import { resolve } from 'node:path';

/**
 * Translate the two POSIX path shapes commonly passed to a Windows process by
 * Git Bash or WSL. Node itself does not translate these when cdp-cli is an exe.
 *
 * Only a single-letter drive prefix is recognized, so ordinary rooted paths
 * such as /tmp/output.png keep their existing Windows meaning.
 */
export function normalizeCliPath(input: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    return input;
  }

  const msys = input.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (msys) {
    const tail = msys[2] ? `\\${msys[2].replace(/\//g, '\\')}` : '\\';
    return `${msys[1].toUpperCase()}:${tail}`;
  }

  const wsl = input.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (wsl) {
    const tail = wsl[2] ? `\\${wsl[2].replace(/\//g, '\\')}` : '\\';
    return `${wsl[1].toUpperCase()}:${tail}`;
  }

  return input;
}

export interface CliPathDetails {
  requestedPath: string;
  normalizedPath: string;
  resolvedPath: string;
  translated: boolean;
}

export function describeCliPath(input: string): CliPathDetails {
  const normalizedPath = normalizeCliPath(input);
  return {
    requestedPath: input,
    normalizedPath,
    resolvedPath: resolve(normalizedPath),
    translated: normalizedPath !== input
  };
}
