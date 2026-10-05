import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { AgyAgent } from '../drivers/agent.agy.js';
import { OpenCodeAgent } from '../drivers/agent.opencode.js';
import type { Repo, TaskRow } from '../schemas.js';

/**
 * The wiring behind `agent_check_cmd`, guarded end to end: repos.yaml → the
 * driver → the words the agent reads → the permission file that decides whether
 * those words are a lie.
 *
 * Measured 2026-08-15. The prompt told agy not to run the verify command — for
 * a good reason, it is a compound and agy would be denied and abandon the turn
 * — and agy then chose its own check, `pytest tests/services/test_search.py`.
 * agy matches command strings token-for-token, with no prefixes and no globs
 * (issue #614), so a named test file cannot be allow-listed even in principle.
 * It was denied, finished anyway, and shipped code that broke three tests it
 * could not see.
 *
 * Every link below is one someone could quietly cut while leaving the suite
 * green and the agent blind again.
 */

const REPO: Repo = {
  id: 'demo',
  path: 'D:/nowhere',
  branch: 'main',
  stack: 'python',
  verify_cmd: 'python -m compileall -q . && python -m pytest -q',
  agent_check_cmd: 'python -m pytest -q',
  enabled: true,
  weight: 1,
} as Repo;

const TASK = {
  id: 'T-1',
  title: 'scope search by group',
  instruction: 'Add a group_id filter.',
  acceptance: 'it filters',
  verify_cmd: 'python -m compileall -q . && python -m pytest -q',
  files_hint: '[]',
} as TaskRow;

/** buildPrompt is private, and stays private — nothing but a test wants it. */
const promptOf = (d: unknown, repo: Repo) =>
  (d as { buildPrompt(t: TaskRow, r: Repo, c?: string): string }).buildPrompt(TASK, repo);

const agy = () => new AgyAgent({ bin: 'agy.exe', sandbox: true, skip_permissions: false });
const oc = () => new OpenCodeAgent({});

/**
 * The command as the agent must see it: alone on its own indented line.
 *
 * `toContain(cmd)` looked like it tested this and did not. example-api's
 * verify_cmd ends in the same words (`... && python -m pytest -q`), so the
 * substring is in the prompt whether the driver passed the check command or
 * not — the assertion held with the wiring cut out. Found by mutation, not by
 * the suite, which is the point of running one.
 */
