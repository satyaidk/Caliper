import { create } from 'zustand';
import type { Engine, FrameInfo, PlateInfo, SelectionInfo } from '@/viewer/Engine';
import { computeStats } from '@/viewer/analyze';
import { buildContext, loadModel } from '@/viewer/loaders';
import { OVERHANG_DEFAULT } from '@/viewer/printability';
import { defaultUnitFor, extOf, specFor } from '@/lib/formats';
import { MM_PER, bedById } from '@/lib/printers';
import { FILAMENTS, nextColour } from '@/lib/colours';
import { extractArchive, isArchive } from '@/lib/archive';
import { MAX_MODELS, capacity, companionsFor, fileKey, needsChooser, sortIntake } from '@/lib/intake';
import {
  clearRecent as wipeRecent,
  listRecent,
  loadPlate,
  loadRecent,
  recordFrom,
  removeRecent,
  saveRecent,
  savePlate,
  updateRecent,
  type PlateItem,
  type RecentSummary,
} from '@/lib/recent';
import type {
  Axis,
  ClipState,
  Measurement,
  MeasureTool,
  ModelInfo,
  PartInfo,
  Printability,
  Projection,
  RenderMode,
  SourceUnit,
  Toast,
  UnitSystem,
  ViewPreset,
  Workspace,
} from '@/types';

/**
 * The single source of truth for anything the interface shows.
 *
 * The Engine owns the scene; this owns the decisions. Every button calls an
 * action here, the action tells the Engine what to do, and the Engine reports
 * back through the hooks wired up in Viewport.tsx. Components never touch the
 * Engine directly, so there is exactly one path from a click to a pixel.
 *
 * The plate holds up to MAX_MODELS models. `models` lists them; `model` is the
 * active one — the one the sidebar describes — kept as its own field so every
 * panel written for a single file keeps reading the file it is about.
 */

export type Status = 'idle' | 'loading' | 'ready';
export type Theme = 'dark' | 'light';

/** `replace` clears the plate first; `add` puts the new models beside what is there. */
export type IntakeMode = 'replace' | 'add';

const PREFS_KEY = 'caliper.prefs.v2';
const THEME_KEY = 'caliper.theme';

export interface Display {
  renderMode: RenderMode;
  grid: boolean;
  shadows: boolean;
  projection: Projection;
  labels: boolean;
  overhang: boolean;
}

const DEFAULT_DISPLAY: Display = {
  renderMode: 'shaded',
  grid: true,
  shadows: true,
  projection: 'perspective',
  labels: false,
  overhang: false,
};

export { FILAMENTS };

/** Layer heights Bambu Studio's process presets ship with, in millimetres. */
export const LAYER_HEIGHTS = [0.08, 0.12, 0.16, 0.2, 0.24, 0.28];

/** One model on the plate, as the interface knows it. */
export interface ModelEntry extends ModelInfo {
  id: number;
  colour: string;
  paintAuthored: boolean;
  sourceUnit: SourceUnit;
  visible: boolean;
  /** Footprint centre on the plate, millimetres. */
  position: [number, number];
  /** This model's key in the recent cache, once it has been kept there. */
  recentId: string | null;
}

/** A collection waiting for the person to choose what to open from it. */
export interface PendingPick {
  /** What the files came from, for the dialog's title. */
  source: string;
  models: File[];
  companions: File[];
  mode: IntakeMode;
}

/** What a model was last shown with, when it is reopened from the cache. */
interface RestoreHint {
  colour?: string;
  unit?: SourceUnit;
  position?: [number, number];
  recentId?: string;
}

interface LoadItem {
  file: File;
  companions: File[];
  hint?: RestoreHint;
}

/* --- preferences -----------------------------------------------------------
   Storage is unavailable in some privacy modes, and a remembered toggle is not
   worth a crash. Only the settings that describe *how you like to look at
   models* persist — anything tied to the file in front of you starts clean. */

interface Prefs {
  display: Display;
  unit: UnitSystem;
  sidebarOpen: boolean;
  bedId: string;
  filament: string;
  paintAuthored: boolean;
  overhangDeg: number;
  layerHeight: number;
  keepRecent: boolean;
}

function readPrefs(): Partial<Prefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
  } catch {
    return {};
  }
}

function writePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

function rememberTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

/**
 * A remembered choice wins; otherwise follow the OS. The HTML entry stamps the
 * same value on <html> before first paint, so this only has to agree with it.
 */
function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    /* fall through to the OS preference */
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const saved = readPrefs();

export interface SectionState extends ClipState {
  on: boolean;
}

/** What every visible model covers together, in millimetres. */
export interface Extent3 {
  x: number;
  y: number;
  z: number;
}

