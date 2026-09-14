"""Deterministic cold-index fixture; visible queries remain unblocked."""
import importlib.util
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server.app.repositories.partitioned_legacy_repository import PartitionedLegacyRepository

gate = Path(sys.argv.pop(1))
original = PartitionedLegacyRepository._reconcile


def delayed(self):
    deadline = time.monotonic() + 90
    while not gate.exists():
        if self._stop.wait(.02) or time.monotonic() >= deadline:
            return
    original(self)


PartitionedLegacyRepository._reconcile = delayed
spec = importlib.util.spec_from_file_location('legacy_launcher', ROOT / 'scripts/serve-legacy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.main()
