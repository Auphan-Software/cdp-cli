import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  choiceOptions,
  calibrationSliceKey,
  conservativeDenialDirections,
  decisionDefinitions,
  evalSchemaVersion,
  hazardDirectionMisses,
  parseEvalJsonl,
  requiredGateIds,
  requiredDecisionIds,
  validateCalibrationObservation,
  validateEvalCases
} from '../evals/system-one/contract.js';

const fixturePath = fileURLToPath(new URL('../evals/system-one/cases.jsonl', import.meta.url));
const cases = parseEvalJsonl(readFileSync(fixturePath, 'utf8'));

describe('provider-neutral System One eval corpus', () => {
  it('parses and validates every synthetic case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(validateEvalCases(cases)).toEqual([]);
    expect('risk_score' in decisionDefinitions).toBe(false);
    for (const item of cases as Array<Record<string, any>>) {
      expect(item.schema_version).toBe(evalSchemaVersion);
      expect(Object.keys(item.answers).sort()).toEqual([...requiredDecisionIds].sort());
      expect(item.answers).not.toHaveProperty('risk_score');
      expect(item.answers).not.toHaveProperty('provider_call_allowed');
      expect(item.answers).not.toHaveProperty('confirmation_required');
      expect(Object.keys(item.gates).sort()).toEqual([...requiredGateIds].sort());
      expect(item.gates.provider_call_allowed).toEqual(expect.any(Boolean));
      expect(item.gates.confirmation_required).toEqual(expect.any(Boolean));
      expect(item.state).not.toHaveProperty('expected_postcondition');
      expect(item.oracle.expected_postcondition).toEqual(expect.any(String));
      expect(item.stage2.proposal.operation).toEqual(expect.any(String));
      expect(item.stage2.proposal.target).toEqual(expect.any(String));
      expect(item.stage2.effect_relevant_state.action_effect_summary).toEqual(expect.any(String));
      expect(item.stage2.effect_relevant_state.reversal_summary).toEqual(expect.any(String));
    }
    for (const [id, definition] of Object.entries(decisionDefinitions)) {
      if (definition.type !== 'choice') continue;
      expect(choiceOptions[id]).toContain('defer_to_llm');
      expect(choiceOptions[id]).toContain('insufficient_evidence');
    }
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

  it('rejects a missing exact-question answer instead of silently completing it', () => {
    const altered = structuredClone(cases) as Array<Record<string, any>>;
    delete altered[0].answers.target;
    expect(validateEvalCases(altered).some((error) => error.includes('missing exact question target'))).toBe(true);
  });

  it('requires deterministic gates separately from modeled answers', () => {
    const altered = structuredClone(cases) as Array<Record<string, any>>;
    delete altered[0].gates.provider_call_allowed;
    expect(validateEvalCases(altered).some((error) => error.includes('gates.provider_call_allowed must be boolean'))).toBe(true);

    const withModeledGate = structuredClone(cases) as Array<Record<string, any>>;
    withModeledGate[0].answers.confirmation_required = false;
    expect(validateEvalCases(withModeledGate).some((error) => error.includes('unknown question confirmation_required'))).toBe(true);
  });

  it('requires stage-two proposals to name a target and include effect-relevant context', () => {
    const altered = structuredClone(cases) as Array<Record<string, any>>;
    altered[0].stage2.proposal.target = 'invented-target';
    altered[0].stage2.proposal.target_kind = 'candidate';
    expect(validateEvalCases(altered).some((error) => error.includes('stage2.proposal target is not in state.candidates'))).toBe(true);
  });

  it('keeps target choice invariant to candidate ordering and defers when the target is absent', () => {
    const ordered = cases.filter((item) => (item as Record<string, any>).pair_id === 'candidate-order-invariance') as Array<Record<string, any>>;
    expect(ordered).toHaveLength(2);
    expect(ordered[0].state.candidates.map((candidate: Record<string, unknown>) => candidate.id))
      .not.toEqual(ordered[1].state.candidates.map((candidate: Record<string, unknown>) => candidate.id));
    expect(ordered[0].answers).toEqual(ordered[1].answers);

    const missing = cases.find((item) => (item as Record<string, any>).id === 'candidate-set-missing-export') as Record<string, any>;
    expect(missing.answers.target).toBe('insufficient_evidence');
    expect(missing.answers.status).toBe('blocked');
  });

  it('does not let upstream confidence alter an ambiguous answer', () => {
    const pair = cases.filter((item) => (item as Record<string, any>).pair_id === 'misleading-confidence-target') as Array<Record<string, any>>;
    expect(pair).toHaveLength(2);
    expect(Math.max(...pair.map((item) => item.state.upstream_recommendation.confidence))).toBeGreaterThan(0.9);
    expect(pair[0].answers).toEqual(pair[1].answers);
    expect(pair[0].answers.target).toBe('insufficient_evidence');
  });

  it('calibrates separately by provider, model version, schema, and exact question without thresholding confidence', () => {
    const observation = {
      case_id: 'ambiguous-target-upstream-high-confidence',
      provider: 'synthetic-provider',
      model_version: 'synthetic-model-v1',
      schema_version: evalSchemaVersion,
      question_id: 'target' as const,
      question_text: decisionDefinitions.target.instruction,
      answer: 'format-a',
      confidence: 0.99,
      correct: false
    };
    expect(validateCalibrationObservation(observation)).toEqual([]);
    expect(observation.correct).toBe(false);
    expect(calibrationSliceKey(observation)).not.toBe(calibrationSliceKey({
      ...observation,
      question_id: 'status',
      question_text: decisionDefinitions.status.instruction
    }));
    expect(calibrationSliceKey(observation)).not.toBe(calibrationSliceKey({
      ...observation,
      model_version: 'synthetic-model-v2'
    }));
    expect(validateCalibrationObservation({ ...observation, question_text: 'Choose a target.' }))
      .toContain('observation.question_text must exactly match the declared question');
  });

  it('defines hazard-direction misses separately from conservative denials and deterministic gates', () => {
    expect(hazardDirectionMisses.action_reversible).toEqual({ expected: false, predicted: true });
    expect(conservativeDenialDirections.action_reversible).toEqual({ expected: true, predicted: false });
    expect(hazardDirectionMisses.persistent_data_change).toEqual({ expected: true, predicted: false });
    expect('provider_call_allowed' in hazardDirectionMisses).toBe(false);
    expect('confirmation_required' in decisionDefinitions).toBe(false);
  });
});
