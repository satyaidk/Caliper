/**
 * Where each layer starts and ends (docs/slicer-logic.md, section 7).
 *
 * Every layer is cut at its middle height (`sliceZ`), because one layer of
 * plastic stands for the whole slab between its bottom and its top. The loop
 * mirrors the slicers': keep adding layers while a cut at the middle of the
 * next one would still be inside the object.
 */

export interface LayerSpec {
  index: number;
  /** Bottom of the layer, mm. */
  bottom: number;
  /** Top of the layer, mm: the nozzle height while printing it. */
  top: number;
  height: number;
  /** Where the mesh is cut for this layer: halfway up. */
  sliceZ: number;
}

export function generateLayers(objectHeight: number, firstLayerHeight: number, layerHeight: number): LayerSpec[] {
  if (!(objectHeight > 0) || !(firstLayerHeight > 0) || !(layerHeight > 0)) return [];
  const layers: LayerSpec[] = [];
  const push = (bottom: number, top: number) =>
    layers.push({ index: layers.length, bottom, top, height: top - bottom, sliceZ: (bottom + top) / 2 });

  push(0, firstLayerHeight);
  let printZ = firstLayerHeight;
  // Accumulated floating-point error over hundreds of layers would make the
  // 300th layer 0.2000000004 thick; snapping to a micrometre keeps them honest.
  const snap = (z: number) => Math.round(z * 1e6) / 1e6;
  while (printZ + layerHeight / 2 < objectHeight) {
    const top = snap(printZ + layerHeight);
    push(printZ, top);
    printZ = top;
  }
  return layers;
}
