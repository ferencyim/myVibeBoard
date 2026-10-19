// Evidence thumbnails: PNG screenshots are box-downscaled to at most THUMB_MAX_WIDTH px wide.
// Other kinds (GIF, video, logs) get none: the UI shows the original (GIF, size-capped) or a link.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

export const THUMB_MAX_WIDTH = 320;

/** Downscale a PNG to `maxWidth` (box filter). Returns the input unchanged when already small. */
export function thumbnailPng(source: Buffer, maxWidth = THUMB_MAX_WIDTH): Buffer {
  const src = PNG.sync.read(source);
  if (src.width <= maxWidth) return source;
  const width = maxWidth;
  const height = Math.max(1, Math.round((src.height * width) / src.width));
  const out = new PNG({ width, height });
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.ceil((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          const alpha = src.data[i + 3]!;
          r += src.data[i]! * alpha;
          g += src.data[i + 1]! * alpha;
          b += src.data[i + 2]! * alpha;
          a += alpha;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      out.data[o] = a ? Math.round(r / a) : 0;
      out.data[o + 1] = a ? Math.round(g / a) : 0;
      out.data[o + 2] = a ? Math.round(b / a) : 0;
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return PNG.sync.write(out);
}

/** Writes `<name>.thumb.png` next to a PNG evidence file; returns its path, or null (not a PNG, unreadable). */
export function writeThumbnail(file: string): string | null {
  if (!file.toLowerCase().endsWith(".png") || !existsSync(file)) return null;
  try {
    const thumbPath = file.replace(/\.png$/i, ".thumb.png");
    writeFileSync(thumbPath, thumbnailPng(readFileSync(file)));
    return thumbPath;
  } catch {
    return null;
  }
}
