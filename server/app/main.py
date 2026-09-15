from __future__ import annotations

import os
import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException
import rfc8785

from .models.domain import DomainError, parse_json, read_json
from .models.model_catalog import definition_errors
from .services.query import QueryEngine
from .services.query_preparation import QueryPreparationCoordinator
from .services.identity import IdentityStore
from .services.workspace_access import WorkspaceAccess
from .api.identity import identity_router
from .api.configuration import configuration_router
from .api.openapi import build_contract
from .services.configuration import ConfigurationService
from .services.audit import AuditService
from .services.changes import ChangeService
from .api.changes import changes_router
from .repositories.json_repository import JsonRepository
from .repositories.legacy_repository import LegacyRepository
from .repositories.snapshot_file_repository import SnapshotFileRepository
from .repositories.partitioned_legacy_repository import PartitionedLegacyRepository
from .services.legacy_configuration import LegacyConfigurationService
from .repositories.legacy_preferences import LegacyPreferencesRepository
from .services.legacy_preferences import LegacyPreferencesConfigurationService
from .services.identity import authorize
from .services.local_browser import local_browser_key, require_local_browser, source_catalog, validate_local_origin
from .services.startup import StartupStatus

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CLIENT_HTML = PROJECT_ROOT / "dist" / "index.html"
BASE = "/api/v1/workspaces/default"


