import { describe, it, expect } from 'vitest';
import { fill, prompt } from '../config.js';
import { DecomposeSchema } from '../schemas.js';

/**
 * The brain has no workspace and no tools, and until 2026-08-08 no prompt said so.
 *
 * agy read the empty scratch dir as an invitation to explore, reached for
 * `command` and `read_file`, was auto-denied by headless mode and returned
 * nothing — a wasted provider request each time. The rule now lives in one
 * fragment that config.ts prefixes to every template, so a new prompt file
 * cannot forget it.
 */
const BRAIN_PROMPTS = ['shape', 'decompose', 'narrate', 'ask', 'repair'];

/**
 * The prompt and the schema must sanction the same answers.
 *
 * decompose.md told the model to return zero tasks for a milestone that was
 * already built; DecomposeSchema called that a violation. On 2026-08-18 both
 * models gave the requested answer, were told it was malformed, and were
 * repaired into fabricating a placeholder task. A green suite said nothing,
 * because nothing tested the two halves against each other.
 *
 * So the example in the prompt is parsed and run through the real schema. If
 * the prompt ever again shows the model a shape the schema refuses, this fails.
 */
describe('the decompose prompt and the decompose schema agree', () => {
  const jsonBlocks = (text: string): string[] =>
    [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]!.trim());

  it('shows the model a way to say there is no work left', () => {
    expect(prompt('decompose')).toContain('nothing_to_do');
  });

  it('shows an example of that answer which the schema actually accepts', () => {
    const empty = jsonBlocks(prompt('decompose')).filter((b) => b.includes('nothing_to_do'));
    expect(empty.length, 'the prompt has no NOTHING TO DO example').toBeGreaterThan(0);
    for (const block of empty) {
      const parsed = DecomposeSchema.safeParse(JSON.parse(block));
      expect(parsed.success, `schema rejected the prompt example: ${block}`).toBe(true);
    }
  });

  it('does not offer the empty answer as a way out of hard work', () => {
    const text = prompt('decompose');
    expect(text).toMatch(/already built/i);
    expect(text).toMatch(/If you are unsure/i);
  });
});

describe('brain prompt assembly', () => {
  it('tells every brain prompt that it has no tools and no workspace', () => {
    for (const name of BRAIN_PROMPTS) {
      const text = prompt(name);
      expect(text, name).toMatch(/no tools/i);
      expect(text, name).toMatch(/auto-denied/i);
    }
  });

  it('keeps each template intact behind the shared rules', () => {
    expect(prompt('decompose')).toContain('Respond with EXACTLY one fenced json code block');
    expect(prompt('decompose')).toContain('DEPENDENCIES ARE EXPENSIVE');
    expect(prompt('repair')).toContain('Your previous response was rejected');
  });

  it('states the rule once, not twice — a fragment does not prefix itself', () => {
    expect(prompt('_no-tools').match(/YOU HAVE NO TOOLS/g)).toHaveLength(1);
    expect(prompt('shape').match(/YOU HAVE NO TOOLS/g)).toHaveLength(1);
  });

  it('still substitutes every placeholder once the rules are prefixed', () => {
    const filled = fill(prompt('narrate'), {
      PERIOD: 'week',
      STARTS: '2026-08-03',
      REPO: 'shanauto',
      STATS: '3 commits',
      HIGHLIGHTS: 'none',
    });
    expect(filled).not.toMatch(/\{\{\w+}}/);
    expect(filled).toContain('beginning 2026-08-03');
  });
});

/*
 * The layer split was fixed one level too low.
 *
 * `decompose.md` has carried an explicit rule for a while — "split it by
 * BEHAVIOUR, never by LAYER" — and it works. `shape.md` had nothing of the
 * kind, so on 2026-08-21 the epic arrived already split as
 *
 *     Database Query and Aggregation Logic
 *     FastAPI Endpoint and Empty State Handling
 *     Integration Testing for Aggregation Rules
 *
 * and there was nothing left for the decomposer's rule to prevent. Each
 * layer-milestone then held one task's worth of work, the decomposer correctly
 * refused to pad, and the backlog floor warned three times a run about a
 * shortfall that started here.
 */
describe('the shape prompt forbids what the decompose prompt forbids', () => {
  it('names the layer split as the thing not to do', () => {
    const text = prompt('shape');
    expect(text).toMatch(/never by layer/i);
    // The rule and a test the model can apply to its own draft, not just a ban.
    expect(text).toMatch(/only value is that a LATER milestone can use it/i);
  });

  it('says tests are not a milestone, which is the split it kept reaching for', () => {
    expect(prompt('shape')).toMatch(/Tests are never their own milestone/i);
  });

  /*
   * Half of a pair: the template declares the slot, and the planner test asserts
   * `shapeIdea` fills it. Either one alone passes while the model is handed the
   * literal `{{SURFACE}}` and plans as blindly as it did before.
   */
  it('has a slot for the surface the shaper is now given', () => {
    expect(prompt('shape')).toContain('{{SURFACE}}');
    expect(prompt('shape')).toMatch(/already answers the idea/i);
  });
});

/*
 * The prompt and the schema have to sanction the same answer here too. The
 * planner is told to send a field; if the schema refused it, the repair loop
 * would spend the model's attempts teaching it to stop.
 */
describe('the planner is told to declare a change to something that already works', () => {
  it('asks for the declaration, and names what counts as one', () => {
    const text = prompt('decompose');
    expect(text).toContain('breaking');
    for (const shape of ['response shape', 'status code', 'required parameter', 'signature'])
      expect(text, shape).toContain(shape);
  });

  /*
   * A planner that thinks declaring costs it something stops declaring. This is
   * the sentence that makes it free, and it is the load-bearing one.
   */
  it('promises the declaration is not held against the task', () => {
    expect(prompt('decompose')).toContain('NEVER penalised');
  });

  it('shows a declaration the schema actually accepts', () => {
    const example = /"breaking":\s*"([^"]+)"/.exec(prompt('decompose'));
    expect(example, 'the prompt shows no example declaration').not.toBeNull();
    const parsed = DecomposeSchema.safeParse({
      tasks: [
        {
          title: 'Return frequent queries in an envelope',
          kind: 'feature',
          instruction: 'wrap the list in a data key so clients can read the message',
          acceptance: 'the endpoint returns an object',
          verify_cmd: 'pytest -q',
          breaking: example![1],
        },
      ],
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

/*
 * The reviewer must NOT reject for this. A finding deletes the junior's work,
 * and the junior did not write the plan that failed to declare the change - it
 * implemented one. qa.md already carries the most expensive lesson available
 * here ("Rejecting correct work for failing to do the impossible"), and this
 * rule is one step from repeating it.
 */
describe('the reviewer reports an undeclared contract change without rejecting for it', () => {
  it('is shown what the plan declared', () => {
    expect(prompt('qa')).toContain('DECLARED BREAKING');
  });

  it('is told to put it in summary', () => {
    expect(prompt('qa')).toMatch(/one sentence in `summary`/);
  });

  it('is told, in as many words, not to make it a finding', () => {
    expect(prompt('qa')).toContain('Do NOT make it a finding');
  });

  it('is told why, so the rule survives a rewrite of the sentence above it', () => {
    // Whitespace-normalised. qa.md is hard-wrapped, this sentence straddles two
    // lines, and which words land on which line is not the fact under test.
    expect(prompt('qa').replace(/\s+/g, ' ')).toContain('the junior did not write the plan');
  });
});
