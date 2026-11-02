import { create } from 'zustand';
import { useViewer } from './useViewer';
import {
  DEFAULT_PROCESS,
  filamentById,
  printerById,
  settingProblems,
  type CustomGcode,
  type FilamentId,
  type ProcessSettings,
} from '@/slicer/profiles';
import type { SliceOutput } from '@/slicer/index';
import type { VerifyReport } from '@/slicer/verify';
import type { WorkerRequest, WorkerResponse } from '@/slicer/worker';

/**
 * Slicing, checking and exporting, kept apart from the viewer store so the
 * viewer stays about looking at models.
 *
 * The flow, and where each safety rule lives:
 *
 *   Slice     the plate's triangles go to a Web Worker, which slices them,
 *             writes G-code and runs the checker over the text it wrote.
 *   Review    the Preview draws the checked file's moves layer by layer, and
 *             the sidebar lists every finding.
 *   Export    allowed only when the result is current (nothing changed since
 *             slicing), has no errors, and the person has acknowledged the
 *             warnings and the first-print checklist.
 *
 * Any G-code file can also be checked against the chosen printer, so files
 * from other slicers get the same scrutiny before they reach a printer.
 */

const PREFS_KEY = 'caliper.slicer.v1';
const GENERATOR = 'Caliper 2.1 (experimental slicer)';

/** Everything in ProcessSettings except the layer height, which the viewer owns. */
export type ProcessPrefs = Omit<ProcessSettings, 'layerHeight'>;

export interface SliceResult {
  source: 'caliper' | 'external';
  /** For the download and the readout. */
  name: string;
  gcode: string;
  report: VerifyReport;
  printerId: string;
  filamentId: FilamentId | null;
  layerCount: number;
  ms: number;
  /** The plate or a setting changed after slicing: the file no longer matches. */
  stale: boolean;
  /** What the plate and settings were when this was sliced. */
  key: string;
}

interface SlicerState {
  filamentId: FilamentId;
  process: ProcessPrefs;
  /** Start and end sequences typed by the person, per printer. */
  custom: Record<string, CustomGcode>;

  status: 'idle' | 'working' | 'failed';
  progress: number;
  note: string;
  error: string | null;
  result: SliceResult | null;

  /** Highest layer drawn in the Preview, 0-based. */
  viewLayer: number;
  showTravel: boolean;
  exportOpen: boolean;

  setFilamentId(id: FilamentId): void;
  setProcess(patch: Partial<ProcessPrefs>): void;
  setCustom(printerId: string, patch: Partial<CustomGcode>): void;
  resetProcess(): void;

  slice(): void;
  cancel(): void;
  checkFile(file: File): Promise<void>;
  clearResult(): void;

  setViewLayer(layer: number): void;
  setShowTravel(on: boolean): void;
  setExportOpen(open: boolean): void;
  download(): void;

  /** Called when the viewer changes: keeps staleness and the drawing in step. */
  syncFromViewer(): void;
}

interface Prefs {
  filamentId: FilamentId;
  process: ProcessPrefs;
  custom: Record<string, CustomGcode>;
  showTravel: boolean;
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
    /* private mode: settings last for the session */
  }
}

const saved = readPrefs();
const { layerHeight: _unused, ...defaultPrefs } = DEFAULT_PROCESS;

let worker: Worker | null = null;
let requestSeq = 0;
let pending: { id: number; resolve: (r: WorkerResponse) => void } | null = null;

function startWorker(onProgress: (fraction: number, note: string) => void): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../slicer/worker.ts', import.meta.url), { type: 'module', name: 'caliper-slicer' });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (!pending || message.id !== pending.id) return;
    if (message.type === 'progress') onProgress(message.fraction, message.note);
    else pending.resolve(message);
  };
  return worker;
}

function ask(request: WorkerRequest, onProgress: (fraction: number, note: string) => void): Promise<WorkerResponse> {
  const w = startWorker(onProgress);
  return new Promise((resolve) => {
    pending = { id: request.id, resolve };
    w.postMessage(request, request.type === 'slice' ? [request.input.positions.buffer] : []);
  });
}

