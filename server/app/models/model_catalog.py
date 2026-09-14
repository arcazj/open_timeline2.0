from __future__ import annotations

import copy
import math
import re
import uuid
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .domain import DomainError, MAX_SAFE_INT, instant_ms, now_iso, read_json, validate_json

DEFINITION_FIELDS = {"theme", "rowHeight", "fontSize", "groupBy", "displayUnit", "timeZone", "scaleMode", "ratio", "bins"}
OPTIONAL_DEFINITION_FIELDS = {"presentation"}
MODEL_FIELDS = {"id", "name", "description", "tags", "revision", "lifecycle", "createdAt", "updatedAt", "draft", "versions"}
TIME_UNITS = {"MILLISECOND", "SECOND", "MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "YEAR", "DECADE", "CENTURY", "MILLENNIUM"}
LEGACY_FIELDS = {"id", "name", "version", "theme", "rowHeight", "fontSize", "groupBy"}
DEFAULTS = {"displayUnit": "HOUR", "timeZone": "UTC", "scaleMode": "uniform", "ratio": 4, "bins": 128}
TIME_ZONES = frozenset(read_json(Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "time-zones.json")["zones"])


def model_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise DomainError("invalid_model_id", "Model IDs require 1-128 letters, digits, underscores or hyphens.")
    return value


def integer(value, low, high):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and low <= value <= high and int(value) == value)


def definition_errors(definition):
    errors = []

    def error(field, message, code="invalid_model_definition"):
        pointer = "/" + field.replace("~", "~0").replace("/", "~1") if field else "/"
        errors.append({"path": pointer, "code": code, "message": message})

    if not isinstance(definition, dict):
        error("", "Definition must be an object.")
        return errors
    for field in sorted(DEFINITION_FIELDS - set(definition)):
        error(field, "Required definition field is missing.")
    for field in sorted(set(definition) - DEFINITION_FIELDS - OPTIONAL_DEFINITION_FIELDS):
        error(field, "Unsupported definition field.")
    options = {"theme": {"light", "classic", "dark"}, "groupBy": {"none", "sourceId", "kind"},
               "displayUnit": TIME_UNITS, "scaleMode": {"uniform", "adaptive"}}
    for field, allowed in options.items():
        if field in definition and (not isinstance(definition[field], str) or definition[field] not in allowed):
            error(field, "Value is not a supported option.")
    for field, low, high in (("rowHeight", 32, 128), ("fontSize", 11, 24), ("bins", 16, 256)):
        if field in definition and not integer(definition[field], low, high):
            error(field, f"Value must be an integer from {low} to {high}.")
    if integer(definition.get("fontSize"), 11, 24) and integer(definition.get("rowHeight"), 32, 128):
        if definition["rowHeight"] < definition["fontSize"] + 19:
            error("rowHeight", "Row height must be at least font size plus 19.", "row_height")
    if "ratio" in definition:
        value = definition["ratio"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 1 <= value <= 32:
            error("ratio", "Ratio must be a finite number from 1 to 32.")
    if "timeZone" in definition:
        value = definition["timeZone"]
        if not isinstance(value, str) or value not in TIME_ZONES:
            error("timeZone", "Use UTC or a supported named IANA timezone, not a numeric offset.", "time_zone")
        else:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError):
                error("timeZone", "Timezone is not supported by this environment.", "time_zone")
    if "presentation" in definition:
        from .presentation import presentation_errors
        errors.extend({**item, "path": "/presentation" + item["path"]} for item in presentation_errors(definition["presentation"]))
    return errors


def validate_definition(definition):
    errors = definition_errors(definition)
    if errors:
        first = errors[0]
        raise DomainError("invalid_model_definition", first["path"] + ": " + first["message"])
    validate_json(definition)
    return definition


def metadata_fields(value, required_name=True):
    if required_name or "name" in value:
        name = value.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 100:
            raise DomainError("invalid_model", "Model name requires 1-100 Unicode code points.")
    if "description" in value and (not isinstance(value["description"], str) or len(value["description"]) > 2000):
        raise DomainError("invalid_model", "Model description is limited to 2000 Unicode code points.")
    if "tags" in value:
        tags = value["tags"]
        if not isinstance(tags, list) or len(tags) > 20 or any(not isinstance(tag, str) or not tag.strip() or len(tag) > 40 for tag in tags):
            raise DomainError("invalid_model", "Model tags require at most 20 strings of 1-40 Unicode code points.")
        if len(set(tags)) != len(tags):
            raise DomainError("invalid_model", "Model tags must be unique.")


