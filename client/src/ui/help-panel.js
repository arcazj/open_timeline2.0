import { captureTimeline } from './timeline-image.js';
import { escapeHtml as esc, icon, downloadJson } from '../utils/dom.js';
import { sharedViewLink, decodeSharedView } from './shared-view.js';
import { renderMarkdown, documentTarget, swaggerDocument } from './help-documents.js';

const command = (id, symbol, label, disabled = false, title = label) => `<button type="button" data-help="${id}" ${disabled ? 'disabled' : ''} title="${esc(title)}">${icon(symbol)}<span>${esc(label)}</span></button>`;
function download(blob, name) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openHelpPanel(host, initialLink = '', initialTab = 'help') {
  const content = JSON.parse(document.getElementById('help-content').textContent);
  const notices = JSON.parse(document.getElementById('third-party-notices').textContent);
  const dialog = host.openDialog('Help and sharing', `<nav class="help-tabs" aria-label="Help sections">${['Help', 'Share', 'Diagnostics'].map(tab => `<button type="button" data-help-tab="${tab.toLowerCase()}" aria-pressed="false">${icon({ Help: 'circle-help', Share: 'share-2', Diagnostics: 'activity' }[tab])}${tab}</button>`).join('')}</nav><div class="help-body"></div><p class="help-status" role="status" aria-live="polite"></p>`, { wide: true });
  dialog.querySelector('.modal').classList.add('help-modal');
  const body = dialog.querySelector('.help-body'), status = dialog.querySelector('.help-status');
  const controller = new AbortController();
  let section = '', previewUrl = null, previewBlob = null, pending = false, paintIntent = 0, waitingForView = false;
  const current = () => dialog.isConnected && !controller.signal.aborted && host.isCurrent();
  const message = value => { if (dialog.isConnected) status.textContent = value; };
  const revoke = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; previewBlob = null; };
  const ready = () => {
    if (waitingForView && current() && section === 'share' && host.shareReady && !pending && !body.querySelector('.help-import textarea')?.value) share();
  };
  document.addEventListener('timeline-ready', ready);
  dialog.addEventListener('dialog-close', () => { controller.abort(); revoke(); document.removeEventListener('timeline-ready', ready); }, { once: true });
  async function run(action) {
    if (pending) return;
    if (!current()) { message('The active view changed. Close and reopen Help to use the current view.'); return; }
    pending = true; body.setAttribute('aria-busy', 'true'); message('');
    try { await action(); }
    catch (error) { if (dialog.isConnected && error.name !== 'AbortError') message(error.message || 'The operation could not be completed.'); }
    finally { pending = false; body.removeAttribute('aria-busy'); }
  }
  async function copyText(value, fallback) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value); if (current()) message('Copied to clipboard.');
    } catch {
      fallback?.focus(); fallback?.select(); message('Clipboard access is unavailable. Select the text and copy it using the browser.');
    }
  }
  const paint = html => {
    const restoreFocus = body.contains(document.activeElement);
    ++paintIntent; body.innerHTML = html; message(''); host.updateIcons();
    if (restoreFocus) body.querySelector('button:not(:disabled),a[href],textarea,iframe')?.focus();
  };
  function documentView(path) {
    const doc = content.documents[path]; if (!doc) return;
    paint(`<div class="help-document-heading">${command('home', 'arrow-left', 'Help') }<h3>${esc(doc.title)}</h3></div><article class="help-document">${renderMarkdown(doc.markdown)}</article>`);
    body.querySelector('[data-help="home"]').onclick = () => show('help');
    for (const anchor of body.querySelectorAll('.help-document a')) {
      let target; try { target = documentTarget(anchor.getAttribute('href'), path, content.documents, content.projectUrl); } catch { target = null; }
      if (!target) { anchor.removeAttribute('href'); continue; }
      if (target.document) { anchor.href = '#'; anchor.onclick = event => { event.preventDefault(); documentView(target.document); }; }
      else { anchor.href = target.url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.title = 'Open external documentation'; }
    }
  }
  function home() {
    paint(`<div class="help-section-heading"><h3>Project</h3><span class="subtle">Version ${esc(content.version)} / release candidate</span></div><div class="help-actions"><a href="${esc(content.projectUrl)}" target="_blank" rel="noopener noreferrer">${icon('git-fork')}GitHub${icon('external-link')}</a>${command('readme', 'book-open', 'README')}${command('releases', 'history', 'Release history')}${command('licenses', 'scale', 'Licenses')}</div><h3>Developer docs</h3><div class="help-actions">${command('swagger', 'braces', 'Swagger (offline)')}${command('api-md', 'file-text', 'Swagger MD')}${command('live-api', 'radio', 'Live API', !host.serverReady, 'Read the active server OpenAPI contract')}${command('contract', 'file-json', 'Download OpenAPI')}</div><h3>Guides</h3><div class="help-actions">${command('sources', 'folder-open', 'Server YAML and sources')}${command('scaling', 'ruler', 'Local scaling')}${command('standalone', 'monitor-off', 'Standalone mode')}${command('sharing-guide', 'share-2', 'Help and sharing')}${command('testing', 'list-checks', 'Testing')}${command('implementation', 'clipboard-list', 'Implementation status')}</div>`);
    const docs = { readme: 'README.md', releases: 'docs/release-history.md', 'api-md': 'docs/api.md', sources: 'docs/local-source-paths.md', scaling: 'docs/local-scaling.md', standalone: 'docs/standalone-mode.md', 'sharing-guide': 'docs/help-and-sharing.md', testing: 'docs/testing.md', implementation: 'docs/implementation-status.md' };
    if (host.testDatasets?.length) {
      body.insertAdjacentHTML('beforeend', `<section class="test-data-section"><h3>Test local data</h3><div class="help-actions"><select aria-label="Test local dataset">${host.testDatasets.map(entry => `<option value="${esc(entry.id)}" ${entry.id === host.testDatasetId ? 'selected' : ''}>${esc(entry.title)}</option>`).join('')}</select>${command('open-test-data', 'folder-open', 'Open dataset')}${command('reset-test-data', 'rotate-ccw', 'Reset reference view', !host.testDatasetId)}</div><p class="test-data-summary subtle"></p><details class="test-data-reference"><summary>Reference image</summary><img alt="Supplied timeline reference" style="max-width:100%;height:auto"></details><details><summary>Conversion report</summary><pre class="test-data-report help-json"></pre></details></section>`);
      const select = body.querySelector('[aria-label="Test local dataset"]');
      const preview = () => {
        const entry = host.testDatasets.find(item => item.id === select.value);
        body.querySelector('.test-data-summary').textContent = `${entry.report.outputRecords} records / Complete bundled snapshot / ${entry.yaml}${entry.referenceImage ? '' : ' / No supplied reference: unapproved baseline'}`;
        body.querySelector('.test-data-reference').hidden = !entry.referenceImage;
        const img = body.querySelector('.test-data-reference img');
        if (entry.referenceImage) img.src = entry.referenceImage; else img.removeAttribute('src');
        body.querySelector('.test-data-report').textContent = JSON.stringify(entry.report, null, 2);
      };
      select.onchange = preview; preview();
      body.querySelector('[data-help="open-test-data"]').onclick = () => run(() => host.openTestDataset(select.value));
      body.querySelector('[data-help="reset-test-data"]').onclick = () => run(() => host.resetTestDataset());
      host.updateIcons();
    }
    for (const [id, path] of Object.entries(docs)) body.querySelector(`[data-help="${id}"]`).onclick = () => documentView(path);
    body.querySelector('[data-help="licenses"]').onclick = () => {
      documentView('docs/third-party-notices.md');
      const list = document.createElement('div'); list.className = 'help-license-list';
      const packages = [...(notices.packages || []), ...(notices.assets || [])];
      list.innerHTML = packages.map(pkg => `<details><summary>${esc(pkg.name)} ${esc(pkg.version || '')} / ${esc(pkg.license)}</summary><pre>${esc(pkg.notices?.map(notice => notice.text).join('\n\n') || '')}</pre></details>`).join('');
      body.append(list);
    };
    body.querySelector('[data-help="contract"]').onclick = () => downloadJson(content.spec, 'openbexi-openapi.json');
    body.querySelector('[data-help="swagger"]').onclick = () => {
      paint(`<div class="help-document-heading">${command('home', 'arrow-left', 'Help')}<h3>Swagger / bundled contract</h3></div><iframe class="help-swagger" title="Offline Swagger API reference" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`);
      body.querySelector('[data-help="home"]').onclick = () => show('help');
      body.querySelector('iframe').srcdoc = swaggerDocument(content);
    };
    body.querySelector('[data-help="live-api"]').onclick = () => run(async () => {
      const intent = paintIntent;
      const spec = await host.liveApi({ signal: controller.signal });
      if (!current() || intent !== paintIntent) return;
      paint(`<div class="help-document-heading">${command('home', 'arrow-left', 'Help')}<h3>Live API / active server</h3>${command('save-api', 'download', 'Download JSON')}</div><pre class="help-json"></pre>`);
      body.querySelector('pre').textContent = JSON.stringify(spec, null, 2);
      body.querySelector('[data-help="home"]').onclick = () => show('help');
      body.querySelector('[data-help="save-api"]').onclick = () => { if (current()) downloadJson(spec, 'openbexi-live-openapi.json'); };
    });
  }
  function share() {
    waitingForView = !host.shareReady;
    let link = '', error = '';
    try { if (!host.shareReady) throw new Error('Wait for a ready timeline before sharing this view.'); link = sharedViewLink(location.href, host.capture()); } catch (cause) { error = cause.message; }
    const native = !!navigator.share && /^https?:/.test(link);
    const canCopyImage = !!navigator.clipboard?.write && !!window.ClipboardItem && (!ClipboardItem.supports || ClipboardItem.supports('image/png'));
    paint(`<div class="help-section-heading"><h3>Current view</h3><span class="subtle">${esc(host.summary.source)}</span></div><dl class="help-facts"><dt>Time range</dt><dd>${esc(host.summary.range)}</dd><dt>Filter</dt><dd>${esc(host.summary.filter)}</dd><dt>Selection</dt><dd>${esc(host.summary.selection)}</dd></dl><div class="help-actions">${command('copy-link', 'link', 'Copy link', !link)}${command('native-share', 'share-2', 'Native share', !native, native ? 'Share the view link' : 'Native sharing requires a supported browser and an HTTP application URL')}</div><label>View link<textarea class="help-link" aria-label="View link" readonly spellcheck="false">${esc(link)}</textarea></label><p class="subtle">Links include readable filters, search text and record IDs, but no records or credentials. Recipients need access to the same dataset.${location.protocol === 'file:' ? ' This local file produces a view fragment: open the same snapshot and paste it below.' : ''}</p><h3>Timeline image</h3><div class="help-actions">${command('preview', 'image', 'Preview image', !host.shareReady)}${command('download-image', 'download', 'Download image', true)}${command('copy-image', 'copy', 'Copy image', true, canCopyImage ? 'Copy the preview PNG' : 'Image clipboard is unavailable in this browser')}</div><img class="help-preview" alt="Current timeline image preview" hidden><p class="subtle">The image includes visible labels and the open descriptor. Review it before sharing.</p><h3>Open a shared view</h3><form class="help-import"><label>Shared view link<textarea name="link" aria-label="Shared view link" maxlength="20480" spellcheck="false">${esc(initialLink)}</textarea></label><div class="help-actions">${command('review-link', 'scan-text', 'Review link')}${command('apply-link', 'check', 'Apply view', true)}</div><pre class="help-review" hidden></pre><p class="subtle">Uses the active dataset only. This cannot connect to a server, open a filesystem path, or modify records.</p></form>`);
    initialLink = '';
    if (error) {
      message(error);
      body.insertAdjacentHTML('afterbegin', command('refresh-view', 'rotate-cw', 'Refresh view'));
      body.querySelector('[data-help="refresh-view"]').onclick = host.reopenShare;
      host.updateIcons();
    }
    body.querySelector('[data-help="copy-link"]').onclick = () => run(() => copyText(link, body.querySelector('.help-link')));
    body.querySelector('[data-help="native-share"]').onclick = () => run(() => navigator.share({ title: 'OpenBEXI Timeline', url: link }));
    body.querySelector('[data-help="preview"]').onclick = () => run(async () => {
      message('Preparing image...'); await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (!current()) return;
      const stamp = host.viewStamp();
      const blob = await captureTimeline(document.getElementById('app'));
      if (!current() || section !== 'share') return;
      if (stamp !== host.viewStamp()) throw new Error('The timeline changed during capture. Preview the image again.');
      if (!blob) throw new Error('The browser could not capture this view.');
      revoke(); previewBlob = blob; previewUrl = URL.createObjectURL(blob);
      const img = body.querySelector('.help-preview'); img.src = previewUrl; img.hidden = false;
      body.querySelector('[data-help="download-image"]').disabled = false;
      body.querySelector('[data-help="copy-image"]').disabled = !canCopyImage;
      message('Image ready. Review the preview before sharing.');
    });
    body.querySelector('[data-help="download-image"]').onclick = () => { if (current() && previewBlob) download(previewBlob, 'openbexi-timeline.png'); };
    body.querySelector('[data-help="copy-image"]').onclick = () => run(async () => {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': previewBlob })]); if (current()) message('Image copied to clipboard.');
    });
    const form = body.querySelector('form'), input = form.elements.link, apply = form.querySelector('[data-help="apply-link"]');
    let reviewed = null;
    form.onsubmit = event => event.preventDefault();
    input.oninput = () => { reviewed = null; apply.disabled = true; form.querySelector('pre').hidden = true; };
    const review = () => {
      reviewed = null; apply.disabled = true;
      try {
        const view = decodeSharedView(input.value.trim());
        const pre = form.querySelector('pre'); pre.hidden = false;
        pre.textContent = JSON.stringify({ range: view.range, view: view.view, filters: view.filters, search: view.search, selectedId: view.selectedId, sourceGeneration: view.generation }, null, 2);
        reviewed = view; apply.disabled = !host.shareReady;
        message(view.generation !== host.generation ? 'This link references a different snapshot. Only records available in the active dataset can be shown.' : 'Review these settings, then apply to the active dataset.');
      } catch (cause) { message(cause.message); }
    };
    form.querySelector('[data-help="review-link"]').onclick = review;
    apply.onclick = () => run(async () => { if (!reviewed) return; await host.apply(reviewed, { signal: controller.signal, isCurrent: current }); if (dialog.isConnected) { host.closeDialog(); host.toast('Shared view applied to the active dataset.'); } });
    if (input.value) review();
  }
  function diagnostics() {
    const data = { version: content.version, ...host.diagnostics };
    paint(`<h3>Diagnostics</h3><div class="help-actions">${command('copy-diagnostics', 'copy', 'Copy diagnostics')}${command('save-diagnostics', 'download', 'Download JSON')}${command('health', 'heart-pulse', 'Check server health', !host.serverReady)}</div><label>Diagnostic report<textarea class="help-diagnostics" aria-label="Diagnostic report" readonly spellcheck="false">${esc(JSON.stringify(data, null, 2))}</textarea></label><p class="subtle">No credentials, filesystem paths, record contents, search text, or filter values are included.</p>`);
    body.querySelector('[data-help="copy-diagnostics"]').onclick = () => run(() => copyText(JSON.stringify(data, null, 2), body.querySelector('textarea')));
    body.querySelector('[data-help="save-diagnostics"]').onclick = () => downloadJson(data, 'openbexi-diagnostics.json');
    body.querySelector('[data-help="health"]').onclick = () => run(async () => { await host.health({ signal: controller.signal }); if (current()) message('The active server health endpoint responded successfully.'); });
  }
  function show(tab) {
    if (pending) return;
    revoke(); section = tab;
    for (const node of dialog.querySelectorAll('[data-help-tab]')) node.setAttribute('aria-pressed', String(node.dataset.helpTab === tab));
    if (tab === 'share') share(); else if (tab === 'diagnostics') diagnostics(); else home();
  }
  for (const tab of dialog.querySelectorAll('[data-help-tab]')) tab.onclick = () => show(tab.dataset.helpTab);
  show(initialLink ? 'share' : initialTab);
  return dialog;
}
