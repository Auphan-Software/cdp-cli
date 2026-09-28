import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSuccessfulAction, replayActions, type RecordedAction } from '../../src/recording.js';

const savedArgv = process.argv;
const savedRecordFile = process.env.CDP_RECORD_FILE;
const savedReplay = process.env.CDP_RECORD_REPLAY;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cdp-actions-'));
  process.exitCode = 0;
});

afterEach(() => {
  process.argv = savedArgv;
  if (savedRecordFile === undefined) delete process.env.CDP_RECORD_FILE;
  else process.env.CDP_RECORD_FILE = savedRecordFile;
  if (savedReplay === undefined) delete process.env.CDP_RECORD_REPLAY;
  else process.env.CDP_RECORD_REPLAY = savedReplay;
  process.exitCode = 0;
  vi.restoreAllMocks();
  for (const name of ['actions.ndjson', 'fake.mjs', 'params.json']) {
    try { unlinkSync(join(dir, name)); } catch { /* not created */ }
  }
  rmdirSync(dir);
});

function readRecorded(): RecordedAction[] {
  return readFileSync(join(dir, 'actions.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

describe('successful action recording', () => {
  it('records a stable frame selector and portable page reference, omitting endpoint/session', () => {
    process.env.CDP_RECORD_FILE = join(dir, 'actions.ndjson');
    process.argv = ['node', 'cdp-cli', 'click', '#save', 'PAGE', '--frame', '#engine', '--wait-for', '#done',
      '--cdp-url', 'http://localhost:9222', '--session', 'worker'];
    recordSuccessfulAction('PAGE', { frame: '#engine' });
    expect(readRecorded()).toEqual([expect.objectContaining({
      seq: 1, frame: '#engine', verification: 'command',
      argv: ['click', '#save', '{{page}}', '--frame', '#engine', '--wait-for', '#done']
    })]);
  });

  it('parameterizes a verified fill value', () => {
    process.env.CDP_RECORD_FILE = join(dir, 'actions.ndjson');
    process.argv = ['node', 'cdp-cli', 'fill', '#username', 'private@example.com', 'PAGE', '--expect-value'];
    recordSuccessfulAction('PAGE');
    const written = readFileSync(join(dir, 'actions.ndjson'), 'utf8');
    expect(written).not.toContain('private@example.com');
    expect(readRecorded()[0].argv).toEqual(['fill', '#username', '{{value1}}', '{{page}}', '--expect-value']);
  });

  it('parameterizes a fill value that begins with a dash', () => {
    process.env.CDP_RECORD_FILE = join(dir, 'actions.ndjson');
    process.argv = ['node', 'cdp-cli', 'fill', '#amount', '-10', 'PAGE', '--expect-value'];
    recordSuccessfulAction('PAGE');
    expect(readRecorded()[0].argv[2]).toBe('{{value1}}');
  });

  it('rejects frame indexes and leaves the journal untouched', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.CDP_RECORD_FILE = join(dir, 'actions.ndjson');
    process.argv = ['node', 'cdp-cli', 'click', '#save', 'PAGE', '--frame', '1'];
    recordSuccessfulAction('PAGE', { frame: '1' });
    expect(process.exitCode).toBe(1);
    expect(() => readRecorded()).toThrow();
  });

  it('replays parameterized steps and fails closed when frame delivery is unverified', () => {
    const file = join(dir, 'actions.ndjson');
    const step: RecordedAction = { schema: 'cdp-cli.actions/1', seq: 1, at: new Date().toISOString(),
      argv: ['click', '#save', '{{page}}', '--frame', '#engine'], frame: '#engine', verification: 'command' };
    appendFileSync(file, `${JSON.stringify(step)}\n`);
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    const fake = join(dir, 'fake.mjs');
    appendFileSync(fake, 'console.log(JSON.stringify({success:true,data:{clickDelivered:null,frameReached:null}}));');
    process.argv = ['node', fake];
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(value => output.push(String(value)));
    replayActions(file, 'PAGE', { cdpUrl: 'http://localhost:9222' });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output[0]).reason, JSON.stringify(output)).toBe('frame-delivery-unverified');
  });

  it('replays only passing expectation steps', () => {
    const file = join(dir, 'actions.ndjson');
    const step: RecordedAction = { schema: 'cdp-cli.actions/1', seq: 1, at: new Date().toISOString(),
      argv: ['state', 'click', '#save', '{{page}}', '--spec', 'expect.json', '--exit-on-fail'],
      verification: 'expectation' };
    appendFileSync(file, `${JSON.stringify(step)}\n`);
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    const fake = join(dir, 'fake.mjs');
    appendFileSync(fake, 'console.log(JSON.stringify({success:true,type:"state-expect",value:{outcome:"PASSED",action:{clickDelivered:null,frameReached:null}}}));');
    process.argv = ['node', fake];
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(value => output.push(String(value)));
    replayActions(file, 'PAGE', { cdpUrl: 'http://localhost:9222' });
    expect(process.exitCode, JSON.stringify(output)).toBe(0);
    expect(JSON.parse(output[0]).outcome).toBe('PASSED');
  });

  it('supplies a fill parameter without writing its value into the journal', () => {
    const file = join(dir, 'actions.ndjson');
    const step: RecordedAction = { schema: 'cdp-cli.actions/1', seq: 1, at: new Date().toISOString(),
      argv: ['fill', '#name', '{{value1}}', '{{page}}', '--expect-value'], verification: 'command' };
    appendFileSync(file, `${JSON.stringify(step)}\n`);
    const paramsFile = join(dir, 'params.json');
    appendFileSync(paramsFile, JSON.stringify({ value1: 'private@example.com' }));
    const fake = join(dir, 'fake.mjs');
    appendFileSync(fake, 'console.log(JSON.stringify({success:process.argv.includes("private@example.com") && process.argv.includes("PAGE"),data:{valueApplied:true}}));');
    process.argv = ['node', fake];
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(value => output.push(String(value)));
    replayActions(file, 'PAGE', { paramsFile, cdpUrl: 'http://localhost:9222' });
    expect(process.exitCode, JSON.stringify(output)).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toContain('private@example.com');
    expect(JSON.parse(output[0]).outcome).toBe('PASSED');
  });
});
