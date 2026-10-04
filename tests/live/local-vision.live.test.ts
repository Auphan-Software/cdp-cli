import { it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { lunaSelect } from './luna-selector.js';
import { LiveChrome, startFixture, CdpSession } from './harness.js';
import { LocalVisionProvider } from '../../src/experimental/local-vision.js';
import { JevProvider } from '../../src/experimental/jev.js';
import type { AgentView, AllowedAction } from '../../src/experimental/decision.js';

it.skipIf(!process.env.CDP_VISION_URL)('local screenshot bounded choices', async () => {
  const fixture = await startFixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body style="font:28px sans-serif"><h2>Choose a card</h2><div id="cards" style="display:flex;gap:25px"></div></body></html>'); });
  const chrome = await LiveChrome.launch();
  let session: CdpSession | undefined;
  const rows: any[] = [];
  try {
    const page = await chrome.createPage(fixture.baseUrl);
    session = await CdpSession.connect(page.webSocketDebuggerUrl);
    await session.command('Emulation.setDeviceMetricsOverride', { width: 640, height: 320, deviceScaleFactor: 1, mobile: false });
    targets: for (const target of ['B', 'A', 'C']) {
      const html = ['A','B','C'].map(label => `<button id="${label}" style="font:30px sans-serif;width:150px;height:160px">${label}<br><svg width="70" height="70"><circle cx="35" cy="35" r="30" fill="${label===target?'green':'red'}"/>${label===target?'<path d="M15 35 L30 50 L55 20" fill="none" stroke="white" stroke-width="8"/>':'<path d="M20 20 L50 50 M50 20 L20 50" stroke="white" stroke-width="8"/>'}</svg></button>`).join('');
      await session.command('Runtime.evaluate', { expression: `document.querySelector('#cards').innerHTML=${JSON.stringify(html)}` });
      const source = { id: randomUUID(), digest: createHash('sha256').update(html).digest('hex'), targetId: page.id };
      const state: AgentView = { source, url: 'http://fixture/visual', title: 'Choose a card', errors: [],
        coverage: { truncated: false, unstable: false, unreachableFrames: [] },
        elements: ['A','B','C'].map(k => ({ k, kq: 'strong', role: 'button', name: k })),
        omitted: { count: 0, expand: { sourceId: source.id, sourceDigest: source.digest } }, providerStatus: 'unused' };
      const allowed: AllowedAction[] = [...['A','B','C'].map(id => ({ id, kind: 'click' as const, target: id, description: `Card ${id}` })),
        { id: 'escalate', kind: 'escalate', description: 'Insufficient evidence' }];
      const task = 'Choose the card with the green circle and white check mark. Escalate if the visual evidence is unavailable.';
      const screenshotStart = performance.now();
      const image = await session.command('Page.captureScreenshot', { format: 'png' });
      const screenshotMs = performance.now() - screenshotStart;
      await mkdir('evals/decision/results/visual', { recursive: true });
      const imagePath = resolve(`evals/decision/results/visual/${randomUUID()}.png`);
      await writeFile(imagePath, Buffer.from(image.data, 'base64'));
      for (const arm of ['semantic-only', ...(process.env.JEV_API_KEY ? ['jev-text'] : []), 'local-text', 'local-screenshot',
        ...(process.env.CDP_DECISION_LUNA==='1' ? ['luna-text', 'luna-screenshot'] : [])]) {
        const provider = arm==='jev-text' ? new JevProvider() : new LocalVisionProvider({ url: process.env.CDP_VISION_URL! });
        const started = performance.now();
        let choice: string | null = 'escalate', failure = false;
        let luna;
        try {
          if (arm.startsWith('luna')) {
            luna = await lunaSelect(task, state, allowed, arm==='luna-screenshot' ? imagePath : undefined);
            choice = luna.id;
          } else if (arm!=='semantic-only') choice = (await provider.decideNext(task, state, allowed,
            arm==='local-screenshot' ? { source, width: 640, height: 320, mimeType: 'image/png', data: image.data } : undefined)).actionId;
        } catch { choice=null; failure=true; }
        rows.push({ target, arm, choice, failure, rawCorrect: choice===target, ms: performance.now()-started, screenshotMs,
          metrics: provider.metrics, lunaUsage: luna?.usage ?? null, executionQualified: false });
        // Stop optional vision on its first hard deadline; do not repeatedly run a clearly impractical worker.
        if (arm==='local-screenshot' && failure && performance.now()-started >= 29000) break targets;
      }
    }
  } finally {
    session?.close(); await chrome.close(); await fixture.close();
    await writeFile(process.env.CDP_VISION_RESULTS ?? 'evals/decision/results/vision.json', JSON.stringify({
      warning: 'Raw constrained-choice accuracy; uncalibrated scores cannot authorize execution. Synthetic screenshots, no browser-agent completion.', rows }, null, 2));
  }
}, 300000);
