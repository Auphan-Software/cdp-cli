import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CDPContext } from '../../src/context.js';
import { fill } from '../../src/commands/input.js';
import { CdpSession, LiveChrome, startFixture, type LiveFixture } from './harness.js';

let chrome: LiveChrome;
let fixture: LiveFixture;

// This is intentionally opt-in: a headed Chrome can become foreground on a
// developer's desktop, whereas the baseline suite never does.
describe.runIf(process.env.CDP_LIVE_HEADFUL === '1')('headful background-tab focus delivery', () => {
  beforeAll(async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><input id="background-field">');
    });
    chrome = await LiveChrome.launch({ headful: true });
  }, 30_000);

  afterAll(async () => {
    await chrome?.close();
    await fixture?.close();
    expect(chrome.status()).toEqual({ chromeStopped: true, profileRemoved: true });
  }, 30_000);

  it('delivers fill to a background target while another tab is active', async () => {
    const background = await chrome.createPage(fixture.baseUrl);
    const foreground = await chrome.createPage('about:blank');
    const browser = await chrome.browserSession();
    try {
      await browser.command('Target.activateTarget', { targetId: foreground.id });
      await fill(new CDPContext(chrome.cdpUrl), '#background-field', 'background delivery', { page: background.id });
    } finally {
      browser.close();
    }
    const session = await CdpSession.connect(background.webSocketDebuggerUrl);
    try {
      const value = await session.command('Runtime.evaluate', { expression: 'document.querySelector("#background-field").value', returnByValue: true });
      expect(value.result.value).toBe('background delivery');
    } finally {
      session.close();
    }
  });
});
