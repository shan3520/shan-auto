import { simpleGit, type SimpleGit } from 'simple-git';
import { rmSync, existsSync, mkdirSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repo, TaskKindT } from './schemas.js';
import { log } from './logger.js';

export interface DiffStat {
  files: string[];
  insertions: number;
  deletions: number;
  /**
   * How many raw diff entries were renames (F11).
   *
   * A rename is one git entry whose path is `old => new` (or `src/{old => new}`),
   * but splitRename expands it into TWO files below — so `files.length` overstates
   * the change and understates the work. The TRIVIAL floor measures insertions +
   * deletions; a pure rename is 0/0 and yet is real work. Counted before
   * splitRename, on the raw entries, so one rename is one.
   */
  renames: number;
}

function g(repo: Repo): SimpleGit {
  return simpleGit({ baseDir: repo.path, maxConcurrentProcesses: 1 });
}

async function safeGit<T>(promise: Promise<T>, fallback: T, warnMessage?: string): Promise<T> {
  try {
    return await promise;
  } catch (e) {
    if (warnMessage) log.warn(`${warnMessage}: ${(e as Error).message}`);
    return fallback;
  }
}

export async function isRepo(repo: Repo): Promise<boolean> {
  return safeGit(g(repo).checkIsRepo(), false);
}

/**
 * Throw away the stash we just made, but only once git has confirmed it holds
 * nothing at all.
 *
 * `status` can report a change that does not exist. `diffStat` runs
 * `git add -A --intent-to-add .` on every task, and an intent-to-add entry whose
 * file is later removed — which rollback's fallback path does — leaves a phantom
 * ` D somefile` in status with no content anywhere behind it. ensureClean
 * believes status, stashes, and git dutifully records a stash of nothing.
 *
 * Reproduced end to end: status reports one deletion, `stash push -u` succeeds,
 * and `stash show -u --name-only` on the result is empty. Two of the eleven
 * stashes sitting in example-api are exactly that, from 2026-08-08.
 *
 * They cost nothing but they are not harmless: the real ones are what an owner
 * has to find in that list, and a pile of decoys is how a genuine rescue gets
 * scrolled past.
 *
 * Every branch here fails towards KEEPING the stash. If the ref is gone, if the
 * message is not ours, if the inspection itself errors — leave it alone. Dropping
 * an owner's work to tidy a list would be far worse than the untidiness.
 */
async function dropIfEmpty(git: SimpleGit, repo: Repo, label: string): Promise<void> {
  try {
    await dropIfEmptyInner(git, repo, label);
  } catch (e) {
    /*
     * safeGit catches a REJECTED promise; anything that throws on the way to
     * making one goes straight past it. Tidying the stash list is the least
     * important thing this process does and it must not be able to end a run —
     * the sentence above about failing towards keeping the stash is only true
     * with this here.
     */
    log.warn(`Could not inspect the autostash in ${repo.id}: ${(e as Error).message}`);
  }
}

async function dropIfEmptyInner(git: SimpleGit, repo: Repo, label: string): Promise<void> {
  const subject = await safeGit(git.raw(['log', '-1', '--format=%s', 'stash@{0}']), null);
  /*
   * Not ours, or no stash there at all. Someone else's stash is never our
   * business. Deliberately redundant with the re-read below — a mutation run
   * confirmed either check alone can be deleted with the other still answering
   * the same question. Kept because it also stops us inspecting a stash that
   * was never ours to look at.
   */
  if (subject === null || !subject.includes(label)) return;

  /*
   * One command covers tracked edits AND the untracked files kept in the stash's
   * third parent; on git 2.45 it exits 0 with empty output for a stash holding
   * neither. `null` means the question could not be asked, which is not an answer
   * of "empty".
   */
  const content = await safeGit(
    git.raw(['stash', 'show', '--include-untracked', '--name-only', 'stash@{0}']),
    null,
  );
  if (content === null || content.trim() !== '') return;

  // Re-read the ref immediately before dropping: `stash drop` takes a position,
  // not an identity, and stash@{0} means whatever is on top at that instant.
  const stillOurs = await safeGit(git.raw(['log', '-1', '--format=%s', 'stash@{0}']), null);
  if (stillOurs === null || !stillOurs.includes(label)) return;

  await safeGit(
    git.raw(['stash', 'drop', 'stash@{0}']),
    null,
    `Could not drop the empty autostash in ${repo.id}`,
  );
  log.info(
    `Repo ${repo.id} looked dirty but had nothing to stash (a stale index entry); ` +
      `dropped the empty ${label}.`,
  );
}

/**
 * Guarantee a clean tree on the right branch before an agent touches anything.
 * Stray changes are stashed, never discarded - if you were mid-edit, it is recoverable.
 */
export async function ensureClean(repo: Repo): Promise<void> {
  const git = g(repo);
  const status = await git.status();

  if (!status.isClean()) {
    const label = `shanauto-autostash-${Date.now()}`;
    log.warn(`Repo ${repo.id} was dirty; stashing ${status.files.length} file(s) as ${label}`);
    await git.stash(['push', '-u', '-m', label]);
    await dropIfEmpty(git, repo, label);
  }
  if (status.current !== repo.branch) {
    await git.checkout(repo.branch);
  }
  const pulled = await safeGit(git.pull('origin', repo.branch, { '--rebase': 'true' }), null);

  /*
   * A failed pull is not always "offline".
   *
   * This swallowed everything and logged "continuing offline". A genuine
   * CONFLICT is not offline: it leaves the repo mid-rebase and detached, and the
   * run carried on regardless. Measured — the task committed onto the orphan,
   * simple-git returned a garbage sha ("HEAD 739") which went into the ledger as
   * the commit id, the push was rejected and logged as a warning, and
   * `git rebase --abort` then made the commit unreachable. The task was marked
   * committed, so it is never retried: the work is gone and the record says it
   * succeeded.
   *
   * Refusing to start is the only safe answer — an unresolved conflict needs a
   * person, and anything this does on top of it compounds the mess.
   */
  if (pulled === null) {
    const st = await safeGit(git.status(), null);
    const conflicts = st?.conflicted?.length ?? 0;
    const midRebase = conflicts > 0 || !!st?.detached;
    if (midRebase) {
      throw new Error(
        `${repo.id} is mid-rebase or detached (${conflicts} conflicted file(s)). ` +
          `Refusing to run: resolve it, or 'git -C ${repo.path} rebase --abort'.`,
      );
    }
    log.warn(`Pull failed for ${repo.id} (continuing offline)`);
  }
}

