from __future__ import annotations

from .generated_protocol import (
    CHEMSMART_COMMIT,
    PROTOCOL_VERSION,
    SCHEMA_SHA256,
    StudioProtocolHello,
)


def protocol_hello() -> StudioProtocolHello:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "schemaSha256": SCHEMA_SHA256,
        "chemSmartCommit": CHEMSMART_COMMIT,
    }
