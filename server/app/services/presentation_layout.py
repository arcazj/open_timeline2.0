from __future__ import annotations

import copy
import json
import math
import unicodedata
from functools import cmp_to_key
from pathlib import Path

import rfc8785

from ..models.domain import DomainError, instant_ms
from ..models.model_catalog import TIME_UNITS
from ..models.presentation import MISSING, pointer_value, validate_presentation
from .row_packer import pack_footprints
from .preparation_control import checked, checkpoint

HAZARD_ICONS = frozenset(json.loads((Path(__file__).resolve().parents[3] / "shared/legacy-hazard-icons.json").read_text(encoding="utf-8")).values())


def resolved_presentation(value, font_size, theme, group_by="none", display_unit="HOUR"):
    validate_presentation(value)
    if not isinstance(display_unit, str) or display_unit not in TIME_UNITS:
        raise DomainError("invalid_presentation", "Unknown display unit.")
    if theme not in {"light", "classic", "dark"}:
        raise DomainError("invalid_presentation", "Unknown layout theme.")
    dark = theme == "dark"
    common = {"textColor": "#e4edf0" if dark else "#27343a", "dateColor": "#a1b3bc" if dark else "#667981",
              "sessionColor": "#39788a", "eventColor": "#39788a", "axisPosition": "bottom", "dateFormat": "DEFAULT"}
    bands = {"primary": {**common, "backgroundColor": {"light": "#eef0f0", "classic": "#a9d7ef", "dark": "#171c21"}[theme],
                         "barHeight": 8, "pointRadius": 4.5, "intervalUnit": display_unit},
             "overview": {**common, "backgroundColor": "#283841" if dark else "#f0f2f4",
                          "barHeight": 4, "pointRadius": 2, "intervalUnit": "DAY"}}
    for name, band in value.get("bands", {}).items():
        bands[name].update(copy.deepcopy(band))
    return {"version": 1, "bands": bands, "sourceStyles": copy.deepcopy(value.get("sourceStyles", [])),
            **({"compact": value["compact"]} if "compact" in value else {}),
            **({"durationLabels": value["durationLabels"]} if "durationLabels" in value else {}),
            **({"bandLayout": copy.deepcopy(value["bandLayout"])} if "bandLayout" in value else {}),
            "grouping": {"direction": "asc", **copy.deepcopy(value["grouping"])} if "grouping" in value else
                        {"field": "/" + group_by if group_by != "none" else None, "direction": "asc"},
            "labels": {"fields": ["/title"], "fontSize": font_size, "fontWeight": 400, "fontStyle": "normal",
                       "maxLines": 1, "backgroundColor": None, **copy.deepcopy(value.get("labels", {}))},
            "inspector": copy.deepcopy(value.get("inspector")),
            "nesting": {"enabled": False, "color": "#75909e", "opacity": 0.15, **copy.deepcopy(value.get("nesting", {}))},
            "baseline": {"enabled": False, "color": "#78848d", **copy.deepcopy(value.get("baseline", {}))}}


def resolved_style(record, presentation, band_name="primary"):
    band = presentation["bands"][band_name]
    source = next((style for style in presentation["sourceStyles"] if style["sourceId"] == record["sourceId"]), {})
    palette = {**band, **source}
    labels = presentation["labels"]
    result = {"color": palette["eventColor" if record["kind"] == "event" else "sessionColor"],
              "textColor": palette["textColor"], "backgroundColor": labels["backgroundColor"],
              "fontSize": labels["fontSize"], "fontWeight": labels["fontWeight"], "fontStyle": labels["fontStyle"],
              "barHeight": band["barHeight"], "pointRadius": band["pointRadius"], "icon": None,
              "sourceBackground": source.get("backgroundColor")}
    result.update(copy.deepcopy(record["render"]))
    return result


def group_style(value, presentation):
    field = presentation["grouping"]["field"]
    source = next((style for style in presentation["sourceStyles"] if style["sourceId"] == value), {}) if field == "/sourceId" else {}
    if field == "/data/namespace" and isinstance(value, str):
        source = next((style for style in presentation["sourceStyles"]
                       if "namespace" in style and unicodedata.normalize("NFC", style["namespace"]) == value), {})
    return {"backgroundColor": source.get("backgroundColor"),
            "textColor": source.get("textColor", presentation["bands"]["primary"]["textColor"]),
            "dateColor": source.get("dateColor", presentation["bands"]["primary"]["dateColor"])}


