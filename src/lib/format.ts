import type { UnitSystem } from '@/types';

const UNIT_FACTOR: Record<UnitSystem, number> = {
  mm: 1,
  cm: 0.1,
  m: 0.001,
  in: 1 / 25.4,
};

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function count(n: number): string {
  return n.toLocaleString('en-US');
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/**
 * Source units are unknown for most formats, so the number is treated as
 * millimetres and converted from there. The status strip says as much.
 */
export function dim(value: number, unit: UnitSystem): string {
  const v = value * UNIT_FACTOR[unit];
  if (v === 0) return `0 ${unit}`;
  // Nudge off the boundary first: 25.4 mm converts to 0.99999… inches, and
  // without this it would print with four decimals instead of two.
  const abs = Math.abs(v) * (1 + Number.EPSILON * 8);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  return `${v.toFixed(digits)} ${unit}`;
}

export function ms(value: number): string {
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

export function shortName(name: string, max = 34): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${name.slice(0, max - ext.length - 1)}…${ext}`;
}
