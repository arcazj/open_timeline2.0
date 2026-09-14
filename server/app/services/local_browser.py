"""Opt-in, same-origin access to a read-only loopback instance."""

from urllib.parse import urlsplit
import os
import re

from ..models.domain import DomainError, json_bytes, parse_json
from .legacy_sources import _guard_path
from .legacy_reader import safe_read


def validate_local_origin(origin, legacy_config):
    parsed = urlsplit(origin)
    if (not legacy_config or parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or not parsed.port or parsed.username or parsed.password or parsed.path
            or parsed.query or parsed.fragment):
        raise ValueError("Local browser mode requires read-only legacy sources and an explicit http://127.0.0.1:PORT origin.")
    return parsed.netloc


def require_local_browser(request, origin):
    # A custom header prevents simple cross-origin requests; Host, Origin and
    # Fetch Metadata checks also reject rebinding and sandboxed/null origins.
    if (request.client is None or request.client.host not in ("127.0.0.1", "::1")
            or request.headers.get("host") != urlsplit(origin).netloc
            or request.headers.get("x-openbexi-local") != "1"
            or request.headers.get("origin", origin) != origin
            or request.headers.get("sec-fetch-site") != "same-origin"):
        raise DomainError("local_origin_required", "Use the application on its configured loopback origin.", 403)


def source_catalog(repository):
    return {"mode": "local-read-only", "sources": [
        {"id": source.id, "namespace": source.namespace, "path": str(source.root),
         "template": source.data_model, "readOnly": True}
        for source in repository.configuration.sources
    ]}


def local_browser_key(root, initial_secret):
    """Keep the private bootstrap identity stable across local server restarts."""
    root = _guard_path(root)
    path = _guard_path(root / "local-browser-key.json")
    root.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        if (root / "control" / "identities.json").exists():
            raise DomainError("local_key_missing", "Local key is missing from an existing identity store. Restore it or select a new local state directory.", 503)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "wb") as stream:
                stream.write(json_bytes({"version": 1, "secret": initial_secret}))
                stream.flush()
                os.fsync(stream.fileno())
    value = parse_json(safe_read(path, root, 4096))
    if (not isinstance(value, dict) or set(value) != {"version", "secret"} or value["version"] != 1
            or not isinstance(value["secret"], str) or not re.fullmatch(r"[!-~]{12,512}", value["secret"])):
        raise DomainError("local_key_invalid", "Local identity key is invalid; it was not replaced.", 503)
    return value["secret"]
