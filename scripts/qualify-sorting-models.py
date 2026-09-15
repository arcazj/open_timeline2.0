"""Private-input half of the read-only model/source qualification; emits only safe summaries."""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time
from collections import Counter
from dataclasses import replace
from pathlib import Path

import rfc8785

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app.models.domain import DomainError, instant_ms  # noqa: E402
from server.app.repositories.partitioned_legacy_repository import PartitionedLegacyRepository  # noqa: E402
from server.app.services import legacy_reader  # noqa: E402
from server.app.services.launch_configuration import load_launch_configuration  # noqa: E402
from server.app.services.legacy_presentation import adapt_legacy_presentation  # noqa: E402
from server.app.services.legacy_sources import is_partition_directory, is_partition_file, partition_date, partition_interval  # noqa: E402
from server.app.services.presentation_layout import group_key, group_value  # noqa: E402
from server.app.services.query_configuration import resolve_query_configuration  # noqa: E402
from server.app.services.query_relationships import resolve_relationships  # noqa: E402


def digest(value):
    return hashlib.sha256(value).hexdigest()


def model_report(root, relative):
    raw = legacy_reader.safe_read(root / relative, root, 1024 * 1024)
    try:
        result = adapt_legacy_presentation(json.loads(raw))
        return {'path': relative, 'status': 'adapted-with-explicit-substitutions',
                'canonicalResultSha256': digest(rfc8785.dumps(result)), 'diagnostics': result['diagnostics']}
    except (DomainError, ValueError) as error:
        return {'path': relative, 'status': 'blocked', 'code': getattr(error, 'code', 'invalid_json'), 'message': str(error)}


def representative_domain(repository):
    """Choose nearby existing partition days from every source, without reading records."""
    calendars = []
    inspected = 0
    for source in repository.reader.sources:
        pending, days = [source.root], []
        while pending:
            directory = pending.pop()
            inspected += 1
            if inspected > 10000:
                raise DomainError('qualification_bound', 'Partition metadata inspection exceeded 10000 directories.')
            legacy_reader._path_guard(directory, source.root)
            relative = directory.relative_to(source.root)
            day = partition_date(relative, source.data_model)
            if day:
                with os.scandir(directory) as children:
                    if any(entry.is_file(follow_symlinks=False) and is_partition_file(Path(entry.path).relative_to(source.root), source.data_model) for entry in children):
                        days.append(day)
                continue
            with os.scandir(directory) as children:
                pending.extend(Path(entry.path) for entry in children if entry.is_dir(follow_symlinks=False)
                               and is_partition_directory(Path(entry.path).relative_to(source.root), source.data_model))
        if not days:
            raise DomainError('no_record_partitions', 'A configured source has no available record partitions.')
        calendars.append((source, days))
    anchor = min(max(days) for _, days in calendars)
    intervals = [partition_interval(min(days, key=lambda day: (abs((day - anchor).days), day)),
                                   data_model=source.data_model, timezone=source.timezone or 'UTC')
                 for source, days in calendars]
    low, high = min(item[0] for item in intervals), max(item[1] for item in intervals)
    if (high - low).days > 31:
        raise DomainError('qualification_bound', 'Configured source partitions are more than 31 days apart.')
    return {'from': low.isoformat().replace('+00:00', 'Z'), 'to': high.isoformat().replace('+00:00', 'Z')}, inspected


