import copy
import uuid

import pytest

from conftest import BASE, ROOT
from server.app.models.domain import DomainError, instant_ms, validate_record, validate_snapshot
from server.app.models.presentation import pointer_value, validate_presentation
from server.app.repositories.json_repository import JsonRepository
from server.app.services.presentation_layout import full_label, wrap_label
from server.app.services.query import FontMetrics, QueryEngine
from test_models import DEFINITION, command, created_model
from test_api import prepared


class SnapshotRepository:
    def __init__(self, bundle):
        self.bundle = bundle

    def query_snapshot(self):
        return copy.deepcopy(self.bundle)


def engine_records(bundle, count=5):
    value = copy.deepcopy(bundle)
    records = []
    for index in range(count):
        record = copy.deepcopy(bundle["records"][0])
        record.update(id=str(uuid.UUID(int=index + 1)), title=f"Record {index}", parentSessionId=None,
                      start="2026-09-12T12:00:00.000Z", end="2026-09-12T13:00:00.000Z", kind="session")
        records.append(record)
    value["records"] = records
    engine = QueryEngine(SnapshotRepository(value), ROOT / "shared" / "fixtures" / "font-metrics.json")
    return engine, value


def layout(engine, value, presentation, **changes):
    domain = {"from": "2026-09-12T08:00:00.000Z", "to": "2026-09-12T17:00:00.000Z"}
    query = engine.create_query({"domain": domain})
    request = {**domain, "mapId": query["mapId"], "width": 800, "availableHeight": 480,
               "rowHeight": 32, "fontSize": 13, **changes}
    if presentation is not None:
        request["presentation"] = presentation
    result = engine.create_layout(query["queryId"], request)
    page = engine.rows(query["queryId"], result["layoutId"])
    return query, result, page


@pytest.mark.parametrize("presentation", [
    {"version": 1, "unknown": True}, {"version": 2},
    {"version": 1, "grouping": {"field": "/data/__proto__/x"}},
    {"version": 1, "grouping": {"field": "/data/a~2b"}},
    {"version": 1, "grouping": {"field": "/data//x"}},
    {"version": 1, "labels": {"fields": ["/data/constructor"]}},
    {"version": 1, "sourceStyles": [{"sourceId": "a"}, {"sourceId": "a"}]},
    {"version": 1, "inspector": {"fields": [{"field": "/title", "label": " "}]}},
    {"version": 1, "labels": {"fontWeight": 900}},
    {"version": 1, "bands": {"primary": {"dateFormat": "eval(x)"}}},
])
def test_presentation_strict_validation(presentation):
    with pytest.raises(DomainError) as caught:
        validate_presentation(presentation)
    assert caught.value.code == "invalid_presentation"


def test_pointer_escaped_segments_and_scalar_labels(bundle):
    record = copy.deepcopy(bundle["records"][0])
    record["data"] = {"a/b": {"~key": "Value"}, "number": 1e-7, "yes": True, "empty": ""}
    assert pointer_value(record, "/data/a~1b/~0key") == "Value"
    assert full_label(record, ["/data/empty", "/data/number", "/data/yes"]) == "1e-7 | true"
    with pytest.raises(DomainError, match="scalar"):
        full_label(record, ["/data/a~1b"])


def test_hazard_points_pack_without_parents_and_reserve_bitmap_extent(bundle):
    engine, value = engine_records(bundle, 4)
    for index, record in enumerate(value["records"]):
        record.update(kind="event", end=None, start=f"2026-09-12T{9 + index:02d}:30:00.000Z",
                      render={"icon": "legacy-green-flag"})
    _, resolved, page = layout(engine, value, {"version": 1, "nesting": {"enabled": True}})
    assert resolved["totalRows"] == 1
    for item in page["items"]:
        assert item["iconX"] == item["xStart"] - 8
        assert item["labelX"] >= item["iconX"] + 20
        assert item["footprintStart"] <= item["iconX"] - 2


def test_minor_divisions_require_an_explicit_supported_unit():
    validate_presentation({"version": 1, "bands": {"primary": {"minorDivisions": 4, "intervalUnit": "HOUR"}}})
    for band in ({"minorDivisions": 4}, {"minorDivisions": 4, "intervalUnit": "MONTH"}):
        with pytest.raises(DomainError):
            validate_presentation({"version": 1, "bands": {"primary": band}})


def test_old_path_preserved_and_new_explicit_defaults(bundle):
    engine, value = engine_records(bundle, 2)
    _, old, page = layout(engine, value, None)
    assert old["rowHeight"] == 32 and "presentation" not in old
    assert "style" not in page["items"][0]
    _, new, styled = layout(engine, value, {"version": 1})
    assert new["rowHeight"] == 40
    assert new["presentation"]["grouping"] == {"field": None, "direction": "asc"}
    assert styled["items"][0]["geometryOffsetY"] == 30
    assert styled["items"][0]["labelLines"] == ["Record 0"]


