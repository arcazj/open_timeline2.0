"""Authorized catalog reads and atomic JSON-only configuration transactions."""
from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import json
import secrets
import uuid
from collections import OrderedDict

import rfc8785

from ..models.configuration_catalog import (
    FAMILIES, apply_configuration_command, configuration_usage, effective_settings,
    normalize_configuration, resolved_data_schema, validate_resource_definition,
)
from ..models.domain import DomainError, MAX_SAFE_INT, _compile_schema, content_checksum, now_iso, validate_snapshot
from ..models.settings_commands import apply_settings_command
from .identity import ROLES, authorize, authorized_sources, scope_fingerprint


class ConfigurationService:
    def __init__(self, identities, repository):
        self.identities, self.repository = identities, repository
        self.workspace_id = repository.meta["manifest"]["workspaceId"]
        self._cached_key, self._cached_snapshot = None, None
        self._cursor_secret = secrets.token_bytes(32)
        self._impacts = OrderedDict()

    def _current(self, identity):
        self.identities._ready()
        current = self.identities._current(identity)
        authorize(current, "configuration.read", self.workspace_id)
        self.repository._ensure_available()
        if current["role"] == "admin":
            capabilities = ["*"]
        else:
            grant = next(item for item in current["grants"] if item["workspaceId"] == self.workspace_id)
            capabilities = sorted(ROLES[current["role"]] | set(grant["capabilities"]))
        return current, {"id": current["id"], "capabilities": capabilities,
                         "sourceScopeAll": current["role"] == "admin" or grant["sourceIds"] is None,
                         "sourceIds": authorized_sources(current, self.workspace_id, self.repository.meta["manifest"]["scope"]["sourceIds"])}

    def _snapshot(self, actor):
        manifest = self.repository.meta["manifest"]
        key = (manifest["generation"], manifest["revision"])
        if key != self._cached_key:
            self._cached_snapshot = normalize_configuration({**self.repository.meta, "records": list(self.repository.records.values())}, actor)
            self._cached_key = key
        return self._cached_snapshot

    @staticmethod
    def _can(actor, capability):
        return "*" in actor["capabilities"] or capability in actor["capabilities"]

    @staticmethod
    def _revision_text(value):
        return str(int(value)) if type(value) in (int, float) and value == int(value) else str(value)

    def _readable(self, snapshot, family, resource, actor, seen=None):
        if resource is None:
            return False
        if resource.get("visibility") == "personal" and resource.get("ownerId") != actor["id"] and not self._can(actor, "configuration.manage"):
            return False
        if family == "sources" and not actor.get("sourceScopeAll") and resource["id"] not in actor["sourceIds"]:
            return False
        seen = set() if seen is None else seen
        key = (family, resource["id"])
        if key in seen:
            return True
        seen.add(key)
        definitions = [version["definition"] for version in resource.get("versions", [])]
        if resource.get("draft") is not None:
            definitions.append(resource["draft"])
        for definition in definitions:
            if not self._definition_readable(snapshot, family, definition, actor, seen):
                return False
        return True

    def _definition_readable(self, snapshot, family, definition, actor, seen=None):
        references = []
        if family == "sources" and definition.get("defaultSchema"):
            references.append(("schemas", definition["defaultSchema"]["id"]))
        if family == "filters":
            if not actor.get("sourceScopeAll") and definition.get("sourceIds") is not None and any(source not in actor["sourceIds"] for source in definition["sourceIds"]):
                return False
            references.extend(("schemas", pin["id"]) for pin in definition.get("schemaRefs", []))
        if family == "views":
            references.append(("models", definition["model"]["id"]))
            if definition.get("filter"):
                references.append(("filters", definition["filter"]["id"]))
        for target, resource_id in references:
            resource = next((item for item in snapshot.get(target, []) if item["id"] == resource_id), None)
            if not self._readable(snapshot, target, resource, actor, seen):
                return False
        return True

    def _resource(self, snapshot, family, resource_id, actor):
        if family not in FAMILIES:
            raise DomainError("configuration_not_found", "Configuration family is unavailable.", 404)
        resource = next((item for item in snapshot[family] if item["id"] == resource_id), None)
        if not self._readable(snapshot, family, resource, actor):
            raise DomainError("configuration_not_found", "Configuration resource is unavailable.", 404)
        return resource

    def _allowed(self, snapshot, family, resource, actor):
        manage = self._can(actor, "configuration.manage") or (resource["visibility"] == "personal" and resource["ownerId"] == actor["id"] and self._can(actor, "configuration.personal"))
        actions = []
        if self._can(actor, "configuration.personal") or self._can(actor, "configuration.manage"):
            if family not in ("sources", "groups") or (self._can(actor, "configuration.manage") and self._can(actor, "configuration.publish") and (family != "sources" or actor.get("sourceScopeAll"))):
                actions.append("duplicate")
            if family in ("filters", "views") and resource["lifecycle"] == "active" and resource["versions"]:
                actions.append("apply")
        if manage:
            actions.append("unarchive" if resource["lifecycle"] == "archived" else "archive")
            if resource["lifecycle"] == "active":
                actions.append("update")
                if resource["draft"] is not None and (resource["visibility"] == "personal" or self._can(actor, "configuration.publish")):
                    actions.append("publish")
            if not configuration_usage(snapshot, family, resource["id"]):
                actions.append("delete")
        return actions

    @staticmethod
    def _envelope(snapshot, **values):
        return {"generation": snapshot["manifest"]["generation"], "revision": snapshot["manifest"]["revision"], **values}

    def list_resources(self, identity, family, include_archived=True):
        with self.identities.mutex, self.repository.mutex:
            _, actor = self._current(identity)
            snapshot = self._snapshot(actor)
            if family not in FAMILIES:
                raise DomainError("configuration_not_found", "Configuration family is unavailable.", 404)
            if type(include_archived) is not bool:
                raise DomainError("invalid_configuration", "includeArchived must be boolean.")
            items = []
            for resource in sorted(snapshot[family], key=lambda item: (item["name"], item["id"])):
                if (not include_archived and resource["lifecycle"] == "archived") or not self._readable(snapshot, family, resource, actor):
                    continue
                summary = {key: copy.deepcopy(value) for key, value in resource.items() if key not in ("draft", "versions")}
                summary.update(hasDraft=resource["draft"] is not None, publishedVersions=[version["version"] for version in resource["versions"]], allowedActions=self._allowed(snapshot, family, resource, actor))
                items.append(summary)
            return self._envelope(snapshot, family=family, items=items, total=len(items))

    def get_resource(self, identity, family, resource_id):
        with self.identities.mutex, self.repository.mutex:
            _, actor = self._current(identity)
            snapshot = self._snapshot(actor)
            resource = self._resource(snapshot, family, resource_id, actor)
            return self._envelope(snapshot, family=family, resource=copy.deepcopy(resource), allowedActions=self._allowed(snapshot, family, resource, actor))

    def validate(self, identity, family, definition, context=None):
        context = {} if context is None else context
        if not isinstance(context, dict) or set(context) - {"resourceId", "visibility"}:
            raise DomainError("invalid_configuration", "Validation context accepts only resourceId and visibility.")
        with self.identities.mutex, self.repository.mutex:
            _, actor = self._current(identity)
            snapshot = self._snapshot(actor)
            resource = self._resource(snapshot, family, context["resourceId"], actor) if "resourceId" in context else None
            visibility = resource["visibility"] if resource else context.get("visibility", "workspace" if family in ("sources", "groups") else "personal")
            if visibility not in ("personal", "workspace"):
                raise DomainError("invalid_configuration", "Invalid visibility.")
            resolved = {"snapshot": snapshot, "actor": actor, "visibility": visibility, "ownerId": resource["ownerId"] if resource else actor["id"], "newReference": True}
            result = validate_resource_definition(family, definition, resolved)
            if result["valid"] and not self._definition_readable(snapshot, family, definition, actor):
                return {"valid": False, "errors": [{"path": "/", "code": "configuration_not_found", "message": "Referenced configuration is unavailable."}]}
            return result

    def _encode_cursor(self, value):
        data = rfc8785.dumps(value)
        return base64.urlsafe_b64encode(data + b"." + hmac.digest(self._cursor_secret, data, "sha256")).decode().rstrip("=")

    def _decode_cursor(self, cursor):
        try:
            if not isinstance(cursor, str) or len(cursor) > 4096:
                raise ValueError()
            raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
            data, signature = raw[:-33], raw[-32:]
            if raw[-33:-32] != b"." or not hmac.compare_digest(signature, hmac.digest(self._cursor_secret, data, "sha256")):
                raise ValueError()
            return json.loads(data)
        except (ValueError, TypeError, UnicodeError, IndexError):
            raise DomainError("invalid_cursor", "Configuration cursor is invalid.", 400) from None

    def _usage_visible(self, item, snapshot, actor):
        if item["kind"] in ("record", "tombstone"):
            record = self.repository.records.get(item["id"])
            return record is not None and record["sourceId"] in actor["sourceIds"]
        if item["kind"] == "resource":
            resource = next((resource for resource in snapshot[item["family"]] if resource["id"] == item["id"]), None)
            return self._readable(snapshot, item["family"], resource, actor)
        if item["kind"] == "personal-preferences":
            return item["principalId"] == actor["id"] or self._can(actor, "configuration.manage")
        return True

    def usage(self, identity, family, resource_id, version=None, *, cursor=None, limit=100):
        if type(limit) is not int or not 1 <= limit <= 1000 or (version is not None and (type(version) is not int or not 1 <= version <= 32)):
            raise DomainError("invalid_configuration", "Invalid usage version or page size.")
        with self.identities.mutex, self.repository.mutex:
            current, actor = self._current(identity)
            snapshot = self._snapshot(actor)
            self._resource(snapshot, family, resource_id, actor)
            expected = {"kind": "usage", "generation": snapshot["manifest"]["generation"], "revision": snapshot["manifest"]["revision"], "scope": scope_fingerprint(current, self.workspace_id), "family": family, "id": resource_id, "version": version, "limit": limit}
            offset = 0
            if cursor is not None:
                decoded = self._decode_cursor(cursor)
                if any(decoded.get(key) != value for key, value in expected.items()) or type(decoded.get("offset")) is not int or decoded["offset"] < 0:
                    raise DomainError("stale_cursor", "Configuration or permission scope changed; restart the usage query.", 409)
                offset = decoded["offset"]
            references = configuration_usage(snapshot, family, resource_id, version)
            items = [item for item in references if self._usage_visible(item, snapshot, actor)]
            page = items[offset:offset + limit]
            return self._envelope(snapshot, family=family, items=copy.deepcopy(page), total=len(items), deletionBlocked=bool(references), nextCursor=self._encode_cursor({**expected, "offset": offset + len(page)}) if offset + len(page) < len(items) else None)

    def get_effective(self, identity, options=None):
        options = {} if options is None else options
        if not isinstance(options, dict) or set(options) - {"viewId", "viewVersion", "transient"}:
            raise DomainError("invalid_configuration", "Effective settings options are invalid.")
        with self.identities.mutex, self.repository.mutex:
            _, actor = self._current(identity)
            snapshot = self._snapshot(actor)
            names = {"viewId": "view_id", "viewVersion": "view_version", "transient": "transient"}
            result = effective_settings(snapshot, principal_id=actor["id"], **{names[key]: value for key, value in options.items()})
            for family, key in (("views", "viewId"), ("filters", "filterId")):
                if result["values"].get(key) is not None:
                    self._resource(snapshot, family, result["values"][key], actor)
            return self._envelope(snapshot, principalId=actor["id"], defaultsRevision=snapshot["defaults"]["revision"], **result)

    def export_snapshot(self, identity):
        with self.identities.mutex, self.repository.mutex:
            current, actor = self._current(identity)
            authorize(current, "export", self.workspace_id)
            snapshot = copy.deepcopy(self._snapshot(actor))
            snapshot["records"] = sorted((record for record in snapshot["records"] if record["sourceId"] in actor["sourceIds"]), key=lambda record: record["id"])
            snapshot["zones"] = [zone for zone in snapshot.get("zones", []) if not zone.get("legacy", {}).get("sourceId")
                                 or zone["legacy"]["sourceId"] in actor["sourceIds"]]
            for family in FAMILIES:
                snapshot[family] = [resource for resource in snapshot[family] if (resource["visibility"] == "workspace" or resource["ownerId"] == actor["id"]) and self._readable(snapshot, family, resource, actor)]
            snapshot["preferences"] = [item for item in snapshot["preferences"] if item["principalId"] == actor["id"]]
            snapshot["manifest"]["scope"]["sourceIds"] = list(actor["sourceIds"])
            snapshot["manifest"]["recordCount"] = len(snapshot["records"])
            snapshot["manifest"]["bundleId"] = str(uuid.uuid4())
            snapshot["manifest"].pop("contentSha256", None)
            try:
                snapshot = normalize_configuration(snapshot, actor)
                validate_snapshot(snapshot)
            except DomainError:
                raise DomainError("export_scope_dependencies", "This scope cannot form a complete authorized portable snapshot.", 409) from None
            snapshot["manifest"]["contentSha256"] = content_checksum(snapshot)
            return snapshot

    def _command_permission(self, snapshot, command, actor):
        family, operation = command.get("family"), command.get("type")
        if family not in FAMILIES:
            raise DomainError("invalid_configuration", "Unknown configuration family.")
        resource = self._resource(snapshot, family, command.get("resourceId"), actor) if operation != "create" else None
        if resource is not None:
            manage = self._can(actor, "configuration.manage") or (resource["visibility"] == "personal" and resource["ownerId"] == actor["id"] and self._can(actor, "configuration.personal"))
            allowed = self._can(actor, "configuration.personal") or self._can(actor, "configuration.manage") if operation in ("duplicate", "apply") else manage
            if not allowed or (operation == "publish" and resource["visibility"] == "workspace" and not self._can(actor, "configuration.publish")):
                raise DomainError("configuration_forbidden", "Configuration operation is not permitted.", 403)
        payload = {} if command.get("payload") is None else command["payload"]
        if not isinstance(payload, dict):
            raise DomainError("invalid_configuration", "Command payload must be an object.")
        definition = payload.get("definition") if operation == "create" else payload.get("draft") if operation == "update" else None
        if definition is not None:
            validation = validate_resource_definition(family, definition, {"snapshot": snapshot, "actor": actor, "visibility": resource["visibility"] if resource else payload.get("visibility", "workspace" if family in ("sources", "groups") else "personal"), "ownerId": resource["ownerId"] if resource else actor["id"], "newReference": True})
            if validation["valid"] and not self._definition_readable(snapshot, family, definition, actor):
                raise DomainError("configuration_not_found", "Referenced configuration is unavailable.", 404)
        return resource

    def _authorize_outcome(self, snapshot, result, authorization, actor):
        family = result.get("family")
        if family is None and result.get("status") == "committed" and "settings" in result:
            if authorization.get("scope") == "personal" and authorization.get("ownerId") != actor["id"]:
                raise DomainError("configuration_not_found", "Settings outcome is unavailable.", 404)
            values = result.get("effectiveSettings", {}).get("values", {})
            for target, field in (("views", "viewId"), ("filters", "filterId")):
                if values.get(field) is not None:
                    self._resource(snapshot, target, values[field], actor)
            return
        if family not in FAMILIES:
            raise DomainError("command_not_found", "Configuration outcome is unavailable.", 404)
        resource = result.get("resource")
        if resource is None:
            if authorization.get("visibility") == "personal" and authorization.get("ownerId") != actor["id"] and not self._can(actor, "configuration.manage"):
                raise DomainError("configuration_not_found", "Configuration outcome is unavailable.", 404)
            if not actor.get("sourceScopeAll") and any(source not in actor["sourceIds"] for source in authorization.get("sourceIds", [])):
                raise DomainError("configuration_not_found", "Configuration outcome is unavailable.", 404)
        elif not self._readable(snapshot, family, resource, actor):
            raise DomainError("configuration_not_found", "Configuration outcome is unavailable.", 404)
        values = result.get("effectiveSettings", {}).get("values", {})
        for target, field in (("views", "viewId"), ("filters", "filterId")):
            if values.get(field) is not None:
                self._resource(snapshot, target, values[field], actor)

    def outcome(self, identity, command_id):
        with self.identities.mutex, self.repository.mutex:
            _, actor = self._current(identity)
            snapshot = self._snapshot(actor)
            path = self.repository._outcome_path(actor["id"], command_id)
            stored = self.repository._read_target(path.relative_to(self.repository.root).as_posix())
            if stored is None:
                raise DomainError("command_not_found", "No committed outcome is known for this command key.", 404)
            if stored["result"].get("generation") != snapshot["manifest"]["generation"]:
                raise DomainError("generation_conflict", "This historical outcome belongs to a previous workspace generation.", 409)
            self._authorize_outcome(snapshot, stored["result"], stored.get("authorization", {}), actor)
            return copy.deepcopy(stored["result"])

    def mutate(self, identity, command, generation, idempotency_key, if_match=None):
        command = copy.deepcopy(command)
        if not isinstance(command, dict):
            raise DomainError("invalid_configuration", "Configuration command must be an object.")
        if generation is None or idempotency_key is None:
            raise DomainError("precondition_required", "Generation and idempotency headers are required.", 428)
        if command.get("generation") != generation or command.get("clientCommandId") != idempotency_key:
            raise DomainError("invalid_configuration", "Command identity and generation must agree with the headers.", 400)
        if command.get("type") != "create":
            if if_match is None or command.get("expectedRevision") is None:
                raise DomainError("precondition_required", "An existing configuration resource requires If-Match.", 428)
            if if_match != f'"{generation}:{self._revision_text(command.get("expectedRevision"))}"':
                raise DomainError("configuration_revision_conflict", "Resource ETag and command revision differ.", 412)
        with self.identities.mutex, self.repository.mutex:
            current, actor = self._current(identity)
            snapshot = self._snapshot(actor)
            if generation != snapshot["manifest"]["generation"]:
                raise DomainError("workspace_generation_conflict", "Workspace generation changed.", 409)
            if command.get("family") == "sources" and command.get("type") in ("create", "duplicate") and current["role"] != "admin":
                grant = next(grant for grant in current["grants"] if grant["workspaceId"] == self.workspace_id)
                if grant["sourceIds"] is not None:
                    raise DomainError("configuration_forbidden", "Creating a source requires unrestricted workspace source scope.", 403)
            path = self.repository._outcome_path(actor["id"], idempotency_key)
            fingerprint = hashlib.sha256(rfc8785.dumps({"resource": "configuration", "command": command})).hexdigest()
            stored = self.repository._read_target(path.relative_to(self.repository.root).as_posix())
            if stored is not None:
                if stored["requestHash"] != fingerprint:
                    raise DomainError("idempotency_conflict", "This command key was used for different content.", 409)
                self._authorize_outcome(snapshot, stored["result"], stored.get("authorization", {}), actor)
                return copy.deepcopy(stored["result"])
            resource = self._command_permission(snapshot, command, actor)
            result = apply_configuration_command(snapshot, command, actor=actor, now=now_iso())
            candidate = result["snapshot"]
            if candidate["manifest"]["revision"] == MAX_SAFE_INT:
                raise DomainError("revision_capacity", "Workspace revision capacity reached.", 413)
            candidate["manifest"]["revision"] += 1
            candidate["manifest"]["snapshotAt"] = now_iso()
            metadata = {key: value for key, value in candidate.items() if key != "records"}
            committed = {"status": "committed", "durability": "json-files", "commandId": idempotency_key, "family": command["family"], "generation": generation, "revision": candidate["manifest"]["revision"], "resource": result["resource"]}
            for key in ("effectiveSettings", "resetTransientKeys"):
                if key in result:
                    committed[key] = result[key]
            authorization = {"visibility": resource["visibility"] if resource else result["resource"]["visibility"], "ownerId": resource["ownerId"] if resource else actor["id"], "sourceIds": [resource["id"]] if resource and command["family"] == "sources" else []}
            outcome = {"clientCommandId": idempotency_key, "actorId": actor["id"], "requestHash": fingerprint, "result": committed, "authorization": authorization}
            # The identity lock precedes the repository lock and stays held through durable commit.
            self.identities._current(identity)
            try:
                self.repository._commit_files({"workspace.json": metadata, path.relative_to(self.repository.root).as_posix(): outcome})
            except OSError as error:
                raise DomainError("commit_outcome_unknown", "Configuration commit requires recovery; retain the original command identity.", 503) from error
            self.repository.meta = metadata
            self._cached_key, self._cached_snapshot = None, None
            return copy.deepcopy(committed)

    def mutate_settings(self, identity, command, generation, idempotency_key, if_match=None):
        command = copy.deepcopy(command)
        if not isinstance(command, dict):
            raise DomainError("invalid_settings", "Settings command must be an object.")
        if generation is None or idempotency_key is None or if_match is None or command.get("expectedRevision") is None:
            raise DomainError("precondition_required", "Settings require generation, idempotency and revision headers.", 428)
        if command.get("generation") != generation or command.get("clientCommandId") != idempotency_key:
            raise DomainError("invalid_settings", "Settings command identity must agree with its headers.", 400)
        if if_match != f'"{generation}:{self._revision_text(command.get("expectedRevision"))}"':
            raise DomainError("settings_revision_conflict", "Settings ETag and command revision differ.", 412)
        with self.identities.mutex, self.repository.mutex:
            _, actor = self._current(identity)
            snapshot = self._snapshot(actor)
            if generation != snapshot["manifest"]["generation"]:
                raise DomainError("generation_mismatch", "Settings belong to another generation.", 409)
            path = self.repository._outcome_path(actor["id"], idempotency_key)
            fingerprint = hashlib.sha256(rfc8785.dumps({"resource": "settings", "command": command})).hexdigest()
            stored = self.repository._read_target(path.relative_to(self.repository.root).as_posix())
            if stored is not None:
                if stored["requestHash"] != fingerprint:
                    raise DomainError("idempotency_conflict", "This command key was used for different content.", 409)
                self._authorize_outcome(snapshot, stored["result"], stored.get("authorization", {}), actor)
                return copy.deepcopy(stored["result"])
            result = apply_settings_command(snapshot, command, actor)
            candidate = result["snapshot"]
            if candidate["manifest"]["revision"] == MAX_SAFE_INT:
                raise DomainError("revision_capacity", "Workspace revision capacity reached.", 413)
            for family, field in (("views", "viewId"), ("filters", "filterId")):
                if result["effectiveSettings"]["values"].get(field) is not None:
                    self._resource(candidate, family, result["effectiveSettings"]["values"][field], actor)
            candidate["manifest"]["revision"] += 1
            candidate["manifest"]["snapshotAt"] = now_iso()
            metadata = {key: value for key, value in candidate.items() if key != "records"}
            committed = {"status": "committed", "durability": "json-files", "commandId": idempotency_key, "generation": generation, "revision": candidate["manifest"]["revision"], "settings": result["settings"], "effectiveSettings": result["effectiveSettings"]}
            outcome = {"clientCommandId": idempotency_key, "actorId": actor["id"], "requestHash": fingerprint, "result": committed, "authorization": {"scope": command["scope"], "ownerId": actor["id"]}}
            self.identities._current(identity)
            try:
                self.repository._commit_files({"workspace.json": metadata, path.relative_to(self.repository.root).as_posix(): outcome})
            except OSError as error:
                raise DomainError("commit_outcome_unknown", "Settings commit requires recovery; retain the original command identity.", 503) from error
            self.repository.meta = metadata
            self._cached_key, self._cached_snapshot = None, None
            return copy.deepcopy(committed)

    def preview_impact(self, identity, schema_id, options):
        if not isinstance(options, dict) or set(options) - {"version", "definition", "cursor", "limit"} or ("version" in options) == ("definition" in options):
            raise DomainError("invalid_configuration", "Impact requires exactly one candidate version or definition.")
        limit = options.get("limit", 100)
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise DomainError("invalid_configuration", "Impact page limit must be 1-1000.")
        with self.identities.mutex, self.repository.mutex:
            current, actor = self._current(identity)
            snapshot = self._snapshot(actor)
            schema = self._resource(snapshot, "schemas", schema_id, actor)
            if "version" in options:
                if type(options["version"]) is not int:
                    raise DomainError("invalid_configuration", "Impact version must be an integer.")
                version = next((version for version in schema["versions"] if version["version"] == options["version"]), None)
                if version is None:
                    raise DomainError("configuration_version_unavailable", "Published schema version is unavailable.", 409)
                definition = version["definition"]
            else:
                definition = options["definition"]
            validation = validate_resource_definition("schemas", definition)
            if not validation["valid"]:
                error = DomainError("invalid_configuration_definition", "Impact schema is invalid.")
                error.errors = validation["errors"]
                raise error
            digest = hashlib.sha256(rfc8785.dumps(definition)).hexdigest()
            fingerprint = scope_fingerprint(current, self.workspace_id)
            offset = 0
            if options.get("cursor"):
                decoded = self._decode_cursor(options["cursor"])
                analysis = self._impacts.get(decoded.get("analysisId"))
                if analysis is None or any(decoded.get(key) != value for key, value in {"kind": "impact", "scope": fingerprint, "schemaId": schema_id, "definitionHash": digest, "limit": limit}.items()):
                    raise DomainError("stale_cursor", "Impact analysis expired or its inputs changed.", 409)
                offset = decoded["offset"]
                analysis_id = decoded["analysisId"]
            else:
                validator = _compile_schema(resolved_data_schema(definition), [])
                items, invalid = [], 0
                for record in sorted(snapshot["records"], key=lambda item: item["id"]):
                    if record.get("schemaId") != schema_id or record["sourceId"] not in actor["sourceIds"]:
                        continue
                    errors = [{"path": "/data/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in error.instance_path), "code": str(error.schema_path[-1]) if error.schema_path else "schema", "message": error.message} for error in validator.iter_errors(record.get("data", {}))]
                    invalid += bool(errors)
                    items.append({"id": record["id"], "schemaId": record["schemaId"], "schemaVersion": record["schemaVersion"], "deleted": record.get("deletedAt") is not None, "errors": errors[:100]})
                analysis_id = str(uuid.uuid4())
                analysis = {"generation": snapshot["manifest"]["generation"], "revision": snapshot["manifest"]["revision"], "schemaId": schema_id, "totalAffected": len(items), "totalInvalid": invalid, "items": items}
                self._impacts[analysis_id] = analysis
                while len(self._impacts) > 2:
                    self._impacts.popitem(last=False)
            page = analysis["items"][offset:offset + limit]
            cursor = self._encode_cursor({"kind": "impact", "analysisId": analysis_id, "scope": fingerprint, "schemaId": schema_id, "definitionHash": digest, "limit": limit, "offset": offset + len(page)}) if offset + len(page) < len(analysis["items"]) else None
            return {**{key: value for key, value in analysis.items() if key != "items"}, "items": copy.deepcopy(page), "nextCursor": cursor}
