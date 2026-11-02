import { unzipSync, strFromU8 } from 'fflate';

/**
 * A 3MF reader written for the files slicers actually produce.
 *
 * three.js's 3MFLoader reads the core spec, but real files break it three ways:
 *
 * 1. Bambu Studio, OrcaSlicer and newer tools use the Production extension:
 *    each object lives in its own file (3D/Objects/object_1.model) and the main
 *    model refers to it with `<component p:path="…" objectid="1">`. Every one
 *    of those files numbers its objects from 1, so object ids are only unique
 *    *per file*. Merging them into one id table, as three.js does, makes
 *    components point at the wrong mesh or at nothing.
 * 2. The model's `unit` (micron, millimeter, centimeter, inch, foot, meter) was
 *    ignored, so a part drawn in inches came out 25.4 times too small.
 * 3. Slicer projects keep modifier meshes, negative volumes and support
 *    blockers next to the real parts, marked only in their own metadata. Drawn
 *    (and sliced) as solid plastic, they add material that should not exist.
 *
 * This reader resolves objects by (file, id), composes component and build
 * transforms, converts to millimetres, reads Bambu Studio's and PrusaSlicer's
 * part metadata to leave non-printing volumes out, and picks up colours: the
 * core spec's materials, and Bambu Studio's filament palette with each
 * object's, part's and painted face's filament slot.
 *
 * Pure code with no DOM and no three.js, so it is tested in Node. Coordinates
 * stay in 3MF's own frame (Z up); the loader turns them Y-up for the viewer.
 */

export interface ThreeMfPart {
  name: string;
  /** Nine numbers per triangle, millimetres, Z up, every transform applied. */
  positions: Float32Array;
  /** One colour for the whole part, `#rrggbb`, when the file gives one. */
  colour: string | null;
  /** Per-vertex colours (three per vertex) when triangles differ in colour. */
  colours: Float32Array | null;
  /**
   * Bambu filament slot of each triangle, 0-based into `palette`, −1 for none.
   * Null when the file has no palette or nothing in this part is assigned.
   */
  filament: Int16Array | null;
}

export interface ThreeMfResult {
  parts: ThreeMfPart[];
  /** Millimetres per unit of the file. */
  unitMm: number;
  /** Bambu Studio's filament colours, as saved in the project (`#RRGGBB`). */
  palette: string[] | null;
  /** Things a person should know about how the file was read. */
  notes: string[];
}

const UNITS: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

const UNIT_WORDS: Record<number, string> = { 0.001: 'microns', 10: 'centimetres', 25.4: 'inches', 304.8: 'feet', 1000: 'metres' };

/** A 3MF affine transform: p' = [x y z 1] · M, stored row by row (m00 m01 m02 m10 … m32). */
type Affine = number[];
const IDENTITY: Affine = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(text: string | undefined): Affine {
  if (!text) return IDENTITY;
  const values = text.trim().split(/\s+/).map(Number);
  if (values.length !== 12 || values.some((v) => !Number.isFinite(v))) throw new Error(`Invalid 3MF transform "${text}".`);
  return values;
}

/** Applies `a` then `b`: p · a · b. */
function compose(a: Affine, b: Affine): Affine {
  const r = new Array<number>(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = row === 3 ? b[9 + col] : 0;
      for (let k = 0; k < 3; k++) sum += a[row * 3 + k] * b[k * 3 + col];
      r[row * 3 + col] = sum;
    }
  }
  return r;
}

const determinant = (m: Affine) =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/* --- a small, fast XML scanner for the handful of elements 3MF needs ----- */

/** Attributes by local name (`p:path` → `path`). */
function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = m[1].includes(':') && !m[1].startsWith('xml') ? m[1].slice(m[1].indexOf(':') + 1) : m[1];
    out[name] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return out;
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** Every `<name …>` (self-closing or not) as its attribute text and, when it has one, its body. */
function* elements(xml: string, name: string): Generator<{ attrs: string; body: string }> {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*?)(/?)>`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    if (match[2] === '/') {
      yield { attrs: match[1], body: '' };
      continue;
    }
    const close = new RegExp(`</(?:[\\w.-]+:)?${name}\\s*>`, 'g');
    close.lastIndex = pattern.lastIndex;
    const end = close.exec(xml);
    const body = end ? xml.slice(pattern.lastIndex, end.index) : '';
    if (end) pattern.lastIndex = close.lastIndex;
    yield { attrs: match[1], body };
  }
}

/** `#RRGGBB` or `#RRGGBBAA` to `#rrggbb`, or null. */
function colourOf(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.trim().match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  return m ? `#${m[1].toLowerCase()}` : null;
}