def test_source_record_style_precedence_variant_metrics_and_icon(bundle):
    engine, value = engine_records(bundle, 1)
    record = value["records"][0]
    record["render"].update(fontSize=20, fontWeight=700.0, fontStyle="italic", icon="check", textColor="#112233")
    presentation = {"version": 1, "bands": {"primary": {"textColor": "#445566", "barHeight": 14}},
                    "sourceStyles": [{"sourceId": record["sourceId"], "textColor": "#778899", "backgroundColor": "#000000"}]}
    _, result, page = layout(engine, value, presentation)
    item = page["items"][0]
    assert item["style"]["textColor"] == "#112233"
    assert item["style"]["sourceBackground"] == "#000000"
    assert item["style"]["backgroundColor"] is None
    assert item["style"]["barHeight"] == 14
    assert item["iconX"] == item["xStart"] - 20
    assert item["footprintStart"] <= item["iconX"] - 2
    metric = FontMetrics(ROOT / "shared" / "fixtures" / "font-metrics-700-italic.json").measure("Record 0", 20)
    assert item["labelWidth"] == metric["width"]
    assert result["rowHeight"] >= item["geometryOffsetY"] + 7 + 6


def test_multiline_wrap_overflow_and_independent_ink_reservation(bundle):
    engine, value = engine_records(bundle, 3)
    for record in value["records"]:
        record["title"] = "A long configured label with many words\nSecond paragraph\nThird paragraph"
    _, result, page = layout(engine, value, {"version": 1, "labels": {"maxLines": 2}}, width=180)
    metrics = engine.metrics
    for item in page["items"]:
        assert len(item["labelLines"]) == 2 and item["overflow"]
        assert item["labelLines"][-1].endswith("...")
        assert item["fullLabel"].endswith("Third paragraph")
        assert all(metrics.measure(line, 13)["width"] <= item["labelWidth"] + 1e-9 for line in item["labelLines"])
        assert item["labelX"] + item["labelWidth"] <= 174 + 1e-9
    assert result["rowHeight"] == 58
    assert len({item["row"] for item in page["items"]}) == 3
    lines, _, _, overflow = wrap_label("one\n\ntwo", metrics, 13, 200, 4)
    assert lines == ["one", "", "two"] and not overflow


def test_group_order_types_null_missing_nfc_merge_and_descending(bundle):
    engine, value = engine_records(bundle, 8)
    values = [None, True, "e\u0301", 4, False, "\u00e9", 1]
    for record, group in zip(value["records"], values):
        record["data"] = {"status": group}
    value["records"][-1]["data"] = {}
    _, _, page = layout(engine, value, {"version": 1, "grouping": {"field": "/data/status", "direction": "desc"}}, availableHeight=8192)
    assert [row["name"] for row in page["rows"]] == ["4", "1", "\u00e9", "true", "false", "(null)", "(missing)"]


def test_invalid_group_or_label_fails_before_publishing_layout(bundle):
    engine, value = engine_records(bundle, 2)
    value["records"][1]["data"]["nested"] = {"x": 1}
    for presentation, code in [({"version": 1, "grouping": {"field": "/data/nested"}}, "invalid_group_value"),
                               ({"version": 1, "labels": {"fields": ["/data/nested"]}}, "invalid_label_value")]:
        with pytest.raises(DomainError) as caught:
            layout(engine, value, presentation)
        assert caught.value.code == code
    assert all(not query["layouts"] for query in engine.queries.values())


def test_nested_preorder_pages_enclosures_and_stable_placement(bundle):
    engine, value = engine_records(bundle, 5)
    parent = value["records"][0]
    for index, record in enumerate(value["records"][1:]):
        record["parentSessionId"] = parent["id"]
        record["order"] = 4 - index
    query, manifest, page = layout(engine, value, {"version": 1, "nesting": {"enabled": True}}, availableHeight=80)
    pages = [page]
    while pages[-1]["nextCursor"]:
        pages.append(engine.rows(query["queryId"], manifest["layoutId"], pages[-1]["nextCursor"]))
    assert [page["loadedCount"] for page in pages] == [2, 2, 1]
    assert [item["record"]["id"] for page in pages for item in page["items"]] == [parent["id"], *[record["id"] for record in reversed(value["records"][1:])]]
    assert [page["enclosures"][0]["continuedBefore"] for page in pages] == [False, True, True]
    assert [page["enclosures"][0]["continuedAfter"] for page in pages] == [True, True, False]
    assert manifest["detailTotal"] == manifest["renderInstanceTotal"] == 5
    assert manifest["enclosures"][0]["startRow"] == 0 and manifest["enclosures"][0]["endRow"] == 5
    assert engine.placement(query["queryId"], manifest["layoutId"], value["records"][1]["id"])["pageIndex"] == 2
    assert value["records"][1]["parentSessionId"] == parent["id"]


