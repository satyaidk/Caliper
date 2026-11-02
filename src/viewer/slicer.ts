/**
 * Main-thread side of slicing: one worker per job, so cancelling is simply
 * terminating it, and a stuck slice can never hold the page.
 */
import type { PreviewData, SliceRequest, SliceResponse, SliceStage, SliceSummary } from './sliceProtocol';

export interface SliceJobResult {
  summary: SliceSummary;
  preview: PreviewData;
  archive: Uint8Array | null;
}

export interface SliceJob {
  promise: Promise<SliceJobResult>;
  cancel(): void;
}

let nextId = 1;

export function startSlice(
  request: Omit<SliceRequest, 'id'>,
  onStage: (stage: SliceStage) => void,
): SliceJob {
  const id = nextId++;
  const worker = new Worker(new URL('./sliceWorker.ts', import.meta.url), { type: 'module', name: 'caliper-slicer' });
  let settle: { reject(reason: Error): void } | null = null;
  const promise = new Promise<SliceJobResult>((resolve, reject) => {
    settle = { reject };
    worker.onmessage = (event: MessageEvent<SliceResponse>) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === 'progress') onStage(message.stage);
      else {
        worker.terminate();
        if (message.type === 'error') reject(new Error(message.message));
        else resolve({ summary: message.summary, preview: message.preview, archive: message.archive });
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The slicer stopped unexpectedly.'));
    };
  });
  worker.postMessage({ ...request, id } satisfies SliceRequest, [request.triangles.buffer]);
  return {
    promise,
    cancel() {
      worker.terminate();
      settle?.reject(new Error('Slicing cancelled.'));
    },
  };
}