export interface StashEntry {
  /** `stash@{0}`. A POSITION, not an identity — it shifts as stashes are added. */
  ref: string;
  /** The message, minus git's `On main:` prefix. */
  label: string;
  /** ISO date, day precision. */
  when: string;
  /** Everything the stash holds, tracked edits and untracked files alike. */
  files: string[];
}

/**
 * The work ShanAuto has set aside in this repo and not given back.
 *
 * Two things put files here and neither ever returns them: `ensureClean` sweeps
 * a dirty tree before a task starts, and `rollback` keeps a copy of an agent's
 * work before reverting it. Both are right to preserve rather than delete — but
 * preserving into a place nobody is told about is only a slower kind of losing.
 *
 * Measured in example-api on 2026-08-15: eleven stashes, the oldest a week old. One
 * held two of the owner's own untracked scripts, swept up on 08-12 and mentioned
 * nowhere except a log line in a run that had already scrolled past. Nothing in
 * the reports, the TUI or the ledger ever said the pile existed.
 *
 * Read-only, and it names only ShanAuto's own stashes: an owner's `git stash` is
 * theirs and does not belong in our report.
 */
export async function shanautoStashes(repo: Repo): Promise<StashEntry[]> {
  const git = g(repo);
  // NUL-separated: a stash message is free text and can contain anything else.
  const raw = await safeGit(git.raw(['stash', 'list', '--format=%gd%x00%cI%x00%gs']), null);
  if (!raw) return [];

  const out: StashEntry[] = [];
  for (const line of raw.split('\n')) {
    const [ref, when, subject] = line.split('\0');
    if (!ref || !subject || !/shanauto-(autostash|rollback)/i.test(subject)) continue;
    const files = await safeGit(
      git.raw(['stash', 'show', '--include-untracked', '--name-only', ref]),
      '',
    );
    out.push({
      ref,
      label: subject.replace(/^on\s+[^:]+:\s*/i, '').trim(),
      when: (when ?? '').slice(0, 10),
      files: files.split('\n').map((f) => f.trim()).filter(Boolean),
    });
  }
  return out;
}

/**
 * The label `rollback` writes, anchored at both ends.
 *
 * `shanautoStashes` matches loosely because it only REPORTS. This decides what is
 * DELETED, so it matches exactly what rollback writes and nothing else:
 * `shanauto-rollback <ISO>`, with the ` — <task and verdict>` suffix O24 added on
 * 2026-08-31. Both shapes are in the wild — the stashes taken before O24 have no
 * suffix — and both must be recognised.
 *
 * Two things it must never match:
 *
 * - `shanauto-autostash-*`. ensureClean takes that from a dirty tree BEFORE a
 *   task runs, so it can hold the owner's own unsaved work — measured in
 *   example-api, two of the owner's scripts swept up on 2026-08-12 and still
 *   sitting there. Age says nothing about whether that is safe to lose.
 * - An owner's own `git stash push -m "..."` that happens to mention the word.
 *   Anchoring is the whole difference between "ours" and "contains our name".
 */
const ROLLBACK_LABEL =
  /^shanauto-rollback (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?: — .*)?$/;

export interface RollbackStash {
  /** Position when read. NEVER dropped by this alone — see dropStashBySha. */
  ref: string;
  /** The stash commit: the identity a drop is checked against. */
  sha: string;
  label: string;
  /** When rollback took it, from the ISO time it writes into the label. */
  created: Date;
}

/**
 * ShanAuto's rollback stashes in this repo, and only those.
 *
 * Throws when the list cannot be read, unlike `shanautoStashes`: a report can
 * shrug at an unreadable repo, but a sweep that read nothing must say so rather
 * than report a clean pass it never made.
 */
export async function rollbackStashes(repo: Repo): Promise<RollbackStash[]> {
  // NUL-separated: a stash message is free text and can contain anything else.
  const raw = await g(repo).raw(['stash', 'list', '--format=%gd%x00%H%x00%gs']);
  const out: RollbackStash[] = [];
  for (const line of raw.split('\n')) {
    const [ref, sha, subject] = line.split('\0');
    if (!ref || !sha || !subject) continue;
    const label = subject.replace(/^on\s+[^:]+:\s*/i, '').trim();
    const m = ROLLBACK_LABEL.exec(label);
    if (!m) continue;
    const created = new Date(m[1]!);
    // A label that names no real time is not evidence of age.
    if (Number.isNaN(created.getTime())) continue;
    out.push({ ref: ref.trim(), sha: sha.trim(), label, created });
  }
  return out;
}

