import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startSnapshotServer } from './snapshot-server-fixture.mjs';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';

for(const id of ['jfk','monet','religions']) test(`${id} Python/file providers match reference maps, uncertainty and row packing`,async()=>{
  const server=await startSnapshotServer(id), local=new LocalProvider(JSON.parse(await readFile(`data/${id}.json`,'utf8'))), remote=new ServerProvider({baseUrl:server.baseUrl,token:server.token});
  try{
    const info=await local.initialize(); await remote.initialize();
    const primary=info.settings.presentation.bandLayout.find(b=>b.role==='primary');
    const request={domain:info.settings.overview,scaleMode:'uniform',...(primary.fixedScale ? {fixedScale:primary.fixedScale}: {})};
    const a=await local.createQuery(request),b=await remote.createQuery(request);
    const am=await local.getMap(a.queryId,a.mapId),bm=await remote.getMap(b.queryId,b.mapId);
    assert.deepEqual(am.knots,bm.knots);
    const input={...info.settings.range,width:1800,availableHeight:300,rowHeight:32,fontSize:11,presentation:info.settings.presentation};
    const al=await local.createLayout(a.queryId,{...input,mapId:a.mapId}),bl=await remote.createLayout(b.queryId,{...input,mapId:b.mapId});
    for(const key of ['totalRows','detailTotal','rowHeight','pageCapacity'])assert.equal(al[key],bl[key],key);
    let ac,bc;
    do{
      const ap=await local.getRows(a.queryId,al.layoutId,{cursor:ac}),bp=await remote.getRows(b.queryId,bl.layoutId,{cursor:bc});
      assert.deepEqual(ap.items.map(item=>[item.record.id,item.row]),bp.items.map(item=>[item.record.id,item.row]));
      for(let i=0;i<ap.items.length;i++)for(const key of ['xStart','xEnd','labelX','labelWidth','geometryOffsetY','labelOffsetY'])assert.ok(Math.abs(ap.items[i][key]-bp.items[i][key])<1e-7,key);
      ac=ap.nextCursor;bc=bp.nextCursor;assert.equal(!!ac,!!bc);
    }while(ac);
  }finally{local.dispose();remote.dispose();await server.stop();}
});
