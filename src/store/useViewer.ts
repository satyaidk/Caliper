import { create } from 'zustand';
import type { Engine, FrameInfo, SelectionInfo } from '@/viewer/Engine';
import { buildTree, computeDimensions, computeStats } from '@/viewer/analyze';
import { buildContext, loadModel, pickPrimary } from '@/viewer/loaders';
import { extOf, specFor } from '@/lib/formats';
import type {
  ClipAxis,
  ModelInfo,
  ProjectionMode,
  RenderMode,
  Toast,
  TreeNode,
  UnitSystem,
  ViewPreset,
} from '@/types';

export type Status = 'idle' | 'loading' | 'ready';
export type InspectorTab = 'model' | 'tree' | 'display';
export type Theme = 'dark' | 'light';

interface Display {
  renderMode: RenderMode;
  projection: ProjectionMode;
  grid: boolean;
  axes: boolean;
  shadows: boolean;
  autoRotate: boolean;
  exposure: number;
  environment: number;
  tint: string;
  explode: number;
  clipEnabled: boolean;
  clipAxis: ClipAxis;
  clipT: number;
}

interface ViewerState {
  engine: Engine | null;
  status: Status;
  progress: number | null;
  progressNote: string;
  model: ModelInfo | null;
  tree: TreeNode | null;
  selection: SelectionInfo | null;
  hidden: number[];
  frame: FrameInfo;
  display: Display;
  unit: UnitSystem;
  theme: Theme;
  inspectorOpen: boolean;
  tab: InspectorTab;
  paletteOpen: boolean;
  sheetOpen: boolean;
  toasts: Toast[];

  attach(engine: Engine): void;
  detach(): void;
  open(files: File[]): Promise<void>;
  openFromUrl(url: string, filename: string): Promise<void>;
  close(): void;

  setDisplay<K extends keyof Display>(key: K, value: Display[K]): void;
  setUnit(unit: UnitSystem): void;
  setTheme(theme: Theme): void;
  setTab(tab: InspectorTab): void;
  toggleInspector(force?: boolean): void;
  togglePalette(force?: boolean): void;
  toggleSheet(force?: boolean): void;
  setView(preset: ViewPreset): void;
  frameAll(): void;
  selectNode(id: number | null): void;
  toggleNode(id: number): void;
  showAll(): void;
  setFrame(info: FrameInfo): void;
  setSelection(info: SelectionInfo | null): void;

  toast(t: Omit<Toast, 'id'>): void;
  dismiss(id: number): void;
}

const DEFAULT_DISPLAY: Display = {
  renderMode: 'shaded',
  projection: 'perspective',
  grid: true,
  axes: false,
  shadows: true,
  autoRotate: false,
  exposure: 1,
  environment: 1,
  tint: '#b8c3d4',
  explode: 0,
  clipEnabled: false,
  clipAxis: 'x',
  clipT: 1,
};

let toastSeq = 0;