def validate_model(model):
    if not isinstance(model, dict) or set(model) != MODEL_FIELDS:
        raise DomainError("invalid_model", "Model envelope has missing or unsupported fields.")
    model_id(model["id"])
    metadata_fields(model)
    if not integer(model["revision"], 1, MAX_SAFE_INT):
        raise DomainError("invalid_model", "Model revision must be a positive safe integer.")
    if model["lifecycle"] not in ("active", "archived"):
        raise DomainError("invalid_model", "Model lifecycle must be active or archived.")
    instant_ms(model["createdAt"])
    instant_ms(model["updatedAt"])
    if model["draft"] is not None:
        validate_definition(model["draft"])
    versions = model["versions"]
    if not isinstance(versions, list) or len(versions) > 32 or (not versions and model["draft"] is None):
        raise DomainError("invalid_model", "Model requires a draft or 1-32 published versions.")
    for index, published in enumerate(versions, start=1):
        if not isinstance(published, dict) or set(published) != {"version", "publishedAt", "definition"}:
            raise DomainError("invalid_model", "Published version has missing or unsupported fields.")
        if not integer(published["version"], index, index):
            raise DomainError("invalid_model", "Published versions must be contiguous starting at 1.")
        instant_ms(published["publishedAt"])
        validate_definition(published["definition"])
    validate_json(model)
    return model


def normalize_catalog(models, snapshot_at):
    if not isinstance(models, list) or not 1 <= len(models) <= 100:
        raise DomainError("model_capacity", "Catalog requires 1-100 models.", 413)
    instant_ms(snapshot_at)
    normalized = []
    identities = set()
    for value in models:
        if not isinstance(value, dict):
            raise DomainError("invalid_model", "Model must be an object.")
        if "versions" in value:
            model = copy.deepcopy(value)
        else:
            if set(value) - LEGACY_FIELDS or not {"id", "name", "theme", "rowHeight", "fontSize", "groupBy"} <= set(value):
                raise DomainError("invalid_model", "Legacy preset contains unsupported or missing fields.")
            if "version" in value and not integer(value["version"], 1, 1):
                raise DomainError("invalid_model", "Legacy preset version is invalid.")
            definition = {**DEFAULTS, **{key: copy.deepcopy(value[key]) for key in DEFINITION_FIELDS if key in value}}
            model = {"id": value["id"], "name": value["name"], "description": "", "tags": [], "revision": 1,
                     "lifecycle": "active", "createdAt": snapshot_at, "updatedAt": snapshot_at, "draft": None,
                     "versions": [{"version": 1, "publishedAt": snapshot_at, "definition": definition}]}
        validate_model(model)
        model["revision"] = int(model["revision"])
        for published in model["versions"]:
            published["version"] = int(published["version"])
        if model["id"] in identities:
            raise DomainError("duplicate_id", "Catalog contains duplicate model IDs.")
        identities.add(model["id"])
        normalized.append(model)
    return normalized


def normalize_metadata(meta):
    normalized = copy.deepcopy(meta)
    models = normalize_catalog(meta["models"], meta["manifest"]["snapshotAt"])
    settings = normalized["settings"]
    if "presentation" in settings:
        from .presentation import validate_presentation
        validate_presentation(settings["presentation"])
    original = next((model for model in meta["models"] if model["id"] == settings["modelId"]), None)
    if original is None:
        raise DomainError("missing_model", "Selected model is absent from the complete snapshot.")
    if "modelVersion" not in settings and "versions" not in original:
        settings["modelVersion"] = 1
    selected = next(model for model in models if model["id"] == settings["modelId"])
    if not integer(settings.get("modelVersion"), 1, 32) or not any(version["version"] == settings["modelVersion"] for version in selected["versions"]):
        raise DomainError("model_version_unavailable", "Settings must pin an existing published model version.", 409)
    settings["modelVersion"] = int(settings["modelVersion"])
    normalized["models"] = models
    normalized["manifest"].pop("contentSha256", None)
    return normalized


