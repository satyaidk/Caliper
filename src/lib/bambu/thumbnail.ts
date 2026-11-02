/**
 * Plate thumbnails for the `.gcode.3mf`, drawn from the toolpaths themselves.
 *
 * Why not a WebGL screenshot: slicing runs in a Web Worker with no canvas
 * guaranteed, and the printer only needs a recognisable picture of what is on
 * the plate. Toolpaths are rasterised top-down, later layers over earlier
 * ones and shaded by height, then PNG-encoded with fflate's zlib.
 */
import { zlibSync } from 'fflate';
import type { ToolpathResult } from '../toolpath';

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encodes an RGBA buffer as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) throw new RangeError('PNG pixel buffer has the wrong size.');
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0;
    rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(rows)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/**
 * Draws the toolpaths seen from above, framed on the parts with a margin,
 * in the filament colour shaded from dark (low) to light (high).
 */
export function renderThumbnail(toolpaths: ToolpathResult, size: number, colour = '#00AE42'): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const layer of toolpaths.layers) {
    for (const path of layer.paths) {
      for (const point of path.points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }
  }
  if (!Number.isFinite(minX)) return encodePng(size, size, rgba);
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const scale = (size * 0.86) / span;
  const offsetX = (size - (maxX - minX) * scale) / 2;
  const offsetY = (size - (maxY - minY) * scale) / 2;
  const base = /^#([0-9a-f]{6})$/i.exec(colour) ? colour : '#00AE42';
  const rgb = [1, 3, 5].map((i) => parseInt(base.slice(i, i + 2), 16));
  const top = toolpaths.maxZ || 1;

  const plot = (px: number, py: number, shade: number) => {
    const x = Math.round(px);
    const y = Math.round(py);
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = Math.min(255, rgb[0] * shade);
    rgba[i + 1] = Math.min(255, rgb[1] * shade);
    rgba[i + 2] = Math.min(255, rgb[2] * shade);
    rgba[i + 3] = 255;
  };
  for (const layer of toolpaths.layers) {
    const shade = 0.55 + 0.6 * (layer.z / top);
    for (const path of layer.paths) {
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1];
        const b = path.points[i];
        // Image Y runs down; plate Y runs to the back, so the back is drawn at the top.
        const ax = offsetX + (a.x - minX) * scale;
        const ay = size - (offsetY + (a.y - minY) * scale);
        const bx = offsetX + (b.x - minX) * scale;
        const by = size - (offsetY + (b.y - minY) * scale);
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
        for (let s = 0; s <= steps; s++) plot(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, shade);
      }
    }
  }
  return encodePng(size, size, rgba);
}
