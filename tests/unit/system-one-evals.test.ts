import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEvalJsonl, validateEvalCases } from '../evals/system-one/contract.js';

const fixturePath = fileURLToPath(new URL('../evals/system-one/cases.jsonl', import.meta.url));
const cases = parseEvalJsonl(readFileSync(fixturePath, 'utf8'));

describe('provider-neutral System One eval corpus', () => {
  it('parses and validates every synthetic case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(validateEvalCases(cases)).toEqual([]);
  });

  it('rejects targets not enumerated in that case', () => {
    const altered = structuredClone(cases) as Array<Record<string, any>>;
    altered[0].answers.target = 'invented-selector';
    expect(validateEvalCases(altered).some((error) => error.includes('is not in state.candidates'))).toBe(true);
  });

  it('rejects duplicate case IDs and unredacted personal or credential-like strings', () => {
    const altered = structuredClone(cases) as Array<Record<string, any>>;
    altered[1].id = altered[0].id;
    altered[1].state.evidence.push('Synthetic fixture accidentally contains person@example.invalid');
    const errors = validateEvalCases(altered);
    expect(errors.some((error) => error.includes('duplicates'))).toBe(true);
    expect(errors.some((error) => error.includes('possible secret or personal-data'))).toBe(true);
  });
});
