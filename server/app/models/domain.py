from __future__ import annotations

import copy
import hashlib
import hmac
import json
import re
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import jsonschema_rs
from jsonschema import FormatChecker
import rfc8785


class DomainError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
CASEFOLD_PATH = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "casefold.json"
ISO_PATTERN = re.compile(r"^(\d{4}|-\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$")
MIN_INSTANT_MS = -377705116800000
MAX_INSTANT_MS = 253402300799999
COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
SURROGATE_PATTERN = re.compile("[\ud800-\udfff]")
UUID_FORMAT_CHECKER = FormatChecker(formats=["uuid"])
MAX_SAFE_INT = 9007199254740991
RECORD_FIELDS = {
    "id", "workspaceId", "kind", "title", "start", "end", "parentSessionId", "order",
    "sourceId", "groupIds", "tags", "data", "render", "extensions", "schemaId",
    "schemaVersion", "originalStart", "originalEnd", "version", "createdAt", "updatedAt",
    "createdBy", "updatedBy", "deletedAt",
}
MUTABLE_FIELDS = RECORD_FIELDS - {
    "id", "workspaceId", "version", "createdAt", "updatedAt", "createdBy", "updatedBy", "deletedAt"
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def instant_ms(value: str) -> int:
    if not isinstance(value, str) or not ISO_PATTERN.fullmatch(value):
        raise DomainError("invalid_datetime", "Dates require a timezone and millisecond-or-coarser ISO precision.")
    if not value.endswith("Z") and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59):
        raise DomainError("invalid_datetime", "Timezone offset is outside its valid range.")
    try:
        year, month, day, hour, minute, second, fraction, offset = ISO_PATTERN.fullmatch(value).groups()
        year = int(year)
        if not -9999 <= year <= 9999 or value.startswith('-000000'):
            raise ValueError()
        # Gregorian 400-year cycles let datetime validate ancient civil dates
        # without inventing a separate calendar or relying on platform strftime.
        cycles = (year - 1) // 400
        value_dt = datetime(year - cycles * 400, int(month), int(day), int(hour), int(minute), int(second),
                            int((fraction or '').ljust(3, '0')) * 1000, tzinfo=timezone.utc)
        delta = value_dt - EPOCH
        milliseconds = (delta.days + cycles * 146097) * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000
        if offset != 'Z':
            milliseconds -= (int(offset[1:3]) * 60 + int(offset[4:])) * 60000 * (1 if offset[0] == '+' else -1)
        if not MIN_INSTANT_MS <= milliseconds <= MAX_INSTANT_MS:
            raise ValueError()
        return milliseconds
    except (ValueError, OverflowError) as error:
        raise DomainError("invalid_datetime", "Date is outside the supported Gregorian range.") from error


def iso_from_ms(value: int) -> str:
    if not MIN_INSTANT_MS <= value <= MAX_INSTANT_MS:
        raise DomainError('invalid_datetime', 'Date is outside the supported Gregorian range.')
    days, remainder = divmod(int(value), 86400000)
    cycles, days = divmod(days + 719162, 146097)
    result = datetime(1, 1, 1) + timedelta(days=days, milliseconds=remainder)
    year = result.year + cycles * 400
    label = f'-{abs(year):06d}' if year < 0 else f'{year:04d}'
    return f"{label}-{result.month:02d}-{result.day:02d}T{result.hour:02d}:{result.minute:02d}:{result.second:02d}.{result.microsecond // 1000:03d}Z"


def instant_format(value):
    try:
        instant_ms(value)
        return True
    except DomainError:
        return False