/**
 * Drop one stash by IDENTITY, never by a position read earlier.
 *
 * `git stash drop` takes a position, and positions move: every stash pushed
 * shifts every older one down by one, and a run in flight pushes one for each
 * rejected task. A position read at the start of a sweep can point at a
 * different stash by the time it is used — and the one it slides onto is the
 * NEWER neighbour, which may be an autostash holding the owner's own work.
 *
 * So the position is looked up from the SHA immediately before the drop, then
 * confirmed with rev-parse, and a stash that cannot be found is left alone and
 * reported as gone rather than guessed at. The `prune` command also refuses to
 * sweep while a run holds the lock, which closes the last window.
 *
 * Returns false when the stash is no longer there.
 */
export async function dropStashBySha(repo: Repo, sha: string): Promise<boolean> {
  const git = g(repo);
  const raw = await git.raw(['stash', 'list', '--format=%gd%x00%H']);
  const ref = raw
    .split('\n')
    .map((l) => l.split('\0'))
    .find(([, h]) => h?.trim() === sha)?.[0]
    ?.trim();
  if (!ref) return false;
  const now = (await git.raw(['rev-parse', ref])).trim();
  if (now !== sha) return false;
  await git.raw(['stash', 'drop', ref]);
  return true;
}

export interface StashSummary {
  repo: string;
  path: string;
  count: number;
  files: string[];
  oldest: string;
  /**
   * The newest few, with their labels — which now say which task and why.
   *
   * The count and the file list say a pile exists; these say what is in it.
   * Capped for the same reason the file list is: a prompt to go and look, not
   * an inventory.
   */
  recent: { ref: string; label: string; when: string }[];
}

/**
 * The same reading, per repo, in the shape the report prints.
 *
 * Shared so that a run and a standalone `sa report` cannot drift into telling the
 * owner two different stories about the same stash list.
 */
export async function stashSummary(repos: Repo[]): Promise<StashSummary[]> {
  const out: StashSummary[] = [];
  for (const repo of repos) {
    // A repo that cannot be read is not a reason to lose the whole report.
    const entries = await safeGit(shanautoStashes(repo), [], `Could not read stashes in ${repo.id}`);
    if (!entries.length) continue;
    out.push({
      repo: repo.id,
      path: repo.path,
      count: entries.length,
      // Deduped and capped: this is a prompt to go and look, not an inventory.
      files: [...new Set(entries.flatMap((e) => e.files))].slice(0, 8),
      oldest: entries[entries.length - 1]?.when ?? '',
      recent: entries.slice(0, 5).map((e) => ({ ref: e.ref, label: e.label, when: e.when })),
    });
  }
  return out;
}

