from __future__ import annotations

import math
from array import array

from ..models.domain import DomainError
from .preparation_control import checked


def pack_footprints(items, clearance=4, max_index_bytes=128 * 1024 * 1024):
    if isinstance(clearance, bool) or not isinstance(clearance, (int, float)) or not math.isfinite(clearance) or clearance < 0:
        raise ValueError("Invalid packing clearance.")
    for item in checked(items):
        start, end = item["footprintStart"], item["footprintEnd"]
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (start, end)) or end + clearance <= start:
            raise ValueError("Invalid packing footprint.")
    if len(items) < 128:
        tracks, rows = [], []
        for item in checked(items):
            start, end = item["footprintStart"], item["footprintEnd"]
            row = 0
            while row < len(tracks) and any(not (end + clearance <= left or start >= right + clearance) for left, right in tracks[row]):
                row += 1
            if row == len(tracks):
                tracks.append([])
            tracks[row].append((start, end))
            rows.append(row)
        return {"rows": rows, "count": len(tracks)}
    # Expanded half-open intervals encode the existing clearance rule exactly.
    points = sorted({coordinate for item in items for coordinate in (item["footprintStart"], item["footprintEnd"] + clearance)})
    coordinates = {value: index for index, value in enumerate(points)}
    size = len(points) - 1
    capacity = size * 4 + 4
    accounted_bytes = capacity * 24

    def require_capacity():
        if accounted_bytes > max_index_bytes:
            raise DomainError("layout_capacity", "Packing index capacity exceeded; narrow the time range or filters.", 413)

    require_capacity()
    aggregate, own = [0] * capacity, [0] * capacity
    aggregate_bits, own_bits = array("I", [0]) * capacity, array("I", [0]) * capacity

    def mark(values, widths, node, bit, row):
        nonlocal accounted_bytes
        previous, next_width = widths[node], row + 1
        if next_width > previous:
            accounted_bytes += (32 if previous == 0 else 0) + 8 * ((next_width + 63) // 64 - (previous + 63) // 64)
            require_capacity()
            widths[node] = next_width
        values[node] |= bit

    def occupied(node, left, right, start, end):
        if start <= left and right <= end:
            return aggregate[node]
        middle = (left + right) // 2
        result = own[node]
        if start < middle:
            result |= occupied(node * 2, left, middle, start, end)
        if end > middle:
            result |= occupied(node * 2 + 1, middle, right, start, end)
        return result

    def insert(node, left, right, start, end, bit, row):
        mark(aggregate, aggregate_bits, node, bit, row)
        if start <= left and right <= end:
            mark(own, own_bits, node, bit, row)
            return
        middle = (left + right) // 2
        if start < middle:
            insert(node * 2, left, middle, start, end, bit, row)
        if end > middle:
            insert(node * 2 + 1, middle, right, start, end, bit, row)

    rows, count, all_rows = [], 0, 0
    for item in checked(items):
        start, end = coordinates[item["footprintStart"]], coordinates[item["footprintEnd"] + clearance]
        blocked = occupied(1, 0, size, start, end)
        if blocked == all_rows:
            row = count
            count += 1
            bit = 1 << row
            all_rows |= bit
        else:
            bit = (blocked + 1) & ~blocked
            row = bit.bit_length() - 1
        rows.append(row)
        insert(1, 0, size, start, end, bit, row)
    return {"rows": rows, "count": count}
