import { createRecordCommandRecovery } from '../data/record-command-recovery.js';
import { ProviderError } from '../data/data-provider.js';
import { escapeHtml as esc, icon } from '../utils/dom.js';
import '../styles/record-recovery.css';

export function createRecordRecovery(host) {
  const store = createRecordCommandRecovery(host);
  let disposed = false, checking = false, executing = false;
  const locked = new Map();
  const current = () => !disposed && host.isCurrent();
  const pending = () => store.read();
  const banner = document.createElement('div');
  banner.className = 'record-recovery-banner'; banner.hidden = true;
  banner.innerHTML = '<span role="status"></span><button type="button" data-action="record-recovery">Check record outcome</button>';
  host.anchor.after(banner);
  banner.querySelector('button').onclick = event => { event.stopPropagation(); open(); };

  function refreshControls() {
    if (!current()) return;
    const blocked = pending().length > 0;
    for (const node of locked.keys()) if (!node.isConnected) locked.delete(node);
    const selector = '[data-action=create],[data-action=edit],[data-action=duplicate],[data-action=delete],[data-action=time-edit],[data-action=close-session],[data-time-mode=edit],#new-command';
    for (const node of document.querySelectorAll(selector)) {
      if (blocked) { if (!locked.has(node)) locked.set(node, node.disabled); node.disabled = true; }
      else if (locked.has(node)) { node.disabled = locked.get(node); locked.delete(node); }
    }
  }
  function refresh() {
    if (!current()) return;
    const entries = pending();
    banner.hidden = !entries.length;
    banner.querySelector('span').textContent = executing ? 'Record write awaiting confirmation. New record writes are locked.' : `${entries.length} unconfirmed record ${entries.length === 1 ? 'write' : 'writes'} on this source. New record writes are locked.`;
    banner.querySelector('button').disabled = executing;
    refreshControls(); host.onChange?.();
  }
  function warning(container) {
    let node = container.querySelector('.record-recovery-warning');
    if (!node) { node = document.createElement('p'); node.className = 'record-recovery-warning subtle'; node.setAttribute('role', 'status'); container.append(node); }
    node.textContent = store.warning(); node.hidden = !node.textContent;
  }
  async function check(commandId) {
    if (!current()) throw new Error('Reconnect to the original source and generation before checking this record write.');
    const entry = pending().find(item => item.clientCommandId === commandId);
    if (!entry) throw new Error('This record command has already been resolved.');
    let outcome;
    try { outcome = await host.provider.getCommandOutcome(commandId); }
    catch (error) { if (current() && [401, 403].includes(error.status)) host.onAuthorizationError?.(error); throw error; }
    if (outcome.state !== 'committed') return { confirmed: false, message: 'No committed outcome is confirmed. New record writes remain locked; no retry or upload was sent.' };
    if (outcome.result?.generation !== host.generation || !outcome.result?.record?.id || (entry.recordId && outcome.result.record.id !== entry.recordId)) throw new Error('The returned outcome does not match the original source generation and record. Recovery remains locked.');
    store.clear(commandId);
    refresh();
    let followup = '';
    if (current()) {
      try { await host.onConfirmed(entry, outcome.result); }
      catch (error) { followup = ` Follow-up refresh failed: ${error.message}. The write remains confirmed; do not submit it again.`; }
    }
    return { confirmed: true, message: `The original write committed on its original source. Its recovery identity is resolved.${followup}` };
  }
  function attachOutcome(container, commandId) {
    if (container.querySelector('.outcome-check')) return;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'outcome-check record-outcome-check'; button.textContent = 'Check original write outcome';
    button.onclick = async () => {
      if (checking) return; checking = true; button.disabled = true;
      try { const result = await check(commandId); host.formError(container, new Error(result.message)); if (result.confirmed) button.remove(); }
      catch (error) { if (container.isConnected) host.formError(container, error); }
      finally { checking = false; button.disabled = false; warning(container); }
    };
    container.append(button); warning(container);
  }
  function open() {
    if (!current()) return;
    const entries = pending();
    const dialog = host.openDialog('Record write recovery', `<section class="record-recovery"><p>Only the original command outcome is checked. No record payload is stored here, and nothing is retried or uploaded.</p><div class="record-recovery-list">${entries.map(entry => `<div class="record-recovery-item"><strong>${esc(entry.type)} record</strong><code>${esc(entry.clientCommandId)}</code>${entry.recordId ? `<span>Record ${esc(entry.recordId)}</span>` : ''}<button type="button" class="record-outcome-check" data-command-id="${esc(entry.clientCommandId)}">${icon('search-check')}Check original outcome</button></div>`).join('')}</div><p class="record-recovery-message" role="status">${entries.length ? 'Record writes remain locked until the original outcomes are confirmed.' : 'No unconfirmed record writes on this source.'}</p></section>`);
    const section = dialog.querySelector('.record-recovery'); warning(section); host.updateIcons();
    for (const button of dialog.querySelectorAll('[data-command-id]')) button.onclick = async () => {
      if (checking) return; checking = true; button.disabled = true;
      try {
        const result = await check(button.dataset.commandId);
        if (!dialog.isConnected) return;
        section.querySelector('.record-recovery-message').textContent = result.message;
        if (result.confirmed) { button.closest('.record-recovery-item').remove(); if (!pending().length) section.dataset.resolved = 'true'; }
      } catch (error) { if (dialog.isConnected && current()) section.querySelector('.record-recovery-message').textContent = error.message; }
      finally { checking = false; button.disabled = false; if (dialog.isConnected) warning(section); }
    };
  }
  return {
    pending, open, warning, attachOutcome, refreshControls,
    async execute(command) {
      if (!current()) throw new Error('This draft belongs to another source or generation. No command was sent.');
      if (pending().length) throw new Error('Resolve the original record write outcome before another record mutation.');
      store.remember(command); executing = true; refresh();
      try {
        const result = await host.provider.executeCommand(command);
        if (result?.generation !== host.generation || !result.record?.id || (command.recordId && result.record.id !== command.recordId)) throw new ProviderError('write_outcome_unknown', 'The record write response was incomplete. Check the original command outcome.', 502);
        store.clear(command.clientCommandId);
        return result;
      } catch (error) {
        if (error.code !== 'write_outcome_unknown' && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) store.clear(command.clientCommandId);
        else if (error.code !== 'write_outcome_unknown') throw new ProviderError('write_outcome_unknown', `The original record write outcome is unconfirmed. ${error.message}`, 503);
        throw error;
      } finally { executing = false; refresh(); }
    },
    dispose() { disposed = true; banner.remove(); for (const [node, disabled] of locked) if (node.isConnected) node.disabled = disabled; locked.clear(); },
    suspend() { banner.hidden = true; },
    refresh,
  };
}
