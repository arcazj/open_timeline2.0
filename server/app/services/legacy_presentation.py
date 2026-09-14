"""Read-only legacy model adaptation; no legacy code or connector is executed."""

from __future__ import annotations

import copy
import hashlib
import re
from datetime import UTC, datetime

import rfc8785

from ..models.configuration_catalog import normalize_configuration
from ..models.domain import DomainError, instant_ms, validate_json, validate_snapshot
from ..models.model_catalog import definition_errors, validate_model

BAND_FIELDS = {"color": "backgroundColor", "textColor": "textColor", "dateColor": "dateColor",
               "SessionColor": "sessionColor", "eventColor": "eventColor", "sessionHeight": "barHeight",
               "defaultEventSize": "pointRadius", "intervalUnit": "intervalUnit", "dateFormat": "dateFormat"}
PARAM_FIELDS = {"name", "title", "date", "timeZone", "top", "left", "height", "width", "fontSize",
                "fontFamily", "fontWeight", "fontStyle", "camera", "data", "data_default_port", "data_sse_port"}
OTHER_BAND_FIELDS = {"name", "height", "intervalPixels", "subIntervalPixels", "intervalUnitPos", "fontSize",
                     "fontWeight", "fontStyle", "fontFamily", "textBackgroundColor", "model"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _problem(message):
    return DomainError("invalid_legacy_presentation", message)


def _number(value, label):
    if isinstance(value, str) and re.fullmatch(r"(?:0|[1-9]\d*)(?:\.\d+)?", value):
        value = float(value)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value < float("inf"):
        raise _problem(f"{label} must be a positive decimal number")
    return value


def legacy_model_focus(value=None):
    if value is None or value == "current_time":
        return {"mode": "current", "timestamp": None}
    try:
        ms = instant_ms(value)
        stamp = datetime.fromtimestamp(ms / 1000, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return {"mode": "fixed", "timestamp": stamp}
    except (DomainError, TypeError, ValueError, OverflowError):
        pass
    match = re.fullmatch(r"(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) "
                         r"(\d{1,2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) UTC", value) if isinstance(value, str) else None
    if not match:
        raise _problem("Model reference date requires offset ISO or an explicit legacy UTC date")
    weekday, month, day, year, hour, minute, second = match.groups()
    try:
        date = datetime(int(year), MONTHS.index(month) + 1, int(day), int(hour), int(minute), int(second), tzinfo=UTC)
        if DAYS[date.weekday()] != weekday:
            raise ValueError("weekday")
        return {"mode": "fixed", "timestamp": date.isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    except ValueError as error:
        raise _problem("Model reference date is invalid or its weekday does not match") from error


def adapt_legacy_presentation(model, *, source_bindings=None, namespace_grouping=None, sort_by=None, focus=None):
    validate_json(model)
    source_bindings = [] if source_bindings is None else source_bindings
    validate_json(source_bindings)
    if (not isinstance(model, dict) or not isinstance(model.get("params"), list) or len(model["params"]) != 1
            or not isinstance(model["params"][0], dict) or not isinstance(model.get("bands"), list)
            or len(model["bands"]) != 2 or not all(isinstance(band, dict) for band in model["bands"])
            or re.search("overview", str(model["bands"][0].get("name", "")), re.I)
            or not re.search("overview", str(model["bands"][1].get("name", "")), re.I)):
        raise _problem("Compatibility profile requires one primary band and one named overview band")
    if not isinstance(source_bindings, list) or len(source_bindings) > 100:
        raise _problem("At most 100 explicit source bindings are supported")
    if namespace_grouping is not None and not isinstance(namespace_grouping, bool):
        raise _problem("namespaceGrouping must be boolean")
    params = model["params"][0]
    definition = {"theme": "light", "rowHeight": 32, "fontSize": 13, "groupBy": "none", "displayUnit": "HOUR",
                  "timeZone": "UTC", "scaleMode": "uniform", "ratio": 4, "bins": 128}
    diagnostics = []

    def notice(path, code, message):
        diagnostics.append({"path": path, "code": code, "severity": "notice", "message": message})

    def unsupported(path):
        diagnostics.append({"path": path, "code": "unsupported_legacy_presentation", "severity": "warning",
                            "message": "This authored property is preserved in source provenance but is not rendered or executed."})

    if params.get("camera", "Orthographic") != "Orthographic":
        raise _problem("Perspective models require a separate explicit compatibility implementation")
    name = params.get("title", "Legacy timeline")
    if not isinstance(name, str) or not name.strip() or len(name) > 100:
        raise _problem("Model title must contain 1-100 characters")
    definition["fontSize"] = _number(params.get("fontSize", 12), "fontSize")
    definition["rowHeight"] = max(32, definition["fontSize"] + 19)
    definition["timeZone"] = params.get("timeZone", "UTC")
    presentation = {"version": 1, "bands": {}, "labels": {"fields": ["/title"]}, "nesting": {"enabled": True}}
    hints = {"version": 1, "focus": legacy_model_focus(focus if focus is not None else params.get("date")), "bands": {}}
    heights = []
    for index, band in enumerate(model["bands"]):
        role = "overview" if index else "primary"
        target = {field: copy.deepcopy(band[legacy]) for legacy, field in BAND_FIELDS.items() if legacy in band}
        target.setdefault("barHeight", 4 if index else 10)
        target.setdefault("pointRadius", 2 if index else 5)
        axis = band.get("intervalUnitPos", "BOTTOM")
        if axis not in {"TOP", "BOTTOM"}:
            raise _problem("Unknown legacy axis position")
        target["axisPosition"] = axis.lower()
        target.setdefault("intervalUnit", "DAY" if index else "HOUR")
        presentation["bands"][role] = target
        if not index:
            definition["displayUnit"] = target["intervalUnit"]
            for field in ("fontSize", "fontWeight", "fontStyle"):
                if field in band or field in params:
                    value = band.get(field, params.get(field))
                    if field == "fontSize":
                        value = _number(value, field)
                    if field == "fontWeight" and isinstance(value, str):
                        value = {"normal": 400, "bold": 700}.get(value.lower(), value)
                    presentation["labels"][field] = value
            if "textBackgroundColor" in band:
                presentation["labels"]["backgroundColor"] = None if band["textBackgroundColor"] is False else band["textBackgroundColor"]
        height = band.get("height")
        if not isinstance(height, str) or not re.fullmatch(r"(?:[1-9]\d?|100)%", height):
            raise _problem("Legacy band heights must be explicit percentages")
        height = int(height[:-1])
        heights.append(height)
        hints["bands"][role] = {"heightFraction": height / 100, "intervalPixels": _number(band.get("intervalPixels"), "intervalPixels"),
                                "intervalUnit": target["intervalUnit"]}
        if "subIntervalPixels" in band and band["subIntervalPixels"] != "NONE":
            if band.get("intervalUnit") == "HOUR" and hints["bands"][role]["intervalPixels"] >= 60:
                target["minorDivisions"] = 4
            else:
                unsupported(f"/bands/{index}/subIntervalPixels")
        if "dateFormat" in band:
            notice(f"/bands/{index}/dateFormat", "calendar_format_correction", "Calendar months and 24-hour time are formatted correctly; legacy formatter defects are not reproduced.")
        for key in band:
            if key not in BAND_FIELDS and key not in OTHER_BAND_FIELDS:
                unsupported(f"/bands/{index}/{key}")
        if "model" in band:
            if not isinstance(band["model"], list) or len(band["model"]) != 1 or not isinstance(band["model"][0], dict):
                raise _problem("Only one sort model per band is supported")
            for key in band["model"][0]:
                if key == "alternateColor":
                    notice(f"/bands/{index}/model/0/{key}", "inactive_legacy_property", "No legacy consumer of model.alternateColor was found; this value is not applied as a lane palette.")
                elif key != "sortBy":
                    unsupported(f"/bands/{index}/model/0/{key}")
    if sum(heights) != 100:
        raise _problem("Primary and overview percentages must total 100")
    grouping = "namespace" if namespace_grouping is True else "NONE" if namespace_grouping is False else sort_by if sort_by is not None else model["bands"][0].get("model", [{}])[0].get("sortBy", "NONE")
    if grouping != "NONE":
        if not isinstance(grouping, str) or not re.fullmatch(r"[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,7}", grouping, re.ASCII):
            raise _problem("Legacy grouping must be a safe data-property chain")
        presentation["grouping"] = {"field": "/data/" + grouping.replace(".", "/"), "direction": "asc"}
    presentation["sourceStyles"] = []
    for index, binding in enumerate(source_bindings):
        if not isinstance(binding, dict):
            raise _problem("Invalid source binding")
        if binding.get("enabled") is False:
            continue
        style = {"sourceId": binding.get("sourceId")}
        if "namespace" in binding:
            style["namespace"] = binding["namespace"]
        render = binding.get("render", {})
        if not isinstance(render, dict):
            raise _problem("Source render must be an object")
        for field, target in {"color": "backgroundColor", "textColor": "textColor", "dateColor": "dateColor"}.items():
            if field in render:
                style[target] = render[field]
        for field in render:
            if field == "alternateColor":
                notice(f"/sourceBindings/{index}/render/{field}", "inactive_legacy_property", "Legacy namespace lanes use source.color without alternating this color.")
            elif field not in {"color", "textColor", "dateColor"}:
                unsupported(f"/sourceBindings/{index}/render/{field}")
        presentation["sourceStyles"].append(style)
    definition["presentation"] = presentation
    if definition_errors(definition):
        raise _problem("Legacy model contains unsupported presentation values")
    for key in model:
        if key not in {"params", "bands"}:
            unsupported(f"/{key}")
    for key in params:
        if key not in PARAM_FIELDS:
            unsupported(f"/params/0/{key}")
    for key in ("data", "data_default_port", "data_sse_port"):
        if key in params:
            notice(f"/params/0/{key}", "connector_not_activated", "Legacy data paths and ports are not executed; only explicitly configured read-only sources are used.")
    notice("/params/0/fontFamily", "measured_font_substitution", "Embedded measured Noto Sans replaces the legacy browser font; exact historical glyph geometry is not claimed.")
    notice("/params/0/width", "responsive_geometry", "Authored band proportions and scale are retained; fixed page placement is replaced by responsive viewport dimensions.")
    return {"name": name, "definition": definition, "viewHints": hints, "diagnostics": diagnostics}


def apply_legacy_presentation(snapshot, adapted):
    """Return a validated presentation snapshot without editing data or model history.

    Responsive viewport geometry is applied by the client from viewHints. The source
    range stays unchanged here so a bounded archive snapshot cannot imply more data.
    """
    validate_snapshot(snapshot)
    validate_json(adapted)
    if (not isinstance(adapted, dict) or set(adapted) != {"name", "definition", "viewHints", "diagnostics"}
            or not isinstance(adapted["viewHints"], dict) or not isinstance(adapted["diagnostics"], list)):
        raise _problem("Expected an adapted legacy presentation with explicit view hints and diagnostics")
    digest = hashlib.sha256(rfc8785.dumps({"name": adapted["name"], "definition": adapted["definition"]})).hexdigest()
    model_id = "legacy-presentation-" + digest[:32]
    timestamp = snapshot["manifest"]["snapshotAt"]
    model = {"id": model_id, "name": adapted["name"], "description": "Read-only legacy presentation",
             "tags": ["legacy"], "revision": 1, "lifecycle": "active", "createdAt": timestamp,
             "updatedAt": timestamp, "draft": None,
             "versions": [{"version": 1, "publishedAt": timestamp, "definition": copy.deepcopy(adapted["definition"])}]}
    validate_model(model)
    result = normalize_configuration(snapshot, {"id": "legacy-presentation", "capabilities": ["*"]})
    existing = next((value for value in result["models"] if value["id"] == model_id), None)
    if existing is None:
        if len(result["models"]) >= 100:
            raise DomainError("model_capacity", "Legacy presentation would exceed the 100-model catalog limit.", 413)
        result["models"].append(model)
    elif (existing["name"] != adapted["name"] or existing["lifecycle"] != "active" or not existing["versions"]
          or existing["versions"][0]["definition"] != adapted["definition"]):
        raise _problem("Legacy presentation identity conflicts with an existing model publication")
    result["settings"].update(copy.deepcopy(adapted["definition"]))
    result["settings"].update(modelId=model_id, modelVersion=1)
    legacy = result["manifest"].setdefault("legacy", {})
    if not isinstance(legacy, dict):
        raise _problem("Legacy provenance must be an object")
    legacy.update(viewHints=copy.deepcopy(adapted["viewHints"]),
                  presentationDiagnostics=copy.deepcopy(adapted["diagnostics"]))
    result["manifest"].pop("contentSha256", None)
    validate_snapshot(result)
    return result
