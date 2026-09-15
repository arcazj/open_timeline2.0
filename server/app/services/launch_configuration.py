"""Strict, operator-owned YAML profiles for the read-only legacy launcher."""

from pathlib import Path
import math

import yaml

from .legacy_sources import _SourceLoader, _guard_path, _zone
from .legacy_reader import safe_read


def _mapping(value, name, allowed, required=()):
    if not isinstance(value, dict) or set(value) - allowed or set(required) - set(value):
        raise ValueError(f"{name} requires {', '.join(required) or 'a mapping'}; allowed keys: {', '.join(sorted(allowed))}")
    return value


def _text(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 4096 or any(ord(c) < 32 for c in value):
        raise ValueError(f"{name} must be a nonempty string without control characters")
    return value


def load_launch_configuration(filename):
    path = _guard_path(Path(filename).absolute())
    raw = safe_read(path, Path(path.anchor), 1024 * 1024)
    try:
        document = yaml.load(raw.decode("utf-8-sig"), Loader=_SourceLoader)
    except (yaml.YAMLError, UnicodeError, RecursionError) as error:
        raise ValueError("Invalid YAML: duplicate keys, aliases and unsafe tags are not allowed") from error
    document = _mapping(document, "Profile", {"version", "server", "legacy", "data_sources", "loading", "snapshot"},
                        ("version", "server"))
    if type(document["version"]) is not int or document["version"] != 1:
        raise ValueError("Profile version must be 1")
    server = _mapping(document["server"], "server", {"host", "port", "local_browser", "state_root", "preferences_root", "startup_mode", "data_loading"},
                      ("host", "port", "local_browser", "state_root"))
    if "snapshot" in document and any(key in document for key in ("legacy", "data_sources", "loading")):
        raise ValueError("snapshot cannot be combined with partitioned legacy sources or loading settings")

    def resolve(value, name, base=path.parent):
        selected = Path(_text(value, name))
        return _guard_path(base / selected)

    state_root = resolve(server["state_root"], "server.state_root")
    preferences_root = (state_root / "preferences" if "preferences_root" not in server else
                        None if server["preferences_root"] is None else resolve(server["preferences_root"], "server.preferences_root"))
    if preferences_root is not None and (preferences_root == state_root or not preferences_root.is_relative_to(state_root)):
        raise ValueError("server.preferences_root must be a dedicated child of server.state_root, or null to disable preferences")

    host = _text(server["host"], "server.host")
    port = server["port"]
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("server.port must be an integer from 1 to 65535")
    if type(server["local_browser"]) is not bool:
        raise ValueError("server.local_browser must be a boolean")
    if server["local_browser"] and host != "127.0.0.1":
        raise ValueError("server.local_browser requires host 127.0.0.1")
    if "snapshot" in document:
        source = _mapping(document["snapshot"], "snapshot", {"file"}, ("file",))
        if set(server) - {"host", "port", "local_browser", "state_root", "preferences_root"}:
            raise ValueError("Snapshot profiles use background startup and a bounded complete JSON source")
        return {"source_yaml": path, "snapshot_file": resolve(source["file"], "snapshot.file"),
                "state_root": state_root, "preferences_root": preferences_root, "host": host, "port": port,
                "local_browser": server["local_browser"], "background_startup": True, "lazy": False,
                "source_document": {}, "loading": {}}
    legacy = _mapping(document.get("legacy"), "legacy", {"root", "allow_roots", "path_maps", "model", "timezone", "dialect", "namespace_grouping"},
                      ("root", "allow_roots"))
    startup_mode = server.get("startup_mode", "background")
    if startup_mode not in ("background", "foreground"):
        raise ValueError("server.startup_mode must be background or foreground")
    data_loading = server.get("data_loading", "lazy")
    if data_loading not in ("lazy", "eager"):
        raise ValueError("server.data_loading must be lazy or eager")
    loading = _mapping(document.get("loading", {}), "loading", {"buffer_ratio", "cache_mib", "index_refresh_seconds", "initial_range"})
    normalized_loading = {}
    for key, target, default, low, high, integer in (
        ("buffer_ratio", "bufferRatio", .25, 0, 1, False),
        ("cache_mib", "cacheMiB", 64, 8, 256, True),
        ("index_refresh_seconds", "indexRefreshSeconds", 30, 5, 3600, False),
    ):
        value = loading.get(key, default)
        if (type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high
                or (integer and type(value) is not int)):
            raise ValueError(f"loading.{key} must be {'an integer' if integer else 'a number'} from {low} to {high}")
        normalized_loading[target] = value
    if "initial_range" in loading:
        from ..models.domain import instant_ms
        bounds = _mapping(loading["initial_range"], "loading.initial_range", {"from", "to"}, ("from", "to"))
        if instant_ms(bounds["from"]) >= instant_ms(bounds["to"]):
            raise ValueError("loading.initial_range.to must follow from")
        normalized_loading["initialRange"] = bounds
    root = resolve(legacy["root"], "legacy.root")
    roots = legacy["allow_roots"]
    if not isinstance(roots, list) or not 1 <= len(roots) <= 100:
        raise ValueError("legacy.allow_roots requires 1 to 100 paths")
    maps = legacy.get("path_maps", {})
    if not isinstance(maps, dict):
        raise ValueError("legacy.path_maps must be a mapping of legacy prefixes to local paths")
    timezone = legacy.get("timezone", "UTC")
    _zone(timezone)
    dialect = legacy.get("dialect", "strict")
    if dialect not in ("strict", "legacy-json"):
        raise ValueError("legacy.dialect must be strict or legacy-json")
    grouping = legacy.get("namespace_grouping")
    if "namespace_grouping" in legacy and type(grouping) is not bool:
        raise ValueError("legacy.namespace_grouping must be a boolean")
    sources = document.get("data_sources")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 100:
        raise ValueError("data_sources requires 1 to 100 legacy source definitions")
    return {
        "source_yaml": path, "source_document": {"data_sources": sources}, "legacy_root": root,
        "allow_root": [str(resolve(value, "legacy.allow_roots")) for value in roots],
        "path_map": [f"{_text(prefix, 'legacy.path_maps key')}={resolve(target, 'legacy.path_maps target')}" for prefix, target in maps.items()],
        "model": resolve(legacy["model"], "legacy.model", root) if "model" in legacy else None,
        "namespace_grouping": grouping, "timezone": timezone, "dialect": dialect,
        "state_root": state_root, "preferences_root": preferences_root,
        "host": host, "port": port, "local_browser": server["local_browser"],
        "background_startup": startup_mode == "background",
        "lazy": data_loading == "lazy", "loading": normalized_loading,
    }
