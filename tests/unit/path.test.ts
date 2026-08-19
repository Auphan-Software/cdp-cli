import { describe, expect, it } from 'vitest';
import { describeCliPath, normalizeCliPath } from '../../src/path.js';

describe('normalizeCliPath', () => {
  it('translates a Git Bash drive path for a Windows process', () => {
    expect(normalizeCliPath('/q/web/mako2/test.js', 'win32')).toBe('Q:\\web\\mako2\\test.js');
  });

  it('translates a WSL drive path for a Windows process', () => {
    expect(normalizeCliPath('/mnt/c/Users/test/out.png', 'win32')).toBe('C:\\Users\\test\\out.png');
  });

  it('does not reinterpret ordinary rooted paths', () => {
    expect(normalizeCliPath('/tmp/out.png', 'win32')).toBe('/tmp/out.png');
  });

  it('leaves paths unchanged on non-Windows platforms', () => {
    expect(normalizeCliPath('/q/web/mako2/test.js', 'linux')).toBe('/q/web/mako2/test.js');
  });

  it('reports whether normalization changed the caller path', () => {
    const details = describeCliPath('/tmp/out.png');
    expect(details.requestedPath).toBe('/tmp/out.png');
    expect(details.normalizedPath).toBe('/tmp/out.png');
    expect(details.translated).toBe(false);
    expect(details.resolvedPath).toBeTruthy();
  });
});
