/**
 * The colours offered in the Filament section. Green comes first and is the
 * default: it is the colour a part wears in Bambu Studio out of the box, and
 * it stands clear of the canvas in both themes, where a light grey part
 * disappears into the light theme's grey plate.
 */
export const FILAMENTS: { name: string; hex: string }[] = [
  { name: 'Green', hex: '#00ae42' },
  { name: 'Light grey', hex: '#c8ccd2' },
  { name: 'White', hex: '#f1f1ec' },
  { name: 'Charcoal', hex: '#3b3e44' },
  { name: 'Orange', hex: '#ff6a13' },
  { name: 'Red', hex: '#c8312a' },
  { name: 'Yellow', hex: '#f2cf3c' },
  { name: 'Blue', hex: '#1663c7' },
  { name: 'Cyan', hex: '#1fa3c9' },
  { name: 'Purple', hex: '#6d4bc4' },
  { name: 'Pink', hex: '#ef80b0' },
  { name: 'Brown', hex: '#8a5a3c' },
];

/**
 * The order colours are handed to models as they join the plate: strong hues
 * that are far apart first, the neutrals last. Two models side by side should
 * never arrive in green and cyan when orange and blue are free.
 */
const AUTO_ORDER = [
  '#00ae42',
  '#ff6a13',
  '#1663c7',
  '#f2cf3c',
  '#6d4bc4',
  '#1fa3c9',
  '#c8312a',
  '#ef80b0',
  '#8a5a3c',
  '#c8ccd2',
  '#3b3e44',
  '#f1f1ec',
];

/**
 * The colour for the next model. The first model wears `preferred`, the colour
 * the person last chose; later ones take the first palette colour nobody on
 * the plate is wearing, and cycle once all twelve are in use.
 */
export function nextColour(inUse: string[], preferred: string): string {
  const used = new Set(inUse.map((c) => c.toLowerCase()));
  if (!used.has(preferred.toLowerCase())) return preferred;
  const free = AUTO_ORDER.find((c) => !used.has(c));
  return free ?? AUTO_ORDER[inUse.length % AUTO_ORDER.length];
}

export function colourName(hex: string): string {
  return FILAMENTS.find((f) => f.hex.toLowerCase() === hex.toLowerCase())?.name ?? 'Custom';
}
