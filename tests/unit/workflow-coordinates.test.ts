import { describe, it, expect } from 'vitest';
import { imagePointToViewport, layoutSignature } from '../../src/workflow-coordinates.js';
import type { PageState } from '../../src/state/types.js';

const shot = { available: true, coordinateAligned: true, pixelWidth: 617, pixelHeight: 338,
  coordinateFrame: { width: 1234, height: 676, imageScope: 'full viewport' } };
describe('screenshot-bound pointer mapping', () => {
  it('maps delivered pixels to CSS independently of DPR and allows unequal rounded axes', () => {
    expect(imagePointToViewport(shot, 300, 150)).toEqual({ x: 600, y: 300 });
    expect(imagePointToViewport({ ...shot, pixelHeight: 337 }, 0, 100).y).toBeCloseTo(200.59347);
  });
  it('refuses missing, unaligned and cropped evidence and out-of-bounds points', () => {
    for (const altered of [undefined, { ...shot, coordinateAligned: false }, { ...shot, available: false },
      { ...shot, pixelWidth: 0 }, { ...shot, coordinateFrame: { ...shot.coordinateFrame, imageScope: 'cropped document' } }])
      expect(() => imagePointToViewport(altered, 0, 0)).toThrow('IMAGE_UNAVAILABLE');
    for (const [x, y] of [[-1, 0], [0, -1], [617, 0], [0, 338], [NaN, 0], [0, Infinity]])
      expect(() => imagePointToViewport(shot, x, y)).toThrow('OUT_OF_BOUNDS');
  });
  it('detects layout drift that semantic state alone ignores, allowing configured clock boxes only', () => {
    const state = { elements: [{ k: 'button', box: [10, 20, 30, 40] }, { k: 'clock', cosmeticClock: true, box: [0, 0, 10, 10] }] } as PageState;
    const moved = structuredClone(state); moved.elements[0].box![0] = 11;
    expect(layoutSignature(moved)).not.toBe(layoutSignature(state));
    moved.elements[0].box![0] = 10; moved.elements[1].box![2] = 11;
    expect(layoutSignature(moved)).toBe(layoutSignature(state));
  });
});
