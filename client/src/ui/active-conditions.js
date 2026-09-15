import { filterFieldLabel } from './filter-editor-state.js';
import { icon } from '../utils/dom.js';
import '../styles/active-conditions.css';

const operators = { eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=', in: 'is one of', contains: 'contains' };
function label(node) {
  if (node.op === 'or') return `Any of ${node.args.length} conditions`;
  if (node.op === 'and') return `All of ${node.args.length} conditions`;
  if (node.op === 'not') return `Not (${label(node.arg)})`;
  if (node.op === 'overlaps') return `Overlaps ${node.from} to ${node.to}`;
  const field = filterFieldLabel(node.field);
  if (node.op === 'exists') return `${field} ${node.value ? 'exists' : 'is missing'}`;
  if (node.value === null && ['eq', 'ne'].includes(node.op)) return `${field} ${node.op === 'eq' ? 'is null' : 'has a value'}`;
  if (node.op === 'regex') return `${field} matches /${node.pattern}/${(node.flags || []).join('')}`;
  return `${field} ${operators[node.op] || node.op} ${JSON.stringify(node.values ?? node.value)}`;
}

export function activeConditionEntries(expression) {
  if (!expression) return [];
  const nodes = expression.root.op === 'and' ? expression.root.args : [expression.root];
  return nodes.map((node, index) => ({ index, label: label(node), node: structuredClone(node) }));
}

export function removeActiveCondition(expression, index) {
  if (!expression || !Number.isInteger(index)) throw new Error('Choose an existing condition.');
  const result = structuredClone(expression), nodes = result.root.op === 'and' ? result.root.args : [result.root];
  if (index < 0 || index >= nodes.length) throw new Error('The condition is no longer available.');
  nodes.splice(index, 1);
  if (!nodes.length) return null;
  result.root = nodes.length === 1 ? nodes[0] : { ...result.root, args: nodes };
  return result;
}

export function mountActiveConditions(parent, { onRemove, updateIcons } = {}) {
  const container = document.createElement('div'); container.className = 'active-conditions'; container.setAttribute('aria-label', 'Active conditions'); parent.append(container);
  return {
    render({ expression, sourceLabel, searchLabel } = {}) {
      container.replaceChildren();
      for (const [prefix, text] of [['Source', sourceLabel], ['Search', searchLabel]]) if (text) {
        const item = document.createElement('span'); item.className = 'active-condition-context'; item.textContent = `${prefix}: ${text}`; item.title = item.textContent; container.append(item);
      }
      for (const entry of activeConditionEntries(expression)) {
        const item = document.createElement('span'); item.className = 'active-condition';
        const text = document.createElement('span'); text.textContent = entry.label; text.title = entry.label;
        const button = document.createElement('button'); button.type = 'button'; button.innerHTML = icon('x'); button.setAttribute('aria-label', `Remove ${entry.label}`); button.title = `Remove ${entry.label}`;
        button.onclick = () => onRemove?.(removeActiveCondition(expression, entry.index)); item.append(text, button); container.append(item);
      }
      container.hidden = !container.childElementCount; updateIcons?.();
    },
    dispose() { container.remove(); },
  };
}
