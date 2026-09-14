import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startSnapshotServer } from '../integration/snapshot-server-fixture.mjs';

const datasets = [['default-dataset',48,2],['ephemeris',127,2],['jfk',130,2],['monet',27,1],['religions',730,4],['space_exploration',1287,2]];
const file = pathToFileURL(path.resolve('dist/index.html')).href;
const captures = process.env.OPENBEXI_UPDATE_SCREENSHOTS === '1' ? 'docs/ui/test-data' : 'artifacts/browser/test-data';
async function choose(page, id) {
  await expect.poll(() => page.evaluate(() => window.__timelineDebug?.ready)).toBe(true);
  const previous = await page.evaluate(() => window.__timelineDebug.providerId);
  await page.locator('[data-action=help]').click();
  await page.getByLabel('Test local dataset', { exact: true }).selectOption(id);
  await page.locator('[data-help=open-test-data]').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.providerId)).not.toBe(previous);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug?.testDatasetId)).toBe(id);
  await expect.poll(() => page.evaluate(() => window.__timelineDebug?.ready)).toBe(true);
}

for (const [id, count, bands] of datasets) test(`complete ${id} fixture works directly from file without network`, async ({page}) => {
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0,500)); });
  page.on('dialog', dialog => dialog.accept());
  await page.route(/^https?:/, route => { requests.push(route.request().url()); return route.abort(); });
  await page.setViewportSize({width:1832,height:['jfk','monet'].includes(id) ? 600 : 1020});
  await page.goto(file); await choose(page,id);
  const state = await page.evaluate(() => window.__timelineDebug);
  expect(state.recordCount).toBe(count); expect(state.bandCount).toBe(bands);
  await expect(page.locator('.plot-wrap .record-label').first()).toBeVisible();
  const pixels = await page.locator('.plot-wrap canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width*canvas.height*4); gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    const colors = new Set(); for(let i=0;i<pixels.length;i+=4) colors.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]}`); return colors.size;
  });
  expect(pixels).toBeGreaterThan(4);
  expect(await page.locator('.timeline-view canvas').evaluateAll(canvases => canvases.filter(canvas => canvas.getBoundingClientRect().height > 0).every(canvas => {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const data = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    return data.some((value,index) => index % 4 !== 3 && value !== data[index % 4]);
  }))).toBe(true);
  if(id === 'monet') { await expect(page.locator('.overview-section')).toBeHidden(); await expect(page.locator('.relative-axis')).toContainText('Age'); }
  if(id === 'religions') { await expect(page.locator('.additional-band')).toHaveCount(2); await expect(page.locator('.main-axis')).toContainText('BC'); await expect(page.locator('.detail-band .record-label').first()).toBeVisible(); }
  await mkdir(captures,{recursive:true});
  await expect(page.locator('.toast')).toHaveCount(0);
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await page.screenshot({path:`${captures}/${id}.png`});
  await page.locator('.timeline-view').screenshot({path:`${captures}/${id}-timeline.png`});
  await page.locator('.plot-wrap .record-label').first().click(); await expect(page.locator('.descriptor')).toBeVisible();
  expect(errors).toEqual([]); expect(requests).toEqual([]);
  await writeFile(`${captures}/${id}.verification.json`, JSON.stringify({status:'passed',dataset:id,recordCount:count,bandCount:bands,viewport:page.viewportSize(),canvasColors:pixels,errors,httpRequests:requests,buildSha256:createHash('sha256').update(await readFile('dist/index.html')).digest('hex')},null,2)+'\n');
});

test('source switching resets leaked search, preserves complete datasets and restores reference view', async ({page}) => {
  page.on('dialog',dialog=>dialog.accept());
  await page.goto(file); await choose(page,'monet');
  const original = await page.evaluate(() => window.__timelineDebug);
  await page.locator('#search').fill('Birth');
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.ready && window.__timelineDebug.search === 'Birth')).toBe(true);
  await choose(page,'jfk'); await expect(page.locator('#search')).toHaveValue('');
  await choose(page,'monet');
  await page.locator('[data-action=help]').click(); await page.locator('[data-help=reset-test-data]').click();
  await expect.poll(() => page.evaluate(() => window.__timelineDebug.ready)).toBe(true);
  expect((await page.evaluate(() => window.__timelineDebug)).fromMs).toBe(original.fromMs);
});

for(const id of ['monet','religions']) test(`${id} remains readable on mobile`,async({page})=>{
  page.on('dialog',dialog=>dialog.accept()); await page.setViewportSize({width:390,height:844}); await page.goto(file); await choose(page,id);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await expect(page.locator('.plot-wrap .record-label').first()).toBeVisible();
  await mkdir(captures,{recursive:true});
  await expect(page.locator('.toast')).toHaveCount(0); await page.screenshot({path:`${captures}/${id}-mobile.png`});
  await writeFile(`${captures}/${id}-mobile.verification.json`, JSON.stringify({status:'passed',dataset:id,viewport:page.viewportSize(),horizontalOverflow:false,buildSha256:createHash('sha256').update(await readFile('dist/index.html')).digest('hex')},null,2)+'\n');
});

test('YAML server opens the real fixture first and Help can switch to a complete offline source',async({page})=>{
  const server=await startSnapshotServer('religions',{localBrowser:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  try{
    await page.goto(server.baseUrl);
    await expect.poll(()=>page.evaluate(()=>window.__timelineDebug?.ready)).toBe(true);
    const info=await page.evaluate(()=>window.__timelineDebug);
    expect(info.providerKind).toBe('server');expect(info.recordCount).toBe(730);expect(info.bandCount).toBe(4);
    await expect(page.locator('.detail-band .record-label').first()).toBeVisible();
    await choose(page,'space_exploration');
    expect((await page.evaluate(()=>window.__timelineDebug)).providerKind).toBe('local');
    await page.context().setOffline(true); await page.locator('.plot-wrap').focus();await page.keyboard.press('ArrowRight');
    await expect.poll(()=>page.evaluate(()=>window.__timelineDebug?.ready)).toBe(true);
    expect(errors).toEqual([]);
  }finally{await page.context().setOffline(false);await server.stop();}
});

test('BC calendar and range editing preserve the selected historical instant', async ({page}) => {
  const errors=[]; page.on('pageerror',error=>errors.push(error.message)); page.on('dialog',dialog=>dialog.accept());
  await page.goto(file); await choose(page,'religions');
  await page.getByRole('button',{name:'Calendar',exact:true}).click();
  await page.getByLabel('Calendar year',{exact:true}).fill('-199');
  await page.getByLabel('Calendar year',{exact:true}).press('Tab');
  await page.getByLabel('Calendar month',{exact:true}).selectOption('1');
  await page.getByRole('button',{name:'-000199-01-02',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__timelineDebug.ready)).toBe(true);
  expect(Math.abs(Number((await page.evaluate(()=>window.__timelineDebug)).centerMs)-Date.parse('-000199-01-02T00:00:00Z'))).toBeLessThan(1);
  await page.getByRole('complementary',{name:'Calendar',exact:true}).getByRole('button',{name:'Date and time range',exact:true}).click();
  const form=page.locator('#range-form'); await expect(form.locator('[name=from]')).toHaveAttribute('type','text');
  await form.locator('[name=from]').fill('-000199-01-01T00:00:00'); await form.locator('[name=to]').fill('0036-01-01T00:00:00');
  await form.getByRole('button',{name:'Apply range'}).click();
  await expect.poll(()=>page.evaluate(()=>window.__timelineDebug.ready)).toBe(true);
  await expect(page.locator('.main-axis')).toContainText('BC'); expect(errors).toEqual([]);
});