export async function diffStat(repo: Repo): Promise<DiffStat> {
  const git = g(repo);
  /*
   * Compare against HEAD, not the index.
   *
   * `git add -A --intent-to-add .` was here to make untracked files visible,
   * and it does — but `-A` also stages DELETIONS for real (`--intent-to-add`
   * only defers new files). The next line read the UNSTAGED diff, so every
   * deletion the agent had just made moved into the index and vanished from
   * the gate's view. The one line meant to make it see more is what made it
   * see less:
   *
   *   rm tracked.txt   ; git diff --numstat  ->  0  1  tracked.txt
   *   git add -A --i-t-a; git diff --numstat  ->  (nothing)
   *
   * Measured consequences: a commit the gate authorised as "1 file" contained
   * four, including deleting .github/workflows/ci.yml — a FORBIDDEN path,
   * protected against editing and not against deletion. The scope cap counted
   * one file while 47 changed. A pure removal task reported NO_CHANGES.
   *
   * `diffSummary(['HEAD'])` sees staged and unstaged changes together, so a
   * deletion is visible however it got there. The intent-to-add is kept for
   * untracked files, which HEAD alone still would not show.
   */
  await safeGit(git.add(['-A', '--intent-to-add', '.']), undefined);

  /*
   * A repo with no commits yet has no HEAD, and `git diff HEAD` there is fatal:
   *
   *   fatal: ambiguous argument 'HEAD': unknown revision or path not in the
   *   working tree.
   *
   * diffStat runs on every task and inside rollback's error path, so an empty
   * repo — an entirely ordinary thing to point this at, and exactly what a
   * brand-new project is — turned the first task into an unexplained crash.
   * Against the empty tree object, every file simply reads as an addition.
   */
  const hasHead = (await safeGit(git.raw(['rev-parse', '--verify', 'HEAD']), null)) !== null;
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  try {
    const d = await git.diffSummary([hasHead ? 'HEAD' : EMPTY_TREE, '--numstat']);
    /*
     * §9.4: exclude the orchestrator's own `.shanauto/` briefs.
     *
     * The handoff driver writes them into the repo while a task runs, so they
     * pollute every later gate on that repo (a one-line brief looks like the
     * agent's work). Excluded at this one shared measurement, so the gate, the
     * commit pathspec (commitAndPush stages only these files) and rollback all
     * agree on what the agent changed. The totals must be recomputed from the
     * kept entries, because git counts a brief as a real addition.
     */
    const kept = d.files.filter((f) => !underShanauto(f.file));
    // F11: rename entries are counted before splitRename expands each into two
    // paths, so `renames` reflects git's own accounting, not the file list.
    const renames = kept.filter((f) => f.file.includes('=>')).length;
    /*
     * The totals are recomputed from the kept entries, because git counts a
     * brief as a real addition. Only text entries carry line counts — binary
     * files and name-status entries are 0/0.
     */
    return {
      files: kept.flatMap((f) => splitRename(f.file)),
      insertions: kept.reduce((a, f) => a + ('insertions' in f ? f.insertions : 0), 0),
      deletions: kept.reduce((a, f) => a + ('deletions' in f ? f.deletions : 0), 0),
      renames,
    };
  } finally {
    /*
     * Leave the index as we found it (SEC-8).
     *
     * `git add -A --intent-to-add .` above stages every deletion for real and
     * records i-t-a entries for the untracked files. Both would otherwise ride
     * along into an OWNER'S next `git add -A && git commit`, sweeping the
     * agent's deletions into a commit that is not theirs. Restore the index to
     * HEAD (or empty it, on a repo with no commits yet). commitAndPush
     * re-stages the exact pathspec it commits, so this never hurts the commit
     * path — it only undoes the side effect of measuring.
     */
    if (hasHead) {
      await safeGit(git.raw(['reset', '-q', '--', '.']), undefined);
    } else {
      await safeGit(git.raw(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']), undefined);
    }
  }
}

/**
 * Expand git's rename notation into the real paths on both sides.
 *
 * Once deletions became visible, a genuine move stopped appearing as two
 * entries and started appearing as one: `old.ts => new.ts`, or with a shared
 * prefix, `src/{old => new}/a.ts`. That string is not a path. It would be
 * handed to `git add` as a pathspec that matches nothing, and checked against
 * the forbidden-path list as a name no rule could ever match — so a rename INTO
 * a protected path would have slipped by.
 *
 * Both sides matter: the destination is the new work, and the source is a
 * deletion the gate must account for.
 */
export function splitRename(entry: string): string[] {
  const braced = entry.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) {
    const [, before, from, to, after] = braced;
    const join = (mid: string) => `${before}${mid}${after}`.replace(/\/\//g, '/');
    return [...new Set([join(from ?? ''), join(to ?? '')])].filter(Boolean);
  }
  if (entry.includes(' => ')) {
    return [...new Set(entry.split(' => ').map((s) => s.trim()))].filter(Boolean);
  }
  return [entry];
}

/**
 * Whether a raw diff entry lives under the orchestrator's own `.shanauto/` dir.
 *
 * The handoff driver writes briefs into `repo/.shanauto/handoff/` while a task
 * runs. They are orchestrator-owned state, not the agent's work, so the gate
 * must neither count nor scope them, commitAndPush must not stage them, and
 * rollback must not revert them. A rename entry is `old => new` (or braced),
 * and either side may be a brief — check both.
 */
export function underShanauto(entry: string): boolean {
  return entry
    .replace(/[{}]/g, '')
    .split('=>')
    .some((side) => {
      const p = side.trim();
      return p === '.shanauto' || p.startsWith('.shanauto/');
    });
}

/**
 * Undo the agent's work, scoped to specific paths.
 *
 * Deliberately NOT `git reset --hard` + `git clean -fd`. Those are repo-wide and
 * permanently destroy any file you happened to be editing while the run was in
 * flight — no stash, no recovery. Scoping to the files that actually changed
 * keeps the blast radius to the task being rolled back.
 *
 * Tracked files are restored from HEAD; files the agent newly created are deleted.
 * 
 * @param {Repo} repo The repository context.
 * @param {string[]} [paths] The list of file paths to rollback. If omitted, rolls back all changed files.
 * @returns {Promise<void>}
 */
/**
 * Delete compiled artifacts whose source the rollback just took away.
 *
 * A reverted attempt is supposed to leave no trace, and it left a compiled one.
 * In zero11 an intern authored `alembic/versions/0013_search_log_failure_fields.py`,
 * adding two columns to a model. The attempt was rejected and reverted; `.pyc`
 * is gitignored, so `__pycache__/0013_search_log_failure_fields.cpython-311.pyc`
 * stayed behind with no source anywhere in the tree.
 *
 * In zero12 the same task ran again against the same missing columns, found a
 * compiled migration whose NAME promises exactly the fields it needs, and spent
 * its entire remaining budget trying to recover them from the bytecode — three
 * denied tool calls and not one line written. A second task died the same way on
 * a `conftest.pyc` whose source has never existed in this tree. Two of that
 * run's five dispatches, both reported as the agent producing no changes.
 *
 * Only when the source is GONE. A reverted edit leaves the file in place and its
 * cache merely stale, which Python fixes by itself; deleting there would be
 * meddling. An orphan cannot be the owner's work either — it is derived from a
 * file that no longer exists, so nothing is lost that anything can read.
 *
 * Python only, because Python is where the trap is: the cache sits beside the
 * source, is gitignored, and is named after the thing it came from — which is
 * what makes it legible as evidence to the next agent. A `dist/` is none of
 * those. Another stack that grows the same shape is one more entry here.
 */
export function sweepOrphanedArtifacts(repoPath: string, targets: string[]): string[] {
  const removed: string[] = [];
  for (const file of targets) {
    const norm = file.replace(/\\/g, '/');
    if (!norm.endsWith('.py')) continue;
    if (existsSync(join(repoPath, norm))) continue;

    const slash = norm.lastIndexOf('/');
    const dir = slash === -1 ? '' : norm.slice(0, slash);
    const stem = norm.slice(slash + 1, -'.py'.length);
    const cacheDir = join(repoPath, dir, '__pycache__');

    let entries: string[];
    try {
      entries = readdirSync(cacheDir);
    } catch {
      continue; // no cache beside it, which is the ordinary case
    }
    for (const entry of entries) {
      // `stem.cpython-311.pyc`, `stem.cpython-311-pytest-8.3.3.pyc` — the name
      // up to the first dot is the module it was compiled from.
      if (!entry.endsWith('.pyc') || entry.split('.')[0] !== stem) continue;
      try {
        rmSync(join(cacheDir, entry), { force: true });
        removed.push(`${dir ? `${dir}/` : ''}__pycache__/${entry}`);
      } catch {
        /* a locked file is a nuisance, not a reason to fail a rollback */
      }
    }
  }
  return removed;
}

/** Say what was swept, or say nothing. Named so both exits from `rollback` read the same. */
function reportSweep(repo: Repo, swept: string[]): void {
  if (!swept.length) return;
  log.debug(
    `Removed ${swept.length} orphaned build artifact(s) in ${repo.id}: ${swept.slice(0, 3).join(', ')}`,
  );
}

/**
 * What a rollback actually did, for whoever has to describe it.
 *
 * O26. This returned `void`, and the note handed to the next attempt said "Its
 * file changes were reverted and stashed, so you are starting from a clean
 * tree" unconditionally — beside a debug line reading "Nothing to roll back in
 * example-api", on every one of run 23's retries. It also promised a stash on the
 * fallback path, which is the path that has no stash and may have deleted.
 *
 * Telling an agent its predecessor's work was safely put aside when nothing was
 * put aside anywhere is the same defect as the refusal note that told an agent
 * its turn had ended when it had not: the one message written to be believed,
 * spending its credibility on a detail nobody checked.
 */
export interface RollbackResult {
  /** Files reverted. 0 means the tree was already clean. */
  reverted: number;
  /** The stash they can be recovered from, or null if there is none. */
  stash: string | null;
  /** Left alone: another process holds the index, so nothing was touched. */
  skipped: boolean;
}

export async function rollback(
  repo: Repo,
  paths?: string[],
  why?: string,
): Promise<RollbackResult> {
  const clean: RollbackResult = { reverted: 0, stash: null, skipped: false };
  const git = g(repo);
  const targets = paths?.length ? paths : (await diffStat(repo)).files;

  if (targets.length === 0) {
    log.debug(`Nothing to roll back in ${repo.id}`);
    return clean;
  }

  /*
   * Stash first, so a rollback is recoverable.
   *
   * This used to `git checkout HEAD --` tracked files and `rmSync` untracked
   * ones. Both are permanent, and neither can tell the agent's work from the
   * OWNER'S: a task may run for 15 minutes, and anything written in the repo
   * during that window is reported by `diffStat` exactly as if the agent had
   * written it. Measured — a note the owner created while a task ran was passed
   * to rollback and deleted outright, with no stash and no way back.
   *
   * `git stash push -u` reverts the same paths AND keeps a copy, so the worst
   * case becomes "your file is in a stash" rather than "your file is gone".
   * The ref is logged, because a recovery nobody is told about is not one.
   */
  /*
   * O24. Every entry was `shanauto-rollback <timestamp>` and nothing else, so a
   * pile of 38 in example-api had no way to tell one from another: "restore the
   * newest" was a coin toss over which rejected task you got back, and finding
   * run 21's fix in there took reading diffs. The stash is the only place a
   * rejected task's work survives, and it was write-only.
   *
   * The task and the verdict go in the message, where `git stash list` shows
   * them without any tooling at all. Trimmed, because a stash subject is one
   * line and a gate detail can run to paragraphs.
   */
  const why1 = (why ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const label = `shanauto-rollback ${new Date().toISOString()}${why1 ? ` — ${why1}` : ''}`;

  /*
   * A stale index.lock turns every git command below into a no-op — and the
   * fallback beneath them is a plain rmSync.
   *
   * `.git/index.lock` is left behind by any git process killed mid-write, which
   * is exactly what a timed-out agent produces. With it present, `reset`,
   * `stash` and `checkout` all fail with "Unable to create index.lock: File
   * exists"; safeGit swallows each one; and rollback proceeds to delete
   * untracked files with no stash, no revert and no recovery. The one condition
   * that disables every safety net is the one a crash leaves behind.
   *
   * A lock older than ten minutes cannot belong to a live command — nothing here
   * holds the index that long — so it is cleared. A fresh one is left alone and
   * the rollback is abandoned: leaving the agent's work in the tree is
   * recoverable, and racing another git process is not.
   */
  const lock = join(repo.path, '.git', 'index.lock');
  // SEC-10: stat/exists/rm are three separate syscalls, and another git process
  // can remove or recreate the lock between any two of them. Each would have
  // thrown out of rollback's safety check entirely (a stat on a vanished file is
  // an uncaught crash); one try/catch makes every such race "leave the tree
  // alone", which is the recoverable answer.
  try {
    if (existsSync(lock)) {
      const age = Date.now() - statSync(lock).mtimeMs;
      if (age > 10 * 60 * 1000) {
        log.warn(`Clearing a stale git lock in ${repo.id} (${Math.round(age / 60000)} min old)`);
        rmSync(lock, { force: true });
      }
    }
  } catch {
    /* a racy lock is a live lock — leave the tree alone, below */
  }
  if (existsSync(lock)) {
    log.warn(
      `${repo.id} has a git lock held by another process; leaving the working tree alone. ` +
        `Nothing was deleted.`,
    );
    // Skipped, NOT clean: the agent's changes are still sitting in the tree.
    return { ...clean, skipped: true };
  }

  /*
   * Clear the index for these paths BEFORE stashing.
   *
   * `diffStat` runs `git add -A --intent-to-add .` moments earlier, and git
   * refuses to stash a pathspec containing such an entry:
   *
   *   error: Entry 'mine.md' not uptodate. Cannot merge.
   *
   * So the stash failed every single time an untracked file was involved —
   * which is the only case the destructive fallback can actually destroy
   * anything. The safety net engaged only for tracked files, which were already
   * recoverable from HEAD. Measured across six scenarios: the ordinary
   * failed-task case (one edit plus one new file) deleted the new file with an
   * empty stash list.
   *
   * The test did not catch it because it mocked simple-git and asserted that
   * `stash push` was CALLED, never that it worked.
   */
  await safeGit(git.raw(['reset', '-q', '--', ...targets]), null);

  const stashed = await safeGit(
    git.raw(['stash', 'push', '-u', '-m', label, '--', ...targets]),
    null,
    `Could not stash before rollback in ${repo.id}`,
  );

  if (stashed !== null && !/No local changes/i.test(stashed)) {
    reportSweep(repo, sweepOrphanedArtifacts(repo.path, targets));
    log.info(
      `Rolled back ${targets.length} file(s) in ${repo.id}; kept in stash "${label}". ` +
        `Recover with: git -C ${repo.path} stash list`,
    );
    return { reverted: targets.length, stash: label, skipped: false };
  }

  /*
   * Stash refused — an old git, a pathspec it dislikes, or genuinely nothing to
   * do. Fall back to the previous behaviour rather than leaving the agent's work
   * in the tree for the next task to trip over, but say so: this path CAN lose
   * an owner's concurrent edit.
   */
  const trackedOut = await safeGit(git.raw(['ls-tree', '-r', '--name-only', 'HEAD']), '');
  const tracked = new Set(trackedOut.split('\n').map((s) => s.trim()).filter(Boolean));

  // F10: outside the repo, so diffStat (which lists every untracked file) can
  // never see the copies as new work for the next task to trip over.
  const quarantine = join(tmpdir(), 'shanauto-rollback', String(Date.now()));
  const saved: string[] = [];

  for (const file of targets) {
    const normalised = file.replace(/\\/g, '/');
    await safeGit(
      (async () => {
        if (tracked.has(normalised)) {
          await git.checkout(['HEAD', '--', file]);
          return;
        }
        /*
         * An untracked file is the OWNER'S until proven otherwise, and this path
         * only runs when git itself could not help — a stale index.lock, a repo
         * with no commits, a conflicted rebase. Copy it aside before removing
         * it, so "we could not stash" never means "it is gone".
         */
        const src = join(repo.path, file);
        if (!existsSync(src)) return;
        try {
          mkdirSync(quarantine, { recursive: true });
          // SEC-9: two different paths can sanitise to the same name
          // (`a/b.ts` and `a__b.ts` both become `a__b.ts`). Disambiguate with a
          // numeric suffix so neither copy overwrites the other.
          const base = normalised.replace(/[\\/]/g, '__');
          let dest = join(quarantine, base);
          let n = 1;
          while (existsSync(dest)) dest = join(quarantine, `${base}-${n++}`);
          copyFileSync(src, dest);
          saved.push(file);
        } catch (e) {
          // Could not preserve it, so do not remove it. Leaving the agent's work
          // in the tree is a nuisance; deleting the owner's is unrecoverable.
          log.warn(`Refusing to delete ${file}: no copy could be kept (${(e as Error).message})`);
          return;
        }
        rmSync(src, { force: true });
      })(),
      undefined,
      `Rollback could not revert ${file}`
    );
  }
  reportSweep(repo, sweepOrphanedArtifacts(repo.path, targets));
  log.warn(
    `Rolled back ${targets.length} file(s) in ${repo.id} WITHOUT a stash` +
      (saved.length ? `; copies kept in ${quarantine}` : '') +
      `. Anything you were editing in that repo may have been reverted.`,
  );
  // Reverted, but `stash: null` — this is the path that has no stash to offer,
  // and the note must not promise one.
  return { reverted: targets.length, stash: null, skipped: false };
}

/**
 * Lists all tracked files in the repository.
 * 
 * @param {Repo} repo The repository context.
 * @returns {Promise<string[]>} A list of tracked file paths.
 */
export async function listFiles(repo: Repo): Promise<string[]> {
  const out = await safeGit(g(repo).raw(['ls-files']), '');
  return out.split('\n').filter(Boolean);
}

/* ---------- history inspection, for resolution memory ---------- */

export interface CommitInfo {
  sha: string;
  author: string;
  date: string;
  message: string;
}

/**
 * Current HEAD, or null in a repo with no commits yet.
 *
 * Read this AFTER ensureClean, never before: ensureClean does a `pull --rebase`,
 * so HEAD can move between the two points.
 */
export async function headSha(repo: Repo): Promise<string | null> {
  const out = await safeGit(g(repo).revparse(['HEAD']), '');
  const sha = out.trim();
  return sha.length ? sha : null;
}

/**
 * Commits reachable from `to` but not `from`, oldest first.
 *
 * `from` null means the whole history — the first ingestion of an existing repo.
 * An unknown or unreachable `from` yields [] rather than throwing, because a
 * rewritten history must not break a run.
 *
 * `limit` bounds the walk when `from` is null. A first ingestion of a repo with
 * years of history otherwise streams every commit through memory just to have
 * the caller take the first `MAX_COMMITS_PER_RUN`; `--max-count` stops git at
 * the wire instead.
 */
export async function commitsBetween(
  repo: Repo,
  from: string | null,
  to = 'HEAD',
  limit?: number,
): Promise<CommitInfo[]> {
  const range = from ? `${from}..${to}` : to;
  const SEP = '\x1f';
  const args = ['log', `--format=%H${SEP}%ae${SEP}%aI${SEP}%s`, range];
  if (!from && limit) args.push('--max-count', String(limit));
  const raw = await safeGit(
    g(repo).raw(args),
    '',
    `Could not read history ${range} in ${repo.id}`,
  );
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = '', author = '', date = '', ...rest] = line.split(SEP);
      return { sha, author, date, message: rest.join(SEP) };
    })
    .filter((c) => c.sha)
    .reverse(); // oldest first, so ingestion resumes in order
}

