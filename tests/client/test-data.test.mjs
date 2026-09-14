import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { toMs, toIso, projectTime, invertPosition, generateTicks } from '../../client/src/timeline/time-scale.js';
import { fixedScaleMap } from '../../client/src/timeline/fixed-scale.js';
import { setDateInput, inputIso } from '../../client/src/utils/dom.js';

const catalog = JSON.parse(await readFile('data/catalog.json','utf8'));
for(const entry of catalog.datasets) test(`${entry.id}: complete provider, coherent preset and stable row pages`,async()=>{
  const snapshot = JSON.parse(await readFile(entry.file,'utf8')), provider = new LocalProvider(snapshot);
  const info = await provider.initialize(); assert.equal(info.recordCount,snapshot.records.length);
  if(entry.id !== 'default-dataset') assert.equal(info.settings.displayUnit,entry.settings.displayUnit);
  const primary = info.settings.presentation?.bandLayout?.find(b=>b.role==='primary');
  const query = await provider.createQuery({domain:info.settings.overview,scaleMode:'uniform',...(primary?.fixedScale ? {fixedScale:primary.fixedScale} : {})});
  const map = await provider.getMap(query.queryId,query.mapId);
  const layout = await provider.createLayout(query.queryId,{mapId:query.mapId,...info.settings.range,width:1000,availableHeight:96,fontSize:11,presentation:info.settings.presentation});
  const ids=[];let cursor=null;
  do { const page=await provider.getRows(query.queryId,layout.layoutId,{cursor});ids.push(...page.items.map(item=>item.record.id));cursor=page.nextCursor; } while(cursor);
  assert.equal(ids.length,new Set(ids).size);assert.equal(ids.length,layout.detailTotal);
  assert.deepEqual(await provider.getMap(query.queryId,query.mapId),map);
  const exported=await provider.exportSnapshot(); assert.equal(exported.records.length,snapshot.records.length);
  provider.dispose();
});

test('BC dates, year zero and fixed magnification round-trip accurately',()=>{
  for(const value of ['-009999-01-01T00:00:00.000Z','-000199-01-01T00:00:00.000Z','0000-02-29T12:34:56.789Z']) assert.equal(toIso(toMs(value)),value);
  const domain={from:'-000199-01-01T00:00:00.000Z',to:'0036-01-01T00:00:00.000Z'};
  const map=fixedScaleMap(domain,[{from:'0000-01-01T00:00:00Z',to:domain.to,ratio:10}]);
  for(let i=0;i<=100;i++){ const t=Math.floor(toMs(domain.from)+(toMs(domain.to)-toMs(domain.from))*i/100);const x=projectTime(map,t,domain.from,domain.to,1600);assert.ok(Math.abs(Number(invertPosition(map,x,domain.from,domain.to,1600))-t)<.1); }
  assert.ok(generateTicks(domain.from,domain.to,'CENTURY').some(t=>t.label.includes('BC')));
  assert.throws(()=>fixedScaleMap(domain,[{from:domain.to,to:domain.from,ratio:3}]));
});

test('historical edit fields do not lose BC or year-zero dates to HTML date input limits',()=>{
  const input={};
  for(const value of ['-000199-01-02T00:00:00.000Z','0000-02-29T00:00:00.000Z']){
    setDateInput(input,value);assert.equal(input.type,'text');assert.equal(inputIso(input.value),value);
  }
  setDateInput(input,'2000-01-01T00:00:00.000Z');assert.equal(input.type,'datetime-local');
});
