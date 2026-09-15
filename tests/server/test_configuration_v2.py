import copy
import pytest

from server.app.models.configuration_catalog import effective_settings, validate_resource_definition, configuration_usage
from server.app.models.settings_commands import apply_settings_command
from server.app.models.domain import DomainError
from server.app.services.query_configuration import resolve_query_configuration
from test_configuration_catalog import ACTOR, normalized, publish, apply

REGEX_SEARCH = {"text": "^Activity_", "mode": "regex", "fields": ["/title"], "flags": ["i"], "matchMode": "search", "dialect": "re2-common-v1"}


def filter_definition():
    return {"definitionVersion": 2, "relationshipMode": "family", "sourceIds": None, "kinds": ["event", "session"], "schemaRefs": [], "expression": {"version": 2, "root": {"op": "regex", "field": "/title", "pattern": "Activity", "ruleId": "activity"}}, "search": copy.deepcopy(REGEX_SEARCH)}


def test_catalog_version_boundary():
    assert validate_resource_definition("filters", filter_definition())["valid"]
    for definition in [{**filter_definition(), "definitionVersion": 1}, {**filter_definition(), "search": {**REGEX_SEARCH, "caseSensitive": False}}, {**filter_definition(), "expression": {"version": 2, "root": {"op": "regex", "field": "/title", "pattern": "(?=unsafe)"}}}]:
        assert not validate_resource_definition("filters", definition)["valid"]
    legacy = filter_definition()
    del legacy["definitionVersion"]
    assert not validate_resource_definition("filters", legacy)["valid"]
    migration = {"format": "legacy-filter-migration", "version": 1, "original": {"include": "status=ready", "exclude": "", "sortBy": "NONE"}, "acknowledged": ["help-equality-repair"]}
    assert validate_resource_definition("filters", {**filter_definition(), "migration": migration})["valid"]
    assert not validate_resource_definition("filters", {**filter_definition(), "migration": {**migration, "original": {**migration["original"], "include": "x" * 4097}}})["valid"]


def test_saved_filter_view_lifecycle_and_resolution():
    saved = publish(normalized(), "filters", filter_definition(), identity=601)
    definition = {"definitionVersion": 2, "model": {"id": "light", "version": 1}, "filter": {"id": saved["resource"]["id"], "version": 1}, "settings": {"definitionVersion": 2, "groupOrder": {"order": "natural", "caseSensitive": False}, "sort": [{"field": "/title", "direction": "asc", "order": "natural", "caseSensitive": False}], "collapsedGroups": ["string:SOURCE1"], "relationshipMode": "independent"}}
    assert not validate_resource_definition("views", {**definition, "definitionVersion": 1, "settings": {}}, {"snapshot": saved["snapshot"]})["valid"]
    view = publish(saved["snapshot"], "views", definition, identity=603)
    applied = apply(view["snapshot"], "views", "apply", {"version": 1}, resource=view["resource"], identity=605)
    assert applied["effectiveSettings"]["values"]["definitionVersion"] == 2
    assert applied["effectiveSettings"]["values"]["search"] == REGEX_SEARCH
    assert applied["effectiveSettings"]["values"]["relationshipMode"] == "independent"
    assert applied["effectiveSettings"]["values"]["groupOrder"] == definition["settings"]["groupOrder"]
    assert configuration_usage(applied["snapshot"], "groups", "string:SOURCE1") == []
    search = {"text": "literal", "mode": "any", "caseSensitive": False, "fields": ["/title"]}
    overridden = effective_settings(applied["snapshot"], principal_id=ACTOR["id"], transient={"definitionVersion": 2, "search": search})
    assert overridden["values"]["search"] == search


def test_settings_sort_collapse_and_mode_changing_patches():
    base = {"definitionVersion": 2, "model": {"id": "light", "version": 1}, "filter": None, "settings": {"definitionVersion": 2}}
    for settings in [{"sort": [{"field": "/order", "direction": "asc", "order": "natural"}]}, {"collapsedGroups": ["resource-group-id"]}, {"collapsedGroups": ["string:e\u0301"]}]:
        assert not validate_resource_definition("views", {**base, "settings": {**base["settings"], **settings}})["valid"]
    snapshot = normalized()
    for revision, search in enumerate([REGEX_SEARCH, {"text": "Activity", "mode": "any", "caseSensitive": True, "fields": ["/title"]}, REGEX_SEARCH]):
        result = apply_settings_command(snapshot, {"scope": "personal", "type": "patch", "expectedRevision": revision, "generation": snapshot["manifest"]["generation"], "clientCommandId": f"settings-{revision}", "payload": {"definitionVersion": 2, "search": search}}, ACTOR)
        assert result["settings"]["values"]["search"] == search
        assert result["effectiveSettings"]["values"]["search"] == search
        snapshot = result["snapshot"]


def test_saved_query_search_modes_and_relationship_inheritance():
    for saved_search in [REGEX_SEARCH, {"text": "Activity", "mode": "any", "caseSensitive": False, "fields": ["/title"]}]:
        saved = publish(normalized(), "filters", {**filter_definition(), "search": saved_search}, identity=701)
        request = {"definitionVersion": 2, "filters": {"filterId": saved["resource"]["id"], "filterVersion": 1}}
        assert resolve_query_configuration(saved["snapshot"], request)["relationshipMode"] == "family"
        assert resolve_query_configuration(saved["snapshot"], {**request, "relationshipMode": "independent"})["relationshipMode"] == "independent"
        with pytest.raises(DomainError) as version:
            resolve_query_configuration(saved["snapshot"], {**request, "definitionVersion": 1})
        assert version.value.code == "unsupported_query_definition"
        override = {"searchMode": "phrase", "search": "literal"} if saved_search["mode"] == "regex" else {"searchMode": "regex", "search": "^literal$", "searchFlags": []}
        resolved = resolve_query_configuration(saved["snapshot"], {**request, **override})
        assert resolved["search"]["matches"]({"title": "literal"})
        assert not resolved["search"]["matches"]({"title": "unrelated"})
        with pytest.raises(DomainError) as invalid:
            resolve_query_configuration(saved["snapshot"], {**request, **override, **({"searchCaseSensitive": False} if override["searchMode"] == "regex" else {"searchFlags": []})})
        assert invalid.value.code == "invalid_search"


def test_v2_table_settings_validation_merge_and_reset():
    base = {"definitionVersion": 2, "model": {"id": "light", "version": 1}, "filter": None, "settings": {"definitionVersion": 2, "table": {"scope": "window", "projection": "matches", "limit": 250}}}
    assert validate_resource_definition("views", base)["valid"]
    assert not validate_resource_definition("views", {**base, "definitionVersion": 1, "settings": {"table": base["settings"]["table"]}})["valid"]
    for table in [{"scope": "visible"}, {"projection": "findings"}, {"limit": 1001}, {"cursor": "stale"}]:
        assert not validate_resource_definition("views", {**base, "settings": {"definitionVersion": 2, "table": table}})["valid"]
    snapshot = normalized()
    for revision, (operation, payload) in enumerate([("patch", base["settings"]), ("patch", {"table": {"limit": 50}}), ("reset", {"paths": ["/table/projection"]})]):
        result = apply_settings_command(snapshot, {"scope": "personal", "type": operation, "expectedRevision": revision, "generation": snapshot["manifest"]["generation"], "clientCommandId": f"table-{revision}", "payload": payload}, ACTOR)
        snapshot = result["snapshot"]
    assert effective_settings(snapshot, principal_id=ACTOR["id"])["values"]["table"] == {"scope": "window", "limit": 50}