def apply_model_command(meta, operation, target_id, payload, expected_revision):
    normalized = normalize_metadata(meta)
    models, settings = normalized["models"], normalized["settings"]
    if not isinstance(payload, dict):
        raise DomainError("invalid_model", "Model command payload must be an object.")
    validate_json(payload)
    timestamp = now_iso()
    if operation == "create":
        if set(payload) - {"name", "description", "tags", "definition"} or not {"name", "definition"} <= set(payload):
            raise DomainError("invalid_model", "Create requires name and definition, with optional description and tags.")
        if len(models) >= 100:
            raise DomainError("model_capacity", "Catalog already contains 100 models.", 413)
        metadata_fields(payload)
        validate_definition(payload["definition"])
        model = {"id": str(uuid.uuid4()), "name": payload["name"], "description": payload.get("description", ""),
                 "tags": copy.deepcopy(payload.get("tags", [])), "revision": 1, "lifecycle": "active",
                 "createdAt": timestamp, "updatedAt": timestamp, "draft": copy.deepcopy(payload["definition"]), "versions": []}
        models.append(model)
    else:
        model_id(target_id)
        model = next((value for value in models if value["id"] == target_id), None)
        if model is None:
            raise DomainError("model_not_found", "Model does not exist.", 404)
        if expected_revision != model["revision"]:
            raise DomainError("model_revision_conflict", "Model changed; refresh before retrying.", 412)
        if operation in ("update", "publish", "apply") and model["lifecycle"] == "archived":
            raise DomainError("model_archived", "Unarchive the model before editing, publishing or applying it.", 409)
        if operation == "update":
            if not payload or set(payload) - {"name", "description", "tags", "draft"}:
                raise DomainError("invalid_model", "Update requires at least one mutable metadata field or a complete draft.")
            metadata_fields(payload, required_name=False)
            if "draft" in payload:
                validate_definition(payload["draft"])
            model.update(copy.deepcopy(payload))
        elif operation == "publish":
            if payload:
                raise DomainError("invalid_model", "Publish payload must be empty.")
            if model["draft"] is None:
                raise DomainError("model_draft_missing", "Save a draft before publishing.", 409)
            if len(model["versions"]) >= 32:
                raise DomainError("model_version_capacity", "Model already contains 32 published versions.", 413)
            model["versions"].append({"version": len(model["versions"]) + 1, "publishedAt": timestamp,
                                      "definition": copy.deepcopy(model["draft"])})
            model["draft"] = None
        elif operation in ("archive", "unarchive"):
            if payload:
                raise DomainError("invalid_model", "Lifecycle payload must be empty.")
            target = "archived" if operation == "archive" else "active"
            if model["lifecycle"] == target:
                raise DomainError("model_lifecycle_conflict", "Model is already in the requested lifecycle state.", 409)
            model["lifecycle"] = target
        elif operation == "delete":
            if payload:
                raise DomainError("invalid_model", "Delete payload must be empty.")
            if settings["modelId"] == target_id:
                raise DomainError("model_referenced", "Model is pinned by the workspace default.", 409)
            if len(models) <= 1:
                raise DomainError("last_model", "The last catalog model cannot be deleted.", 409)
            models.remove(model)
            model = None
        elif operation == "apply":
            if set(payload) != {"version"} or not integer(payload["version"], 1, 32):
                raise DomainError("invalid_model", "Apply requires one positive published version number.")
            published = next((version for version in model["versions"] if version["version"] == payload["version"]), None)
            if published is None:
                raise DomainError("model_version_unavailable", "Requested published version does not exist.", 409)
            settings.pop("presentation", None)
            settings.update(copy.deepcopy(published["definition"]))
            settings.update(modelId=model["id"], modelVersion=published["version"])
        else:
            raise DomainError("invalid_command", "Unsupported model command.")
        if model is not None and operation != "apply":
            if model["revision"] == MAX_SAFE_INT:
                raise DomainError("model_revision_capacity", "Model revision capacity reached.", 413)
            model["revision"] += 1
            model["updatedAt"] = timestamp
    normalize_metadata(normalized)
    return normalized, model
