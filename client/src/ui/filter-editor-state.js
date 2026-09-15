const names = { title: 'Title', start: 'Start time', end: 'End time', sourceId: 'Source', kind: 'Record type', namespace: 'Namespace', status: 'Status', type: 'Type', description: 'Description', text: 'Text', priority: 'Priority', order: 'Order', parentSessionId: 'Parent session', id: 'Record ID' };

export function filterFieldLabel(field) {
  const parts = field.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts[0] === 'data') parts.shift();
  return parts.map(part => Object.hasOwn(names, part) ? names[part] : part.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./u, letter => letter.toUpperCase())).join(' / ');
}

export function filterOperator(node) {
  if (node.op === 'eq' && node.value === null) return 'isNull';
  if (node.op === 'ne' && node.value === null) return 'hasValue';
  if (node.op === 'exists' && node.value === false) return 'isMissing';
  return node.op;
}

export function changeFilterOperator(node, operator, type) {
  const identity = { ...(node.ruleId === undefined ? {} : { ruleId: node.ruleId }), ...(node.field === undefined ? {} : { field: node.field }) };
  for (const key of Object.keys(node)) delete node[key];
  Object.assign(node, identity);
  if (operator === 'isNull' || operator === 'hasValue') Object.assign(node, { op: operator === 'isNull' ? 'eq' : 'ne', value: null });
  else if (operator === 'isMissing') Object.assign(node, { op: 'exists', value: false });
  else if (operator === 'exists') Object.assign(node, { op: 'exists', value: true });
  else if (operator === 'in') Object.assign(node, { op: operator, values: [] });
  else if (operator === 'regex') Object.assign(node, { op: operator, pattern: '', flags: [], matchMode: 'search', dialect: 're2-common-v1' });
  else if (operator === 'overlaps') { delete node.field; Object.assign(node, { op: operator, from: new Date().toISOString(), to: new Date(Date.now() + 3600000).toISOString() }); }
  else Object.assign(node, { op: operator, value: type === 'number' ? 0 : type === 'boolean' ? false : type === 'date' ? new Date().toISOString() : '' });
  return node;
}
