"""Pure personal/workspace settings overrides, mirrored by settings-commands.js."""
import copy
import re

from .configuration_catalog import DEFINITIONS, effective_settings, normalize_configuration
from .domain import DomainError, MAX_SAFE_INT, validate_json
from .model_catalog import integer


def apply_settings_command(input_snapshot, command, actor):
    validate_json(command)
    if not isinstance(command, dict) or set(command) - {"scope", "type", "expectedRevision", "generation", "clientCommandId", "payload"}:
        raise DomainError("invalid_settings", "Unknown settings command fields.")
    if command.get("scope") not in ("personal", "workspace"):
        raise DomainError("settings_scope", "This provider supports personal and workspace overrides.")
    if command.get("type") not in ("replace", "patch", "reset") or not isinstance(command.get("payload"), dict):
        raise DomainError("invalid_settings", "Invalid settings operation or payload.")
    if command.get("generation") is None or command.get("expectedRevision") is None:
        raise DomainError("precondition_required", "Generation and settings revision are required.", 428)
    if command["generation"] != input_snapshot["manifest"]["generation"]:
        raise DomainError("generation_mismatch", "Settings belong to another generation.", 409)

    def has(name):
        return "*" in actor["capabilities"] or name in actor["capabilities"]

    if not has("configuration.manage") and not (command["scope"] == "personal" and has("configuration.personal")):
        raise DomainError("configuration_forbidden", "Settings permission is required.", 403)
    snapshot = normalize_configuration(input_snapshot, actor)
    settings = snapshot["defaults"] if command["scope"] == "workspace" else next((item for item in snapshot["preferences"] if item["principalId"] == actor["id"]), None)
    if not integer(command["expectedRevision"], 0, MAX_SAFE_INT) or command["expectedRevision"] != (settings["revision"] if settings else 0):
        raise DomainError("settings_revision_conflict", "Settings changed; reload before editing.", 412)
    if settings and settings["revision"] == MAX_SAFE_INT:
        raise DomainError("settings_capacity", "Settings revision capacity reached.", 413)
    if settings is None:
        settings = {"principalId": actor["id"], "revision": 0, "values": {}}
        snapshot["preferences"].append(settings)
    payload = command["payload"]
    if command["type"] == "replace":
        settings["values"] = copy.deepcopy(payload)
    elif command["type"] == "patch":
        for key, value in payload.items():
            if key == "search" and isinstance(value, dict) and (value.get("mode") == "regex" or settings["values"].get("search", {}).get("mode") == "regex" and "mode" in value and value["mode"] != "regex"):
                settings["values"][key] = copy.deepcopy(value)
            elif key in ("range", "overview", "search", "table") and isinstance(value, dict):
                settings["values"][key] = {**settings["values"].get(key, {}), **copy.deepcopy(value)}
            else:
                settings["values"][key] = copy.deepcopy(value)
    else:
        if set(payload) != {"paths"}:
            raise DomainError("invalid_settings", "Reset requires only paths.")
        paths = payload["paths"]
        if paths is None:
            settings["values"] = {}
        else:
            if not isinstance(paths, list) or not 1 <= len(paths) <= 100 or any(not isinstance(path, str) for path in paths) or len(set(paths)) != len(paths):
                raise DomainError("invalid_settings", "Reset paths must be null or 1-100 unique JSON pointers.")
            for path in paths:
                if not path.startswith("/") or re.search(r"~(?![01])", path):
                    raise DomainError("invalid_settings", "Reset requires valid JSON pointers.")
                parts = [part.replace("~1", "/").replace("~0", "~") for part in path[1:].split("/")]
                maps = {"range": {"from", "to"}, "overview": {"from", "to"}, "search": {"text", "mode", "caseSensitive", "fields"}}
                if settings["values"].get("definitionVersion") == 2:
                    maps["search"].update({"flags", "matchMode", "dialect"})
                    maps["table"] = {"scope", "projection", "limit"}
                if any(not part or part in ("__proto__", "prototype", "constructor") for part in parts) or len(parts) > 2 or (len(parts) == 2 and parts[0] not in maps):
                    raise DomainError("invalid_settings", "Reset requires a settings field or declared map member.")
                if parts[0] not in DEFINITIONS["$defs"]["settings"]["properties"] or (len(parts) == 2 and parts[1] not in maps[parts[0]]):
                    raise DomainError("invalid_settings", "Reset requires a declared settings field.")
                target = settings["values"]
                for part in parts[:-1]:
                    target = target.get(part) if isinstance(target, dict) else None
                if isinstance(target, dict):
                    target.pop(parts[-1], None)
                if len(parts) == 2 and isinstance(settings["values"].get(parts[0]), dict) and not settings["values"][parts[0]]:
                    del settings["values"][parts[0]]
    settings["revision"] += 1
    snapshot["manifest"].pop("contentSha256", None)
    validated = normalize_configuration(snapshot, actor)
    return {"snapshot": validated, "settings": copy.deepcopy(settings), "effectiveSettings": effective_settings(validated, principal_id=actor["id"])}
