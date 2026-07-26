import type * as THREE from 'three';

/** How a format reaches the screen. Drives the badge colour and the copy. */
export type Pipeline = 'mesh' | 'cad' | 'bim';

export interface FormatSpec {
  /** Lower-case extension without the dot. */
  ext: string;
  label: string;
  pipeline: Pipeline;
  /** Extra files the loader will pick up if they are dropped alongside. */
  companions?: string[];
}

export type RenderMode = 'shaded' | 'wireframe' | 'edges' | 'xray' | 'normals';
export type ProjectionMode = 'perspective' | 'orthographic';
export type ViewPreset =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'iso';
export type ClipAxis = 'x' | 'y' | 'z';
export type UnitSystem = 'mm' | 'cm' | 'm' | 'in';

export interface SceneStats {
  objects: number;
  meshes: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: number;
}

export interface Dimensions {
  x: number;
  y: number;
  z: number;
  diagonal: number;
  center: [number, number, number];
}

export interface ModelInfo {
  name: string;
  ext: string;
  pipeline: Pipeline;
  bytes: number;
  /** Wall-clock parse + tessellation time, ms. */
  parseMs: number;
  stats: SceneStats;
  dimensions: Dimensions;
}

export interface TreeNode {
  id: string;
  name: string;
  type: string;
  triangles: number;
  children: TreeNode[];
}

export interface LoadResult {
  object: THREE.Object3D;
  /** Loaders that carry their own colours ask us not to override materials. */
  hasAuthoredMaterials: boolean;
}

export interface LoadContext {
  /** Every dropped file, keyed by lower-case name and by relative path. */
  files: Map<string, File>;
  /** Blob URL for each entry in `files`, same keys. */
  urls: Map<string, string>;
  onProgress: (fraction: number | null, note?: string) => void;
}

export type Toast = {
  id: number;
  tone: 'info' | 'success' | 'error';
  title: string;
  text?: string;
};
