import os

import pytest

from server.app.models.domain import DomainError
from test_configuration_api import TOKEN, catalog, create, request_command

__all__ = ["catalog"]


@pytest.mark.parametrize("operation", ["lookup", "replay"])
@pytest.mark.parametrize("tamper", ["bytes", "missing"])
def test_configuration_outcomes_use_admitted_bytes_before_background_detection(catalog, operation, tamper):
    _, service, identities, repository = catalog
    resource = create(catalog, "groups")
    response, command, headers = request_command(catalog, "groups", "update", {"name": "Original"}, resource, key="guarded-outcome")
    assert response.status_code == 200, response.text
    identity = identities.authenticate(TOKEN)
    path = repository._outcome_path(identity["id"], "guarded-outcome")
    revision = repository.meta["manifest"]["revision"]
    with repository.mutex:
        if tamper == "missing":
            path.unlink()
        else:
            stamp = path.stat()
            before = path.read_bytes()
            after = before.replace(b'Original', b'Modified')
            assert after != before and len(after) == len(before)
            path.write_bytes(after)
            os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        with pytest.raises(DomainError):
            if operation == "lookup":
                service.outcome(identity, "guarded-outcome")
            else:
                service.mutate(identity, command, command["generation"], command["clientCommandId"], headers["If-Match"])
        assert repository.available is False
        assert repository.meta["manifest"]["revision"] == revision
