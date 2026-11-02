/**
 * Print-time estimate the way a printer's firmware moves: a look-ahead
 * trapezoid planner.
 *
 * Each move speeds up at the machine's acceleration, cruises, and slows down.
 * Between moves it does not stop: it slows only as much as the corner needs.
 * The corner speed comes from Marlin's "junction deviation" model, where a
 * straight continuation keeps full speed and a sharp reversal stops:
 *
 *   s = sin(θ / 2), θ = angle between the reversed incoming and the outgoing direction
 *   v = √( a · δ · s / (1 − s) ),  δ = 0.013 mm (Marlin's default)
 *
 * Then two passes make every move reachable: no move may need to speed up or
 * slow down faster than the acceleration allows over its own length.
 *
 * Treating every move as starting and ending at rest, as a first estimate
 * might, makes a circle of 100 short segments stop 100 times and overstates
 * the time several-fold.
 */

const JUNCTION_DEVIATION = 0.013;

export class MotionPlanner {
  private dist: number[] = [];
  private vmax: number[] = [];
  private accel: number[] = [];
  private dir: number[] = [];
  private seconds = 0;

  /** A move of `distance` mm at up to `speed` mm/s along `direction` (unit vector, or zeros for extruder-only). */
  add(distance: number, speed: number, accel: number, direction: [number, number, number]) {
    if (!(distance > 0) || !(speed > 0)) return;
    this.dist.push(distance);
    this.vmax.push(speed);
    this.accel.push(accel > 0 ? accel : 1e9);
    this.dir.push(...direction);
  }

  /** The machine comes to rest: a dwell, a heater wait, homing. Plans what is queued. */
  stop(extraSeconds = 0) {
    this.flush();
    this.seconds += extraSeconds;
  }

  total(): number {
    this.flush();
    return this.seconds;
  }

  private junction(i: number): number {
    // Corner between move i−1 and move i.
    const a = (i - 1) * 3;
    const b = i * 3;
    const ax = this.dir[a];
    const ay = this.dir[a + 1];
    const az = this.dir[a + 2];
    const bx = this.dir[b];
    const by = this.dir[b + 1];
    const bz = this.dir[b + 2];
    if ((ax === 0 && ay === 0 && az === 0) || (bx === 0 && by === 0 && bz === 0)) return 0;
    const cos = -(ax * bx + ay * by + az * bz); // angle between reversed incoming and outgoing
    const limit = Math.min(this.vmax[i - 1], this.vmax[i]);
    if (cos <= -0.999999) return limit; // straight on
    if (cos >= 0.999999) return 0; // full reversal
    const s = Math.sqrt((1 - cos) / 2);
    const accel = Math.min(this.accel[i - 1], this.accel[i]);
    return Math.min(limit, Math.sqrt((accel * JUNCTION_DEVIATION * s) / (1 - s)));
  }

  private flush() {
    const n = this.dist.length;
    if (!n) return;
    const entry = new Float64Array(n + 1); // entry[n] is the exit of the last move: rest
    for (let i = 1; i < n; i++) entry[i] = this.junction(i);
    // Backward: each move must be able to slow to the next entry speed.
    for (let i = n - 1; i >= 0; i--)
      entry[i] = Math.min(entry[i], Math.sqrt(entry[i + 1] ** 2 + 2 * this.accel[i] * this.dist[i]));
    // Forward: and to speed up to it from its own entry.
    entry[0] = 0;
    for (let i = 0; i < n; i++)
      entry[i + 1] = Math.min(entry[i + 1], Math.sqrt(entry[i] ** 2 + 2 * this.accel[i] * this.dist[i]));

    for (let i = 0; i < n; i++) this.seconds += trapezoid(this.dist[i], entry[i], entry[i + 1], this.vmax[i], this.accel[i]);
    this.dist = [];
    this.vmax = [];
    this.accel = [];
    this.dir = [];
  }
}

/** Time to cover `d` starting at `v0`, ending at `v1`, cruising at most `v`, with acceleration `a`. */
export function trapezoid(d: number, v0: number, v1: number, v: number, a: number): number {
  const up = (v * v - v0 * v0) / (2 * a);
  const down = (v * v - v1 * v1) / (2 * a);
  if (up + down <= d) return (v - v0) / a + (v - v1) / a + (d - up - down) / v;
  // Never reaches cruising speed: a triangle with its peak where the ramps meet.
  const peak = Math.sqrt(Math.max(0, (2 * a * d + v0 * v0 + v1 * v1) / 2));
  return Math.max(0, (peak - v0) / a) + Math.max(0, (peak - v1) / a);
}