/** What a result depends on, so a change after slicing marks it stale. */
function currentKey(): string {
  const viewer = useViewer.getState();
  const s = useSlicer.getState();
  return JSON.stringify({
    geometry: viewer.engine?.geometryKey() ?? '',
    bed: viewer.bedId,
    layerHeight: viewer.layerHeight,
    filament: s.filamentId,
    process: s.process,
    custom: s.custom[viewer.bedId] ?? null,
  });
}

export const useSlicer = create<SlicerState>((set, get) => {
  const persist = () => {
    const { filamentId, process, custom, showTravel } = get();
    writePrefs({ filamentId, process, custom, showTravel });
  };

  /** Shows toolpaths in Preview when there is a result, the models otherwise. */
  const syncDrawing = () => {
    const { engine, workspace } = useViewer.getState();
    const { result, viewLayer, showTravel } = get();
    if (!engine) return;
    const printer = result ? printerById(result.printerId) : null;
    const want = workspace === 'preview' && result && printer ? result : null;
    if (want && printer) {
      if (drawn !== want) {
        engine.showToolpaths(want.report.preview, [printer.bed[0], printer.bed[1]]);
        drawn = want;
      }
      engine.setToolpathLayer(viewLayer, showTravel);
    } else if (drawn) {
      engine.showToolpaths(null, [0, 0]);
      drawn = null;
    }
  };
  let drawn: SliceResult | null = null;

  const markStale = () => {
    const { result } = get();
    if (result && result.source === 'caliper' && !result.stale && result.key !== currentKey()) {
      set({ result: { ...result, stale: true }, exportOpen: false });
    }
  };

  const failed = (message: string) => {
    set({ status: 'failed', error: message, progress: 0, note: '' });
  };

  return {
    filamentId: saved.filamentId ?? 'pla',
    process: { ...defaultPrefs, ...saved.process },
    custom: saved.custom ?? {},

    status: 'idle',
    progress: 0,
    note: '',
    error: null,
    result: null,

    viewLayer: 0,
    showTravel: saved.showTravel ?? false,
    exportOpen: false,

    setFilamentId(filamentId) {
      set({ filamentId });
      persist();
      markStale();
    },

    setProcess(patch) {
      set({ process: { ...get().process, ...patch } });
      persist();
      markStale();
    },

    setCustom(printerId, patch) {
      const current = get().custom[printerId] ?? { start: '', end: '' };
      set({ custom: { ...get().custom, [printerId]: { ...current, ...patch } } });
      persist();
      markStale();
    },

    resetProcess() {
      set({ process: { ...defaultPrefs } });
      persist();
      markStale();
    },

    slice() {
      const viewer = useViewer.getState();
      const { engine, bedId, models, layerHeight } = viewer;
      if (!engine || get().status === 'working') return;
      const printer = printerById(bedId);
      if (!printer) {
        failed('Choose a printer under Printer first. Slicing needs its bed size and limits.');
        return;
      }
      if (!models.some((m) => m.visible)) {
        failed('Nothing to slice: open a model, or show one that is hidden.');
        return;
      }
      const process: ProcessSettings = { ...get().process, layerHeight };
      const problems = settingProblems(printer, filamentById(get().filamentId), process);
      if (problems.length) {
        failed(problems.join(' '));
        return;
      }
      // The assembly view pulls parts apart; slice them where they really are.
      if (viewer.assembly) viewer.setAssembly(false);

      const key = currentKey();
      const positions = engine.printTriangles();
      const id = ++requestSeq;
      set({ status: 'working', progress: 0, note: 'Preparing the plate', error: null });
      void ask(
        {
          id,
          type: 'slice',
          input: {
            positions,
            models: models.filter((m) => m.visible).map((m) => m.name),
            printerId: printer.id,
            filamentId: get().filamentId,
            process,
            custom: get().custom[printer.id] ?? null,
            generator: GENERATOR,
          },
        },
        (fraction, note) => set({ progress: fraction, note }),
      ).then((response) => {
        if (id !== requestSeq) return; // cancelled or superseded
        if (response.type === 'failed') {
          failed(response.expected ? response.message : `The slicer stopped unexpectedly: ${response.message}`);
          return;
        }
        if (response.type !== 'sliced') return;
        const output: SliceOutput = response.output;
        const base = models.find((m) => m.visible)?.name.replace(/\.[^.]+$/, '') ?? 'plate';
        set({
          status: 'idle',
          progress: 1,
          note: '',
          result: {
            source: 'caliper',
            name: `${base}_${printer.id}_${get().filamentId}.gcode`,
            gcode: output.gcode,
            report: output.report,
            printerId: printer.id,
            filamentId: get().filamentId,
            layerCount: output.layerCount,
            ms: output.ms,
            stale: false,
            key,
          },
          viewLayer: Math.max(0, output.report.preview.layerStarts.length - 1),
        });
        if (useViewer.getState().workspace !== 'preview') useViewer.getState().setWorkspace('preview');
        syncDrawing();
      });
    },

    cancel() {
      // The worker cannot be interrupted mid-slice; replacing it is the only stop.
      requestSeq++;
      pending = null;
      worker?.terminate();
      worker = null;
      set({ status: 'idle', progress: 0, note: '' });
    },

    async checkFile(file) {
      const { bedId } = useViewer.getState();
      const printer = printerById(bedId);
      if (!printer) {
        failed('Choose the printer the file is for under Printer first; it is checked against that printer’s limits.');
        return;
      }
      const id = ++requestSeq;
      set({ status: 'working', progress: 0, note: `Reading ${file.name}`, error: null });
      const text = await file.text();
      const response = await ask(
        { id, type: 'verify', text, printerId: printer.id, filamentId: null },
        (fraction, note) => set({ progress: fraction, note }),
      );
      if (id !== requestSeq) return;
      if (response.type === 'failed') {
        failed(response.message);
        return;
      }
      if (response.type !== 'verified') return;
      set({
        status: 'idle',
        progress: 1,
        note: '',
        result: {
          source: 'external',
          name: file.name,
          gcode: text,
          report: response.report,
          printerId: printer.id,
          filamentId: null,
          layerCount: response.report.stats.layers,
          ms: 0,
          stale: false,
          key: '',
        },
        viewLayer: Math.max(0, response.report.preview.layerStarts.length - 1),
      });
      useViewer.getState().setWorkspace('preview');
      syncDrawing();
    },

    clearResult() {
      set({ result: null, exportOpen: false, error: null, status: 'idle' });
      syncDrawing();
    },

    setViewLayer(viewLayer) {
      set({ viewLayer });
      syncDrawing();
    },

    setShowTravel(showTravel) {
      set({ showTravel });
      persist();
      syncDrawing();
    },

    setExportOpen(exportOpen) {
      const { result } = get();
      if (exportOpen && (!result || result.source !== 'caliper' || result.stale || !result.report.ok)) return;
      set({ exportOpen });
    },

    download() {
      const { result } = get();
      if (!result || result.source !== 'caliper' || result.stale || !result.report.ok) return;
      const blob = new Blob([result.gcode], { type: 'text/x.gcode' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = result.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      set({ exportOpen: false });
      useViewer.getState().toast({ tone: 'success', title: 'G-code saved', text: `${result.name} — watch the first layer.` });
    },

    syncFromViewer() {
      markStale();
      syncDrawing();
    },
  };
});

// The viewer drives staleness and drawing: models moved, printer changed,
// workspace switched. Comparing the inputs keeps this cheap on camera moves.
let lastSeen = '';
useViewer.subscribe((state) => {
  const seen = `${state.workspace}|${state.bedId}|${state.layerHeight}|${state.models.length}|${state.engine ? 1 : 0}|${state.models
    .map((m) => `${m.id}:${m.visible}:${m.position.join(',')}:${m.sourceUnit}`)
    .join(';')}|${state.oriented}|${state.scene.x},${state.scene.y},${state.scene.z}`;
  if (seen === lastSeen) return;
  lastSeen = seen;
  if (!state.models.length && useSlicer.getState().result?.source === 'caliper') {
    useSlicer.getState().clearResult();
    return;
  }
  useSlicer.getState().syncFromViewer();
});