def source_report(profile, probe='latest-day'):
    config = load_launch_configuration(profile)
    options = {'yaml': str(config['source_yaml']), 'legacyRoot': str(config['legacy_root']),
               'allowRoots': config['allow_root'], 'pathMaps': dict(value.split('=', 1) for value in config['path_map']),
               'timezone': config['timezone'], 'dialect': config['dialect'], 'sourceDocument': config['source_document'],
               'model': str(config['model']), 'lazy': True, 'loading': config['loading'], 'maxSeconds': 30}
    receipts = {}
    original = legacy_reader.safe_read

    def capture(path, root, maximum):
        raw = original(path, root, maximum)
        receipt = receipts.setdefault(Path(path), {'bytes': len(raw), 'beforeSha256': digest(raw),
                                                  'readCount': 0, 'changedDuringRead': False})
        receipt['readCount'] += 1
        receipt['changedDuringRead'] = receipt['changedDuringRead'] or receipt['beforeSha256'] != digest(raw)
        return raw

    result = {'profile': Path(profile).name, 'probe': probe,
              'scope': 'Bounded configured partitions, foreground-only, no archive reconciliation',
              'archiveQualification': 'not-performed', 'readOnly': True}
    legacy_reader.safe_read = capture
    try:
        with tempfile.TemporaryDirectory(prefix='openbexi-model-qualification-') as temporary:
            repository = PartitionedLegacyRepository(options, Path(temporary) / 'state')
            repository.reader.limits = replace(repository.reader.limits, max_seconds=30, max_records=20000, max_scan_bytes=128 * 1024 * 1024)
            # Deliberately suppress the background archive scan; this is a bounded foreground probe.
            repository._index_loop = lambda: None
            try:
                started = time.perf_counter()
                repository.open()
                result['metadataReadyMs'] = round((time.perf_counter() - started) * 1000, 2)
                result['recordFilesReadBeforeMetadataReady'] = len(receipts)
                domain = repository.meta['settings']['range']
                if probe == 'representative-sources':
                    domain, result['partitionDirectoriesInspected'] = representative_domain(repository)
                result['domain'] = domain
                started = time.perf_counter()
                snapshot = repository.capture_query_domain({'domain': domain})
                result['foregroundWindowMs'] = round((time.perf_counter() - started) * 1000, 2)
                result['records'] = len(snapshot['records'])
                result['coverageComplete'] = snapshot['manifest']['legacy']['coverage']['complete']
                result['recordKinds'] = dict(Counter(record['kind'] for record in snapshot['records']))
                result['configuredNamespaces'] = [source.namespace for source in repository.reader.sources]
                result['partitionModels'] = sorted({source.data_model for source in repository.reader.sources})
                namespace_keys = Counter(group_key(group_value(record, '/data/namespace')[0]) for record in snapshot['records'])
                result['logicalNamespaceGroups'] = len(namespace_keys)
                result['allConfiguredSourcesRepresented'] = all(any(record['sourceId'] == source.id for record in snapshot['records']) for source in repository.reader.sources)
                result['namespaceCounts'] = [{'typedIdentitySha256': digest(key.encode()), 'records': count} for key, count in sorted(namespace_keys.items())]
                request = {'definitionVersion': 2, 'domain': domain}
                configuration = resolve_query_configuration(snapshot, request)
                start, end = instant_ms(domain['from']), instant_ms(domain['to'])
                query = resolve_relationships(snapshot['records'], configuration, start, end)
                result['combinedViewUniqueIds'] = len(query['eligibleIds'])
                result['combinedMembershipMatchesWindow'] = len(query['eligibleIds']) == len(snapshot['records'])
                result['timestampValidity'] = all(instant_ms(record['start']) <= instant_ms(record['end']) for record in snapshot['records'] if record['end'] is not None)
                result['sessionsCrossingStart'] = sum(record['kind'] == 'session' and instant_ms(record['start']) < start and (record['end'] is None or instant_ms(record['end']) > start) for record in snapshot['records'])
                descriptor_status = Counter()
                for source in repository.reader.sources:
                    for record in [record for record in snapshot['records'] if record['sourceId'] == source.id][:12]:
                        try:
                            descriptor_status[repository.reader.descriptor(record)['status']] += 1
                        except DomainError as error:
                            descriptor_status['error:' + error.code] += 1
                result['descriptorSampleStatus'] = dict(descriptor_status)
                result['descriptorSampleLimitPerSource'] = 12
                result['status'] = 'bounded-window-verified' if snapshot['records'] else 'empty-window-not-qualified'
            finally:
                repository.close()
    except (DomainError, ValueError, OSError) as error:
        result.update(status='blocked', code=getattr(error, 'code', type(error).__name__))
    finally:
        legacy_reader.safe_read = original
    verified = []
    for path, receipt in receipts.items():
        after = original(path, next(Path(root) for root in config['allow_root'] if path.is_relative_to(Path(root))), 32 * 1024 * 1024)
        verified.append({**receipt, 'sourcePathSha256': digest(str(path).encode()), 'afterSha256': digest(after),
                         'unchanged': not receipt['changedDuringRead'] and receipt['beforeSha256'] == digest(after)})
    result['readReceipts'] = sorted(verified, key=lambda item: item['sourcePathSha256'])
    result['allReadFilesUnchanged'] = all(item['unchanged'] for item in verified)
    return result


def main():
    request = json.load(sys.stdin)
    root = Path(request['legacyRoot']).absolute()
    models = [model_report(root, path) for path in request['models']]
    sources = [source_report(path) for path in request.get('profiles', [])]
    sources.extend(source_report(path, 'representative-sources') for path in request.get('profiles', [])
                   if Path(path).name == 'multiple_sources_test.yml')
    print(json.dumps({'models': models, 'sources': sources, 'pythonVersion': sys.version.split()[0]}, ensure_ascii=True))


if __name__ == '__main__':
    main()
