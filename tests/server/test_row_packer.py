import random

import pytest

from server.app.services.row_packer import pack_footprints
from server.app.models.domain import DomainError


def reference(items, clearance=4):
    tracks, rows = [], []
    for item in items:
        row = 0
        while row < len(tracks) and not all(item["footprintEnd"] + clearance <= left or item["footprintStart"] >= right + clearance for left, right in tracks[row]):
            row += 1
        if row == len(tracks):
            tracks.append([])
        tracks[row].append((item["footprintStart"], item["footprintEnd"]))
        rows.append(row)
    return {"rows": rows, "count": len(tracks)}


def test_indexed_packing_matches_reference_for_1000_arbitrary_orders():
    randomizer = random.Random(39134839)
    for _ in range(1000):
        items = []
        for _ in range(randomizer.randint(128, 277)):
            start = randomizer.randint(-1000, 1000) / 3
            items.append({"footprintStart": start, "footprintEnd": start + randomizer.random() * 100 + 0.01})
        assert pack_footprints(items) == reference(items)


def test_exact_touching_duplicates_small_path_and_simultaneous_rows():
    touching = [{"footprintStart": 14 if index % 2 else 0, "footprintEnd": 24 if index % 2 else 10} for index in range(400)]
    assert pack_footprints(touching) == reference(touching)
    assert pack_footprints(touching[:127]) == reference(touching[:127])
    simultaneous = [{"footprintStart": 0, "footprintEnd": 100} for _ in range(25000)]
    assert pack_footprints(simultaneous) == {"rows": list(range(25000)), "count": 25000}
    assert pack_footprints([]) == {"rows": [], "count": 0}


@pytest.mark.parametrize("items,clearance", [([], -1), ([], float("inf")), ([{"footprintStart": 0, "footprintEnd": float("nan")}], 4),
                                           ([{"footprintStart": 10, "footprintEnd": 6}], 4), ([{"footprintStart": True, "footprintEnd": 6}], 4)])
def test_invalid_footprints_fail(items, clearance):
    with pytest.raises(ValueError):
        pack_footprints(items, clearance)


def test_packing_admission_budget_before_partial_result():
    items = [{"footprintStart": 0, "footprintEnd": 100} for _ in range(128)]
    for budget in (1, 192, 270):
        with pytest.raises(DomainError) as caught:
            pack_footprints(items, max_index_bytes=budget)
        assert caught.value.code == "layout_capacity" and caught.value.status == 413
    assert pack_footprints(items, max_index_bytes=1024)["count"] == 128
