"""Apply the reviewed GitHub controls without writing or logging credentials."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "arcazj/open_timeline2.0"
BASE = f"https://api.github.com/repos/{REPOSITORY}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Refusing to forward GitHub credentials through a redirect")


def credential():
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        return token
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="Never")
    result = subprocess.run(
        ["git", "-c", "credential.interactive=false", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n", cwd=ROOT, env=env,
        capture_output=True, text=True, timeout=20, check=False,
    )
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if result.returncode or not fields.get("password"):
        raise RuntimeError("No noninteractive GitHub credential available; authenticate Git first")
    return fields["password"]


def api(token, method, path, value=None):
    if not path.startswith("/") or ".." in path or "?" in path:
        raise ValueError("Invalid repository API path")
    data = json.dumps(value).encode() if value is not None else None
    request = urllib.request.Request(BASE + path, method=method, data=data, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OpenBEXI-repository-administration",
    })
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            body = response.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"GitHub {method} {path}: HTTP {error.code}") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--security", action="store_true")
    parser.add_argument("--protection", action="store_true")
    parser.add_argument("--pages", action="store_true")
    parser.add_argument("--publication-approved", action="store_true",
                        help="Explicit owner confirmation of project/data/asset redistribution review")
    parser.add_argument("--apply", action="store_true", help="Apply settings; otherwise print intended changes")
    args = parser.parse_args()
    if not any((args.security, args.protection, args.pages)):
        parser.error("Select --security, --protection, or --pages")
    if args.pages and not args.publication_approved:
        parser.error("Pages requires the owner's explicit --publication-approved confirmation")
    policy = json.loads((ROOT / "config/github-protection.json").read_text())
    if not args.apply:
        print(json.dumps({"repository": REPOSITORY, "apply": False,
                          "privateVulnerabilityReporting": args.security,
                          "mainProtection": policy if args.protection else None,
                          "pages": "workflow" if args.pages else None}, indent=2))
        return
    token = credential()
    if args.security:
        api(token, "PUT", "/private-vulnerability-reporting")
        verified = api(token, "GET", "/private-vulnerability-reporting")
        if verified.get("enabled") is not True:
            raise RuntimeError("Private vulnerability reporting could not be verified")
        print("Private vulnerability reporting: enabled and verified")
    if args.protection:
        api(token, "GET", "/branches/main")
        api(token, "PUT", "/branches/main/protection", policy)
        verified = api(token, "GET", "/branches/main/protection")
        checks = verified.get("required_status_checks", {})
        if set(checks.get("contexts", [])) != set(policy["required_status_checks"]["contexts"]) or not checks.get("strict"):
            raise RuntimeError("Required status checks could not be verified")
        for name in ("enforce_admins", "required_linear_history", "required_conversation_resolution"):
            if not verified.get(name, {}).get("enabled"):
                raise RuntimeError(f"Branch policy not active: {name}")
        for name in ("allow_force_pushes", "allow_deletions"):
            if verified.get(name, {}).get("enabled"):
                raise RuntimeError(f"Unsafe branch policy: {name}")
        print("Main branch protection: applied and verified")
    if args.pages:
        try:
            api(token, "GET", "/pages")
        except RuntimeError as error:
            if "HTTP 404" not in str(error):
                raise
            api(token, "POST", "/pages", {"build_type": "workflow"})
        else:
            api(token, "PUT", "/pages", {"build_type": "workflow"})
        verified = api(token, "GET", "/pages")
        if verified.get("build_type") != "workflow":
            raise RuntimeError("Pages workflow publishing could not be verified")
        print("Pages workflow publishing: enabled; deployment still requires a successful workflow")
    token = None


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from None