def _members(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DomainError("invalid_json", f"Duplicate JSON member: {key}", 400)
        result[key] = value
    return result


def _constant(value):
    raise DomainError("invalid_json", f"Non-finite JSON number: {value}", 400)


def validate_json(value: Any, depth: int = 0):
    if depth > 64:
        raise DomainError("invalid_json", "JSON nesting exceeds 64 levels.", 400)
    if isinstance(value, str):
        if SURROGATE_PATTERN.search(value):
            raise DomainError("invalid_json", "Lone surrogate code points are not supported.", 400)
    elif isinstance(value, bool) or value is None:
        pass
    elif isinstance(value, int):
        if abs(value) > MAX_SAFE_INT:
            raise DomainError("invalid_json", "JSON integers must be interoperable safe integers.", 400)
    elif isinstance(value, float):
        import math
        if not math.isfinite(value):
            raise DomainError("invalid_json", "JSON numbers must be finite.", 400)
        if value.is_integer() and abs(value) > MAX_SAFE_INT:
            raise DomainError("invalid_json", "JSON integers must be interoperable safe integers.", 400)
    elif isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise DomainError("invalid_json", "JSON object keys must be strings.", 400)
            validate_json(key, depth + 1)
            validate_json(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            validate_json(item, depth + 1)
    else:
        raise DomainError("invalid_json", "Value is not a JSON value.", 400)


def parse_json(data: bytes | str):
    try:
        if isinstance(data, (bytes, bytearray)):
            data = data.decode("utf-8")
        result = json.loads(data, object_pairs_hook=_members, parse_constant=_constant)
        validate_json(result)
        return result
    except (ValueError, UnicodeError, RecursionError) as error:
        raise DomainError("invalid_json", "Malformed UTF-8 JSON.", 400) from error


def json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def content_checksum(bundle):
    content = {key: bundle[key] for key in ("records", "zones", "models", "filters", "settings", "sources",
                                           "groups", "schemas", "views", "preferences", "defaults") if key in bundle}
    return hashlib.sha256(rfc8785.dumps(content)).hexdigest()


def read_json(path: Path):
    return parse_json(path.read_bytes())


def valid_id(value: str) -> str:
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError()
        return value
    except (ValueError, TypeError, AttributeError) as error:
        raise DomainError("invalid_id", "Record IDs must be canonical UUIDs.") from error


def _text(value, name: str, limit: int = 500, empty: bool = False):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise DomainError("invalid_record", f"{name} must contain 1 to {limit} Unicode code points.")
    return value


def _validate_record_fields(record: dict, workspace: str) -> dict:
    if not isinstance(record, dict) or set(record) != RECORD_FIELDS:
        raise DomainError("invalid_record", "Record fields must match the complete canonical representation; use extensions for custom metadata.")
    valid_id(record.get("id"))
    if record.get("workspaceId") != workspace:
        raise DomainError("invalid_record", "Record workspace does not match the selected workspace.")
    if record.get("kind") not in ("event", "session"):
        raise DomainError("invalid_record", "Record kind must be event or session.")
    _text(record.get("title"), "title")
    start = instant_ms(record.get("start"))
    end = record.get("end")
    if record["kind"] == "event" and end is not None:
        raise DomainError("invalid_record", "Point events must have a null end.")
    if end is not None and instant_ms(end) < start:
        raise DomainError("invalid_record", "Session end precedes its start.")
    _text(record.get("sourceId"), "sourceId", 128)
    for name in ("groupIds", "tags"):
        values = record.get(name)
        if not isinstance(values, list) or len(values) > 100:
            raise DomainError("invalid_record", f"{name} must be an array with at most 100 values.")
        for value in values:
            _text(value, name, 100 if name == "tags" else 128)
        if len(values) != len(set(values)):
            raise DomainError("invalid_record", f"{name} contains duplicate values.")
    for name in ("data", "extensions"):
        if not isinstance(record.get(name), dict):
            raise DomainError("invalid_record", f"{name} must be an object.")
    from .presentation import validate_render
    validate_render(record.get("render"))
    if isinstance(record.get("order"), bool) or not isinstance(record.get("order"), int):
        raise DomainError("invalid_record", "order must be an integer.")
    if isinstance(record.get("version"), bool) or not isinstance(record.get("version"), int) or record["version"] < 1:
        raise DomainError("invalid_record", "version must be a positive integer.")
    for name in ("createdAt", "updatedAt"):
        instant_ms(record.get(name))
    for name in ("originalStart", "originalEnd", "deletedAt"):
        if record.get(name) is not None:
            instant_ms(record[name])
    for name in ("createdBy", "updatedBy"):
        _text(record.get(name), name, 128)
    if record.get("schemaId") is not None:
        _text(record["schemaId"], "schemaId", 128)
    if record.get("schemaVersion") is not None and (not isinstance(record["schemaVersion"], int) or isinstance(record["schemaVersion"], bool) or record["schemaVersion"] < 1):
        raise DomainError("invalid_record", "schemaVersion must be null or a positive integer.")
    if (record.get("schemaId") is None) != (record.get("schemaVersion") is None):
        raise DomainError("schema_reference", "Schema ID and version must occur together.")
    parent_id = record.get("parentSessionId")
    if parent_id is not None:
        valid_id(parent_id)
        if parent_id == record["id"]:
            raise DomainError("invalid_parent", "A record cannot parent itself.")
    if len(json_bytes(record)) > 256 * 1024:
        raise DomainError("record_too_large", "Record exceeds 256 KiB.", 413)
    return record


def _validate_record_relationships(record: dict, records: dict, workspace: str):
    current = record.get("parentSessionId")
    if current is None:
        return
    seen = {record["id"]}
    for _ in range(8):
        parent = records.get(current)
        if current in seen:
            raise DomainError("invalid_parent", "Parent relationship contains a cycle.")
        if parent is None or (parent.get("deletedAt") is not None and record.get("deletedAt") is None) or parent["kind"] != "session":
            raise DomainError("invalid_parent", "Parent must be an active session.")
        if parent["sourceId"] != record["sourceId"] or parent["workspaceId"] != workspace:
            raise DomainError("invalid_parent", "Parent must belong to the same source and workspace.")
        seen.add(current)
        current = parent.get("parentSessionId")
        if current is None:
            return
    raise DomainError("invalid_parent", "Parent nesting exceeds eight levels.")


def validate_record(record: dict, records: dict | None = None, workspace: str = "default", *, configuration=None) -> dict:
    validate_json(record)
    _validate_record_fields(record, workspace)
    from .record_schema import validate_record_data
    validate_record_data(record, configuration)
    if records is not None:
        _validate_record_relationships(record, records, workspace)
    return record


def make_record(payload: dict, actor: str, workspace: str, previous: dict | None = None):
    if not isinstance(payload, dict) or set(payload) - RECORD_FIELDS:
        raise DomainError("invalid_record", "Unsupported record fields.")
    if set(payload) - MUTABLE_FIELDS:
        raise DomainError("immutable_field", "Record identity, versions and audit fields are server-owned.")
    timestamp = now_iso()
    if previous:
        record = copy.deepcopy(previous)
        for field in MUTABLE_FIELDS:
            if field in payload:
                record[field] = copy.deepcopy(payload[field])
        if record["kind"] != previous["kind"]:
            raise DomainError("immutable_kind", "Record kind cannot be changed.")
        record.update(version=previous["version"] + 1, updatedAt=timestamp, updatedBy=actor)
    else:
        record = {
            "id": str(uuid.uuid4()), "workspaceId": workspace, "kind": "event", "title": "",
            "start": timestamp, "end": None, "parentSessionId": None, "order": 0,
            "sourceId": "default", "groupIds": [], "tags": [], "data": {},
            "render": {"color": "#39788a"}, "extensions": {}, "schemaId": None,
            "schemaVersion": None, "originalStart": None, "originalEnd": None,
            "version": 1, "createdAt": timestamp, "updatedAt": timestamp,
            "createdBy": actor, "updatedBy": actor, "deletedAt": None,
        }
        for field in MUTABLE_FIELDS:
            if field in payload:
                record[field] = copy.deepcopy(payload[field])
    for field in ("start", "end", "originalStart", "originalEnd"):
        if record.get(field) is not None:
            record[field] = iso_from_ms(instant_ms(record[field]))
    return record


def folded(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value)
    return unicodedata.normalize("NFC", "".join(CASEFOLD.get(str(ord(character)), character) for character in normalized))


def search_terms(value: str):
    if not isinstance(value, str) or len(value) > 512:
        raise DomainError("invalid_search", "Search is limited to 512 Unicode code points.")
    # Quoted phrases are single terms; only quote and backslash escapes are accepted.
    terms, current, quoted, escaping = [], [], False, False
    for char in value:
        if escaping:
            if char not in ('"', "\\"):
                raise DomainError("invalid_search", "Only quote and backslash may be escaped.")
            current.append(char)
            escaping = False
        elif char == "\\" and quoted:
            escaping = True
        elif char == '"':
            quoted = not quoted
        elif (char.isspace() or char == ";") and not quoted:
            if current:
                terms.append(folded("".join(current)))
                current = []
        else:
            current.append(char)
    if quoted or escaping:
        raise DomainError("invalid_search", "Search contains an unfinished quote or escape.")
    if current:
        terms.append(folded("".join(current)))
    if len(terms) > 20:
        raise DomainError("invalid_search", "Search contains more than 20 terms.")
    return terms


def matches(record: dict, terms: list[str], mode: str = "any"):
    values = [record["title"]]
    values.extend(record["data"][key] for key in ("description", "text", "system", "type", "status")
                  if isinstance(record["data"].get(key), str))
    text = folded(" ".join(values))
    hits = [term in text for term in terms]
    return not terms or (all(hits) if mode == "all" else any(hits))


def intersects(record: dict, left, right):
    start = instant_ms(record["start"])
    end = instant_ms(record["end"]) if record.get("end") is not None else None
    if record["kind"] == "event" or end == start:
        return left <= start < right
    return start < right and (end is None or end > left)


@lru_cache(maxsize=1)
def _snapshot_validator():
    schemas = Path(__file__).resolve().parents[3] / "shared" / "schemas"
    snapshot_schema = read_json(schemas / "snapshot.schema.json")
    documents = [read_json(path) for path in schemas.glob("*.schema.json")]
    return _compile_schema(snapshot_schema, documents)


def _reject_schema_retrieval(uri):
    raise ValueError(f"Schema reference is not in the local registry: {uri}")


def _compile_schema(schema, documents):
    registry = jsonschema_rs.Registry([(document["$id"], document) for document in documents],
                                      retriever=_reject_schema_retrieval)
    return jsonschema_rs.validator_for(schema, registry=registry, offline=True, validate_formats=True,
                                      formats={"uuid": lambda value: UUID_FORMAT_CHECKER.conforms(value, "uuid"), "timeline-instant": instant_format},
                                      ignore_unknown_formats=False,
                                      pattern_options=jsonschema_rs.RegexOptions(size_limit=1024 * 1024,
                                                                               dfa_size_limit=1024 * 1024))


def validate_snapshot(bundle: dict) -> dict:
    """Validate an explicit complete envelope, including identities and referenced objects."""
    validate_json(bundle)
    error = next(_snapshot_validator().iter_errors(bundle), None)
    if error:
        raise DomainError("invalid_snapshot", "Snapshot schema validation failed: " + error.message)
    manifest = bundle["manifest"]
    if "contentSha256" in manifest:
        supplied = manifest["contentSha256"]
        if not isinstance(supplied, str) or not re.fullmatch(r"[a-f0-9]{64}", supplied) or not hmac.compare_digest(supplied, content_checksum(bundle)):
            raise DomainError("checksum_mismatch", "Snapshot integrity verification failed before normalization.")
    if manifest["workspaceId"] != "default" or manifest["scope"]["workspaceId"] != manifest["workspaceId"]:
        raise DomainError("scope_mismatch", "This server slice supports only the default workspace.")
    if manifest["recordCount"] != len(bundle["records"]):
        raise DomainError("incomplete_snapshot", "Persisted record count does not match the complete manifest.")
    instant_ms(manifest["snapshotAt"])
    records = {}
    source_ids = set(manifest["scope"]["sourceIds"])
    for record in bundle["records"]:
        _validate_record_fields(record, "default")
        from .record_schema import validate_record_data
        validate_record_data(record, bundle)
        if record["id"] in records:
            raise DomainError("duplicate_id", "Snapshot contains duplicate canonical record IDs.")
        if record["sourceId"] not in source_ids:
            raise DomainError("scope_mismatch", "Record source is absent from the complete source catalog.")
        records[record["id"]] = record
    for record in records.values():
        _validate_record_relationships(record, records, "default")
    for family in ("zones", "models"):
        identities = [item["id"] for item in bundle[family]]
        if len(identities) != len(set(identities)):
            raise DomainError("duplicate_id", f"Snapshot contains duplicate {family} IDs.")
    for zone in bundle["zones"]:
        if instant_ms(zone["start"]) >= instant_ms(zone["end"]):
            raise DomainError("invalid_zone", "Annotation zones require positive intervals.")
    for key in ("range", "overview"):
        value = bundle["settings"][key]
        if instant_ms(value["from"]) >= instant_ms(value["to"]):
            raise DomainError("invalid_range", "Snapshot settings require positive ranges.")
    instant_ms(bundle["settings"]["referenceTime"])
    from .model_catalog import normalize_metadata
    normalize_metadata({key: value for key, value in bundle.items() if key != "records"})
    if any(key in bundle for key in ("sources", "groups", "schemas", "views", "preferences", "defaults")) or bundle["filters"]:
        from .configuration_catalog import validate_configuration
        validate_configuration(bundle, {"id": "integrity-validation", "capabilities": ["*"]})
    return bundle


CASEFOLD = read_json(CASEFOLD_PATH)
