import pytest

from server.app.models.domain import DomainError
from server.app.services.legacy_json import legacy_instant, parse_legacy_json


def test_legacy_dialect_is_explicit_and_never_repairs_quoted_text():
    raw = b'{"text":"a,} and \\\"b,]", "same":1,"same":2,"items":[1,2,],}'
    with pytest.raises(DomainError):
        parse_legacy_json(raw)
    value, diagnostics = parse_legacy_json(raw, "legacy-json")
    assert value == {"text": 'a,} and "b,]', "same": 2, "items": [1, 2]}
    assert diagnostics == [
        {"code": "legacy_trailing_commas", "count": 2},
        {"code": "legacy_duplicate_members", "count": 1, "policy": "last-member-wins", "keys": ["same"]},
    ]


@pytest.mark.parametrize("raw", [b"[,]", b"{,}", b"[1,,]", b"{'x':1}", b"[NaN]", b"[Infinity]",
                                  b"[1e999]", b"// comment\n{}", b"{\"x\":", b"\xff", b"[" * 65])
def test_legacy_dialect_rejects_unrelated_malformed_json(raw):
    with pytest.raises(DomainError):
        parse_legacy_json(raw, "legacy-json")


@pytest.mark.parametrize(("value", "expected"), [
    ("2024-03-18T02:30:00+02:00", "2024-03-18T00:30:00.000Z"),
    ("Mon Mar 18 00:30:00 UTC 2024", "2024-03-18T00:30:00.000Z"),
    ("Mon Mar 18 2024 00:30:00 UTC", "2024-03-18T00:30:00.000Z"),
    ("Mon Mar 18 2024 02:30:00 GMT+0200", "2024-03-18T00:30:00.000Z"),
    ("2024-02-29", "2024-02-29T00:00:00.000Z"),
])
def test_documented_legacy_dates(value, expected):
    assert legacy_instant(value, default_timezone="UTC") == expected


def test_offset_free_dates_need_explicit_timezone_and_abbreviations_are_not_guessed():
    with pytest.raises(DomainError, match="timezone must be explicitly"):
        legacy_instant("2024-03-18 00:30:00")
    with pytest.raises(DomainError) as error:
        legacy_instant("Mon Mar 18 00:30:00 EST 2024", default_timezone="UTC")
    assert error.value.code == "legacy_timezone_ambiguous"
    assert legacy_instant("Mon Mar 18 00:30:00 EST 2024", abbreviations={"EST": -300}) == "2024-03-18T05:30:00.000Z"


@pytest.mark.parametrize("value", ["2024-03-10 02:30:00", "2024-11-03 01:30:00"])
def test_dst_gaps_and_folds_require_authored_offsets(value):
    with pytest.raises(DomainError) as error:
        legacy_instant(value, default_timezone="America/New_York")
    assert error.value.code == "legacy_date_ambiguous"


@pytest.mark.parametrize("value", ["2023-02-29", "2024-01-01 25:00:00", "01/02/2024", "today", "", None])
def test_invalid_dates_are_not_guessed(value):
    with pytest.raises(DomainError):
        legacy_instant(value, default_timezone="UTC")
