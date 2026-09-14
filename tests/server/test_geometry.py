import copy
import random
from decimal import Decimal, localcontext

import pytest

from conftest import ROOT
from server.app.models.domain import DomainError, folded, instant_ms, intersects, iso_from_ms, search_terms
from server.app.services.query import FontMetrics, QueryEngine, build_density, build_map, mapped, overview_bin_counts, record_bounds


def test_density_half_open_points_zero_and_ongoing(bundle):
    template = bundle["records"][0]

    def record(kind, start, end):
        value = copy.deepcopy(template)
        value.update(kind=kind, start=iso_from_ms(start), end=iso_from_ms(end) if end is not None else None)
        return value

    records = [record("event", 0, None), record("event", 16, None), record("session", 8, 8),
               record("session", -20, 20), record("session", 2, None)]
    density = build_density(records, 0, 16, 16)
    assert density["total"] == 4
    assert sum(item["points"] for item in density["bins"]) == 2
    assert sum(int(item["overlapMs"]) for item in density["bins"]) == 30
    assert sum(item["endpoints"] for item in density["bins"]) == 1
    assert density["bins"][2]["density"] == 2.5


def test_map_monotone_ratio_bounded_and_search_independent(bundle):
    start = instant_ms(bundle["settings"]["overview"]["from"])
    end = instant_ms(bundle["settings"]["overview"]["to"])
    density = build_density(bundle["records"], start, end, 128)
    map_value = build_map(density, bundle["settings"]["overview"], "adaptive", 8, "test")
    knots = map_value["knots"]
    slopes = []
    for first, second in zip(knots, knots[1:]):
        assert Decimal(first["u"]) < Decimal(second["u"])
        slopes.append((Decimal(second["u"]) - Decimal(first["u"])) / (second["timeMs"] - first["timeMs"]))
    assert max(slopes) / min(slopes) <= Decimal("8.00000000000001")
    assert knots[0]["u"] == "0"
    assert knots[-1]["u"] == "1"
    assert all(len(Decimal(knot["u"]).normalize().as_tuple().digits) <= 34 for knot in knots)


def test_millisecond_window_over_millennium_does_not_collapse():
    start, end = instant_ms("1000-01-01T00:00:00.000Z"), instant_ms("2000-01-01T00:00:00.000Z")
    density = build_density([], start, end, 128)
    result = build_map(density, {"from": iso_from_ms(start), "to": iso_from_ms(end)}, "uniform", 4, "test")
    center = instant_ms("1500-01-01T00:00:00.000Z")
    with localcontext() as context:
        context.prec = 50
        a, b = mapped(result["knots"], center), mapped(result["knots"], center + 1)
        middle = mapped(result["knots"], Decimal(center) + Decimal("0.5"))
        assert b > a
        x = (middle - a) / (b - a) * 1000
        assert abs(x - 500) < Decimal("0.0000001")


@pytest.mark.parametrize("value", ["0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "2026-09-12T08:00:00.000-04:00"])
def test_date_roundtrip(value):
    millis = instant_ms(value)
    assert instant_ms(iso_from_ms(millis)) == millis


def test_search_shared_casefold_and_grammar():
    assert folded("Straße") == "strasse"
    assert folded("İ") == "i\u0307"
    assert search_terms('one;"two three" "quote\\\""') == ["one", "two three", 'quote"']
    with pytest.raises(DomainError):
        search_terms('"invalid\\x"')


def test_font_width_is_measured_and_unsupported_glyph_diagnosed():
    metrics = FontMetrics(ROOT / "shared" / "fixtures" / "font-metrics.json")
    assert metrics.measure("WWW", 13)["width"] > metrics.measure("iii", 13)["width"]
    shortened, width, overflow = metrics.fit("A very long label", 13, 40)
    assert overflow and shortened.endswith("...")
    assert width["width"] <= 40
    with pytest.raises(DomainError) as error:
        metrics.measure("\U0001f600", 13)
    assert error.value.code == "unsupported_glyph"


def test_density_range_accumulation_matches_independent_integer_oracle():
    randomizer = random.Random(20260912)
    for fixture in range(20):
        start, end = -103, 1003 + fixture
        records = []
        for index in range(200):
            record_start = randomizer.randint(-500, 1500)
            kind = "event" if index % 5 == 0 else "session"
            record_end = None if kind == "event" or index % 7 == 0 else record_start + randomizer.randint(0, 1400)
            if index % 9 == 0 and kind == "session":
                record_end = record_start
            records.append({"id": str(index), "kind": kind, "start": iso_from_ms(record_start),
                            "end": iso_from_ms(record_end) if record_end is not None else None})
        original = copy.deepcopy(records)
        cached = {record["id"]: record_bounds(record) for record in records}
        density = build_density(records, start, end, 37, cached)
        assert density == build_density(records, start, end, 37)
        assert density["total"] == sum(intersects(record, start, end) for record in records)
        for item in density["bins"]:
            points, endpoints, overlap = 0, 0, 0
            for record in records:
                if not intersects(record, start, end):
                    continue
                left, right, point = record_bounds(record)
                if point:
                    points += item["from"] <= left < item["to"]
                else:
                    endpoints += sum(value is not None and item["from"] <= value < item["to"] for value in (left, right))
                    overlap += max(0, min(item["to"], right if right is not None else end) - max(item["from"], left))
            assert item["points"] == points
            assert item["endpoints"] == endpoints
            assert item["overlapMs"] == str(overlap)
            assert item["density"] == points + overlap / (item["to"] - item["from"]) + 0.5 * endpoints
        expected_counts = [sum(intersects(record, item["from"], item["to"]) for record in records) for item in density["bins"]]
        assert overview_bin_counts(records, density["bins"], cached) == expected_counts
        assert records == original


def test_density_full_range_safe_integer_occupancy_and_millisecond_bins():
    start, end = instant_ms("0001-01-01T00:00:00.000Z"), instant_ms("9999-12-31T23:59:59.999Z")
    records = [{"id": str(index), "kind": "session", "start": iso_from_ms(start), "end": None} for index in range(100)]
    density = build_density(records, start, end, 16)
    assert sum(int(item["overlapMs"]) for item in density["bins"]) == (end - start) * 100
    assert (end - start) * 100 > 9007199254740991
    assert all(item["density"] == 100 + (50 if index == 0 else 0) for index, item in enumerate(density["bins"]))
    tiny = build_density(records, 0, 3, 128)
    assert len(tiny["bins"]) == 3
    assert [item["overlapMs"] for item in tiny["bins"]] == ["100"] * 3


def test_page_preflight_buckets_preserve_original_item_order():
    values = [{"row": row, "id": index} for index, row in enumerate((20, 0, 15, 1, 20, 29, 30))]
    buckets = QueryEngine._page_buckets(values, 15)
    for page_index in range(3):
        assert buckets[page_index] == [value for value in values if page_index * 15 <= value["row"] < (page_index + 1) * 15]
