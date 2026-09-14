import copy
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from server.app.models.domain import DomainError, content_checksum, validate_snapshot
from server.app.models.presentation import validate_presentation
from server.app.services.legacy_presentation import adapt_legacy_presentation, apply_legacy_presentation, legacy_model_focus
from server.app.services.presentation_layout import group_style, resolved_presentation, resolved_style

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = json.loads((ROOT / "shared/fixtures/legacy-presentation.json").read_text())


def adapt(fixture):
    return adapt_legacy_presentation(fixture["model"], source_bindings=fixture["sourceBindings"], namespace_grouping=fixture["namespaceGrouping"])


@pytest.mark.parametrize("name", FIXTURES)
def test_actual_models_preserve_source_namespace_and_event_palette(name):
    fixture = FIXTURES[name]
    before = copy.deepcopy(fixture)
    result = adapt(fixture)
    assert fixture == before
    definition = result["definition"]
    presentation = resolved_presentation(definition["presentation"], definition["fontSize"], definition["theme"])
    source = fixture["sourceBindings"][0]
    record = {"sourceId": source["sourceId"], "kind": "event", "render": {}}
    assert resolved_style(record, presentation)["color"] == fixture["model"]["bands"][0]["eventColor"]
    assert resolved_style(record, presentation)["sourceBackground"] == source["render"]["color"]
    assert group_style(source["namespace"], presentation)["backgroundColor"] == source["render"]["color"]
    assert result["viewHints"]["bands"]["primary"]["heightFraction"] == 0.75


@pytest.mark.parametrize("value", ["03/18/2024", "Tue Mar 18 2024 20:00:00 UTC", "Mon Feb 30 2024 20:00:00 UTC", "2024-03-18T20:00:00"])
def test_model_dates_are_explicit_and_strict(value):
    with pytest.raises(DomainError, match="Model reference date"):
        legacy_model_focus(value)


def test_namespace_selectors_reject_normalization_ambiguity():
    for namespaces in [[" ", "B"], ["e\u0301", "\u00e9"]]:
        with pytest.raises(DomainError):
            validate_presentation({"version": 1, "sourceStyles": [{"sourceId": str(index), "namespace": namespace} for index, namespace in enumerate(namespaces)]})


def test_javascript_python_adapters_have_exact_output_parity():
    node = shutil.which("node")
    assert node, "Node is required to verify the shared presentation contract"
    code = "import f from './shared/fixtures/legacy-presentation.json' with {type:'json'}; import {adaptLegacyPresentation as adapt} from './client/src/data/legacy-presentation.js'; process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(f).map(([k,v])=>[k,adapt(v.model,v)]))));"
    result = subprocess.run([node, "--input-type=module", "-e", code], cwd=ROOT, capture_output=True, text=True, timeout=30, check=True)
    assert json.loads(result.stdout) == {name: adapt(fixture) for name, fixture in FIXTURES.items()}


def test_apply_presentation_preserves_source_data_history_and_declared_range():
    snapshot = json.loads((ROOT / "data/default-dataset.json").read_text())
    snapshot["manifest"]["legacy"] = {"readOnly": True, "declaredRange": copy.deepcopy(snapshot["settings"]["range"])}
    snapshot["manifest"]["contentSha256"] = content_checksum(snapshot)
    before = copy.deepcopy(snapshot)
    adapted = adapt(FIXTURES["namespace"])
    result = apply_legacy_presentation(snapshot, adapted)
    assert snapshot == before
    assert validate_snapshot(result) is result
    assert result["records"] == snapshot["records"]
    assert result["records"] is not snapshot["records"]
    assert result["zones"] == snapshot["zones"]
    assert [model["id"] for model in result["models"][:-1]] == [model["id"] for model in snapshot["models"]]
    assert result["models"][-1]["versions"][0]["definition"] == adapted["definition"]
    assert result["settings"]["modelId"] == result["models"][-1]["id"]
    assert result["settings"]["modelVersion"] == 1
    assert result["settings"]["range"] == snapshot["settings"]["range"]
    assert result["settings"]["overview"] == snapshot["settings"]["overview"]
    assert result["manifest"]["legacy"]["declaredRange"] == snapshot["manifest"]["legacy"]["declaredRange"]
    assert result["manifest"]["legacy"]["viewHints"] == adapted["viewHints"]
    assert result["manifest"]["legacy"]["presentationDiagnostics"] == adapted["diagnostics"]
    assert "contentSha256" not in result["manifest"]
    assert apply_legacy_presentation(result, adapted) == result


def test_apply_presentation_rejects_input_integrity_failure_before_normalization():
    snapshot = json.loads((ROOT / "data/default-dataset.json").read_text())
    snapshot["manifest"]["contentSha256"] = "0" * 64
    with pytest.raises(DomainError, match="integrity"):
        apply_legacy_presentation(snapshot, adapt(FIXTURES["hazard"]))


def test_apply_presentation_does_not_rewrite_a_conflicting_immutable_publication():
    snapshot = json.loads((ROOT / "data/default-dataset.json").read_text())
    adapted = adapt(FIXTURES["namespace"])
    result = apply_legacy_presentation(snapshot, adapted)
    result["models"][-1]["versions"][0]["definition"]["theme"] = "dark"
    before = copy.deepcopy(result)
    with pytest.raises(DomainError, match="conflicts"):
        apply_legacy_presentation(result, adapted)
    assert result == before
