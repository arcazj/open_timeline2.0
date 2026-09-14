from functools import lru_cache

from .domain import DomainError, _compile_schema, json_bytes, parse_json


BUILT_INS = {"description": str, "text": str, "system": str, "type": str, "status": str, "priority": (int, float)}


@lru_cache(maxsize=32)
def _validator(definition_bytes):
    from .configuration_catalog import resolved_data_schema
    return _compile_schema(resolved_data_schema(parse_json(definition_bytes)), [])


def validate_record_data(record, configuration=None):
    data = record["data"]
    if configuration is not None and "groups" in configuration:
        groups = {group["id"] for group in configuration["groups"]}
        if any(group_id not in groups for group_id in record["groupIds"]):
            raise DomainError("group_unavailable", "Record group is not in the workspace catalog.")
    for name, expected in BUILT_INS.items():
        if name in data and (not isinstance(data[name], expected) or (name == "priority" and isinstance(data[name], bool))):
            raise DomainError("invalid_record_data", f"Built-in data field {name} has an incompatible type.")
    if record.get("schemaId") is None:
        if set(data) - set(BUILT_INS):
            raise DomainError("schema_required", "Custom data fields require a published schema ID and version.")
        return record
    resource = next((item for item in (configuration or {}).get("schemas", []) if item["id"] == record["schemaId"]), None)
    version = next((item for item in resource["versions"] if item["version"] == record["schemaVersion"]), None) if resource else None
    if version is None or resource["visibility"] != "workspace":
        raise DomainError("schema_reference", "Record schema must be an available workspace publication.")
    error = next(_validator(json_bytes(version["definition"])).iter_errors(data), None)
    if error is not None:
        failure = DomainError("invalid_record_data", "Record data does not conform to its pinned schema.")
        pointer = "/data" + "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in error.instance_path)
        failure.errors = [{"path": pointer, "code": "schema", "message": "Value does not conform to its declared schema."}]
        raise failure
    return record


def assert_source_writable(configuration, source_id, operation):
    if "sources" not in configuration:
        if source_id not in configuration["manifest"]["scope"]["sourceIds"]:
            raise DomainError("source_unavailable", "Record source is unavailable.")
        return {"storage": "json", "enabled": True, "writable": True, "defaultSchema": None}
    source = next((item for item in configuration["sources"] if item["id"] == source_id), None)
    if source is None:
        raise DomainError("source_unavailable", "Record source is unavailable.")
    definition = source["versions"][-1]["definition"]
    if not definition["writable"]:
        raise DomainError("source_read_only", "This source is read-only.", 403)
    if operation in ("create", "reassign") and (source["lifecycle"] == "archived" or not definition["enabled"]):
        raise DomainError("source_disabled", "This source does not accept new records.", 409)
    return definition
