"""Versioned, bounded RE2 subset shared with the offline JavaScript provider."""
from __future__ import annotations

import unicodedata
from functools import lru_cache
from pathlib import Path

import re2

from ..models.domain import DomainError, read_json

LIMITS = read_json(Path(__file__).resolve().parents[3] / "shared/fixtures/regex-dialect.json")
REGEX_CAPABILITIES = {
    "dialect": LIMITS["dialect"], "engines": LIMITS["engines"], "flags": ["i", "m", "s"],
    "matchModes": ["search", "full"], "patternCodepoints": LIMITS["patternCodepoints"],
    "regexNodes": LIMITS["regexNodes"], "searchFields": LIMITS["searchFields"], "unicodeProperties": False,
    "expansionUnits": LIMITS["expansionUnits"], "fieldBytes": LIMITS["fieldBytes"],
    "aggregateBytes": LIMITS["aggregateBytes"], "aggregateWork": LIMITS["aggregateWork"],
    "subjectNormalization": "NFC", "casefold": "engine-simple-common-15.1",
    "incompatibleCasefoldRanges": LIMITS["incompatibleCasefoldRanges"],
}
_DEFAULT_FLAGS = object()


def regex_error(code, message, *, offset=None, field=None, rule_id=None,
                hint="Use the documented RE2 common syntax.", status=422):
    error = DomainError(code, message, status)
    error.diagnostic = {"code": code, "offset": offset, "offsetUnit": "unicode-codepoint", "hint": hint}
    if field is not None:
        error.diagnostic["field"] = field
    if rule_id is not None:
        error.diagnostic["ruleId"] = rule_id
    raise error


def _incompatible_casefold(point):
    return any(left <= point <= right for left, right in LIMITS["incompatibleCasefoldRanges"])


class RegexBudget:
    def __init__(self, *, max_work=LIMITS["aggregateWork"], max_bytes=LIMITS["aggregateBytes"], check_cancelled=None):
        if type(max_work) is not int or not 0 < max_work <= 9007199254740991 or type(max_bytes) is not int or not 0 < max_bytes <= 9007199254740991:
            raise TypeError("Regex budgets must be positive safe integers")
        self.max_work, self.max_bytes, self.check_cancelled = max_work, max_bytes, check_cancelled
        self.bytes = self.work = 0

    def consume(self, value, cost, context):
        if self.check_cancelled is not None:
            self.check_cancelled()
        size = len(value.encode("utf-8"))
        self.bytes += size
        self.work += max(1, len(value)) * cost
        if size > LIMITS["fieldBytes"] or self.bytes > self.max_bytes or self.work > self.max_work:
            regex_error("regex_resource_limit", "Regex evaluation exceeded its field or aggregate work budget", **context,
                        status=413, hint="Narrow the time range, source selection, fields, or pattern.")

    @property
    def usage(self):
        return {"bytes": self.bytes, "work": self.work}


def create_regex_budget(**options):
    return RegexBudget(**options)


