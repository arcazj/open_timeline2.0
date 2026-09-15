const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function descriptorText(value) {
  if (value === undefined) return '(missing)';
  if (value === null) return '(null)';
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

export function descriptorNotes(record) {
  const data = record.data || {};
  return [data.description, data.legacy?.description, data.text, data.legacy?.text].find(value => value !== undefined && value !== null && value !== '') ?? '-';
}

export function descriptorFields(record) {
  const data = object(record.data) ? record.data : {};
  const legacy = record.extensions?.legacy && object(data.legacy) ? data.legacy : {};
  const values = new Map(Object.entries(legacy));
  for (const [key, value] of Object.entries(data)) {
    if (key !== 'legacy' || !record.extensions?.legacy) {
      if (!values.has(key)) values.set(key, value);
    }
  }
  values.delete('title');
  values.delete('description');
  if (values.get('text') === descriptorNotes(record)) values.delete('text');
  return [...values].map(([label, value]) => ({ label, value }));
}

export function needsLegacyDescriptor(record) {
  const value = record.data?.description ?? record.data?.legacy?.description;
  return value === undefined || value === null || String(value).trim() === '';
}

export function canRetainDescriptor({ navigationOnly, provider, previousQuery, query, selected, selectedContext, previousScope, scope, unavailable }) {
  return navigationOnly === true && !unavailable && !!selected && previousQuery?.definitionVersion === 2 && query?.definitionVersion === 2 &&
    previousQuery.generation === query.generation && previousQuery.revision === query.revision &&
    previousQuery.preferencesRevision === query.preferencesRevision &&
    typeof scope === 'string' && scope === previousScope && selectedContext?.provider === provider && selectedContext.context?.record === selected &&
    (selectedContext.queryId === previousQuery.queryId || selectedContext.retainedForQueryId === previousQuery.queryId);
}

export function markRetainedDescriptor(panel) {
  const scrollTop = panel.scrollTop;
  panel.querySelector('.descriptor-context')?.remove();
  for (const term of panel.querySelectorAll('.descriptor-data > dt[data-query-snapshot]')) {
    term.nextElementSibling?.remove(); term.remove();
  }
  if (!panel.querySelector('.descriptor-retained')) {
    const note = document.createElement('p'); note.className = 'descriptor-retained subtle'; note.setAttribute('role', 'status');
    note.textContent = 'Retained selection. Query matches are not re-evaluated for this time range.';
    panel.querySelector('.descriptor-metadata')?.before(note);
  }
  panel.scrollTop = scrollTop;
}

export function appendDescriptorValue(parent, value) {
  const text = descriptorText(value);
  if (text.length > 4096) {
    const details = document.createElement('details'), summary = document.createElement('summary'), content = document.createElement('pre');
    summary.textContent = `Full value (${[...text].length.toLocaleString()} characters)`;
    content.textContent = text;
    details.append(summary, content); parent.append(details);
  } else {
    parent.textContent = text;
  }
}

export function appendDescriptorFacts(parent, fields, className = '') {
  const facts = document.createElement('dl'); facts.className = `record-facts ${className}`.trim();
  for (const { label, value } of fields) {
    const term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label; appendDescriptorValue(detail, value);
    const expanded = detail.querySelector('details'); if (expanded) expanded.dataset.descriptorKey = `${className}:${label}`;
    facts.append(term, detail);
  }
  parent.append(facts); return facts;
}

export function appendDescriptorContext(parent, context, select) {
  if (!context) return;
  const section = document.createElement('section'); section.className = 'descriptor-context';
  const fields = [], provenance = context.provenance || {};
  const roles = { direct: 'Filter result', result: 'Filter result', 'filter-result': 'Filter result', ancestor: 'Ancestor context', 'ancestor-context': 'Ancestor context', family: 'Family context', 'family-context': 'Family context' };
  if (provenance.role) fields.push({ label: 'Query role', value: roles[provenance.role] || provenance.role });
  if (context.searchActive === true && provenance.match === true) fields.push({ label: 'Search', value: 'Matching record' });
  if (Number.isSafeInteger(provenance.descendantMatchCount) && provenance.descendantMatchCount > 0) fields.push({ label: 'Matching descendants', value: provenance.descendantMatchCount });
  for (const [key, label] of [['fields', 'Matched fields'], ['ruleIds', 'Matched rules']]) {
    const values = context.explanation?.[key] ?? context.explanation?.rules?.map(rule => key === 'fields' ? rule.field : rule.ruleId);
    if (Array.isArray(values)) {
      const distinct = [...new Set(values.filter(value => typeof value === 'string'))];
      if (distinct.length) fields.push({ label, value: distinct.join(', ') });
    }
  }
  if (fields.length) appendDescriptorFacts(section, fields);
  if (Array.isArray(context.ancestors) && context.ancestors.length) {
    const navigation = document.createElement('nav'); navigation.setAttribute('aria-label', 'Parent sessions');
    const heading = document.createElement('h4'); heading.textContent = 'Parent sessions'; navigation.append(heading);
    for (const ancestor of context.ancestors) {
      const action = document.createElement('button'); action.type = 'button'; action.className = 'descriptor-parent'; action.textContent = ancestor.title;
      action.title = 'Open parent descriptor'; action.addEventListener('click', () => select(ancestor.id)); navigation.append(action);
    }
    section.append(navigation);
  }
  if (context.ancestorsTruncated || context.explanation?.truncated) {
    const note = document.createElement('p'); note.className = 'subtle'; note.textContent = 'Additional context is not included in this result.'; section.append(note);
  }
  if (section.childNodes.length) parent.append(section);
}

export function mountLegacyDescriptor(parent, { record, load, current = () => true }) {
  const section = document.createElement('section'); section.className = 'legacy-descriptor';
  section.setAttribute('aria-label', 'Linked legacy descriptor');
  const heading = document.createElement('h4'), status = document.createElement('p'), action = document.createElement('button'), content = document.createElement('div');
  heading.textContent = 'Linked descriptor'; status.className = 'subtle'; status.setAttribute('role', 'status');
  action.type = 'button'; action.className = 'descriptor-load'; action.textContent = 'Load descriptor';
  section.append(heading, status, action, content); parent.append(section);
  let controller, timer, disposed = false;
  const active = () => !disposed && section.isConnected && current();
  const fetchDescriptor = async () => {
    controller?.abort(); clearTimeout(timer); const requestController = controller = new AbortController();
    const signal = controller.signal;
    action.disabled = true; status.textContent = 'Loading descriptor...'; section.setAttribute('aria-busy', 'true');
    const requestTimer = timer = setTimeout(() => requestController.abort(), 8000);
    try {
      const result = await load(record.id, { signal });
      if (!active() || signal.aborted) return;
      content.replaceChildren();
      if (result.status === 'current' && object(result.descriptor)) {
        const descriptor = result.descriptor;
        const fields = Object.entries(descriptor).filter(([key]) => key !== 'data').map(([label, value]) => ({ label, value }));
        if (object(descriptor.data)) fields.push(...Object.entries(descriptor.data).map(([label, value]) => ({ label, value })));
        appendDescriptorFacts(content, fields, 'linked-descriptor-fields');
        status.textContent = 'Read-only live source descriptor'; action.textContent = 'Refresh descriptor';
      } else {
        status.textContent = result.reason || 'No matching descriptor sidecar.'; action.textContent = 'Retry descriptor';
      }
    } catch (error) {
      if (!active()) return;
      status.textContent = signal.aborted ? 'Descriptor request timed out. Record details remain available.' : `Descriptor unavailable: ${error.message}`;
      action.textContent = 'Retry descriptor';
    } finally {
      clearTimeout(requestTimer);
      if (active()) { action.disabled = false; section.setAttribute('aria-busy', 'false'); }
    }
  };
  action.addEventListener('click', fetchDescriptor);
  if (needsLegacyDescriptor(record)) void fetchDescriptor();
  else status.textContent = 'A description is included in the selected record.';
  return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
}
