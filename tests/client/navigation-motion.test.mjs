import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationMotion } from '../../client/src/timeline/navigation-motion.js';

function harness(reduced = false) {
  let time = 0, id = 0; const callbacks = new Map(), previews = [], settlements = [];
  const motion = createNavigationMotion({ now: () => time, reducedMotion: () => reduced,
    frame(callback) { callbacks.set(++id, callback); return id; }, cancelFrame: key => callbacks.delete(key),
    preview: value => previews.push(value), settle: result => settlements.push(result) });
  const project = offset => ({ offset: Math.max(-500, Math.min(500, offset)), range: { fromMs: String(1000 - Math.max(-500, Math.min(500, offset))) } });
  return { motion, previews, settlements, project, advance(ms = 16) { time += ms; const batch = [...callbacks.values()]; callbacks.clear(); batch.forEach(callback => callback(time)); }, setTime(value) { time = value; }, get queued() { return callbacks.size; } };
}

test('pointer bursts coalesce into one frame and never settle while held', () => {
  const h = harness(); h.motion.begin({}, h.project);
  for (let i = 1; i <= 100; i++) h.motion.move(i);
  assert.equal(h.queued, 1); assert.equal(h.previews.length, 0);
  h.advance(); assert.equal(h.previews.length, 1); assert.equal(h.previews[0].offset, 100);
  assert.equal(h.settlements.length, 0);
});

test('coast uses recent pointer velocity, keeps finite travel, and settles exactly once', async () => {
  const h = harness(); const context = Object.freeze({ mapId: 'frozen-map' }); h.motion.begin(context, h.project);
  h.setTime(20); h.motion.move(20); h.advance(20); h.motion.move(60); h.motion.release();
  assert.equal(h.motion.phase, 'coasting');
  for (let i = 0; i < 60; i++) h.advance();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.settlements.length, 1); assert.ok(h.settlements[0].offset > 60);
  assert.ok(h.settlements[0].offset > 300 && h.settlements[0].offset <= 500); assert.equal(h.queued, 0);
});

test('paused pointer does not coast from an old displacement', async () => {
  const h = harness(); h.motion.begin({}, h.project); h.setTime(20); h.motion.move(150); h.advance(200); h.motion.release();
  await Promise.resolve(); assert.equal(h.settlements[0].offset, 150); assert.equal(h.queued, 0);
});

for (const direction of [-1, 1]) test(`long momentum travels past the old 240px cap and click-stop commits the visible position (${direction})`, async () => {
  const h = harness();
  h.motion.begin({ width: 1600 }, offset => ({ offset }));
  h.setTime(20); h.motion.move(direction * 60); h.setTime(40); h.motion.move(direction * 140); h.motion.release();
  h.advance(300);
  const stopped = h.motion.offset;
  assert.ok(Math.abs(stopped) > 600); assert.equal(h.motion.phase, 'coasting');
  h.motion.stop(); h.motion.stop(); h.advance(5000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.settlements.length, 1); assert.equal(h.settlements[0].offset, stopped); assert.equal(h.queued, 0);
});

test('coasting is frame-rate independent and ends with no residual animation', async () => {
  const results = [];
  for (const step of [8, 16, 33]) {
    const h = harness(); h.motion.begin({ width: 390 }, offset => ({ offset }));
    h.setTime(20); h.motion.move(200); h.setTime(40); h.motion.move(400); h.motion.release();
    h.advance(600); results.push(h.motion.offset);
    for (let i = 0; i < Math.ceil(4100 / step); i++) h.advance(step);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.settlements.length, 1); assert.ok(h.settlements[0].offset <= 400 + 390 * 4); assert.equal(h.queued, 0);
  }
  assert.equal(new Set(results).size, 1);
});

test('domain overshoot is elastic only visually and settles within its bound', async () => {
  const h = harness(); h.motion.begin({}, h.project); h.setTime(20); h.motion.move(5000); h.advance();
  assert.ok(h.previews.at(-1).offset > 500 && h.previews.at(-1).offset <= 532);
  assert.equal(h.previews.at(-1).range.fromMs, '500'); h.motion.release(); h.advance();
  await Promise.resolve(); assert.equal(h.settlements[0].offset, 500);
});

test('reduced motion disables elastic displacement and inertia', async () => {
  const h = harness(true); h.motion.begin({}, h.project); h.setTime(20); h.motion.move(600); h.advance(); h.motion.release();
  await Promise.resolve(); assert.equal(h.settlements[0].offset, 500);
  assert.ok(h.previews.every(value => value.offset === value.constrainedOffset)); assert.equal(h.queued, 0);
});

test('cancel drops queued frames and never commits a canceled gesture', async () => {
  const h = harness(); h.motion.begin({}, h.project); h.motion.move(50); h.motion.cancel(); h.advance();
  await Promise.resolve(); assert.equal(h.queued, 0); assert.deepEqual(h.previews, [null]); assert.equal(h.settlements.length, 0);
});

test('new gesture interrupts inertia without committing the superseded gesture', async () => {
  const h = harness(); h.motion.begin({}, h.project); h.setTime(20); h.motion.move(60); h.motion.release();
  h.advance(); h.motion.begin({}, h.project, 70); h.setTime(250); h.motion.move(90); h.advance(); h.motion.release();
  await Promise.resolve(); assert.equal(h.settlements.length, 1); assert.equal(h.settlements[0].offset, 90);
});

test('cancel after release but before settlement microtask prevents the commit', async () => {
  const h = harness(true); h.motion.begin({}, h.project); h.motion.move(50); h.motion.release();
  assert.equal(h.motion.phase, 'settling'); h.motion.cancel();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.settlements.length, 0); assert.equal(h.motion.phase, 'idle');
});

test('a new gesture supersedes a queued settlement without committing old data', async () => {
  const h = harness(true); h.motion.begin({}, h.project); h.motion.move(50); h.motion.release();
  h.motion.begin({}, h.project); h.motion.move(80); h.motion.release();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(h.settlements.map(value => value.offset), [80]);
});

for (const stage of ['release', 'coasting', 'settling']) test(`preview may cancel during ${stage} without throwing or committing`, async () => {
  let motion, callback, time = 0, enabled = false, commits = 0;
  motion = createNavigationMotion({ now: () => time, reducedMotion: () => stage === 'settling',
    frame: value => { callback = value; return 1; }, cancelFrame: () => { callback = undefined; },
    preview: value => { if (enabled && value) motion.cancel(); }, settle: () => { commits++; } });
  motion.begin({}, offset => ({ offset })); time = 20; motion.move(60);
  if (stage === 'release') enabled = true;
  if (stage === 'settling') {
    let previews = 0;
    motion.cancel();
    motion = createNavigationMotion({ reducedMotion: () => true,
      preview: value => { if (value && ++previews === 2) motion.cancel(); }, settle: () => { commits++; },
      frame: () => 1, cancelFrame: () => {} });
    motion.begin({}, offset => ({ offset })); motion.move(60);
  }
  assert.doesNotThrow(() => motion.release());
  if (stage === 'coasting') { enabled = true; time = 40; assert.doesNotThrow(() => callback(time)); }
  await Promise.resolve(); await Promise.resolve();
  assert.equal(commits, 0); assert.equal(motion.phase, 'idle');
});
