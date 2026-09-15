import ctypes
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from test_launch_configuration import profile  # noqa: F401
from test_legacy_preferences import configured  # noqa: F401
from test_legacy_api import legacy  # noqa: F401
from server.app.models.domain import DomainError
from server.app.repositories.legacy_preferences import LegacyPreferencesRepository
from server.app.services.launch_configuration import load_launch_configuration


def windows_spelling(path, record_property):
    alias = path
    if os.name == "nt":
        short_name = ctypes.WinDLL("kernel32", use_last_error=True).GetShortPathNameW
        short_name.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
        short_name.restype = ctypes.c_uint
        length = short_name(str(path), None, 0)
        if length:
            buffer = ctypes.create_unicode_buffer(length)
            written = short_name(str(path), buffer, length)
            assert 0 < written < length
            alias = Path(buffer.value)
    record_property("windows_short_alias_exercised", alias != path)
    return alias


def test_preferences_resolve_equivalent_spelling_before_containment(configured, tmp_path, monkeypatch):  # noqa: F811
    base, _, _, _, _ = configured
    alias = tmp_path / "short-alias" / "preferences"
    expected = base.root / "alternate-preferences"
    original = Path.resolve

    def resolve(path, *args, **kwargs):
        return expected if path == alias else original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", resolve)
    repository = LegacyPreferencesRepository(base, alias)
    try:
        assert repository.root == expected
        assert repository.path.is_file()
        assert not alias.exists()
    finally:
        repository.close()


@pytest.mark.parametrize("mode,attributes", [(stat.S_IFLNK, 0), (stat.S_IFDIR, 0x400)])
def test_preferences_reject_reparse_spelling_before_resolving(configured, monkeypatch, mode, attributes):  # noqa: F811
    base, _, _, _, _ = configured
    alias = base.root / "reparse-preferences"
    original_lstat, original_resolve = Path.lstat, Path.resolve

    def lstat(path, *args, **kwargs):
        if path == alias:
            return SimpleNamespace(st_mode=mode, st_file_attributes=attributes)
        return original_lstat(path, *args, **kwargs)

    def resolve(path, *args, **kwargs):
        assert path != alias, "Authored reparse paths must be rejected before resolve"
        return original_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", lstat)
    monkeypatch.setattr(Path, "resolve", resolve)
    with pytest.raises(DomainError) as failure:
        LegacyPreferencesRepository(base, alias)
    assert failure.value.code == "legacy_source_path"


def test_preferences_accept_windows_short_names_when_available(configured, record_property):  # noqa: F811
    base, _, _, _, _ = configured
    expected = base.root / "Preferences with a long directory name"
    expected.mkdir()
    alias = windows_spelling(expected, record_property)
    repository = LegacyPreferencesRepository(base, alias)
    try:
        assert repository.root == expected.resolve()
        assert repository.path.is_file()
    finally:
        repository.close()


def test_profile_resolves_mixed_state_and_preference_spellings(profile, tmp_path, monkeypatch):  # noqa: F811
    filename, document = profile
    state = tmp_path / "state"
    alias = tmp_path / "short-alias"
    document["server"].update(state_root=str(state), preferences_root=str(alias / "preferences"))
    filename.write_text(yaml.safe_dump(document), encoding="utf-8")
    original = Path.resolve

    def resolve(path, *args, **kwargs):
        return state / "preferences" if path == alias / "preferences" else original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", resolve)
    configuration = load_launch_configuration(filename)
    assert configuration["state_root"] == state
    assert configuration["preferences_root"] == state / "preferences"


@pytest.mark.parametrize("field", ["state_root", "preferences_root"])
@pytest.mark.parametrize("mode,attributes", [(stat.S_IFLNK, 0), (stat.S_IFDIR, 0x400)])
def test_profile_reparse_guards_precede_canonicalization(profile, tmp_path, monkeypatch, field, mode, attributes):  # noqa: F811
    filename, document = profile
    alias = tmp_path / "state" / "reparse-preferences"
    document["server"][field] = str(alias)
    filename.write_text(yaml.safe_dump(document), encoding="utf-8")
    original_lstat, original_resolve = Path.lstat, Path.resolve

    def lstat(path, *args, **kwargs):
        if path == alias:
            return SimpleNamespace(st_mode=mode, st_file_attributes=attributes)
        return original_lstat(path, *args, **kwargs)

    def resolve(path, *args, **kwargs):
        assert path != alias, "Profile reparse paths must be rejected before resolve"
        return original_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", lstat)
    monkeypatch.setattr(Path, "resolve", resolve)
    with pytest.raises(DomainError) as failure:
        load_launch_configuration(filename)
    assert failure.value.code == "legacy_source_path"


def test_profile_accepts_real_short_state_with_long_preferences(profile, tmp_path, record_property):  # noqa: F811
    filename, document = profile
    state = tmp_path / "Application state with a long directory name"
    state.mkdir()
    document["server"].update(state_root=str(windows_spelling(state, record_property)), preferences_root=str(state / "preferences"))
    filename.write_text(yaml.safe_dump(document), encoding="utf-8")
    configuration = load_launch_configuration(filename)
    assert configuration["state_root"] == state.resolve()
    assert configuration["preferences_root"] == state.resolve() / "preferences"