def test_nested_parent_outside_window_is_not_injected(bundle):
    engine, value = engine_records(bundle, 2)
    parent, child = value["records"]
    parent.update(start="2026-09-12T08:00:00.000Z", end="2026-09-12T09:00:00.000Z")
    child["parentSessionId"] = parent["id"]
    _, result, page = layout(engine, value, {"version": 1, "nesting": {"enabled": True}}, **{"from": "2026-09-12T12:00:00.000Z"})
    assert result["detailTotal"] == 1 and result["enclosures"] == []
    assert page["items"][0]["parentId"] == parent["id"]
    assert page["items"][0]["ancestorIds"] == [] and page["items"][0]["depth"] == 0


def test_baseline_uses_original_dates_and_reserves_height(bundle):
    engine, value = engine_records(bundle, 1)
    record = value["records"][0]
    record["originalStart"] = "2026-09-12T10:00:00.000Z"
    record["originalEnd"] = "2026-09-12T14:00:00.000Z"
    _, result, page = layout(engine, value, {"version": 1, "baseline": {"enabled": True}})
    item = page["items"][0]
    assert item["baselineStart"] < item["xStart"] < item["xEnd"] < item["baselineEnd"]
    assert item["footprintStart"] <= item["baselineStart"] - 2
    assert item["footprintEnd"] >= item["baselineEnd"] + 2
    assert result["rowHeight"] >= item["baselineOffsetY"] + 0.5 + 6
    assert instant_ms(record["start"]) > instant_ms(record["originalStart"])


def test_effective_height_rejects_zero_progress_page(bundle):
    engine, value = engine_records(bundle, 1)
    with pytest.raises(DomainError) as caught:
        layout(engine, value, {"version": 1, "labels": {"fontSize": 24}}, availableHeight=32)
    assert caught.value.code == "row_height_limit"


def test_point_only_four_line_labels_reserve_the_complete_vertical_stack(bundle):
    engine, value = engine_records(bundle, 4)
    for record in value["records"]:
        record.update(kind="event", end=None, title="First\nSecond\nThird\nFourth")
    _, result, page = layout(engine, value, {"version": 1, "labels": {"fontSize": 24, "maxLines": 4}}, availableHeight=480)
    assert result["rowHeight"] == 144 and result["pageCapacity"] == 3
    assert page["loadedCount"] == 3 and page["nextCursor"] is not None
    for item in page["items"]:
        assert len(item["labelLines"]) == 4
        assert item["labelOffsetY"] + len(item["labelLines"]) * item["labelLineHeight"] + 6 <= result["rowHeight"]


def test_large_point_icon_has_marker_and_multiline_label_clearance(bundle):
    engine, value = engine_records(bundle, 1)
    record = value["records"][0]
    record.update(kind="event", end=None, start="2026-09-12T16:59:00.000Z", title="First\nSecond\nThird\nFourth")
    record["render"].update(pointRadius=10, icon="alert-triangle")
    _, result, page = layout(engine, value, {"version": 1, "labels": {"fontSize": 24, "maxLines": 4}})
    item = page["items"][0]
    assert item["iconX"] + 16 <= item["xStart"] - 10 - 5
    assert item["labelX"] + item["labelWidth"] <= item["iconX"] - 4
    assert result["rowHeight"] == 144


def test_point_baseline_cannot_cross_its_multiline_label(bundle):
    engine, value = engine_records(bundle, 1)
    record = value["records"][0]
    record.update(kind="event", end=None, title="First\nSecond\nThird\nFourth",
                  originalStart="2026-09-12T10:00:00.000Z", originalEnd="2026-09-12T15:00:00.000Z")
    _, result, page = layout(engine, value, {"version": 1, "labels": {"fontSize": 24, "maxLines": 4}, "baseline": {"enabled": True}})
    item = page["items"][0]
    assert item["baselineOffsetY"] == 141
    assert item["baselineOffsetY"] >= item["labelOffsetY"] + 4 * item["labelLineHeight"] + 3
    assert result["rowHeight"] == 148


def test_render_validation_supported_variants_and_unsafe_values(bundle):
    record = copy.deepcopy(bundle["records"][0])
    record["render"] = {"color": "#123456", "icon": "alert-triangle", "fontStyle": "italic", "fontWeight": 700, "backgroundColor": None}
    validate_record(record)
    for field, value in [("icon", "https://example.test/a.svg"), ("fontFamily", "system-ui"), ("fontSize", 100), ("backgroundColor", "red")]:
        changed = copy.deepcopy(record)
        changed["render"][field] = value
        with pytest.raises(DomainError):
            validate_record(changed)


