import os
import subprocess

import pytest

from conftest import ROOT
from server.app.models.domain import DomainError
from server.app.repositories import storage_migration as migration
from server.app.repositories.json_repository import JsonRepository, atomic_json

SEED = ROOT / "data/default-dataset.json"


@pytest.fixture
def source(tmp_path):
    root = tmp_path / "source"
    repository = JsonRepository(root, SEED).open()
    repository.close()
    return root


def directory_alias(link, target):
    if os.name == "nt":
        subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(target)],
                       check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        link.symlink_to(target, target_is_directory=True)


def remove_alias(link, temporary_root):
    assert link.parent.resolve().is_relative_to(temporary_root.resolve())
    if os.name == "nt":
        assert link.lstat().st_file_attributes & 0x400
        link.rmdir()
    else:
        assert link.is_symlink()
        link.unlink()


@pytest.mark.parametrize("case", ["source", "source-parent", "destination", "destination-parent", "normalized-parent"])
def test_original_alias_ancestry_is_rejected_before_resolution(source, tmp_path, case):
    before = {path.relative_to(source): path.read_bytes() for path in source.rglob("*.json")}
    alias = tmp_path / "alias"
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "sentinel.json"
    sentinel.write_bytes(b'{"untouched":true}')
    source_input, destination = source, tmp_path / "destination"
    if case == "source":
        directory_alias(alias, source)
        source_input = alias
    elif case == "source-parent":
        directory_alias(alias, tmp_path)
        source_input = alias / source.name
    elif case == "destination":
        directory_alias(alias, outside)
        destination = alias
    elif case == "destination-parent":
        directory_alias(alias, outside)
        destination = alias / "destination"
    else:
        directory_alias(alias, outside)
        source_input = alias / ".." / source.name
    try:
        with pytest.raises(DomainError) as error:
            migration.migrate_storage(source_input, destination, SEED)
        assert error.value.code == "migration_integrity" and error.value.status == 503
        assert before == {path.relative_to(source): path.read_bytes() for path in source.rglob("*.json")}
        assert sentinel.read_bytes() == b'{"untouched":true}'
        assert {path.name for path in outside.iterdir()} == {"sentinel.json"}
        assert not (tmp_path / "destination").exists()
    finally:
        remove_alias(alias, tmp_path)


def test_lexical_aliases_of_the_source_remain_path_conflicts(source):
    for destination in (source / ".", source / "missing" / "..", source / "nested"):
        with pytest.raises(DomainError) as error:
            migration.migrate_storage(source, destination, SEED)
        assert error.value.code == "migration_path_conflict"


def test_destination_parent_alias_added_during_preparation_is_rejected(source, tmp_path, monkeypatch):
    parent = tmp_path / "new-parent"
    parent.mkdir()
    original_parent = tmp_path / "original-parent"
    outside = tmp_path / "outside"
    outside.mkdir()
    original = migration.build_layout

    def replace_parent(*args, **kwargs):
        result = original(*args, **kwargs)
        assert parent.parent == original_parent.parent == tmp_path
        parent.rename(original_parent)
        directory_alias(parent, outside)
        return result

    monkeypatch.setattr(migration, "build_layout", replace_parent)
    try:
        with pytest.raises(DomainError) as error:
            migration.migrate_storage(source, parent / "destination", SEED)
        assert error.value.code == "migration_integrity"
        assert not list(outside.iterdir()) and not list(original_parent.iterdir())
    finally:
        remove_alias(parent, tmp_path)


@pytest.mark.parametrize("replacement", ["directory", "junction"])
def test_replaced_staging_root_is_not_written_or_cleaned_up(source, tmp_path, monkeypatch, replacement):
    destination, preserved = tmp_path / "destination", tmp_path / "preserved-staging"
    outside = tmp_path / "outside"
    outside.mkdir()
    atomic_json(outside / "sentinel.json", {"untouched": True})
    before = {path.relative_to(source): path.read_bytes() for path in source.rglob("*.json")}
    original = migration.atomic_json

    def swap_after_marker(path, document):
        original(path, document)
        if path.name == "migration-incomplete.json":
            assert destination.parent == preserved.parent == tmp_path
            destination.rename(preserved)
            if replacement == "junction":
                directory_alias(destination, outside)
            else:
                destination.mkdir()

    monkeypatch.setattr(migration, "atomic_json", swap_after_marker)
    try:
        with pytest.raises(DomainError) as error:
            migration.migrate_storage(source, destination, SEED)
        assert error.value.code == "migration_integrity"
        assert (preserved / "migration-incomplete.json").is_file()
        assert {path.name for path in outside.iterdir()} == {"sentinel.json"}
        assert before == {path.relative_to(source): path.read_bytes() for path in source.rglob("*.json")}
        if replacement == "directory":
            assert not list(destination.iterdir())
    finally:
        if replacement == "junction":
            remove_alias(destination, tmp_path)
