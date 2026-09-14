import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const legacyDomain = { from: '2024-03-01T00:00:00.000Z', to: '2024-03-02T00:00:00.000Z' };

export async function startLegacyServer() {
  const directory = await mkdtemp(path.join(tmpdir(), 'openbexi-legacy-parity-'));
  const legacy = path.join(directory, 'legacy'), authority = path.join(directory, 'authority');
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const token = 'legacy-parity-test-token-not-for-production';
  const executable = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let child, exit, output = '';
  async function events(source, day, items) {
    const filename = path.join(authority, source, day, 'events.json');
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, JSON.stringify({ dateTimeFormat: 'iso8601', events: items }));
    return filename;
  }
  const record = (id, start, title, extra = {}) => ({ id, start, data: { title }, ...extra });
  const files = [];
  await mkdir(legacy);
  files.push(await events('alpha', '2023/12/31', [
    record('long', '2023-12-31T00:00:00Z', 'Cross-year session Match_5_1', { end: '2024-04-01T00:00:00Z' }),
    record('old', '2023-12-31T01:00:00Z', 'Outside-domain old point'),
  ]));
  files.push(await events('beta', '2024/01/01', [
    record('parent', '2024-01-01T00:00:00Z', 'Parent session', { end: '2024-04-01T00:00:00Z', activities: [
      record('child-a', '2024-03-01T12:00:00Z', 'Child Match_5_1'),
      record('child-b', '2024-03-01T13:00:00Z', 'Child other'),
      record('old-child', '2024-01-02T00:00:00Z', 'Outside-domain child'),
    ] }),
  ]));
  files.push(await events('alpha', '2024/03/01', [
    ...Array.from({ length: 18 }, (_, index) => record(`crowd-${index}`, '2024-03-01T12:00:00Z',
      `${index % 3 ? 'Other' : 'Match_5_1'} clustered item ${index}`)),
    record('at-start', legacyDomain.from, 'Included start boundary'),
    record('at-end', legacyDomain.to, 'Excluded end boundary'),
    record('zero', '2024-03-01T12:00:00Z', 'Zero duration session', { end: '2024-03-01T12:00:00Z' }),
    record('zone-a', '2024-03-01T11:00:00Z', 'Alpha zone', { end: '2024-03-01T14:00:00Z', zone: true, render: { color: '#CC8844' } }),
  ]));
  files.push(await events('beta', '2024/03/01', [
    record('ongoing', '2024-03-01T10:00:00Z', 'Ongoing Match_5_1', { kind: 'session', end: null }),
    record('zone-b', '2024-03-01T11:30:00Z', 'Beta zone', { end: '2024-03-01T15:00:00Z', zone: true, render: { color: '#66AA99' } }),
  ]));
  const yaml = path.join(legacy, 'sources.yml'), model = path.join(legacy, 'model.json');
  await writeFile(yaml, 'data_sources:\n' + ['alpha', 'beta'].map((source, index) =>
    `- namespace: ${source}\n  type: json_file\n  enable: true\n  data_path: /archive\n  data_model: /archive/${source}/yyyy/mm/dd\n  render:\n    color: '${index ? '#E7EDDA' : '#D9EDF2'}'\n`).join(''));
  await writeFile(model, await readFile(path.join(root, 'tests/client/fixtures/legacy-test-regular.json')));
  files.push(yaml, model);
  const originals = new Map(await Promise.all(files.map(async filename => [filename, await readFile(filename)])));
  const baseUrl = `http://127.0.0.1:${port}`;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await exit; }
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('openbexi-legacy-parity-')) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    }
  }
  try {
    child = spawn(executable, ['scripts/serve-legacy.py', '--source-yaml', yaml, '--legacy-root', legacy,
      '--allow-root', authority, '--path-map', `/archive=${authority}`, '--model', model,
      '--namespace-grouping', '--state-root', path.join(directory, 'state'), '--port', String(port)], {
      cwd: root, windowsHide: true, env: { ...process.env, OPENBEXI_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', value => { output = (output + value).slice(-32000); });
    child.stderr.on('data', value => { output = (output + value).slice(-32000); });
    exit = once(child, 'exit');
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`Legacy Python fixture exited: ${output}`);
      try {
        if ((await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(250) })).ok) {
          return { baseUrl, token, directory, stop, originals, logs: () => output };
        }
      } catch { /* Await bounded ASGI readiness. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Legacy Python fixture did not become ready: ${output}`);
  } catch (error) { await stop(); throw error; }
}
