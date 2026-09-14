import hashlib
import importlib.util
import json
import zipfile
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def fixture(root):
    (root / "dist").mkdir()
    (root / "docs/releases").mkdir(parents=True)
    (root / "package.json").write_text('{"version":"0.1.0"}')
    html = b'<!doctype html><title>Fixture</title>'
    (root / "dist/index.html").write_bytes(html)
    (root / "dist/build-manifest.json").write_text(json.dumps({
        "htmlSha256": hashlib.sha256(html).hexdigest(), "externalRuntimeImports": [],
    }))
    (root / "dist/THIRD-PARTY-NOTICES.json").write_text('{}')
    for name in ("standalone-download.md", "data-licensing.md", "releases/v0.1.0-preview.1.md"):
        (root / "docs" / name).write_text('# Fixture\n')


def test_preview_archive_is_reproducible_complete_and_checksummed(tmp_path):
    fixture(tmp_path)
    build = module("package-preview")
    archive = build.package_preview(tmp_path, "v0.1.0-preview.1")
    original = archive.read_bytes()
    build.package_preview(tmp_path, "v0.1.0-preview.1")
    assert archive.read_bytes() == original
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None
        assert set(bundle.namelist()) == {"index.html", "THIRD-PARTY-NOTICES.json", "README-OFFLINE.md", "RELEASE-NOTES.md", "DATA-NOTICES.md"}
        assert bundle.read("index.html") == (tmp_path / "dist/index.html").read_bytes()
    for line in (archive.parent / "SHA256SUMS").read_text().splitlines():
        checksum, name = line.split("  ")
        assert hashlib.sha256((archive.parent / name).read_bytes()).hexdigest() == checksum


@pytest.mark.parametrize("tag", ["v0.1.0", "v0.2.0-preview.1", "../private", "v0.1.0-preview.0", "v0.1.0-preview.1/extra"])
def test_packager_refuses_stable_mismatched_and_unsafe_tags(tmp_path, tag):
    fixture(tmp_path)
    with pytest.raises(ValueError):
        module("package-preview").package_preview(tmp_path, tag)
    assert not (tmp_path / "artifacts").exists()


def test_packager_rejects_stale_or_external_bundles(tmp_path):
    fixture(tmp_path)
    (tmp_path / "dist/index.html").write_text('modified')
    with pytest.raises(ValueError, match="manifest"):
        module("package-preview").package_preview(tmp_path, "v0.1.0-preview.1")


def test_packager_marks_git_metadata_unknown_when_git_is_unavailable(tmp_path, monkeypatch):
    fixture(tmp_path)
    build = module("package-preview")
    def missing_git(*args, **kwargs):
        raise FileNotFoundError("Git unavailable")
    monkeypatch.setattr(build.subprocess, "run", missing_git)
    archive = build.package_preview(tmp_path, "v0.1.0-preview.1")
    manifest = json.loads((archive.parent / "release-manifest.json").read_text())
    assert manifest["commit"] is None
    assert manifest["workingTreeDirty"] is None
    assert manifest["gitMetadataAvailable"] is False


def test_workflow_gates_and_branch_policy_stay_aligned():
    def load(file):
        return yaml.safe_load((ROOT / file).read_text())
    verification = load('.github/workflows/verify.yml')
    demo = load('.github/workflows/demo.yml')
    policy = json.loads((ROOT / 'config/github-protection.json').read_text())
    assert set(policy['required_status_checks']['contexts']) == {
        verification['jobs']['candidate-checks']['name'], demo['jobs']['demo-checks']['name'],
    }
    assert policy['enforce_admins'] and policy['required_status_checks']['strict']
    assert policy['allow_force_pushes'] is False and policy['allow_deletions'] is False
    assert verification['jobs']['candidate-checks']['if'] == 'always()'
    assert 'PUBLIC_DEMO_APPROVED' in demo['jobs']['deploy']['if']
    release = load('.github/workflows/preview-release.yml')
    assert 'PUBLIC_RELEASE_APPROVED' in release['jobs']['verify']['if']
    assert release['jobs']['publish']['needs'] == 'verify'
    command = release['jobs']['publish']['steps'][-1]['run']
    assert '--prerelease' in command and '--latest=false' in command and '--verify-tag' in command


def test_github_private_reporting_is_read_back_without_exposing_credentials(monkeypatch, capsys):
    admin = module('configure-github')
    calls = []
    monkeypatch.setattr(admin, 'credential', lambda: 'synthetic-test')
    def api(token, method, path, value=None):
        calls.append((method, path))
        return {'enabled': True}
    monkeypatch.setattr(admin, 'api', api)
    monkeypatch.setattr('sys.argv', ['configure-github.py', '--security', '--apply'])
    admin.main()
    assert calls == [('PUT', '/private-vulnerability-reporting'), ('GET', '/private-vulnerability-reporting')]
    assert 'synthetic-test' not in capsys.readouterr().out


def test_pages_requires_explicit_publication_review_before_authentication(monkeypatch):
    admin = module('configure-github')
    monkeypatch.setattr('sys.argv', ['configure-github.py', '--pages', '--apply'])
    monkeypatch.setattr(admin, 'credential', lambda: pytest.fail('Authentication must not run'))
    with pytest.raises(SystemExit) as error:
        admin.main()
    assert error.value.code == 2
