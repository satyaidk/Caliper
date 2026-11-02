/**
 * How much plastic a line needs. The formulas are the ones both PrusaSlicer and
 * Bambu Studio use (docs/slicer-logic.md, section 15), written out here from
 * the maths rather than from their code.
 *
 * A printed line is modelled as a rectangle with a semicircle on each side:
 * `width` wide overall, `height` tall.
 */

/** 1 − π/4: how much narrower the rounded line is than its bounding rectangle, per unit of height. */
const ROUNDING = 1 - Math.PI / 4;

/** Extra gap between bridge threads, mm, so neighbouring threads do not merge in mid-air. */
export const BRIDGE_EXTRA_SPACING = 0.05;

/** Cross-section of one line, mm². Also mm³ of plastic per mm of travel. */
export function lineArea(width: number, height: number): number {
  const area = height * (width - height * ROUNDING);
  if (!(area > 0)) throw new RangeError(`A ${width} mm wide, ${height} mm tall line has no cross-section.`);
  return area;
}

/** Centre-to-centre distance between neighbouring lines, mm. Rounded sides overlap a little. */
export function lineSpacing(width: number, height: number): number {
  const spacing = width - height * ROUNDING;
  if (!(spacing > 0)) throw new RangeError(`A ${width} mm wide line is too narrow for ${height} mm layers.`);
  return spacing;
}

/** The line width that gives `spacing` at `height`: the inverse of lineSpacing. */
export function widthFromSpacing(spacing: number, height: number): number {
  return spacing + height * ROUNDING;
}

/** A bridge thread hangs in the air, so it is round: the area of a circle `width` across. */
export function bridgeArea(width: number): number {
  return (Math.PI * width * width) / 4;
}

/** Cross-section of the filament itself, mm². 2.405 mm² for 1.75 mm filament. */
export function filamentArea(diameter: number): number {
  return (Math.PI * diameter * diameter) / 4;
}

/** Millimetres of filament to push for each mm³ of plastic. */
export function ePerMm3(filamentDiameter: number, flowRatio: number): number {
  return flowRatio / filamentArea(filamentDiameter);
}

/**
 * The fastest a line may be printed before it asks the hot end for more than
 * it can melt: speed = maximum flow ÷ cross-section.
 */
export function capSpeed(requested: number, area: number, maxFlow: number): number {
  return Math.min(requested, maxFlow / area);
}

/**
 * The line width implied by an extrusion, inverting lineArea. The checker uses
 * it to catch a move that would push out a blob.
 */
export function impliedWidth(volumePerMm: number, height: number): number {
  return volumePerMm / height + height * ROUNDING;
}

/** Line widths for a nozzle, as fractions of its diameter (docs, 15.2). */
export function widthsFor(nozzle: number) {
  return {
    outerWall: round3(nozzle * 1.05),
    innerWall: round3(nozzle * 1.125),
    infill: round3(nozzle * 1.125),
    solid: round3(nozzle * 1.125),
    top: round3(nozzle * 1.05),
    firstLayer: round3(nozzle * 1.25),
    skirt: round3(nozzle * 1.25),
  };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
