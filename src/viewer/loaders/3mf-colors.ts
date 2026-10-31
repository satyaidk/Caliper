import * as THREE from 'three';
import { unzipSync } from 'fflate';
import type { FilamentColor } from '@/types';

interface ModelColorData {
  objectColor: number | null;
  triangleColors: Array<number | null> | null;
}

interface BambuColorData {
  palette: string[];
  objects: Map<string, ModelColorData>;
}

const decoder = new TextDecoder();

function decodeText(data: Uint8Array): string {
  return decoder.decode(data).replace(/^\uFEFF/, '');
}

function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    result.set(match[1], (match[2] ?? match[3] ?? '')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'));
  }
  return result;
}

function colorIndex(value: string | undefined, paletteSize: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const extruder = Number(value);
  return Number.isSafeInteger(extruder) && extruder > 0 && extruder <= paletteSize
    ? extruder - 1
    : null;
}

/** Returns the 1-based filament state for Bambu's whole-face paint encodings. */
export function decodeBambuPaintState(value: string | undefined): number | null {
  if (!value || !/^[\da-f]+$/i.test(value)) return null;
  const encoded = Number.parseInt(value, 16);
  if (encoded === 0) return 0;
  if (encoded === 4) return 1;
  if (encoded === 8) return 2;
  if (encoded >= 12 && encoded <= 220 && (encoded - 12) % 16 === 0) {
    return 3 + (encoded - 12) / 16;
  }
  return null;
}

function paintAttribute(source: string): string | undefined {
  const attrs = attributes(source);
  for (const [name, value] of attrs) {
    const lower = name.toLowerCase();
    if (lower === 'paint_color' || lower.endsWith(':mmu_segmentation')) return value;
  }
  return undefined;
}

function trianglePaint(xml: string, paletteSize: number): Array<number | null> | null {
  const mesh = xml.match(/<mesh\b[^>]*>([\s\S]*?)<\/mesh\s*>/i)?.[1];
  const triangles = mesh?.match(/<triangles\b[^>]*>([\s\S]*?)<\/triangles\s*>/i)?.[1];
  if (!triangles) return null;

  const result: Array<number | null> = [];
  for (const match of triangles.matchAll(/<triangle\b([^>]*)\/?>/gi)) {
    const paint = decodeBambuPaintState(paintAttribute(match[1]));
    result.push(paint === null ? null : colorIndex(String(paint), paletteSize));
  }
  return result.length ? result : null;
}

function metadataColor(xml: string, paletteSize: number): number | null {
  for (const match of xml.matchAll(/<metadata\b([^>]*)\/?>/gi)) {
    const attrs = attributes(match[1]);
    if (attrs.get('key') === 'extruder') {
      return colorIndex(attrs.get('value'), paletteSize);
    }
  }
  return null;
}

function parseBambuColorData(data: ArrayBuffer): BambuColorData | null {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(new Uint8Array(data), {
      filter: ({ name }) => /^(?:metadata\/(?:project_settings|model_settings)\.config|3d\/.*\.model)$/i.test(name),
    });
  } catch {
    return null;
  }

  const entries = new Map(Object.entries(archive).map(([path, value]) => [path.toLowerCase(), value]));
  const settings = entries.get('metadata/project_settings.config');
  if (!settings) return null;

  let config: unknown;
  try {
    config = JSON.parse(decodeText(settings));
  } catch {
    return null;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const colors = (config as Record<string, unknown>).filament_colour;
  if (!Array.isArray(colors)) return null;
  const palette = colors.map((value) => {
    if (typeof value !== 'string') return null;
    const match = value.trim().match(/^#?([\da-f]{6})(?:[\da-f]{2})?$/i);
    return match ? `#${match[1]}` : null;
  });
  if (!palette.length || palette.some((color) => color === null)) return null;
  const validPalette = palette as string[];

  const modelSettings = entries.get('metadata/model_settings.config');
  const assignments = new Map<string, number | null>();
  if (modelSettings) {
    const xml = decodeText(modelSettings);
    for (const match of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object\s*>/gi)) {
      const objectId = attributes(match[1]).get('id');
      const objectMetadata = match[2].split(/<part\b/i, 1)[0];
      if (objectId) assignments.set(objectId, metadataColor(objectMetadata, validPalette.length));
      for (const part of match[2].matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part\s*>/gi)) {
        const partId = attributes(part[1]).get('id');
        if (partId) assignments.set(partId, metadataColor(part[2], validPalette.length));
      }
    }
  }

  const objects = new Map<string, ModelColorData>();
  for (const [path, bytes] of entries) {
    if (!/^3d\/.*\.model$/i.test(path)) continue;
    const xml = decodeText(bytes);
    for (const match of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object\s*>/gi)) {
      const attrs = attributes(match[1]);
      const id = attrs.get('id');
      const name = attrs.get('name');
      if (!id || !name) continue;
      const triangleColors = trianglePaint(match[2], validPalette.length);
      objects.set(name, {
        objectColor: assignments.get(id) ?? null,
        triangleColors,
      });
    }
  }

  return objects.size ? { palette: validPalette, objects } : null;
}

