import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETTINGS, writeSetting } from '../tui/settings.js';
import { hms, capMs, keyAction, quietNote } from '../tui/app.js';

/**
 * The screen the owner actually uses.
 *
 * These are not cosmetic. The two worst below are silent: a single arrow press
 * that stops the system permanently, and a screen that says "Nothing to build"
 * moments after being told what to build — which gets the same idea entered,
 * planned and built twice.
 *
 * A non-technical person cannot tell "it is thinking" from "it will never do
 * anything again". Everything here is about not making them guess.
 */

const dirs: string[] = [];
afterAll(() =>
  dirs.forEach((d) => {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }),
);

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'tui-'));
  dirs.push(d);
  return d;
}

const setting = (path: string) => SETTINGS.find((s) => s.path === path)!;

describe('a value cannot wrap round to its opposite', () => {
  /*
   * "Stop working at" runs 00:00 .. 23:59. Wrapping made ONE press of → on
   * 23:59 land on 00:00 — which is not midnight tonight, it is before every
   * possible start time. The working day becomes zero minutes and the system
   * never runs again: no error, no warning, and the cause is one keystroke on a
   * screen visited weeks earlier.
   *
   * The list itself is checked here rather than the keypress handler, because
   * the handler stops at the ends and the guarantee has to hold for every
   * setting on the screen — including ones added later.
   */
  it('the last hour is the end of the list, not a step from the first', () => {
    const hours = setting('work_hours.end').choices;
    expect(hours[0]).toBe('00:00');
    expect(hours[hours.length - 1]).toBe('23:59');
  });

  it('every numeric setting is ordered, so an arrow always means more or less', () => {
    for (const s of SETTINGS) {
      const nums = s.choices.filter((v) => typeof v === 'number') as number[];
      if (nums.length < 2) continue;
      const sorted = [...nums].sort((a, b) => a - b);
      expect(nums, `${s.path} must be in order`).toEqual(sorted);
    }
  });

  it('stops at the ends rather than jumping to the other one', () => {
    const src = readFileSync(join(process.cwd(), 'src/tui/settings.ts'), 'utf8');
    // A modulo over the choices is exactly the wrap this cost us.
    const screen = src.slice(src.indexOf('export async function settingsScreen'));
    expect(screen).not.toMatch(/%\s*setting\.choices\.length/);
    expect(screen).toMatch(/target < 0 \|\| target >= setting\.choices\.length/);
  });
});

describe('a hand-edited value is nudged, not reset', () => {
  // A value typed into system.yaml by hand — 12, where the list offers 10 and
  // 15 — matched nothing, and the code fell back to index 0. The first arrow
  // press on any tuned setting silently jumped it to the LOWEST allowed value.
  it('finds the nearest choice for a value not in the list', async () => {
    const src = readFileSync(join(process.cwd(), 'src/tui/settings.ts'), 'utf8');
    expect(src).toMatch(/function nearest/);
    expect(src).not.toMatch(/at < 0 \? 0 :/);
  });
});