def full_label(record, fields):
    parts = []
    for field in fields:
        value = pointer_value(record, field)
        if value is MISSING or value is None:
            continue
        if isinstance(value, (dict, list)):
            raise DomainError("invalid_label_value", "Label fields must resolve to scalar JSON values.")
        text = value if isinstance(value, str) else rfc8785.dumps(value).decode()
        if text:
            parts.append(text)
    text = " | ".join(parts)
    return (text or record["title"]).replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")


def wrap_label(text, metrics, font_size, width, max_lines):
    tolerance = 1e-9
    measure = lambda value: metrics.measure(value, font_size)["width"]  # noqa: E731
    if width <= 0 or measure("...") > width + tolerance:
        raise DomainError("label_width_limit", "The available label width cannot fit a measured ellipsis.")
    paragraphs = text.split("\n")
    lines = []
    overflow = False
    for paragraph_index, paragraph in enumerate(paragraphs):
        remaining = paragraph
        if not remaining and len(lines) < max_lines:
            lines.append("")
        while remaining:
            checkpoint()
            if len(lines) == max_lines:
                overflow = True
                break
            if measure(remaining) <= width + tolerance:
                lines.append(remaining)
                break
            low, high = 0, len(remaining)
            while low < high:
                middle = (low + high + 1) // 2
                if measure(remaining[:middle]) <= width + tolerance:
                    low = middle
                else:
                    high = middle - 1
            if low == 0:
                raise DomainError("label_width_limit", "The available label width cannot contain a measured glyph.")
            prefix = remaining[:low]
            space = prefix.rfind(" ")
            if space > 0:
                lines.append(prefix[:space].rstrip(" "))
                remaining = remaining[space + 1:].lstrip(" ")
            else:
                lines.append(prefix.rstrip(" "))
                remaining = remaining[low:].lstrip(" ")
        if overflow:
            break
        if len(lines) == max_lines and paragraph_index < len(paragraphs) - 1:
            overflow = True
            break
    if overflow:
        if measure("...") > width + tolerance:
            raise DomainError("label_width_limit", "The available label width cannot fit a measured ellipsis.")
        last = lines[-1]
        while measure(last + "...") > width + tolerance:
            last = last[:-1]
        lines[-1] = last + "..."
    line_metrics = [metrics.measure(line, font_size) for line in lines]
    return lines, max((metric["width"] for metric in line_metrics), default=0), line_metrics, overflow


def group_value(record, field):
    value = pointer_value(record, field)
    if value is MISSING:
        return (4, ""), "(missing)"
    if value is None:
        return (3, ""), "(null)"
    if isinstance(value, bool):
        return (2, value), "true" if value else "false"
    if isinstance(value, (int, float)):
        return (0, value), rfc8785.dumps(value).decode()
    if isinstance(value, str):
        normalized = unicodedata.normalize("NFC", value)
        return (1, normalized), normalized
    raise DomainError("invalid_group_value", "Grouping fields must resolve to scalar JSON values.")


def temporal_order(record):
    return instant_ms(record["start"]), instant_ms(record["end"]) if record["end"] is not None else math.inf, record["id"]


def group_key(key):
    rank, value = key
    prefix = ("number", "string", "boolean", "null", "missing")[rank]
    text = value if rank == 1 else rfc8785.dumps(value).decode() if rank < 3 else ""
    return prefix + ":" + text


