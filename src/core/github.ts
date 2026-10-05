import { execa } from 'execa';
import { today } from '../util.js';

/**
 * What GitHub actually recorded, as opposed to what we committed.
 *
 * On 08-06/08-07 roughly 98 commits were pushed and GitHub recorded 52 then 46
 * contributions. Nothing in the system could see that gap, because every number
 * it reported came from its own ledger. This module asks the other side.
 *
 * Everything here fails open. It is reporting; a missing `gh`, an expired login
 * or a dead network must degrade to "unverified" and never fail a run.
 */

/** How the number was obtained, so the report can say how it knows. */
export type ContributionSource = 'gh' | 'token';

export interface ContributionSnapshot {
  /** Contributions GitHub recorded for the day, or null when we could not ask. */
  recorded: number | null;
  source: ContributionSource | null;
  /** The GitHub account the number belongs to. */
  login: string | null;
  /**
   * GitHub counted contributions in private repositories for this window.
   * Not a problem — but it decides whether the public profile agrees.
   */
  privateCounted: boolean;
  /** Operator-facing reason `recorded` is null. Empty string when it is not. */
  skipped: string;
}

export type ContributionVerdict = 'agree' | 'github-lower' | 'github-higher' | 'unverified';

export interface ContributionCheck {
  day: string;
  /** Commits the ledger believes it made that day. */
  ledger: number;
  snapshot: ContributionSnapshot;
  verdict: ContributionVerdict;
  /** Plain-English lines for the operator. Empty when there is nothing to say. */
  notes: string[];
}

/**
 * `viewer` rather than `user(login:)` so the query works from a `gh` login and
 * from a bare token without either one having to be told who it is — and so the
 * answer is always about the account that actually holds the credential, which
 * is the account whose graph we care about.
 */
const CONTRIBUTIONS_QUERY = `query($from:DateTime!,$to:DateTime!){
  viewer{
    login
    contributionsCollection(from:$from,to:$to){
      restrictedContributionsCount
      contributionCalendar{ weeks{ contributionDays{ date contributionCount } } }
    }
  }
}`;

/** GitHub API calls are the slowest thing in a report; do not let one hang it. */
const API_TIMEOUT_MS = 15_000;

function unavailable(reason: string): ContributionSnapshot {
  return { recorded: null, source: null, login: null, privateCounted: false, skipped: reason };
}

/**
 * A GraphQL response only tells us the calendar day GitHub itself assigned, so
 * match on that label instead of trying to re-derive GitHub's timezone bucketing
 * here. The window is deliberately the LOCAL day, matching `today()` and the
 * ledger's `date('now','localtime')`; it can therefore straddle two labelled
 * days, and only the labelled one is ours.
 */
function readSnapshot(json: unknown, day: string, source: ContributionSource): ContributionSnapshot {
  const root = json as {
    errors?: { message?: string }[];
    data?: {
      viewer?: {
        login?: string;
        contributionsCollection?: {
          restrictedContributionsCount?: number;
          contributionCalendar?: { weeks?: { contributionDays?: { date?: string; contributionCount?: number }[] }[] };
        };
      };
    };
  };

  const firstError = root?.errors?.[0]?.message;
  if (firstError) return unavailable(`GitHub rejected the query: ${firstError}`);

  const viewer = root?.data?.viewer;
  const collection = viewer?.contributionsCollection;
  if (!collection) return unavailable('GitHub returned no contribution data');

  const days = (collection.contributionCalendar?.weeks ?? []).flatMap((w) => w?.contributionDays ?? []);
  const match = days.find((d) => d?.date === day);

  return {
    // No entry for the day means GitHub recorded nothing, not that we failed.
    recorded: typeof match?.contributionCount === 'number' ? match.contributionCount : 0,
    source,
    login: viewer?.login ?? null,
    privateCounted: (collection.restrictedContributionsCount ?? 0) > 0,
    skipped: '',
  };
}

/** Only ever the first line, and only from tools that never echo credentials. */
function firstLine(text: string): string {
  return (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

/**
 * Preferred path: the `gh` CLI holds the credential in the OS keyring, so the
 * operator never has to write a token into a file this repo can accidentally
 * commit.
 */
async function viaGhCli(day: string, from: string, to: string): Promise<ContributionSnapshot> {
  let res;
  try {
    res = await execa(
      'gh',
      ['api', 'graphql', '-f', `query=${CONTRIBUTIONS_QUERY}`, '-f', `from=${from}`, '-f', `to=${to}`],
      {
        reject: false,
        timeout: API_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        // As everywhere here: execa's default piped stdin is never closed, and
        // a CLI that reads stdin then waits forever.
        stdin: 'ignore',
        env: { NO_COLOR: '1' },
      },
    );
  } catch (e) {
    return unavailable(`gh could not be run: ${(e as Error).message}`);
  }

  if (res.exitCode !== 0) {
    const detail = firstLine(String(res.stderr ?? '')) || `gh exited ${res.exitCode}`;
    return unavailable(`gh could not reach GitHub: ${detail}`);
  }

  try {
    return readSnapshot(JSON.parse(String(res.stdout ?? '')), day, 'gh');
  } catch {
    return unavailable('gh returned output that was not JSON');
  }
}

/**
 * Fallback for a machine where `gh` is not installed. Kept because it is what
 * `.env.example` has always documented.
 */
async function viaToken(day: string, from: string, to: string, token: string): Promise<ContributionSnapshot> {
  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: CONTRIBUTIONS_QUERY, variables: { from, to } }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    // Deliberately reports the status only. The request carried the token, so
    // nothing derived from it gets logged.
    if (!res.ok) return unavailable(`GitHub API returned HTTP ${res.status}`);
    return readSnapshot(await res.json(), day, 'token');
  } catch (e) {
    return unavailable(`GitHub API unreachable: ${(e as Error).message}`);
  }
}

