from __future__ import annotations

import base64
import copy
import hmac
import secrets

from ..models.domain import DomainError, json_bytes, parse_json
from .identity import authorize, authorized_sources, scope_fingerprint


class AuditService:
    def __init__(self, identities, repository):
        self.identities, self.repository = identities, repository
        self.secret = secrets.token_bytes(32)
        self.workspace_id = repository.meta["manifest"]["workspaceId"]

    def _seal(self, payload):
        raw = json_bytes(payload)
        return base64.urlsafe_b64encode(raw + hmac.digest(self.secret, raw, "sha256")).decode().rstrip("=")

    def _open(self, value):
        try:
            if not isinstance(value, str) or len(value) > 4096:
                raise ValueError()
            raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
            if len(raw) < 33 or not hmac.compare_digest(raw[-32:], hmac.digest(self.secret, raw[:-32], "sha256")):
                raise ValueError()
            payload = parse_json(raw[:-32])
            if not isinstance(payload, dict):
                raise ValueError()
            return payload
        except (ValueError, DomainError) as error:
            raise DomainError("invalid_cursor", "Audit cursor is invalid or belongs to another service instance.", 400) from error

    def page(self, identity, limit=100, cursor=None):
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise DomainError("invalid_page", "Audit limit must be 1-1000.")
        with self.identities.mutex, self.repository.mutex:
            self.identities._ready()
            current = self.identities._current(identity)
            authorize(current, "audit.read", self.workspace_id)
            self.repository._ensure_available()
            manifest = self.repository.meta["manifest"]
            scope = scope_fingerprint(current, self.workspace_id)
            after, through = 0, manifest["revision"]
            if cursor is not None:
                payload = self._open(cursor)
                if set(payload) != {"scope", "generation", "after", "through", "limit"} or payload["scope"] != scope or payload["generation"] != manifest["generation"] or payload["limit"] != limit:
                    raise DomainError("stale_cursor", "Audit scope or generation changed.", 409)
                after, through = payload["after"], payload["through"]
                if type(after) is not int or type(through) is not int or not 0 <= after <= through <= manifest["revision"]:
                    raise DomainError("invalid_cursor", "Audit cursor revision range is invalid.", 400)
            sources = set(authorized_sources(current, self.workspace_id, manifest["scope"]["sourceIds"]))
            unrestricted = current["role"] == "admin" or any(grant["workspaceId"] == self.workspace_id and grant["sourceIds"] is None for grant in current["grants"])
            selected = []
            for entry in self.repository.audit_entries.values():
                if not after < entry["revision"] <= through:
                    continue
                if entry["visibility"] == "personal" and current["role"] != "admin" and entry["ownerId"] != current["id"]:
                    continue
                if entry["records"]:
                    if any(record["sourceId"] not in sources for record in entry["records"]):
                        continue
                elif entry["visibility"] != "personal" and not unrestricted:
                    continue
                selected.append(entry)
                if len(selected) > limit:
                    break
            items = selected[:limit]
            state = self.repository.audit_state
            next_cursor = self._seal({"scope": scope, "generation": manifest["generation"], "after": items[-1]["revision"], "through": through, "limit": limit}) if len(selected) > limit else None
            return {"items": copy.deepcopy(items), "nextCursor": next_cursor,
                    "coverage": {"firstRevision": state["firstRevision"] if state else None, "throughRevision": through,
                                 "legacyHistoryBefore": state["firstRevision"] if state else manifest["revision"] + 1}}
