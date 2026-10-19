// Pure-JS image helpers for web evidence: PNG frames -> GIF, and before/after comparison.
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { PNG } from "pngjs";

export function encodeGif(pngFrames: readonly Buffer[], frameDelayMs = 700): Buffer {
  if (pngFrames.length === 0) throw new Error("No frames to encode");
  const first = PNG.sync.read(pngFrames[0]);
  const gif = GIFEncoder();
  for (const buf of pngFrames) {
    const png = PNG.sync.read(buf);
    // Frames from one viewport share a size; pad/crop defensively to the first frame's size.
    const rgba = fit(png, first.width, first.height).data;
    const palette = quantize(rgba, 256);
    gif.writeFrame(applyPalette(rgba, palette), first.width, first.height, {
      palette,
      delay: frameDelayMs,
    });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

function fit(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  out.data.fill(255);
  PNG.bitblt(png, out, 0, 0, Math.min(png.width, width), Math.min(png.height, height), 0, 0);
  return out;
}

export interface Comparison {
  /** Side-by-side before | after | diff, as PNG. */
  composite: Buffer;
  /** Share of pixels that differ noticeably, 0..1. */
  changedRatio: number;
}

const CHANNEL_THRESHOLD = 16;
const GAP = 8;

export function compareScreenshots(before: Buffer, after: Buffer): Comparison {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const pa = fit(a, width, height);
  const pb = fit(b, width, height);
  const diff = new PNG({ width, height });
  let changed = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const differs =
      Math.abs(pa.data[o] - pb.data[o]) > CHANNEL_THRESHOLD ||
      Math.abs(pa.data[o + 1] - pb.data[o + 1]) > CHANNEL_THRESHOLD ||
      Math.abs(pa.data[o + 2] - pb.data[o + 2]) > CHANNEL_THRESHOLD;
    if (differs) {
      changed++;
      diff.data.set([255, 0, 0, 255], o);
    } else {
      // Faded copy of the new screenshot so the changed regions stay in context.
      diff.data.set(
        [
          (pb.data[o] + 765) >> 2,
          (pb.data[o + 1] + 765) >> 2,
          (pb.data[o + 2] + 765) >> 2,
          255,
        ],
        o,
      );
    }
  }
  const out = new PNG({ width: width * 3 + GAP * 2, height });
  out.data.fill(200);
  PNG.bitblt(pa, out, 0, 0, width, height, 0, 0);
  PNG.bitblt(pb, out, 0, 0, width, height, width + GAP, 0);
  PNG.bitblt(diff, out, 0, 0, width, height, (width + GAP) * 2, 0);
  return { composite: PNG.sync.write(out), changedRatio: changed / (width * height) };
}
