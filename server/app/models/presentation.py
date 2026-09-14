from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator

from .domain import DomainError, read_json, validate_json, instant_ms

SCHEMA_ROOT = Path(__file__).resolve().parents[3] / "shared" / "schemas"
LABEL_FIELDS = {"/id", "/title", "/kind", "/sourceId", "/start", "/end", "/originalStart", "/originalEnd", "/order"}
MISSING = object()


@lru_cache(maxsize=2)
def schema_validator(name):
    return Draft202012Validator(read_json(SCHEMA_ROOT / name))


def pointer_parts(pointer, grouping=False):
    allowed = {"/sourceId", "/kind"} if grouping else LABEL_FIELDS
    if isinstance(pointer, str) and pointer in allowed:
        return pointer[1:].split("/")
    if not isinstance(pointer, str) or len(pointer) > 256 or not pointer.startswith("/data/"):
        raise DomainError("invalid_presentation", "Field requires a supported safe JSON pointer.")
    parts = pointer[1:].split("/")
    if not 2 <= len(parts) <= 9:
        raise DomainError("invalid_presentation", "Data pointers require one to eight segments.")
    decoded = []
    for part in parts:
        if not part or re.search(r"~(?![01])", part):
            raise DomainError("invalid_presentation", "JSON pointer contains an empty segment or invalid escape.")
        value = part.replace("~1", "/").replace("~0", "~")
        if value in {"__proto__", "prototype", "constructor"}:
            raise DomainError("invalid_presentation", "Unsafe JSON pointer segment.")
        decoded.append(value)
    return decoded


def pointer_value(record, pointer):
    value = record
    for part in pointer_parts(pointer):
        if not isinstance(value, dict) or part not in value:
            return MISSING
        value = value[part]
    return value


def _schema_errors(value, name):
    return [{"path": "/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in error.absolute_path),
             "code": "invalid_presentation", "message": error.message}
            for error in schema_validator(name).iter_errors(value)]


def presentation_errors(value):
    errors = _schema_errors(value, "presentation.schema.json")
    if errors:
        return errors
    bands = value.get("bandLayout")
    if bands is not None:
        if sum(band["role"] == "detail" for band in bands) > 1:
            errors.append({"path": "/bandLayout", "code": "band_capacity", "message": "One additional detail band is supported alongside context bands."})
        if (sum(band["role"] == "primary" for band in bands) != 1
                or sum(band["role"] == "overview" for band in bands) > 1
                or len({band["id"] for band in bands}) != len(bands)):
            errors.append({"path": "/bandLayout", "code": "band_roles", "message": "Unique bands require one primary and at most one overview."})
        for index, band in enumerate(bands):
            try:
                if band["role"] == "context" and not band.get("range"):
                    raise ValueError("Context bands require an initial range")
                if band["role"] == "detail" and ("range" in band or "fixedScale" in band):
                    raise ValueError("Detail bands inherit the primary range and scale")
                for bounds in [band["range"]] if "range" in band else []:
                    if instant_ms(bounds["from"]) >= instant_ms(bounds["to"]):
                        raise ValueError("Band range must be positive")
                for bounds in band.get("fixedScale", []):
                    if instant_ms(bounds["from"]) >= instant_ms(bounds["to"]):
                        raise ValueError("Magnified interval must be positive")
                if band.get("relativeAxis"):
                    instant_ms(band["relativeAxis"]["origin"])
            except (DomainError, ValueError) as error:
                errors.append({"path": f"/bandLayout/{index}", "code": "band_range", "message": str(error)})
    fields = []
    if "grouping" in value:
        fields.append(("/grouping/field", value["grouping"]["field"], True))
    fields.extend((f"/labels/fields/{index}", field, False)
                  for index, field in enumerate(value.get("labels", {}).get("fields", [])))
    fields.extend((f"/inspector/fields/{index}/field", entry["field"], False)
                  for index, entry in enumerate(value.get("inspector", {}).get("fields", [])))
    for path, field, grouping in fields:
        try:
            pointer_parts(field, grouping)
        except DomainError as error:
            errors.append({"path": path, "code": error.code, "message": error.message})
    seen = set()
    namespaces = set()
    for index, style in enumerate(value.get("sourceStyles", [])):
        source = style["sourceId"]
        if not source.strip() or source in seen:
            errors.append({"path": f"/sourceStyles/{index}/sourceId", "code": "invalid_presentation",
                           "message": "Source styles require unique nonblank source IDs."})
        seen.add(source)
        if "namespace" in style:
            namespace = unicodedata.normalize("NFC", style["namespace"])
            if not namespace.strip() or namespace in namespaces:
                errors.append({"path": f"/sourceStyles/{index}/namespace", "code": "invalid_presentation",
                               "message": "Namespace style selectors must be nonblank and unique after Unicode normalization."})
            namespaces.add(namespace)
    for index, entry in enumerate(value.get("inspector", {}).get("fields", [])):
        if not entry["label"].strip():
            errors.append({"path": f"/inspector/fields/{index}/label", "code": "invalid_presentation",
                           "message": "Inspector labels cannot be blank."})
    return errors


def validate_presentation(value):
    validate_json(value)
    errors = presentation_errors(value)
    if errors:
        raise DomainError("invalid_presentation", errors[0]["path"] + ": " + errors[0]["message"])
    return value


def validate_render(value):
    validate_json(value)
    errors = _schema_errors(value, "record-render.schema.json")
    if errors:
        raise DomainError("invalid_record", "render" + errors[0]["path"] + ": " + errors[0]["message"])
    return value
