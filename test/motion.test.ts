import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MotionPlanner, trapezoid } from '../src/slicer/motion.ts';

/* The print-time planner, against motion worked out with the equations of
   uniform acceleration: v² = v0² + 2ad and d = v·t for the cruise. */

const near = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);

describe('one move', () => {
  test('100 mm at 50 mm/s with 500 mm/s²: 2 s cruising plus 0.1 s of ramps', () => {
    near(trapezoid(100, 0, 0, 50, 500), 2.1);
  });

  test('too short to reach full speed: a triangle', () => {
    // 1 mm at 500 mm/s²: peak √(500) at the middle, 2·√(1/500) s in total.
    near(trapezoid(1, 0, 0, 100, 500), 2 * Math.sqrt(1 / 500));
  });

  test('entering and leaving at full speed is just distance over speed', () => {
    near(trapezoid(10, 50, 50, 50, 500), 0.2);
  });
});

describe('a sequence of moves', () => {
  const line = (planner: MotionPlanner, d: number, dir: [number, number, number]) => planner.add(d, 50, 500, dir);

  test('two collinear halves take as long as the whole', () => {
    const planner = new MotionPlanner();
    line(planner, 50, [1, 0, 0]);
    line(planner, 50, [1, 0, 0]);
    near(planner.total(), 2.1);
  });

  test('a full reversal stops the nozzle', () => {
    const planner = new MotionPlanner();
    line(planner, 100, [1, 0, 0]);
    line(planner, 100, [-1, 0, 0]);
    near(planner.total(), 4.2);
  });

  test('a circle of short segments is much faster than stopping at each', () => {
    const planner = new MotionPlanner();
    const n = 100;
    const r = 10;
    const chord = 2 * r * Math.sin(Math.PI / n);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * (i + 0.5)) / n + Math.PI / 2;
      line(planner, chord, [Math.cos(a), Math.sin(a), 0]);
    }
    const planned = planner.total();
    const stopping = n * trapezoid(chord, 0, 0, 50, 500);
    assert.ok(planned < stopping / 3, `${planned} vs ${stopping}`);
    // And never faster than cruising the whole circumference.
    assert.ok(planned >= (n * chord) / 50);
  });

  test('a dwell adds its time and brings the head to rest', () => {
    const planner = new MotionPlanner();
    line(planner, 100, [1, 0, 0]);
    planner.stop(5);
    line(planner, 100, [1, 0, 0]);
    near(planner.total(), 2.1 + 5 + 2.1);
  });
});
