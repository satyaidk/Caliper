import { toUnits, type ExPoly } from './clipper';
import { lineSpacing, widthsFor } from './flow';
import { SliceError, writeGcode } from './gcode';
import { generateLayers } from './layers';
import {
  filamentById,
  printerById,
  settingProblems,
  type CustomGcode,
  type FilamentId,
  type ProcessSettings,
} from './profiles';
import { sliceMesh } from './slice';
import { classifySurfaces, overhangs } from './surfaces';
import { planLayer, type LayerPlan } from './toolpaths';
import { makeWalls, type IslandWalls } from './walls';
import { verifyGcode, type Finding, type VerifyReport } from './verify';

/**
 * The whole slicer, from triangles to checked G-code:
 *
 *   layers → slice → walls → surfaces → toolpaths → G-code → verify
 *
 * Pure computation with no DOM and no three.js, so it runs in a Web Worker in
 * the app and in Node's test runner unchanged.
 */

export { SliceError };

export interface SliceInput {
  /** Nine numbers per triangle, mm, Z up, X and Y measured from the centre of the bed. */
  positions: Float32Array;
  models: string[];
  printerId: string;
  filamentId: FilamentId;
  process: ProcessSettings;
  custom: CustomGcode | null;
  generator: string;
}

export interface SliceOutput {
  gcode: string;
  report: VerifyReport;
  layerCount: number;
  /** Time the slicer took, ms. */
  ms: number;
}

export type Progress = (fraction: number, note: string) => void;

const range = (layers: number[]) => {
  if (!layers.length) return '';
  const lo = Math.min(...layers) + 1;
  const hi = Math.max(...layers) + 1;
  return lo === hi ? `layer ${lo}` : `layers ${lo}–${hi}`;
};