def test_presentation_model_publish_apply_remove_and_export(client, app, write_headers):
    definition = {**DEFINITION, "presentation": {"version": 1, "labels": {"maxLines": 3}, "nesting": {"enabled": True}}}
    model = created_model(client, write_headers, definition)
    model = command(client, write_headers, "publish", model).json()["model"]
    applied = command(client, write_headers, "apply", model, {"version": 1})
    assert applied.json()["settings"]["presentation"] == definition["presentation"]
    exported = app.state.repository.snapshot()
    validate_snapshot(exported)
    assert exported["models"][-1]["versions"][0]["definition"] == definition
    plain = client.get(BASE + "/models/light").json()["model"]
    removed = command(client, write_headers, "apply", plain, {"version": 1})
    assert "presentation" not in removed.json()["settings"]
    persisted = app.state.repository.snapshot()
    assert "presentation" not in persisted["settings"]
    assert persisted["models"][-1]["versions"][0]["definition"] == definition


def test_record_style_http_write_roundtrip_and_pinned_overview(client, app, write_headers, bundle):
    existing = bundle["records"][0]
    query = prepared(client, client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"]})).json()
    result = client.patch(BASE + "/records/" + existing["id"], json=[{"op": "replace", "path": "/render", "value": {"color": "#112233", "icon": "flag", "fontWeight": 700}}],
                          headers={**write_headers, "Content-Type": "application/json-patch+json", "If-Match": f'"{write_headers["X-Workspace-Generation"]}:{existing["version"]}"'})
    assert result.status_code == 200, result.text
    fresh = app.state.repository.snapshot()
    assert next(record for record in fresh["records"] if record["id"] == existing["id"])["render"]["icon"] == "flag"
    overview = client.get(BASE + "/query-sessions/" + query["queryId"] + "/overview").json()
    old = next(item for item in overview["items"] if item["id"] == existing["id"])
    assert old["render"] == existing["render"] and old["sourceId"] == existing["sourceId"]


def test_styled_record_and_model_survive_json_repository_restart(tmp_path):
    root = tmp_path / "data"
    seed = ROOT / "data" / "default-dataset.json"
    repository = JsonRepository(root, seed)
    repository.open()
    try:
        generation = repository.metadata()["generation"]
        definition = {**DEFINITION, "presentation": {"version": 1, "baseline": {"enabled": True}}}
        created = repository.mutate_model("create", None, {"name": "Portable", "definition": definition}, generation, None, "model", "test")
        model = created["model"]
        published = repository.mutate_model("publish", model["id"], {}, generation, f'"{generation}:1"', "publish", "test")["model"]
        repository.mutate_model("apply", model["id"], {"version": 1}, generation, f'"{generation}:{published["revision"]}"', "apply", "test")
        record = repository.snapshot()["records"][0]
        changed = repository.mutate("update", record["id"], {"render": {"color": "#445566", "fontStyle": "italic", "icon": "clock"}},
                                    generation, f'"{generation}:{record["version"]}"', "record", "test")
        expected = repository.snapshot()
    finally:
        repository.close()
    restarted = JsonRepository(root, seed)
    restarted.open()
    try:
        actual = restarted.snapshot()
        assert actual["settings"]["presentation"] == definition["presentation"]
        assert actual["models"] == expected["models"]
        assert next(item for item in actual["records"] if item["id"] == record["id"])["render"] == changed["record"]["render"]
        assert restarted.command_outcome("test", "record") == changed
        validate_snapshot(actual)
    finally:
        restarted.close()


def test_snapshot_rejects_unvalidated_presentation_override(bundle):
    bundle["manifest"].pop("contentSha256", None)
    bundle["settings"]["presentation"] = {"version": 1, "grouping": {"field": "/data/prototype"}}
    with pytest.raises(DomainError) as caught:
        validate_snapshot(bundle)
    assert caught.value.code == "invalid_presentation"


def test_nesting_cross_group_disconnect_and_cycle_rejected(bundle):
    engine, value = engine_records(bundle, 2)
    first, second = value["records"]
    first["data"]["status"], second["data"]["status"] = "a", "b"
    second["parentSessionId"] = first["id"]
    _, result, page = layout(engine, value, {"version": 1, "grouping": {"field": "/data/status"}, "nesting": {"enabled": True}})
    assert result["enclosures"] == []
    assert all(item["depth"] == 0 for item in page["items"])
    first["parentSessionId"] = second["id"]
    with pytest.raises(DomainError) as caught:
        layout(engine, value, {"version": 1, "nesting": {"enabled": True}})
    assert caught.value.code == "invalid_parent"
