/**
 * Minimal WebM (Matroska) writer for one video track of already-encoded VP8/VP9
 * frames: EBML header, Segment { Info, Tracks, Clusters, Cues }. Times are in
 * milliseconds (TimestampScale 1 ms). A new Cluster starts at every key frame
 * (and before a block's relative time would overflow int16), and each Cluster
 * gets a Cue so players can seek. No dependency: the browser encodes, this
 * only frames the bytes.
 */

export interface EncodedFrame {
  /** Presentation time in ms from the start of the video. */
  timeMs: number;
  key: boolean;
  data: Uint8Array;
}

export interface WebmTrack {
  codec: 'V_VP8' | 'V_VP9';
  width: number;
  height: number;
  /** Total length in ms (the last frame is shown until then). */
  durationMs: number;
}

function vint(n: number): Buffer {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = Buffer.alloc(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new Error('EBML size too large');
}

function uint(n: number): Buffer {
  const bytes: number[] = [];
  let v = Math.max(0, Math.floor(n));
  do { bytes.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0);
  return Buffer.from(bytes);
}

function float(n: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeDoubleBE(n);
  return out;
}

/** One EBML element: id bytes, size, payload (parts are concatenated). */
export function el(id: number, ...parts: Array<Buffer | Uint8Array>): Buffer {
  const idBytes = uint(id);
  const body = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
  return Buffer.concat([idBytes, vint(body.length), body]);
}

function simpleBlock(relMs: number, key: boolean, data: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0x81; // track 1
  head.writeInt16BE(relMs, 1);
  head[3] = key ? 0x80 : 0x00;
  return el(0xa3, head, data);
}

export function muxWebm(track: WebmTrack, frames: EncodedFrame[]): Buffer {
  if (!frames.length || !frames[0].key) throw new Error('WebM needs a key frame first');
  const header = el(0x1a45dfa3,
    el(0x4286, uint(1)), el(0x42f7, uint(1)), el(0x42f2, uint(4)), el(0x42f3, uint(8)),
    el(0x4282, Buffer.from('webm')), el(0x4287, uint(4)), el(0x4285, uint(2)));
  const info = el(0x1549a966,
    el(0x2ad7b1, uint(1_000_000)), el(0x4489, float(Math.max(track.durationMs, frames[frames.length - 1].timeMs))),
    el(0x4d80, Buffer.from('cdp-cli')), el(0x5741, Buffer.from('cdp-cli video')));
  const tracks = el(0x1654ae6b, el(0xae,
    el(0xd7, uint(1)), el(0x73c5, uint(1)), el(0x83, uint(1)), el(0x9c, uint(0)),
    el(0x86, Buffer.from(track.codec)),
    el(0xe0, el(0xb0, uint(track.width)), el(0xba, uint(track.height)))));

  const clusters: Buffer[] = [];
  const cues: Array<{ timeMs: number; position: number }> = [];
  let position = info.length + tracks.length; // offsets are from the Segment payload start
  let blocks: Buffer[] = [];
  let clusterStart = 0;
  const flush = (): void => {
    if (!blocks.length) return;
    const cluster = el(0x1f43b675, el(0xe7, uint(clusterStart)), ...blocks);
    cues.push({ timeMs: clusterStart, position });
    position += cluster.length;
    clusters.push(cluster);
    blocks = [];
  };
  for (const frame of frames) {
    const t = Math.max(0, Math.round(frame.timeMs));
    if (!blocks.length || frame.key || t - clusterStart > 32_000) {
      flush();
      clusterStart = t;
    }
    blocks.push(simpleBlock(t - clusterStart, frame.key, frame.data));
  }
  flush();
  const cueElement = el(0x1c53bb6b, ...cues.map((cue) => el(0xbb,
    el(0xb3, uint(cue.timeMs)), el(0xb7, el(0xf7, uint(1)), el(0xf1, uint(cue.position))))));
  return Buffer.concat([header, el(0x18538067, info, tracks, ...clusters, cueElement)]);
}
