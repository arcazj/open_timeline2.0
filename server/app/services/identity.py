from __future__ import annotations

import copy
import hashlib
import hmac
import os
import re
import secrets
import stat
import threading
import uuid
from pathlib import Path

import portalocker

from ..models.domain import DomainError, MAX_SAFE_INT, instant_ms as to_ms, json_bytes, now_iso, parse_json, validate_json
from ..repositories.json_repository import atomic_json


ROLES = {
    "viewer": frozenset({"records.read", "configuration.read", "configuration.personal", "export"}),
    "editor": frozenset({"records.read", "records.create", "records.edit", "records.delete", "records.restore",
                          "configuration.read", "configuration.personal", "export"}),
    "admin": frozenset({"*"}),
}
EXTRA_CAPABILITIES = frozenset({"configuration.publish", "configuration.manage", "import", "audit.read",
                                "backup", "restore", "workspace.manage"})
IDENTITY_LIMIT = 1000
TOKEN_LIMIT = 10000
IDENTITY_BYTES = 32 * 1024 * 1024
COMMAND_LIMIT = 100000
MONITOR_SECONDS = 1.0


def _canonical_id(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise DomainError("invalid_identity", "Identity IDs require canonical lowercase UUIDs.") from None
    return value


def _checksum(state):
    return hashlib.sha256(json_bytes({key: value for key, value in state.items() if key != "checksum"})).hexdigest()


def _plain_path(path, directory=False):
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise DomainError("identity_integrity", "Identity paths cannot be links, reparse points or nonregular files.", 503)
    return info


def _stamp(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _read_raw(path):
    initial = _plain_path(path)
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        if _stamp(initial) != _stamp(before):
            raise DomainError("identity_integrity", "Identity file changed while opening.", 503)
        if before.st_size > IDENTITY_BYTES:
            raise DomainError("identity_capacity", "Identity file exceeds the 32 MiB raw limit.", 413)
        raw = stream.read(before.st_size + 1)
        after, current = os.fstat(stream.fileno()), _plain_path(path)
        if (len(raw) != before.st_size or _stamp(before) != _stamp(after) or _stamp(after) != _stamp(current)
                or before.st_ctime_ns != after.st_ctime_ns or initial.st_ctime_ns != current.st_ctime_ns):
            raise DomainError("identity_integrity", "Identity file changed during its read.", 503)
    return raw, _stamp(current)


class IdentityResult(dict):
    """Legacy resource access plus an immutable HTTP response captured at commit."""

    def __init__(self, response):
        body = response["body"]
        resource = body["principal"] if "principal" in body else (body["token"] if response["status"] != 201 else {
            key: value for key, value in body.items() if key not in ("generation", "revision")})
        super().__init__(copy.deepcopy(resource))
        self.response = copy.deepcopy(response)


def _digest(secret):
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _fields(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise DomainError("invalid_identity", "Identity fields do not match the declared representation.")


def _name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 100:
        raise DomainError("invalid_identity", "Name must contain 1-100 characters.")
    return value


def _scope(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 100:
        raise DomainError("invalid_identity", "Workspace grants must contain 1-100 entries.")
    seen = set()
    for grant in value:
        _fields(grant, {"workspaceId", "sourceIds", "capabilities"}, {"workspaceId", "sourceIds", "capabilities"})
        workspace = grant["workspaceId"]
        if not isinstance(workspace, str) or not workspace or len(workspace) > 128 or workspace in seen:
            raise DomainError("invalid_identity", "Workspace grant IDs must be unique bounded strings.")
        seen.add(workspace)
        sources = grant["sourceIds"]
        if sources is not None and (not isinstance(sources, list) or len(sources) > 1000
                                    or any(not isinstance(source, str) or not source or len(source) > 128 for source in sources)
                                    or len(set(sources)) != len(sources)):
            raise DomainError("invalid_identity", "Source scope must be null or a unique bounded list.")
        capabilities = grant["capabilities"]
        if (not isinstance(capabilities, list) or any(not isinstance(item, str) or item not in EXTRA_CAPABILITIES for item in capabilities)
                or len(set(capabilities)) != len(capabilities)):
            raise DomainError("invalid_identity", "Unknown or duplicate granted capability.")
    return copy.deepcopy(value)


def _principal_input(value):
    _name(value["name"])
    if not isinstance(value["role"], str) or value["role"] not in ROLES or type(value["enabled"]) is not bool:
        raise DomainError("invalid_identity", "Principal role and enabled state must match their declared types.")
    if value["role"] == "admin":
        if value["grants"] != []:
            raise DomainError("invalid_identity", "Administrator grants must be empty.")
    else:
        _scope(value["grants"])


def public_principal(principal):
    return copy.deepcopy(principal)


def public_token(token):
    return {key: copy.deepcopy(value) for key, value in token.items() if key != "secretHash"}


def authorize(identity, capability, workspace_id=None, source_id=None):
    if not identity["enabled"]:
        raise DomainError("unauthorized", "The identity is disabled.", 401)
    if identity["role"] == "admin":
        return
    if workspace_id is None:
        raise DomainError("forbidden", "Administrator capability is required.", 403)
    grant = next((item for item in identity["grants"] if item["workspaceId"] == workspace_id), None)
    if grant is None or capability not in ROLES[identity["role"]] | set(grant["capabilities"]):
        raise DomainError("forbidden", "The requested workspace capability is unavailable.", 403)
    if source_id is not None and grant["sourceIds"] is not None and source_id not in grant["sourceIds"]:
        raise DomainError("not_found", "The requested resource is unavailable.", 404)


def authorized_sources(identity, workspace_id, declared_sources):
    authorize(identity, "records.read", workspace_id)
    if identity["role"] == "admin":
        return list(declared_sources)
    grant = next(item for item in identity["grants"] if item["workspaceId"] == workspace_id)
    return [source for source in declared_sources if grant["sourceIds"] is None or source in grant["sourceIds"]]


def scope_fingerprint(identity, workspace_id):
    grants = [grant for grant in identity["grants"] if grant["workspaceId"] == workspace_id]
    return hashlib.sha256(json_bytes({"id": identity["id"], "role": identity["role"],
                                      "enabled": identity["enabled"], "grants": grants})).hexdigest()


class IdentityStore:
    """Single-document JSON commits keep identities, tokens and their audit together."""

    def __init__(self, root: Path, bootstrap_secret: str):
        self.root = Path(root)
        self.path = self.root / "identities.json"
        self.bootstrap_secret = bootstrap_secret
        self.mutex = threading.RLock()
        self.lock = None
        self.state = None
        self.available = False
        self.disk_hash = None
        self.disk_stamp = None
        self.monitor = None
        self.monitor_stop = threading.Event()
        self.authorization_listeners = set()
        self.expired_token_ids = set()

    def subscribe_authorization(self, listener):
        """Trusted service hook; listeners run under the root mutex before publication returns."""
        with self.mutex:
            if not callable(listener) or len(self.authorization_listeners) >= 16:
                raise RuntimeError("Authorization observer capacity exceeded.")
            self.authorization_listeners.add(listener)

        def unsubscribe():
            with self.mutex:
                self.authorization_listeners.discard(listener)
        return unsubscribe

    def _invalidate_authorization(self, principal_ids=None):
        for listener in tuple(self.authorization_listeners):
            try:
                listener(None if principal_ids is None else frozenset(principal_ids))
            except Exception:
                # A committed identity write is still committed; prevent reads through a failed cache purge.
                self.available = False

    def _expire_authorization(self):
        instant = to_ms(now_iso())
        expired = {token["id"]: token["principalId"] for token in self.state["tokens"]
                   if token["expiresAt"] is not None and to_ms(token["expiresAt"]) <= instant}
        newly_expired = set(expired) - self.expired_token_ids
        self.expired_token_ids = set(expired)
        if newly_expired:
            self._invalidate_authorization({expired[token_id] for token_id in newly_expired})

    def open(self):
        if self.lock is not None:
            raise DomainError("identity_already_open", "Identity storage already owns its root.", 409)
        existed = self.root.exists()
        if not existed and (not isinstance(self.bootstrap_secret, str) or not 12 <= len(self.bootstrap_secret) <= 512
                            or any(not 0x21 <= ord(character) <= 0x7e for character in self.bootstrap_secret)):
            raise DomainError("bootstrap_required", "A bootstrap bearer secret requires 12-512 printable ASCII characters without spaces.", 503)
        self.root.mkdir(parents=True, exist_ok=True)
        _plain_path(self.root, directory=True)
        if (self.root / ".identities.lock").exists():
            _plain_path(self.root / ".identities.lock")
        self.lock = portalocker.Lock(str(self.root / ".identities.lock"), mode="a+b", timeout=0,
                                    flags=portalocker.LOCK_EX | portalocker.LOCK_NB)
        try:
            self.lock.acquire()
            if self.path.exists():
                raw, stamp = _read_raw(self.path)
                state = parse_json(raw)
                self._validate(state)
            else:
                if existed or any(path.name != ".identities.lock" for path in self.root.iterdir()):
                    raise DomainError("bootstrap_required", "Missing metadata in an existing identity root cannot be reset by bootstrap.", 503)
                if not isinstance(self.bootstrap_secret, str) or not 12 <= len(self.bootstrap_secret) <= 512:
                    raise DomainError("bootstrap_required", "A bootstrap bearer secret is required.", 503)
                stamp, principal_id, token_id = now_iso(), str(uuid.uuid4()), str(uuid.uuid4())
                principal = {"id": principal_id, "name": "Administrator", "role": "admin", "enabled": True,
                             "grants": [], "revision": 1, "createdAt": stamp, "updatedAt": stamp}
                token = {"id": token_id, "principalId": principal_id, "name": "Bootstrap", "secretHash": _digest(self.bootstrap_secret),
                         "createdAt": stamp, "expiresAt": None, "revokedAt": None, "revision": 1}
                state = {"format": "timeline-identities", "formatVersion": 2, "generation": str(uuid.uuid4()), "revision": 1,
                         "principals": [principal], "tokens": [token], "audit": [], "commands": [], "recoveryHistory": []}
                state["checksum"] = _checksum(state)
                self._validate(state)
                atomic_json(self.path, state)
                raw, stamp = _read_raw(self.path)
            self.state = state
            self.disk_hash, self.disk_stamp = hashlib.sha256(raw).hexdigest(), stamp
            self.available = True
            self.monitor_stop.clear()
            self.monitor = threading.Thread(target=self._monitor, name="timeline-identity-integrity", daemon=True)
            self.monitor.start()
        except BaseException:
            self.close()
            raise
        finally:
            self.bootstrap_secret = None

    def close(self):
        self.available = False
        self.monitor_stop.set()
        if self.monitor is not None and self.monitor is not threading.current_thread():
            self.monitor.join()
        self.monitor = None
        with self.mutex:
            self.authorization_listeners.clear()
            self.expired_token_ids.clear()
        if self.lock is not None:
            self.lock.release()
            self.lock = None

    def _validate(self, state):
        validate_json(state)
        base_fields = {"format", "formatVersion", "generation", "revision", "principals", "tokens", "audit"}
        version = state.get("formatVersion") if isinstance(state, dict) else None
        fields = base_fields | ({"commands", "recoveryHistory", "checksum"} if version == 2 else set())
        _fields(state, fields, fields)
        if state["format"] != "timeline-identities" or type(version) is not int or version not in (1, 2):
            raise DomainError("identity_integrity", "Unknown identity-store format.", 503)
        _canonical_id(state["generation"])
        if version == 2 and state["checksum"] != _checksum(state):
            raise DomainError("identity_integrity", "Identity document checksum mismatch.", 503)
        if type(state["revision"]) is not int or not 1 <= state["revision"] <= MAX_SAFE_INT:
            raise DomainError("identity_integrity", "Invalid identity revision.", 503)
        principals, tokens = state["principals"], state["tokens"]
        if not isinstance(principals, list) or not 1 <= len(principals) <= IDENTITY_LIMIT or not isinstance(tokens, list) or len(tokens) > TOKEN_LIMIT:
            raise DomainError("identity_capacity", "Identity-store capacity is invalid.", 503)
        ids = set()
        for principal in principals:
            _fields(principal, {"id", "name", "role", "enabled", "grants", "revision", "createdAt", "updatedAt"},
                    {"id", "name", "role", "enabled", "grants", "revision", "createdAt", "updatedAt"})
            _canonical_id(principal["id"])
            if principal["id"] in ids:
                raise DomainError("identity_integrity", "Duplicate principal identity.", 503)
            ids.add(principal["id"])
            _name(principal["name"])
            if not isinstance(principal["role"], str) or principal["role"] not in ROLES or type(principal["enabled"]) is not bool:
                raise DomainError("identity_integrity", "Invalid principal role or state.", 503)
            if principal["role"] == "admin":
                if principal["grants"] != []:
                    raise DomainError("invalid_identity", "Administrator grants must be empty.")
            else:
                _scope(principal["grants"])
            if type(principal["revision"]) is not int or not 1 <= principal["revision"] <= MAX_SAFE_INT:
                raise DomainError("identity_integrity", "Invalid principal revision.", 503)
            to_ms(principal["createdAt"])
            to_ms(principal["updatedAt"])
            if to_ms(principal["updatedAt"]) < to_ms(principal["createdAt"]):
                raise DomainError("identity_integrity", "Principal timestamps are not ordered.", 503)
        token_ids, hashes = set(), set()
        for token in tokens:
            _fields(token, {"id", "principalId", "name", "secretHash", "createdAt", "expiresAt", "revokedAt", "revision"},
                    {"id", "principalId", "name", "secretHash", "createdAt", "expiresAt", "revokedAt", "revision"})
            _canonical_id(token["id"])
            digest = token["secretHash"]
            if (token["id"] in token_ids or not isinstance(token["principalId"], str) or token["principalId"] not in ids or not isinstance(digest, str)
                    or len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest) or digest in hashes):
                raise DomainError("identity_integrity", "Invalid or duplicate token reference.", 503)
            token_ids.add(token["id"])
            hashes.add(digest)
            _name(token["name"])
            if type(token["revision"]) is not int or not 1 <= token["revision"] <= MAX_SAFE_INT:
                raise DomainError("identity_integrity", "Invalid token revision.", 503)
            for key in ("createdAt", "expiresAt", "revokedAt"):
                if token[key] is not None:
                    to_ms(token[key])
            if token["createdAt"] is None or (token["expiresAt"] is not None and to_ms(token["expiresAt"]) <= to_ms(token["createdAt"])):
                raise DomainError("identity_integrity", "Invalid token lifetime.", 503)
            if token["revokedAt"] is not None and to_ms(token["revokedAt"]) < to_ms(token["createdAt"]):
                raise DomainError("identity_integrity", "Token revocation precedes creation.", 503)
        if not any(principal["enabled"] and principal["role"] == "admin" for principal in principals):
            raise DomainError("last_administrator", "At least one enabled administrator is required.", 409)
        if not isinstance(state["audit"], list) or len(state["audit"]) > 100000:
            raise DomainError("identity_capacity", "Identity audit capacity exceeded.", 413)
        if len(state["audit"]) != state["revision"] - 1:
            raise DomainError("identity_integrity", "Identity audit sequence is incomplete.", 503)
        for index, entry in enumerate(state["audit"], 2):
            _fields(entry, {"revision", "at", "actorId", "action", "targetId"} | ({"generation"} if version == 2 else set()),
                    {"revision", "at", "actorId", "action", "targetId"})
            if (type(entry["revision"]) is not int or entry["revision"] != index
                    or not isinstance(entry["actorId"], str) or entry["actorId"] not in ids
                    or not isinstance(entry["action"], str)
                    or entry["action"] not in ({"principal.create", "principal.update", "token.create", "token.revoke"}
                                              | ({"identity.recover"} if version == 2 else set()))
                    or not isinstance(entry["targetId"], str) or len(entry["targetId"]) > 128):
                raise DomainError("identity_integrity", "Identity audit entry is invalid.", 503)
            to_ms(entry["at"])
            _canonical_id(entry["targetId"])
            if "generation" in entry:
                _canonical_id(entry["generation"])
        if version == 2:
            self._validate_history(state, ids)
        if len(json_bytes(state)) > IDENTITY_BYTES:
            raise DomainError("identity_capacity", "Identity root exceeds 32 MiB.", 413)

    def _ready(self):
        if not self.available:
            raise DomainError("identity_unavailable", "Identity storage is unavailable.", 503)
        try:
            if _stamp(_plain_path(self.path)) != self.disk_stamp:
                raise OSError("Identity file identity changed")
        except (OSError, DomainError):
            self.available = False
            self._invalidate_authorization()
            raise DomainError("external_change", "Identity files changed outside the service; access is frozen.", 503) from None

    def check_integrity(self):
        with self.mutex:
            self._ready()
            try:
                raw, stamp = _read_raw(self.path)
                if hashlib.sha256(raw).hexdigest() != self.disk_hash or stamp != self.disk_stamp:
                    raise OSError("Identity bytes changed")
            except (OSError, DomainError):
                self.available = False
                self._invalidate_authorization()
                raise DomainError("external_change", "Identity files changed outside the service; access is frozen.", 503) from None
            self._expire_authorization()
            self._ready()
            return True

    def _monitor(self):
        while not self.monitor_stop.wait(MONITOR_SECONDS):
            if not self.mutex.acquire(timeout=0.1):
                continue
            try:
                if not self.monitor_stop.is_set() and self.available:
                    self.check_integrity()
            except DomainError:
                pass
            finally:
                self.mutex.release()

    def _validate_history(self, state, principal_ids):
        commands, history = state["commands"], state["recoveryHistory"]
        if not isinstance(commands, list) or len(commands) > COMMAND_LIMIT or not isinstance(history, list) or len(history) > COMMAND_LIMIT:
            raise DomainError("identity_capacity", "Identity command/recovery history exceeds capacity.", 413)
        keys, previous = set(), 1
        for command in commands:
            _fields(command, {"actorId", "key", "requestHash", "generation", "revision", "action", "targetId", "at", "response"},
                    {"actorId", "key", "requestHash", "generation", "revision", "action", "targetId", "at", "response"})
            _canonical_id(command["generation"])
            _canonical_id(command["targetId"])
            if (not isinstance(command["actorId"], str) or command["actorId"] not in principal_ids
                    or not isinstance(command["key"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", command["key"])
                    or not isinstance(command["requestHash"], str) or not re.fullmatch("[0-9a-f]{64}", command["requestHash"])
                    or type(command["revision"]) is not int or not previous < command["revision"] <= state["revision"]):
                raise DomainError("identity_integrity", "Identity command metadata is invalid.", 503)
            identity = command["actorId"], command["generation"], command["key"]
            if identity in keys:
                raise DomainError("identity_integrity", "Duplicate identity command key.", 503)
            keys.add(identity)
            previous = command["revision"]
            audit = state["audit"][command["revision"] - 2]
            if any(command[key] != audit.get(key) for key in ("actorId", "generation", "revision", "action", "targetId", "at")):
                raise DomainError("identity_integrity", "Identity command is not backed by its audit revision.", 503)
            response = command["response"]
            _fields(response, {"status", "body", "headers"}, {"status", "body", "headers"})
            body, headers = response["body"], response["headers"]
            action = command["action"]
            if action not in {"principal.create", "principal.update", "token.create", "token.revoke"}:
                raise DomainError("identity_integrity", "Identity command action is invalid.", 503)
            key = "principal" if action.startswith("principal.") else "token"
            body_fields = {"generation", "revision", key} | ({"secretUnavailable"} if action == "token.create" else set())
            _fields(body, body_fields, body_fields)
            resource = body[key]
            fields = ({"id", "name", "role", "enabled", "grants", "revision", "createdAt", "updatedAt"} if key == "principal"
                      else {"id", "principalId", "name", "createdAt", "expiresAt", "revokedAt", "revision"})
            _fields(resource, fields, fields)
            _canonical_id(resource["id"])
            _name(resource["name"])
            if key == "principal":
                if not isinstance(resource["role"], str) or resource["role"] not in ROLES or type(resource["enabled"]) is not bool:
                    raise DomainError("identity_integrity", "Historical principal response has invalid role/state.", 503)
                if resource["role"] == "admin":
                    if resource["grants"] != []:
                        raise DomainError("identity_integrity", "Historical administrator grants are invalid.", 503)
                else:
                    _scope(resource["grants"])
                for name in ("createdAt", "updatedAt"):
                    to_ms(resource[name])
            else:
                _canonical_id(resource["principalId"])
                if resource["principalId"] not in principal_ids:
                    raise DomainError("identity_integrity", "Historical token principal is absent.", 503)
                for name in ("createdAt", "expiresAt", "revokedAt"):
                    if resource[name] is not None:
                        to_ms(resource[name])
            _fields(headers, {"ETag", "Location"}, {"ETag"})
            status = 201 if action.endswith(".create") else 200
            if (type(response["status"]) is not int or response["status"] != status
                    or body["generation"] != command["generation"] or type(body["revision"]) is not int or body["revision"] != command["revision"]
                    or resource["id"] != command["targetId"] or type(resource["revision"]) is not int
                    or not 1 <= resource["revision"] <= MAX_SAFE_INT
                    or headers["ETag"] != f'"{command["generation"]}:{resource["revision"]}"'
                    or (action == "token.create" and body["secretUnavailable"] is not True)):
                raise DomainError("identity_integrity", "Identity command response is invalid or contains secret material.", 503)
            expected_location = "/api/v1/" + ("principals/" if key == "principal" else "tokens/") + resource["id"]
            if (status == 201 and headers.get("Location") != expected_location) or (status != 201 and "Location" in headers):
                raise DomainError("identity_integrity", "Identity command Location is invalid.", 503)
        prior_generation, prior_revision = None, 1
        for recovery in history:
            _fields(recovery, {"previousGeneration", "generation", "at", "revision", "principalId", "reason"},
                    {"previousGeneration", "generation", "at", "revision", "principalId", "reason"})
            _canonical_id(recovery["previousGeneration"])
            _canonical_id(recovery["generation"])
            _canonical_id(recovery["principalId"])
            if (recovery["previousGeneration"] == recovery["generation"] or recovery["principalId"] not in principal_ids
                    or type(recovery["revision"]) is not int or not prior_revision < recovery["revision"] <= state["revision"]
                    or not isinstance(recovery["reason"], str) or not recovery["reason"].strip() or len(recovery["reason"]) > 500
                    or (prior_generation is not None and recovery["previousGeneration"] != prior_generation)):
                raise DomainError("identity_integrity", "Identity recovery provenance is invalid.", 503)
            audit = state["audit"][recovery["revision"] - 2]
            if (audit["action"] != "identity.recover" or audit["actorId"] != recovery["principalId"]
                    or audit.get("generation") != recovery["generation"] or audit["at"] != recovery["at"]):
                raise DomainError("identity_integrity", "Identity recovery has no matching audit revision.", 503)
            to_ms(recovery["at"])
            prior_generation, prior_revision = recovery["generation"], recovery["revision"]
        if history and prior_generation != state["generation"]:
            raise DomainError("identity_integrity", "Identity recovery chain does not reach the current generation.", 503)

    def _authorize_outcome(self, identity, command):
        self._current(identity)
        if command["action"].startswith("principal.") or command["response"]["body"]["token"]["principalId"] != identity["id"]:
            self._admin(identity)

    def _command(self, identity, action, target, payload, generation, expected_revision, command_id):
        if generation is None or command_id is None:
            raise DomainError("precondition_required", "Identity generation and Idempotency-Key are required.", 428)
        if generation != self.state["generation"]:
            raise DomainError("generation_conflict", "Identity root generation changed.", 409)
        if not isinstance(command_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", command_id):
            raise DomainError("invalid_idempotency_key", "Idempotency-Key requires 1-128 bounded ASCII characters.", 400)
        validate_json(payload)
        fingerprint = hashlib.sha256(json_bytes({"action": action, "target": target, "payload": payload,
                                                "generation": generation, "expectedRevision": expected_revision})).hexdigest()
        found = next((entry for entry in self.state.get("commands", []) if entry["actorId"] == identity["id"]
                      and entry["generation"] == generation and entry["key"] == command_id), None)
        if found is not None:
            if found["requestHash"] != fingerprint:
                raise DomainError("idempotency_conflict", "Identity command key was used with different content.", 409)
            self._authorize_outcome(identity, found)
            return IdentityResult(found["response"])
        return {"actorId": identity["id"], "key": command_id, "requestHash": fingerprint, "generation": generation}

    def get_command_outcome(self, identity, command_id):
        with self.mutex:
            self._ready()
            self._current(identity)
            if not isinstance(command_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", command_id):
                raise DomainError("invalid_idempotency_key", "Invalid identity command key.", 400)
            found = next((entry for entry in self.state.get("commands", []) if entry["actorId"] == identity["id"]
                          and entry["generation"] == self.state["generation"] and entry["key"] == command_id), None)
            if found is None:
                raise DomainError("command_not_found", "No committed identity command is known.", 404)
            self._authorize_outcome(identity, found)
            return {"state": "committed", "operation": found["action"], "committedAt": found["at"],
                    "response": copy.deepcopy(found["response"])}

    def _commit(self, candidate, actor, action, target, command, resource, secret=None):
        self._ready()
        if self.state["revision"] == MAX_SAFE_INT:
            raise DomainError("identity_capacity", "Identity revision capacity reached.", 413)
        candidate["revision"] = self.state["revision"] + 1
        candidate.update(formatVersion=2)
        candidate.setdefault("commands", [])
        candidate.setdefault("recoveryHistory", [])
        stamp = now_iso()
        candidate["audit"].append({"revision": candidate["revision"], "at": stamp, "actorId": actor,
                                   "action": action, "targetId": target, "generation": candidate["generation"]})
        resource_key = "principal" if action.startswith("principal.") else "token"
        body = {"generation": candidate["generation"], "revision": candidate["revision"], resource_key: copy.deepcopy(resource)}
        if action == "token.create":
            body["secretUnavailable"] = True
        status = 201 if action.endswith(".create") else 200
        headers = {"ETag": f'"{candidate["generation"]}:{resource["revision"]}"'}
        if status == 201:
            headers["Location"] = "/api/v1/" + ("principals/" if resource_key == "principal" else "tokens/") + target
        response = {"status": status, "headers": headers, "body": body}
        candidate["commands"].append({**command, "revision": candidate["revision"], "action": action,
                                       "targetId": target, "at": stamp, "response": copy.deepcopy(response)})
        candidate["checksum"] = _checksum(candidate)
        self._publish(candidate)
        if secret is not None:
            response["body"].update(secret=secret, secretUnavailable=False)
        return IdentityResult(response)

    def _publish(self, candidate):
        self._validate(candidate)
        self._require_admin_token(candidate)
        self.check_integrity()
        encoded = json_bytes(candidate)
        try:
            atomic_json(self.path, candidate)
            stamp = _stamp(_plain_path(self.path))
        except (OSError, DomainError):
            # A replacement can commit before a later directory-sync error. Reconcile, never retry the write.
            self.available = False
            self._invalidate_authorization()
            raise DomainError("identity_commit_unknown", "Identity commit requires restart reconciliation.", 503) from None
        previous = self.state
        self.state = candidate
        self.disk_hash = hashlib.sha256(encoded).hexdigest()
        self.disk_stamp = stamp
        if previous["generation"] != candidate["generation"]:
            self._invalidate_authorization()
        else:
            current = {item["id"]: item for item in candidate["principals"]}
            changed = {item["id"] for item in previous["principals"]
                       if item["id"] not in current or any(item[key] != current[item["id"]][key]
                                                          for key in ("role", "enabled", "grants"))}
            current_tokens = {item["id"]: item for item in candidate["tokens"]}
            changed.update(item["principalId"] for item in previous["tokens"]
                           if item["id"] not in current_tokens or any(item[key] != current_tokens[item["id"]][key]
                                                                     for key in ("revokedAt", "expiresAt")))
            if changed:
                self._invalidate_authorization(changed)

    def _require_admin_token(self, candidate):
        admins = {principal["id"] for principal in candidate["principals"] if principal["enabled"] and principal["role"] == "admin"}
        instant = to_ms(now_iso())
        if not any(token["principalId"] in admins and token["revokedAt"] is None
                   and (token["expiresAt"] is None or to_ms(token["expiresAt"]) > instant) for token in candidate["tokens"]):
            raise DomainError("last_administrator_token", "The last currently usable administrator token cannot be removed.", 409)

    def _recover_offline(self, reason, principal_id=None):
        with self.mutex:
            self._ready()
            validate_json(reason)
            if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
                raise DomainError("invalid_recovery_reason", "Recovery requires a nonempty reason of at most 500 characters.")
            if principal_id is not None:
                _canonical_id(principal_id)
            candidate = copy.deepcopy(self.state)
            administrators = sorted((principal for principal in candidate["principals"] if principal["role"] == "admin"),
                                    key=lambda principal: principal["id"])
            principal = next((value for value in administrators if principal_id is None or value["id"] == principal_id), None)
            if principal is None:
                raise DomainError("recovery_principal_unavailable", "Select an existing administrator principal.", 404)
            if candidate["revision"] == MAX_SAFE_INT or principal["revision"] == MAX_SAFE_INT:
                raise DomainError("identity_capacity", "Identity revision capacity prevents recovery.", 413)
            stamp, previous_generation = now_iso(), candidate["generation"]
            candidate.update(formatVersion=2, generation=str(uuid.uuid4()), revision=candidate["revision"] + 1)
            candidate.setdefault("commands", [])
            candidate.setdefault("recoveryHistory", [])
            principal.update(enabled=True, revision=principal["revision"] + 1, updatedAt=stamp)
            for token in candidate["tokens"]:
                if token["revokedAt"] is None:
                    if token["revision"] == MAX_SAFE_INT:
                        raise DomainError("identity_capacity", "Token revision capacity prevents recovery.", 413)
                    token.update(revokedAt=stamp, revision=token["revision"] + 1)
            secret = "obt_" + secrets.token_urlsafe(32)
            token = {"id": str(uuid.uuid4()), "principalId": principal["id"], "name": "Offline recovery",
                     "secretHash": _digest(secret), "createdAt": stamp, "expiresAt": None, "revokedAt": None, "revision": 1}
            candidate["tokens"].append(token)
            candidate["audit"].append({"revision": candidate["revision"], "at": stamp, "actorId": principal["id"],
                                       "action": "identity.recover", "targetId": principal["id"], "generation": candidate["generation"]})
            provenance = {"previousGeneration": previous_generation, "generation": candidate["generation"], "at": stamp,
                          "revision": candidate["revision"], "principalId": principal["id"], "reason": reason}
            candidate["recoveryHistory"].append(provenance)
            candidate["checksum"] = _checksum(candidate)
            self._publish(candidate)
            return {"generation": candidate["generation"], "revision": candidate["revision"], "principalId": principal["id"],
                    "token": public_token(token), "secret": secret, "recovery": copy.deepcopy(provenance)}

    def authenticate(self, bearer):
        with self.mutex:
            self._ready()
            if not isinstance(bearer, str) or not 12 <= len(bearer) <= 512:
                raise DomainError("unauthorized", "A valid bearer token is required.", 401)
            digest, instant = _digest(bearer), to_ms(now_iso())
            token = next((token for token in self.state["tokens"] if hmac.compare_digest(token["secretHash"], digest)), None)
            if token is None or token["revokedAt"] is not None or (token["expiresAt"] is not None and to_ms(token["expiresAt"]) <= instant):
                raise DomainError("unauthorized", "The bearer token is unavailable or expired.", 401)
            principal = next(principal for principal in self.state["principals"] if principal["id"] == token["principalId"])
            if not principal["enabled"]:
                raise DomainError("unauthorized", "The identity is disabled.", 401)
            return {**copy.deepcopy(principal), "tokenId": token["id"], "identityGeneration": self.state["generation"]}

    def _current(self, identity):
        if not isinstance(identity, dict) or any(not isinstance(identity.get(key), str) for key in ("id", "tokenId", "identityGeneration")):
            raise DomainError("unauthorized", "The request identity is unavailable.", 401)
        current = next((principal for principal in self.state["principals"] if principal["id"] == identity["id"]), None)
        token = next((item for item in self.state["tokens"] if item["id"] == identity["tokenId"]
                      and item["principalId"] == identity["id"]), None)
        if (current is None or not current["enabled"] or identity["identityGeneration"] != self.state["generation"]
                or token is None or token["revokedAt"] is not None
                or (token["expiresAt"] is not None and to_ms(token["expiresAt"]) <= to_ms(now_iso()))):
            raise DomainError("unauthorized", "The identity is unavailable.", 401)
        return current

    def _admin(self, identity):
        current = self._current(identity)
        authorize(current, "identity.manage")

    def _precondition(self, generation, expected_revision, actual_revision):
        if generation is None or expected_revision is None:
            raise DomainError("precondition_required", "Identity generation and expected revision are required.", 428)
        if generation != self.state["generation"]:
            raise DomainError("generation_conflict", "Identity root generation changed.", 409)
        if type(expected_revision) is not int or expected_revision != actual_revision:
            raise DomainError("revision_conflict", "Identity resource changed; reload before editing.", 412)

    def list_principals(self, identity):
        with self.mutex:
            self._ready()
            self._admin(identity)
            return {"generation": self.state["generation"], "revision": self.state["revision"],
                    "items": [public_principal(principal) for principal in self.state["principals"]]}

    def create_principal(self, identity, payload, generation, expected_revision, command_id=None):
        with self.mutex:
            self._ready()
            self._admin(identity)
            command = self._command(identity, "principal.create", None, payload, generation, expected_revision, command_id)
            if isinstance(command, IdentityResult):
                return command
            self._precondition(generation, expected_revision, self.state["revision"])
            _fields(payload, {"name", "role", "grants"}, {"name", "role", "grants"})
            stamp, resource_id = now_iso(), str(uuid.uuid4())
            principal = {"id": resource_id, **copy.deepcopy(payload), "enabled": True, "revision": 1,
                         "createdAt": stamp, "updatedAt": stamp}
            _principal_input(principal)
            candidate = copy.deepcopy(self.state)
            candidate["principals"].append(principal)
            return self._commit(candidate, identity["id"], "principal.create", resource_id, command, public_principal(principal))

    def update_principal(self, identity, resource_id, payload, generation, expected_revision, command_id=None):
        with self.mutex:
            self._ready()
            self._admin(identity)
            _canonical_id(resource_id)
            command = self._command(identity, "principal.update", resource_id, payload, generation, expected_revision, command_id)
            if isinstance(command, IdentityResult):
                return command
            _fields(payload, {"name", "role", "grants", "enabled"})
            if not payload:
                raise DomainError("invalid_identity", "A principal update cannot be empty.")
            candidate = copy.deepcopy(self.state)
            principal = next((principal for principal in candidate["principals"] if principal["id"] == resource_id), None)
            if principal is None:
                raise DomainError("not_found", "The principal is unavailable.", 404)
            self._precondition(generation, expected_revision, principal["revision"])
            principal.update(copy.deepcopy(payload))
            _principal_input(principal)
            principal["revision"] += 1
            principal["updatedAt"] = now_iso()
            if not principal["enabled"]:
                for token in candidate["tokens"]:
                    if token["principalId"] == resource_id and token["revokedAt"] is None:
                        token["revokedAt"] = principal["updatedAt"]
                        token["revision"] += 1
            return self._commit(candidate, identity["id"], "principal.update", resource_id, command, public_principal(principal))

    def list_tokens(self, identity):
        with self.mutex:
            self._ready()
            current = self._current(identity)
            administrator = current["role"] == "admin"
            if administrator:
                self._admin(identity)
            return {"generation": self.state["generation"], "revision": self.state["revision"],
                    "items": [public_token(token) for token in self.state["tokens"]
                              if administrator or token["principalId"] == identity["id"]]}

    def create_token(self, identity, payload, generation, expected_revision, command_id=None):
        with self.mutex:
            self._ready()
            self._current(identity)
            _fields(payload, {"principalId", "name", "expiresAt"}, {"principalId", "name", "expiresAt"})
            if payload["principalId"] != identity["id"]:
                self._admin(identity)
            _canonical_id(payload["principalId"])
            command = self._command(identity, "token.create", None, payload, generation, expected_revision, command_id)
            if isinstance(command, IdentityResult):
                return command
            target = next((principal for principal in self.state["principals"] if principal["id"] == payload["principalId"]), None)
            if target is None or not target["enabled"]:
                raise DomainError("not_found", "The principal is unavailable.", 404)
            self._precondition(generation, expected_revision, self.state["revision"])
            secret, resource_id = "obt_" + secrets.token_urlsafe(32), str(uuid.uuid4())
            token = {"id": resource_id, **copy.deepcopy(payload), "secretHash": _digest(secret), "createdAt": now_iso(),
                     "revokedAt": None, "revision": 1}
            candidate = copy.deepcopy(self.state)
            candidate["tokens"].append(token)
            return self._commit(candidate, identity["id"], "token.create", resource_id, command, public_token(token), secret)

    def revoke_token(self, identity, resource_id, generation, expected_revision, command_id=None):
        with self.mutex:
            self._ready()
            self._current(identity)
            _canonical_id(resource_id)
            candidate = copy.deepcopy(self.state)
            token = next((token for token in candidate["tokens"] if token["id"] == resource_id), None)
            if token is None:
                raise DomainError("not_found", "The token is unavailable.", 404)
            if token["principalId"] != identity["id"]:
                self._admin(identity)
            command = self._command(identity, "token.revoke", resource_id, {}, generation, expected_revision, command_id)
            if isinstance(command, IdentityResult):
                return command
            self._precondition(generation, expected_revision, token["revision"])
            if token["revokedAt"] is not None:
                raise DomainError("token_revoked", "The token is already revoked.", 409)
            token["revokedAt"], token["revision"] = now_iso(), token["revision"] + 1
            return self._commit(candidate, identity["id"], "token.revoke", resource_id, command, public_token(token))


def recover_identity(data_root, reason, principal_id=None):
    root = Path(data_root).absolute()
    _plain_path(root, directory=True)
    _plain_path(root / "workspace.json")
    controls = root / "control"
    _plain_path(controls, directory=True)
    _plain_path(controls / "identities.json")
    if (root / ".writer.lock").exists():
        _plain_path(root / ".writer.lock")
    identities = IdentityStore(controls, None)
    workspace_owner = None
    try:
        identities.open()
        workspace_owner = portalocker.Lock(str(root / ".writer.lock"), mode="a+b", timeout=0,
                                           flags=portalocker.LOCK_EX | portalocker.LOCK_NB)
        workspace_owner.acquire()
        return identities._recover_offline(reason, principal_id)
    finally:
        if workspace_owner is not None:
            workspace_owner.release()
        identities.close()
