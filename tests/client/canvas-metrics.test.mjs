import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasMetrics } from '../helpers/canvas-metrics.mjs';

function canvas(width, height, colorAt) {
  return { width, height, getContext: () => ({
    RGBA: 6408, UNSIGNED_BYTE: 5121,
    readPixels: (_x, _y, _width, _height, _format, _type, output) => {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) output.set([...colorAt(x, y), 255], (y * width + x) * 4);
    },
  }) };
}

test('blank canvas has no detail pixels', () => {
  assert.deepEqual(canvasMetrics(canvas(12, 8, () => [238, 238, 238])), { colors: 1, detailPixels: 0 });
});

test('a many-color vertical grid and zones alone do not count as records', () => {
  const result = canvasMetrics(canvas(12, 8, x => [x * 20, 100, 180]));
  assert.equal(result.colors, 12);
  assert.equal(result.detailPixels, 0);
});

test('solid bars are detected without antialiasing or extra palette colors', () => {
  const result = canvasMetrics(canvas(12, 8, (x, y) => x >= 2 && x < 7 && y >= 3 && y < 5 ? [100, 150, 220] : [238, 238, 238]));
  assert.deepEqual(result, { colors: 2, detailPixels: 10 });
});

test('missing WebGL2 is a verification failure', () => {
  assert.throws(() => canvasMetrics({ getContext: () => null }), /WebGL2 context is required/);
});
