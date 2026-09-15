"""Version-2 collapse and presentation-only continuation rows for fixed row pages."""
import unicodedata

from ..models.domain import DomainError


def collapsed_group_keys(value, definition_version=1):
    if not isinstance(value, list) or len(value) > 1000 or any(not isinstance(key, str) or len(key) > 4096 or not key.startswith(('number:', 'string:', 'boolean:', 'null:', 'missing:')) for key in value):
        raise DomainError('invalid_group', 'Collapsed groups require at most 1000 bounded typed group keys.')
    if definition_version != 2 and value:
        raise DomainError('invalid_group', 'Group collapse requires definition version 2.')
    keys = [unicodedata.normalize('NFC', key) for key in value]
    if len(set(keys)) != len(keys):
        raise DomainError('invalid_group', 'Collapsed group keys must be unique.')
    return set(keys)


def paginate_group_rows(layout, capacity):
    groups = {row['row']: row for row in layout['rows']}
    counts = {'logicalGroupTotal': len(groups),
              'collapsedGroupTotal': sum(bool(row.get('collapsed')) for row in layout['rows']),
              'hiddenItemTotal': sum(row['recordCount'] for row in layout['rows'] if row.get('collapsed'))}
    if not groups:
        return {**layout, **counts}
    if capacity < 2 and any(not row.get('collapsed') for row in layout['rows']):
        raise DomainError('row_height_limit', 'A grouped timeline needs space for a group header and at least one readable record row.')
    positions, rows, offset, current = {}, [], 0, None
    # Materialize header slots once before layout publication, never copies of records.
    for row in range(layout['totalRows']):
        group = groups.get(row)
        if group is not None:
            if not group.get('collapsed') and offset % capacity == capacity - 1:
                offset += 1
            current = group
            rows.append({**group, 'row': offset, 'continuation': False})
        elif current is not None and offset % capacity == 0:
            rows.append({**current, 'row': offset, 'continuation': True})
            offset += 1
        positions[row] = offset
        offset += 1
    for item in layout['items']:
        item['row'] = positions[item['row']]
    for enclosure in layout.get('enclosures', []):
        enclosure['startRow'] = positions[enclosure['startRow']]
        enclosure['endRow'] = positions[enclosure['endRow'] - 1] + 1
    return {**layout, **counts, 'rows': rows, 'totalRows': offset}
