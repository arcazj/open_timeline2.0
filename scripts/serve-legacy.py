"""Serve read-only, date-partitioned legacy JSON with the current timeline client."""

from __future__ import annotations

import argparse
import os
import secrets
import sys
from pathlib import Path

# Check before dependency imports so an old IDE interpreter gets an actionable error.
if not (3, 12) <= sys.version_info[:2] < (3, 14):
    interpreter = Path(__file__).resolve().parents[1] / ".venv" / (
        "Scripts/python.exe" if os.name == "nt" else "bin/python"
    )
    raise SystemExit(
        "OpenBEXI requires Python >=3.12,<3.14.\n"
        f"Current interpreter: {sys.executable} (Python {'.'.join(map(str, sys.version_info[:3]))}).\n"
        f"Select the existing project interpreter in your IDE: {interpreter}\n"
        "In IntelliJ IDEA, set Run > Edit Configurations > OpenBEXI Local Sources > "
        "Use specified interpreter. Do not use the system Python 3.9 SDK."
    )

import uvicorn  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app.main import create_app  # noqa: E402
from server.app.models.domain import DomainError  # noqa: E402
from server.app.services.launch_configuration import load_launch_configuration  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yaml", type=Path, help="Global server and legacy source YAML profile")
    parser.add_argument("--source-yaml", type=Path)
    parser.add_argument("--legacy-root", type=Path)
    parser.add_argument("--allow-root", action="append")
    parser.add_argument("--path-map", action="append", default=[], metavar="LEGACY=LOCAL")
    parser.add_argument("--model", type=Path)
    parser.add_argument("--namespace-grouping", action="store_true", default=None)
    parser.add_argument("--timezone", default="UTC")
    parser.add_argument("--dialect", choices=("strict", "legacy-json"), default="strict")
    parser.add_argument("--state-root", type=Path, default=Path("var/legacy-server"))
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--local-browser", action="store_true", help="Token-free same-origin browser access; read-only and 127.0.0.1 only")
    args = parser.parse_args()
    if args.yaml:
        conflicting = [value.split("=", 1)[0] for value in sys.argv[1:]
                       if value.startswith("--") and value.split("=", 1)[0] not in ("--yaml", "--host", "--port")]
        if conflicting:
            parser.error("--yaml replaces individual source settings; only --host and --port may override a profile")
        try:
            settings = load_launch_configuration(args.yaml)
        except (ValueError, OSError, DomainError) as error:
            parser.error(f"Cannot load profile {args.yaml}: {error}")
        overrides = {key: getattr(args, key) for key in ("host", "port") if getattr(args, key) is not None}
        vars(args).update(settings | overrides)
    elif not args.source_yaml or not args.legacy_root or not args.allow_root:
        parser.error("Use --yaml PROFILE or provide --source-yaml, --legacy-root and --allow-root")
    args.host = args.host if args.host is not None else "127.0.0.1"
    args.port = args.port if args.port is not None else 8765
    maps = {}
    for value in args.path_map:
        old, separator, new = value.partition("=")
        if not separator or not old or not new or old in maps:
            parser.error("--path-map requires unique LEGACY=LOCAL mappings")
        maps[old] = new
    if args.local_browser and (args.host != "127.0.0.1" or not 1 <= args.port <= 65535):
        parser.error("--local-browser requires --host 127.0.0.1 and a valid explicit port")
    if not args.local_browser and not os.environ.get("OPENBEXI_API_TOKEN"):
        parser.error("Set OPENBEXI_API_TOKEN to a secret of at least 12 characters")
    options = {"yaml": str(args.source_yaml), "legacyRoot": str(args.legacy_root),
               "allowRoots": args.allow_root, "pathMaps": maps, "timezone": args.timezone,
               "dialect": args.dialect, "namespaceGrouping": args.namespace_grouping}
    options.update(lazy=getattr(args, "lazy", True), loading=getattr(args, "loading", {}))
    if getattr(args, "snapshot_file", None):
        options = {"snapshotFile": str(args.snapshot_file), "lazy": False}
    if args.model:
        options["model"] = str(args.model)
    if args.yaml:
        options["sourceDocument"] = args.source_document
        if args.preferences_root is not None:
            options["preferencesRoot"] = str(args.preferences_root)
        print(f"Server configuration: {args.source_yaml}", flush=True)
    local = {"local_browser_origin": f"http://127.0.0.1:{args.port}", "token": secrets.token_urlsafe(32)} if args.local_browser else {}
    background_startup = getattr(args, "background_startup", True)
    app = create_app(data_root=args.state_root, legacy_config=options, background_startup=background_startup, **local)
    client_host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(args.host, args.host)
    if ":" in client_host and not client_host.startswith("["):
        client_host = f"[{client_host}]"
    if args.port:
        availability = "real source; visible-window loading" if options["lazy"] else "page opens while legacy data initializes" if background_startup else "available after server startup"
        print(f"Client URL: http://{client_host}:{args.port}/ ({availability})", flush=True)
    else:
        print("Client URL: use the automatically assigned port in Uvicorn's startup log.", flush=True)
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
