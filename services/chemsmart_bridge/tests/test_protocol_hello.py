from __future__ import annotations

import unittest

from chemsmart_studio_bridge.generated_protocol import (
    CHEMSMART_COMMIT,
    PROTOCOL_HELLO_RUNTIME_SCHEMA,
    PROTOCOL_VERSION,
    SCHEMA_SHA256,
)
from chemsmart_studio_bridge.protocol_identity import protocol_hello
from jsonschema import Draft202012Validator


class ProtocolHelloTest(unittest.TestCase):
    def test_runtime_reports_the_generated_protocol_identity(self) -> None:
        hello = protocol_hello()

        self.assertEqual(
            hello,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "schemaSha256": SCHEMA_SHA256,
                "chemSmartCommit": CHEMSMART_COMMIT,
            },
        )
        self.assertTrue(
            Draft202012Validator(PROTOCOL_HELLO_RUNTIME_SCHEMA).is_valid(hello)
        )


if __name__ == "__main__":
    unittest.main()