def create_app(data_root=None, token=None, seed_path=None, metrics_path=None, legacy_config=None, local_browser_origin=None, background_startup=False):
    if local_browser_origin:
        validate_local_origin(local_browser_origin, legacy_config)
    configured_token = token if token is not None else os.environ.get("OPENBEXI_API_TOKEN")
    if not configured_token or len(configured_token) < 12:
        raise RuntimeError("Set OPENBEXI_API_TOKEN to a secret of at least 12 characters before starting the server.")
    root = Path(data_root or os.environ.get("OPENBEXI_DATA_ROOT", PROJECT_ROOT / "var" / "timeline"))
    seed = Path(seed_path or PROJECT_ROOT / "data" / "default-dataset.json")
    metrics = Path(metrics_path or PROJECT_ROOT / "shared" / "fixtures" / "font-metrics.json")

    @asynccontextmanager
    async def lifespan(app):
        repository = identities = preferences = None
        startup = app.state.startup = StartupStatus()

        def bootstrap():
            nonlocal repository, identities, preferences
            try:
                legacy_type = SnapshotFileRepository if legacy_config and legacy_config.get("snapshotFile") else PartitionedLegacyRepository if legacy_config and legacy_config.get("lazy", False) else LegacyRepository
                repository = legacy_type(legacy_config, root) if legacy_config else JsonRepository(root, seed)
                app.state.repository = repository
                startup.update("reading-legacy" if legacy_config else "recovering-storage")
                if legacy_config:
                    repository.open(cancel=startup.cancel, progress=startup.update)
                else:
                    repository.open()
                startup.update("recovering-identity")
                app.state.local_browser_secret = local_browser_key(root, configured_token) if local_browser_origin else None
                identities = IdentityStore(root / "control", app.state.local_browser_secret or configured_token)
                identities.open()
                startup.update("loading-services")
                if legacy_config and legacy_config.get("preferencesRoot"):
                    preferences = LegacyPreferencesRepository(repository, legacy_config["preferencesRoot"])
                app.state.preferences = preferences
                app.state.repository = repository
                app.state.identities = identities
                app.state.queries = QueryEngine(repository, metrics)
                app.state.access = WorkspaceAccess(identities, repository, app.state.queries)
                app.state.preparations = QueryPreparationCoordinator(app.state.queries, app.state.access, preferences=preferences)
                service = LegacyPreferencesConfigurationService if preferences else LegacyConfigurationService if legacy_config else ConfigurationService
                app.state.configuration = service(identities, preferences or repository)
                app.state.audit = AuditService(identities, repository)
                app.state.changes = ChangeService(identities, repository)
                startup.complete()
            except Exception:
                startup.fail()
                if not startup.cancel.is_set():
                    logging.getLogger("uvicorn.error").exception("Timeline data startup failed; data APIs remain unavailable.")
                raise

        loader = asyncio.get_running_loop().run_in_executor(None, bootstrap)
        try:
            if not background_startup:
                await asyncio.shield(loader)
            yield
        finally:
            startup.cancel.set()
            # Never dispose storage while its loader thread can still publish.
            try:
                await asyncio.shield(loader)
            except Exception:
                pass
            if hasattr(app.state, "preparations"):
                await run_in_threadpool(app.state.preparations.close)
            if hasattr(app.state, "changes"):
                app.state.changes.close()
            if hasattr(app.state, "access"):
                app.state.access.close()
            if hasattr(app.state, "queries"):
                app.state.queries.close()
            if identities:
                identities.close()
            if preferences:
                preferences.close()
            if repository:
                repository.close()

    app = FastAPI(title="OpenBEXI Timeline JSON API", version="0.1.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.startup = StartupStatus()
    cors_origins = [origin.strip() for origin in os.environ.get("OPENBEXI_CORS_ORIGINS", "").split(",") if origin.strip()]
    if local_browser_origin and cors_origins:
        raise RuntimeError("Local browser mode does not permit cross-origin access.")
    if "*" in cors_origins:
        raise RuntimeError("CORS requires explicit origins; wildcard access is not supported.")
    if cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=cors_origins, allow_credentials=False,
                           allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                           allow_headers=["Authorization", "Content-Type", "X-Workspace-Generation", "X-Identity-Generation", "Idempotency-Key", "If-Match", "Accept", "Prefer"],
                           expose_headers=["ETag", "Location", "X-Request-Id", "Retry-After", "Preference-Applied"], max_age=600)

    @app.exception_handler(DomainError)
    async def domain_error(request, error):
        headers = {"Cache-Control": "no-store"}
        if error.status == 401:
            headers["WWW-Authenticate"] = "Bearer"
        if error.status in (429, 503):
            headers["Retry-After"] = "2"
        return JSONResponse({"type": "about:blank", "code": error.code, "message": error.message,
                             "title": error.code.replace("_", " ").capitalize(), "detail": error.message,
                             "instance": request.url.path, "requestId": getattr(request.state, "request_id", None),
                             **({"errors": error.errors} if hasattr(error, "errors") else {}),
                             **({'diagnostic': error.diagnostic} if hasattr(error, 'diagnostic') else {}),
                             "status": error.status}, status_code=error.status,
                            media_type="application/problem+json", headers=headers)

    @app.exception_handler(RequestValidationError)
    async def request_validation(request, error):
        problem = DomainError("invalid_request", "Request parameters do not match the API contract.")
        problem.errors = [{"path": "/" + "/".join(str(part) for part in item["loc"]),
                           "code": item["type"], "message": "Invalid request parameter."} for item in error.errors()]
        return await domain_error(request, problem)

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        return await domain_error(request, DomainError("not_found" if error.status_code == 404 else "http_error",
                                                       "The requested route or method is unavailable.", error.status_code))

    @app.middleware("http")
    async def security_headers(request, call_next):
        request.state.request_id = str(uuid.uuid4())
        if (not app.state.startup.ready and request.url.path.startswith("/api/")
                and request.url.path not in ("/api/v1/health", "/api/v1/capabilities", "/api/v1/bootstrap")):
            failed = app.state.startup.snapshot()["status"] == "failed"
            response = await domain_error(request, DomainError("startup_failed" if failed else "server_starting",
                "Server data initialization failed; inspect the server log and restart." if failed else "Server data is initializing; retry shortly.", 503))
        else:
            response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    async def authenticated(request: Request):
        authorization = request.headers.get("authorization", "")
        if local_browser_origin and request.headers.get("x-openbexi-local"):
            require_local_browser(request, local_browser_origin)
            authorization = "Bearer " + app.state.local_browser_secret
        if not authorization.startswith("Bearer "):
            raise DomainError("unauthorized", "A valid bearer token is required.", 401)
        identity = await run_in_threadpool(app.state.identities.authenticate, authorization[7:])
        request.state.identity = identity
        return identity

    if local_browser_origin:
        @app.get("/api/v1/bootstrap", include_in_schema=False)
        async def bootstrap_info(request: Request):
            require_local_browser(request, local_browser_origin)
            repository = getattr(app.state, "repository", None)
            document = legacy_config.get("sourceDocument", {})
            names = [source.get("namespace", "") for source in document.get("data_sources", []) if source.get("enable")]
            result = {"mode": "configured-server", "localBrowser": True,
                      "sourceName": " + ".join(names) or "Configured legacy JSON sources",
                      "status": app.state.startup.snapshot()["status"]}
            if repository:
                result["sourceName"] = " + ".join(source.namespace or source.id for source in repository.configuration.sources)
                if repository.meta.get("settings", {}).get("range"):
                    result["range"] = repository.meta["settings"]["range"]
            return result

        @app.get("/api/v1/local-sources", include_in_schema=False)
        async def local_sources(request: Request):
            require_local_browser(request, local_browser_origin)
            return source_catalog(app.state.repository)

    async def body(request: Request, empty=False, patch=False, maximum=1024 * 1024):
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip()
        expected_type = "application/json-patch+json" if patch else "application/json"
        if content_type != expected_type and not empty:
            raise DomainError("unsupported_media_type", f"Use {expected_type}.", 415)
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > maximum:
                raise DomainError("request_too_large", f"Request body exceeds {maximum} bytes.", 413)
        if empty and not data:
            return {}
        result = parse_json(data)
        if not isinstance(result, list if patch else dict):
            raise DomainError("invalid_request", "Request body must be a JSON Patch array." if patch else "Request body must be a JSON object.", 400)
        return result

    def item_response(record, repository):
        return JSONResponse(record, headers={"ETag": f'"{repository.meta["manifest"]["generation"]}:{record["version"]}"'})

    app.include_router(identity_router(authenticated, body))
    app.include_router(configuration_router(authenticated, body))
    app.include_router(changes_router(authenticated))

    def workspace_metadata(identity):
        with app.state.identities.mutex, app.state.repository.mutex:
            result = app.state.access.metadata(identity)
            effective = app.state.configuration.get_effective(identity)
            result.update(settings=effective["values"], preferenceRevision=effective["preferenceRevision"],
                          defaultsRevision=effective["defaultsRevision"])
            result["capabilities"]["configurationManagement"] = not bool(legacy_config) or app.state.preferences is not None
            if app.state.preferences:
                result["legacy"].update(preferencesEnabled=True, preferencesSource="application-json",
                                        preferencesRevision=app.state.preferences.revision)
                result["preferencesRevision"] = app.state.preferences.revision
            result['capabilities']['query'] = read_json(Path(__file__).resolve().parents[2] / 'shared/query-capabilities.json')
            return result

    async def query_call(request, operation, *args):
        prefer_async = any(value.split(";", 1)[0].strip().lower() == "respond-async"
                           for value in request.headers.get("prefer", "").split(","))
        return await run_in_threadpool(app.state.preparations.dispatch, request.state.identity, operation,
                                      *args, prefer_async=prefer_async)

    def preparation_response(result):
        if result.get("state") != "preparing":
            return result
        location = BASE + "/query-sessions/" + result["queryId"]
        if "layoutId" in result:
            location += "/layouts/" + result["layoutId"]
        return JSONResponse(result, status_code=202, headers={"Location": location, "Retry-After": "1",
                                                            "Preference-Applied": "respond-async"})

    @app.get("/api/v1/health")
    async def health():
        if not app.state.startup.ready:
            return JSONResponse({**app.state.startup.snapshot(), "storage": "json-files"}, status_code=503,
                                headers={"Cache-Control": "no-store", "Retry-After": "1"})
        ready = (hasattr(app.state, "repository") and app.state.repository.available
                 and hasattr(app.state, "identities") and app.state.identities.available)
        return JSONResponse({"status": "ok" if ready else "unavailable", "storage": "json-files"}, status_code=200 if ready else 503)

    @app.get("/health/live")
    async def liveness():
        return JSONResponse({"status": "live"}, headers={"Cache-Control": "no-store"})

    @app.get("/health/ready")
    async def readiness():
        if not app.state.startup.ready:
            return JSONResponse({**app.state.startup.snapshot(), "storage": "json-files"}, status_code=503,
                                headers={"Cache-Control": "no-store", "Retry-After": "1"})
        try:
            if not hasattr(app.state, "identities") or not hasattr(app.state, "repository"):
                raise DomainError("not_ready", "Recovery has not completed.", 503)
            await run_in_threadpool(app.state.identities.check_integrity)
            await run_in_threadpool(app.state.repository._ensure_available)
            return JSONResponse({"status": "ready", "storage": "json-files"}, headers={"Cache-Control": "no-store"})
        except DomainError:
            return JSONResponse({"status": "unavailable", "storage": "json-files"}, status_code=503,
                                headers={"Cache-Control": "no-store", "Retry-After": "2"})

    @app.get("/api/v1/capabilities")
    async def capabilities():
        repository = getattr(app.state, "repository", None)
        ready = bool(app.state.startup.ready and repository and repository.available and app.state.identities.available)
        return {"apiVersion": "v1", "contractVersion": "3.1.1", "storage": "json-files", "transactionVersion": 2,
                "storageLayout": repository.layout["formatVersion"] if repository and repository.layout else 1,
                "modes": ["server", "standalone"], "state": "ready" if ready else "recovery-required",
                "readOnly": bool(legacy_config) or not ready, "limits": {"requestBytes": 1048576, "batchRequestBytes": 8388608,
                "batchRecords": 500, "journalBytes": 33554432, "patchOperations": 100,
                "queryHandles": app.state.queries.max_queries if hasattr(app.state, "queries") else 4}}

    @app.get(BASE, dependencies=[Depends(authenticated)])
    async def initialize(request: Request):
        return await run_in_threadpool(workspace_metadata, request.state.identity)

    @app.get(BASE + "/status", dependencies=[Depends(authenticated)])
    async def status(request: Request):
        return await run_in_threadpool(workspace_metadata, request.state.identity)

    @app.get(BASE + "/legacy/loading", dependencies=[Depends(authenticated)], include_in_schema=False)
    async def loading_status(request: Request):
        if not getattr(app.state.repository, "lazy", False):
            raise DomainError("not_found", "On-demand loading is not enabled.", 404)
        with app.state.identities.mutex:
            scope = app.state.access._scope(app.state.access._current(request.state.identity, "records.read"))
        return await run_in_threadpool(app.state.repository.loading_status, scope["sourceIds"])

    @app.post(BASE + "/legacy/prefetch", dependencies=[Depends(authenticated)], include_in_schema=False)
    async def prefetch_legacy(request: Request):
        if not getattr(app.state.repository, "lazy", False):
            raise DomainError("not_found", "On-demand loading is not enabled.", 404)
        payload = await body(request, maximum=64 * 1024)
        def prepare():
            with app.state.identities.mutex:
                scope = app.state.access._scope(app.state.access._current(request.state.identity, "records.read"))
            from .services.query_access import query_access
            with query_access(scope):
                return app.state.repository.prefetch(payload)
        return await run_in_threadpool(prepare)

    @app.post(BASE + "/legacy/reload", dependencies=[Depends(authenticated)])
    async def reload_legacy(request: Request):
        if not legacy_config:
            raise DomainError("not_found", "No linked legacy source is configured.", 404)
        with app.state.identities.mutex:
            identity = app.state.access._current(request.state.identity, "workspace.manage")
            authorize(identity, "workspace.manage", "default")
        await run_in_threadpool(app.state.repository.reload)
        return await run_in_threadpool(workspace_metadata, request.state.identity)

    @app.get(BASE + "/records/{record_id}/legacy-descriptor", dependencies=[Depends(authenticated)])
    async def legacy_descriptor(record_id: str, request: Request):
        if not legacy_config:
            raise DomainError("not_found", "No linked legacy source is configured.", 404)
        record = await run_in_threadpool(app.state.access.read, request.state.identity, "get_record", record_id)
        if app.state.repository.reader is None:
            raise DomainError("descriptor_unavailable", "This JSON snapshot has no external descriptor source.", 404)
        result = await run_in_threadpool(app.state.repository.reader.descriptor, record)
        # Descriptor reads must not outlive revocation of the selected source grant.
        await run_in_threadpool(app.state.access.read, request.state.identity, "get_record", record_id)
        return result

    @app.post(BASE + "/records/query", dependencies=[Depends(authenticated)])
    @app.post(BASE + "/query-sessions", dependencies=[Depends(authenticated)])
    async def query_create(request: Request):
        return preparation_response(await query_call(request, "create_query", await body(request, maximum=64 * 1024)))

    query_base = BASE + "/query-sessions/{query_id}"

    @app.get(query_base, dependencies=[Depends(authenticated)])
    async def get_query(query_id: str, request: Request):
        return preparation_response(await query_call(request, "get_query", query_id))

    @app.get(query_base + "/density", dependencies=[Depends(authenticated)])
    async def density(query_id: str, request: Request):
        return await query_call(request, "density", query_id)

    @app.get(query_base + "/maps/{map_id}", dependencies=[Depends(authenticated)])
    async def mapping(query_id: str, map_id: str, request: Request):
        return await query_call(request, "mapping", query_id, map_id)

    @app.get(query_base + "/overview", dependencies=[Depends(authenticated)])
    async def overview(query_id: str, request: Request):
        return await query_call(request, "overview", query_id)

    @app.get(query_base + "/zones", dependencies=[Depends(authenticated)])
    async def zones(query_id: str, request: Request):
        return await query_call(request, "zones", query_id)

    @app.post(query_base + "/records/query", dependencies=[Depends(authenticated)])
    async def query_records(query_id: str, request: Request):
        result = await query_call(request, "query_records", query_id, await body(request, maximum=64 * 1024))
        return Response(content=rfc8785.dumps(result), media_type="application/json")

    @app.get(query_base + "/records/{record_id}", dependencies=[Depends(authenticated)])
    async def query_record(query_id: str, record_id: str, request: Request):
        return await query_call(request, 'query_record', query_id, record_id)

    @app.post(query_base + '/find', dependencies=[Depends(authenticated)])
    async def find_match(query_id: str, request: Request):
        return await query_call(request, 'find_match', query_id, await body(request, maximum=1024))

    @app.post(query_base + '/legacy-filter-migration', dependencies=[Depends(authenticated)])
    async def migrate_legacy_filter(query_id: str, request: Request):
        return await query_call(request, 'migrate_legacy_filter', query_id, await body(request, maximum=16384))

    @app.post(query_base + "/layouts", dependencies=[Depends(authenticated)])
    async def layout_create(query_id: str, request: Request):
        return preparation_response(await query_call(request, "create_layout", query_id, await body(request, maximum=64 * 1024)))

    @app.get(query_base + "/layouts/{layout_id}", dependencies=[Depends(authenticated)])
    async def get_layout(query_id: str, layout_id: str, request: Request):
        return preparation_response(await query_call(request, "get_layout", query_id, layout_id))

    @app.get(query_base + "/layouts/{layout_id}/rows", dependencies=[Depends(authenticated)])
    async def rows(query_id: str, layout_id: str, request: Request, cursor: str | None = None, pageIndex: str | None = None):
        if pageIndex is not None:
            if cursor is not None:
                raise DomainError("invalid_pagination", "Specify either cursor or pageIndex, not both.", 422)
            if len(pageIndex) > 16 or not pageIndex.isascii() or not pageIndex.isdecimal() or int(pageIndex) > 9007199254740991:
                raise DomainError("invalid_page_index", "pageIndex must be a nonnegative safe integer.", 422)
        return await query_call(request, "rows", query_id, layout_id, cursor, int(pageIndex) if pageIndex is not None else None)

    @app.get(query_base + "/layouts/{layout_id}/placement/{record_id}", dependencies=[Depends(authenticated)])
    async def placement(query_id: str, layout_id: str, record_id: str, request: Request):
        return await query_call(request, "placement", query_id, layout_id, record_id)

    @app.delete(query_base + "/layouts/{layout_id}", dependencies=[Depends(authenticated)], status_code=204)
    async def release_layout(query_id: str, layout_id: str, request: Request):
        await query_call(request, "release_layout", query_id, layout_id)
        return Response(status_code=204)

    @app.delete(query_base, dependencies=[Depends(authenticated)], status_code=204)
    async def release_query(query_id: str, request: Request):
        await query_call(request, "release_query", query_id)
        return Response(status_code=204)

    @app.delete(BASE + "/query-snapshots/{snapshot_id}", dependencies=[Depends(authenticated)], status_code=204)
    async def release_snapshot(snapshot_id: str, request: Request):
        await query_call(request, "release_snapshot", snapshot_id)
        return Response(status_code=204)

    @app.get(BASE + "/records", dependencies=[Depends(authenticated)])
    async def list_records(request: Request, limit: int = 100, offset: int = 0):
        if not 1 <= limit <= 1000 or offset < 0:
            raise DomainError("invalid_page", "Record list limit must be 1-1000 and offset nonnegative.")
        return await run_in_threadpool(app.state.access.records, request.state.identity, limit, offset)

    @app.get(BASE + "/models", dependencies=[Depends(authenticated)])
    async def list_models(request: Request, includeArchived: bool = True):
        return await run_in_threadpool(app.state.access.read, request.state.identity, "list_models", includeArchived)

    @app.post(BASE + "/models/validate", dependencies=[Depends(authenticated)])
    async def validate_model(request: Request):
        payload = await body(request)
        if set(payload) != {"definition"}:
            raise DomainError("invalid_model", "Validation requires only a definition field.")
        errors = definition_errors(payload["definition"])
        return {"valid": not errors, "errors": errors}

    @app.get(BASE + "/models/{target_id}", dependencies=[Depends(authenticated)])
    async def get_model(target_id: str, request: Request):
        result = await run_in_threadpool(app.state.access.read, request.state.identity, "get_model", target_id)
        return JSONResponse(result, headers={"ETag": f'"{result["generation"]}:{result["model"]["revision"]}"'})

    async def model_mutation(request, operation, target_id=None):
        payload = await body(request, empty=operation in ("publish", "archive", "unarchive", "delete"))
        result = await run_in_threadpool(app.state.access.mutate_model, request.state.identity, operation, target_id, payload,
                                         request.headers.get("x-workspace-generation"), request.headers.get("if-match"),
                                         request.headers.get("idempotency-key"))
        headers = {"ETag": f'"{result["generation"]}:{result["model"]["revision"]}"'} if result["model"] is not None else {}
        return JSONResponse(result, status_code=201 if operation == "create" else 200, headers=headers)

    @app.post(BASE + "/models", dependencies=[Depends(authenticated)])
    async def create_model(request: Request):
        return await model_mutation(request, "create")

    @app.put(BASE + "/models/{target_id}", dependencies=[Depends(authenticated)])
    async def update_model(target_id: str, request: Request):
        return await model_mutation(request, "update", target_id)

    @app.post(BASE + "/models/{target_id}/publish", dependencies=[Depends(authenticated)])
    async def publish_model(target_id: str, request: Request):
        return await model_mutation(request, "publish", target_id)

    @app.post(BASE + "/models/{target_id}/archive", dependencies=[Depends(authenticated)])
    async def archive_model(target_id: str, request: Request):
        return await model_mutation(request, "archive", target_id)

    @app.post(BASE + "/models/{target_id}/unarchive", dependencies=[Depends(authenticated)])
    async def unarchive_model(target_id: str, request: Request):
        return await model_mutation(request, "unarchive", target_id)

    @app.post(BASE + "/models/{target_id}/apply", dependencies=[Depends(authenticated)])
    async def apply_model(target_id: str, request: Request):
        return await model_mutation(request, "apply", target_id)

    @app.delete(BASE + "/models/{target_id}", dependencies=[Depends(authenticated)])
    async def delete_model(target_id: str, request: Request):
        return await model_mutation(request, "delete", target_id)

    @app.get(BASE + "/records/{record_id}", dependencies=[Depends(authenticated)])
    async def get_record(record_id: str, request: Request, includeDeleted: bool = False):
        record = await run_in_threadpool(app.state.access.read, request.state.identity, "get_record", record_id, includeDeleted)
        return item_response(record, app.state.repository)

    async def mutate(request, operation, record_id=None, expected_kind=None):
        payload = await body(request, empty=operation in ("delete", "restore"), patch=operation == "patch")
        if operation in ("delete", "restore") and payload:
            raise DomainError("invalid_request", "This operation does not accept record fields.")
        result = await run_in_threadpool(app.state.access.mutate, request.state.identity, operation, record_id, payload,
                                         request.headers.get("x-workspace-generation"), request.headers.get("if-match"),
                                         request.headers.get("idempotency-key"), expected_kind=expected_kind,
                                         request_route=request.url.path)
        headers = {"ETag": f'"{result["generation"]}:{result["record"]["version"]}"'}
        if operation == "delete":
            return Response(status_code=204, headers=headers)
        if operation == "create":
            headers["Location"] = f'{request.url.path}/{result["record"]["id"]}'
        return JSONResponse(result, status_code=201 if operation == "create" else 200,
                            headers=headers)

    @app.post(BASE + "/records", dependencies=[Depends(authenticated)])
    async def create_record(request: Request):
        return await mutate(request, "create")

    @app.post(BASE + "/records/batch", dependencies=[Depends(authenticated)])
    async def batch_records(request: Request):
        payload = await body(request, maximum=8 * 1024 * 1024)
        return await run_in_threadpool(app.state.access.mutate_batch, request.state.identity, payload,
                                      request.headers.get("x-workspace-generation"), request.headers.get("idempotency-key"),
                                      request.url.path)

    @app.put(BASE + "/records/{record_id}", dependencies=[Depends(authenticated)])
    async def update_record(record_id: str, request: Request):
        return await mutate(request, "replace", record_id)

    @app.patch(BASE + "/records/{record_id}", dependencies=[Depends(authenticated)])
    async def patch_record(record_id: str, request: Request):
        return await mutate(request, "patch", record_id)

    @app.delete(BASE + "/records/{record_id}", dependencies=[Depends(authenticated)])
    async def delete_record(record_id: str, request: Request):
        return await mutate(request, "delete", record_id)

    @app.post(BASE + "/records/{record_id}/restore", dependencies=[Depends(authenticated)])
    async def restore_record(record_id: str, request: Request):
        return await mutate(request, "restore", record_id)

    def add_typed_records(collection, kind):
        path = f"{BASE}/{collection}"

        async def list_typed(request: Request, limit: int = 100, offset: int = 0):
            if not 1 <= limit <= 1000 or offset < 0:
                raise DomainError("invalid_page", "Record list limit must be 1-1000 and offset nonnegative.")
            return await run_in_threadpool(app.state.access.records, request.state.identity, limit, offset, kind)

        async def get_typed(record_id: str, request: Request, includeDeleted: bool = False):
            record = await run_in_threadpool(app.state.access.read, request.state.identity, "get_record", record_id, includeDeleted)
            if record["kind"] != kind:
                raise DomainError("record_not_found", "Record does not exist in this collection.", 404)
            return item_response(record, app.state.repository)

        async def create_typed(request: Request):
            return await mutate(request, "create", expected_kind=kind)

        async def replace_typed(record_id: str, request: Request):
            return await mutate(request, "replace", record_id, kind)

        async def patch_typed(record_id: str, request: Request):
            return await mutate(request, "patch", record_id, kind)

        async def delete_typed(record_id: str, request: Request):
            return await mutate(request, "delete", record_id, kind)

        for suffix, method, endpoint in (("", "GET", list_typed), ("", "POST", create_typed),
                                         ("/{record_id}", "GET", get_typed), ("/{record_id}", "PUT", replace_typed),
                                         ("/{record_id}", "PATCH", patch_typed), ("/{record_id}", "DELETE", delete_typed)):
            app.add_api_route(path + suffix, endpoint, methods=[method], dependencies=[Depends(authenticated)],
                              name=f"{method.lower()}_{collection}")

    add_typed_records("events", "event")
    add_typed_records("sessions", "session")

    @app.get(BASE + "/command-results/{command_id}")
    async def command_outcome(command_id: str, actor=Depends(authenticated)):
        def outcome():
            with app.state.identities.mutex, app.state.repository.mutex:
                result = app.state.access.outcome(actor, command_id)
                if "family" in result or (result.get("status") == "committed" and "settings" in result):
                    return app.state.configuration.outcome(actor, command_id)
                return result
        return await run_in_threadpool(outcome)

    @app.get(BASE + "/snapshot", dependencies=[Depends(authenticated)])
    async def snapshot(request: Request):
        return await run_in_threadpool(app.state.configuration.export_snapshot, request.state.identity)

    @app.get(BASE + "/audit", dependencies=[Depends(authenticated)])
    async def audit(request: Request, limit: int = 100, cursor: str | None = None):
        if legacy_config:
            raise DomainError("legacy_read_only", "Legacy authorities have no managed write audit log.", 409)
        return await run_in_threadpool(app.state.audit.page, request.state.identity, limit, cursor)

    @app.get(BASE + "/openapi.json", dependencies=[Depends(authenticated)])
    async def schema():
        return build_contract(app)

    @app.get("/")
    async def index():
        if not CLIENT_HTML.exists():
            return JSONResponse({"message": "Client build is missing; run npm run build."}, status_code=404)
        return FileResponse(CLIENT_HTML, media_type="text/html")

    return app


app = create_app() if os.environ.get("OPENBEXI_API_TOKEN") else None


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(create_app(), host="127.0.0.1", port=int(os.environ.get("OPENBEXI_PORT", "8000")))
