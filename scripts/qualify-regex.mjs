import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, firefox } from '@playwright/test';

const root = process.cwd(), output = path.resolve('artifacts/regex-qualification');
await mkdir(output, { recursive: true });
const fixture = await readFile('shared/fixtures/regex-cases.json'), cases = JSON.parse(fixture).cases;
const worker = await build({ stdin: { contents: `
import { compileRegex } from './client/src/data/safe-regex.js';
import corpus from './shared/fixtures/regex-cases.json';
onmessage = ({ data }) => {
  if (data === 'cancel') { postMessage({ started: true }); const regex = compileRegex('(a+)+$'); for (let i=0; i<1000000; i++) regex.test('a'.repeat(1024)); return; }
  const start = performance.now();
  const results = corpus.cases.map(item => {
    try { const compiled = compileRegex(item.pattern, { flags: item.flags, matchMode: item.matchMode }); return { id:item.id, values:item.subjects.map(value => compiled.test(value)) }; }
    catch (error) { return { id:item.id, error:error.code, offset:error.diagnostic?.offset ?? null }; }
  });
  postMessage({ results, engineMilliseconds: performance.now()-start });
};`, resolveDir: root, sourcefile: 'regex-qualification-worker.js' }, bundle: true, minify: true, format: 'iife', platform: 'browser', write: false });
const workerSource = worker.outputFiles[0].text;
const pageFile = path.join(output, 'index.html');
await writeFile(pageFile, `<!doctype html><meta charset="utf-8"><title>Regex qualification</title><script>
const source=${JSON.stringify(workerSource).replace(/</g, '\\u003c')};
window.runRegex = () => new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));const worker=new Worker(url);worker.onmessage=({data})=>{worker.terminate();URL.revokeObjectURL(url);resolve(data)};worker.onerror=reject;worker.postMessage('run')});
window.cancelRegex = () => new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));const worker=new Worker(url);const started=performance.now();worker.onmessage=()=>{worker.terminate();URL.revokeObjectURL(url);resolve({terminated:true,milliseconds:performance.now()-started})};worker.onerror=reject;worker.postMessage('cancel')});
</script>`);
const expected = cases.map(item => item.error ? { id: item.id, error: item.error, offset: item.offset } : { id: item.id, values: item.expected });
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const probe = spawnSync(python, ['-c', `import json
from server.app.services.safe_regex import compile_regex
from server.app.models.domain import DomainError
items=json.load(open('shared/fixtures/regex-cases.json'))['cases']; results=[]
for item in items:
 try:
  compiled=compile_regex(item['pattern'],flags=item.get('flags',[]),match_mode=item.get('matchMode','search'))
  results.append({'id':item['id'],'values':[compiled['test'](value) for value in item['subjects']]})
 except DomainError as error: results.append({'id':item['id'],'error':error.code,'offset':error.diagnostic['offset']})
print(json.dumps(results))`], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
assert.equal(probe.status, 0, probe.stderr);
assert.deepEqual(JSON.parse(probe.stdout), expected);
const report = { fixtureSha256: createHash('sha256').update(fixture).digest('hex'), cases: cases.length, platform: process.platform, node: process.version, workerBytes: Buffer.byteLength(workerSource), python: { passed: cases.length }, browsers: [] };
for (const [name, engine] of [['chromium', chromium], ['firefox', firefox]]) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage(), requests = [];
    page.on('request', request => { if (/^(https?|wss?):/.test(request.url())) requests.push(request.url()); });
    await page.goto(pathToFileURL(pageFile).href);
    const result = await page.evaluate(() => window.runRegex());
    assert.deepEqual(result.results, expected);
    const cancellation = await page.evaluate(() => window.cancelRegex());
    assert.equal(cancellation.terminated, true); assert.ok(cancellation.milliseconds < 5000);
    assert.deepEqual(requests, []);
    report.browsers.push({ name, version: browser.version(), passed: cases.length, engineMilliseconds: result.engineMilliseconds, cancellation, networkRequests: requests.length });
  } finally { await browser.close(); }
}
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
