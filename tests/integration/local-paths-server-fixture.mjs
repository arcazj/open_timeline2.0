import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';

export async function startLocalPathsServer({ deferStartup = false, deferIndex = false, archiveDays = 1 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'openbexi-path-test-'));
  const root = path.resolve('.'), legacy = path.join(directory, 'legacy'), authority = path.join(directory, 'data');
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  await mkdir(legacy);
  await writeFile(path.join(legacy, 'model.json'), await readFile(path.join(root, 'tests/client/fixtures/legacy-test-regular.json')));
  const originals = new Map();
  for (const namespace of ['SOURCE1', 'SOURCE2', 'SOURCE3']) {
    for (let index = 0; index < archiveDays; index++) {
    const day = new Date(Date.UTC(2024, 2, 18 - index)).toISOString().slice(0, 10), suffix = index ? `-${index}` : '';
    const file = path.join(authority, namespace, `${day.replaceAll('-', '/')}/events.json`); await mkdir(path.dirname(file), { recursive: true });
    const events = [
      { id: 'session', start: '2024-03-18T19:45:00Z', end: '2024-03-18T20:15:00Z', data: { title: `${namespace} session`, namespace }, render: { color: '#3e9e56' } },
      { id: 'event', start: '2024-03-18T20:05:00Z', data: { title: `${namespace} event`, namespace }, render: { color: '#b45d32' } },
      { id: 'zone', zone: true, start: '2024-03-18T19:50:00Z', end: '2024-03-18T20:10:00Z', data: { title: `${namespace} zone`, namespace }, render: { color: '#d9a838' } },
    ];
    for (const event of events) { event.id += suffix; event.start = event.start.replace('2024-03-18', day); if (event.end) event.end = event.end.replace('2024-03-18', day); }
    if (index === archiveDays - 1 && archiveDays > 1 && namespace === 'SOURCE1') events.push({ id: 'earlier-session', start: `${day}T12:00:00Z`, end: '2024-03-18T21:00:00Z', data: { title: 'Earlier crossing session', namespace } });
    const text = JSON.stringify({ events }); await writeFile(file, text); originals.set(file, text);
    }
  }
  const config = path.join(directory, 'sources.yml');
  await writeFile(config, 'data_sources:\n' + ['SOURCE1', 'SOURCE2', 'SOURCE3'].map(namespace => `- namespace: ${namespace}\n  type: json_file\n  enable: true\n  data_model: /data/${namespace}/yyyy/mm/dd\n  render: {color: '${namespace === 'SOURCE1' ? '#dceef0' : '#ecedda'}', textColor: '#142c31', dateColor: '#142c31'}\n`).join(''));
  const gate = path.join(directory, 'startup-gate'), started = performance.now();
  const entry = deferStartup ? ['tests/integration/delayed-legacy-server.py', gate] : deferIndex ? ['tests/integration/lazy-legacy-server.py', gate] : ['scripts/serve-legacy.py'];
  const child = spawn(path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), [
    ...entry, '--source-yaml', config, '--legacy-root', legacy, '--allow-root', authority,
    '--path-map', `/data=${authority}`, '--model', 'model.json', '--local-browser', '--port', String(port), '--state-root', path.join(directory, 'state'),
  ], { cwd: root, windowsHide: true, env: { ...process.env, OPENBEXI_CORS_ORIGINS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const exited = once(child, 'exit'), baseUrl = `http://127.0.0.1:${port}`;
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    for (const [file, text] of originals) if (await readFile(file, 'utf8') !== text) throw new Error('Legacy source changed');
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('openbexi-path-test-')) await rm(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
  try {
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        const response = await fetch(`${baseUrl}${deferStartup ? '/' : '/health/ready'}`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          await response.arrayBuffer();
          return { baseUrl, stop, urlAvailableMs: performance.now() - started,
            releaseIndex: () => writeFile(gate, 'ready'),
            releaseStartup: (fail = false) => writeFile(gate, fail ? 'fail' : 'ready') };
        }
      } catch { /* Startup is bounded. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Local server did not start: ${output}`);
  } catch (error) { await stop(); throw error; }
}