/** Repo-relative paths changed between two SHAs. `from` null = files in `to`. */
export async function changedFilesBetween(
  repo: Repo,
  from: string | null,
  to = 'HEAD',
): Promise<string[]> {
  const args = from
    ? ['diff', '--name-only', `${from}..${to}`]
    : ['show', '--name-only', '--format=', to];
  const raw = await safeGit(g(repo).raw(args), '', `Could not diff ${from ?? 'root'}..${to} in ${repo.id}`);
  return [...new Set(raw.split('\n').map((s) => s.trim()).filter(Boolean))];
}

/** File contents at a specific SHA, or '' if the file did not exist then. */
export async function fileAtSha(repo: Repo, sha: string, file: string): Promise<string> {
  return safeGit(g(repo).show([`${sha}:${file.replace(/\\/g, '/')}`]), '');
}

/**
 * Which of these paths already existed in the last commit?
 *
 * The gate needs to tell an agent's OWN new test file apart from one that was
 * already in the repo before the task started. `git diff HEAD` reports both as
 * changed and says nothing about which is which, and the working tree cannot
 * answer it either — by the time the gate looks, both are sitting on disk.
 *
 * `git ls-tree HEAD -- <paths>` answers from the commit, which is the only
 * place the distinction still exists. A repo with no HEAD yet has no
 * pre-existing anything, so the answer there is the empty set.
 */
