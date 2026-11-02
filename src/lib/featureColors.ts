import type { Feature } from './toolpath';

/**
 * Preview colours per toolpath feature, close to Bambu Studio's G-code viewer
 * so a preview reads the same in both. Shared by the worker (which bakes
 * vertex colours), the G-code file preview and the legend.
 */
export const FEATURE_COLORS: Readonly<Record<Feature, string>> = {
  'Outer wall': '#FF8A1F',
  'Inner wall': '#FFD34E',
  'Sparse infill': '#B8323A',
  'Internal solid infill': '#9B5DE5',
  'Top surface': '#F2545B',
  'Bottom surface': '#6E9B5A',
  Bridge: '#4D8FD6',
  Support: '#3FC56B',
  'Support interface': '#1F8F4E',
  Skirt: '#59D1C6',
  Brim: '#59D1C6',
};

/** Features other slicers write that Caliper does not generate itself. */
const OTHER_FEATURE_COLORS: Readonly<Record<string, string>> = {
  'Overhang wall': '#3D6FE0',
  'Gap infill': '#E8E8E8',
  'Floating vertical shell': '#C77DFF',
  'Prime tower': '#7A8A99',
  'Wipe tower': '#7A8A99',
  'Support transition': '#2E9E5B',
  Ironing: '#FF9EC4',
  Custom: '#8C8C8C',
};

const FALLBACK = '#A0A4A8';

/** Order the legend lists features in: Caliper's print order, then the rest. */
export const LEGEND_ORDER: readonly string[] = [
  'Skirt',
  'Brim',
  'Support',
  'Support interface',
  'Support transition',
  'Inner wall',
  'Outer wall',
  'Overhang wall',
  'Bridge',
  'Bottom surface',
  'Internal solid infill',
  'Floating vertical shell',
  'Sparse infill',
  'Gap infill',
  'Top surface',
  'Ironing',
  'Prime tower',
  'Wipe tower',
  'Custom',
];

export function featureColor(feature: string): string {
  return (FEATURE_COLORS as Record<string, string>)[feature] ?? OTHER_FEATURE_COLORS[feature] ?? FALLBACK;
}

export function featureRgb(feature: string): [number, number, number] {
  const hex = featureColor(feature);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** Sorts feature names into legend order; unknown names go last, alphabetically. */
export function legendOrder(features: readonly string[]): string[] {
  return [...features].sort((a, b) => {
    const ia = LEGEND_ORDER.indexOf(a);
    const ib = LEGEND_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
}