export function slicePlate(input: SliceInput, onProgress: Progress = () => {}): SliceOutput {
  const started = Date.now();
  const printer = printerById(input.printerId);
  if (!printer) throw new SliceError('Choose a printer first: slicing needs its bed and limits.');
  const filament = filamentById(input.filamentId);
  const process = input.process;
  const problems = settingProblems(printer, filament, process);
  if (problems.length) throw new SliceError(problems.join(' '));

  /* --- place the plate on the bed and check it fits -------------------- */
  const [bedW, bedD, bedH] = printer.bed;
  const positions = new Float32Array(input.positions.length);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const px = input.positions[i] + bedW / 2;
    const py = input.positions[i + 1] + bedD / 2;
    const pz = input.positions[i + 2];
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz))
      throw new SliceError('The model has corrupt coordinates (not numbers). Repair it before slicing.');
    positions[i] = px;
    positions[i + 1] = py;
    positions[i + 2] = pz;
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    if (pz > maxZ) maxZ = pz;
  }
  if (!positions.length) throw new SliceError('Nothing to slice: the plate is empty or every model is hidden.');
  if (Math.abs(minZ) > 0.05)
    throw new SliceError(`The models do not sit on the bed (lowest point at Z ${minZ.toFixed(2)} mm).`);
  const margin = Math.max(process.skirtLoops > 0 ? process.skirtDistance + 1 : 0, process.brimWidth + 0.5);
  if (minX < margin || minY < margin || maxX > bedW - margin || maxY > bedD - margin)
    throw new SliceError(
      `The models reach outside ${printer.label}'s ${bedW} × ${bedD} mm bed${margin > 0 ? ` once the ${margin.toFixed(0)} mm skirt or brim is added` : ''}. Arrange the plate or move them in.`,
    );
  if (maxZ > bedH) throw new SliceError(`The models are ${maxZ.toFixed(1)} mm tall; ${printer.label} prints up to ${bedH} mm.`);

  /* --- layers and outlines --------------------------------------------- */
  onProgress(0.02, 'Choosing layer heights');
  const specs = generateLayers(maxZ, process.firstLayerHeight, process.layerHeight);
  if (!specs.length) throw new SliceError('The models are too flat to slice.');

  onProgress(0.05, 'Cutting the mesh into layers');
  const { layers: slices, diagnostics } = sliceMesh(
    { positions },
    specs.map((s) => s.sliceZ),
    (f) => onProgress(0.05 + f * 0.35, 'Cutting the mesh into layers'),
  );

  /* --- walls ------------------------------------------------------------ */
  const widths = widthsFor(printer.nozzle);
  const walls: IslandWalls[][] = [];
  const infillAreas: ExPoly[][] = [];
  const thinLayers: number[] = [];
  specs.forEach((spec, i) => {
    if ((i & 7) === 0) onProgress(0.4 + (i / specs.length) * 0.2, 'Making walls');
    const first = i === 0;
    const outer = first ? widths.firstLayer : widths.outerWall;
    const inner = first ? widths.firstLayer : widths.innerWall;
    const infill = first ? widths.firstLayer : widths.infill;
    const islandWalls = slices[i].map((island) =>
      makeWalls(island, process.walls, { outer, inner, infillSpacing: lineSpacing(infill, spec.height) }, spec.height),
    );
    walls.push(islandWalls);
    infillAreas.push(islandWalls.flatMap((w) => w.infillArea));
    if (islandWalls.reduce((sum, w) => sum + w.lostArea, 0) > 0.5) thinLayers.push(i);
  });

  /* --- surfaces ---------------------------------------------------------- */
  onProgress(0.6, 'Finding top and bottom surfaces');
  const surfaces = classifySurfaces(
    slices,
    infillAreas,
    process.topLayers,
    process.bottomLayers,
    toUnits(lineSpacing(widths.infill, process.layerHeight) / 2),
  );
  const overhang = overhangs(
    slices,
    specs.map((s) => s.height),
    process.overhangLimitDeg,
  );

  /* --- toolpaths ------------------------------------------------------- */
  onProgress(0.75, 'Planning toolpaths');
  const state = { position: { X: 0, Y: 0 }, seam: null as { X: number; Y: number } | null };
  const plans: LayerPlan[] = specs.map((spec, i) =>
    planLayer(
      { index: i, z: spec.top, height: spec.height, slices: slices[i], walls: walls[i], surfaces: surfaces[i] },
      {
        outerWall: widths.outerWall,
        innerWall: widths.innerWall,
        infill: widths.infill,
        solid: widths.solid,
        top: widths.top,
        firstLayer: widths.firstLayer,
        skirt: widths.skirt,
        bridge: printer.nozzle,
      },
      process,
      state,
    ),
  );
  // Trailing layers with nothing in them (a model with a needle tip) are dropped.
  while (plans.length && !plans[plans.length - 1].extrusions.length) plans.pop();

  /* --- G-code ------------------------------------------------------------ */
  onProgress(0.85, 'Writing G-code');
  const result = writeGcode(plans, printer, filament, process, input.custom, {
    generator: input.generator,
    models: input.models,
  });

  /* --- verify the text, exactly as it will be sent ----------------------- */
  onProgress(0.93, 'Checking the G-code');
  const report = verifyGcode(result.text, { printer, filament, source: 'caliper' });

  // What the slicer itself noticed, added to what the checker found.
  const extra: Finding[] = [];
  if (diagnostics.openContours.size)
    extra.push({
      code: 'S001',
      severity: 'warning',
      title: 'The mesh has holes',
      detail: `Outlines on ${range([...diagnostics.openContours.keys()])} would not close (${diagnostics.droppedLength.toFixed(1)} mm of edge left out). Repair the mesh, or check those layers in the preview.`,
      layer: Math.min(...diagnostics.openContours.keys()),
      count: diagnostics.openContours.size,
    });
  if (thinLayers.length)
    extra.push({
      code: 'S002',
      severity: 'warning',
      title: 'Features thinner than one line',
      detail: `Parts of ${range(thinLayers)} are narrower than a ${widths.outerWall} mm line and will not print. Thicken them, or use a smaller nozzle.`,
      layer: thinLayers[0],
      count: thinLayers.length,
    });
  const overhangLayers = overhang.flatMap((o, i) => (o.area > 1 ? [i] : []));
  if (overhangLayers.length)
    extra.push({
      code: 'S003',
      severity: 'warning',
      title: 'Overhangs that need support',
      detail: `On ${range(overhangLayers)} the part reaches out more than ${process.overhangLimitDeg}° from vertical. Caliper does not generate support yet: turn the part (lay on face, auto orient), or slice it elsewhere with support.`,
      layer: overhangLayers[0],
      count: overhangLayers.length,
    });
  const floatingLayers = overhang.flatMap((o, i) => (o.floating > 0 ? [i] : []));
  if (floatingLayers.length)
    extra.push({
      code: 'S004',
      severity: 'error',
      title: 'Parts that start in mid-air',
      detail: `On ${range(floatingLayers)} part of the model begins with nothing under it. It would be printed onto air, drag around as loose plastic and can wrap the nozzle. Turn the part so everything grows from the bed.`,
      layer: floatingLayers[0],
      count: floatingLayers.length,
    });
  if (filament.needsEnclosure)
    extra.push({
      code: 'S005',
      severity: 'warning',
      title: `${filament.label} needs an enclosure`,
      detail: `${filament.label} warps and gives off fumes; print it in an enclosed, ventilated printer.`,
      count: 1,
    });
  if (printer.notes.length)
    extra.push({ code: 'S010', severity: 'info', title: `About ${printer.label}`, detail: printer.notes.join(' '), count: 1 });

  const findings = [...extra, ...report.findings].sort(
    (a, b) => ['error', 'warning', 'info'].indexOf(a.severity) - ['error', 'warning', 'info'].indexOf(b.severity),
  );
  onProgress(1, 'Done');
  return {
    gcode: result.text,
    report: { ...report, ok: !findings.some((f) => f.severity === 'error'), findings },
    layerCount: plans.length,
    ms: Date.now() - started,
  };
}
