"""Fail-closed, read-only translation of a bounded, field-scoped legacy grammar."""
import json
import re

from .filters import FIELD_TYPES, compile_expression


def migrate_legacy_filter(request, *, field_types=None):
    fields = FIELD_TYPES if field_types is None else field_types
    diagnostics, required = [], []

    def issue(code, message, offset=0, repair=False):
        diagnostics.append({'code': code, 'message': message, 'offset': offset, 'offsetUnit': 'unicode-codepoint', 'severity': 'warning' if repair else 'error'})
        if repair and code not in required:
            required.append(code)

    def result(draft=None):
        blocked = any(item['severity'] == 'error' for item in diagnostics)
        if not blocked and any(code not in acknowledgements for code in required):
            diagnostics.append({'code': 'intent_repair_required', 'message': 'Review and acknowledge the proposed semantic repairs before using this draft.', 'offset': 0, 'offsetUnit': 'unicode-codepoint', 'severity': 'warning'})
        return {'format': 'legacy-filter-migration', 'version': 1, 'classification': 'blocked' if blocked else 'intent-repair' if required else 'exact',
                'publishable': not blocked and all(code in acknowledgements for code in required), 'diagnostics': diagnostics,
                'requiredAcknowledgements': required, 'draft': None if blocked else draft}

    acknowledgements = []
    if not isinstance(request, dict) or set(request) - {'include', 'exclude', 'sortBy', 'relationshipMode', 'acknowledgements'}:
        issue('migration_input', 'Use explicit include, exclude and sortBy fields.')
        return result()
    include, exclude, sort_by = request.get('include', ''), request.get('exclude', ''), request.get('sortBy', 'NONE')
    acknowledgements, relationship_mode = request.get('acknowledgements', []), request.get('relationshipMode', 'independent')
    if (any(not isinstance(value, str) or len(value) > 4096 for value in (include, exclude, sort_by)) or not isinstance(acknowledgements, list)
            or len(acknowledgements) > 20 or any(not isinstance(value, str) or len(value) > 128 for value in acknowledgements) or relationship_mode not in ('independent', 'family')):
        issue('migration_input', 'Migration text must be bounded; choose independent or family relationships.')
        return result()

    def scalar_field(name):
        aliases = {'title': '/title', 'start': '/start', 'end': '/end', 'id': '/id', 'namespace': '/data/namespace'}
        pointer = name if name.startswith('/') else aliases.get(name, '/data/' + name)
        return pointer if pointer in fields and fields[pointer] != 'strings' else None

    ordinal = 0

    def leaf(text):
        nonlocal ordinal
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_./~]*)\s*([:=])([\s\S]*)', text.strip())
        if not match:
            raise ValueError('A condition must identify an approved field with : or =. Unscoped serialized-object patterns require manual field selection.')
        field, raw = scalar_field(match[1]), match[3].strip()
        if not field:
            raise ValueError(f'Unknown or nonscalar field: {match[1]}. Select its published schema first.')
        if not raw:
            raise ValueError('Empty condition values are ambiguous. Use an explicit typed empty-string rule.')
        ordinal += 1
        rule_id = f'migration-{ordinal}'
        if match[2] == '=':
            issue('help-equality-repair', 'The inspected legacy server does not implement the advertised equality syntax; this is an intent repair.', repair=True)
            value = json.loads(raw) if fields[field] not in ('string', 'date') or raw.startswith('"') else raw
            return {'op': 'eq', 'field': field, 'value': value, 'ruleId': rule_id}
        issue('typed-field-repair', 'Typed field matching replaces serialized-object matching; nested children and JSON punctuation no longer create parent hits.', repair=True)
        if fields[field] != 'string':
            raise ValueError('A legacy colon pattern on a non-text field requires an explicit typed equality/comparison repair.')
        if any(char in raw for char in '.*?^$()[]{}\\|+'):
            return {'op': 'regex', 'field': field, 'pattern': raw, 'flags': [], 'matchMode': 'search', 'dialect': 're2-common-v1', 'ruleId': rule_id}
        return {'op': 'contains', 'field': field, 'value': raw, 'caseSensitive': True, 'ruleId': rule_id}

    def tree(text):
        if not text.strip():
            return None
        alternatives, start, escaped, bracket, depth = [[]], 0, False, False, 0
        for index, char in enumerate(text):
            if escaped:
                escaped = False
                continue
            if char == '\\':
                escaped = True
                continue
            if char == '[':
                bracket = True
            if char == ']' and bracket:
                bracket = False
                continue
            if bracket:
                continue
            if char == '(':
                depth += 1
            if char == ')':
                depth -= 1
            if depth < 0:
                raise ValueError('Unbalanced pattern grouping.')
            if depth or char not in ';+|':
                continue
            if char == '|':
                raise ValueError('A top-level pipe is ambiguous between legacy include/exclude separation and regex alternation. Use separate include/exclude fields or a structured rule.')
            if not re.match(r'[A-Za-z_][A-Za-z0-9_./~]*\s*[:=]', text[index + 1:].lstrip()):
                raise ValueError('An unescaped separator or repetition is ambiguous. Rewrite it as a structured regex or AND/OR rule.')
            alternatives[-1].append(leaf(text[start:index]))
            start = index + 1
            if char == ';':
                alternatives.append([])
        if escaped or bracket or depth:
            raise ValueError('Unfinished escape, character class or grouping.')
        alternatives[-1].append(leaf(text[start:]))
        nodes = [args[0] if len(args) == 1 else {'op': 'and', 'args': args} for args in alternatives]
        return nodes[0] if len(nodes) == 1 else {'op': 'or', 'args': nodes}

    try:
        included, excluded = tree(include), tree(exclude)
        root = {'op': 'and', 'args': [included, {'op': 'not', 'arg': excluded}]} if included and excluded else included or ({'op': 'not', 'arg': excluded} if excluded else None)
        expression = {'version': 2, 'root': root} if root else None
        compile_expression(expression, field_types=fields)
        grouping = None
        if sort_by and sort_by != 'NONE':
            field = '/data/namespace' if sort_by == 'namespace' else scalar_field(sort_by)
            if not field:
                raise ValueError('Legacy grouping is not a registered scalar field.')
            grouping = {'field': field, 'direction': 'asc'}
            issue('deterministic-group-order', 'Groups use deterministic codepoint order instead of legacy encounter order.', repair=True)
        if relationship_mode == 'family':
            issue('explicit-family-context', 'Family retention includes authorized family members only; direct predicate hits and context remain distinct.', repair=True)
        return result({'definitionVersion': 2, 'relationshipMode': relationship_mode, 'expression': expression, 'grouping': grouping,
                       'groupOrder': {'order': 'codepoint', 'caseSensitive': True}, 'migration': {'format': 'legacy-filter-migration', 'version': 1,
                       'original': {'include': include, 'exclude': exclude, 'sortBy': sort_by}, 'acknowledged': [code for code in required if code in acknowledgements]}})
    except Exception as error:
        diagnostic = getattr(error, 'diagnostic', {})
        issue(diagnostic.get('code', 'migration_ambiguous'), str(error), diagnostic.get('offset', 0))
        return result()
