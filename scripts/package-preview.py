"""Create a reproducible standalone preview ZIP and SHA-256 release inventory."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def package_preview(root, tag):
    version = json.loads((root / "package.json").read_text())["version"]
    if not re.fullmatch(r"v" + re.escape(version) + r"-preview\.[1-9][0-9]*", tag):
        raise ValueError(f"Tag must be v{version}-preview.N with a positive preview number")
    manifest = json.loads((root / "dist/build-manifest.json").read_text())
    html = (root / "dist/index.html").read_bytes()
    if sha256(html) != manifest["htmlSha256"] or manifest.get("externalRuntimeImports"):
        raise ValueError("Standalone bundle does not match its validated build manifest")
    content = {
        "index.html": html,
        "THIRD-PARTY-NOTICES.json": (root / "dist/THIRD-PARTY-NOTICES.json").read_bytes(),
        "README-OFFLINE.md": (root / "docs/standalone-download.md").read_bytes(),
        "RELEASE-NOTES.md": (root / f"docs/releases/{tag}.md").read_bytes(),
        "DATA-NOTICES.md": (root / "docs/data-licensing.md").read_bytes(),
    }
    if (root / "LICENSE").is_file():
        content["LICENSE"] = (root / "LICENSE").read_bytes()
    output = root / "artifacts/releases" / tag
    if not output.resolve().is_relative_to(root.resolve() / "artifacts/releases"):
        raise ValueError("Release output must stay within artifacts/releases")
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"openbexi-timeline-{tag}-standalone.zip"
    for target in (archive, output / "release-manifest.json", output / "SHA256SUMS"):
        if target.is_symlink():
            raise ValueError("Refusing a symlink release target")
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name, data in sorted(content.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, data, compresslevel=9)
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None or bundle.read("index.html") != html:
            raise ValueError("Preview ZIP failed its content verification")
    def git(*args):
        try:
            result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=False)
        except FileNotFoundError:
            return None
        return result.stdout.strip() if result.returncode == 0 else None
    commit, status = git("rev-parse", "HEAD"), git("status", "--porcelain")
    release = {
        "format": "openbexi-preview-release-v1", "tag": tag, "prerelease": True,
        "releaseApproved": False, "publicationReviewRequired": True,
        "commit": commit, "workingTreeDirty": None if status is None else bool(status),
        "gitMetadataAvailable": commit is not None and status is not None,
        "bundleSha256": sha256(html), "archiveSha256": sha256(archive.read_bytes()),
        "archiveBytes": archive.stat().st_size,
        "files": {name: {"bytes": len(data), "sha256": sha256(data)} for name, data in sorted(content.items())},
        "datasets": manifest.get("testDatasets", []),
    }
    inventory = output / "release-manifest.json"
    inventory.write_text(json.dumps(release, indent=2) + "\n", encoding="utf-8", newline="\n")
    (output / "SHA256SUMS").write_text(
        "".join(f"{sha256(file.read_bytes())}  {file.name}\n" for file in (archive, inventory)),
        encoding="utf-8", newline="\n",
    )
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", default="v0.1.0-preview.1")
    args = parser.parse_args()
    print(package_preview(ROOT, args.tag))


if __name__ == "__main__":
    main()
