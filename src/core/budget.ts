import type { AppConfig } from '../config.js';
import * as ledger from '../ledger.js';
import type { AgentSpend } from '../ledger.js';
import { log } from '../logger.js';

/**
 * Reading today's agent spend, in a form three different surfaces can print.
 *
 * The run loop, the daily report and `sa status` all need the same sentence and
 * the same over-budget verdict. Rendering it in each of them drifted the wording
 * apart, and worse, would have meant three separate chances to get the "unknown
 * is not zero" rule wrong.
 */

/** Nothing measured. Also what a failed read reports — see dailyBudget. */
const UNKNOWN: AgentSpend = { units: null, unmeasured: 0 };

/**
 * Render spend without ever implying that an unmeasured dispatch was free.
 *
 * Only copilot reports a figure. When anything else ran, the number we have is
 * a floor and is worded as one; when nothing reported at all, the answer is the
 * word "unknown" and not a plausible-looking 0.
 */
function formatSpend(s: AgentSpend): string {
  const tail = s.unmeasured > 0 ? ` · ${s.unmeasured} dispatch(es) reported no figure` : '';
  if (s.units === null) return s.unmeasured > 0 ? `unknown${tail}` : 'nothing recorded';
  const n = Math.round(s.units * 100) / 100;
  return s.unmeasured > 0 ? `at least ${n} unit(s)${tail}` : `${n} unit(s)`;
}

interface BudgetState {
  spend: AgentSpend;
  /** From config. 0 means unlimited. */
  limit: number;
  /** True only on a measured figure above a real limit. */
  over: boolean;
  /** One line, fit for a log, a report table or the status screen. */
  line: string;
}

/**
 * Today's spend against the configured soft budget.
 *
 * Never throws and never reports `over` on a guess. Bookkeeping must fail open:
 * a ledger this cannot read is a reason to say "unknown", not a reason to stop
 * a run or to raise an alarm nobody can act on.
 */
export function dailyBudget(cfg: AppConfig): BudgetState {
  /*
   * Optional-chained even though the schema defaults it.
   *
   * The schema only defends configs that came through `loadConfig`. A config
   * object built by hand — every test does this, and so would any future caller
   * — has no `budget` block, and reading straight through it threw a TypeError
   * from inside the run loop. A soft budget that can abort a run is not soft,
   * and this function's own contract is that it never throws.
   */
  const limit = cfg.system.budget?.daily_agent_units ?? 0;

  let spend = UNKNOWN;
  try {
    spend = ledger.agentSpendForDay();
  } catch (e) {
    log.debug(`could not read today's agent spend: ${(e as Error).message}`);
  }

  const over = limit > 0 && spend.units !== null && spend.units > limit;
  const line = limit > 0 ? `${formatSpend(spend)} of a ${limit} soft budget` : formatSpend(spend);
  return { spend, limit, over, line };
}
