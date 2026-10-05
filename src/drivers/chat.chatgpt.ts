import type { ChatDriver, DriverOpts } from './contracts.js';
import { log, archive } from '../logger.js';
import { sleep } from '../util.js';
import { p } from '../config.js';

/**
 * OPTIONAL human-input channel over the ChatGPT web UI.
 *
 * Two things to know before enabling this (`chat.enabled: true` in drivers.yaml):
 *
 * 1. Automating the ChatGPT web UI is against OpenAI's terms of use, which allow
 *    programmatic access via the API rather than the browser app. The risk you are
 *    accepting is to your own account. The API, or the opencode brain that is
 *    already wired up, are the sanctioned paths.
 * 2. Practically, chat.openai.com sits behind Cloudflare bot detection. Expect this
 *    driver to break periodically regardless of selector quality.
 *
 * Because of both, nothing in the autonomous loop depends on this driver. It is a
 * convenience for dumping ideas by voice/phone into a chat thread instead of editing
 * ideas/inbox.md. If it fails, the run logs a warning and continues.
 *
 * Selectors are declared in one place because they WILL drift.
 */
const SEL = {
  composer: '#prompt-textarea',
  send: '[data-testid="send-button"]',
  stop: '[data-testid="stop-button"]',
  userMsg: '[data-message-author-role="user"]',
  assistantMsg: '[data-message-author-role="assistant"]',
  loginHint: '[data-testid="login-button"]',
};

export class ChatGptChat implements ChatDriver {
  readonly id = 'chatgpt';
  private url: string;
  private profileDir: string;
  private headless: boolean;
  private ctx: any = null;
  private page: any = null;

  constructor(opts: DriverOpts) {
    this.url = (opts.url as string) ?? 'https://chatgpt.com';
    this.profileDir = (opts.profile_dir as string) ?? p('data', 'browser-profile');
    this.headless = (opts.headless as boolean) ?? false;
  }

  async init(): Promise<void> {
    const { chromium } = await import('playwright');
    this.ctx = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: { width: 1400, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Session check: a logged-out page is a hard stop, not something to retry into.
    if (await this.page.locator(SEL.loginHint).count()) {
      throw new Error(
        'ChatGPT session is logged out. Run `npm run sa -- chat:login`, sign in by hand, then close the window.',
      );
    }
    await this.page.waitForSelector(SEL.composer, { timeout: 45_000 });
    log.info('ChatGPT session ready');
  }

  /** Wait for the reply to finish: stop-button gone AND text stable. */
  private async waitForReply(prevCount: number): Promise<string> {
    await this.page.waitForFunction(
      ([sel, n]: [string, number]) => document.querySelectorAll(sel).length > n,
      [SEL.assistantMsg, prevCount],
      { timeout: 180_000 },
    );
    await this.page
      .locator(SEL.stop)
      .waitFor({ state: 'detached', timeout: 300_000 })
      .catch(() => undefined);

    const last = this.page.locator(SEL.assistantMsg).last();
    let prev = '';
    for (let i = 0; i < 60; i++) {
      const cur: string = await last.innerText();
      if (cur && cur === prev) break;
      prev = cur;
      await sleep(500);
    }
    return prev;
  }

  async ask(text: string): Promise<string> {
    const before = await this.page.locator(SEL.assistantMsg).count();
    const composer = this.page.locator(SEL.composer);
    await composer.click();
    await composer.fill(text);
    await this.page.locator(SEL.send).click();
    const reply = await this.waitForReply(before);
    archive('chatgpt-reply', reply);
    return reply;
  }

  /**
   * Read your own messages out of the current thread. Everything you typed is
   * treated as data to be triaged, never as instructions to execute directly -
   * harvested text goes into the idea inbox and through the normal planner.
   */
  async harvest(_sinceIso: string): Promise<string[]> {
    const nodes = this.page.locator(SEL.userMsg);
    const n = await nodes.count();
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push((await nodes.nth(i).innerText()).trim());
    return out.filter(Boolean);
  }

  async dispose(): Promise<void> {
    await this.ctx?.close().catch(() => undefined);
  }
}

export default ChatGptChat;
