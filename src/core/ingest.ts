import { extname } from 'node:path';
import type { Repo } from '../schemas.js';
import * as ledger from '../ledger.js';
import { commitsBetween, changedFilesBetween, fileAtSha } from '../git.js';
import { exportedSymbols } from './deadexports.js';
import { log } from '../logger.js';
import { pMap } from '../util.js';

/**
 * Record what has actually happened in a repo, so a queued task can be checked
 * against reality before it is dispatched.
 *
 * The system assumes it is the only writer to a repo, and that assumption is
 * wrong in exactly the case that costs the most: the owner fixes something by
 * hand while a task for it sits queued. Nothing in the ledger knows about those
 * commits, so git history is the only source for them.
 *
 * ShanAuto's own commits are ingested too, tagged `shanauto_commit`. They matter
 * for the same reason: a task planned at T0 can be superseded by another task
 * that landed at T3, not only by a human.
 */

/** Bounds on a first ingestion of an existing repo, which walks everything. */
const MAX_COMMITS_PER_RUN = 200;
const MAX_TS_FILES_PER_COMMIT = 25;

export interface IngestResult {
  ingested: number;
  skipped: number;
  reachedCap: boolean;
}

/** Newly exported symbols a commit introduced, by diffing each .ts file. */
async function symbolsAddedBy(repo: Repo, sha: string, files: string[]): Promise<string[]> {
  const ts = files.filter((f) => ['.ts', '.tsx'].includes(extname(f).toLowerCase()));
  const added = new Set<string>();

  // Bounded concurrency: a first ingestion can diff 25 files per commit across
  // 200 commits, and the fileAtSha pair is a subprocess each. Sequential was
  // ~2 subprocesses per file; this caps in-flight work without spawning all
  // 50 at once.
  await pMap(ts.slice(0, MAX_TS_FILES_PER_COMMIT), 4, async (file) => {
    // `sha^` does not resolve for a root commit; safeGit yields '' and every
    // symbol in the file then reads as newly added, which is correct there.
    const [after, before] = await Promise.all([
      fileAtSha(repo, sha, file),
      fileAtSha(repo, `${sha}^`, file),
    ]);
    if (!after) return; // deleted, or unreadable

    const was = exportedSymbols(before);
    for (const s of exportedSymbols(after)) if (!was.has(s)) added.add(s);
  });
  return [...added];
}

/**
 * Walk history forward from the last ingested commit and record each one.
 *
 * Idempotent by SHA: a commit already carrying a resolution row is skipped, so
 * running twice adds nothing. Safe to call at the start of every run.
 */
export async function ingestCommits(repo: Repo): Promise<IngestResult> {
  const from = ledger.lastIngestedSha(repo.id);
  // MAX_COMMITS_PER_RUN+1 so the cap-detection below still works: commitsBetween
  // stops git at the wire instead of streaming a years-long history into memory
  // only to have the slice() throw most of it away.
  const commits = await commitsBetween(repo, from, 'HEAD', MAX_COMMITS_PER_RUN + 1);

  let ingested = 0;
  let skipped = 0;
  const reachedCap = commits.length > MAX_COMMITS_PER_RUN;

  for (const c of commits.slice(0, MAX_COMMITS_PER_RUN)) {
    if (ledger.hasResolutionForSha(c.sha)) {
      skipped++;
      continue;
    }

    // Per-commit, not cumulative: `show` gives the files this commit changed and
    // works for root commits, where a `parent..sha` range would not resolve.
    const paths = await changedFilesBetween(repo, null, c.sha);
    const symbols = await symbolsAddedBy(repo, c.sha, paths);

    ledger.addResolution({
      repo: repo.id,
      kind: ledger.isKnownCommit(c.sha) ? 'shanauto_commit' : 'external_commit',
      commit_sha: c.sha,
      paths,
      symbols,
      reason: c.message.slice(0, 200),
      // The commit's own author date. Without this, ingesting years of history
      // in one pass stamps every memory with the moment ingestion ran.
      occurred_at: c.date || undefined,
    });
    ingested++;
  }

  if (ingested > 0 || skipped > 0) {
    log.debug(`ingest ${repo.id}: ${ingested} new, ${skipped} already recorded`);
  }
  if (reachedCap) {
    log.warn(
      `ingest ${repo.id}: stopped at ${MAX_COMMITS_PER_RUN} commits; run again to continue.`,
    );
  }
  return { ingested, skipped, reachedCap };
}
