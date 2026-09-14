"""Incremental accounting for immutable retained artifact graphs, not process RSS."""
from __future__ import annotations

import itertools
import sys

from ..models.domain import DomainError


def children(value):
    if isinstance(value, dict):
        return itertools.chain(value.keys(), value.values())
    if isinstance(value, (list, tuple, set, frozenset)):
        return iter(value)
    return ()


class _Node:
    __slots__ = ("value", "size", "references", "admission")

    def __init__(self, value, admission):
        self.value = value
        self.size = sys.getsizeof(value)
        self.references = 1
        self.admission = admission


class QueryResourceLedger:
    """Call under the engine mutex; retained roots must never mutate in place."""

    def __init__(self, limit_bytes=256 * 1024 * 1024, scratch_limit_bytes=64 * 1024 * 1024, bookkeeping_limit_bytes=256 * 1024 * 1024):
        self.limit_bytes = limit_bytes
        self.nodes = {}
        self.roots = {}
        self.retained_bytes = 0
        self.peak_bytes = 0
        self.graph_visits = 0
        self.scratch_limit_bytes = scratch_limit_bytes
        self.bookkeeping_limit_bytes = bookkeeping_limit_bytes
        self.peak_scratch_bytes = 0
        self._admission = 0

    def bookkeeping_bytes(self):
        # Conservative CPython storage bound; referenced payload is counted separately.
        return sys.getsizeof(self.nodes) + sys.getsizeof(self.roots) + len(self.nodes) * (sys.getsizeof(_Node(None, 0)) + 4 * sys.getsizeof(0))

    def _check_admission(self, new_ids, increments, stack, active):
        scratch = sys.getsizeof(new_ids) + len(new_ids) * sys.getsizeof(0) + sys.getsizeof(increments) + len(increments) * 2 * sys.getsizeof(0) + len(stack) * 256 + sys.getsizeof(active)
        self.peak_scratch_bytes = max(self.peak_scratch_bytes, scratch)
        if scratch > self.scratch_limit_bytes or self.bookkeeping_bytes() > self.bookkeeping_limit_bytes:
            raise DomainError("query_accounting_capacity", "Query accounting exceeded its bounded admission capacity.", 413)

    def _compact(self):
        if not self.nodes:
            self.nodes.clear()
        elif sys.getsizeof(self.nodes) > max(4096, len(self.nodes) * 160):
            self.nodes = dict(self.nodes)

    def reserve(self, key, root, overhead=0):
        if key in self.roots:
            raise RuntimeError("Artifact is already retained")
        new_ids, increments, active = [], {}, set()
        before = self.retained_bytes
        self.retained_bytes += overhead
        self._admission += 1
        admission = self._admission
        try:
            stack = [(None, iter((root,)))]
            while stack:
                parent, iterator = stack[-1]
                try:
                    value = next(iterator)
                except StopIteration:
                    stack.pop()
                    if parent is not None:
                        active.remove(parent)
                    continue
                identity = id(value)
                self.graph_visits += 1
                if identity in active:
                    raise DomainError("invalid_query_artifact", "Retained query artifacts must be acyclic.", 422)
                node = self.nodes.get(identity)
                if node is not None:
                    node.references += 1
                    if node.admission != admission:
                        increments[identity] = increments.get(identity, 0) + 1
                else:
                    node = _Node(value, admission)
                    self.nodes[identity] = node
                    new_ids.append(identity)
                    self.retained_bytes += node.size
                    if self.retained_bytes > self.limit_bytes:
                        raise DomainError("query_memory_capacity", "Retained query/layout memory capacity is exhausted; release a handle.", 429 if before else 413)
                    if isinstance(value, (dict, list, tuple, set, frozenset)):
                        active.add(identity)
                        stack.append((identity, iter(children(value))))
                if self.graph_visits % 256 == 0:
                    self._check_admission(new_ids, increments, stack, active)
            self._check_admission(new_ids, increments, stack, active)
            if self.retained_bytes > self.limit_bytes:
                raise DomainError("query_memory_capacity", "Retained query/layout memory capacity is exhausted; release a handle.", 429 if before else 413)
        except BaseException:
            for identity, count in increments.items():
                self.nodes[identity].references -= count
            for identity in new_ids:
                del self.nodes[identity]
            self.retained_bytes = before
            self._compact()
            raise
        self.roots[key] = (root, overhead)
        self.peak_bytes = max(self.peak_bytes, self.retained_bytes)

    def release(self, key):
        retained = self.roots.pop(key, None)
        if retained is None:
            return
        root, overhead = retained
        self.retained_bytes -= overhead
        stack = [iter((root,))]
        while stack:
            try:
                value = next(stack[-1])
            except StopIteration:
                stack.pop()
                continue
            identity = id(value)
            node = self.nodes[identity]
            node.references -= 1
            if not node.references:
                self.retained_bytes -= node.size
                del self.nodes[identity]
                stack.append(iter(children(value)))
        self._compact()

    def replace(self, key, root, overhead=0):
        """Keep the old graph intact unless replacement admission succeeds."""
        old_root, old_overhead = self.roots[key]
        temporary = object()
        self.roots[key] = (old_root, 0)
        self.retained_bytes -= old_overhead
        try:
            self.reserve(temporary, root, overhead)
        except BaseException:
            self.roots[key] = (old_root, old_overhead)
            self.retained_bytes += old_overhead
            raise
        self.release(key)
        self.roots[key] = self.roots.pop(temporary)

    def stats(self):
        return {"retainedBytes": self.retained_bytes, "limitBytes": self.limit_bytes, "peakBytes": self.peak_bytes,
                "objects": len(self.nodes), "artifacts": len(self.roots), "graphVisits": self.graph_visits,
                "accountingBookkeepingBytes": self.bookkeeping_bytes(), "accountingBookkeepingLimitBytes": self.bookkeeping_limit_bytes,
                "peakAdmissionScratchBytes": self.peak_scratch_bytes, "admissionScratchLimitBytes": self.scratch_limit_bytes,
                "accounting": "python-owned-graph-v1"}

    def clear(self):
        self.nodes.clear()
        self.roots.clear()
        self.retained_bytes = 0
