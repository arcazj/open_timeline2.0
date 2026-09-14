from __future__ import annotations

import re
import secrets
import threading
import time
import uuid

from ..models.domain import DomainError
from ..repositories.audit_history import audit_path
from .identity import authorize, authorized_sources, scope_fingerprint


class ChangeService:
    STREAM_LIMIT = 64
    PRINCIPAL_STREAM_LIMIT = 2
    LEASE_SECONDS = 5

    def __init__(self, identities, repository):
        self.identities, self.repository = identities, repository
        self.workspace_id = repository.meta["manifest"]["workspaceId"]
        self.leases = {}
        self.mutex = threading.RLock()
        self.closed = False

    def page(self, identity, generation, after_revision, limit=100, scope=None):
        try:
            if not isinstance(generation, str) or str(uuid.UUID(generation)) != generation:
                raise ValueError()
        except ValueError as error:
            raise DomainError("invalid_generation", "Generation must be a UUID.", 422) from error
        if type(after_revision) is not int or not 0 <= after_revision <= 9007199254740991:
            raise DomainError("invalid_revision", "afterRevision must be a nonnegative safe integer.", 422)
        if type(limit) is not int or not 1 <= limit <= 500:
            raise DomainError("invalid_page", "Change limit must be 1-500.", 422)
        if scope is not None and (not isinstance(scope, str) or re.fullmatch(r"[0-9a-f]{64}", scope) is None):
            raise DomainError("invalid_scope", "Scope must be a lowercase SHA-256 fingerprint.", 422)
        with self.identities.mutex, self.repository.mutex:
            self.identities._ready()
            current = self.identities._current(identity)
            authorize(current, "records.read", self.workspace_id)
            self.repository._ensure_available()
            manifest = self.repository.meta["manifest"]
            current_scope = scope_fingerprint(current, self.workspace_id)
            if scope is not None and scope != current_scope:
                raise DomainError("permission_scope_changed", "Change feed permissions changed; reload an authorized snapshot.", 409)
            if generation != manifest["generation"]:
                raise DomainError("generation_mismatch", "Workspace generation changed; reload an authorized snapshot.", 409)
            through = manifest["revision"]
            if after_revision > through:
                raise DomainError("invalid_revision", "afterRevision is ahead of the workspace.", 422)
            state = self.repository.audit_state
            first = state["firstRevision"] if state else through + 1
            if after_revision < first - 1:
                raise DomainError("replay_gap", "Change history does not cover this revision; reload an authorized snapshot.", 409)
            sources = set(authorized_sources(current, self.workspace_id, manifest["scope"]["sourceIds"]))
            unrestricted = current["role"] == "admin" or any(grant["workspaceId"] == self.workspace_id and grant["sourceIds"] is None for grant in current["grants"])
            selected = []
            for revision in range(after_revision + 1, through + 1):
                entry = self.repository.audit_entries.get(audit_path(revision))
                if entry is None:
                    raise DomainError("replay_gap", "Change history does not cover this revision; reload an authorized snapshot.", 409)
                if entry["visibility"] == "personal" and current["role"] != "admin" and entry["ownerId"] != current["id"]:
                    continue
                if entry["records"]:
                    if any(record["sourceId"] not in sources for record in entry["records"]):
                        continue
                elif entry["visibility"] != "personal" and not unrestricted:
                    continue
                selected.append({"revision": entry["revision"], "family": entry["family"],
                                 "recordIds": sorted({record["id"] for record in entry["records"]}), "requiresReload": True})
                if len(selected) > limit:
                    break
            more = len(selected) > limit
            changes = selected[:limit]
            return {"generation": manifest["generation"], "scope": current_scope, "throughRevision": through,
                    "nextRevision": changes[-1]["revision"] if more else through, "changes": changes, "hasMore": more}

    def _cleanup(self):
        now = time.monotonic()
        self.leases = {key: value for key, value in self.leases.items() if value["expires"] > now}

    def admit_stream(self, identity, generation, after_revision, limit=100, scope=None):
        page = self.page(identity, generation, after_revision, limit, scope)
        with self.mutex:
            self._cleanup()
            if self.closed:
                raise DomainError("server_unavailable", "Change service is closed.", 503)
            if len(self.leases) >= self.STREAM_LIMIT or sum(value["principalId"] == identity["id"] for value in self.leases.values()) >= self.PRINCIPAL_STREAM_LIMIT:
                raise DomainError("stream_capacity", "Change stream capacity is exhausted.", 429)
            lease = secrets.token_hex(24)
            self.leases[lease] = {"principalId": identity["id"], "expires": time.monotonic() + self.LEASE_SECONDS}
            return {"lease": lease, "page": page}

    def stream_page(self, lease, identity, generation, after_revision, limit=100, scope=None):
        with self.mutex:
            self._cleanup()
            if self.closed or lease not in self.leases or self.leases[lease]["principalId"] != identity["id"]:
                raise DomainError("stream_expired", "Change stream lease expired.", 409)
            self.leases[lease]["expires"] = time.monotonic() + self.LEASE_SECONDS
        page = self.page(identity, generation, after_revision, limit, scope)
        with self.mutex:
            self._cleanup()
            if self.closed or lease not in self.leases:
                raise DomainError("stream_expired", "Change stream lease expired.", 409)
            self.leases[lease]["expires"] = time.monotonic() + self.LEASE_SECONDS
        return page

    def release_stream(self, lease):
        with self.mutex:
            self.leases.pop(lease, None)

    def close(self):
        with self.mutex:
            self.closed = True
            self.leases.clear()
