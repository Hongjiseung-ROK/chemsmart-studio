"""Molecule import keeps paths in main and makes topology provenance explicit."""

from __future__ import annotations

import base64
import json
from typing import Any

import pytest

from chemsmart_studio_bridge.molecule_import import import_molecule
from chemsmart_studio_bridge.rpc import RpcFault


class CapabilityPeer:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.requests: list[dict[str, Any]] = []

    def request(
        self, method: str, params: dict[str, Any], timeout: float = 120.0
    ) -> dict[str, Any]:
        assert method == "molecule.import_chunk"
        assert timeout == 30
        self.requests.append(params)
        start = params["offset"]
        chunk = self.payload[start : start + params["length"]]
        return {
            "capabilityId": params["capabilityId"],
            "offset": start,
            "sizeBytes": len(self.payload),
            "encoding": "base64",
            "content": base64.b64encode(chunk).decode("ascii"),
            "eof": start + len(chunk) == len(self.payload),
            "extensions": {},
        }


def request(format_name: str, payload: bytes) -> dict[str, Any]:
    return {
        "capabilityId": "import-capability-1",
        "format": format_name,
        "documentId": "document-imported",
        "sizeBytes": len(payload),
        "extensions": {},
    }


def test_cjson_preserves_explicit_atom_and_bond_order() -> None:
    payload = json.dumps(
        {
            "chemicalJson": 1,
            "name": "carbon monoxide",
            "atoms": {
                "coords": {"3d": [0.0, 0.0, 0.0, 1.13, 0.0, 0.0]},
                "elements": {"number": [6, 8]},
                "formalCharges": [0, 0],
            },
            "bonds": {"connections": {"index": [0, 1]}, "order": [3]},
            "properties": {"totalCharge": 0, "totalSpinMultiplicity": 1},
        }
    ).encode()
    peer = CapabilityPeer(payload)

    result = import_molecule(peer, request("cjson", payload))

    document = result["document"]
    assert [atom["atomicNumber"] for atom in document["atoms"]] == [6, 8]
    assert document["bonds"] == [
        {
            "id": "bond-1",
            "atomIds": ["atom-1", "atom-2"],
            "order": 3,
            "extensions": {},
        }
    ]
    assert document["extensions"]["chemsmart.import"] == {
        "format": "cjson",
        "topology": "explicit",
        "reviewRequired": False,
    }
    assert all("path" not in json.dumps(chunk).lower() for chunk in peer.requests)


def test_sdf_preserves_explicit_double_bond() -> None:
    payload = b"""ethene
  ChemSmart

  2  1  0  0  0  0  0  0  0  0999 V2000
   -0.6700    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.6700    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  2  0  0  0  0
M  END
$$$$
"""

    document = import_molecule(CapabilityPeer(payload), request("sdf", payload))[
        "document"
    ]

    assert document["bonds"][0]["order"] == 2
    assert document["extensions"]["chemsmart.import"]["topology"] == "explicit"
    assert document["extensions"]["chemsmart.import"]["reviewRequired"] is False


def test_xyz_infers_bonds_once_and_marks_them_for_researcher_review() -> None:
    payload = b"""3
water
O 0.0000 0.0000 0.0000
H 0.9572 0.0000 0.0000
H -0.2390 0.9270 0.0000
"""

    document = import_molecule(CapabilityPeer(payload), request("xyz", payload))[
        "document"
    ]

    assert len(document["bonds"]) == 2
    provenance = document["extensions"]["chemsmart.import"]
    assert provenance["format"] == "xyz"
    assert provenance["topology"] == "inferred"
    assert provenance["algorithm"] == "rdkit.DetermineConnectivity"
    assert provenance["algorithmVersion"]
    assert provenance["reviewRequired"] is True


def test_refuses_a_chunk_that_changes_capability_identity() -> None:
    payload = b"1\nhydrogen\nH 0 0 0\n"

    class ForgedPeer(CapabilityPeer):
        def request(
            self, method: str, params: dict[str, Any], timeout: float = 120.0
        ) -> dict[str, Any]:
            response = super().request(method, params, timeout)
            response["capabilityId"] = "import-other"
            return response

    with pytest.raises(RpcFault, match="changed capability identity"):
        import_molecule(ForgedPeer(payload), request("xyz", payload))