export async function existedAtHead(repo: Repo, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const git = g(repo);
  const hasHead = (await safeGit(git.raw(['rev-parse', '--verify', 'HEAD']), null)) !== null;
  if (!hasHead) return [];
  const slash = (p: string) => p.replace(/\\/g, '/');
  const out = await safeGit(
    git.raw(['ls-tree', '--name-only', '-z', 'HEAD', '--', ...paths.map(slash)]),
    '',
  );
  const present = new Set(out.split('\0').filter(Boolean).map(slash));
  return paths.filter((p) => present.has(slash(p)));
}

const PREFIX: Record<TaskKindT, string> = {
  feature: 'feat',
  test: 'test',
  refactor: 'refactor',
  docs: 'docs',
  config: 'chore',
  bugfix: 'fix',
};

/**
 * The co-author trailer: this machine, not whichever agent happened to take
 * the job.
 *
 * Naming the agent would put `opencode` or `agy` in a public history as a
 * co-author, which says more than is known — the agent is an interchangeable
 * worker picked by the router, and the thing that planned the task, wrote the
 * brief, gated the diff and made the commit is ShanAuto. One name also means
 * the trailer stays true when the agent roster changes.
 *
 * The address is in RFC 2606's reserved `.invalid` TLD on purpose. GitHub
 * resolves `<name>@users.noreply.github.com` to the GitHub USER called `name`,
 * so the obvious spelling would hand a share of the authorship to whoever
 * happens to own that account — a stranger, credited on work they have never
 * seen. `.invalid` can never resolve, so this names the machine and claims
 * nothing about a person.
 */