const NO_EXTENT: Extent3 = { x: 0, y: 0, z: 0 };

interface ViewerState {
  engine: Engine | null;
  status: Status;
  progress: number | null;
  progressNote: string;
  contextLost: boolean;

  workspace: Workspace;
  /** Every model on the plate, in the order they arrived. */
  models: ModelEntry[];
  activeId: number | null;
  /** The active model. */
  model: ModelEntry | null;
  scene: Extent3;
  parts: PartInfo[];
  report: Printability | null;
  reportPending: boolean;
  selection: SelectionInfo | null;
  hover: string | null;
  frame: FrameInfo;

  display: Display;
  unit: UnitSystem;
  /** The active model's unit. */
  sourceUnit: SourceUnit;
  theme: Theme;
  bedId: string;
  plate: PlateInfo;
  /** The colour last chosen, which the next fresh plate starts in. */
  filament: string;
  paintAuthored: boolean;
  overhangDeg: number;

  section: SectionState;
  layerAt: number;
  layerHeight: number;
  explode: number;
  /** Bambu Studio's assembly view: the explode slider is out. */
  assembly: boolean;
  oriented: boolean;

  measureTool: MeasureTool;
  measurements: Measurement[];
  pendingPoints: number;

  pick: PendingPick | null;
  recent: RecentSummary[];
  lastPlate: PlateItem[];
  keepRecent: boolean;

  sidebarOpen: boolean;
  sheetOpen: boolean;
  shortcutsOpen: boolean;
  toasts: Toast[];

  attach(engine: Engine): void;
  detach(): void;
  open(files: File[], mode?: IntakeMode): Promise<void>;
  openPicked(files: File[]): Promise<void>;
  cancelPick(): void;
  openFromUrl(url: string, filename: string): Promise<void>;
  openSample(): Promise<void>;
  close(): void;

  setActiveModel(id: number): void;
  removeModel(id: number): void;
  setModelVisible(id: number, visible: boolean): void;
  setModelColour(id: number, hex: string, paintAuthored?: boolean): void;
  setModelPosition(id: number, position: [number, number]): void;
  nudgeModel(dxMm: number, dzMm: number): void;
  cycleModel(step: 1 | -1): void;
  arrange(): void;
  frameModel(id: number): void;

  refreshRecent(): Promise<void>;
  openRecent(id: string, mode?: IntakeMode): Promise<void>;
  forgetRecent(id: string): Promise<void>;
  clearRecent(): Promise<void>;
  restorePlate(): Promise<void>;
  setKeepRecent(keep: boolean): void;

  setWorkspace(workspace: Workspace): void;
  setDisplay<K extends keyof Display>(key: K, value: Display[K]): void;
  setUnit(unit: UnitSystem): void;
  setSourceUnit(unit: SourceUnit): void;
  setTheme(theme: Theme): void;
  setBed(id: string): void;
  setFilament(hex: string, paintAuthored?: boolean): void;
  setOverhangDeg(degrees: number): void;

  setSection(patch: Partial<SectionState>): void;
  setLayerAt(at: number): void;
  setLayerHeight(height: number): void;
  setExplode(ratio: number): void;
  setAssembly(on: boolean): void;
  autoOrient(): void;
  resetOrientation(): void;

  setPartVisible(id: number, visible: boolean): void;
  isolatePart(id: number | null): void;
  selectPart(id: number): void;

  toggleSidebar(force?: boolean): void;
  toggleSheet(force?: boolean): void;
  setShortcutsOpen(open: boolean): void;

  setView(preset: ViewPreset): void;
  frameAll(): void;
  frameSelection(): void;
  clearSelection(): void;

  setMeasureTool(tool: MeasureTool): void;
  removeMeasurement(id: number): void;
  clearMeasurements(): void;
  undoMeasure(): void;

  setFrame(info: FrameInfo): void;
  setSelection(info: SelectionInfo | null): void;
  setHover(name: string | null): void;
  setMeasurements(list: Measurement[], pending: number): void;
  setContextLost(lost: boolean): void;
  setParts(parts: PartInfo[]): void;
  onTransform(): void;
  onActiveModel(id: number | null): void;

  toast(t: Omit<Toast, 'id'>): void;
  dismiss(id: number): void;
}

let toastSeq = 0;
let analysisTimer = 0;
let overhangTimer = 0;
let plateTimer = 0;
const thumbTimers = new Map<number, number>();
/** One intake at a time: two loads interleaving would mount into each other's plate. */
let busy = false;