/* --- the model files ------------------------------------------------------ */

interface MeshObject {
  kind: 'mesh';
  name: string;
  vertices: Float64Array;
  triangles: Uint32Array;
  /** Colour of each triangle, or null where none was given. */
  triangleColours: (string | null)[] | null;
  /** Bambu/Prusa painted filament state of each triangle (0 inherits), or null. */
  paint: (number | null)[] | null;
}

interface CompositeObject {
  kind: 'components';
  name: string;
  components: { path: string; id: string; transform: Affine }[];
}

type ObjectDef = MeshObject | CompositeObject;

interface ModelFile {
  unitMm: number;
  objects: Map<string, ObjectDef>;
  build: { id: string; transform: Affine }[];
}

const normalise = (path: string) => path.replace(/^\/+/, '').replace(/\\/g, '/');

function parseModel(xml: string, path: string): ModelFile {
  const modelTag = xml.match(/<(?:[\w.-]+:)?model\b([^>]*)>/);
  if (!modelTag) throw new Error(`${path} is not a 3MF model.`);
  const unit = attributes(modelTag[1]).unit ?? 'millimeter';
  const unitMm = UNITS[unit.toLowerCase()];
  if (!unitMm) throw new Error(`Unknown 3MF unit "${unit}".`);

  // Colour resources: basematerials and the materials extension's colorgroup.
  const palettes = new Map<string, (string | null)[]>();
  for (const { attrs, body } of elements(xml, 'basematerials')) {
    const id = attributes(attrs).id;
    if (id) palettes.set(id, [...elements(body, 'base')].map((b) => colourOf(attributes(b.attrs).displaycolor)));
  }
  for (const { attrs, body } of elements(xml, 'colorgroup')) {
    const id = attributes(attrs).id;
    if (id) palettes.set(id, [...elements(body, 'color')].map((c) => colourOf(attributes(c.attrs).color)));
  }

  const objects = new Map<string, ObjectDef>();
  for (const { attrs, body } of elements(xml, 'object')) {
    const a = attributes(attrs);
    if (!a.id) continue;
    const name = a.name ?? '';
    const meshTag = body.match(/<(?:[\w.-]+:)?mesh\b/);
    if (meshTag) {
      const coords: number[] = [];
      for (const m of body.matchAll(/<(?:[\w.-]+:)?vertex\b([^>]*)>/g)) {
        const v = attributes(m[1]);
        coords.push(Number(v.x), Number(v.y), Number(v.z));
      }
      const indices: number[] = [];
      const triColours: (string | null)[] = [];
      const paint: (number | null)[] = [];
      let anyColour = false;
      let anyPaint = false;
      const objectPalette = a.pid ? palettes.get(a.pid) : undefined;
      const objectColour = objectPalette ? (objectPalette[Number(a.pindex ?? 0)] ?? null) : null;
      for (const m of body.matchAll(/<(?:[\w.-]+:)?triangle\b([^>]*)>/g)) {
        const t = attributes(m[1]);
        indices.push(Number(t.v1), Number(t.v2), Number(t.v3));
        const palette = t.pid ? palettes.get(t.pid) : objectPalette;
        const colour = palette ? (palette[Number(t.p1 ?? a.pindex ?? 0)] ?? objectColour) : objectColour;
        if (colour) anyColour = true;
        triColours.push(colour);
        // Bambu Studio writes `paint_color`, PrusaSlicer `slic3rpe:mmu_segmentation`.
        const state = decodeBambuPaintState(t.paint_color ?? t.mmu_segmentation);
        if (state !== null && state > 0) anyPaint = true;
        paint.push(state);
      }
      const vertexCount = coords.length / 3;
      if (coords.some((c) => !Number.isFinite(c))) throw new Error(`Object ${a.id} in ${path} has a vertex that is not a number.`);
      if (indices.some((i) => !(i >= 0 && i < vertexCount)))
        throw new Error(`Object ${a.id} in ${path} has a triangle pointing at a vertex that does not exist.`);
      objects.set(a.id, {
        kind: 'mesh',
        name,
        vertices: Float64Array.from(coords),
        triangles: Uint32Array.from(indices),
        triangleColours: anyColour ? triColours : null,
        paint: anyPaint ? paint : null,
      });
    } else {
      const components = [...elements(body, 'component')].map(({ attrs: c }) => {
        const ca = attributes(c);
        return { path: ca.path ? normalise(ca.path) : path, id: ca.objectid, transform: parseTransform(ca.transform) };
      });
      objects.set(a.id, { kind: 'components', name, components });
    }
  }

  const build: ModelFile['build'] = [];
  const buildBlock = [...elements(xml, 'build')][0];
  if (buildBlock) {
    for (const { attrs } of elements(buildBlock.body, 'item')) {
      const a = attributes(attrs);
      if (a.objectid) build.push({ id: a.objectid, transform: parseTransform(a.transform) });
    }
  }
  return { unitMm, objects, build };
}