describe('a warning that was never shown', () => {
  /*
   * `Setting.warn` was declared, written for two settings, and called nowhere —
   * including on the switch whose warning records that two thirds of one day's
   * work turned out to be code nothing called. A warning nobody sees is a
   * comment.
   */
  it('is now asked before the change is saved', () => {
    const src = readFileSync(join(process.cwd(), 'src/tui/settings.ts'), 'utf8');
    expect(src).toMatch(/s\.warn\?\.\(next\)/);
    expect(src).toMatch(/return confirm\(/);
  });

  it('still produces its text for the setting that matters most', () => {
    const dead = setting('limits.forbid_dead_exports');
    expect(dead.warn?.(false)).toMatch(/nothing called/);
    expect(dead.warn?.(true)).toBeNull();
  });
});

describe('writeSetting keeps the file a person can still read', () => {
  function file(body: string): string {
    const dir = scratch();
    const f = join(dir, 'system.yaml');
    writeFileSync(f, body);
    return f;
  }

  it('changes the value and nothing else', () => {
    const f = file('daily_target: 25   # measured on 2026-08-07\nother: 1\n');
    writeSetting('daily_target', 30, f);
    const out = readFileSync(f, 'utf8');
    expect(out).toContain('daily_target: 30');
    expect(out, 'the reasoning must survive').toContain('# measured on 2026-08-07');
    expect(out).toContain('other: 1');
  });

  it('works on a CRLF file, which is what git checks out here', () => {
    const f = file('work_hours:\r\n  start: "07:00"\r\n  end: "22:00"\r\n');
    writeSetting('work_hours.end', '23:00', f);
    const out = readFileSync(f, 'utf8');
    expect(out).toContain('end: "23:00"');
    expect(out.includes('\r\n'), 'line endings must not be rewritten').toBe(true);
  });

  it('refuses rather than silently doing nothing when the key is absent', () => {
    const f = file('unrelated: 1\n');
    expect(() => writeSetting('daily_target', 30, f)).toThrow(/Could not find/);
  });
});

describe('an idea survives being written down', () => {
  /*
   * Ideas are separated on lines beginning "## ". A description containing one
   * — an entirely reasonable thing to type — became TWO jobs: the second with a
   * heading for a title and half a brief for a body, planned and built as if it
   * were something the owner had asked for.
   *
   * The escaping app.ts applies is checked directly against the planner's own
   * separator, so the two cannot drift apart without this failing.
   */
  const escape = (body: string) => body.replace(/^(#{1,6}\s)/gm, '  $1');
  const SEPARATOR = /^##\s+/m; // parseInbox splits on exactly this

  it('a markdown heading in the description does not start a new idea', () => {
    const written = '## A heading\n\nSome text about what to build.';
    expect(written.split(SEPARATOR)).toHaveLength(2); // the fault
    expect(escape(written).split(SEPARATOR)).toHaveLength(1);
  });

  it('keeps the words the person actually wrote', () => {
    expect(escape('## A heading\n\nSome text')).toContain('A heading');
    expect(escape('### Deeper\n\ntext')).toContain('Deeper');
  });

  it('leaves an ordinary description untouched', () => {
    const plain = 'Add a login page.\n\nIt must not store passwords in plain text.';
    expect(escape(plain)).toBe(plain);
  });

  it('the planner still drops sample ideas, which is why the TUI refuses that name', () => {
    // parseInbox skips any title starting "example:", silently. Someone naming a
    // real job "Example: dark mode" would have watched it vanish with no
    // message anywhere — so the TUI now stops them before it is written.
    const src = readFileSync(join(process.cwd(), 'src/core/planner.ts'), 'utf8');
    expect(src).toMatch(/startsWith\('example:'\)/);
    const app = readFileSync(join(process.cwd(), 'src/tui/app.ts'), 'utf8');
    expect(app).toMatch(/Pick a different name/);
  });

  it('warns about a description too short to plan from, instead of dropping it', () => {
    const src = readFileSync(join(process.cwd(), 'src/core/planner.ts'), 'utf8');
    expect(src, 'the planner still enforces it').toMatch(/body\.length < 20/);
    const app = readFileSync(join(process.cwd(), 'src/tui/app.ts'), 'utf8');
    expect(app).toMatch(/That is a little too short/);
  });
});

describe('keys that are not text are not typed as text', () => {
  /*
   * Home, End, PgUp, PgDn and Delete arrive as escape sequences. Unrecognised
   * ones fell through to `{ char: s }`, so pressing Home inside the description
   * box typed a literal "[1~" into the idea — invisible as a cause, and it goes
   * on to the planner as part of the brief.
   */
  /*
   * Asserted through the parser now, not by grepping ui.ts for `resolve('home')`.
   * That spelling was an implementation detail: when the reader became a lookup
   * table this went red while the behaviour it is named after was untouched, and
   * a guard that fails for the wrong reason teaches people to edit the guard.
   * The chunked-input cases live in ui-keys.test.ts.
   */
  it('names them, and ignores any escape sequence it does not know', async () => {
    const { nextKey } = await import('../tui/ui.js');
    expect(nextKey('\x1B[1~').key).toBe('home');
    expect(nextKey('\x1BOF').key).toBe('end');
    expect(nextKey('\x1B[5~').key).toBe('pageup');
    // F5 — the point is that it is not handed back as the text "[15~".
    expect(nextKey('\x1B[15~').key).toBe('unknown');
    expect(nextKey('\x1B[15~').rest).toBe('');
  });
});

describe('the screens that could lose or mislead', () => {
  const app = () => readFileSync(join(process.cwd(), 'src/tui/app.ts'), 'utf8');

  it('reads the project list before asking for anything', () => {
    // loadConfig throws on an empty or malformed repos.yaml, and it was called
    // AFTER the title was typed — so the friendly "No projects yet" screen was
    // unreachable, and a new user got a Node stack trace with their text lost.
    const src = app();
    const fn = src.slice(src.indexOf('async function tellItWhatToBuild'));
    expect(fn.indexOf('loadConfig'), 'config is read first').toBeLessThan(fn.indexOf("await input("));
    expect(fn).toMatch(/catch \(e\) \{[\s\S]{0,200}Cannot read your projects/);
  });

  it('confirms an idea was saved, so nobody enters it twice', () => {
    expect(app()).toMatch(/await notice\('Saved'/);
  });

  it('does not claim a start time while it is paused', () => {
    const src = app();
    expect(src).toMatch(/it is paused — it will not start on its own/);
  });

  it('calls a job ready only when the run could actually pick it', () => {
    /*
     * `waiting` is ready + pending, and a pending job is one whose dependency
     * has not finished — selectBatch cannot pick it. The front screen said
     * "7 job(s) ready" with 4 ready and 3 pending, and the run it invited then
     * attempted 4. The pending ones still get said; they get said as pending.
     */
    const src = app();
    const fn = src.slice(src.indexOf('function computeOverview'));
    expect(fn).toMatch(/const ready = counts\.ready \?\? 0;/);
    expect(fn).toMatch(/\$\{ready\} job\(s\) ready/);
    expect(fn).not.toMatch(/\$\{waiting\} job\(s\) ready/);
    // Said, and said only when there are some: a bare "3 more waiting" under a
    // queue with nothing pending is the same kind of wrong in the other direction.
    expect(fn).toMatch(/const alsoLater = later \?/);
    expect(fn).toMatch(/\$\{later\} more waiting on those to finish/);
  });

  it('asks before letting it loose again, exactly as pausing does', () => {
    expect(app()).toMatch(/confirm\('Let ShanAuto run again\?'/);
  });

  it('does not say "Finished" between un-pausing and starting the work', () => {
    /*
     * Starting while paused used to be two command screens — `resume`, then
     * `run` — and runCommand ends every one of them on "Finished. Press any
     * key to go back.". Measured on a real run 2026-08-15: the operator chose
     * "Start working now", confirmed "let it run?", and the next thing on
     * screen was Finished, before any job had started. My own harness read it
     * as the end of the run, which is the correct reading of that sentence.
     *
     * Asserted on the case-1 body specifically: `run` must be the only command
     * screen it opens, and the killswitch must be cleared in-process.
     */
    const src = app();
    const start = src.indexOf("const go = await confirm('It is paused. Let it run?'");
    expect(start, 'the paused branch is still there').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('case 2: {', start));
    expect(body).toMatch(/if \(existsSync\(KILLSWITCH\(\)\)\) unlinkSync\(KILLSWITCH\(\)\);/);
    expect(body).not.toMatch(/runCommand\('Resuming'/);
    expect(body.match(/await runCommand\(/g) ?? []).toHaveLength(1);
    expect(body).toMatch(/await runCommand\('Working', \['run'\]\)/);
  });

  it('lets the process end when the user chooses Quit', () => {
    // readKey resumes stdin on every press, holding the event loop open. Quit
    // cleared the screen and then sat there dead until Ctrl-C — a terminal
    // shortcut, on the one screen written for someone who avoids terminals.
    expect(app()).toMatch(/process\.stdin\.unref\(\)/);
  });

  it('pages the diary instead of cutting it off', () => {
    const src = app();
    expect(src).toMatch(/await pager\(/);
    expect(src).not.toMatch(/slice\(0, 200\)/);
  });

  it('asks before throwing away a written description', () => {
    const ui = readFileSync(join(process.cwd(), 'src/tui/ui.ts'), 'utf8');
    const ed = ui.slice(ui.indexOf('export async function editor'));
    expect(ed).toMatch(/Throw away what you have written\?/);
  });
});

describe('a command that has stopped moving', () => {
  /*
   * The screen ran `sa` with inherited stdio and no bound on it. Two things
   * followed, and the recorded runs contain both: a 9m32s silence with nothing
   * on screen to say the machine was alive, and — because inherited stdio hands
   * the keyboard to the child — no way to answer this screen until the child
   * chose to finish. The Pause button that exists for exactly that moment was
   * on a menu the operator could no longer reach.
   */
  const MIN = 60_000;

  describe('how long it waits', () => {
    /*
     * The cap is a backstop for a run that has stopped bounding itself, never a
     * limit on a run that is merely long. The executor already checks the
     * killswitch and its max_run_hours budget between jobs and kills one agent
     * at timeouts.task_s — so the cap has to sit above ALL of that, or this
     * screen starts killing healthy overnight runs and the operator's evidence
     * is a run that dies at the same time every night for no visible reason.
     */
    it('leaves room for the whole budget plus one more job', () => {
      const sys = { limits: { max_run_hours: 8 }, timeouts: { task_s: 900 } };
      const own = (8 * 3600 + 900) * 1000;
      expect(capMs(['run'], sys)).toBeGreaterThan(own);
    });

    it('follows the budget up when the owner raises it', () => {
      const small = capMs(['run'], { limits: { max_run_hours: 2 }, timeouts: { task_s: 900 } });
      const large = capMs(['run'], { limits: { max_run_hours: 20 }, timeouts: { task_s: 900 } });
      expect(large).toBeGreaterThan(small);
      expect(large - small).toBe(18 * 3600 * 1000);
    });

    it('follows a longer per-job timeout too', () => {
      const a = capMs(['run'], { limits: { max_run_hours: 8 }, timeouts: { task_s: 900 } });
      const b = capMs(['run'], { limits: { max_run_hours: 8 }, timeouts: { task_s: 3600 } });
      expect(b - a).toBe(2700 * 1000);
    });

    it('resumes are runs, and get a run-sized wait', () => {
      const sys = { limits: { max_run_hours: 8 }, timeouts: { task_s: 900 } };
      expect(capMs(['resume'], sys)).toBe(capMs(['run'], sys));
    });

    it('gives a report half an hour, which is already far past working', () => {
      for (const cmd of ['status', 'report', 'doctor', 'plan', 'ask', 'recall']) {
        expect(capMs([cmd]), cmd).toBe(30 * MIN);
      }
    });

    it('still bounds a run when the config could not be read', () => {
      // loadConfig throws on a broken repos.yaml and this screen swallows it.
      // An unreadable config must not quietly mean an unbounded wait.
      const cap = capMs(['run'], undefined);
      expect(cap).toBeGreaterThan(8 * 3600 * 1000);
      expect(Number.isFinite(cap)).toBe(true);
    });
  });

  describe('what a keypress means while it runs', () => {
    /*
     * Raw mode is what makes this list necessary. The terminal normally turns
     * Ctrl-C into SIGINT; in raw mode it arrives as a byte like any other, so
     * every one of these has to be recognised by hand — and if this were
     * dropped, this change would be the thing that took the operator's only
     * exit away from them.
     */
    it('Ctrl-C means stop now, on any screen', () => {
      expect(keyAction('\x03', true)).toBe('kill');
      expect(keyAction('\x03', false)).toBe('kill');
    });

    it('finds Ctrl-C even when another key arrived with it', () => {
      // Two keys pressed together arrive as one chunk. The one key that must
      // never be missed is the one that gets them out.
      expect(keyAction('a\x03', true)).toBe('kill');
      expect(keyAction('\x03\x03', true)).toBe('kill');
    });

    it('S stops cleanly, but only where a clean stop exists', () => {
      expect(keyAction('s', true)).toBe('stop');
      expect(keyAction('S', true)).toBe('stop');
      expect(keyAction('\x1b', true)).toBe('stop');
      // `doctor` never looks at the killswitch, so offering it a clean stop
      // would be a button that does nothing.
      expect(keyAction('s', false)).toBe('hint');
      expect(keyAction('\x1b', false)).toBe('hint');
    });

    it('an arrow key is not an escape', () => {
      // Down is ESC-[-B. Reading the prefix as the whole key would make
      // pressing Down stop the night's work.
      for (const arrow of ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']) {
        expect(keyAction(arrow, true), JSON.stringify(arrow)).toBe('none');
      }
      expect(keyAction('\x1b[1~', true)).toBe('none'); // Home
    });

    it('ordinary typing does nothing at all', () => {
      for (const k of ['a', 'q', ' ', '\r', 'stop']) expect(keyAction(k, true), k).toBe('none');
    });
  });

  describe('what it says into a silence', () => {
    const t = 10_000_000; // an arbitrary "now"

    it('says nothing while output is still arriving', () => {
      expect(quietNote(t, t - 59_000, t - 10 * MIN, t - 10 * MIN, true)).toBeNull();
    });

    it('speaks up once a minute has passed with nothing printed', () => {
      const note = quietNote(t, t - 90_000, t - 10 * MIN, t - 10 * MIN, true);
      expect(note).not.toBeNull();
      expect(note).toContain('still going');
    });

    it('names both the silence and the whole wait', () => {
      // "nothing for 9m32s" is the number that tells the operator this is not
      // normal; "20m00s in total" is the one that tells them whether to care.
      const note = quietNote(t, t - 572_000, t - 10 * MIN, t - 1_200_000, true)!;
      expect(note).toContain('9m32s');
      expect(note).toContain('20m00s');
    });

    it('does not repeat itself every five seconds', () => {
      // The heartbeat wakes every 5s. Without this the silence it is reporting
      // fills the screen with 12 identical lines a minute.
      expect(quietNote(t, t - 10 * MIN, t - 5_000, t - 10 * MIN, true)).toBeNull();
    });

    it('says it again if the silence goes on', () => {
      expect(quietNote(t, t - 10 * MIN, t - 61_000, t - 10 * MIN, true)).not.toBeNull();
    });

    it('offers the clean stop only when there is one', () => {
      expect(quietNote(t, t - 90_000, t - 10 * MIN, t - 10 * MIN, true)).toContain('Press S');
      const cannot = quietNote(t, t - 90_000, t - 10 * MIN, t - 10 * MIN, false)!;
      expect(cannot).not.toContain('Press S');
      // but never leaves them with no way out named
      expect(cannot).toContain('Ctrl-C');
    });
  });

  describe('the durations are readable by someone who is worried', () => {
    it('counts seconds under a minute', () => {
      expect(hms(0)).toBe('0s');
      expect(hms(59_400)).toBe('59s');
    });

    it('counts minutes above one, zero-padded so it cannot be misread', () => {
      expect(hms(60_000)).toBe('1m00s');
      expect(hms(572_000)).toBe('9m32s');
      expect(hms(8 * 3600_000)).toBe('480m00s');
    });

    it('never shows a negative wait', () => {
      expect(hms(-5_000)).toBe('0s');
    });
  });

  describe('the command is actually bounded and actually watched', () => {
    /*
     * Comments are stripped before anything is matched.
     *
     * Found by mutation: replacing the operator-facing "may still be running"
     * with a flat promise that everything had stopped left this green, because
     * the assertion was matching the comment ABOVE the line explaining why that
     * wording is hedged. A source-level test that a comment can satisfy is
     * testing the prose, and the prose is the one part that cannot be wrong.
     */
    const run = () => {
      const s = readFileSync(join(process.cwd(), 'src/tui/app.ts'), 'utf8');
      return s
        .slice(s.indexOf('async function runCommand'), s.indexOf('function isOn()'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
    };

    it('does not hand the terminal to the child', () => {
      // stdio: 'inherit' is what took the keyboard away. Nothing under `sa`
      // reads stdin, so handing it over bought nothing and cost the operator
      // the ability to answer their own screen.
      expect(run()).not.toMatch(/stdio:\s*'inherit'/);
      expect(run()).toMatch(/stdin:\s*'ignore'/);
    });

    it('watches the output rather than letting it go straight past', () => {
      expect(run()).toMatch(/stdout:\s*'pipe'/);
      expect(run()).toMatch(/stderr:\s*'pipe'/);
      expect(run()).toMatch(/child\.stdout\?\.on\('data'/);
      expect(run()).toMatch(/child\.stderr\?\.on\('data'/);
    });

    it('passes a bound to the child instead of waiting forever', () => {
      expect(run()).toMatch(/timeout: capMs\(args, sys\)/);
    });

    it('gives the terminal back however the command ended', () => {
      // Leaving raw mode on returns the operator to a menu that does not echo
      // what they type, which reads as a frozen computer.
      const r = run();
      expect(r).toMatch(/clearInterval\(beat\)/);
      expect(r).toMatch(/stdin\.off\('data', onKey\)/);
      expect(r).toMatch(/setRawMode\(wasRaw \?\? false\)/);
    });

    it('tells the operator when it gave up, and does not pretend that is normal', () => {
      const r = run();
      expect(r).toMatch(/res\.timedOut/);
      expect(r).toMatch(/Stopped waiting after/);
      // The whole sentence, because the hedge is the point: this screen cannot
      // see whether an agent CLI outlived the run, and must not say it can.
      expect(r).toMatch(/An agent it started may still be running\. Run Checking/);
    });

    it('does not let node print its own warnings onto the operator screen', () => {
      /*
       * tui() suppresses warnings for the menu, and the reason it gives applies
       * just as much here: someone who does not use a terminal cannot tell a
       * warning about a database driver from a real failure. The child is a
       * fresh node, so that suppression never reached it, and every command
       * screen opened with node:sqlite's ExperimentalWarning and a
       * --trace-warnings hint printed into the middle of it.
       */
      const r = run();
      expect(r).toMatch(/NODE_OPTIONS/);
      expect(r).toMatch(/--disable-warning=ExperimentalWarning/);
    });

    it("adds to the operator's NODE_OPTIONS instead of replacing them", () => {
      // Whoever set NODE_OPTIONS did it for a reason, and this screen is not
      // entitled to throw it away to quieten a warning.
      expect(run()).toMatch(/process\.env\.NODE_OPTIONS[\s\S]{0,120}?\.filter\(Boolean\)/);
    });

    it('still hands the child the credentials this process was started with', () => {
      /*
       * extendEnv:false belongs on the agent and verify spawns, where a stripped
       * environment is the security boundary. Here it would take GH_TOKEN and
       * every provider key away from `sa` itself, and the command would fail at
       * the first thing it tried to reach — caused by a change made to hide a
       * warning.
       */
      expect(run()).not.toMatch(/extendEnv:\s*false/);
    });
  });
});
