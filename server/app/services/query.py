from __future__ import annotations

import base64
import bisect
import copy
import hashlib
import hmac
import math
import re
import secrets
import threading
import time
import uuid
import weakref
from collections import OrderedDict
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path

import rfc8785

from ..models.domain import DomainError, instant_ms, json_bytes, read_json
from .query_configuration import resolve_query_configuration
from .presentation_layout import build_styled_layout
from .query_access import current_query_access
from .query_resources import QueryResourceLedger
from .preparation_control import checked, checkpoint
from .row_packer import pack_footprints
from .fixed_scale import fixed_scale_map
from .table_query import TABLE_CACHE_LIMIT, TABLE_RESPONSE_BYTES, normalize_table_input, prepare_table


def number(value, name, minimum, maximum, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise DomainError("invalid_query", f"{name} must be a finite number.")
    if value < minimum or value > maximum or (integer and int(value) != value):
        raise DomainError("invalid_query", f"{name} is outside its supported bounds.")
    return int(value) if integer else value


def decimal_string(value: Decimal):
    if value.is_zero():
        return "0"
    with localcontext() as context:
        context.prec = 34
        result = format(+value, "f")
        return result.rstrip("0").rstrip(".") if "." in result else result


def continuous(value, fallback):
    if value is None:
        return Decimal(fallback)
    if not isinstance(value, str) or len(value) > 100 or not re.fullmatch(r"-?(?:0|[1-9]\d*)(?:\.\d+)?", value):
        raise DomainError("invalid_view", "Continuous view bounds require bounded decimal strings.")
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise DomainError("invalid_view", "Invalid continuous view bound.") from error
    digits = result.as_tuple().digits
    significant = len(digits)
    while significant > 1 and digits[significant - 1] == 0:
        significant -= 1
    if not result.is_finite() or result.adjusted() > 15 or significant > 34:
        raise DomainError("invalid_view", "Continuous view bound is not finite or is out of range.")
    return result


def mapped(knots, timestamp):
    value = Decimal(timestamp)
    times = [knot["timeMs"] for knot in knots]
    if value < times[0] or value > times[-1]:
        raise DomainError("outside_domain", "The view must stay within the query analysis domain.")
    index = max(0, min(len(knots) - 2, bisect.bisect_right(times, value) - 1))
    left, right = knots[index], knots[index + 1]
    u0, u1 = Decimal(left["u"]), Decimal(right["u"])
    return u0 + (u1 - u0) * (value - left["timeMs"]) / (right["timeMs"] - left["timeMs"])


def record_bounds(record):
    start = instant_ms(record["start"])
    end = instant_ms(record["end"]) if record["end"] is not None else None
    return start, end, record["kind"] == "event" or end == start


def bounds_intersect(bounds, start, end):
    record_start, record_end, point = bounds
    return start <= record_start < end if point else record_start < end and (record_end is None or record_end > start)


def build_density(records, start, end, requested_bins, cached_bounds=None):
    count = min(requested_bins, end - start)
    edges = [start + i * (end - start) // count for i in range(count + 1)]
    bins = [{"from": edges[i], "to": edges[i + 1], "points": 0, "overlapMs": 0, "endpoints": 0} for i in range(count)]
    full_bins = [0] * (count + 1)
    selected_count = 0
    for record in checked(records):
        bounds = cached_bounds[record["id"]] if cached_bounds is not None else record_bounds(record)
        if not bounds_intersect(bounds, start, end):
            continue
        selected_count += 1
        record_start, record_end, point = bounds
        if point:
            index = min(count - 1, bisect.bisect_right(edges, record_start) - 1)
            bins[index]["points"] += 1
            continue
        for endpoint in (record_start, record_end):
            if endpoint is not None and start <= endpoint < end:
                bins[bisect.bisect_right(edges, endpoint) - 1]["endpoints"] += 1
        lower, upper = max(start, record_start), min(end, record_end if record_end is not None else end)
        first = max(0, bisect.bisect_right(edges, lower) - 1)
        last = min(count - 1, bisect.bisect_left(edges, upper) - 1)
        if first == last:
            bins[first]["overlapMs"] += upper - lower
        else:
            bins[first]["overlapMs"] += edges[first + 1] - lower
            bins[last]["overlapMs"] += upper - edges[last]
            full_bins[first + 1] += 1
            full_bins[last] -= 1
    active = 0
    for index, item in enumerate(bins):
        active += full_bins[index]
        item["overlapMs"] += active * (item["to"] - item["from"])
        item["density"] = item["points"] + item["overlapMs"] / (item["to"] - item["from"]) + 0.5 * item["endpoints"]
        item["overlapMs"] = str(item["overlapMs"])
    return {"bins": bins, "complete": True, "total": selected_count}


def overview_bin_counts(records, bins, cached_bounds):
    edges = [bins[0]["from"], *[item["to"] for item in bins]]
    difference = [0] * (len(bins) + 1)
    for record in records:
        bounds = cached_bounds[record["id"]]
        if not bounds_intersect(bounds, edges[0], edges[-1]):
            continue
        start, end, point = bounds
        first = max(0, bisect.bisect_right(edges, max(edges[0], start)) - 1)
        last = first if point else min(len(bins) - 1, bisect.bisect_left(edges, min(edges[-1], end if end is not None else edges[-1])) - 1)
        difference[first] += 1
        difference[last + 1] -= 1
    active, counts = 0, []
    for index in range(len(bins)):
        active += difference[index]
        counts.append(active)
    return counts


def build_map(density, domain, mode, ratio, map_id):
    with localcontext() as context:
        context.prec = 50
        maximum = max((item["density"] for item in density["bins"]), default=0)
        masses = []
        for item in density["bins"]:
            weight = Decimal(1)
            if mode == "adaptive" and maximum > 0:
                weight += Decimal(str(ratio - 1)) * Decimal(str(math.log1p(item["density"]))) / Decimal(str(math.log1p(maximum)))
            masses.append(weight * (item["to"] - item["from"]))
        total = sum(masses, Decimal(0))
        cumulative = Decimal(0)
        knots = []
        for item, mass in zip(density["bins"], masses):
            knots.append({"timeMs": item["from"], "u": decimal_string(cumulative / total)})
            cumulative += mass
        knots.append({"timeMs": density["bins"][-1]["to"], "u": "1"})
        return {"mapId": map_id, "domain": domain, "knots": knots, "mode": mode, "ratio": ratio}


class FontMetrics:
    def __init__(self, path: Path):
        self.profile = read_json(path)

    def measure(self, text: str, font_size: int):
        pen, ink_min, ink_max = 0, 0, 0
        glyphs = self.profile["glyphs"]
        for character in checked(text):
            glyph = glyphs.get(str(ord(character)))
            if glyph is None:
                raise DomainError("unsupported_glyph", f"Render profile lacks U+{ord(character):04X}; select a supported font profile.")
            ink_min = min(ink_min, pen + glyph["xMin"])
            ink_max = max(ink_max, pen + glyph["xMax"])
            pen += glyph["advance"]
        scale = font_size / self.profile["unitsPerEm"]
        return {"width": (max(pen, ink_max) - min(0, ink_min)) * scale, "offset": -min(0, ink_min) * scale}

    def fit(self, title, font_size, width):
        metrics = self.measure(title, font_size)
        if metrics["width"] <= width:
            return title, metrics, False
        suffix = "..."
        if self.measure(suffix, font_size)["width"] > width:
            raise DomainError("label_width_limit", "The available label side cannot fit a measured ellipsis; increase the plot width.")
        characters = list(title)
        low, high = 0, len(characters)
        while low < high:
            middle = (low + high + 1) // 2
            if self.measure("".join(characters[:middle]) + suffix, font_size)["width"] <= width:
                low = middle
            else:
                high = middle - 1
        text = "".join(characters[:low]) + suffix
        return text, self.measure(text, font_size), True


def _expire_queries(reference, stopped, interval):
    while not stopped.wait(interval):
        engine = reference()
        if engine is None:
            return
        with engine.mutex:
            engine._expire()
        del engine


class QueryEngine:
    def __init__(self, repository, metrics_path: Path, ttl_seconds: float = 300, max_queries: int = 4,
                 memory_limit_bytes: int = 256 * 1024 * 1024, cleanup_interval_seconds: float = 1):
        self.repository = repository
        self.metrics = FontMetrics(metrics_path)
        self.metrics_path = metrics_path
        self.metric_variants = {(400, "normal"): self.metrics}
        self.ttl_seconds = ttl_seconds
        self.max_queries = max_queries
        self.queries = {}
        self.mutex = threading.RLock()
        self.cursor_secret = secrets.token_bytes(32)
        self.resources = QueryResourceLedger(memory_limit_bytes)
        self.tombstones = OrderedDict()
        self.closed = False
        self._stopped = threading.Event()
        self._maintenance = None
        self.on_release = None
        if cleanup_interval_seconds > 0:
            stopped = self._stopped
            reference = weakref.ref(self, lambda _: stopped.set())
            self._maintenance = threading.Thread(target=_expire_queries, args=(reference, stopped, cleanup_interval_seconds),
                                                 name="timeline-query-expiry", daemon=True)
            self._maintenance.start()

    def _forget(self, query_id, reason=None):
        query = self.queries.pop(query_id, None)
        if query is None:
            return
        if self.on_release is not None:
            self.on_release(query_id, None)
        for layout_id in query["layouts"]:
            self.resources.release(("layout", query_id, layout_id))
        for table_id in query["tables"]:
            self.resources.release(("table", query_id, table_id))
        self.resources.release(("query", query_id))
        if reason is not None:
            owner = query.get("access")
            self.tombstones[query_id] = {"principalId": owner["principalId"] if owner else None,
                                         "reason": reason, "until": time.monotonic() + self.ttl_seconds}
            while len(self.tombstones) > 1024:
                self.tombstones.popitem(last=False)

    def _expire(self):
        now = time.monotonic()
        for key in [key for key, value in self.queries.items() if value["expires"] <= now]:
            self._forget(key, "query_expired")
        for key in [key for key, value in self.tombstones.items() if value["until"] <= now]:
            self.tombstones.pop(key, None)

    def invalidate_principal(self, principal_id, fingerprint=None):
        with self.mutex:
            keys = [key for key, value in self.queries.items() if value.get("access") is not None
                    and value["access"]["principalId"] == principal_id
                    and (fingerprint is None or value["access"]["fingerprint"] != fingerprint)]
            for key in keys:
                self._forget(key, "permission_scope_changed")

    def invalidate_all(self):
        with self.mutex:
            for key in list(self.queries):
                self._forget(key, "permission_scope_changed")

    def resource_stats(self):
        with self.mutex:
            self._expire()
            return self.resources.stats()

    def _query(self, query_id, allow_pending=False):
        if self.closed:
            raise DomainError("query_service_closed", "Query service is closed.", 503)
        query = self.queries.get(query_id)
        access = current_query_access()
        if query is None:
            tombstone = self.tombstones.get(query_id)
            if tombstone is not None and tombstone["until"] > time.monotonic() and tombstone["principalId"] == (access["principalId"] if access else None):
                reason = tombstone["reason"]
                raise DomainError(reason, "Query expired or its authorization changed; prepare a new query.", 410 if reason == "query_expired" else 409)
            raise DomainError("query_not_found", "Query does not exist or has been released.", 404)
        owner = query.get("access")
        if owner is not None:
            if access is None or owner["principalId"] != access["principalId"]:
                raise DomainError("query_not_found", "Query is unavailable.", 404)
            if owner["fingerprint"] != access["fingerprint"]:
                self.invalidate_principal(access["principalId"], access["fingerprint"])
                raise DomainError("permission_scope_changed", "Permissions changed; prepare a new query.", 409)
        if query["expires"] <= time.monotonic():
            self._forget(query_id, "query_expired")
            raise DomainError("query_expired", "Query snapshot expired; create a new query.", 410)
        if not allow_pending and query["manifest"].get("state", "ready") != "ready":
            state = query["manifest"]["state"]
            raise DomainError("query_" + state, "Query is not ready; inspect its preparation status.", 409)
        return query

    def create_query(self, request):
        if not isinstance(request, dict):
            raise DomainError("invalid_query", "Query input must be an object.")
        if len(json_bytes(request)) > 64 * 1024:
            raise DomainError("query_request_limit", "Query preparation requests are limited to 64 KiB.", 413)
        domain = request.get("domain")
        if not isinstance(domain, dict):
            raise DomainError("invalid_query", "Query requires a finite domain.")
        start, end = instant_ms(domain.get("from")), instant_ms(domain.get("to"))
        if start >= end:
            raise DomainError("invalid_query", "Query domain end must follow its start.")
        mode = request.get("scaleMode", "uniform")
        if mode not in ("uniform", "adaptive"):
            raise DomainError("invalid_query", "Unknown scale mode.")
        ratio = number(request.get("ratio", 4), "ratio", 1, 32)
        count = number(request.get("bins", 128), "bins", 16, 256, integer=True)
        with self.mutex:
            if self.closed:
                raise DomainError("query_service_closed", "Query service is closed.", 503)
            self._expire()
            access = current_query_access()
            if access is not None:
                self.invalidate_principal(access["principalId"], access["fingerprint"])
            principal = access["principalId"] if access else None
            owned = sum((value["access"]["principalId"] if value.get("access") else None) == principal for value in self.queries.values())
            if owned >= self.max_queries:
                raise DomainError("query_capacity", "Release an existing query before creating another.", 429)
            bundle = self.repository.query_snapshot()
            resolved = resolve_query_configuration(bundle, request, access)
            search = resolved["search"]
            allowed_sources = set(access["sourceIds"]) if access is not None else None
            records = [record for record in checked(bundle["records"]) if record["deletedAt"] is None
                       and (allowed_sources is None or record["sourceId"] in allowed_sources)
                       and resolved["predicate"](record)]
            records.sort(key=lambda record: record["id"])
            checkpoint()
            if len(records) > 100000 or len(json_bytes(bundle)) > 128 * 1024 * 1024:
                raise DomainError("query_capacity", "Query exceeds the admitted in-memory preparation limit.", 413)
            cached_bounds = {record["id"]: record_bounds(record) for record in checked(records)}
            match_ids = {record["id"] for record in checked(records) if search["matches"](record)}
            query_id, snapshot_id, map_id = getattr(self, "assigned_query_ids", None) or (str(uuid.uuid4()) for _ in range(3))
            density = build_density(records, start, end, count, cached_bounds)
            coverage = bundle["manifest"].get("legacy", {}).get("coverage")
            if coverage is not None:
                density["complete"] = coverage["complete"]
                if not coverage["complete"]:
                    mode = "uniform"
            mapping = build_map(density, copy.deepcopy(domain), mode, ratio, map_id)
            if "fixedScale" in request:
                fixed = fixed_scale_map(copy.deepcopy(domain), request["fixedScale"], map_id, decimal_string)
                if mode == "uniform":
                    mapping = fixed
            overview_records = [record for record in records if bounds_intersect(cached_bounds[record["id"]], start, end)]
            overview_matches = [record for record in overview_records if record["id"] in match_ids]
            selected_sources = request.get("filters", {}).get("sourceIds")
            selected_source = request.get("filters", {}).get("sourceId", "all")

            def selected_zone(zone):
                source = zone.get("legacy", {}).get("sourceId")
                return (not source or ((allowed_sources is None or source in allowed_sources)
                                       and (selected_sources is None or source in selected_sources)
                                       and (selected_source == "all" or source == selected_source)))
            manifest = {"queryId": query_id, "snapshotId": snapshot_id, "mapId": map_id,
                        "generation": bundle["manifest"]["generation"], "revision": bundle["manifest"]["revision"],
                        "baseTotal": len(records), "matchTotal": len(match_ids), "overviewTotal": len(overview_records),
                        "overviewMatchTotal": len(overview_matches), "fieldTypes": resolved["fieldTypes"], "state": "ready"}
            if coverage is not None:
                manifest["coverage"] = copy.deepcopy(coverage)
            query = {"manifest": manifest, "access": copy.deepcopy(access),
                                      "records": records, "matchIds": match_ids, "recordBounds": cached_bounds, "fieldTypes": resolved["fieldTypes"],
                                      "hasSearch": search["active"], "density": density, "map": mapping,
                                      "overviewRecords": overview_matches if search["active"] else overview_records,
                                      "zones": [zone for zone in bundle.get("zones", []) if selected_zone(zone)],
                                      "expires": time.monotonic() + self.ttl_seconds,
                                      "layouts": {}, "tables": OrderedDict()}
            result = copy.deepcopy(manifest)
            # Mutable handle/cache indexes are bounded separately; retained payloads never mutate.
            retained = {key: value for key, value in query.items() if key not in ("layouts", "tables")}
            self.resources.reserve(("query", query_id), retained, overhead=1024)
            self.queries[query_id] = query
            return result

    def density(self, query_id):
        with self.mutex:
            return copy.deepcopy(self._query(query_id)["density"])

    def mapping(self, query_id, map_id):
        with self.mutex:
            result = self._query(query_id)["map"]
            if result["mapId"] != map_id:
                raise DomainError("map_mismatch", "Map belongs to a different query.", 409)
            return copy.deepcopy(result)

    def overview(self, query_id):
        with self.mutex:
            query = self._query(query_id)
            records = query["overviewRecords"]
            aggregate = len(records) > 1000
            if aggregate:
                items = []
                counts = overview_bin_counts(records, query["density"]["bins"], query["recordBounds"])
                for count, bin_item in zip(counts, query["density"]["bins"]):
                    if count:
                        from ..models.domain import iso_from_ms
                        items.append({"id": f'aggregate:{bin_item["from"]}', "kind": "session", "start": iso_from_ms(bin_item["from"]),
                                      "end": iso_from_ms(bin_item["to"]), "color": "#557a88", "title": f"{count} records", "count": count})
            else:
                items = [{"id": record["id"], "kind": record["kind"], "start": record["start"], "end": record["end"],
                          "color": record["render"].get("color", "#39788a"), "title": record["title"],
                          "sourceId": record["sourceId"], "render": copy.deepcopy(record["render"])} for record in records]
            return {"items": items, "total": query["manifest"]["overviewTotal"],
                    "matched": query["manifest"]["overviewMatchTotal"], "matchActive": query["hasSearch"], "aggregated": aggregate,
                    "domain": copy.deepcopy(query["map"]["domain"]),
                    **({"coverage": copy.deepcopy(query["manifest"]["coverage"])} if "coverage" in query["manifest"] else {})}

    def zones(self, query_id):
        with self.mutex:
            query = self._query(query_id)
            domain = query["map"]["domain"]
            start, end = instant_ms(domain["from"]), instant_ms(domain["to"])
            return {"items": copy.deepcopy([zone for zone in query["zones"]
                                             if instant_ms(zone["start"]) < end and instant_ms(zone["end"]) > start])}

    def create_layout(self, query_id, request):
        with self.mutex, localcontext() as context:
            context.prec = 50
            query = self._query(query_id)
            if not isinstance(request, dict):
                raise DomainError("invalid_layout", "Layout input must be an object.")
            if len(json_bytes(request)) > 64 * 1024:
                raise DomainError("query_request_limit", "Layout preparation requests are limited to 64 KiB.", 413)
            if len(query["layouts"]) >= 2:
                raise DomainError("layout_capacity", "Release an existing layout before creating another.", 429)
            if request.get("mapId") != query["map"]["mapId"]:
                raise DomainError("map_mismatch", "Layout map belongs to a different query.", 409)
            width = number(request.get("width"), "width", 64, 8192)
            font_size = number(request.get("fontSize", 13), "fontSize", 10, 32)
            row_height = number(request.get("rowHeight", 32), "rowHeight", max(32, font_size + 19), 192)
            height = number(request.get("availableHeight", 480), "availableHeight", row_height, 8192)
            page_capacity = min(100, math.floor(height / row_height))
            group_by = request.get("groupBy", "none")
            if group_by not in ("none", "sourceId", "kind"):
                raise DomainError("invalid_layout", "Unknown grouping field.")
            if request.get("renderProfileId", "noto-sans-latin-v1") != self.metrics.profile["profileId"]:
                raise DomainError("unsupported_profile", "Render profile is not registered.")
            start = continuous(request.get("viewFromMs"), instant_ms(request.get("from")))
            end = continuous(request.get("viewToMs"), instant_ms(request.get("to")))
            if start >= end:
                raise DomainError("invalid_layout", "Detail end must follow its start.")
            knots = query["map"]["knots"]
            a, b = mapped(knots, start), mapped(knots, end)
            selected = [record for record in checked(query["records"]) if bounds_intersect(query["recordBounds"][record["id"]], start, end)]
            if "presentation" in request or any(set(record["render"]) - {"color"} for record in selected):
                def project(timestamp):
                    clipped = max(knots[0]["timeMs"], min(knots[-1]["timeMs"], timestamp))
                    return float(Decimal(str(width)) * (mapped(knots, clipped) - a) / (b - a))

                resolved = build_styled_layout(selected, request, width, row_height, font_size, group_by,
                                               project, knots[-1]["timeMs"], self._variant_metrics)
                canonical = {record["id"]: record for record in selected}
                for item in resolved["items"]:
                    item["record"] = canonical[item["record"]["id"]]
                return self._store_styled_layout(query, request, resolved, width, height, start, end)
            if row_height > 128:
                raise DomainError("invalid_query", "Legacy row height is limited to 128 pixels.")
            groups = {}
            for record in selected:
                key = record[group_by] if group_by != "none" else ""
                groups.setdefault(key, []).append(record)
            items, rows, row_offset = [], [], 0
            for group_name in sorted(groups):
                if group_by != "none":
                    rows.append({"row": row_offset, "type": "group", "name": group_name})
                    row_offset += 1
                group_items = []
                sorted_records = sorted(groups[group_name], key=lambda record: (
                    instant_ms(record["start"]), instant_ms(record["end"]) if record["end"] is not None else math.inf, record["id"]))
                for record in checked(sorted_records):
                    record_start = instant_ms(record["start"])
                    record_end = instant_ms(record["end"]) if record["end"] is not None else knots[-1]["timeMs"]
                    if record["kind"] == "event":
                        record_end = record_start
                    clipped_start = max(knots[0]["timeMs"], min(knots[-1]["timeMs"], record_start))
                    clipped_end = max(knots[0]["timeMs"], min(knots[-1]["timeMs"], record_end))
                    x_start = float(Decimal(str(width)) * (mapped(knots, clipped_start) - a) / (b - a))
                    x_end = float(Decimal(str(width)) * (mapped(knots, clipped_end) - a) / (b - a))
                    point = record["kind"] == "event" or record_end == record_start
                    if point:
                        full_width = self.metrics.measure(record["title"], font_size)["width"]
                        right_space, left_space = width - 6 - (x_start + 10), x_start - 10 - 6
                        right_side = full_width <= right_space or (full_width > left_space and right_space >= left_space)
                        available = right_space if right_side else left_space
                        title, metric, overflow = self.metrics.fit(record["title"], font_size, available)
                        label_width = metric["width"]
                        label_x = x_start + 10 if right_side else x_start - 10 - label_width
                    else:
                        title, metric, overflow = self.metrics.fit(record["title"], font_size, width - 12)
                        label_width = metric["width"]
                        label_x = max(6, min(width - 6 - label_width, x_start))
                    left = max(0, min(x_start - (6 if point else 2), label_x - 2))
                    right = min(width, max(x_end + (6 if point else 2), label_x + label_width + 2))
                    group_items.append({"record": record, "row": 0, "xStart": x_start, "xEnd": x_end,
                                  "labelX": label_x, "labelWidth": label_width, "labelInkOffset": metric["offset"],
                                  "footprintStart": left, "footprintEnd": right, "match": record["id"] in query["matchIds"],
                                  "displayTitle": title, "overflow": overflow,
                                  "continuesBefore": record_start < start,
                                  "continuesAfter": record["kind"] == "session" and (record["end"] is None or record_end > end)})
                packed = pack_footprints(group_items)
                for item, row in zip(group_items, packed["rows"]):
                    item["row"] = row_offset + row
                items.extend(group_items)
                row_offset += packed["count"]
            layout_id = str(uuid.uuid4())
            manifest = {"layoutId": layout_id, "mapId": query["map"]["mapId"], "totalRows": row_offset,
                        "detailTotal": len(selected), "detailMatchTotal": sum(record["id"] in query["matchIds"] for record in selected),
                        "renderInstanceTotal": len(items), "rowHeight": row_height, "pageCapacity": page_capacity,
                        "from": request["from"], "to": request["to"], "viewFromMs": decimal_string(start),
                        "viewToMs": decimal_string(end), "width": width, "availableHeight": height,
                        "renderProfileId": self.metrics.profile["profileId"]}
            # Reject an over-budget logical page before publishing any part of this layout.
            for page_items in self._page_buckets(items, page_capacity).values():
                if len(page_items) > 1000 or len(json_bytes(page_items)) > 2 * 1024 * 1024 - 16384:
                    raise DomainError("row_payload_limit", "A logical page exceeds this slice's 1000-record/2 MiB limit; narrow the interval or filters.")
            return self._retain_layout(query, {"manifest": manifest, "items": items, "rows": rows})

    def _variant_metrics(self, weight, style):
        weight = int(weight)
        key = (weight, style)
        if key not in self.metric_variants:
            path = self.metrics_path.with_name(f"font-metrics-{weight}-{style}.json")
            if not path.is_file():
                raise DomainError("unsupported_profile", "The requested font variant is not registered.")
            self.metric_variants[key] = FontMetrics(path)
        return self.metric_variants[key]

    def _store_styled_layout(self, query, request, resolved, width, height, start, end):
        row_height = resolved["rowHeight"]
        if height < row_height:
            raise DomainError("row_height_limit", "Available height cannot contain one resolved row.")
        capacity = min(100, math.floor(height / row_height))
        items = resolved["items"]
        for item in items:
            record = item["record"]
            item["match"] = record["id"] in query["matchIds"]
            item["continuesBefore"] = instant_ms(record["start"]) < start
            item["continuesAfter"] = record["kind"] == "session" and (record["end"] is None or instant_ms(record["end"]) > end)
        layout_id = str(uuid.uuid4())
        manifest = {"layoutId": layout_id, "mapId": query["map"]["mapId"], "totalRows": resolved["totalRows"],
                    "detailTotal": len(items), "detailMatchTotal": sum(item["match"] for item in items),
                    "renderInstanceTotal": len(items), "rowHeight": row_height, "pageCapacity": capacity,
                    "from": request["from"], "to": request["to"], "viewFromMs": decimal_string(start),
                    "viewToMs": decimal_string(end), "width": width, "availableHeight": height,
                    "renderProfileId": self.metrics.profile["profileId"], "presentation": resolved["presentation"],
                    "enclosures": resolved["enclosures"]}
        item_pages = self._page_buckets(items, capacity)
        row_pages = self._page_buckets(resolved["rows"], capacity)
        enclosure_pages = {}
        for enclosure in resolved["enclosures"]:
            for index in range(enclosure["startRow"] // capacity, (enclosure["endRow"] - 1) // capacity + 1):
                enclosure_pages.setdefault(index, []).append(enclosure)
        for index in range(math.ceil(resolved["totalRows"] / capacity)):
            offset = index * capacity
            page = {"items": item_pages.get(index, []), "rows": row_pages.get(index, []),
                    "enclosures": self._enclosure_fragments(enclosure_pages.get(index, []), offset, offset + capacity)}
            if len(page["items"]) > 1000 or len(json_bytes(page)) > 2 * 1024 * 1024 - 16384:
                raise DomainError("row_payload_limit", "A styled logical page exceeds the 1000-record/2 MiB limit.")
        if len(json_bytes(manifest)) > 2 * 1024 * 1024:
            raise DomainError("row_payload_limit", "Layout metadata exceeds 2 MiB; narrow the interval or filters.")
        return self._retain_layout(query, {"manifest": manifest, "items": items, "rows": resolved["rows"],
                                          "enclosures": resolved["enclosures"]})

    def _retain_layout(self, query, layout):
        checkpoint()
        if getattr(self, "assigned_layout_id", None):
            layout["manifest"]["layoutId"] = self.assigned_layout_id
        query_id, layout_id = query["manifest"]["queryId"], layout["manifest"]["layoutId"]
        result = copy.deepcopy(layout["manifest"])
        self.resources.reserve(("layout", query_id, layout_id), layout)
        query["layouts"][layout_id] = layout
        return result

    @staticmethod
    def _page_buckets(values, capacity):
        pages = {}
        for value in values:
            pages.setdefault(value["row"] // capacity, []).append(value)
        return pages

    @staticmethod
    def _enclosure_fragments(enclosures, start, end):
        return [{**copy.deepcopy(enclosure), "visibleStartRow": max(start, enclosure["startRow"]),
                 "visibleEndRow": min(end, enclosure["endRow"]), "continuedBefore": enclosure["startRow"] < start,
                 "continuedAfter": enclosure["endRow"] > end}
                for enclosure in enclosures if enclosure["startRow"] < end and enclosure["endRow"] > start]

    def _layout(self, query_id, layout_id, allow_pending=False):
        layout = self._query(query_id)["layouts"].get(layout_id)
        if layout is None:
            raise DomainError("layout_not_found", "Layout does not exist or belongs to a different query.", 404)
        if not allow_pending and layout["manifest"].get("state", "ready") != "ready":
            state = layout["manifest"]["state"]
            raise DomainError("layout_" + state, "Layout is not ready; inspect its preparation status.", 409)
        return layout

    def get_layout(self, query_id, layout_id):
        with self.mutex:
            return copy.deepcopy(self._layout(query_id, layout_id, allow_pending=True)["manifest"])

    def _cursor(self, layout_id, offset):
        payload = f"{layout_id}:{offset}".encode()
        signature = hmac.digest(self.cursor_secret, payload, "sha256")
        return base64.urlsafe_b64encode(payload + b"." + signature).decode().rstrip("=")

    def _offset(self, cursor, layout_id, capacity):
        if not cursor:
            return 0
        if len(cursor) > 256:
            raise DomainError("invalid_cursor", "Invalid row cursor.", 400)
        try:
            raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
            payload, signature = raw[:-33], raw[-32:]
            if raw[-33:-32] != b"." or not hmac.compare_digest(signature, hmac.digest(self.cursor_secret, payload, "sha256")):
                raise ValueError()
            identity, value = payload.decode().rsplit(":", 1)
            offset = int(value)
            if identity != layout_id or offset < 0 or offset % capacity:
                raise ValueError()
            return offset
        except (ValueError, UnicodeError) as error:
            raise DomainError("invalid_cursor", "Cursor belongs to a different layout or has been altered.", 400) from error

    def rows(self, query_id, layout_id, cursor=None):
        with self.mutex:
            layout = self._layout(query_id, layout_id)
            manifest = layout["manifest"]
            capacity, total = manifest["pageCapacity"], manifest["totalRows"]
            start = self._offset(cursor, layout_id, capacity)
            if start >= total and start != 0:
                raise DomainError("invalid_cursor", "Cursor points beyond the last row.", 400)
            end = min(total, start + capacity)
            items = [item for item in layout["items"] if start <= item["row"] < end]
            result = {"layoutId": layout_id, "mapId": manifest["mapId"], "items": copy.deepcopy(items),
                    "rows": copy.deepcopy([row for row in layout["rows"] if start <= row["row"] < end]),
                    "startRow": start, "endRow": end, "totalRows": total, "pageIndex": start // capacity,
                    "pageCount": max(1, math.ceil(total / capacity)),
                    "previousCursor": self._cursor(layout_id, max(0, start - capacity)) if start else None,
                    "nextCursor": self._cursor(layout_id, end) if end < total else None,
                    "pageComplete": True, "loadedCount": len(items)}
            if "enclosures" in layout:
                result["enclosures"] = self._enclosure_fragments(layout["enclosures"], start, end)
            return result

    def placement(self, query_id, layout_id, record_id):
        with self.mutex:
            layout = self._layout(query_id, layout_id)
            item = next((item for item in layout["items"] if item["record"]["id"] == record_id), None)
            if item is None:
                return {"outsideLayout": True, "recordId": record_id}
            capacity = layout["manifest"]["pageCapacity"]
            offset = item["row"] // capacity * capacity
            return {"layoutId": layout_id, "mapId": layout["manifest"]["mapId"], "recordId": record_id,
                    "row": item["row"], "cursor": self._cursor(layout_id, offset), "pageIndex": offset // capacity, "outsideLayout": False}

    def _table_cursor(self, table_id, offset):
        payload = f"table:{table_id}:{offset}".encode("ascii")
        signature = hmac.digest(self.cursor_secret, payload, "sha256")
        return base64.urlsafe_b64encode(payload + b"." + signature).decode("ascii").rstrip("=")

    def _table_offset(self, cursor, table_id):
        if cursor is None:
            return 0
        if len(cursor) > 256 or not re.fullmatch(r"[A-Za-z0-9_-]+", cursor):
            raise DomainError("invalid_table_cursor", "Malformed table cursor.", 400)
        try:
            raw = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
            payload, signature = raw[:-33], raw[-32:]
            if raw[-33:-32] != b"." or not hmac.compare_digest(signature, hmac.digest(self.cursor_secret, payload, "sha256")):
                raise ValueError()
            prefix, identity, index = payload.decode("ascii").split(":")
            if prefix != "table" or identity != table_id or not re.fullmatch(r"0|[1-9][0-9]*", index):
                raise ValueError()
            return int(index)
        except (ValueError, UnicodeError) as error:
            raise DomainError("invalid_table_cursor", "Cursor is altered or belongs to another query, sort, scope or capacity.", 400) from error

    def _table_input(self, query_id, query, request):
        if isinstance(request, dict) and len(json_bytes(request)) > 64 * 1024:
            raise DomainError("query_request_limit", "Table preparation requests are limited to 64 KiB.", 413)
        options, cursor = normalize_table_input(request, query["map"]["domain"], continuous, decimal_string, query.get("fieldTypes"))
        provenance = query["manifest"]
        fingerprint = {"algorithm": "table-records-v1", "queryId": query_id, "snapshotId": provenance["snapshotId"],
                       "generation": provenance["generation"], "revision": provenance["revision"], "options": options}
        return options, cursor, hashlib.sha256(rfc8785.dumps(fingerprint)).hexdigest()

    def has_table(self, query_id, request):
        with self.mutex:
            query = self._query(query_id)
            _, _, table_id = self._table_input(query_id, query, request)
            return table_id in query["tables"]

    def query_records(self, query_id, request):
        with self.mutex:
            query = self._query(query_id)
            options, cursor, table_id = self._table_input(query_id, query, request)
            provenance = query["manifest"]
            offset = self._table_offset(cursor, table_id)
            tables = query["tables"]
            table = tables.get(table_id)
            prepared = table is None
            if table is None:
                table = prepare_table(query, options)
            starts = table["pageStarts"]
            page_index = bisect.bisect_left(starts, offset)
            if page_index >= len(starts) or starts[page_index] != offset:
                raise DomainError("invalid_table_cursor", "Cursor does not identify a complete table page boundary.", 400)
            end = starts[page_index + 1] if page_index + 1 < len(starts) else len(table["records"])
            items = [{"record": copy.deepcopy(record), "match": record["id"] in query["matchIds"]}
                     for record in table["records"][offset:end]]
            result = {"queryId": query_id, "snapshotId": provenance["snapshotId"], "generation": provenance["generation"],
                      "revision": provenance["revision"], "tableId": table_id, **copy.deepcopy(options),
                      "baseTotal": table["baseTotal"], "total": len(table["records"]), "matchTotal": table["matchTotal"],
                      "matchActive": query["hasSearch"], "items": items, "startIndex": offset, "endIndex": end,
                      "pageIndex": page_index, "pageCount": len(starts), "previousCursor": self._table_cursor(table_id, starts[page_index - 1]) if page_index else None,
                      "nextCursor": self._table_cursor(table_id, end) if end < len(table["records"]) else None,
                      "pageComplete": True}
            if len(rfc8785.dumps(result)) > TABLE_RESPONSE_BYTES:
                raise DomainError("table_payload_limit", "Table response exceeds its canonical byte limit.", 413)
            if prepared:
                self.resources.reserve(("table", query_id, table_id), table)
                tables[table_id] = table
                while len(tables) > TABLE_CACHE_LIMIT:
                    removed_id, _ = tables.popitem(last=False)
                    self.resources.release(("table", query_id, removed_id))
            tables.move_to_end(table_id)
            return result

    def release_layout(self, query_id, layout_id):
        with self.mutex:
            self._query(query_id)["layouts"].pop(layout_id, None)
            if self.on_release is not None:
                self.on_release(query_id, layout_id)
            self.resources.release(("layout", query_id, layout_id))

    def release_query(self, query_id):
        with self.mutex:
            if query_id in self.queries:
                self._query(query_id, allow_pending=True)
            self._forget(query_id)

    def release_snapshot(self, snapshot_id):
        with self.mutex:
            query_id = next((key for key, query in self.queries.items() if query["manifest"]["snapshotId"] == snapshot_id), None)
            if query_id is not None:
                self._query(query_id, allow_pending=True)
                self._forget(query_id)

    def get_query(self, query_id):
        with self.mutex:
            return copy.deepcopy(self._query(query_id, allow_pending=True)["manifest"])

    def close(self):
        self._stopped.set()
        with self.mutex:
            self.closed = True
            self.queries.clear()
            self.tombstones.clear()
            self.resources.clear()
        if self._maintenance is not None and self._maintenance is not threading.current_thread():
            self._maintenance.join()
