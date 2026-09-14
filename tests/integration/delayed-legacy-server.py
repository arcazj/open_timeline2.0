"""Isolated browser-test entry point; never used by the production launcher."""
import importlib.util
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server.app.repositories.partitioned_legacy_repository import PartitionedLegacyRepository
from server.app.models.domain import DomainError

gate = Path(sys.argv.pop(1))
original = PartitionedLegacyRepository.open


def delayed(self, *, cancel, progress):
    deadline = time.monotonic() + 60
    progress('reading-legacy', filesRead=0, recordsRead=0)
    while not gate.exists():
        if cancel.wait(.02) or time.monotonic() >= deadline:
            raise DomainError('startup_cancelled', 'Test startup cancelled', 503)
    if gate.read_text() == 'fail':
        raise DomainError('test_failure', 'Controlled startup failure', 503)
    return original(self, cancel=cancel, progress=progress)


PartitionedLegacyRepository.open = delayed
spec = importlib.util.spec_from_file_location('legacy_launcher', ROOT / 'scripts/serve-legacy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.main()