export const useViewer = create<ViewerState>((set, get) => {
  const persist = () => {
    const { display, unit, sidebarOpen, bedId, filament, paintAuthored, overhangDeg, layerHeight, keepRecent } = get();
    writePrefs({ display, unit, sidebarOpen, bedId, filament, paintAuthored, overhangDeg, layerHeight, keepRecent });
  };

  /** The plate under the models, and what they cover together. */
  const syncPlate = () => {
    const { engine, bedId } = get();
    if (!engine) return;
    set({ plate: engine.setPlate(bedById(bedId).size), scene: engine.plateExtent() });
  };

  /**
   * Preview is a height slice with overhangs shown; Prepare shows whatever
   * section and overhang setting the person chose. Both are derived here, so
   * switching tab never leaves the other tab's cut in place.
   */
  const syncView = () => {
    const { engine, workspace, section, layerAt, display, overhangDeg } = get();
    if (!engine) return;
    const preview = workspace === 'preview';
    const clip: ClipState | null = preview
      ? { axis: 'y', at: layerAt, flip: false }
      : section.on
        ? { axis: section.axis, at: section.at, flip: section.flip }
        : null;
    engine.setClip(clip);
    engine.setOverhang(preview || display.overhang, overhangDeg);
  };

  /** Printability is a full pass over the triangles, so it runs off the click. */
  const scheduleAnalysis = () => {
    window.clearTimeout(analysisTimer);
    set({ reportPending: true });
    analysisTimer = window.setTimeout(() => {
      const engine = get().engine;
      set({ report: engine?.analyse() ?? null, reportPending: false });
    }, 60);
  };

  const scheduleOverhang = () => {
    window.clearTimeout(overhangTimer);
    overhangTimer = window.setTimeout(() => {
      const { engine, report } = get();
      if (!engine || !report) return;
      set({ report: { ...report, overhangArea: engine.overhangArea() } });
    }, 120);
  };

  const patchModel = (id: number, patch: Partial<ModelEntry>) => {
    const models = get().models.map((m) => (m.id === id ? { ...m, ...patch } : m));
    set({ models, model: models.find((m) => m.id === get().activeId) ?? null });
  };

  /**
   * Brings everything that describes "the model" round to whichever model the
   * Engine now has active: its parts, its unit, its size, and a fresh
   * printability check. The assembly view belonged to the last one.
   */
  const syncActive = () => {
    const { engine } = get();
    if (!engine) return;
    const activeId = engine.activeModelId;
    const models = get().models.map((m) => (m.id === activeId ? { ...m, dimensions: engine.dimensions(m.id) } : m));
    const model = models.find((m) => m.id === activeId) ?? null;
    set({
      models,
      activeId,
      model,
      sourceUnit: model?.sourceUnit ?? 'mm',
      parts: engine.partList(),
      report: null,
      explode: 1,
      assembly: false,
      oriented: engine.oriented,
    });
    if (model) scheduleAnalysis();
  };

  /**
   * Remembers which cached models are on the plate and where, so the plate can
   * be put back after it is closed. Debounced: a drag reports every frame.
   */
  const persistPlate = () => {
    window.clearTimeout(plateTimer);
    plateTimer = window.setTimeout(() => {
      const { engine, models, keepRecent } = get();
      if (!engine || !keepRecent || !models.length) return;
      const items: PlateItem[] = models
        .filter((m) => m.recentId)
        .map((m) => ({ id: m.recentId!, colour: m.colour, unit: m.sourceUnit, position: engine.modelPosition(m.id) }));
      if (!items.length) return;
      set({ lastPlate: items });
      void savePlate(items);
    }, 400);
  };

  /** Keeps freshly opened models in the recent cache, with a thumbnail each. */
  const remember = async (kept: { item: LoadItem; id: number }[]) => {
    const { engine } = get();
    if (!engine || !get().keepRecent) return;
    // Thumbnails first, synchronously, while every model is still on the plate.
    const pictures = kept.map(({ id }) => engine.thumbnail(id));
    for (const [i, { item, id }] of kept.entries()) {
      const entry = get().models.find((m) => m.id === id);
      if (!entry) continue;
      if (item.hint?.recentId) {
        patchModel(id, { recentId: item.hint.recentId });
        if (pictures[i]) void updateRecent(item.hint.recentId, { thumb: pictures[i] });
        continue;
      }
      const recentId = fileKey(item.file);
      const record = recordFrom(recentId, item.file, companionsFor(item.file, item.companions), {
        ext: entry.ext,
        colour: entry.colour,
        unit: entry.sourceUnit,
        thumb: pictures[i],
      });
      if (await saveRecent(record)) patchModel(id, { recentId });
    }
    await get().refreshRecent();
    persistPlate();
  };

  /**
   * Parses every file, then mounts the ones that opened. Parsing comes first so
   * a batch that fails entirely leaves the plate exactly as it was.
   */
  const loadModels = async (items: LoadItem[], mode: IntakeMode) => {
    const engine = get().engine;
    if (!engine || !items.length) return;

    const existing = mode === 'add' ? get().models.length : 0;
    const { take, dropped } = capacity(existing, items.length);
    if (dropped) {
      get().toast({
        tone: 'info',
        title: `The plate holds ${MAX_MODELS} models`,
        text: `${dropped} ${dropped === 1 ? 'model was' : 'models were'} left out. Remove some to make room.`,
      });
    }
    const batch = items.slice(0, take);
    if (!batch.length) return;

    set({ status: 'loading', progress: null, progressNote: 'Reading file', selection: null });
    const started = performance.now();
    const many = batch.length > 1;
    const opened: {
      item: LoadItem;
      object: Awaited<ReturnType<typeof loadModel>>;
      stats: ModelInfo['stats'];
      parseMs: number;
    }[] = [];

    for (const [i, item] of batch.entries()) {
      const tag = many ? ` (${i + 1} of ${batch.length})` : '';
      set({ progress: null, progressNote: `Opening ${item.file.name}${tag}` });
      const ctx = buildContext([item.file, ...item.companions], (fraction, note) =>
        set((s) => ({ progress: fraction, progressNote: note ? `${note}${tag}` : s.progressNote })),
      );
      const t0 = performance.now();
      try {
        const result = await loadModel(item.file, ctx);
        const stats = computeStats(result.object);
        if (!stats.meshes && !stats.vertices) throw new Error('The file opened but contains no drawable geometry.');
        opened.push({ item, object: result, stats, parseMs: performance.now() - t0 });
      } catch (error) {
        get().toast({
          tone: 'error',
          title: `Could not open ${item.file.name}`,
          text: error instanceof Error ? error.message : 'The file could not be read.',
        });
      } finally {
        // Blob URLs stay alive briefly so async texture fetches can finish.
        setTimeout(ctx.revoke, 12_000);
      }
    }

    if (!opened.length) {
      set({ status: get().models.length ? 'ready' : 'idle', progress: null, progressNote: '' });
      return;
    }

    const fresh = mode === 'replace' || !get().models.length;
    if (mode === 'replace') engine.clearModel();
    const entries: ModelEntry[] = mode === 'replace' ? [] : [...get().models];
    const mounted: { item: LoadItem; id: number }[] = [];

    for (const { item, object, stats, parseMs } of opened) {
      const { file, hint } = item;
      const sourceUnit = hint?.unit ?? defaultUnitFor(file.name);
      const colour = hint?.colour ?? nextColour(entries.map((e) => e.colour), get().filament);
      const paintAuthored = get().paintAuthored;
      const id = engine.addModel(object.object, object.hasAuthoredMaterials, {
        name: file.name,
        mmPerUnit: MM_PER[sourceUnit],
        colour,
        paintAuthored,
        position: hint?.position,
      });
      mounted.push({ item, id });
      entries.push({
        id,
        name: file.name,
        ext: extOf(file.name),
        pipeline: specFor(file.name)!.pipeline,
        bytes: file.size,
        parseMs,
        stats,
        dimensions: engine.dimensions(id),
        authored: object.hasAuthoredMaterials,
        colour,
        paintAuthored,
        sourceUnit,
        visible: true,
        position: [0, 0],
        recentId: null,
      });
    }

    // A fresh plate of several models is packed; models added to a plate
    // somebody already arranged go beside what is there and move nothing.
    const restoring = mounted.some(({ item }) => item.hint?.position);
    if (fresh && mounted.length > 1 && !restoring) engine.arrange();
    engine.setActiveModel(mounted[0].id);
    engine.setMeasureTool('off');
    engine.frameAll(fresh);

    set({
      models: entries.map((e) => ({ ...e, position: engine.modelPosition(e.id) })),
      status: 'ready',
      workspace: get().workspace === 'preview' ? 'preview' : 'prepare',
      progress: null,
      progressNote: '',
      selection: null,
      hover: null,
      measureTool: 'off',
      measurements: [],
      pendingPoints: 0,
      section: { ...get().section, on: false },
      layerAt: 1,
    });
    syncActive();
    syncPlate();
    syncView();

    const elapsed = Math.round(performance.now() - started);
    const triangles = opened.reduce((sum, o) => sum + o.stats.triangles, 0);
    const first = entries.find((e) => e.id === mounted[0].id)!;
    get().toast({
      tone: 'success',
      title: mounted.length > 1 ? `Opened ${mounted.length} models` : fresh ? `Opened ${first.name}` : `Added ${first.name}`,
      text: `${triangles.toLocaleString()} triangles in ${elapsed} ms${
        fresh ? '' : ` · ${entries.length} models on the plate`
      }`,
    });

    // Bambu Studio asks the same question when a part imports tiny: a file
    // drawn in metres reads as a speck when its numbers are taken as mm.
    const d = first.dimensions;
    const longest = Math.max(d.x, d.y, d.z);
    if (mounted.length === 1 && first.sourceUnit === 'mm' && longest > 0 && longest < 1) {
      get().toast({
        tone: 'info',
        title: 'This part is under 1 mm across',
        text: 'Files drawn in metres read this small when their numbers are taken as millimetres.',
        action: { label: 'Read it as metres', run: () => get().setSourceUnit('m') },
      });
    }

    void remember(mounted);
  };

  /** Runs one intake at a time; a second request while one is running is turned away politely. */
  const exclusive = async (run: () => Promise<void>) => {
    if (busy) {
      get().toast({ tone: 'info', title: 'Still opening the last file', text: 'Try again once it has opened.' });
      return;
    }
    busy = true;
    try {
      await run();
    } finally {
      busy = false;
    }
  };

  return {
    engine: null,
    status: 'idle',
    progress: null,
    progressNote: '',
    contextLost: false,

    workspace: 'home',
    models: [],
    activeId: null,
    model: null,
    scene: NO_EXTENT,
    parts: [],
    report: null,
    reportPending: false,
    selection: null,
    hover: null,
    frame: { fps: 0, quality: 1 },

    display: { ...DEFAULT_DISPLAY, ...(saved.display ?? {}) },
    unit: saved.unit ?? 'mm',
    sourceUnit: 'mm',
    theme: initialTheme(),
    bedId: saved.bedId ?? 'auto',
    plate: { cellMm: null, fits: null },
    filament: saved.filament ?? FILAMENTS[0].hex,
    paintAuthored: saved.paintAuthored ?? false,
    overhangDeg: saved.overhangDeg ?? OVERHANG_DEFAULT,

    section: { on: false, axis: 'z', at: 0.5, flip: false },
    layerAt: 1,
    layerHeight: saved.layerHeight ?? 0.2,
    explode: 1,
    assembly: false,
    oriented: false,

    measureTool: 'off',
    measurements: [],
    pendingPoints: 0,

    pick: null,
    recent: [],
    lastPlate: [],
    keepRecent: saved.keepRecent ?? true,

    sidebarOpen: saved.sidebarOpen ?? true,
    sheetOpen: false,
    shortcutsOpen: false,
    toasts: [],

    attach(engine) {
      set({ engine });
      const { display, theme, filament, paintAuthored } = get();
      engine.setGridVisible(display.grid);
      engine.setShadowsEnabled(display.shadows);
      engine.setRenderMode(display.renderMode);
      engine.setProjection(display.projection);
      engine.setPartLabels(display.labels);
      engine.setTheme(theme);
      engine.setFilament(filament, paintAuthored);
      syncPlate();
      syncView();
      if (get().keepRecent) {
        void get().refreshRecent();
        void loadPlate().then((lastPlate) => set({ lastPlate }));
      }
    },

    detach() {
      set({ engine: null });
    },

    async open(files, mode = 'replace') {
      if (!get().engine) return;
      await exclusive(async () => {
        const idle = () => set({ status: get().models.length ? 'ready' : 'idle', progress: null, progressNote: '' });
        const archives = files.filter((f) => isArchive(f.name));
        let pool = files.filter((f) => !isArchive(f.name));
        let nested = 0;

        for (const archive of archives) {
          set({ status: 'loading', progress: null, progressNote: `Unpacking ${archive.name}` });
          try {
            const { files: inner, skipped } = await extractArchive(archive);
            pool = pool.concat(inner);
            nested += skipped.filter((s) => s.reason === 'archive').length;
          } catch (error) {
            idle();
            get().toast({
              tone: 'error',
              title: `Could not open ${archive.name}`,
              text: error instanceof Error ? error.message : 'The archive could not be read.',
            });
            return;
          }
        }

        const { models, companions } = sortIntake(pool);
        if (!models.length) {
          idle();
          get().toast(
            archives.length
              ? {
                  tone: 'error',
                  title: `No 3D models in ${archives[0].name}`,
                  text: `The archive holds no file in a format Caliper reads.${
                    nested ? ' Archives inside archives are not opened; unpack those first.' : ''
                  }`,
                }
              : {
                  tone: 'error',
                  title: 'Nothing to open',
                  text: 'None of those files are in a format Caliper reads. Drop a mesh, CAD or BIM file, or a .zip of them.',
                },
          );
          return;
        }

        if (needsChooser(models.length, archives.length > 0)) {
          idle();
          const source = archives.length === 1 && files.length === 1 ? archives[0].name : `${files.length} files`;
          set({ pick: { source, models, companions, mode } });
          return;
        }

        await loadModels(
          models.map((file) => ({ file, companions })),
          mode,
        );
      });
    },

    async openPicked(files) {
      const pick = get().pick;
      set({ pick: null });
      if (!pick || !files.length) return;
      await exclusive(() => loadModels(files.map((file) => ({ file, companions: pick.companions })), pick.mode));
    },

    cancelPick() {
      set({ pick: null });
    },

    async openFromUrl(url, filename) {
      set({ status: 'loading', progressNote: `Fetching ${filename}`, progress: null });
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`The server replied ${response.status}.`);
        const blob = await response.blob();
        await get().open([new File([blob], filename, { type: blob.type })]);
      } catch (error) {
        set({ status: get().models.length ? 'ready' : 'idle', progress: null, progressNote: '' });
        get().toast({
          tone: 'error',
          title: 'Download failed',
          text: error instanceof Error ? error.message : 'The file could not be fetched.',
        });
      }
    },

    async openSample() {
      const { gearFile } = await import('@/lib/sample');
      await get().open([await gearFile()]);
    },

    close() {
      get().engine?.clearModel();
      window.clearTimeout(analysisTimer);
      window.clearTimeout(plateTimer);
      set({
        status: 'idle',
        workspace: 'home',
        models: [],
        activeId: null,
        model: null,
        scene: NO_EXTENT,
        parts: [],
        report: null,
        reportPending: false,
        selection: null,
        hover: null,
        measureTool: 'off',
        measurements: [],
        pendingPoints: 0,
        explode: 1,
        assembly: false,
        oriented: false,
      });
      syncPlate();
      syncView();
    },

    /* --- the plate ------------------------------------------------------ */

    setActiveModel(id) {
      const engine = get().engine;
      if (!engine || engine.activeModelId === id) return;
      engine.setActiveModel(id);
      syncActive();
    },

    removeModel(id) {
      const { engine, models } = get();
      if (!engine || !models.some((m) => m.id === id)) return;
      if (models.length === 1) return get().close();
      engine.removeModel(id);
      set({ models: models.filter((m) => m.id !== id) });
      syncActive();
      syncPlate();
      syncView();
      persistPlate();
    },

    setModelVisible(id, visible) {
      get().engine?.setModelVisible(id, visible);
      patchModel(id, { visible });
      syncPlate();
      syncView();
    },

    setModelColour(id, hex, paintAuthored) {
      const entry = get().models.find((m) => m.id === id);
      if (!entry) return;
      get().engine?.setModelColour(id, hex, paintAuthored);
      patchModel(id, { colour: hex, paintAuthored: paintAuthored ?? entry.paintAuthored });
      // The colour last picked is the one the next fresh plate starts in.
      set({ filament: hex, paintAuthored: paintAuthored ?? get().paintAuthored });
      persist();
      if (entry.recentId) {
        // The cached picture should show the colour the model is now. A colour
        // picker reports every step of a drag, so the redraw waits for a pause.
        const recentId = entry.recentId;
        window.clearTimeout(thumbTimers.get(id));
        thumbTimers.set(
          id,
          window.setTimeout(() => {
            thumbTimers.delete(id);
            const thumb = get().engine?.thumbnail(id) ?? null;
            void updateRecent(recentId, thumb ? { colour: hex, thumb } : { colour: hex }).then(() => get().refreshRecent());
          }, 500),
        );
      }
      persistPlate();
    },

    setModelPosition(id, position) {
      get().engine?.setModelPosition(id, position);
    },

    nudgeModel(dxMm, dzMm) {
      const { engine, activeId } = get();
      if (engine && activeId !== null) engine.moveModelBy(activeId, dxMm, dzMm);
    },

    cycleModel(step) {
      const { models, activeId } = get();
      if (models.length < 2) return;
      const at = models.findIndex((m) => m.id === activeId);
      get().setActiveModel(models[(at + step + models.length) % models.length].id);
    },

    arrange() {
      const { engine, models } = get();
      if (!engine || models.length < 2) return;
      engine.arrange();
    },

    frameModel(id) {
      get().engine?.frameModel(id);
    },

    /* --- the recent cache ----------------------------------------------- */

    async refreshRecent() {
      set({ recent: get().keepRecent ? await listRecent() : [] });
    },

    async openRecent(id, mode = 'replace') {
      await exclusive(async () => {
        const found = await loadRecent(id);
        if (!found) {
          get().toast({
            tone: 'info',
            title: 'That model is no longer kept',
            text: 'The browser cleared it from storage. Open the file again to keep it.',
          });
          await get().refreshRecent();
          return;
        }
        const [file, ...companions] = found.files;
        const { colour, unit } = found.record;
        await loadModels([{ file, companions, hint: { colour, unit, recentId: id } }], mode);
      });
    },

    async forgetRecent(id) {
      await removeRecent(id);
      set({ lastPlate: get().lastPlate.filter((item) => item.id !== id) });
      get().models.forEach((m) => m.recentId === id && patchModel(m.id, { recentId: null }));
      await get().refreshRecent();
    },

    async clearRecent() {
      await wipeRecent();
      get().models.forEach((m) => m.recentId && patchModel(m.id, { recentId: null }));
      set({ recent: [], lastPlate: [] });
    },

    async restorePlate() {
      const plate = get().lastPlate;
      if (!plate.length) return;
      await exclusive(async () => {
        set({ status: 'loading', progress: null, progressNote: 'Reading the last plate' });
        const items: LoadItem[] = [];
        for (const { id, colour, unit, position } of plate) {
          const found = await loadRecent(id);
          if (!found) continue;
          const [file, ...companions] = found.files;
          items.push({ file, companions, hint: { colour, unit, position, recentId: id } });
        }
        const missing = plate.length - items.length;
        if (!items.length) {
          set({ status: get().models.length ? 'ready' : 'idle', progress: null, progressNote: '', lastPlate: [] });
          get().toast({ tone: 'info', title: 'The last plate is gone', text: 'Its files were cleared from storage.' });
          return;
        }
        await loadModels(items, 'replace');
        if (missing) {
          get().toast({
            tone: 'info',
            title: `${missing} ${missing === 1 ? 'model is' : 'models are'} no longer kept`,
            text: 'The browser cleared them from storage. The rest are back where you left them.',
          });
        }
      });
    },

    /** Off forgets everything already kept, at once: "don't remember" includes the past. */
    setKeepRecent(keepRecent) {
      set({ keepRecent });
      persist();
      if (keepRecent) void get().refreshRecent();
      else void get().clearRecent();
    },

    /* --- workspace and display ------------------------------------------ */

    setWorkspace(workspace) {
      const { engine, measureTool } = get();
      // Preview is for looking at layers; tools that click on the part stay in Prepare.
      if (workspace !== 'prepare' && measureTool !== 'off') {
        engine?.setMeasureTool('off');
        set({ measureTool: 'off', pendingPoints: 0 });
      }
      set({ workspace });
      syncView();
    },

    setDisplay(key, value) {
      const engine = get().engine;
      const display = { ...get().display, [key]: value };
      set({ display });
      persist();
      if (!engine) return;

      switch (key) {
        case 'renderMode':
          engine.setRenderMode(display.renderMode);
          if (display.renderMode === 'edges' && engine.edgesTruncated) {
            get().toast({
              tone: 'info',
              title: 'Outlines stop partway',
              text: 'This model has more edges than can be drawn at speed. Shaded shows all of it.',
            });
          }
          break;
        case 'grid':
          engine.setGridVisible(display.grid);
          break;
        case 'shadows':
          engine.setShadowsEnabled(display.shadows);
          break;
        case 'projection':
          engine.setProjection(display.projection);
          break;
        case 'labels':
          engine.setPartLabels(display.labels);
          break;
        case 'overhang':
          syncView();
          break;
      }
    },

    setUnit(unit) {
      set({ unit });
      persist();
    },

    setSourceUnit(sourceUnit) {
      const { engine, model, models } = get();
      if (!engine || !model) {
        set({ sourceUnit });
        return;
      }
      engine.setModelUnit(model.id, MM_PER[sourceUnit]);
      patchModel(model.id, { sourceUnit });
      set({ sourceUnit });
      syncPlate();
      syncView();
      // Against its neighbours the model just grew or shrank; show all of it.
      if (models.length > 1) engine.frameAll();
      if (model.recentId) void updateRecent(model.recentId, { unit: sourceUnit });
      persistPlate();
    },

    setTheme(theme) {
      document.documentElement.dataset.theme = theme;
      rememberTheme(theme);
      get().engine?.setTheme(theme);
      set({ theme });
    },

    setBed(bedId) {
      set({ bedId });
      persist();
      syncPlate();
    },

    /** The Filament section: colours the active model, or sets the colour the next plate starts in. */
    setFilament(hex, paintAuthored = get().model?.paintAuthored ?? get().paintAuthored) {
      const model = get().model;
      if (model) return get().setModelColour(model.id, hex, paintAuthored);
      set({ filament: hex, paintAuthored });
      persist();
      get().engine?.setFilament(hex, paintAuthored);
    },

    setOverhangDeg(overhangDeg) {
      set({ overhangDeg });
      persist();
      syncView();
      scheduleOverhang();
    },

    setSection(patch) {
      set((s) => ({ section: { ...s.section, ...patch } }));
      syncView();
    },

    setLayerAt(layerAt) {
      set({ layerAt });
      syncView();
    },

    setLayerHeight(layerHeight) {
      set({ layerHeight });
      persist();
    },

    setExplode(ratio) {
      get().engine?.setExplode(ratio);
      set({ explode: ratio, scene: get().engine?.plateExtent() ?? NO_EXTENT });
    },

    setAssembly(assembly) {
      const engine = get().engine;
      if (assembly && !engine?.canExplode) {
        get().toast({
          tone: 'info',
          title: 'Nothing to pull apart',
          text: 'This file is a single part. The assembly view needs two or more.',
        });
        return;
      }
      if (!assembly) engine?.setExplode(1);
      set({ assembly, explode: assembly ? get().explode : 1 });
    },

    autoOrient() {
      const engine = get().engine;
      if (!engine || !get().model) return;
      if (!engine.autoOrient()) {
        get().toast({
          tone: 'info',
          title: 'No flat face to stand on',
          text: 'This part has no flat face on its outside, so it stays the way it is.',
        });
      }
    },

    resetOrientation() {
      get().engine?.resetOrientation();
    },

    setPartVisible(id, visible) {
      get().engine?.setPartVisible(id, visible);
    },

    isolatePart(id) {
      get().engine?.isolate(id);
    },

    selectPart(id) {
      get().engine?.select(id);
    },

    toggleSidebar(force) {
      set((s) => ({ sidebarOpen: force ?? !s.sidebarOpen }));
      persist();
    },

    toggleSheet(force) {
      set((s) => ({ sheetOpen: force ?? !s.sheetOpen }));
    },

    setShortcutsOpen(shortcutsOpen) {
      set({ shortcutsOpen });
      get().engine?.setPaused(shortcutsOpen);
    },

    setView(preset) {
      get().engine?.setView(preset);
    },

    frameAll() {
      get().engine?.frameAll();
    },

    frameSelection() {
      const { engine, selection } = get();
      if (engine && selection) engine.frameSelection(selection.id);
    },

    clearSelection() {
      get().engine?.select(null);
    },

    setMeasureTool(tool) {
      const { engine, measureTool, model, workspace } = get();
      if (!model) return;
      // Pressing the tool you are already holding puts it down.
      const next = tool === measureTool ? 'off' : tool;
      engine?.setMeasureTool(next);
      set({ measureTool: next, pendingPoints: 0 });
      if (next !== 'off' && workspace !== 'prepare') get().setWorkspace('prepare');
    },

    removeMeasurement(id) {
      get().engine?.removeMeasurement(id);
    },

    clearMeasurements() {
      get().engine?.clearMeasurements();
    },

    undoMeasure() {
      get().engine?.undoMeasurePoint();
    },

    setFrame(frame) {
      set({ frame });
    },

    setSelection(selection) {
      set({ selection });
    },

    setHover(hover) {
      if (get().hover !== hover) set({ hover });
    },

    setMeasurements(measurements, pendingPoints) {
      set({ measurements, pendingPoints });
    },

    setContextLost(contextLost) {
      set({ contextLost });
    },

    setParts(parts) {
      set({ parts });
    },

    /** A model was reoriented or moved: sizes, positions and the plate catch up. */
    onTransform() {
      const { engine } = get();
      if (!engine || !get().models.length) return;
      const activeId = engine.activeModelId;
      const models = get().models.map((m) => ({
        ...m,
        position: engine.modelPosition(m.id),
        dimensions: m.id === activeId ? engine.dimensions(m.id) : m.dimensions,
      }));
      set({
        models,
        model: models.find((m) => m.id === activeId) ?? null,
        explode: engine.explodeRatio,
        oriented: engine.oriented,
        plate: engine.plateInfo,
        scene: engine.plateExtent(),
      });
      syncView();
      scheduleOverhang();
      persistPlate();
    },

    /** A click on the canvas made another model active. */
    onActiveModel() {
      syncActive();
    },

    toast(t) {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-3) }));
      const life = t.action ? 12000 : t.tone === 'error' ? 9000 : 4200;
      window.setTimeout(() => get().dismiss(id), life);
    },

    dismiss(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  };
});

/** File units → millimetres, for the active model. */
export function useMm() {
  const sourceUnit = useViewer((s) => s.sourceUnit);
  return MM_PER[sourceUnit];
}

export type { Axis };