const offersCommand = (prompt: string, cmd: string) =>
  new RegExp(`^ {6}${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(prompt);

describe('agent_check_cmd reaches the agent', () => {
  it('agy is given the configured command and told to copy it exactly', () => {
    const p = promptOf(agy(), REPO);
    expect(offersCommand(p, 'python -m pytest -q')).toBe(true);
    expect(p).toMatch(/EXACTLY this one command/);
  });

  it('opencode is given the same command without the false claim of a denial', () => {
    // opencode's injected config allows bash '*' and denies a named list, so an
    // improvised command runs. Telling it otherwise would be untrue.
    const p = promptOf(oc(), REPO);
    expect(offersCommand(p, 'python -m pytest -q')).toBe(true);
    expect(p).toMatch(/check your own work by running/i);
    expect(p).not.toMatch(/refused outright/i);
  });

  it('agy is told to run nothing when a repo configures no check', () => {
    const p = promptOf(agy(), { ...REPO, agent_check_cmd: undefined });
    expect(p).toMatch(/Do NOT run any shell command to check your work/i);
    expect(p).not.toMatch(/EXACTLY this one command/);
  });

  /*
   * This used to assert `toContain('<VERIFY_CMD>')` under the name "still keeps
   * the gate away from the agent", on the reasoning that a printed command
   * labelled "Do not run it yourself" was being kept away. It was not. On
   * 2026-08-20 agy ran the printed string verbatim on two of four tasks and
   * both ended with nothing committed, so the test was asserting the bug.
   *
   * Away from the agent now means absent from the prompt.
   */
  it('never puts the gate command in front of an allow-listed agent', () => {
    const p = promptOf(agy(), REPO);
    expect(p).not.toContain('<VERIFY_CMD>');
    expect(p).not.toContain('python -m compileall -q . && python -m pytest -q');
    expect(p).toMatch(/You cannot run that check/);
  });

  it('names the files the gate looks at, so the agent still knows the target', () => {
    const task = { ...TASK, verify_cmd: 'python -m pytest -q tests/db/test_search_logs.py' };
    const p = (agy() as unknown as { buildPrompt(t: TaskRow, r: Repo): string }).buildPrompt(task, REPO);
    expect(p).toContain('<VERIFY_TARGETS>');
    expect(p).toContain('tests/db/test_search_logs.py');
    // The path, never the invocation that agy would copy back out.
    expect(p).not.toMatch(/^ *python -m pytest -q tests\/db/m);
  });

  it('tells the agent the truth about whether its own check covers the gate', () => {
    const covered = { ...TASK, verify_cmd: 'python -m pytest -q tests/db/test_x.py' };
    const build = (t: TaskRow) =>
      (agy() as unknown as { buildPrompt(t: TaskRow, r: Repo): string }).buildPrompt(t, REPO);
    expect(build(covered)).toMatch(/if it passes, this passes/);
    // The repo gate is a compound; `python -m pytest -q` does not cover compileall.
    expect(build(TASK)).toMatch(/Nothing you may run covers it/);
  });

  it('still shows the command to an open shell, which can actually run it', () => {
    const p = promptOf(oc(), REPO);
    expect(p).toContain('<VERIFY_CMD>');
  });
});

/*
 * Skipped, not silently passed, when there is no repos.yaml.
 *
 * This read is at describe-body level, so on a fresh clone it did not merely
 * fail one test — the whole FILE failed to collect, and `npm test` reported
 * "0 test" for it before a contributor had run anything. repos.yaml is
 * gitignored because it names paths on the operator's own disk.
 *
 * The ternary is load-bearing even with `skipIf`: vitest still executes a
 * skipped describe's body to collect it, so the read has to be guarded too.
 */
const REPOS_FILE = 'config/repos.yaml';
const HAVE_REPOS = existsSync(REPOS_FILE);

describe.skipIf(!HAVE_REPOS)('the configured command is one agy will actually accept', () => {
  const repos = HAVE_REPOS
    ? (parseYaml(readFileSync(REPOS_FILE, 'utf8')) as { repos: Repo[] })
    : { repos: [] as Repo[] };
  const template = JSON.parse(readFileSync('config/agy-permissions.example.json', 'utf8')) as {
    permissions: { allow: string[] };
  };
  const configured = repos.repos.filter((r) => r.agent_check_cmd);

  it('at least one repo configures a check, or this feature is dead code', () => {
    expect(configured.length).toBeGreaterThan(0);
  });

  it.each(configured.map((r) => [r.id, r.agent_check_cmd!] as const))(
    '%s: `%s` is allow-listed verbatim',
    (_id, cmd) => {
      /*
       * The exact-match rule with no room in it. `command(pytest)` does NOT
       * cover `pytest -q`; a trailing `*` does not make it, it crashes agy
       * (issue #614). If this fails, the agent is being handed a string that
       * will be auto-denied and it is blind again — with a green suite.
       */
      expect(template.permissions.allow).toContain(`command(${cmd})`);
    },
  );

  it.each(configured.map((r) => [r.id, r.agent_check_cmd!] as const))(
    '%s: `%s` is a single command, not a compound',
    (_id, cmd) => {
      // A compound cannot match any rule: no allow entry contains `&&`, and
      // this is exactly how the original two tasks died.
      expect(cmd).not.toMatch(/&&|\|\||[;|]/);
    },
  );
});

/*
 * Finding AO, and the same lesson this file already carries one scar from: the
 * executor resolves the complaint and taskPrompt renders it, both proven, and
 * the hop between them is a driver spreading an argument into an options
 * object. Cut that one line and every other test in the repo stays green -
 * measured, as mutants M10 and M11, on 2026-08-26.
 *
 * Both drivers, separately. They build the same prompt from the same builder
 * and they are still two call sites, and the intern must not be told a
 * different story depending on which agent the router picked.
 */
describe('the complaint the task came from reaches the agent', () => {
  const IDEA = {
    title: 'Unpopular complaints do not count against a document',
    body: 'I want it to stop deciding by popularity at all.',
  };

  /** Same private-method reach as promptOf above, one argument further along. */
  const withIdea = (d: unknown, idea: { title: string; body: string } | null) =>
    (
      d as {
        buildPrompt(
          t: TaskRow,
          r: Repo,
          c?: string,
          rework?: string,
          i?: { title: string; body: string } | null,
        ): string;
      }
    ).buildPrompt(TASK, REPO, undefined, undefined, idea);

  for (const [name, make] of [
    ['agy', agy],
    ['opencode', oc],
  ] as const) {
    it(`${name} puts the operator words in front of the agent`, () => {
      const p = withIdea(make(), IDEA);
      expect(p).toContain(IDEA.body);
      expect(p).toContain(IDEA.title);
      expect(p).toContain('WHY THIS WAS ASKED FOR');
    });

    it(`${name} makes the ALREADY_DONE verdict answerable to it`, () => {
      // The block on its own changes nothing. It is the rule at the bottom of
      // the prompt that decides what the intern measures "already done" against,
      // and the rule only appears when the block does.
      const p = withIdea(make(), IDEA);
      expect(p).toMatch(/against THAT, not against the brief/i);
      expect(p).not.toContain(
        'If the task is already satisfied, change nothing and say ALREADY_DONE.',
      );
    });

    it(`${name} falls back to the old rule when there is no complaint`, () => {
      const p = withIdea(make(), null);
      expect(p).toContain('If the task is already satisfied, change nothing and say ALREADY_DONE.');
      expect(p).not.toContain('WHY THIS WAS ASKED FOR');
    });
  }

  it('tells both agents the same thing about it', () => {
    /*
     * agy and opencode differ in their permission preambles and nowhere else
     * that matters here. If one of them ever grows its own copy of this block,
     * the two interns start disagreeing about what the job was.
     */
    const a = withIdea(agy(), IDEA);
    const o = withIdea(oc(), IDEA);
    const why = (p: string) => p.slice(p.indexOf('WHY THIS WAS ASKED FOR')).split('\n\n')[0];

    expect(why(a)).toBe(why(o));
  });
});
