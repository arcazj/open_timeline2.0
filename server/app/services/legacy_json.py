"""Narrow, opt-in compatibility with the observed json-simple file dialect."""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..models.domain import DomainError, iso_from_ms, instant_ms, parse_json, validate_json


MONTHS = {name: index + 1 for index, name in enumerate(
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"))}
JAVA_DATE = re.compile(
    r"^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?([A-Z][a-z]{2}) (\d{1,2}) "
    r"(\d{2}):(\d{2}):(\d{2})(?: ([A-Za-z_+:/0-9-]+))? (\d{4})$")
JAVA_BROWSER_DATE = re.compile(
    r"^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?([A-Z][a-z]{2}) (\d{1,2}) (\d{4}) "
    r"(\d{2}):(\d{2}):(\d{2}) (UTC|GMT(?:[+-]\d{4})?)$")


def parse_legacy_json(raw: bytes, dialect="strict"):
    if dialect not in ("strict", "legacy-json"):
        raise DomainError("legacy_dialect", "Select strict or legacy-json explicitly.")
    if dialect == "strict":
        return parse_json(raw), []
    try:
        return parse_json(raw), []
    except DomainError:
        pass
    try:
        text = raw.decode("utf-8")
    except UnicodeError as error:
        raise DomainError("invalid_json", "Legacy files require UTF-8.", 400) from error
    diagnostics = []
    # This lexical pass only removes a comma immediately before a closing
    # delimiter outside strings. The standard JSON parser still owns grammar.
    result, quoted, escaped, removals, depth = [], False, False, 0, 0
    for index, char in enumerate(text):
        if quoted:
            result.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
            continue
        if char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
            if depth > 64:
                raise DomainError("invalid_json", "JSON nesting exceeds 64 levels.", 400)
        elif char in "]}":
            depth -= 1
        elif char == ",":
            look = index + 1
            while look < len(text) and text[look] in " \t\r\n":
                look += 1
            previous = index - 1
            while previous >= 0 and text[previous] in " \t\r\n":
                previous -= 1
            if (look < len(text) and text[look] in "]}" and previous >= 0
                    and text[previous] not in "[{,:"):
                removals += 1
                continue
        result.append(char)
    duplicates = {}

    def members(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                duplicates[key] = duplicates.get(key, 0) + 1
            value[key] = item
        return value

    def constant(_value):
        raise ValueError("Non-finite number")

    try:
        value = json.loads("".join(result), object_pairs_hook=members, parse_constant=constant)
        validate_json(value)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise DomainError("invalid_json", "Malformed legacy JSON; only trailing commas and duplicate keys are allowed.", 400) from error
    if removals:
        diagnostics.append({"code": "legacy_trailing_commas", "count": removals})
    if duplicates:
        diagnostics.append({"code": "legacy_duplicate_members", "count": sum(duplicates.values()),
                            "policy": "last-member-wins", "keys": sorted(duplicates)[:32]})
    return value, diagnostics


def legacy_instant(value, *, default_timezone=None, abbreviations=None):
    """Parse only documented forms; never use the host's ambient timezone."""
    if not isinstance(value, str) or not value.strip() or len(value) > 128:
        raise DomainError("legacy_date", "A nonempty, bounded date string is required.")
    text = value.strip()
    try:
        return iso_from_ms(instant_ms(text))
    except DomainError:
        pass
    match = JAVA_DATE.fullmatch(text)
    browser = JAVA_BROWSER_DATE.fullmatch(text)
    zone = None
    try:
        if match:
            month, day, hour, minute, second, zone, year = match.groups()
            parsed = datetime(int(year), MONTHS[month], int(day), int(hour), int(minute), int(second))
        elif browser:
            month, day, year, hour, minute, second, zone = browser.groups()
            parsed = datetime(int(year), MONTHS[month], int(day), int(hour), int(minute), int(second))
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?", text):
            parsed = datetime.fromisoformat(text)
        else:
            raise ValueError()
        selected = zone or default_timezone
        if not selected:
            raise DomainError("legacy_timezone_required", "A timezone must be explicitly configured for dates without offsets.")
        if selected in ("UTC", "GMT", "Z"):
            tz = timezone.utc
        elif re.fullmatch(r"GMT[+-]\d{4}", selected):
            hours, minutes = int(selected[4:6]), int(selected[6:8])
            if hours > 23 or minutes > 59:
                raise ValueError()
            tz = timezone(timedelta(minutes=(hours * 60 + minutes) * (1 if selected[3] == "+" else -1)))
        elif selected in (abbreviations or {}):
            offset = abbreviations[selected]
            if type(offset) is not int or not -1439 <= offset <= 1439:
                raise ValueError()
            tz = timezone(timedelta(minutes=offset))
        else:
            if "/" not in selected:
                raise DomainError("legacy_timezone_ambiguous", f"Timezone {selected} requires an explicit abbreviation-to-offset mapping.")
            tz = ZoneInfo(selected)
        aware = parsed.replace(tzinfo=tz)
        if isinstance(tz, ZoneInfo):
            if aware.utcoffset() != parsed.replace(tzinfo=tz, fold=1).utcoffset():
                raise DomainError("legacy_date_ambiguous", "A DST transition requires an explicit offset in the source date.")
            if aware.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None) != parsed:
                raise DomainError("legacy_date_ambiguous", "The local date does not exist in its configured timezone.")
        return aware.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, KeyError, OverflowError, ZoneInfoNotFoundError) as error:
        raise DomainError("legacy_date", "Unsupported or invalid legacy date; no automatic date repair was applied.") from error
