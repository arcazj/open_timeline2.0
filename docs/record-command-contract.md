# Record Commands

This contract describes the implemented record update transport and the next atomic-batch contract. It does not certify the remaining full-release endpoint families.

## Individual Records

`POST /api/v1/workspaces/default/events`, `/sessions`, or `/records` creates one record and returns 201, its canonical record, durable outcome and Location. Typed collections enforce kind; an item of another kind returns 404. GET is read-only. Item ETags are strong `"generation:version"` values.

PUT requires exactly the sixteen mutable fields: `kind`, `title`, `start`, `end`, `parentSessionId`, `order`, `sourceId`, `groupIds`, `tags`, `data`, `render`, `extensions`, `schemaId`, `schemaVersion`, `originalStart`, and `originalEnd`. Kind must remain unchanged. Identity, audit fields, soft-deletion state and versions are server-owned. Explicit null baseline dates are required when no baseline is authored. An incomplete representation returns 422, not a partial merge.

PATCH uses `application/json-patch+json` and 1-100 RFC 6902 operations: add, remove, replace, move, copy, and test. Paths and source paths are bounded JSON Pointers under mutable fields. Root replacement, immutable paths and prototype-related path components are forbidden. All canonical fields must still exist afterward. Arrays use JSON Patch indices and `-` append semantics; null is a value, not an implicit removal. A failed test returns 409; malformed operations or an invalid final record return 422. No operation commits partially. Tests distinguish booleans from numbers. The implementation uses pinned JSON Patch libraries in both languages.

DELETE soft-deletes and returns 204 with no body and the new ETag. `POST /records/{id}/restore` returns 200 and the restored record. Both reject unexpected body members. Active children prevent individual parent deletion. The provider obtains a body-free deletion's original durable result through `/command-results/{key}`; failure to retrieve that result retains the original recovery identity and never triggers a new deletion.

All current writes require `X-Workspace-Generation` and `Idempotency-Key`; existing items additionally require If-Match. Missing preconditions return 428, stale versions 412, generation/key conflicts 409. Identity and present authorization are checked before returning a stored result. Identical retries replay the original response even with the now-stale original version. The route is part of the request fingerprint: retrying a typed route through a different alias conflicts. Successful query and layout preparation returns 200, not resource-creation 201.

## Atomic Batch

`POST B/records/batch` accepts `{ "operations": [...] }`, with workspace-generation and idempotency headers. The Local/Server provider equivalent is `executeBatch({generation,clientCommandId,operations})`. Each entry is `{type,payload?}` for create or `{type,recordId,expectedVersion,payload?}` for update, replace, patch, delete or restore. Update is a provider/batch partial-field assignment; public item PUT remains complete replacement. Patch payloads are RFC 6902 arrays. Other write payloads are objects. Delete/restore payloads are absent or empty.

The batch contains 1-500 operations and at most 500 distinct affected records; an existing ID may occur once. New IDs are allocated by the provider and returned by operation index. New records can reference existing session IDs; references to newly generated IDs require a subsequent explicit command. Request UTF-8 JSON is limited to 8 MiB, and the complete before/after journal envelope to 32 MiB. Every record, source permission, schema pin, expected version and final relationship is checked before PREPARED. Cascades are explicit lists of every intended record/version; there is no implicit expansion. Restore order is immaterial because relationships are validated on the final candidate. A parent with an active unlisted child rejects the entire batch.

A successful synchronous batch returns 200 with `{status:'committed',commandId,generation,revision,affectedCount,items:[{index,record}],durability}`. One batch increments workspace revision once and each affected existing record's version once. The result is stored under the original command identity in the same transaction. A failure returns problem details with safe operation-index diagnostics and commits nothing. Server durability is `server-committed`; Local durability is `memory-only` and still requires explicit export. Disconnect or cancellation after commit cannot undo it; recover using the original key. No client token, role or owner field establishes permission.

## Release Work Still Open

Durable pending-command admission, published retention/checkpoint policy, complete workspace routes and full native OpenAPI coverage remain separate mandatory release work. They must not be inferred from successful synchronous command tests.

## References

The operation engine follows [RFC 6902](https://www.rfc-editor.org/rfc/rfc6902), using [fast-json-patch](https://github.com/Starcounter-Jack/JSON-Patch) and [python-json-patch](https://python-json-patch.readthedocs.io/en/latest/tutorial.html). Repository-specific admission limits and immutable-field rules above are intentionally stricter than the general-purpose engines.
