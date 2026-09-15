import hashlib
import importlib.util
import json
from pathlib import Path


def test_inventory_is_readonly_and_does_not_approve_semantic_repairs(tmp_path):
    spec = importlib.util.spec_from_file_location("migration_ledger", Path(__file__).parents[2] / "scripts/audit-legacy-filter-migration.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (tmp_path / "filters").mkdir()
    (tmp_path / "yaml").mkdir()
    (tmp_path / "models").mkdir()
    preset = tmp_path / "filters/preset.json"
    preset.write_text(json.dumps({"openbexi_timeline": [{"filters": [
        {"name": "Empty", "filter_value": "", "sortBy": "NONE"},
        {"name": "Needs approval", "filter_value": "status=SCHEDULE", "sortBy": "status"},
        {"name": "Ambiguous", "filter_value": "title:alpha|beta", "sortBy": "NONE"},
    ]}]}), encoding="utf-8")
    (tmp_path / "models/model.json").write_text('{"labels": ["untypedCustomField"]}', encoding="utf-8")
    (tmp_path / "yaml/aliases.yml").write_text("base: &value []\ndata_sources: *value\n", encoding="utf-8")
    before = hashlib.sha256(preset.read_bytes()).hexdigest()
    result = module.audit(tmp_path)
    assert result["summary"]["classifications"] == {"exact": 1, "intent-repair": 1, "blocked": 1}
    assert all(not item["result"]["publishable"] for item in result["entries"][1:])
    assert any(item["status"] == "parse-blocked" for item in result["files"])
    assert result["modelRegistries"][0]["fieldRegistry"] == "legacy-metadata-v1"
    assert "/data/untypedCustomField" not in result["fieldRegistries"]["legacy-metadata-v1"]
    assert hashlib.sha256(preset.read_bytes()).hexdigest() == before
    assert result["summary"]["allFilesUnchanged"]
