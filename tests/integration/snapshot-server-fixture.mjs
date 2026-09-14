import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';

export async function startSnapshotServer(id, { localBrowser = false } = {}) {
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error('Invalid fixture ID');
  const directory = await mkdtemp(path.join(tmpdir(), 'openbexi-snapshot-test-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const root = path.resolve('.'), profile = path.join(directory,'server.yml'), token = 'fixture-only-token-not-production';
  await writeFile(profile, JSON.stringify({version:1,server:{host:'127.0.0.1',port,local_browser:localBrowser,state_root:path.join(directory,'state')},snapshot:{file:path.join(root,`data/${id}.json`)}}));
  const child = spawn(path.join(root,'.venv',process.platform === 'win32' ? 'Scripts/python.exe':'bin/python'),['scripts/serve-legacy.py','--yaml',profile],{cwd:root,windowsHide:true,env:{...process.env,OPENBEXI_API_TOKEN:token,OPENBEXI_CORS_ORIGINS:''},stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',data=>output+=data); child.stderr.on('data',data=>output+=data);
  const exit=once(child,'exit'), baseUrl=`http://127.0.0.1:${port}`;
  async function stop(){
    if(child.exitCode === null && child.signalCode === null){child.kill();await exit;}
    const resolved=path.resolve(directory);
    if(path.dirname(resolved)===path.resolve(tmpdir()) && path.basename(resolved).startsWith('openbexi-snapshot-test-')) await rm(resolved,{recursive:true,force:true,maxRetries:12,retryDelay:100});
  }
  try {
    for(let i=0;i<120;i++){
      if(child.exitCode!==null)throw new Error(output);
      try {if((await fetch(`${baseUrl}/health/ready`,{signal:AbortSignal.timeout(500)})).ok) return {baseUrl,token,stop,logs:()=>output};}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error(`Snapshot fixture failed to start: ${output}`);
  }catch(error){await stop();throw error;}
}