function paintObject(
  mesh: THREE.Mesh,
  paletteIndex: number,
  paletteColor: string,
  replacedMaterials: Set<THREE.Material>,
): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const painted = materials.map((material) => {
    const colored = material.clone() as THREE.Material & { color?: THREE.Color };
    colored.color?.set(paletteColor);
    colored.userData.caliperBambuFilamentIndex = paletteIndex;
    replacedMaterials.add(material);
    return colored;
  });
  mesh.material = Array.isArray(mesh.material) ? painted : painted[0];
}

function paintTriangles(
  mesh: THREE.Mesh,
  colors: Array<number | null>,
  palette: string[],
  inheritedColor: number | null,
  replacedGeometries: Set<THREE.BufferGeometry>,
  replacedMaterials: Set<THREE.Material>,
): boolean {
  if (mesh.geometry.getAttribute('color')) return false;
  const indexCount = mesh.geometry.getIndex()?.count ?? mesh.geometry.getAttribute('position')?.count ?? 0;
  const triangleCount = Math.floor(indexCount / 3);
  if (triangleCount !== colors.length) return false;

  if (!colors.some((color) => color !== null)) return false;

  const originalGeometry = mesh.geometry;
  const geometry = originalGeometry.index ? originalGeometry.toNonIndexed() : originalGeometry.clone();
  const vertexCount = geometry.getAttribute('position').count;
  const vertexColors = new Float32Array(vertexCount * 3);
  const filamentIndices = new Int16Array(vertexCount);
  filamentIndices.fill(-1);
  const originalMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const fallbackMaterial = originalMaterials[0] as THREE.Material & { color?: THREE.Color };
  const fallback = inheritedColor !== null
    ? new THREE.Color(palette[inheritedColor])
    : fallbackMaterial.color?.clone() ?? new THREE.Color(0xffffff);

  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const paletteIndex = colors[triangle] ?? inheritedColor;
    filamentIndices.fill(paletteIndex ?? -1, triangle * 3, triangle * 3 + 3);
    const color = paletteIndex !== null && palette[paletteIndex]
      ? new THREE.Color(palette[paletteIndex])
      : fallback;
    color.toArray(vertexColors, triangle * 9);
    color.toArray(vertexColors, triangle * 9 + 3);
    color.toArray(vertexColors, triangle * 9 + 6);
  }

  geometry.setAttribute('color', new THREE.Float32BufferAttribute(vertexColors, 3));
  geometry.userData.caliperBambuFilamentIndices = filamentIndices;
  const materials = originalMaterials.map((material) => {
    const clone = material.clone() as THREE.Material & {
      color?: THREE.Color;
      vertexColors?: boolean;
    };
    clone.color?.set(0xffffff);
    if ('vertexColors' in clone) clone.vertexColors = true;
    replacedMaterials.add(material);
    return clone;
  });
  mesh.geometry = geometry;
  mesh.material = Array.isArray(mesh.material) ? materials : materials[0];
  replacedGeometries.add(originalGeometry);
  return true;
}

/** Apply Bambu's saved filament palette and whole-face paint to ThreeMFLoader output. */
export function applyBambu3mfColors(root: THREE.Object3D, data: ArrayBuffer): boolean {
  const colors = parseBambuColorData(data);
  if (!colors) {
    root.userData.caliperBambuFilamentColors = [];
    return false;
  }

  let applied = false;
  const usedColors = new Set<number>();
  const replacedGeometries = new Set<THREE.BufferGeometry>();
  const replacedMaterials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const model = colors.objects.get(object.name);
    if (!model) return;

    const inheritedColor = model.objectColor;
    if (model.triangleColors && paintTriangles(
      object,
      model.triangleColors,
      colors.palette,
      inheritedColor,
      replacedGeometries,
      replacedMaterials,
    )) {
      applied = true;
      for (const color of model.triangleColors) {
        const index = color ?? inheritedColor;
        if (index !== null) usedColors.add(index);
      }
    } else if (
      inheritedColor !== null &&
      colors.palette[inheritedColor] &&
      !object.geometry.getAttribute('color')
    ) {
      paintObject(object, inheritedColor, colors.palette[inheritedColor], replacedMaterials);
      usedColors.add(inheritedColor);
      applied = true;
    }
  });

  const liveGeometries = new Set<THREE.BufferGeometry>();
  const liveMaterials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    liveGeometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      liveMaterials.add(material);
    }
  });
  for (const geometry of replacedGeometries) {
    if (!liveGeometries.has(geometry)) geometry.dispose();
  }
  for (const material of replacedMaterials) {
    if (!liveMaterials.has(material)) material.dispose();
  }

  root.userData.caliperBambuFilamentColors = [...usedColors]
    .sort((a, b) => a - b)
    .map((index) => ({ index, color: colors.palette[index] }));
  return applied;
}

