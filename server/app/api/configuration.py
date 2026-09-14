from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.convertors import Convertor, register_url_convertor

from ..models.domain import DomainError


class ConfigurationFamily(Convertor):
    regex = "sources|groups|schemas|filters|views"

    def convert(self, value):
        return value

    def to_string(self, value):
        return value


register_url_convertor("configuration_family", ConfigurationFamily())


def configuration_router(authenticated, read_body):
    router = APIRouter(prefix="/api/v1/workspaces/default", dependencies=[Depends(authenticated)])

    async def invoke(request, operation, *args, **kwargs):
        return await run_in_threadpool(getattr(request.app.state.configuration, operation), request.state.identity, *args, **kwargs)

    @router.get("/configuration/resource")
    async def get_opaque(request: Request, family: str, id: str):
        result = await invoke(request, "get_resource", family, id)
        return JSONResponse(result, headers={"ETag": f'"{result["generation"]}:{int(result["resource"]["revision"])}"'})

    @router.get("/configuration/usage")
    async def usage_opaque(request: Request, family: str, id: str, version: int | None = None, cursor: str | None = None, limit: int = 100):
        return await invoke(request, "usage", family, id, version, cursor=cursor, limit=limit)

    @router.post("/configuration/commands")
    async def mutate(request: Request):
        command = await read_body(request)
        result = await invoke(request, "mutate", command, request.headers.get("x-workspace-generation"), request.headers.get("idempotency-key"), request.headers.get("if-match"))
        headers = {"ETag": f'"{result["generation"]}:{int(result["resource"]["revision"])}"'} if result["resource"] else {}
        return JSONResponse(result, headers=headers)

    @router.get("/settings/effective")
    async def effective(request: Request):
        return await invoke(request, "get_effective")

    @router.post("/settings/effective")
    async def effective_preview(request: Request):
        return await invoke(request, "get_effective", await read_body(request))

    @router.post("/settings/commands")
    async def settings_command(request: Request):
        result = await invoke(request, "mutate_settings", await read_body(request), request.headers.get("x-workspace-generation"), request.headers.get("idempotency-key"), request.headers.get("if-match"))
        return JSONResponse(result, headers={"ETag": f'"{result["generation"]}:{int(result["settings"]["revision"])}"'})

    @router.post("/schemas/{resource_id}/impact")
    async def impact(resource_id: str, request: Request):
        return await invoke(request, "preview_impact", resource_id, await read_body(request))

    @router.get("/{family:configuration_family}/{resource_id}/usage")
    async def usage(family: str, resource_id: str, request: Request, version: int | None = None, cursor: str | None = None, limit: int = 100):
        return await invoke(request, "usage", family, resource_id, version, cursor=cursor, limit=limit)

    @router.get("/{family:configuration_family}/{resource_id}/versions")
    async def versions(family: str, resource_id: str, request: Request):
        result = await invoke(request, "get_resource", family, resource_id)
        return {"family": family, "generation": result["generation"], "revision": result["revision"], "items": result["resource"]["versions"]}

    @router.get("/{family:configuration_family}/{resource_id}/versions/{version}")
    async def version(family: str, resource_id: str, version: int, request: Request):
        result = await invoke(request, "get_resource", family, resource_id)
        publication = next((item for item in result["resource"]["versions"] if item["version"] == version), None)
        if publication is None:
            raise DomainError("configuration_version_unavailable", "Published configuration version is unavailable.", 409)
        return {"family": family, "generation": result["generation"], "revision": result["revision"], "publication": publication}

    @router.post("/{family:configuration_family}/validate")
    async def validate(family: str, request: Request):
        body = await read_body(request)
        if set(body) - {"definition", "context"} or "definition" not in body:
            raise DomainError("invalid_configuration", "Validation accepts definition and optional context.")
        return await invoke(request, "validate", family, body["definition"], body.get("context"))

    @router.get("/{family:configuration_family}/{resource_id}")
    async def get(family: str, resource_id: str, request: Request):
        result = await invoke(request, "get_resource", family, resource_id)
        return JSONResponse(result, headers={"ETag": f'"{result["generation"]}:{int(result["resource"]["revision"])}"'})

    @router.get("/{family:configuration_family}")
    async def listing(family: str, request: Request, includeArchived: bool = True):
        return await invoke(request, "list_resources", family, includeArchived)

    return router
