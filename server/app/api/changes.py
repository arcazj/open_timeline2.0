import asyncio
import json
import time

import anyio
from fastapi import APIRouter, Depends, Request
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect
from starlette.responses import StreamingResponse

from ..models.domain import DomainError


def frame(event, value):
    return f"event: {event}\ndata: {json.dumps(value, separators=(',', ':'), ensure_ascii=True)}\n\n"


class BoundedStreamResponse(StreamingResponse):
    def __init__(self, content, release):
        super().__init__(content, media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"}, background=BackgroundTask(release))
        self.release = release

    async def __call__(self, scope, receive, send):
        async def bounded_send(message):
            with anyio.fail_after(1):
                await send(message)

        try:
            await super().__call__(scope, receive, bounded_send)
        except (TimeoutError, ClientDisconnect, OSError):
            pass
        finally:
            self.release()
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()


def changes_router(authenticated):
    router = APIRouter(prefix="/api/v1/workspaces/default", dependencies=[Depends(authenticated)])

    @router.get("/changes")
    async def changes(request: Request, generation: str, afterRevision: int, limit: int = 100, scope: str | None = None):
        return await run_in_threadpool(request.app.state.changes.page, request.state.identity, generation, afterRevision, limit, scope)

    @router.get("/changes/stream")
    async def stream(request: Request, generation: str, afterRevision: int, limit: int = 100, scope: str | None = None):
        service, identity = request.app.state.changes, request.state.identity
        admitted = await run_in_threadpool(service.admit_stream, identity, generation, afterRevision, limit, scope)
        lease = admitted["lease"]

        async def events():
            after, pinned_scope = afterRevision, admitted["page"]["scope"]
            try:
                while True:
                    started = time.monotonic()
                    try:
                        page = await run_in_threadpool(service.stream_page, lease, identity, generation, after, limit, pinned_scope)
                    except DomainError as error:
                        yield frame("error", {"code": error.code, "status": error.status, "message": "Change stream ended; refresh authorization and snapshot."})
                        return
                    heartbeat = "" if page["hasMore"] else frame("heartbeat", {"generation": page["generation"], "revision": page["nextRevision"]})
                    yield frame("changes", page) + heartbeat
                    after = page["nextRevision"]
                    if page["hasMore"]:
                        await asyncio.sleep(0)
                    else:
                        await asyncio.sleep(max(0, 1 - (time.monotonic() - started)))
            finally:
                service.release_stream(lease)

        return BoundedStreamResponse(events(), lambda: service.release_stream(lease))

    return router
