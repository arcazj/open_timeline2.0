"""Writable app-owned views and preferences over read-only legacy data."""
from ..models.configuration_catalog import normalize_configuration
from ..models.domain import DomainError, content_checksum
from .configuration import ConfigurationService
from .legacy_configuration import LegacyConfigurationService, _LegacyRecordConfiguration


class LegacyPreferencesConfigurationService(LegacyConfigurationService):
    def __init__(self, identities, repository):
        super().__init__(identities, repository)
        self._full_service = _LegacyPreferencesRecordConfiguration(identities, repository)

    def _snapshot(self, actor):
        metadata = self.repository.meta
        key = (metadata["manifest"]["generation"], metadata["manifest"]["revision"], self.repository.base.meta["manifest"]["revision"])
        if self._cached_key != key:
            self._cached_snapshot = normalize_configuration({**metadata, "records": []}, actor)
            self._cached_key = key
        return self._cached_snapshot

    def _allowed(self, snapshot, family, resource, actor):
        if family not in ("filters", "views"):
            return []
        if resource and resource["id"] in {item["id"] for item in self.repository._base_metadata()[family]}:
            return [action for action in ConfigurationService._allowed(self, snapshot, family, resource, actor) if action in ("duplicate", "apply")]
        return ConfigurationService._allowed(self, snapshot, family, resource, actor)

    def mutate(self, identity, command, *args, **kwargs):
        if not isinstance(command, dict) or command.get("family") not in ("filters", "views"):
            raise DomainError("legacy_read_only", "Only app-owned filters and views can be changed; legacy data and models remain read-only.", 403)
        family, resource_id = command["family"], command.get("resourceId")
        if resource_id and command.get("type") not in ("duplicate", "apply") and resource_id in {item["id"] for item in self.repository._base_metadata()[family]}:
            raise DomainError("legacy_read_only", "Duplicate an imported legacy definition before editing it.", 403)
        return ConfigurationService.mutate(self, identity, command, *args, **kwargs)

    mutate_settings = ConfigurationService.mutate_settings
    outcome = ConfigurationService.outcome


class _LegacyPreferencesRecordConfiguration(ConfigurationService):
    def _snapshot(self, actor):
        source = _LegacyRecordConfiguration(self.identities, self.repository.base)._snapshot(actor)
        return self.repository.apply(source)

    def export_snapshot(self, identity):
        snapshot = super().export_snapshot(identity)
        snapshot["manifest"]["localPreferencesPrincipalId"] = identity["id"]
        owned = snapshot["manifest"]["legacy"]["preferencesCatalogIds"]
        for family in ("filters", "views"):
            retained = {item["id"] for item in snapshot[family]}
            owned[family] = [resource_id for resource_id in owned[family] if resource_id in retained]
        snapshot["manifest"]["contentSha256"] = content_checksum(snapshot)
        return snapshot
