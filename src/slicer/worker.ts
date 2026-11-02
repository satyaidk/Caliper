/// <reference lib="webworker" />
import { slicePlate, SliceError, type SliceInput, type SliceOutput } from './index';
import { filamentById, printerById, type FilamentId } from './profiles';
import { verifyGcode, type VerifyReport } from './verify';

/**
 * Slicing runs here, off the main thread: a large model takes seconds, and the
 * page must keep drawing and answering clicks while it does.
 *
 * Messages in:  { id, type: 'slice', input }
 *               { id, type: 'verify', text, printerId, filamentId }
 * Messages out: { id, type: 'progress', fraction, note }
 *               { id, type: 'sliced', output }  |  { id, type: 'verified', report }
 *               { id, type: 'failed', message, expected }
 *
 * `expected` separates a refusal the person can act on (a SliceError: the
 * model is off the bed) from a bug, so the interface can word them differently.
 */

export type WorkerRequest =
  | { id: number; type: 'slice'; input: SliceInput }
  | { id: number; type: 'verify'; text: string; printerId: string; filamentId: FilamentId | null };

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number; note: string }
  | { id: number; type: 'sliced'; output: SliceOutput }
  | { id: number; type: 'verified'; report: VerifyReport }
  | { id: number; type: 'failed'; message: string; expected: boolean };

const scope = self as unknown as DedicatedWorkerGlobalScope;

const transfers = (report: VerifyReport): Transferable[] => {
  const p = report.preview;
  return [p.segments.buffer, p.roles.buffer, p.layerStarts.buffer, p.layerZ.buffer, p.travels.buffer, p.travelLayerStarts.buffer];
};

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'slice') {
      let last = 0;
      const output = slicePlate(request.input, (fraction, note) => {
        // A message per triangle batch would flood the page; a percent is plenty.
        if (fraction - last < 0.01 && fraction < 1) return;
        last = fraction;
        scope.postMessage({ id: request.id, type: 'progress', fraction, note } satisfies WorkerResponse);
      });
      scope.postMessage({ id: request.id, type: 'sliced', output } satisfies WorkerResponse, transfers(output.report));
    } else {
      const printer = printerById(request.printerId);
      if (!printer) throw new SliceError('Choose a printer to check the file against.');
      const report = verifyGcode(request.text, {
        printer,
        filament: request.filamentId ? filamentById(request.filamentId) : null,
        source: 'external',
      });
      scope.postMessage({ id: request.id, type: 'verified', report } satisfies WorkerResponse, transfers(report));
    }
  } catch (error) {
    const expected = error instanceof SliceError;
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ id: request.id, type: 'failed', message, expected } satisfies WorkerResponse);
  }
};