def validate_regex(pattern, flags=_DEFAULT_FLAGS, match_mode="search", dialect=LIMITS["dialect"], **context):
    def fail(code, message, offset=None, hint="Use the documented RE2 common syntax."):
        regex_error(code, message, **context, offset=offset, hint=hint, status=413 if code == "regex_resource_limit" else 422)

    flags = [] if flags is _DEFAULT_FLAGS else flags
    if not isinstance(pattern, str) or not 1 <= len(pattern) <= LIMITS["patternCodepoints"]:
        fail("invalid_regex", "Regex requires 1-512 Unicode codepoints")
    if not isinstance(flags, list) or any(flag not in ("i", "m", "s") for flag in flags) or len(set(flags)) != len(flags):
        fail("invalid_regex_flags", "Regex flags must be unique i, m, or s values")
    if match_mode not in ("search", "full"):
        fail("invalid_regex", "Regex matchMode must be search or full")
    if dialect != LIMITS["dialect"]:
        fail("unsupported_regex_dialect", "Unsupported regex dialect")

    def check_point(point, offset):
        if 0xd800 <= point <= 0xdfff or point > 0x10ffff:
            fail("invalid_regex", "Regex contains an invalid Unicode scalar", offset)
        if "i" in flags and _incompatible_casefold(point):
            fail("regex_unicode_version", "This character has incompatible case folding between the pinned engines", offset,
                 "Use case-sensitive regex or literal search for this character.")

    stack, in_class, class_content, class_start = [], False, False, 0
    weights, index = [{"total": 0, "last": 0}], 0

    def atom(units):
        weights[-1]["total"] += units
        weights[-1]["last"] = units
    while index < len(pattern):
        char = pattern[index]
        check_point(ord(char), index)
        if char == "\\":
            start = index
            index += 1
            if index == len(pattern):
                fail("invalid_regex", "Regex ends with an unfinished escape", start)
            next_char = pattern[index]
            if next_char in "0123456789":
                fail("unsupported_regex_syntax", "Backreferences and octal escapes are not supported", start,
                     "Use an explicit character or hexadecimal escape.")
            if next_char in "pPCQEkguUZe":
                fail("unsupported_regex_syntax", "This escape is outside the shared regex dialect", start)
            if next_char == "x":
                hexadecimal = ""
                if pattern[index + 1:index + 2] == "{":
                    index += 2
                    while index < len(pattern) and pattern[index] != "}":
                        hexadecimal += pattern[index]
                        index += 1
                    if index == len(pattern) or not hexadecimal or len(hexadecimal) > 6:
                        fail("invalid_regex", "Invalid hexadecimal escape", start)
                else:
                    hexadecimal = pattern[index + 1:index + 3]
                    index += 2
                    if len(hexadecimal) != 2:
                        fail("invalid_regex", "Hexadecimal escape requires two digits or braces", start)
                if any(value not in "0123456789abcdefABCDEF" for value in hexadecimal):
                    fail("invalid_regex", "Invalid hexadecimal escape", start)
                check_point(int(hexadecimal, 16), start)
            elif "A" <= next_char <= "Z" or "a" <= next_char <= "z":
                if next_char not in "afnrtvAbBdDsSwWz":
                    fail("unsupported_regex_syntax", "Unsupported regex escape", start)
            if in_class:
                class_content = True
            else:
                atom(1)
            index += 1
            continue
        if in_class:
            if char == "]" and class_content:
                in_class = False
                atom(index - class_start + 1)
            elif not (index == class_start + 1 and char == "^"):
                class_content = True
            index += 1
            continue
        if char == "[":
            in_class, class_start, class_content = True, index, False
        elif char == "(":
            if pattern[index + 1:index + 2] == "?" and pattern[index + 2:index + 3] != ":":
                fail("unsupported_regex_syntax", "Lookaround, inline flags and named groups are not supported", index,
                     "Use a Boolean filter group and the explicit i, m, s flags.")
            stack.append(index)
            weights.append({"total": 0, "last": 0})
            if pattern[index + 1:index + 3] == "?:":
                index += 2
        elif char == ")":
            if not stack:
                fail("invalid_regex", "Unmatched closing parenthesis", index)
            stack.pop()
            atom(weights.pop()["total"] + 2)
        elif char == "{":
            end = index + 1
            while end < len(pattern) and pattern[end] in "0123456789,":
                end += 1
            if pattern[end:end + 1] == "}" and end > index + 1:
                parts = pattern[index + 1:end].split(",")
                if len(parts) <= 2 and parts[0] and all(not part or int(part) <= 1000 for part in parts):
                    repeated = max(0, int(parts[-1] or parts[0]) - 1) * weights[-1]["last"] + (2 if len(parts) == 2 and not parts[1] else 0)
                    weights[-1]["total"] += repeated
                    weights[-1]["last"] += repeated
                    index = end
                else:
                    atom(1)
            else:
                atom(1)
        elif char in "*+?":
            weights[-1]["total"] += 2
            weights[-1]["last"] += 2
        elif char == "|":
            atom(1)
            weights[-1]["last"] = 0
        else:
            atom(1)
        index += 1
    if in_class:
        fail("invalid_regex", "Unclosed character class", class_start)
    if stack:
        fail("invalid_regex", "Unclosed parenthesis", stack[-1])
    cost = weights[0]["total"]
    if cost > LIMITS["expansionUnits"]:
        fail("regex_resource_limit", "Regex exceeds the shared expansion budget", None, "Reduce repetition or alternatives in the pattern.")
    return {"pattern": pattern, "flags": sorted(flags), "matchMode": match_mode,
            "dialect": dialect, "cost": max(1, cost)}


@lru_cache(maxsize=LIMITS["cacheEntries"])
def _engine(pattern, flags, match_mode, dialect, engine_version):
    options = re2.Options()
    options.max_mem = LIMITS["engineMemoryBytes"]
    options.log_errors = False
    options.case_sensitive = "i" not in flags
    options.dot_nl = "s" in flags
    options.never_capture = True
    # RE2's one_line option only affects POSIX syntax. A scoped engine modifier
    # supplies the explicit public m flag without changing the saved pattern.
    compiled = re2.compile("(?m:" + pattern + ")" if "m" in flags else pattern, options=options)
    if compiled.programsize > LIMITS["programInstructions"]:
        regex_error("regex_resource_limit", "Regex compiled program exceeds its instruction budget", status=413,
                    hint="Reduce repetition or alternatives in the pattern.")
    return compiled


def compile_regex(pattern, *, flags=_DEFAULT_FLAGS, match_mode="search", dialect=LIMITS["dialect"], budget=None, **context):
    flags = [] if flags is _DEFAULT_FLAGS else flags
    specification = validate_regex(pattern, flags, match_mode, dialect, **context)
    budget = create_regex_budget() if budget is None else budget
    try:
        compiled = _engine(pattern, tuple(sorted(flags)), match_mode, dialect, LIMITS["engines"]["python"])
    except DomainError as error:
        error.diagnostic.update({"field": context["field"]} if "field" in context else {})
        error.diagnostic.update({"ruleId": context["rule_id"]} if "rule_id" in context else {})
        raise
    except re2.error:
        regex_error("invalid_regex", "Invalid RE2 expression", **context)
    except Exception:
        regex_error("regex_engine_failure", "The bounded regex engine could not compile this expression", **context,
                    status=503, hint="Simplify the pattern or retry; no alternate regex engine is used.")
    operation = compiled.fullmatch if match_mode == "full" else compiled.search

    def test(raw, **evaluation_context):
        active_context = {**context, **evaluation_context}
        subject = unicodedata.normalize("NFC", raw)
        budget.consume(subject, specification["cost"], active_context)
        if "i" in flags:
            for index, char in enumerate(subject):
                if _incompatible_casefold(ord(char)):
                    regex_error("regex_unicode_version", "A selected field contains a character with incompatible engine case folding", **active_context,
                                offset=index, hint="Use case-sensitive regex or literal search for this field.")
        try:
            return operation(subject) is not None
        except Exception:
            regex_error("regex_engine_failure", "The bounded regex engine failed during evaluation", **active_context,
                        status=503, hint="Retry with a narrower scope; no alternate regex engine is used.")
    return {**specification, "emptyMatch": operation("") is not None, "test": test}
