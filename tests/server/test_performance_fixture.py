import json
import shutil
import subprocess

import pytest

from scripts.performance_fixture import ROOT, build_snapshot, fixture_summary
from server.app.models.domain import instant_ms, json_bytes, validate_snapshot


def test_release_mixture_is_complete_deterministic_and_structurally_valid():
    snapshot = build_snapshot("small")
    assert json_bytes(snapshot) == json_bytes(build_snapshot("small"))
    validate_snapshot(snapshot)
    summary = fixture_summary(snapshot, "small")
    assert summary["recordCount"] == 1000
    assert summary["groupCount"] == 100
    assert summary["sourceCount"] == 10
    assert summary["averageRecordBytes"] <= 2048
    assert summary["pointCount"] == 200
    assert summary["nestedCount"] == 400
    for key in ("ongoingCount", "deletedCount", "longLabelCount", "sparseMeasurementCount"):
        assert summary[key] > 0
    assert summary["stressTierSupported"] is False
    records = {record["id"]: record for record in snapshot["records"]}
    groups = {entry["id"] for entry in snapshot["groups"]}
    assert {value for record in records.values() for value in record["groupIds"]} == groups
    assert any(record["parentSessionId"] and records[record["parentSessionId"]]["parentSessionId"] for record in records.values())
    for record in records.values():
        if record["parentSessionId"]:
            parent = records[record["parentSessionId"]]
            assert record["sourceId"] == parent["sourceId"]
            assert record["groupIds"] == parent["groupIds"]
    dense = [record for record in records.values() if "dense" in record["tags"] and not record["deletedAt"]]
    assert len(dense) >= 180
    counts = {}
    for record in dense:
        counts[record["start"]] = counts.get(record["start"], 0) + 1
    assert max(counts.values()) > 100
    start = instant_ms(snapshot["settings"]["range"]["from"])
    assert any(record["end"] is not None and instant_ms(record["start"]) < start < instant_ms(record["end"])
               for record in records.values())


def test_unknown_performance_tier_is_rejected():
    with pytest.raises(ValueError, match="Unknown performance tier"):
        build_snapshot("unbounded")


def test_small_release_fixture_is_admitted_and_fully_browsable_by_local_provider():
    snapshot = build_snapshot("small")
    script = """
        import { readFileSync } from 'node:fs';
        import { LocalProvider } from './client/src/data/local-provider.js';
        const snapshot = JSON.parse(readFileSync(0, 'utf8'));
        const provider = new LocalProvider(snapshot);
        try {
          const status = await provider.initialize();
          const query = await provider.createQuery({domain: snapshot.settings.overview, scaleMode: 'adaptive'});
          const ids = []; let cursor = null;
          do {
            const page = await provider.queryRecords(query.queryId, {limit: 100, cursor});
            ids.push(...page.items.map(item => item.record.id)); cursor = page.nextCursor;
          } while (cursor);
          console.log(JSON.stringify({ids, total: query.baseTotal, active: status.recordCount,
            groups: provider.snapshot.groups.length, schemas: provider.snapshot.schemas.length}));
        } finally { await provider.dispose(); }
    """
    result = subprocess.run([shutil.which("node") or "node", "--input-type=module", "-e", script],
                            cwd=ROOT, input=json_bytes(snapshot), capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    actual = json.loads(result.stdout)
    expected = {record["id"] for record in snapshot["records"] if record["deletedAt"] is None}
    assert actual["groups"] == 100 and actual["schemas"] == 1
    assert actual["active"] == actual["total"] == len(expected)
    assert len(actual["ids"]) == len(set(actual["ids"])) == len(expected)
    assert set(actual["ids"]) == expected