export function getBambu3mfFilamentColors(root: THREE.Object3D): FilamentColor[] {
  const colors = root.userData.caliperBambuFilamentColors as FilamentColor[] | undefined;
  return Array.isArray(colors) ? colors : [];
}

/** Update every mesh paint assignment that uses one saved AMS palette slot. */
export function setBambuFilamentColor(
  root: THREE.Object3D,
  paletteIndex: number,
  hex: string,
): boolean {
  if (!Number.isSafeInteger(paletteIndex) || paletteIndex < 0 || !/^#[\da-f]{6}$/i.test(hex)) return false;

  const color = new THREE.Color(hex);
  let changed = false;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;

    const indices = object.geometry.userData.caliperBambuFilamentIndices as Int16Array | undefined;
    const attribute = object.geometry.getAttribute('color');
    if (indices && attribute && indices.length === attribute.count) {
      let geometryChanged = false;
      for (let vertex = 0; vertex < indices.length; vertex++) {
        if (indices[vertex] === paletteIndex) {
          attribute.setXYZ(vertex, color.r, color.g, color.b);
          changed = true;
          geometryChanged = true;
        }
      }
      if (geometryChanged) attribute.needsUpdate = true;
    }

    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material.userData.caliperBambuFilamentIndex !== paletteIndex) continue;
      const colored = material as THREE.Material & { color?: THREE.Color };
      if (colored.color) {
        colored.color.set(hex);
        changed = true;
      }
    }
  });
  return changed;
}

/** Reassigns all faces in one selected object to a single imported AMS slot. */
export function setBambuObjectFilamentColor(
  root: THREE.Object3D,
  objectId: number,
  paletteIndex: number,
  hex: string,
): boolean {
  if (!Number.isSafeInteger(paletteIndex) || paletteIndex < 0 || !/^#[\da-f]{6}$/i.test(hex)) return false;
  const target = root.getObjectById(objectId);
  if (!(target instanceof THREE.Mesh)) return false;

  const color = new THREE.Color(hex);
  const sourceGeometry = target.geometry;
  const sourceIndices = sourceGeometry.userData.caliperBambuFilamentIndices as Int16Array | undefined;
  const sourceAttribute = sourceGeometry.getAttribute('color');
  if (sourceIndices && sourceAttribute && sourceIndices.length === sourceAttribute.count) {
    let shared = false;
    root.traverse((node) => {
      if (node !== target && (node as THREE.Mesh).isMesh && (node as THREE.Mesh).geometry === sourceGeometry) {
        shared = true;
      }
    });
    if (shared) {
      const geometry = sourceGeometry.clone();
      const indices = sourceIndices.slice();
      geometry.userData = {
        ...geometry.userData,
        caliperBambuFilamentIndices: indices,
      };
      target.geometry = geometry;
    }

    const indices = target.geometry.userData.caliperBambuFilamentIndices as Int16Array;
    const attribute = target.geometry.getAttribute('color');
    indices.fill(paletteIndex);
    for (let vertex = 0; vertex < indices.length; vertex++) {
      attribute.setXYZ(vertex, color.r, color.g, color.b);
    }
    attribute.needsUpdate = true;
    return true;
  }

  const sourceMaterials = Array.isArray(target.material) ? target.material : [target.material];
  const sharedMaterials = new Set<THREE.Material>();
  root.traverse((node) => {
    if (node === target || !(node as THREE.Mesh).isMesh) return;
    const mesh = node as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (sourceMaterials.includes(material)) sharedMaterials.add(material);
    }
  });

  const clones = new Map<THREE.Material, THREE.Material>();
  const materials = sourceMaterials.map((material) => {
    if (!sharedMaterials.has(material)) return material;
    const existing = clones.get(material);
    if (existing) return existing;
    const clone = material.clone();
    clones.set(material, clone);
    return clone;
  });
  target.material = Array.isArray(target.material) ? materials : materials[0] ?? target.material;
  let changed = false;
  for (const material of new Set(materials)) {
    const colored = material as THREE.Material & { color?: THREE.Color };
    if (!colored.color) continue;
    colored.color.set(hex);
    material.userData.caliperBambuFilamentIndex = paletteIndex;
    changed = true;
  }
  return changed;
}

/** Current one-slot assignment for an object-list row; null means mixed. */
export function bambuObjectFilamentIndex(object: THREE.Object3D): number | null | undefined {
  let found: number | null | undefined;
  let mixed = false;
  const readMesh = (node: THREE.Mesh) => {
    const indices = node.geometry.userData.caliperBambuFilamentIndices as Int16Array | undefined;
    if (indices?.length) {
      for (const index of indices) {
        if (index < 0) continue;
        if (found === undefined) found = index;
        else if (found !== index) mixed = true;
      }
    } else {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        const index = material.userData.caliperBambuFilamentIndex;
        if (typeof index !== 'number') continue;
        if (found === undefined) found = index;
        else if (found !== index) mixed = true;
      }
    }
  };
  if (object instanceof THREE.Mesh) readMesh(object);
  return mixed ? null : found;
}