/** Ask GitHub what it recorded for `day`. Never throws. */
async function contributionsOn(day: string): Promise<ContributionSnapshot> {
  // Parsed without a `Z`, so these are local midnight and local end-of-day —
  // the same day boundary the ledger counts against.
  const from = new Date(`${day}T00:00:00`).toISOString();
  const to = new Date(`${day}T23:59:59`).toISOString();

  const gh = await viaGhCli(day, from, to);
  if (gh.recorded !== null) return gh;

  const token = process.env.GH_TOKEN;
  if (!token) {
    return unavailable(`${gh.skipped}; set GH_TOKEN to verify without it, or run \`gh auth login\``);
  }
  return viaToken(day, from, to, token);
}

/**
 * Compare what we committed against what GitHub counted, and name the likely
 * cause when they differ.
 *
 * The causes are suggested, not detected: proving an author-email mismatch would
 * need the `user:email` scope, which the standard `gh` login does not carry.
 */
export async function checkContributions(ledgerCommits: number, day = today()): Promise<ContributionCheck> {
  const snapshot = await contributionsOn(day);
  const notes: string[] = [];

  if (snapshot.recorded === null) {
    return { day, ledger: ledgerCommits, snapshot, verdict: 'unverified', notes };
  }

  const verdict: ContributionVerdict =
    snapshot.recorded === ledgerCommits
      ? 'agree'
      : snapshot.recorded < ledgerCommits
        ? 'github-lower'
        : 'github-higher';

  if (verdict === 'github-lower') {
    notes.push(
      `GitHub recorded ${snapshot.recorded} contribution(s) but the ledger committed ` +
        `${ledgerCommits}. Likely causes, cheapest first:`,
      `1. Commits were never pushed — check \`git log origin/<branch>..HEAD\` in each repo.`,
      // The 34-commit rewrite: everything was committed and pushed, and none of
      // it counted, because the author email was not on the GitHub account.
      `2. The commit author email is not linked to ${snapshot.login ?? 'the account'} — ` +
        `compare \`git config user.email\` with your GitHub verified emails.`,
      `3. The commits are on a fork, or on a branch that is not the repo's default — ` +
        `GitHub counts neither.`,
    );
  }

  if (verdict === 'github-higher') {
    // Not a fault. GitHub counts issues, reviews and any work done by hand.
    notes.push(
      `GitHub recorded ${snapshot.recorded} contribution(s), more than the ${ledgerCommits} ` +
        `this system committed — the rest is work done outside ShanAuto.`,
    );
  }

  if (snapshot.privateCounted) {
    // Both configured repos are private. Saying this up front is the difference
    // between an explained number and a phantom discrepancy report.
    notes.push(
      `Some of these are in private repositories. They count for ${snapshot.login ?? 'you'} here, ` +
        `but appear on your public profile only if Settings -> Public profile -> ` +
        `"Include private contributions on my profile" is enabled.`,
    );
  }

  const declared = process.env.GH_USER;
  if (declared && snapshot.login && declared !== snapshot.login) {
    notes.push(
      `GH_USER is "${declared}" but the credential in use belongs to "${snapshot.login}" — ` +
        `you are verifying a different account than you configured.`,
    );
  }

  return { day, ledger: ledgerCommits, snapshot, verdict, notes };
}

/**
 * One line, suitable for a log or a report header.
 *
 * Three outcomes, not two. `github-higher` is documented twenty lines above as
 * NOT a fault — GitHub counts issues, reviews and anything done by hand, so it
 * is higher on any day the owner touched their own work — and this line printed
 * "they DISAGREE" for it anyway.
 *
 * Measured 2026-08-30: ledger 6, GitHub 8, and every one of the seven commits
 * on disk was verified present on origin/main with nothing unpushed. The run
 * had done exactly what it was supposed to and its closing line read as an
 * alarm about the one thing this system exists to do.
 *
 * A word in capitals is the loudest thing on the screen. It has to be reserved
 * for the case that earns it: GitHub counting FEWER than we committed, which
 * means work that was made did not arrive.
 */
export function summariseContributions(check: ContributionCheck): string {
  if (check.verdict === 'unverified') {
    return `contribution verification unavailable — ${check.snapshot.skipped}`;
  }
  const who = check.snapshot.login ? ` for ${check.snapshot.login}` : '';
  const how = check.snapshot.source === 'gh' ? 'gh CLI' : 'GH_TOKEN';
  const head = `ledger ${check.ledger} vs GitHub ${check.snapshot.recorded}${who}`;

  if (check.verdict === 'agree') return `${head} — they agree (via ${how})`;
  if (check.verdict === 'github-higher') {
    return (
      `${head} — every commit arrived; the rest is work done outside ShanAuto ` +
      `(via ${how})`
    );
  }
  return `${head} — they DISAGREE, GitHub counted fewer (via ${how})`;
}

/** Is this a number the operator has to do something about? */
export function needsAttention(check: ContributionCheck): boolean {
  // `github-higher` is expected on any day the owner did their own work, and
  // `unverified` is a missing gh login, which doctor reports on its own line.
  return check.verdict === 'github-lower';
}
