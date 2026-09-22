import json
import subprocess

import pytest


@pytest.fixture(scope="session")
def server():
    process = subprocess.Popen(
        ["node", "scripts/test-server.mjs"],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        yield json.loads(process.stdout.readline())
    finally:
        process.terminate()
        process.wait(timeout=15)
