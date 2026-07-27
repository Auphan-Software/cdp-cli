/**
 * Pure JS PNG resize using pngjs + area-average downscaling.
 * Replaces the native sharp dependency.
 */

import { PNG } from 'pngjs';

/**
 * Area-average (box filter) downscale on raw RGBA pixel data.
 * Averages all source pixels that map to each destination pixel,
 * preserving thin details like checkbox borders and text.
 */
function areaAverageResize(
  src: Buffer,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Buffer {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const srcY0 = y * yRatio;
    const srcY1 = (y + 1) * yRatio;
    const yStart = Math.floor(srcY0);
    const yEnd = Math.min(Math.ceil(srcY1), srcH);

    for (let x = 0; x < dstW; x++) {
      const srcX0 = x * xRatio;
      const srcX1 = (x + 1) * xRatio;
      const xStart = Math.floor(srcX0);
      const xEnd = Math.min(Math.ceil(srcX1), srcW);

      let r = 0, g = 0, b = 0, a = 0;
      let totalWeight = 0;

      for (let sy = yStart; sy < yEnd; sy++) {
        // Vertical coverage fraction
        const wy = Math.min(sy + 1, srcY1) - Math.max(sy, srcY0);

        for (let sx = xStart; sx < xEnd; sx++) {
          // Horizontal coverage fraction
          const wx = Math.min(sx + 1, srcX1) - Math.max(sx, srcX0);
          const w = wx * wy;

          const off = (sy * srcW + sx) * 4;
          r += src[off] * w;
          g += src[off + 1] * w;
          b += src[off + 2] * w;
          a += src[off + 3] * w;
          totalWeight += w;
        }
      }

      const dstOff = (y * dstW + x) * 4;
      dst[dstOff] = Math.round(r / totalWeight);
      dst[dstOff + 1] = Math.round(g / totalWeight);
      dst[dstOff + 2] = Math.round(b / totalWeight);
      dst[dstOff + 3] = Math.round(a / totalWeight);
    }
  }

  return dst;
}

/**
 * Decode a PNG buffer, resize by scale factor, re-encode to PNG.
 */
export async function resizePngBuffer(buffer: Buffer, scale: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const png = new PNG();
    png.parse(buffer, (err, parsed) => {
      if (err) return reject(err);

      const srcW = parsed.width;
      const srcH = parsed.height;
      const dstW = Math.round(srcW * scale);
      const dstH = Math.round(srcH * scale);

      const resizedData = areaAverageResize(parsed.data as unknown as Buffer, srcW, srcH, dstW, dstH);

      const out = new PNG({ width: dstW, height: dstH });
      resizedData.copy(out.data as unknown as Buffer);

      const chunks: Buffer[] = [];
      out.pack()
        .on('data', (chunk: Buffer) => chunks.push(chunk))
        .on('end', () => resolve(Buffer.concat(chunks)))
        .on('error', reject);
    });
  });
}
