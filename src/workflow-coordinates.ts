import type { PageState } from './state/types.js';

/** Coordinates require layout identity in addition to the workflow's semantic guard. */
export function layoutSignature(state: PageState): string {
  return JSON.stringify(state.elements.filter(n => !n.cosmeticClock).map(n => [n.k, n.box]));
}

/** Input points are delivered image pixels, never guessed device-scale factors. */
export function imagePointToViewport(shot: any, x: number, y: number): { x: number; y: number } {
  const frame = shot?.coordinateFrame;
  if (!shot?.available || shot.coordinateAligned !== true || frame?.imageScope !== 'full viewport' ||
    ![shot.pixelWidth, shot.pixelHeight, frame.width, frame.height].every(v => Number.isFinite(v) && v > 0))
    throw new Error('WORKFLOW_COORDINATE_IMAGE_UNAVAILABLE: request an aligned full-viewport screenshot');
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= shot.pixelWidth || y >= shot.pixelHeight)
    throw new Error('WORKFLOW_COORDINATE_OUT_OF_BOUNDS: no action delivered');
  return { x: x * frame.width / shot.pixelWidth, y: y * frame.height / shot.pixelHeight };
}