/* --- slicer project metadata ---------------------------------------------- */

/** Part kinds that are not printed plastic. */
const NOT_PRINTED = new Set([
  'modifier_part',
  'negative_part',
  'support_enforcer',
  'support_blocker',
  'ModifierVolume',
  'NegativeVolume',
  'SupportEnforcer',
  'SupportBlocker',
]);

const KIND_LABEL: Record<string, string> = {
  modifier_part: 'modifier',
  ModifierVolume: 'modifier',
  negative_part: 'negative volume',
  NegativeVolume: 'negative volume',
  support_enforcer: 'support enforcer',
  SupportEnforcer: 'support enforcer',
  support_blocker: 'support blocker',
  SupportBlocker: 'support blocker',
};

interface BambuObjectMeta {
  name: string | null;
  /** 1-based filament the object prints in, if set. */
  extruder: number | null;
  /** Kind of each part, by component object id. */
  parts: Map<string, string>;
  /** 1-based filament of each part that overrides the object's. */
  partExtruders: Map<string, number>;
}

interface ProjectMeta {
  /** Bambu Studio: main object id → its name, filament and parts. */
  bambu: Map<string, BambuObjectMeta>;
  /** PrusaSlicer: mesh object id → its name and triangle ranges that are not printed. */
  prusa: Map<string, { name: string | null; skip: { first: number; last: number; kind: string }[] }>;
  /** Bambu Studio's filament colours. */
  palette: string[] | null;
}

function metadataValue(body: string, key: string): string | null {
  for (const { attrs } of elements(body, 'metadata')) {
    const a = attributes(attrs);
    if (a.key === key) return a.value ?? null;
  }
  return null;
}

