"""Pinned upstream contract, with explicit deployment limits (see spec/README.md)."""

import copy
import json
import secrets

import schemathesis
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st


def deployment_schema():
    with open("spec/upstream.json") as stream:
        document = json.load(stream)
    document["paths"] = {"/v8" + path: item for path, item in document["paths"].items()}
    parameters = document["components"]["parameters"]
    parameters["ArtifactHash"]["schema"]["maxLength"] = 256
    parameters["TeamId"]["schema"]["enum"] = ["team_tractorbeam"]
    parameters["Slug"]["schema"]["enum"] = ["tractorbeam", "team_tractorbeam"]
    schemas = document["components"]["schemas"]
    schemas["ArtifactQueryRequest"]["properties"]["hashes"].update(maxItems=128)
    schemas["ArtifactQueryRequest"]["properties"]["hashes"]["items"] = copy.deepcopy(
        parameters["ArtifactHash"]["schema"]
    )
    schemas["CacheEvent"]["properties"]["hash"]["maxLength"] = 256
    schemas["CacheEvent"]["properties"]["duration"]["maximum"] = 9007199254740991
    document["paths"]["/v8/artifacts/events"]["post"]["requestBody"]["content"][
        "application/json"
    ]["schema"]["maxItems"] = 128
    for param in document["paths"]["/v8/artifacts/{hash}"]["put"]["parameters"]:
        if param.get("name") in ["x-artifact-sha", "x-artifact-dirty-hash"]:
            param["schema"]["maxLength"] = 128
    upload = document["paths"]["/v8/artifacts/{hash}"]["put"]
    upload["parameters"] = [
        p for p in upload["parameters"] if p.get("name") != "Content-Length"
    ]
    for p in upload["parameters"]:
        if p.get("name") == "x-artifact-duration":
            p["schema"]["maximum"] = 9007199254740991
    # HEAD responses cannot have bodies, including error responses. Upstream
    # references shared JSON errors here, which conflicts with HTTP semantics.
    head = document["paths"]["/v8/artifacts/{hash}"]["head"]
    for code, response in head["responses"].items():
        if "$ref" in response:
            head["responses"][code] = {"description": "HEAD error (no body)"}
    for item in document["paths"].values():
        for method, operation in item.items():
            if method == "parameters":
                continue
            # Credential generation cannot synthesize a valid signed Access JWT.
            # Exercise that boundary separately with signed/forged/expired tokens;
            # keep structural fuzzing authenticated rather than mostly testing 401.
            operation.pop("security", None)
            for code in ["413", "429", "503"]:
                operation["responses"][code] = {
                    "description": "Deployment resource limit or unavailable authentication configuration",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Error"}
                        }
                    },
                }
                if method == "head":
                    operation["responses"][code].pop("content", None)
    return document


schema = schemathesis.openapi.from_dict(deployment_schema())


@schema.parametrize()
@settings(max_examples=60, deadline=None, suppress_health_check=[HealthCheck.too_slow])
def test_contract(case, server):
    # HTTP clients own Content-Length framing; independent length fuzzing could
    # hang a connection instead of exercising application validation.
    case.headers.pop("Content-Length", None)
    excluded = []
    if (
        case.meta
        and getattr(case.meta.phase.data, "scenario", None)
        == "object_unexpected_properties"
        and getattr(case.meta.phase.data.parameter_location, "value", None)
        in ["header", "query"]
    ):
        # HTTP permits extra headers/query parameters. All structural response
        # checks still execute for this case.
        from schemathesis.specs.openapi.checks import negative_data_rejection

        excluded.append(negative_data_rejection)
    case.call_and_validate(
        excluded_checks=excluded,
        base_url=server["url"],
        headers={"Authorization": "Bearer " + server["token"]},
    )


@given(
    body=st.binary(max_size=8192), duration=st.integers(min_value=0, max_value=1000000)
)
@settings(
    max_examples=30,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
def test_upload_read_sequence(server, body, duration):
    """Real multi-request workflows; new names avoid cross-example collisions."""
    artifact = secrets.token_hex(16)
    auth = {"Authorization": "Bearer " + server["token"]}
    params = {"hash": artifact}
    put = schema["/v8/artifacts/{hash}"]["PUT"].Case(
        path_parameters=params,
        query={"teamId": "team_tractorbeam"},
        headers={
            "x-artifact-duration": str(duration),
            "x-artifact-tag": "test-signature",
        },
        body=body,
        media_type="application/octet-stream",
    )
    put.call_and_validate(base_url=server["url"], headers=auth)
    for method in ["HEAD", "GET", "GET"]:
        case = schema["/v8/artifacts/{hash}"][method].Case(path_parameters=params)
        response = case.call(base_url=server["url"], headers=auth)
        case.validate_response(response)
        assert response.status_code == 200
        assert int(response.headers["content-length"][0]) == len(body)
        assert response.headers["x-artifact-tag"][0] == "test-signature"
        assert int(response.headers["x-artifact-duration"][0]) == duration
        assert response.content == (b"" if method == "HEAD" else body)
    query = schema["/v8/artifacts"]["POST"].Case(
        body={"hashes": [artifact]},
        media_type="application/json",
    )
    response = query.call(base_url=server["url"], headers=auth)
    query.validate_response(response)
    assert response.json()[artifact] == {
        "size": len(body),
        "taskDurationMs": duration,
        "tag": "test-signature",
    }
