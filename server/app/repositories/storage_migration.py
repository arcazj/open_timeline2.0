"""Offline, non-destructive migration into a separate authoritative shard root."""
from pathlib import Path

from ..models.domain import DomainError, read_json, validate_snapshot
from ..services.identity import IdentityStore
from .json_repository import JsonRepository, atomic_json, sync_directory
from .json_shards import build_layout


def _safe_absolute(path):
    from ..services.backup import _absolute, _plain

    path = Path(path)
    if path.drive and not path.is_absolute():
        raise DomainError("migration_path_conflict", "Drive-relative migration paths are ambiguous.", 409)
    if not path.is_absolute():
        path = Path.cwd() / path
    try:
        # Check the original prefixes before either '..' normalization or alias resolution.
        for prefix in reversed((path, *path.parents)):
            if prefix.exists() or prefix.is_symlink():
                _plain(prefix, directory=True)
        checked = _absolute(path)
        resolved = checked.resolve()
        _absolute(checked)
        return _absolute(resolved)
    except (DomainError, OSError, RuntimeError) as error:
        raise DomainError("migration_integrity", "Migration paths must have regular, link-free directory ancestry.", 503) from error


class _MigrationSource(JsonRepository):
    def _recover(self):
        if (self.root / "transaction.json").exists():
            raise DomainError("migration_recovery_required", "Recover the source with its ordinary owner before offline migration.", 409)

    def _seed(self):
        raise DomainError("migration_source_missing", "Migration cannot initialize or repair its source.", 409)


def migrate_storage(source, destination, seed_path):
    source, destination = _safe_absolute(source), _safe_absolute(destination)
    if source == destination or source.is_relative_to(destination) or destination.is_relative_to(source):
        raise DomainError("migration_path_conflict", "Source and destination must be separate, non-nested roots.", 409)
    if destination.exists():
        raise DomainError("migration_destination_exists", "Migration never overwrites an existing destination.", 409)
    if not (source / "workspace.json").is_file():
        raise DomainError("migration_source_missing", "Migration requires an existing workspace; it never seeds the source.", 404)
    controls = source / "control"
    identities = None
    repository = None
    try:
        # Root identity ownership precedes workspace ownership, matching service lock order.
        if controls.exists():
            if controls.is_symlink() or not controls.is_dir() or getattr(controls.lstat(), "st_file_attributes", 0) & 0x400:
                raise DomainError("migration_integrity", "Identity control directory must not be a link.", 503)
            if {path.name for path in controls.iterdir()} - {"identities.json", ".identities.lock"}:
                raise DomainError("migration_integrity", "Unrecognized control authority cannot be silently omitted.", 503)
            if not (controls / "identities.json").is_file():
                raise DomainError("migration_integrity", "Identity control metadata is missing.", 503)
            identities = IdentityStore(controls, None)
            identities.open()
        repository = _MigrationSource(source, seed_path).open()
        if repository.layout is not None:
            raise DomainError("migration_layout_conflict", "Source already uses authoritative JSON shards.", 409)
        if {path.name for path in source.iterdir()} - {"workspace.json", "records", "outcomes", "control", ".writer.lock", "restore-provenance.json", "audit", "audit-state.json"}:
            raise DomainError("migration_integrity", "Unrecognized source authority cannot be silently omitted.", 503)
        from ..services.backup import _inventory, _read_json
        from .audit_history import AUDIT_ENTRY_BYTES, validate_audit_history
        # Migration may precede root identity adoption; its existing no-control mode remains supported.
        audit_paths = []
        if controls.exists():
            audit_paths = [relative for relative in _inventory(source) if relative.startswith("audit/")]
        elif (source / "audit").exists():
            repository._checked_path("audit/0000000000000001.json")
            audit_paths = [path.relative_to(source).as_posix() for path in sorted((source / "audit").iterdir())]
        audit_documents = {relative: _read_json(source / relative, AUDIT_ENTRY_BYTES) for relative in audit_paths}
        audit_state = _read_json(source / "audit-state.json") if (source / "audit-state.json").exists() else None
        validate_audit_history(audit_state, audit_documents, repository.meta["manifest"])
        provenance = None
        if (source / "restore-provenance.json").exists():
            from ..services.backup import validate_provenance
            provenance = _read_json(source / "restore-provenance.json")
            validate_provenance(provenance)
            last = provenance["restores"][-1]
            if last["workspaceGeneration"] != repository.meta["manifest"]["generation"] or last["workspaceId"] != repository.meta["manifest"]["workspaceId"]:
                raise DomainError("migration_integrity", "Restore provenance does not match the source workspace.", 503)
        repository._checked_path("outcomes/" + "0" * 64 + ".json")
        outcomes = list((source / "outcomes").glob("*.json"))
        layout, shards = build_layout(list(repository.records.values()), repository.meta["manifest"])
        _safe_absolute(source)
        _safe_absolute(destination)
        destination.mkdir(parents=False, exist_ok=False)
        destination_stat = destination.lstat()
        destination_identity = destination_stat.st_dev, destination_stat.st_ino

        def check_destination():
            _safe_absolute(destination)
            information = destination.lstat()
            if (information.st_dev, information.st_ino) != destination_identity:
                raise DomainError("migration_integrity", "Migration destination was replaced during staging.", 503)

        def write(relative, document):
            check_destination()
            path = destination / relative
            _safe_absolute(path.parent)
            if path.exists() or path.is_symlink():
                raise DomainError("migration_integrity", "Migration staging cannot overwrite an existing member.", 503)
            atomic_json(path, document)
            check_destination()

        marker = destination / "migration-incomplete.json"
        write(marker.name, {"formatVersion": 1, "source": str(source), "phase": "staging", "storageLayoutVersion": 2})
        for prefix, document in shards.items():
            write(f"shards/{prefix}.json", document)
        write("storage-layout.json", layout)
        write("workspace.json", repository.meta)
        if provenance is not None:
            write("restore-provenance.json", provenance)
        if audit_state is not None:
            write("audit-state.json", audit_state)
            for relative, document in audit_documents.items():
                write(relative, document)
        for path in outcomes:
            relative = "outcomes/" + path.name
            write(relative, repository._read_target(relative))
        if identities is not None:
            write("control/identities.json", identities.state)
        check_destination()
        staged = JsonRepository(destination, seed_path)
        staged.meta = read_json(destination / "workspace.json")
        records = staged._load_records()
        validate_snapshot({**staged.meta, "records": list(records.values())})
        if identities is not None:
            identities._validate(read_json(destination / "control" / "identities.json"))
        check_destination()
        from ..services.backup import _plain
        _plain(marker)
        marker.unlink()
        sync_directory(destination)
        return {"storageLayoutVersion": 2, "recordCount": len(records), "shardCount": len(shards),
                "source": str(source), "destination": str(destination), "activated": False,
                "nextStep": "Keep the source service stopped; explicitly configure the service data root to the validated destination. Never run both roots as writers."}
    finally:
        if repository is not None:
            repository.close()
        if identities is not None:
            identities.close()
