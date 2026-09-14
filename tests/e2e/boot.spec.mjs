import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

async function holdInitialSource(page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const gate = window.__bootGate = { captured: false, delivered: false, methods: [] };
    gate.wait = new Promise(resolve => { gate.release = resolve; });
    window.Worker = class extends NativeWorker {
      constructor(url, options) { super(url, options); this.methods = new Map(); }
      postMessage(message, ...rest) {
        if (message.type === 'request') { this.methods.set(message.id, message.method); gate.methods.push(message.method); }
        return super.postMessage(message, ...rest);
      }
      addEventListener(type, listener, options) {
        if (type !== 'message') return super.addEventListener(type, listener, options);
        return super.addEventListener(type, event => {
          if (event.data?.type !== 'response' || this.methods.get(event.data.id) !== 'initialize' || gate.captured) { listener.call(this, event); return; }
          gate.captured = true;
          gate.wait.then(fail => {
            gate.delivered = true;
            const delivered = fail ? new MessageEvent('message', { data: { ...event.data, result: undefined, error: { code: 'invalid_snapshot', status: 422, message: 'The initial snapshot could not be opened.' } } }) : event;
            listener.call(this, delivered);
          });
        }, options);
      }
    };
  });
  await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);
  await expect.poll(() => page.evaluate(() => window.__bootGate?.captured)).toBe(true);
}

test('a delayed initial source keeps shell actions inert until metadata is adopted', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await holdInitialSource(page);
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.provider-status[role=status]')).toHaveText('Opening Local snapshot...');
  expect(await page.locator('#app').evaluate(root => [...root.querySelectorAll('button, input, select, textarea')].every(control => control.disabled))).toBe(true);
  await page.evaluate(() => {
    for (const selector of ['[data-action=sources]', '[data-action=create]', '[data-action=settings]', '[data-action=help]', '[data-action=filters]', '[data-action=zoom-in]', '[data-action=next]', '[data-view=table]']) document.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    document.querySelector('#search').dispatchEvent(new Event('input', { bubbles: true }));
    for (const id of ['source-filter', 'kind-filter', 'auto-scale']) document.getElementById(id).dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.plot-wrap').dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.modal, .model-manager')).toHaveCount(0);
  expect(await page.evaluate(() => window.__bootGate.methods)).toEqual(['initialize']);
  expect(await page.evaluate(() => window.__timelineDebug.view)).toBe('timeline');
  expect(await page.evaluate(() => window.__timelineDebug.search)).toBe('');
  expect(errors).toEqual([]);
  await page.evaluate(() => window.__bootGate.release(false));
  await expect(page.locator('.record-label').first()).toBeVisible();
  await expect(page.locator('.busy-indicator')).toHaveCount(0);
  await expect(page.locator('#app')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#search')).toBeEnabled();
  await page.locator('[data-action=sources]').first().click();
  await expect(page.locator('#server-form [name=baseUrl]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a rejected initial source replaces the loading guard with an accessible error', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await holdInitialSource(page);
  await page.evaluate(() => window.__bootGate.release(true));
  await expect(page.getByRole('alert')).toHaveText('The initial snapshot could not be opened.');
  await expect(page.locator('#app')).not.toHaveAttribute('aria-busy', 'true');
  expect(await page.locator('#app').evaluate(root => root.inert)).toBe(false);
  await expect(page.locator('.provider-status, .busy-indicator')).toHaveCount(0);
  expect(errors).toEqual([]);
});
