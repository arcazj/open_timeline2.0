import { escapeHtml as esc, icon } from '../utils/dom.js';
import { filterFieldLabel } from './filter-editor-state.js';

export function mountFilterMigration(parent, { fieldTypes, review, useDraft, current = () => true, updateIcons = () => {} }) {
  const section = document.createElement('details'); section.className = 'filter-migration';
  section.innerHTML = `<summary>Legacy filter migration</summary><div class="filter-migration-inputs"><label>Include<textarea name="legacyInclude" spellcheck="false"></textarea></label><label>Exclude<textarea name="legacyExclude" spellcheck="false"></textarea></label><label>Legacy grouping<select name="legacySortBy"><option value="NONE">All items</option>${Object.keys(fieldTypes).filter(field => fieldTypes[field] !== 'strings').map(field => `<option value="${esc(field === '/data/namespace' ? 'namespace' : field)}">${esc(filterFieldLabel(field))}</option>`).join('')}</select></label><label>Related sessions<select name="legacyRelationship"><option value="independent">Matches + parent context</option><option value="family">Matching families</option></select></label></div><div class="filter-migration-actions"><button type="button" data-migration="review">${icon('scan-text')}Review conversion</button><button type="button" data-migration="use" disabled>${icon('check')}Use reviewed draft</button></div><p class="filter-migration-status" role="status"></p><ul class="filter-migration-diagnostics"></ul><div class="filter-migration-acknowledgements"></div><details class="filter-migration-proposal" hidden><summary>Proposed query definition</summary><pre></pre></details>`;
  parent.append(section); updateIcons();
  const controls = section.querySelector('.filter-migration-inputs'), button = section.querySelector('[data-migration=review]'), accept = section.querySelector('[data-migration=use]');
  const status = section.querySelector('[role=status]'), diagnostics = section.querySelector('.filter-migration-diagnostics'), approvals = section.querySelector('.filter-migration-acknowledgements');
  let controller, timer, intent = 0, report = null, disposed = false;
  const active = () => !disposed && section.isConnected && current();
  const invalidate = () => {
    ++intent; controller?.abort(); clearTimeout(timer); controller = null; report = null;
    button.disabled = false; accept.disabled = true; approvals.replaceChildren(); diagnostics.replaceChildren();
    section.querySelector('.filter-migration-proposal').hidden = true; section.removeAttribute('aria-busy'); status.textContent = 'Review required.';
  };
  controls.addEventListener('input', invalidate); controls.addEventListener('change', invalidate);
  const run = async () => {
    controller?.abort(); clearTimeout(timer); const requestController = controller = new AbortController(); const signal = controller.signal, request = ++intent;
    const input = { include: section.querySelector('[name=legacyInclude]').value, exclude: section.querySelector('[name=legacyExclude]').value,
      sortBy: section.querySelector('[name=legacySortBy]').value, relationshipMode: section.querySelector('[name=legacyRelationship]').value,
      acknowledgements: [...approvals.querySelectorAll('input:checked')].map(node => node.value) };
    button.disabled = true; accept.disabled = true; report = null; section.setAttribute('aria-busy', 'true'); status.textContent = 'Reviewing legacy filter...';
    const requestTimer = timer = setTimeout(() => requestController.abort(), 8000);
    try {
      if ([input.include, input.exclude].some(value => [...value].length > 4096)) throw new Error('Legacy include and exclude fields are limited to 4096 characters each.');
      const result = await review(input, { signal });
      if (!active() || signal.aborted || request !== intent) return;
      report = result; diagnostics.replaceChildren();
      status.textContent = result.classification === 'blocked' ? 'Conversion blocked' : result.publishable ? 'Reviewed draft ready' : 'Explicit approval required';
      for (const diagnostic of result.diagnostics || []) {
        const item = document.createElement('li'); item.textContent = `${diagnostic.message}${Number.isInteger(diagnostic.offset) ? ` (character ${diagnostic.offset + 1})` : ''}`;
        item.dataset.severity = diagnostic.severity; diagnostics.append(item);
      }
      const focused = approvals.contains(document.activeElement) ? document.activeElement.value : null;
      approvals.replaceChildren();
      for (const code of result.requiredAcknowledgements || []) {
        const label = document.createElement('label'), checkbox = document.createElement('input'); label.className = 'check-label'; checkbox.type = 'checkbox'; checkbox.value = code;
        checkbox.checked = input.acknowledgements.includes(code); label.append(checkbox, document.createTextNode(`Approve: ${result.diagnostics.find(item => item.code === code)?.message || code}`)); approvals.append(label);
      }
      if (focused) [...approvals.querySelectorAll('input')].find(node => node.value === focused)?.focus({ preventScroll: true });
      const proposal = section.querySelector('.filter-migration-proposal'); proposal.hidden = !result.draft;
      proposal.querySelector('pre').textContent = result.draft ? JSON.stringify(result.draft, null, 2) : '';
      accept.disabled = result.publishable !== true || !result.draft;
    } catch (error) {
      if (active() && request === intent) status.textContent = signal.aborted ? 'Review timed out. The active timeline is unchanged.' : `Review unavailable: ${error.message}`;
    } finally {
      clearTimeout(requestTimer);
      if (active() && request === intent) { button.disabled = false; section.removeAttribute('aria-busy'); }
    }
  };
  button.addEventListener('click', run); approvals.addEventListener('change', run);
  accept.addEventListener('click', async () => {
    if (!active() || !report?.publishable || !report.draft) return;
    try { await useDraft(structuredClone(report.draft), report); status.textContent = 'Reviewed draft loaded. Not applied.'; }
    catch (error) { status.textContent = error.message; accept.disabled = true; }
  });
  return { reset() {
    section.querySelector('[name=legacyInclude]').value = ''; section.querySelector('[name=legacyExclude]').value = '';
    section.querySelector('[name=legacySortBy]').value = 'NONE'; section.querySelector('[name=legacyRelationship]').value = 'independent'; invalidate();
  }, dispose() { disposed = true; ++intent; clearTimeout(timer); controller?.abort(); } };
}
