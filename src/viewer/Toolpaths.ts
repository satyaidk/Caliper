import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { PreviewData } from '@/slicer/verify';

/**
 * Draws a G-code file's moves on the plate, layer by layer: the Preview after
 * slicing. The data is what the checker read back from the G-code text, so the
 * picture is the file itself, not the slicer's idea of it.
 *
 * Printer space is Z up with the origin at the bed's front-left corner; the
 * viewer is Y up with the plate centred on the origin. Converting:
 *
 *   world x =  (X − width / 2) × worldPerMm
 *   world y =   Z              × worldPerMm
 *   world z = −(Y − depth / 2) × worldPerMm
 *
 * Each segment is one instance of LineSegments2, in layer order, so showing
 * "everything up to layer n" is just how many instances are drawn.
 */

/** Role colours, after the slicers' previews: warm walls, cool supports, red top. */
export const ROLE_COLOURS = [
  '#ff7d38', // outer wall
  '#ffc45c', // inner wall
  '#b8434e', // sparse infill
  '#9a5cc6', // solid infill
  '#ff4d6a', // top surface
  '#3d8bff', // bridge
  '#00ae42', // skirt and brim
  '#3fc6c6', // support
  '#8a8a8a', // purge
  '#cfcfcf', // other
];

export class Toolpaths {
  readonly group = new THREE.Group();
  private readonly material = new LineMaterial({ vertexColors: true, linewidth: 2, worldUnits: false });
  private readonly travelMaterial = new LineMaterial({
    color: 0x58b4ff,
    linewidth: 1,
    worldUnits: false,
    transparent: true,
    opacity: 0.55,
  });
  private lines: LineSegments2 | null = null;
  private travel: LineSegments2 | null = null;
  private data: PreviewData | null = null;

  constructor() {
    this.group.name = '__caliper_toolpaths';
    this.group.visible = false;
  }

  get active(): boolean {
    return this.data !== null;
  }

  get layerCount(): number {
    return this.data?.layerStarts.length ?? 0;
  }

  set(data: PreviewData | null, bed: [number, number], worldPerMm: number) {
    this.clear();
    this.data = data;
    if (!data) return;
    const [w, d] = bed;
    const toWorld = (source: Float32Array) => {
      const out = new Float32Array(source.length);
      for (let i = 0; i < source.length; i += 3) {
        out[i] = (source[i] - w / 2) * worldPerMm;
        out[i + 1] = source[i + 2] * worldPerMm;
        out[i + 2] = -(source[i + 1] - d / 2) * worldPerMm;
      }
      return out;
    };

    const colours = ROLE_COLOURS.map((hex) => new THREE.Color(hex));
    const rgb = new Float32Array(data.segments.length);
    for (let s = 0; s < data.roles.length; s++) {
      const c = colours[data.roles[s]] ?? colours[colours.length - 1];
      for (let k = 0; k < 2; k++) {
        rgb[s * 6 + k * 3] = c.r;
        rgb[s * 6 + k * 3 + 1] = c.g;
        rgb[s * 6 + k * 3 + 2] = c.b;
      }
    }
    if (data.segments.length) {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(toWorld(data.segments));
      geometry.setColors(rgb);
      this.lines = new LineSegments2(geometry, this.material);
      this.lines.frustumCulled = false;
      this.group.add(this.lines);
    }
    // Travels are kept in world space; only the current layer's are drawn.
    this.travelWorld = data.travels.length ? toWorld(data.travels) : null;
    this.group.visible = true;
    this.showUpTo(this.layerCount - 1, false);
  }

  /** Draws layers 0 … `layer`, and the travel moves of `layer` itself when asked. */
  showUpTo(layer: number, showTravel: boolean) {
    const data = this.data;
    if (!data) return;
    const top = Math.max(0, Math.min(layer, data.layerStarts.length - 1));
    const end = top + 1 < data.layerStarts.length ? data.layerStarts[top + 1] : data.roles.length;
    if (this.lines) (this.lines.geometry as LineSegmentsGeometry).instanceCount = end;
    if (this.travel) {
      this.group.remove(this.travel);
      this.travel.geometry.dispose();
      this.travel = null;
    }
    if (showTravel && this.travelWorld) {
      const from = data.travelLayerStarts[top] ?? 0;
      const to = top + 1 < data.travelLayerStarts.length ? data.travelLayerStarts[top + 1] : this.travelWorld.length / 6;
      if (to > from) {
        // A few hundred moves at most: rebuilding them per layer is cheaper than keeping every layer's.
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(this.travelWorld.slice(from * 6, to * 6));
        this.travel = new LineSegments2(geometry, this.travelMaterial);
        this.travel.frustumCulled = false;
        this.group.add(this.travel);
      }
    }
  }

  private travelWorld: Float32Array | null = null;

  setResolution(width: number, height: number, pixelRatio: number) {
    this.material.resolution.set(width, height);
    this.travelMaterial.resolution.set(width, height);
    this.material.linewidth = 1.8 * pixelRatio;
    this.travelMaterial.linewidth = 1 * pixelRatio;
  }

  clear() {
    for (const line of [this.lines, this.travel]) {
      if (!line) continue;
      this.group.remove(line);
      line.geometry.dispose();
    }
    this.lines = null;
    this.travel = null;
    this.travelWorld = null;
    this.data = null;
    this.group.visible = false;
  }

  dispose() {
    this.clear();
    this.material.dispose();
    this.travelMaterial.dispose();
  }
}
