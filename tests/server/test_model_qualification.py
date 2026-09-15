import hashlib
import importlib.util
from types import SimpleNamespace

import pytest

from conftest import ROOT
from server.app.models.domain import DomainError


SPEC = importlib.util.spec_from_file_location('model_qualification', ROOT / 'scripts/qualify-sorting-models.py')
qualification = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qualification)


def source(root):
    return SimpleNamespace(root=root, data_model='yyyy/mm/dd', timezone='UTC')


def partition(root, day, records=True):
    directory = root / day
    directory.mkdir(parents=True)
    target = directory / 'events.json' if records else directory / 'descriptors' / 'descriptor.json'
    target.parent.mkdir(exist_ok=True)
    target.write_text('{}', encoding='utf-8')
    return target


def test_representative_probe_uses_actual_record_partitions_not_descriptor_only_days(tmp_path):
    roots = [tmp_path / 'first', tmp_path / 'second']
    files = [partition(roots[0], '2024/03/23', False), partition(roots[0], '2024/03/24'),
             partition(roots[1], '2024/03/18'), partition(roots[0], '2026/09/13')]
    before = [hashlib.sha256(path.read_bytes()).hexdigest() for path in files]
    repository = SimpleNamespace(reader=SimpleNamespace(sources=[source(root) for root in roots]))
    domain, inspected = qualification.representative_domain(repository)
    assert domain == {'from': '2024-03-18T00:00:00Z', 'to': '2024-03-25T00:00:00Z'}
    assert 0 < inspected < 20
    assert before == [hashlib.sha256(path.read_bytes()).hexdigest() for path in files]


@pytest.mark.parametrize('day,records,code', [('2026/09/13', True, 'qualification_bound'),
                                           ('2024/03/18', False, 'no_record_partitions')])
def test_representative_probe_reports_unavailable_or_unbounded_sources(tmp_path, day, records, code):
    roots = [tmp_path / 'first', tmp_path / 'second']
    partition(roots[0], '2024/03/24')
    partition(roots[1], day, records)
    repository = SimpleNamespace(reader=SimpleNamespace(sources=[source(root) for root in roots]))
    with pytest.raises(DomainError) as error:
        qualification.representative_domain(repository)
    assert error.value.code == code
