import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDiagnosticArtifactsAvailable,
  redactDialog,
  redactUrl
} from '../../../src/commands/diagnose.js';

describe('diagnostic URL redaction', () => {
  it('redacts every query value instead of trying to classify credentials', () => {
    const value = redactUrl('https://example.test/callback?code=secret&session=abc123');

    expect(value).not.toContain('secret');
    expect(value).not.toContain('abc123');
    expect(value).toContain('/callback?');
  });

  it('redacts query-like values even when the input is not a parseable URL', () => {
    expect(redactUrl('not a URL?token=secret')).toBe('not a URL?[REDACTED_QUERY]');
  });

  it('does not emit sensitive dialog text', () => {
    const redacted = redactDialog({
      type: 'prompt',
      message: 'Enter OTP 123456',
      url: 'https://example.test/login?token=secret'
    });
    expect(JSON.stringify(redacted)).not.toContain('123456');
    expect(JSON.stringify(redacted)).not.toContain('secret');
    expect(redacted.message).toBe('[REDACTED]');
  });

  it('refuses to overwrite an existing artifact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cdp-cli-diagnose-'));
    const manifest = join(directory, 'manifest.json');
    const screenshot = join(directory, 'screenshot.png');
    try {
      closeSync(openSync(manifest, 'wx'));
      expect(() => assertDiagnosticArtifactsAvailable(manifest, screenshot, directory))
        .toThrow('Diagnostic artifact already exists');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
