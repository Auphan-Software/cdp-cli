import { describe, expect, it } from 'vitest';
import { verifyWorkflowReport } from '../live/workflow-verdict.js';

describe('reproduction report oracle', () => {
  const shots = [{ artifact: 'initial.png', screen: '#menu' }, { artifact: 'final.png', screen: '#checkout' }];
  const errors = [{ screen: '#checkout', errors: ['Cart calculation never settled after history restoration'] }];
  const report = { finding: 'cart-stuck', screenshotArtifact: 'final.png', consoleError: errors[0].errors[0] };
  const verdict = (r: unknown) => verifyWorkflowReport(JSON.stringify(r), 'cart-stuck', '#checkout', shots, errors);
  it('requires matching final evidence and the actual observed bug', () => { expect(verdict(report).diagnosed).toBe(true); });
  it('rejects negated findings that a keyword match would accept', () => {
    expect(verdict({ ...report, finding: 'cart-not-stuck' }).diagnosed).toBe(false);
    expect(verifyWorkflowReport(JSON.stringify({ ...report, finding: 'future date rejected' }), 'future-date-accepted', '#checkout', shots, errors).diagnosed).toBe(false);
  });
  it('rejects a real artifact from the wrong workflow stage and fabricated errors', () => {
    expect(verdict({ ...report, screenshotArtifact: 'initial.png' }).diagnosed).toBe(false);
    expect(verdict({ ...report, consoleError: 'Everything succeeded' }).diagnosed).toBe(false);
    expect(verifyWorkflowReport('Reproduced cart stuck', 'cart-stuck', '#checkout', shots, errors).diagnosed).toBe(false);
  });
});
