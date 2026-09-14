import copy
from pathlib import Path

import jsonschema_rs
import pytest
from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.validators import validator_for
from referencing import Registry, Resource

from conftest import ROOT
from server.app.models import domain


@pytest.fixture(scope="module")
def reference_snapshot_validator():
    documents = [domain.read_json(path) for path in (ROOT / "shared" / "schemas").glob("*.schema.json")]
    registry = Registry().with_resources((document["$id"], Resource.from_contents(document)) for document in documents)
    schema = next(value for value in documents if value["$id"].endswith("/snapshot.schema.json"))
    checker = FormatChecker()

    # The prior service enforced dates in domain validation even when the optional
    # jsonschema date-time dependency was absent. Keep that policy in this oracle.
    @checker.checks("date-time", raises=domain.DomainError)
    @checker.checks("timeline-instant", raises=domain.DomainError)
    def canonical_datetime(value):
        if isinstance(value, str):
            domain.instant_ms(value)
        return True

    return validator_for(schema)(schema, registry=registry, format_checker=checker)


@pytest.mark.parametrize("field,value", [
    ("id", "bad-id"), ("id", "00000000000000000000000000000000"),
    ("id", "00000000-0000-0000-0000-000000000000"),
    ("title", ""), ("title", "x" * 500), ("title", "x" * 501),
    ("title", "\U0001f600" * 500), ("title", "\U0001f600" * 501),
    ("title", "e\u0301" * 250), ("title", "e\u0301" * 251),
    ("start", "0001-01-01T00:00:00Z"), ("start", "9999-12-31T23:59:59.999Z"),
    ("start", "2026-01-01"), ("start", "2026-02-30T00:00:00Z"),
    ("start", "2026-01-01T00:00:00+24:00"), ("start", "2026-01-01T00:00:00-05:00"),
    ("end", None), ("end", 42), ("parentSessionId", "bad-id"),
    ("order", True), ("order", -1), ("order", 1.5),
    ("version", True), ("version", 0), ("version", 1.0), ("version", domain.MAX_SAFE_INT),
    ("kind", "point"), ("data", []), ("data", {"number": 3.14159}),
    ("tags", ["same", "same"]), ("groupIds", [True]),
    ("render", {"color": "#123456"}), ("render", {"color": "#123456\n"}),
    ("render", {"color": "#123456\r\n"}), ("render", {"fontSize": 25}),
    ("render", {"fontWeight": 700, "fontStyle": "italic"}),
])
def test_compiled_snapshot_matches_reference_on_boundary_corpus(bundle, reference_snapshot_validator, field, value):
    bundle["records"][0][field] = value
    assert domain._snapshot_validator().is_valid(bundle) == reference_snapshot_validator.is_valid(bundle)


def test_compiled_schema_missing_required_and_unknown_members_match_reference(bundle, reference_snapshot_validator):
    candidates = []
    for key in ("id", "title", "start", "end", "sourceId", "version"):
        candidate = copy.deepcopy(bundle)
        candidate["records"][0].pop(key)
        candidates.append(candidate)
    candidate = copy.deepcopy(bundle)
    candidate["records"][0]["unknown"] = 1
    candidates.append(candidate)
    for candidate in candidates:
        assert not domain._snapshot_validator().is_valid(candidate)
        assert not reference_snapshot_validator.is_valid(candidate)


@pytest.mark.parametrize("value", [domain.MAX_SAFE_INT + 1, float(domain.MAX_SAFE_INT + 1), float("nan"), float("inf"), "\ud800", {1: "invalid JSON key"}])
def test_unsafe_json_is_rejected_before_native_conversion(bundle, monkeypatch, value):
    bundle["records"][0]["data"]["value"] = value

    def forbidden_compile():
        pytest.fail("Unsafe JSON reached native schema conversion")

    monkeypatch.setattr(domain, "_snapshot_validator", forbidden_compile)
    with pytest.raises(domain.DomainError) as error:
        domain.validate_snapshot(bundle)
    assert error.value.code == "invalid_json"


def test_2020_12_keywords_and_registered_references_are_enforced():
    document = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "https://openbexi.local/test-value",
                "type": "array", "prefixItems": [{"type": "string", "maxLength": 1}, {"type": "integer"}],
                "minItems": 2, "items": False}
    schema = {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",
              "properties": {"value": {"$ref": document["$id"]}}, "required": ["value"], "unevaluatedProperties": False}
    compiled = domain._compile_schema(schema, [document])
    reference = Draft202012Validator(schema, registry=Registry().with_resource(document["$id"], Resource.from_contents(document)))
    for value in ({"value": ["\U0001f600", 1]}, {"value": ["x", True]}, {"value": ["xx", 1]},
                  {"value": ["x", 1, 2]}, {"value": ["x", 1], "extra": 2}, {}):
        assert compiled.is_valid(value) == reference.is_valid(value)
    assert compiled.is_valid({"value": ["\U0001f600", 1]})


def test_explicit_dialect_is_honored_without_silent_upgrade():
    schema = {"$schema": "http://json-schema.org/draft-07/schema#", "prefixItems": [{"type": "integer"}]}
    assert domain._compile_schema(schema, []).is_valid(["legacy keyword ignored"])
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    assert not domain._compile_schema(schema, []).is_valid(["new keyword enforced"])


@pytest.mark.parametrize("reference", ["https://example.invalid/private-schema.json", "http://127.0.0.1:9/private-schema.json", "file:///not-authorized/schema.json"])
def test_unregistered_schema_references_are_offline_and_rejected(reference):
    with pytest.raises((ValueError, jsonschema_rs.ValidationError)):
        domain._compile_schema({"$ref": reference}, [])


def test_registry_cannot_retrieve_a_reference_during_construction(monkeypatch):
    calls = []

    def rejected(uri):
        calls.append(uri)
        raise ValueError("Forbidden external retrieval")

    monkeypatch.setattr(domain, "_reject_schema_retrieval", rejected)
    document = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "https://openbexi.local/registered",
                "$ref": "https://example.invalid/not-registered"}
    with pytest.raises((ValueError, jsonschema_rs.ValidationError)):
        domain._compile_schema({"$ref": document["$id"]}, [document])
    assert calls == ["https://example.invalid/not-registered"]


def test_unknown_formats_are_not_silently_ignored():
    with pytest.raises(jsonschema_rs.ValidationError, match="Unknown format"):
        domain._compile_schema({"$schema": "https://json-schema.org/draft/2020-12/schema", "format": "unsupported-format"}, [])


def test_schema_compilation_is_cached_and_does_not_read_files_after_initialization(monkeypatch):
    compiled = domain._snapshot_validator()

    def forbidden_read(_):
        pytest.fail("Cached schema validator reread its schema files")

    monkeypatch.setattr(Path, "read_bytes", forbidden_read)
    assert domain._snapshot_validator() is compiled