export const CO_AUTHOR = 'Co-authored-by: shanauto <noreply@shanauto.invalid>';

/**
 * @param breaking When the plan declared that this task changes behaviour that
 * already worked. It becomes the conventional-commits `!` and footer, which is
 * the one place the declaration outlives the machine it was made on: the run
 * report is a file on this disk, the ledger is a database on this disk, and
 * the commit is on the operator's GitHub where a caller of the changed thing
 * will actually come looking.
 *
 * @param coAuthor Whether to credit ShanAuto as a co-author. True for a commit
 * an agent produced. Omitted for a `resolve` of a handed-off task, where a
 * human wrote the diff by hand and the orchestrator only committed it.
 */
export function commitMessage(
  kind: TaskKindT,
  title: string,
  acceptance: string,
  breaking?: string,
  coAuthor?: boolean,
): string {
  // The `!` goes before the colon, and inside the 72-char clamp with the rest
  // of the subject - a marker trimmed off by the clamp is worse than none.
  const subject = `${PREFIX[kind]}${breaking ? '!' : ''}: ${title.replace(/\.$/, '')}`;
  /*
   * One trailer block, blank-line separated from the body, because git only
   * reads trailers out of the LAST paragraph: a `Co-authored-by:` sitting in
   * the middle of prose is text, not a trailer, and GitHub ignores it.
   */
  const trailers = [
    breaking ? `BREAKING CHANGE: ${breaking}` : '',
    coAuthor ? CO_AUTHOR : '',
  ].filter(Boolean);
  const footer = trailers.length ? `\n${trailers.join('\n')}\n` : '';
  return `${subject.slice(0, 72)}\n\n${acceptance}\n${footer}`;
}

/**
 * Stage ONLY the paths the agent actually changed, never `git add -A`.
 *
 * A blanket add sweeps in anything you happened to edit while the run was in
 * flight, and buries it under an unrelated automated commit message. That
 * silently corrupts both your work and the honesty of the history, so the
 * caller passes the exact file list the gate observed.
 * 
 * @param {Repo} repo The repository context.
 * @param {string} message The commit message.
 * @param {string[]} paths The list of file paths to stage and commit.
 * @returns {Promise<{ sha: string; pushed: boolean }>} The commit SHA and
 *   whether the push succeeded. A local-only commit is not the same as a
 *   delivered one, and the caller must not conflate them (SEC-7).
 */