def build_styled_layout(selected, request, width, requested_height, font_size, group_by, project, domain_end, metrics_for):
    presentation = resolved_presentation(request.get("presentation", {"version": 1}), font_size, request.get("theme", "light"),
                                         group_by, request.get("displayUnit", "HOUR"))
    grouping = presentation["grouping"]
    field = grouping["field"]
    descending = grouping["direction"] == "desc"
    groups = {}
    band_sources = next((band.get("sourceIds") for band in presentation.get("bandLayout", []) if band["role"] == "primary"), None)
    for record in checked(selected):
        if band_sources and record["sourceId"] not in band_sources:
            continue
        key, name = group_value(record, field) if field else ((0, ""), "")
        groups.setdefault(key, {"name": name, "records": []})["records"].append(record)

    def compare_groups(left, right):
        if left[0] != right[0]:
            return -1 if left[0] < right[0] else 1
        result = (left[1] > right[1]) - (left[1] < right[1])
        return -result if descending and left[0] < 3 else result

    items, rows, enclosures, row_offset = [], [], [], 0
    effective_height = 21 if presentation.get("compact") else requested_height
    for key in sorted(groups, key=cmp_to_key(compare_groups)):
        group = groups[key]
        if field:
            row = {"row": row_offset, "type": "group", "name": group["name"], "key": group_key(key),
                   "style": group_style(key[1], presentation)}
            rows.append(row)
            row_offset += 1
        records = sorted(group["records"], key=temporal_order)
        record_map = {record["id"]: record for record in records}
        ancestors, children = {}, {}
        nested = presentation["nesting"]["enabled"] and any(record.get("parentSessionId") in record_map for record in records)
        if nested:
            for record in records:
                parent = record.get("parentSessionId")
                if parent in record_map:
                    children.setdefault(parent, []).append(record)
            for values in children.values():
                values.sort(key=lambda record: (record.get("order", 0), *temporal_order(record)))
            ordered = []

            def visit(record, chain):
                if len(chain) > 8 or record["id"] in chain:
                    raise DomainError("invalid_parent", "Parent nesting is cyclic or too deep.")
                ancestors[record["id"]] = chain
                ordered.append(record)
                for child in children.get(record["id"], []):
                    visit(child, [*chain, record["id"]])

            for record in records:
                if record.get("parentSessionId") not in record_map:
                    visit(record, [])
            if len(ordered) != len(records):
                raise DomainError("invalid_parent", "Parent nesting contains a cycle.")
            records = ordered
        group_items = []
        for record in checked(records):
            style = resolved_style(record, presentation)
            metrics = metrics_for(style["fontWeight"], style["fontStyle"])
            label = full_label(record, presentation["labels"]["fields"])
            record_start = instant_ms(record["start"])
            record_end = instant_ms(record["end"]) if record["end"] is not None else domain_end
            point = record["kind"] == "event" or record_end == record_start
            if record["kind"] == "event":
                record_end = record_start
            x_start, x_end = project(record_start), project(record_end)
            bitmap_point = point and style["icon"] in HAZARD_ICONS
            icon_x = x_start - (8 if bitmap_point else style["pointRadius"] + 5 + 16 if point else 20) if style["icon"] else None
            if point:
                unwrapped = max(metrics.measure(line, style["fontSize"])["width"] for line in label.split("\n"))
                right_gap = (8 if bitmap_point else style["pointRadius"]) + 5
                left_gap = 12 if bitmap_point else style["pointRadius"] + 25 if style["icon"] else right_gap
                right_space, left_space = width - 6 - x_start - right_gap, x_start - left_gap - 6
                right_side = unwrapped <= right_space or (unwrapped > left_space and right_space >= left_space)
                available = right_space if right_side else left_space
            else:
                available = width - 12
            lines, label_width, line_metrics, overflow = wrap_label(label, metrics, style["fontSize"], available, presentation["labels"]["maxLines"])
            label_x = (x_start + right_gap if right_side else x_start - left_gap - label_width) if point else max(6, min(width - 6 - label_width, x_start))
            line_height = math.ceil(style["fontSize"] * 1.35)
            geometry_y = 6 + max(16, len(lines) * line_height) / 2 if point else 8 + len(lines) * line_height + style["barHeight"] / 2
            label_y = 6
            if presentation.get("compact"):
                label_y = 2
                geometry_y = 2 + len(lines) * line_height / 2 if point else 2 + len(lines) * line_height + style["barHeight"] / 2
            inside = not point and not style["icon"] and presentation.get("durationLabels") == "inside-when-fitting" and label_x >= x_start and label_x + label_width + 4 <= min(width, x_end)
            if inside:
                style["barHeight"] = max(style["barHeight"], len(lines) * line_height + 2)
                label_x += 2
                geometry_y = label_y + len(lines) * line_height / 2
            padding = style["pointRadius"] + 2 if point else 2
            left = max(0, min(x_start - padding, label_x - 2))
            right = min(width, max(x_end + padding, label_x + label_width + 2))
            row_bottom = max(6 + len(lines) * line_height + 6,
                             geometry_y + (max(style["pointRadius"], 8) if point else max(style["barHeight"] / 2, 8 if style["icon"] else 0)) + 6)
            if presentation.get("compact"):
                row_bottom = max(label_y + len(lines) * line_height, geometry_y + (style["pointRadius"] if point else style["barHeight"] / 2)) + 2
            item = {"record": copy.deepcopy(record), "xStart": x_start, "xEnd": x_end, "labelX": label_x,
                    "labelWidth": label_width, "labelInkOffsets": [-metric["offset"] for metric in line_metrics],
                    "labelLines": lines, "labelLineHeight": line_height, "labelOffsetY": label_y,
                    "geometryOffsetY": geometry_y, "fullLabel": label, "displayTitle": "\n".join(lines),
                    "overflow": overflow, "style": style, "parentId": record.get("parentSessionId"),
                    "ancestorIds": ancestors.get(record["id"], []), "depth": len(ancestors.get(record["id"], []))}
            if inside:
                item["labelInsideBar"] = True
            if icon_x is not None:
                item["iconX"] = icon_x
                left = max(0, min(left, icon_x - 2))
                right = min(width, max(right, icon_x + 18))
            if presentation["baseline"]["enabled"] and (record.get("originalStart") is not None or record.get("originalEnd") is not None):
                baseline_start = instant_ms(record.get("originalStart") or record["start"])
                fallback_end = record["end"] or (None if record["kind"] == "session" else record["start"])
                baseline_end = instant_ms(record.get("originalEnd") or fallback_end) if record.get("originalEnd") or fallback_end else domain_end
                item["baselineStart"], item["baselineEnd"] = project(baseline_start), project(baseline_end)
                item["baselineOffsetY"] = geometry_y + (style["pointRadius"] if point else style["barHeight"] / 2) + 3
                if point:
                    item["baselineOffsetY"] = max(item["baselineOffsetY"], 6 + len(lines) * line_height + 3)
                left = max(0, min(left, item["baselineStart"] - 2, item["baselineEnd"] - 2))
                right = min(width, max(right, item["baselineStart"] + 2, item["baselineEnd"] + 2))
                row_bottom = max(row_bottom, item["baselineOffsetY"] + 0.5 + 6)
            effective_height = max(effective_height, math.ceil(row_bottom))
            item.update(row=0, footprintStart=left, footprintEnd=right)
            group_items.append(item)
        packed = {"rows": range(len(group_items)), "count": len(group_items)} if nested else pack_footprints(group_items)
        for item, row in zip(group_items, packed["rows"]):
            item["row"] = row_offset + row
        if nested:
            descendant_items = {}
            for item in group_items:
                for ancestor in item["ancestorIds"]:
                    descendant_items.setdefault(ancestor, []).append(item)
            for parent in group_items:
                descendants = descendant_items.get(parent["record"]["id"], [])
                if descendants:
                    block = [parent, *descendants]
                    enclosures.append({"parentId": parent["record"]["id"], "title": parent["record"]["title"],
                                       "startRow": parent["row"], "endRow": max(item["row"] for item in block) + 1,
                                       "xStart": max(0, min(item["footprintStart"] for item in block) - 4),
                                       "xEnd": min(width, max(item["footprintEnd"] for item in block) + 4),
                                       "color": presentation["nesting"]["color"], "opacity": presentation["nesting"]["opacity"],
                                       "depth": parent["depth"]})
        items.extend(group_items)
        row_offset += packed["count"]
    if effective_height > 192:
        raise DomainError("row_height_limit", "Resolved label and geometry exceed the 192-pixel row limit.")
    enclosures.sort(key=lambda value: (value["startRow"], -value["endRow"], value["parentId"]))
    return {"items": items, "rows": rows, "enclosures": enclosures, "rowHeight": math.ceil(effective_height),
            "totalRows": row_offset, "presentation": presentation}
