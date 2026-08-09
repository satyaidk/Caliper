import { create } from 'zustand';
import type { Engine, FrameInfo, SelectionInfo } from '@/viewer/Engine';
import { computeDimensions, computeStats } from '@/viewer/analyze';
import { buildContext, loadModel, pickPrimary } from '@/viewer/loaders';
import { extOf, specFor } from '@/lib/formats';
import type {
  Measurement,
  MeasureTool,
  ModelInfo,
  RenderMode,
  Toast,
  UnitSystem,
  ViewPreset,
} from '@/types';

export type Status = 'idle' | 'loading' | 'ready';
export type Theme = 'dark' | 'light';

const PREFS_KEY = 'caliper.prefs';
const THEME_KEY = 'caliper.theme';

export interface Display {
  renderMode: RenderMode;
  grid: boolean;
  shadows: boolean;
}

const DEFAULT_DISPLAY: Display = {
  renderMode: 'shaded',
  grid: true,
  shadows: true,
};

/* --- preferences -----------------------------------------------------------
   Storage is unavailable in some privacy modes, and a remembered toggle is not
   worth a crash. Only the settings that describe *how you like to look at
   models* persist — anything tied to the file in front of you starts clean. */

interface Prefs {
  display: Display;
  unit: UnitSystem;
  panelOpen: boolean;
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
 * A remembered choice wins; otherwise follow the OS. index.html stamps the same
 * value on <html> before first paint, so this only has to agree with it.
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

interface ViewerState {
  engine: Engine | null;
  status: Status;
  progress: number | null;
  progressNote: string;
  contextLost: boolean;

  model: ModelInfo | null;
  selection: SelectionInfo | null;
  hover: string | null;
  frame: FrameInfo;

  display: Display;
  unit: UnitSystem;
  theme: Theme;

  measureTool: MeasureTool;
  measurements: Measurement[];
  pendingPoints: number;

  panelOpen: boolean;
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
  togglePanel(force?: boolean): void;
  toggleSheet(force?: boolean): void;

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

  toast(t: Omit<Toast, 'id'>): void;
  dismiss(id: number): void;
}

let toastSeq = 0;

export const useViewer = create<ViewerState>((set, get) => {
  const persist = () => {
    const { display, unit, panelOpen } = get();
    writePrefs({ display, unit, panelOpen });
  };

  return {
    engine: null,
    status: 'idle',
    progress: null,
    progressNote: '',
    contextLost: false,

    model: null,
    selection: null,
    hover: null,
    frame: { fps: 0, quality: 1 },

    display: { ...DEFAULT_DISPLAY, ...(saved.display ?? {}) },
    unit: saved.unit ?? 'mm',
    theme: initialTheme(),

    measureTool: 'off',
    measurements: [],
    pendingPoints: 0,

    panelOpen: saved.panelOpen ?? true,
    sheetOpen: false,
    toasts: [],

    attach(engine) {
      set({ engine });
      const d = get().display;
      engine.setGridVisible(d.grid);
      engine.setShadowsEnabled(d.shadows);
      engine.setRenderMode(d.renderMode);
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
        set((s) => ({ progress: fraction, progressNote: note ?? s.progressNote })),
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
        engine.setMeasureTool('off');

        set({
          status: 'ready',
          progress: null,
          progressNote: '',
          selection: null,
          hover: null,
          measureTool: 'off',
          measurements: [],
          pendingPoints: 0,
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
        selection: null,
        hover: null,
        measureTool: 'off',
        measurements: [],
        pendingPoints: 0,
      });
    },

    setDisplay(key, value) {
      const engine = get().engine;
      const display = { ...get().display, [key]: value };
      set({ display });
      persist();
      if (!engine) return;

      if (key === 'renderMode') {
        engine.setRenderMode(display.renderMode);
        if (display.renderMode === 'edges' && engine.edgesTruncated) {
          get().toast({
            tone: 'info',
            title: 'Outlines stop partway',
            text: 'This model has more edges than can be drawn at speed. Shaded shows all of it.',
          });
        }
      } else if (key === 'grid') {
        engine.setGridVisible(display.grid);
      } else if (key === 'shadows') {
        engine.setShadowsEnabled(display.shadows);
      }
    },

    setUnit(unit) {
      set({ unit });
      persist();
    },

    setTheme(theme) {
      document.documentElement.dataset.theme = theme;
      rememberTheme(theme);
      get().engine?.setTheme(theme);
      set({ theme });
    },

    togglePanel(force) {
      set((s) => ({ panelOpen: force ?? !s.panelOpen }));
      persist();
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

    frameSelection() {
      const { engine, selection } = get();
      if (engine && selection) engine.frameSelection(selection.id);
    },

    clearSelection() {
      get().engine?.select(null);
    },

    setMeasureTool(tool) {
      const { engine, measureTool } = get();
      // Pressing the tool you are already holding puts it down.
      const next = tool === measureTool ? 'off' : tool;
      engine?.setMeasureTool(next);
      set({ measureTool: next, pendingPoints: 0 });
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

    toast(t) {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-3) }));
      window.setTimeout(() => get().dismiss(id), t.tone === 'error' ? 9000 : 4200);
    },

    dismiss(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  };
});