export async function commitAndPush(
  repo: Repo,
  message: string,
  paths: string[],
): Promise<{ sha: string; pushed: boolean }> {
  const git = g(repo);
  if (paths.length === 0) throw new Error('Refusing to commit: no paths supplied');

  await git.add(paths);

  // If a concurrent edit slipped into one of these files there is nothing more
  // we can do, but anything outside this list stays untouched in the worktree.
  const staged = await git.diff(['--cached', '--name-only']);
  if (!staged.trim()) throw new Error('Refusing to commit: nothing staged');

  /*
   * Commit the pathspec, not the index.
   *
   * `git commit <msg>` writes whatever the index holds — and the index is not
   * ours alone. diffStat runs `git add -A --intent-to-add` a moment earlier, so
   * anything staged by that (every deletion, in particular) rode along.
   * Measured: the gate authorised one file and the commit contained four,
   * deleting .github/workflows/ci.yml and .gitignore.
   *
   * Naming the paths makes the guarantee in this function's own docstring true
   * — the commit contains exactly what the gate inspected, whatever else may be
   * sitting in the index.
   */
  const res = await git.commit(message, paths);
  const sha = res.commit;
  if (!sha) throw new Error('Commit produced no SHA (nothing staged?)');

  // A failed push is NOT a failed commit, but it is also not a delivered one.
  // Returning `pushed: false` (rather than swallowing it, as before) lets the
  // caller surface "local only" instead of counting it as shipped (SEC-7).
  let pushed = true;
  try {
    await git.push('origin', repo.branch);
  } catch (e) {
    pushed = false;
    log.warn(`Push failed for ${repo.id}; ${sha} is local only: ${(e as Error).message}`);
  }
  return { sha, pushed };
}

export async function hasRemote(repo: Repo): Promise<boolean> {
  return safeGit(
    (async () => {
      const remotes = await g(repo).getRemotes(true);
      return remotes.some((r) => r.name === 'origin' && r.refs.push);
    })(),
    false
  );
}

/**
 * Every top-level tracked entry, lower-cased — the set a planned path must be
 * rooted in to be talking about this repo at all.
 *
 * Both files and first path segments, so `README.md` and `app` (from
 * `app/api/x.py`) are equally valid anchors. Tracked files only, for the same
 * reason fileTree uses them: an untracked build directory is not repo structure.
 *
 * An EMPTY set means "cannot tell" — a repo with no tracked files, or no repo at
 * all — and every caller must treat it as "do not check", never as "nothing is
 * valid". A fresh repo would otherwise have every path it plans rejected.
 */
export async function trackedRoots(repo: Repo): Promise<Set<string>> {
  return safeGit(
    (async () => {
      const out = await g(repo).raw(['ls-files']);
      const roots = new Set<string>();
      for (const line of out.split('\n')) {
        const first = line.trim().split(/[/\\]/)[0];
        if (first) roots.add(first.toLowerCase());
      }
      return roots;
    })(),
    new Set<string>()
  );
}

/** Compact file tree for prompt context. Tracked files only, so node_modules never leaks in. */
export async function fileTree(repo: Repo, limit = 200): Promise<string> {
  return safeGit(
    (async () => {
      const out = await g(repo).raw(['ls-files']);
      const lines = out.split('\n').filter(Boolean);
      const shown = lines.slice(0, limit).join('\n');
      return lines.length > limit ? `${shown}\n...(${lines.length - limit} more files)` : shown || '(empty repo)';
    })(),
    '(not a git repo yet)'
  );
}

export interface WorkingPatch {
  /** Unified diff of the given paths against HEAD. Empty if nothing changed. */
  text: string;
  /** True when the diff was longer than `maxChars` and the tail was dropped. */
  truncated: boolean;
  /** How many characters the full diff was, before any trimming. */
  fullLength: number;
}

/**
 * The agent's work as a unified diff, for a reader that has to judge it.
 *
 * Deliberately built the same way `diffStat` measures, and for the same reason:
 * the reviewer must see exactly what the gate saw and what `commitAndPush` will
 * stage. A reviewer shown a different set of changes from the one that ships is
 * worse than no reviewer, because its approval means nothing.
 *
 * That means repeating diffStat's two awkward parts rather than sharing them.
 * The `--intent-to-add` is what makes brand-new files appear at all — without it
 * a task that only ADDS files reads as an empty patch, and a reviewer shown an
 * empty patch has no grounds to object to anything. The `finally` restores the
 * index afterwards (SEC-8): the i-t-a entries would otherwise ride along into
 * the owner's own next `git add -A`.
 *
 * Truncation is reported rather than hidden. The caller has to tell the reader
 * it is looking at part of a change, because "this function is never called" is
 * a reasonable thing to conclude from a patch whose call site was cut off.
 */
export async function workingPatch(
  repo: Repo,
  paths: string[],
  maxChars = 20000,
): Promise<WorkingPatch> {
  const git = g(repo);
  await safeGit(git.add(['-A', '--intent-to-add', '.']), undefined);
  const hasHead = (await safeGit(git.raw(['rev-parse', '--verify', 'HEAD']), null)) !== null;
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  try {
    /*
     * Pathspec-limited to the files the gate accounted for. A patch is read by
     * a model with a fixed budget, so an unrelated file left in the tree by
     * something else is not just noise — it displaces the work under review.
     */
    const args = ['diff', hasHead ? 'HEAD' : EMPTY_TREE];
    const wanted = paths.filter((p) => p && !underShanauto(p));
    if (wanted.length) args.push('--', ...wanted);
    const out = await safeGit(git.raw(args), '');
    const full = out.trim();
    return full.length > maxChars
      ? { text: full.slice(0, maxChars), truncated: true, fullLength: full.length }
      : { text: full, truncated: false, fullLength: full.length };
  } finally {
    if (hasHead) {
      await safeGit(git.raw(['reset', '-q', '--', '.']), undefined);
    } else {
      await safeGit(git.raw(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']), undefined);
    }
  }
}