function parseProjectMeta(files: Record<string, Uint8Array>): ProjectMeta {
  const meta: ProjectMeta = { bambu: new Map(), prusa: new Map(), palette: null };
  const find = (name: string) => Object.keys(files).find((k) => k.toLowerCase() === name.toLowerCase());

  const bambu = find('Metadata/model_settings.config');
  if (bambu) {
    const xml = strFromU8(files[bambu]);
    for (const { attrs, body } of elements(xml, 'object')) {
      const id = attributes(attrs).id;
      if (!id) continue;
      const parts = new Map<string, string>();
      const partExtruders = new Map<string, number>();
      for (const part of elements(body, 'part')) {
        const pa = attributes(part.attrs);
        if (!pa.id) continue;
        if (pa.subtype) parts.set(pa.id, pa.subtype);
        const extruder = Number(metadataValue(part.body, 'extruder'));
        if (Number.isInteger(extruder) && extruder > 0) partExtruders.set(pa.id, extruder);
      }
      // The object's own settings sit outside its parts.
      const own = body.replace(/<part\b[\s\S]*?<\/part>/g, '');
      const extruder = Number(metadataValue(own, 'extruder'));
      meta.bambu.set(id, {
        name: metadataValue(own, 'name'),
        extruder: Number.isInteger(extruder) && extruder > 0 ? extruder : null,
        parts,
        partExtruders,
      });
    }
  }

  const prusa = find('Metadata/Slic3r_PE_model.config');
  if (prusa) {
    const xml = strFromU8(files[prusa]);
    for (const { attrs, body } of elements(xml, 'object')) {
      const id = attributes(attrs).id;
      if (!id) continue;
      const skip: { first: number; last: number; kind: string }[] = [];
      for (const volume of elements(body, 'volume')) {
        const va = attributes(volume.attrs);
        const type = metadataValue(volume.body, 'volume_type') ?? (metadataValue(volume.body, 'modifier') === '1' ? 'ModifierVolume' : null);
        if (type && NOT_PRINTED.has(type)) skip.push({ first: Number(va.firstid), last: Number(va.lastid), kind: type });
      }
      const own = body.replace(/<volume\b[\s\S]*?<\/volume>/g, '');
      meta.prusa.set(id, { name: metadataValue(own, 'name'), skip });
    }
  }

  const settings = find('Metadata/project_settings.config');
  if (settings) {
    try {
      const colours = (JSON.parse(strFromU8(files[settings]).replace(/^\uFEFF/, '')) as { filament_colour?: unknown }).filament_colour;
      if (Array.isArray(colours) && colours.length) {
        const palette = colours.map((value) => (typeof value === 'string' ? value.trim().match(/^#?([\da-f]{6})(?:[\da-f]{2})?$/i) : null));
        if (palette.every(Boolean)) meta.palette = palette.map((m) => `#${m![1]}`);
      }
    } catch {
      // A malformed settings file only costs the palette.
    }
  }
  return meta;
}

/**
 * Bambu Studio's whole-face paint state: 0 inherits the part's filament,
 * 1, 2, … are filament slots. Codes that subdivide a face are not decoded and
 * return null, so the face inherits too.
 */
export function decodeBambuPaintState(value: string | undefined): number | null {
  if (!value || !/^[\da-f]+$/i.test(value)) return null;
  const encoded = Number.parseInt(value, 16);
  if (encoded === 0) return 0;
  if (encoded === 4) return 1;
  if (encoded === 8) return 2;
  if (encoded >= 12 && encoded <= 220 && (encoded - 12) % 16 === 0) return 3 + (encoded - 12) / 16;
  return null;
}

/* --- reading a package ---------------------------------------------------- */

const MAX_DEPTH = 16;

export function parse3mf(bytes: Uint8Array): ThreeMfResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('This 3MF is not a readable zip archive. It may be damaged or only partly downloaded.');
  }
  const byPath = new Map(Object.keys(files).map((k) => [normalise(k).toLowerCase(), k]));
  const read = (path: string) => {
    const key = byPath.get(normalise(path).toLowerCase());
    return key ? files[key] : undefined;
  };

  // The package's relationships name the root model; fall back to the usual name.
  let rootPath = '3D/3dmodel.model';
  const rels = read('_rels/.rels');
  if (rels) {
    for (const { attrs } of elements(strFromU8(rels), 'Relationship')) {
      const a = attributes(attrs);
      if (a.Type?.endsWith('/3dmodel') && a.Target) rootPath = normalise(a.Target);
    }
  }
  if (!read(rootPath)) throw new Error('This 3MF has no 3D model inside (3D/3dmodel.model is missing).');

  const models = new Map<string, ModelFile>();
  const model = (path: string): ModelFile => {
    const key = normalise(path).toLowerCase();
    let found = models.get(key);
    if (!found) {
      const data = read(path);
      if (!data) throw new Error(`The 3MF refers to ${path}, which is not in the archive.`);
      found = parseModel(strFromU8(data), normalise(path));
      models.set(key, found);
    }
    return found;
  };

  const root = model(rootPath);
  const meta = parseProjectMeta(files);
  const notes: string[] = [];
  const skippedKinds = new Map<string, number>();
  const parts: ThreeMfPart[] = [];

  /** Walks an object down to its meshes, collecting each with its full transform. */
  const visit = (
    path: string,
    id: string,
    transform: Affine,
    depth: number,
    label: string,
    rootId: string | null,
    componentId: string | null,
  ) => {
    if (depth > MAX_DEPTH) throw new Error('The 3MF nests components too deeply (a loop?).');
    const file = model(path);
    const object = file.objects.get(id);
    if (!object) throw new Error(`The 3MF refers to object ${id} in ${path}, which does not exist.`);
    // Each file has its own unit; a component file may differ from the root.
    const toMm = file.unitMm / root.unitMm;
    const scaled: Affine = toMm === 1 ? transform : compose([toMm, 0, 0, 0, toMm, 0, 0, 0, toMm, 0, 0, 0], transform);

    if (object.kind === 'components') {
      for (const c of object.components) {
        visit(c.path, c.id, compose(c.transform, transform), depth + 1, label || object.name, rootId, c.id);
      }
      return;
    }

    // Bambu: a part of a root object, identified by its component's object id.
    const bambuKind = rootId && componentId ? meta.bambu.get(rootId)?.parts.get(componentId) : undefined;
    if (bambuKind && NOT_PRINTED.has(bambuKind)) {
      skippedKinds.set(bambuKind, (skippedKinds.get(bambuKind) ?? 0) + 1);
      return;
    }
    // PrusaSlicer: triangle ranges inside a single mesh object.
    const prusaSkip = path === normalise(rootPath) ? (meta.prusa.get(id)?.skip ?? []) : [];
    for (const s of prusaSkip) skippedKinds.set(s.kind, (skippedKinds.get(s.kind) ?? 0) + 1);
    const skipped = (t: number) => prusaSkip.some((s) => t >= s.first && t <= s.last);

    const m = scaled;
    const flip = determinant(m) < 0; // a mirror turns triangles inside out
    const v = object.vertices;
    const tri = object.triangles;
    const count = tri.length / 3;
    const out = new Float32Array(count * 9);
    const colourList = object.triangleColours;
    const uniform = colourList && colourList.every((c) => c === colourList[0]) ? colourList[0] : null;
    const perVertex = colourList && !uniform ? new Float32Array(count * 9) : null;

    // Bambu filament slots: a painted face's own slot, else the part's, else the object's.
    const palette = meta.palette;
    const slotOf = (extruder: number | null | undefined) =>
      palette && extruder && extruder <= palette.length ? extruder - 1 : null;
    const owner = rootId ? meta.bambu.get(rootId) : undefined;
    const partKey = componentId ?? id;
    // A mesh placed straight in the build is its own part; find the object that lists it.
    const lister = owner?.partExtruders.has(partKey)
      ? owner
      : [...meta.bambu.values()].find((o) => o.partExtruders.has(partKey));
    const inherited = slotOf(lister?.partExtruders.get(partKey)) ?? slotOf(owner?.extruder ?? lister?.extruder);
    const slots = palette ? new Int16Array(count).fill(-1) : null;
    let anySlot = false;
    let written = 0;
    for (let t = 0; t < count; t++) {
      if (skipped(t)) continue;
      if (slots) {
        const state = object.paint?.[t];
        const slot = state && palette && state <= palette.length ? state - 1 : inherited;
        if (slot !== null) {
          slots[written] = slot;
          anySlot = true;
        }
      }
      for (let corner = 0; corner < 3; corner++) {
        const vi = tri[t * 3 + (flip ? 2 - corner : corner)] * 3;
        const x = v[vi];
        const y = v[vi + 1];
        const z = v[vi + 2];
        const o = written * 9 + corner * 3;
        out[o] = x * m[0] + y * m[3] + z * m[6] + m[9];
        out[o + 1] = x * m[1] + y * m[4] + z * m[7] + m[10];
        out[o + 2] = x * m[2] + y * m[5] + z * m[8] + m[11];
        if (perVertex) {
          const hex = colourList![t] ?? '#cccccc';
          perVertex[o] = parseInt(hex.slice(1, 3), 16) / 255;
          perVertex[o + 1] = parseInt(hex.slice(3, 5), 16) / 255;
          perVertex[o + 2] = parseInt(hex.slice(5, 7), 16) / 255;
        }
      }
      written++;
    }
    if (!written) return;
    const rootName =
      (rootId ? (meta.bambu.get(rootId)?.name ?? meta.prusa.get(rootId)?.name) : null) ?? (label || object.name);
    parts.push({
      name: rootName || object.name || `Object ${id}`,
      positions: written === count ? out : out.slice(0, written * 9),
      colour: uniform,
      colours: perVertex ? (written === count ? perVertex : perVertex.slice(0, written * 9)) : null,
      filament: slots && anySlot ? slots.slice(0, written) : null,
    });
  };

  const unitScale: Affine = [root.unitMm, 0, 0, 0, root.unitMm, 0, 0, 0, root.unitMm, 0, 0, 0];
  if (root.build.length) {
    for (const item of root.build) visit(rootPath, item.id, compose(item.transform, unitScale), 0, '', item.id, null);
  } else {
    notes.push('The 3MF lists no build items, so every object in it is shown.');
    for (const id of root.objects.keys()) visit(rootPath, id, unitScale, 0, '', id, null);
  }

  for (const [kind, n] of skippedKinds) {
    const label = KIND_LABEL[kind] ?? kind;
    notes.push(
      `${n} ${label}${n === 1 ? '' : 's'} left out: in the slicer project ${n === 1 ? 'it changes' : 'they change'} settings or cut away material, ${label === 'negative volume' ? 'and the cut is not applied here' : 'and is not printed plastic'}.`,
    );
  }
  if (root.unitMm !== 1) notes.push(`The file is in ${UNIT_WORDS[root.unitMm] ?? 'another unit'}; sizes are converted to millimetres.`);

  return { parts, unitMm: root.unitMm, palette: meta.palette, notes };
}
