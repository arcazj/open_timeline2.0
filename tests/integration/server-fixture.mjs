import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function startServer() {
  const directory = await mkdtemp(path.join(tmpdir(), 'openbexi-test-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const token = 'test-only-token-not-a-production-secret';
  const executable = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let child, exit, output = '';
  function launch() {
    child = spawn(executable, ['-m', 'uvicorn', 'server.app.main:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: root, windowsHide: true,
      env: { ...process.env, OPENBEXI_DATA_ROOT: directory, OPENBEXI_API_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    exit = once(child, 'exit');
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  async function pause() {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exit; }
  }
  async function stop() {
    await pause();
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('openbexi-test-')) {
      await rm(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    }
  }
  async function ready() {
    // Cold JSON recovery on Windows can exceed the old 12-second polling budget.
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Python service exited: ${output}`);
      try { if ((await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(250) })).ok) return; }
      catch { /* Wait for ASGI startup, not for an arbitrary fixed server delay. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Python service did not become healthy: ${output}`);
  }
  async function restart() { await pause(); launch(); await ready(); }
  try {
    launch(); await ready();
    return { baseUrl, token, directory, stop, pause, restart, logs: () => output };
  } catch (error) { await stop(); throw error; }
}
