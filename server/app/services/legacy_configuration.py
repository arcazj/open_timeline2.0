"""Read-only catalog access without copying an entire archive for metadata reads."""

from ..models.configuration_catalog import normalize_configuration
from ..models.domain import DomainError
from .configuration import ConfigurationService


class LegacyConfigurationService(ConfigurationService):
    def __init__(self, identities, repository):
        super().__init__(identities, repository)
        self._full_service = _LegacyRecordConfiguration(identities, repository)

    def _snapshot(self, actor):
        manifest = self.repository.meta["manifest"]
        key = (manifest["generation"], manifest["revision"], tuple(actor["sourceIds"]))
        if self._cached_key != key:
            self._cached_snapshot = normalize_configuration({**self.repository.meta, "records": []}, actor)
            self.repository.project_scope(self._cached_snapshot, actor["sourceIds"])
            self._cached_key = key
        return self._cached_snapshot

    def _allowed(self, *args):
        return []

    def export_snapshot(self, identity):
        return self._full_service.export_snapshot(identity)

    def usage(self, identity, *args, **kwargs):
        return self._full_service.usage(identity, *args, **kwargs)

    def mutate(self, *args, **kwargs):
        raise DomainError("legacy_read_only", "Legacy source configuration is read-only.", 403)

    mutate_settings = mutate
    preview_impact = mutate

    def outcome(self, *args):
        raise DomainError("command_not_found", "Read-only legacy sources have no write commands.", 404)


class _LegacyRecordConfiguration(ConfigurationService):
    def _snapshot(self, actor):
        if getattr(self.repository, "lazy", False):
            snapshot = normalize_configuration(self.repository.query_snapshot(), actor)
            snapshot["records"] = [record for record in snapshot["records"] if record["sourceId"] in actor["sourceIds"]]
            snapshot["manifest"]["recordCount"] = len(snapshot["records"])
            return snapshot
        snapshot = normalize_configuration({**self.repository.meta, "records": []}, actor)
        snapshot["records"] = [record for record in self.repository.records.values()
                               if record["sourceId"] in actor["sourceIds"]]
        snapshot["manifest"]["recordCount"] = len(snapshot["records"])
        return self.repository.project_scope(snapshot, actor["sourceIds"])
