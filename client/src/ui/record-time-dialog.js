import { changeRecordTime, validateRecordTimes } from './record-time-edit.js';
import { escapeHtml as esc, icon, dateInput, setDateInput, inputIso } from '../utils/dom.js';

export function openRecordTimeDialog(host, record, context, { operation = 'move', proposed = null, error = null } = {}) {
  const operations = [['move', 'Move by elapsed time'], ['start', 'Set start'], ...(record.kind === 'session' ? record.end === null ? [['close', 'Close ongoing session']] : [['end', 'Set end']] : [])];
  const dialog = host.openDialog('Record time', `<form class="time-edit-form" id="record-time-form"><h3>${esc(record.title)}</h3><p class="time-edit-source">${esc(context.sourceName)} / Version ${record.version}</p><p class="time-edit-original">Original: ${esc(record.start)}${record.kind === 'session' ? ` to ${esc(record.end || 'ongoing')}` : ''}</p><div class="form-grid"><label class="full">Operation<select name="operation">${operations.map(([value, name]) => `<option value="${value}" ${value === operation ? 'selected' : ''}>${name}</option>`).join('')}${proposed ? '<option value="exact" selected>Review proposed times</option>' : ''}</select></label><label class="offset-field">Offset<input name="offset" type="number" step="any" value="0" required></label><label class="offset-field">Elapsed unit<select name="unit"><option value="1">Milliseconds</option><option value="1000">Seconds</option><option value="60000" selected>Minutes</option><option value="3600000">Hours</option><option value="86400000">Days</option></select></label><label class="time-field full">Time / UTC<input type="datetime-local" name="time" step="0.001" value="${dateInput(operation === 'end' ? record.end : operation === 'close' ? new Date().toISOString() : record.start)}"></label><label class="exact-field">Start / UTC<input type="datetime-local" name="start" step="0.001" value="${dateInput(proposed?.start || record.start)}"></label><label class="exact-field">End / UTC<input type="datetime-local" name="end" step="0.001" value="${dateInput(proposed?.end || record.end)}" ${record.kind === 'event' || record.end === null ? 'disabled' : ''}></label></div><p class="time-edit-proposal" role="status"></p><p class="time-edit-locked" hidden></p><div class="modal-actions"><button type="button" id="cancel-time-edit">Cancel</button><button type="submit" class="primary-button">${icon('check')}Apply time change</button></div></form>`);
  const form = dialog.querySelector('form'), fields = form.elements, submit = form.querySelector('[type=submit]');
  const currentTime = () => operation === 'end' ? record.end : operation === 'close' ? new Date().toISOString() : record.start;
  setDateInput(fields.time, currentTime()); setDateInput(fields.start, proposed?.start || record.start); setDateInput(fields.end, proposed?.end || record.end, proposed?.end || record.end || record.start);
  let confirmed = false, uncertain = null, busy = false;
  host.recovery.warning(form);
  const propose = () => {
    const operation = fields.operation.value;
    if (operation === 'exact') {
      return validateRecordTimes(record, inputIso(fields.start.value), record.end === null ? null : inputIso(fields.end.value));
    }
    return changeRecordTime(record, operation, operation === 'move' ? Number(fields.offset.value) * Number(fields.unit.value) : inputIso(fields.time.value));
  };
  const update = () => {
    const operation = fields.operation.value;
    form.querySelectorAll('.offset-field').forEach(node => { node.hidden = operation !== 'move'; }); fields.offset.disabled = operation !== 'move';
    form.querySelector('.time-field').hidden = ['move', 'exact'].includes(operation); fields.time.required = !['move', 'exact'].includes(operation);
    form.querySelectorAll('.exact-field').forEach(node => { node.hidden = operation !== 'exact'; });
    try { const proposal = propose(); form.querySelector('.time-edit-proposal').textContent = `Proposed: ${proposal.payload.start}${record.kind === 'session' ? ` to ${proposal.payload.end || 'ongoing'}` : ''}`; submit.disabled = !proposal.changed || busy || confirmed || !!uncertain || !host.current(context); }
    catch (error) { form.querySelector('.time-edit-proposal').textContent = error.message; submit.disabled = true; }
    if (!host.current(context)) { const warning = form.querySelector('.time-edit-locked'); warning.hidden = false; warning.textContent = 'This draft belongs to a previous source or generation. No time change can be sent from this dialog.'; }
  };
  form.addEventListener('input', update); form.addEventListener('change', update); update();
  fields.operation.addEventListener('change', () => { operation = fields.operation.value; setDateInput(fields.time, currentTime()); update(); });
  const sourceTimer = setInterval(() => { if (!form.isConnected) clearInterval(sourceTimer); else update(); }, 250);
  form.querySelector('#cancel-time-edit').onclick = host.closeDialog;
  if (error) { host.formError(form, error); if (error.code === 'write_outcome_unknown') { uncertain = error.commandId; host.recovery.attachOutcome(form, uncertain); } }
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || confirmed || uncertain || !host.current(context)) return; busy = true; submit.disabled = true;
    try {
      const proposal = propose(); if (!proposal.changed) return;
      await host.commit(record, proposal.payload, { ...context, isDraftOpen: () => form.isConnected }); confirmed = true; if (form.isConnected) host.closeDialog();
    } catch (error) {
      if (!form.isConnected) return;
      host.formError(form, error);
      if (error.code === 'write_outcome_unknown') { uncertain = error.commandId; host.recovery.attachOutcome(form, uncertain); }
    } finally { busy = false; if (form.isConnected) { update(); host.recovery.warning(form); } }
  };
  host.updateIcons(); return dialog;
}