export const useViewer = create<ViewerState>((set, get) => ({
  engine: null,
  status: 'idle',
  progress: null,
  progressNote: '',
  model: null,
  tree: null,
  selection: null,
  hidden: [],
  frame: { fps: 0, calls: 0, triangles: 0 },
  display: DEFAULT_DISPLAY,
  unit: 'mm',
  theme: 'dark',
  inspectorOpen: true,
  tab: 'model',
  paletteOpen: false,
  sheetOpen: false,
  toasts: [],

  attach(engine) {
    set({ engine });
    const d = get().display;
    engine.setGridVisible(d.grid);
    engine.setAxesVisible(d.axes);
    engine.setShadowsEnabled(d.shadows);
    engine.setTheme(get().theme);
  },

  detach() {
    set({ engine: null });
  },

  async open(files) {
    const engine = get().engine;
    if (!engine) return;

    const primary = pickPrimary(files);
    if (!primary) {
      get().toast({
        tone: 'error',
        title: 'Nothing to open',
        text: 'None of those files are in a format Caliper reads. Drop a mesh, CAD or BIM file.',
      });
      return;
    }

    const spec = specFor(primary.name)!;
    set({ status: 'loading', progress: null, progressNote: 'Reading file', selection: null });

    const ctx = buildContext(files, (fraction, note) =>
      set((s) => ({
        progress: fraction,
        progressNote: note ?? s.progressNote,
      })),
    );

    const started = performance.now();
    try {
      const { object, hasAuthoredMaterials } = await loadModel(primary, ctx);
      const stats = computeStats(object);
      if (!stats.meshes && !stats.vertices) {
        throw new Error('The file opened but contains no drawable geometry.');
      }
      const dimensions = computeDimensions(object);

      engine.setModel(object, hasAuthoredMaterials);
      engine.setExplode(0);
      engine.setClipping(false, get().display.clipAxis, get().display.clipT);

      set({
        status: 'ready',
        progress: null,
        progressNote: '',
        hidden: [],
        selection: null,
        tree: buildTree(engine.modelRoot ?? object),
        display: { ...get().display, explode: 0, clipEnabled: false },
        model: {
          name: primary.name,
          ext: extOf(primary.name),
          pipeline: spec.pipeline,
          bytes: primary.size,
          parseMs: performance.now() - started,
          stats,
          dimensions,
        },
      });

      get().toast({
        tone: 'success',
        title: `Opened ${primary.name}`,
        text: `${stats.triangles.toLocaleString()} triangles in ${Math.round(performance.now() - started)} ms`,
      });
    } catch (error) {
      set({ status: get().model ? 'ready' : 'idle', progress: null, progressNote: '' });
      get().toast({
        tone: 'error',
        title: `Could not open ${primary.name}`,
        text: error instanceof Error ? error.message : 'The file could not be read.',
      });
    } finally {
      // Blob URLs stay alive briefly so async texture fetches can finish.
      setTimeout(ctx.revoke, 12_000);
    }
  },

  async openFromUrl(url, filename) {
    set({ status: 'loading', progressNote: `Fetching ${filename}`, progress: null });
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`The server replied ${response.status}.`);
      const blob = await response.blob();
      await get().open([new File([blob], filename, { type: blob.type })]);
    } catch (error) {
      set({ status: get().model ? 'ready' : 'idle', progress: null, progressNote: '' });
      get().toast({
        tone: 'error',
        title: 'Download failed',
        text: error instanceof Error ? error.message : 'The file could not be fetched.',
      });
    }
  },

  close() {
    get().engine?.clearModel();
    set({
      status: 'idle',
      model: null,
      tree: null,
      selection: null,
      hidden: [],
      display: { ...get().display, explode: 0, clipEnabled: false },
    });
  },

  setDisplay(key, value) {
    const engine = get().engine;
    const display = { ...get().display, [key]: value };
    set({ display });
    if (!engine) return;

    switch (key) {
      case 'renderMode':
        engine.setRenderMode(display.renderMode);
        break;
      case 'projection':
        engine.setProjection(display.projection);
        break;
      case 'grid':
        engine.setGridVisible(display.grid);
        break;
      case 'axes':
        engine.setAxesVisible(display.axes);
        break;
      case 'shadows':
        engine.setShadowsEnabled(display.shadows);
        break;
      case 'autoRotate':
        engine.setAutoRotate(display.autoRotate);
        break;
      case 'exposure':
        engine.setExposure(display.exposure);
        break;
      case 'environment':
        engine.setEnvironmentIntensity(display.environment);
        break;
      case 'tint':
        engine.setTint(display.tint);
        break;
      case 'explode':
        engine.setExplode(display.explode);
        break;
      case 'clipEnabled':
      case 'clipAxis':
      case 'clipT':
        engine.setClipping(display.clipEnabled, display.clipAxis, display.clipT);
        break;
    }
  },

  setUnit(unit) {
    set({ unit });
  },

  setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    get().engine?.setTheme(theme);
    set({ theme });
  },

  setTab(tab) {
    set({ tab });
  },

  toggleInspector(force) {
    set((s) => ({ inspectorOpen: force ?? !s.inspectorOpen }));
  },

  togglePalette(force) {
    set((s) => ({ paletteOpen: force ?? !s.paletteOpen }));
  },

  toggleSheet(force) {
    set((s) => ({ sheetOpen: force ?? !s.sheetOpen }));
  },

  setView(preset) {
    get().engine?.setView(preset);
  },

  frameAll() {
    get().engine?.frameAll();
  },

  selectNode(id) {
    get().engine?.select(id);
  },

  toggleNode(id) {
    const hidden = get().hidden;
    const next = hidden.includes(id) ? hidden.filter((v) => v !== id) : [...hidden, id];
    get().engine?.setNodeVisible(id, !next.includes(id));
    set({ hidden: next });
  },

  showAll() {
    get().engine?.showAll();
    set({ hidden: [] });
  },

  setFrame(frame) {
    set({ frame });
  },

  setSelection(selection) {
    set({ selection });
  },

  toast(t) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-4) }));
    window.setTimeout(() => get().dismiss(id), t.tone === 'error' ? 9000 : 4200);
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
