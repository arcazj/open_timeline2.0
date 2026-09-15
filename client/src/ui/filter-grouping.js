import { filterFieldLabel } from './filter-editor-state.js';

export function mountFilterGrouping(parent, { fieldTypes, grouping = null, groupOrder, definitionVersion = 1, onChange } = {}) {
  const container = document.createElement('fieldset'); container.className = 'filter-grouping';
  container.innerHTML = '<legend>Grouping</legend><div class="filter-grouping-fields"><label>Field<select aria-label="Group by field"></select></label><label>Direction<select aria-label="Group direction"><option value="asc">Ascending</option><option value="desc">Descending</option></select></label><label>Text order<select aria-label="Group text order"><option value="codepoint">Code point</option><option value="natural">Natural</option></select></label><label class="check-label"><input type="checkbox" aria-label="Case-sensitive groups">Case-sensitive</label></div>';
  parent.append(container);
  const [field, direction, order] = container.querySelectorAll('select'), sensitive = container.querySelector('input');
  field.add(new Option('All records', ''));
  for (const [path, type] of Object.entries(fieldTypes || {})) if (type !== 'strings') field.add(new Option(filterFieldLabel(path), path));
  let version = definitionVersion;
  const enabled = () => {
    container.disabled = version !== 2;
    direction.disabled = !field.value; order.disabled = sensitive.disabled = !field.value || fieldTypes[field.value] !== 'string';
  };
  const reset = value => {
    if (value.grouping?.field && ![...field.options].some(option => option.value === value.grouping.field)) field.add(new Option(`${filterFieldLabel(value.grouping.field)} (undeclared)`, value.grouping.field));
    field.value = value.grouping?.field ?? ''; direction.value = value.grouping?.direction ?? 'asc';
    order.value = value.groupOrder?.order ?? 'codepoint'; sensitive.checked = value.groupOrder?.caseSensitive ?? true; enabled();
  };
  reset({ grouping, groupOrder });
  container.addEventListener('change', event => { if (event.target === field && fieldTypes[field.value] !== 'string') { order.value = 'codepoint'; sensitive.checked = true; } enabled(); onChange?.(); });
  return {
    setVersion(value) { version = value; enabled(); }, reset,
    setFieldTypes(registry) {
      const selected = field.value; fieldTypes = registry; field.replaceChildren(new Option('All records', ''));
      for (const [path, type] of Object.entries(registry)) if (type !== 'strings') field.add(new Option(filterFieldLabel(path), path));
      if (selected && !Object.hasOwn(registry, selected)) field.add(new Option(`${filterFieldLabel(selected)} (undeclared)`, selected));
      field.value = selected; enabled();
    },
    value() { return { grouping: field.value ? { field: field.value, direction: direction.value } : null, groupOrder: { order: order.value, caseSensitive: sensitive.checked } }; },
    dispose() { container.remove(); },
  };
}
