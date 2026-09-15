"""Locale-independent, versioned string ordering using the shared casefold table."""
from __future__ import annotations

import unicodedata

from ..models.domain import DomainError, folded


def normalize_string_order(value, definition_version=1):
    if type(definition_version) is not int or definition_version not in (1, 2):
        raise DomainError('invalid_order', 'Ordering requires definition version 1 or 2.')
    if not isinstance(value, dict) or set(value) - {'order', 'caseSensitive'}:
        raise DomainError('invalid_order', 'Unknown string ordering option.')
    if definition_version == 1 and value:
        raise DomainError('invalid_order', 'String ordering options require definition version 2.')
    if value.get('order', 'codepoint') not in ('codepoint', 'natural'):
        raise DomainError('invalid_order', 'String order must be codepoint or natural.')
    if type(value.get('caseSensitive', True)) is not bool:
        raise DomainError('invalid_order', 'String ordering caseSensitive must be boolean.')
    return {'order': value.get('order', 'codepoint'), 'caseSensitive': value.get('caseSensitive', True)}


def _compare(left, right):
    return (left > right) - (left < right)


def _natural_compare(left, right):
    i = j = 0
    while i < len(left) and j < len(right):
        if '0' <= left[i] <= '9' and '0' <= right[j] <= '9':
            start_left, start_right = i, j
            while i < len(left) and '0' <= left[i] <= '9':
                i += 1
            while j < len(right) and '0' <= right[j] <= '9':
                j += 1
            # Compare magnitude by significant length and digits, never float/int conversion.
            a = left[start_left:i].lstrip('0') or '0'
            b = right[start_right:j].lstrip('0') or '0'
            result = _compare(len(a), len(b)) or _compare(a, b) or _compare(i - start_left, j - start_right)
            if result:
                return result
        else:
            result = _compare(left[i], right[j])
            if result:
                return result
            i += 1
            j += 1
    return _compare(len(left) - i, len(right) - j)


def compare_ordered_text(left, right, options=None):
    options = {} if options is None else options
    original_left, original_right = unicodedata.normalize('NFC', left), unicodedata.normalize('NFC', right)
    a, b = (original_left, original_right) if options.get('caseSensitive', True) else (folded(left), folded(right))
    result = _natural_compare(a, b) if options.get('order', 'codepoint') == 'natural' else _compare(a, b)
    return result or _compare(original_left, original_right)
