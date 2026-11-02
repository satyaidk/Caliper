/// <reference lib="webworker" />
/**
 * Slicing runs here so the page stays responsive: profiles are fetched (or
 * read from IndexedDB), the plate is sliced, the G-code is written and
 * pre-flight checked, and — only if it passes — packed as `.gcode.3mf`.
 */
import { fromArray } from './triangles';
import { indexedDbProfileCache, loadP1SProfiles } from '@/lib/bambu/profiles';
import { packageSlice, slicePlate } from '@/lib/bambu/slice';
import { featureRgb } from '@/lib/featureColors';
import type { Feature, ToolpathResult } from '@/lib/toolpath';
import type { PreviewData, SliceRequest, SliceResponse } from './sliceProtocol';

const cache = indexedDbProfileCache();
const post = (message: SliceResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);

function previewOf(toolpaths: ToolpathResult): PreviewData {
  let vertices = 0;
  for (const layer of toolpaths.layers) {
    for (const path of layer.paths) vertices += Math.max(0, path.points.length - 1) * 2;
  }
  const positions = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const layerEnds = new Uint32Array(toolpaths.layers.length);
  const layerZ = new Float32Array(toolpaths.layers.length);
  const features = new Set<Feature>();
  let v = 0;
  toolpaths.layers.forEach((layer, index) => {
    for (const path of layer.paths) {
      features.add(path.feature);
      const [r, g, b] = featureRgb(path.feature);
      for (let i = 1; i < path.points.length; i++) {
        for (const point of [path.points[i - 1], path.points[i]]) {
          positions[v * 3] = point.x;
          positions[v * 3 + 1] = point.y;
          positions[v * 3 + 2] = layer.z;
          colors[v * 3] = r;
          colors[v * 3 + 1] = g;
          colors[v * 3 + 2] = b;
          v++;
        }
      }
    }
    layerEnds[index] = v;
    layerZ[index] = layer.z;
  });
  return { positions, colors, layerEnds, layerZ, features: [...features] };
}

self.onmessage = async (event: MessageEvent<SliceRequest>) => {
  const request = event.data;
  const { id } = request;
  try {
    post({ id, type: 'progress', stage: 'profiles' });
    const profiles = await loadP1SProfiles(request.choices.processId, request.choices.filamentId, { cache });
    post({ id, type: 'progress', stage: 'slicing' });
    const output = slicePlate(fromArray(request.triangles), request.heightMm, profiles, request.choices, request.application);
    post({ id, type: 'progress', stage: 'packaging' });
    const archive = output.preflight.ok
      ? packageSlice(output, profiles, request.choices, request.filamentColour, request.application, request.objectName)
      : null;
    const preview = previewOf(output.toolpaths);
    const { settings } = output;
    post(
      {
        id,
        type: 'result',
        summary: {
          stats: output.stats,
          preflight: output.preflight,
          settings: {
            layerHeight: settings.layerHeight,
            plateType: settings.plateType,
            wallLoops: settings.wallLoops,
            infillDensity: settings.infillDensity,
            filamentType: settings.filament.type,
            nozzleTemperature: settings.filament.nozzleTemperature,
            bedTemperature: settings.filament.bedTemperature,
            processName: settings.names.process,
            filamentName: settings.names.filament,
          },
        },
        preview,
        archive,
      },
      [preview.positions.buffer, preview.colors.buffer, ...(archive ? [archive.buffer] : [])],
    );
  } catch (error) {
    post({ id, type: 'error', message: error instanceof Error ? error.message : 'Slicing failed.' });
  }
};
