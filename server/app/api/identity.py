import re

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from ..models.domain import DomainError
from ..services.identity import public_principal


def identity_router(authenticated, read_body):
    router = APIRouter(prefix="/api/v1", dependencies=[Depends(authenticated)])

    def preconditions(request):
        generation = request.headers.get("x-identity-generation")
        match = request.headers.get("if-match")
        command_id = request.headers.get("idempotency-key")
        if generation is None or match is None or command_id is None:
            raise DomainError("precondition_required", "X-Identity-Generation, If-Match and Idempotency-Key are required.", 428)
        parsed = re.fullmatch(r'"([^":]+):([1-9][0-9]{0,15})"', match)
        if parsed is None or parsed[1] != generation:
            raise DomainError("revision_conflict", "Identity ETag does not match the requested generation.", 412)
        return generation, int(parsed[2]), command_id

    def envelope(store, value, status=200, location=None):
        resource = value.get("token", value.get("principal", value))
        committed = getattr(value, "response", getattr(resource, "response", None))
        if committed is not None:
            return JSONResponse(committed["body"], status_code=committed["status"], headers=committed["headers"])
        revision = resource.get("revision", store.state["revision"])
        headers = {"ETag": f'"{store.state["generation"]}:{revision}"'}
        if location is not None:
            headers["Location"] = location
        return JSONResponse({"generation": store.state["generation"], "revision": store.state["revision"],
                             **value}, status_code=status, headers=headers)

    async def invoke(request, operation, *args):
        store = request.app.state.identities
        return await run_in_threadpool(getattr(store, operation), request.state.identity, *args)

    @router.get("/principals/me")
    async def me(request: Request):
        store = request.app.state.identities

        def current():
            with store.mutex:
                store._ready()
                principal = public_principal(store._current(request.state.identity))
                return envelope(store, {"principal": principal, "tokenId": request.state.identity["tokenId"]})

        return await run_in_threadpool(current)

    @router.get("/identity/commands/{command_id}")
    async def command_outcome(command_id: str, request: Request):
        return await invoke(request, "get_command_outcome", command_id)

    @router.get("/principals")
    async def list_principals(request: Request):
        result = await invoke(request, "list_principals")
        return JSONResponse(result, headers={"ETag": f'"{result["generation"]}:{result["revision"]}"'})

    @router.post("/principals", status_code=201)
    async def create_principal(request: Request):
        payload, conditions = await read_body(request), preconditions(request)
        store = request.app.state.identities

        def create():
            with store.mutex:
                resource = store.create_principal(request.state.identity, payload, *conditions)
                return envelope(store, {"principal": resource}, 201, "/api/v1/principals/" + resource["id"])

        return await run_in_threadpool(create)

    @router.get("/principals/{principal_id}")
    async def get_principal(principal_id: str, request: Request):
        result = await invoke(request, "list_principals")
        principal = next((item for item in result["items"] if item["id"] == principal_id), None)
        if principal is None:
            raise DomainError("not_found", "The principal is unavailable.", 404)
        return JSONResponse({"generation": result["generation"], "principal": principal},
                            headers={"ETag": f'"{result["generation"]}:{principal["revision"]}"'})

    @router.patch("/principals/{principal_id}")
    async def update_principal(principal_id: str, request: Request):
        payload, conditions = await read_body(request), preconditions(request)
        store = request.app.state.identities

        def update():
            with store.mutex:
                principal = store.update_principal(request.state.identity, principal_id, payload, *conditions)
                result = envelope(store, {"principal": principal})
                result.headers["ETag"] = f'"{store.state["generation"]}:{principal["revision"]}"'
                return result

        return await run_in_threadpool(update)

    @router.get("/tokens")
    async def list_tokens(request: Request):
        result = await invoke(request, "list_tokens")
        return JSONResponse(result, headers={"ETag": f'"{result["generation"]}:{result["revision"]}"'})

    @router.post("/tokens", status_code=201)
    async def create_token(request: Request):
        payload, conditions = await read_body(request), preconditions(request)
        store = request.app.state.identities

        def create():
            with store.mutex:
                result = store.create_token(request.state.identity, payload, *conditions)
                return envelope(store, result, 201, "/api/v1/tokens/" + result["token"]["id"])

        return await run_in_threadpool(create)

    @router.delete("/tokens/{token_id}")
    async def revoke_token(token_id: str, request: Request):
        conditions = preconditions(request)
        store = request.app.state.identities

        def revoke():
            with store.mutex:
                return envelope(store, {"token": store.revoke_token(request.state.identity, token_id, *conditions)})

        return await run_in_threadpool(revoke)

    return router
