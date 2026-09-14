from __future__ import annotations

import copy

from ..models.domain import DomainError
from .identity import ROLES, authorize, authorized_sources, scope_fingerprint
from .query_access import query_access


class WorkspaceAccess:
    """Resolve trusted scope at the root, then acquire workspace locks in that order."""

    def __init__(self, identities, repository, queries):
        self.identities, self.repository, self.queries = identities, repository, queries
        self.workspace_id = repository.meta["manifest"]["workspaceId"]
        self._unsubscribe_authorization = identities.subscribe_authorization(self._authorization_changed)

    def _authorization_changed(self, principal_ids):
        if principal_ids is None:
            self.queries.invalidate_all()
        else:
            for principal_id in principal_ids:
                self.queries.invalidate_principal(principal_id)

    def close(self):
        self._unsubscribe_authorization()

    def _current(self, identity, capability):
        self.identities._ready()
        current = self.identities._current(identity)
        authorize(current, capability, self.workspace_id)
        return current

    def _scope(self, current):
        sources = self.repository.meta["manifest"]["scope"]["sourceIds"]
        return {"principalId": current["id"], "fingerprint": scope_fingerprint(current, self.workspace_id),
                "actor": {"id": current["id"], "capabilities": self._capabilities(current)},
                "sourceIds": authorized_sources(current, self.workspace_id, sources)}

    def _capabilities(self, current):
        if current["role"] == "admin":
            return ["*"]
        grant = next(grant for grant in current["grants"] if grant["workspaceId"] == self.workspace_id)
        return sorted(ROLES[current["role"]] | set(grant["capabilities"]))

    def metadata(self, identity):
        with self.identities.mutex, self.repository.mutex:
            current = self._current(identity, "records.read")
            scope = self._scope(current)
            result = self.repository.metadata()
            if hasattr(self.repository, "project_scope"):
                result = self.repository.project_scope(result, scope["sourceIds"])
            capabilities = self._capabilities(current)
            def can(name):
                return "*" in capabilities or name in capabilities
            visible = [record for record in self.repository.records.values()
                       if record["sourceId"] in scope["sourceIds"] and record["deletedAt"] is None]
            result["sources"] = sorted({record["sourceId"] for record in visible})
            result["sourceIds"] = scope["sourceIds"]
            result["recordCount"] = len(visible)
            if getattr(self.repository, "lazy", False):
                result["sources"] = scope["sourceIds"]
                result["recordCount"] = self.repository.coverage(scope["sourceIds"])["recordCount"]
            result["actor"] = {"id": current["id"], "name": current["name"], "role": current["role"],
                               "capabilities": capabilities, "sourceIds": scope["sourceIds"]}
            result["capabilities"].update({"write": can("records.edit"), "recordCrud": can("records.edit"),
                                           "export": can("export"), "importExport": can("import"),
                                           "modelManagement": can("configuration.manage"),
                                           "modelPublication": can("configuration.publish"),
                                           "admin": can("workspace.manage"),
                                           "serverAdministration": current["role"] == "admin"})
            if getattr(self.repository, "read_only", False):
                result["capabilities"].update(write=False, recordCrud=False, importExport=False,
                                               modelManagement=False, modelPublication=False,
                                               configurationManagement=False, legacyReload=can("workspace.manage"))
            return result

    def query(self, identity, operation, *args):
        with self.identities.mutex:
            try:
                current = self._current(identity, "records.read")
            except DomainError:
                self.queries.invalidate_principal(identity["id"])
                raise
            scope = self._scope(current)
        with query_access(scope):
            result = getattr(self.queries, operation)(*args)
        # Preparation can be expensive. Do not block revocation while it runs.
        try:
            with self.identities.mutex:
                current = self._current(identity, "records.read")
                if scope["fingerprint"] != scope_fingerprint(current, self.workspace_id):
                    raise DomainError("permission_scope_changed", "Permissions changed; prepare a new query.", 409)
        except DomainError:
            try:
                with query_access(scope):
                    if operation == "create_query":
                        self.queries.release_query(result["queryId"])
                    elif operation == "create_layout":
                        self.queries.release_layout(args[0], result["layoutId"])
            except DomainError:
                pass  # Expiry or concurrent invalidation may already have released it.
            raise
        return result

    def read(self, identity, operation, *args):
        with self.identities.mutex, self.repository.mutex:
            current = self._current(identity, "records.read")
            if operation == "get_record":
                result = self.repository.get_record(*args)
                authorize(current, "records.read", self.workspace_id, result["sourceId"])
                return result
            if operation in ("list_models", "get_model"):
                authorize(current, "configuration.read", self.workspace_id)
                result = getattr(self.repository, operation)(*args)
                if hasattr(self.repository, "project_scope"):
                    result = self.repository.project_scope(result, self._scope(current)["sourceIds"])
                return result
            raise RuntimeError("Unregistered authorized read operation.")

    def records(self, identity, limit, offset, kind=None):
        with self.identities.mutex, self.repository.mutex:
            current = self._current(identity, "records.read")
            scope = self._scope(current)
            self.repository._ensure_available()
            if getattr(self.repository, "lazy", False):
                raise DomainError("time_range_required", "Use a time-window query or explicit complete export for legacy archives.", 422)
            records = sorted((record for record in self.repository.records.values()
                              if record["sourceId"] in scope["sourceIds"] and record["deletedAt"] is None
                              and (kind is None or record["kind"] == kind)),
                             key=lambda record: record["id"])
            return {"items": copy.deepcopy(records[offset:offset + limit]), "total": len(records),
                    "revision": self.repository.meta["manifest"]["revision"],
                    "nextOffset": offset + limit if offset + limit < len(records) else None}

    def mutate(self, identity, operation, record_id, payload, *preconditions, expected_kind=None, request_route=None):
        capability = {"create": "records.create", "update": "records.edit", "delete": "records.delete",
                      "replace": "records.edit", "patch": "records.edit", "restore": "records.restore"}[operation]
        with self.identities.mutex, self.repository.mutex:
            current = self._current(identity, capability)
            if record_id is not None:
                existing = self.repository.get_record(record_id, True)
                authorize(current, capability, self.workspace_id, existing["sourceId"])
                if expected_kind is not None and existing["kind"] != expected_kind:
                    raise DomainError("record_not_found", "Record does not exist in this collection.", 404)

            def authorize_record(record):
                authorize(current, capability, self.workspace_id, record["sourceId"])
                parent_id = record.get("parentSessionId")
                if parent_id is not None:
                    parent = self.repository.records.get(parent_id) if isinstance(parent_id, str) else None
                    if parent is not None:
                        authorize(current, "records.read", self.workspace_id, parent["sourceId"])

            return self.repository.mutate(operation, record_id, payload, *preconditions, current["id"],
                                          expected_kind=expected_kind, request_route=request_route,
                                          authorize_record=authorize_record)

    def mutate_model(self, identity, operation, target_id, payload, *preconditions):
        with self.identities.mutex, self.repository.mutex:
            current = self._current(identity, "configuration.manage")
            if operation == "publish":
                authorize(current, "configuration.publish", self.workspace_id)
            return self.repository.mutate_model(operation, target_id, payload, *preconditions, current["id"])

    def mutate_batch(self, identity, payload, generation, command_id, request_route):
        with self.identities.mutex, self.repository.mutex:
            current = self._current(identity, "records.read")

            def authorize_record(operation, record):
                capability = {"create": "records.create", "delete": "records.delete", "restore": "records.restore"}.get(operation, "records.edit")
                authorize(current, capability, self.workspace_id, record["sourceId"])
                parent = self.repository.records.get(record.get("parentSessionId"))
                if parent is not None:
                    authorize(current, "records.read", self.workspace_id, parent["sourceId"])

            return self.repository.mutate_batch(payload, generation, command_id, current["id"],
                                                request_route=request_route, authorize_record=authorize_record)

    def outcome(self, identity, command_id):
        with self.identities.mutex, self.repository.mutex:
            current = self._current(identity, "records.read")
            result = self.repository.command_outcome(current["id"], command_id)
            record = result.get("record")
            if record is not None:
                authorize(current, "records.read", self.workspace_id, record["sourceId"])
            for item in result.get("items", []):
                if "record" in item:
                    authorize(current, "records.read", self.workspace_id, item["record"]["sourceId"])
            return result
