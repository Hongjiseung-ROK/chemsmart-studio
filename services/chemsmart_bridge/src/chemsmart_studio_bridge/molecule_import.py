"""Path-free CJSON, SDF, and XYZ import for ChemSmart Studio."""

from __future__ import annotations

import base64
import binascii
import json
import math
from typing import Any

from jsonschema import Draft202012Validator

from .generated_protocol import MOLECULE_IMPORT_RUNTIME_SCHEMA
from .rpc import JsonRpcPeer, RpcFault

_CHUNK_BYTES = 256 * 1024
_MAX_IMPORT_BYTES = 128 * 1024 * 1024


def _definition_validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": MOLECULE_IMPORT_RUNTIME_SCHEMA["$defs"],
            "$ref": f"#/$defs/{name}",
        }
    )


_REQUEST_VALIDATOR = _definition_validator("importRequest")
_CHUNK_RESPONSE_VALIDATOR = _definition_validator("chunkResponse")
_RESULT_VALIDATOR = _definition_validator("importResult")


def _read_capability(peer: JsonRpcPeer, request: dict[str, Any]) -> bytes:
    size_bytes = request["sizeBytes"]
    if not isinstance(size_bytes, int) or not 1 <= size_bytes <= _MAX_IMPORT_BYTES:
        raise RpcFault(-32602, "Molecule import size is invalid")
    content = bytearray()
    while len(content) < size_bytes:
        response = peer.request(
            "molecule.import_chunk",
            {
                "capabilityId": request["capabilityId"],
                "offset": len(content),
                "length": _CHUNK_BYTES,
                "extensions": {},
            },
            timeout=30,
        )
        if not _CHUNK_RESPONSE_VALIDATOR.is_valid(response):
            raise RpcFault(-32603, "Molecule import chunk is schema-invalid")
        if (
            response["capabilityId"] != request["capabilityId"]
            or response["offset"] != len(content)
            or response["sizeBytes"] != size_bytes
        ):
            raise RpcFault(-32603, "Molecule import chunk changed capability identity")
        try:
            chunk = base64.b64decode(response["content"], validate=True)
        except (ValueError, binascii.Error) as error:
            raise RpcFault(-32603, "Molecule import chunk is not valid base64") from error
        if len(chunk) > _CHUNK_BYTES or len(content) + len(chunk) > size_bytes:
            raise RpcFault(-32603, "Molecule import chunk exceeds its bound")
        if not chunk and len(content) < size_bytes:
            raise RpcFault(-32603, "Molecule import ended before the declared size")
        content.extend(chunk)
        if response["eof"] != (len(content) == size_bytes):
            raise RpcFault(-32603, "Molecule import chunk has an inconsistent end marker")
    return bytes(content)


def _number(value: Any, message: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise RpcFault(-32602, message)
    number = float(value)
    if not math.isfinite(number):
        raise RpcFault(-32602, message)
    return number


def _base_document(
    document_id: str,
    atoms: list[dict[str, Any]],
    bonds: list[dict[str, Any]],
    *,
    name: str | None,
    charge: int,
    multiplicity: int,
    provenance: dict[str, Any],
) -> dict[str, Any]:
    properties: dict[str, Any] = {
        "charge": charge,
        "multiplicity": multiplicity,
        "extensions": {},
    }
    if name:
        properties["name"] = name[:512]
    return {
        "documentId": document_id,
        "revision": 0,
        "atoms": atoms,
        "bonds": bonds,
        "selections": [],
        "frozenAxes": {},
        "constraints": [],
        "properties": properties,
        "extensions": {"chemsmart.import": provenance},
    }


def _parse_cjson(payload: bytes, document_id: str) -> dict[str, Any]:
    try:
        source = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RpcFault(-32602, "CJSON import is malformed") from error
    if not isinstance(source, dict):
        raise RpcFault(-32602, "CJSON import must contain an object")
    atom_block = source.get("atoms")
    if not isinstance(atom_block, dict):
        raise RpcFault(-32602, "CJSON import has no atom block")
    elements = atom_block.get("elements")
    coordinates = atom_block.get("coords")
    if not isinstance(elements, dict) or not isinstance(coordinates, dict):
        raise RpcFault(-32602, "CJSON import has incomplete atom data")
    atomic_numbers = elements.get("number")
    coordinate_values = coordinates.get("3d")
    formal_charges = atom_block.get("formalCharges")
    if not isinstance(atomic_numbers, list) or not isinstance(coordinate_values, list):
        raise RpcFault(-32602, "CJSON import has incomplete atom data")
    if coordinate_values and isinstance(coordinate_values[0], list):
        positions = coordinate_values
    else:
        if len(coordinate_values) % 3:
            raise RpcFault(-32602, "CJSON coordinates are not xyz triples")
        positions = [coordinate_values[index : index + 3] for index in range(0, len(coordinate_values), 3)]
    if len(positions) != len(atomic_numbers) or not atomic_numbers:
        raise RpcFault(-32602, "CJSON atom and coordinate counts differ")
    if formal_charges is None:
        formal_charges = [0] * len(atomic_numbers)
    if not isinstance(formal_charges, list) or len(formal_charges) != len(atomic_numbers):
        raise RpcFault(-32602, "CJSON formal-charge count differs")

    atoms: list[dict[str, Any]] = []
    for index, (atomic_number, position, formal_charge) in enumerate(
        zip(atomic_numbers, positions, formal_charges, strict=True)
    ):
        if (
            not isinstance(atomic_number, int)
            or isinstance(atomic_number, bool)
            or not 1 <= atomic_number <= 118
            or not isinstance(formal_charge, int)
            or isinstance(formal_charge, bool)
            or not -8 <= formal_charge <= 8
            or not isinstance(position, list)
            or len(position) != 3
        ):
            raise RpcFault(-32602, "CJSON atom data is invalid")
        atoms.append(
            {
                "id": f"atom-{index + 1}",
                "atomicNumber": atomic_number,
                "position": [_number(component, "CJSON coordinates must be finite") for component in position],
                "formalCharge": formal_charge,
                "extensions": {},
            }
        )

    bonds: list[dict[str, Any]] = []
    bond_block = source.get("bonds")
    if bond_block is not None:
        if not isinstance(bond_block, dict):
            raise RpcFault(-32602, "CJSON bond data is invalid")
        connections = bond_block.get("connections")
        orders = bond_block.get("order")
        if not isinstance(connections, dict) or not isinstance(connections.get("index"), list):
            raise RpcFault(-32602, "CJSON bond connections are invalid")
        indices = connections["index"]
        if len(indices) % 2:
            raise RpcFault(-32602, "CJSON bond connections are not pairs")
        pairs = [indices[index : index + 2] for index in range(0, len(indices), 2)]
        if orders is None:
            orders = [1] * len(pairs)
        if not isinstance(orders, list) or len(orders) != len(pairs):
            raise RpcFault(-32602, "CJSON bond-order count differs")
        for index, (pair, order) in enumerate(zip(pairs, orders, strict=True)):
            if (
                any(not isinstance(atom_index, int) or not 0 <= atom_index < len(atoms) for atom_index in pair)
                or pair[0] == pair[1]
                or order not in (1, 2, 3)
            ):
                raise RpcFault(-32602, "CJSON bond data is invalid")
            bonds.append(
                {
                    "id": f"bond-{index + 1}",
                    "atomIds": [atoms[pair[0]]["id"], atoms[pair[1]]["id"]],
                    "order": order,
                    "extensions": {},
                }
            )
    properties = source.get("properties") if isinstance(source.get("properties"), dict) else {}
    charge = properties.get("totalCharge", sum(atom["formalCharge"] for atom in atoms))
    multiplicity = properties.get("totalSpinMultiplicity", 1)
    if not isinstance(charge, int) or not -64 <= charge <= 64:
        raise RpcFault(-32602, "CJSON total charge is invalid")
    if not isinstance(multiplicity, int) or not 1 <= multiplicity <= 128:
        raise RpcFault(-32602, "CJSON multiplicity is invalid")
    name = source.get("name")
    return _base_document(
        document_id,
        atoms,
        bonds,
        name=name if isinstance(name, str) else None,
        charge=charge,
        multiplicity=multiplicity,
        provenance={
            "format": "cjson",
            "topology": "explicit",
            "reviewRequired": False,
        },
    )


def _document_from_rdkit(
    molecule: Any,
    document_id: str,
    *,
    format_name: str,
    inferred: bool,
) -> dict[str, Any]:
    from rdkit import rdBase

    conformer = molecule.GetConformer()
    atoms = []
    for index, atom in enumerate(molecule.GetAtoms()):
        position = conformer.GetAtomPosition(index)
        entry: dict[str, Any] = {
            "id": f"atom-{index + 1}",
            "atomicNumber": atom.GetAtomicNum(),
            "position": [float(position.x), float(position.y), float(position.z)],
            "formalCharge": atom.GetFormalCharge(),
            "extensions": {},
        }
        if atom.GetIsotope():
            entry["isotope"] = atom.GetIsotope()
        atoms.append(entry)
    bonds = []
    for index, bond in enumerate(molecule.GetBonds()):
        order_value = bond.GetBondTypeAsDouble()
        if order_value not in (1.0, 2.0, 3.0):
            raise RpcFault(-32602, f"{format_name.upper()} contains an unsupported bond order")
        bonds.append(
            {
                "id": f"bond-{index + 1}",
                "atomIds": [
                    atoms[bond.GetBeginAtomIdx()]["id"],
                    atoms[bond.GetEndAtomIdx()]["id"],
                ],
                "order": int(order_value),
                "extensions": {},
            }
        )
    name = molecule.GetProp("_Name") if molecule.HasProp("_Name") else None
    provenance: dict[str, Any] = {
        "format": format_name,
        "topology": "inferred" if inferred else "explicit",
        "reviewRequired": inferred,
    }
    if inferred:
        provenance.update(
            {
                "algorithm": "rdkit.DetermineConnectivity",
                "algorithmVersion": rdBase.rdkitVersion,
            }
        )
    return _base_document(
        document_id,
        atoms,
        bonds,
        name=name,
        charge=sum(atom.GetFormalCharge() for atom in molecule.GetAtoms()),
        multiplicity=max(1, 1 + sum(atom.GetNumRadicalElectrons() for atom in molecule.GetAtoms())),
        provenance=provenance,
    )


def _parse_sdf(payload: bytes, document_id: str) -> dict[str, Any]:
    from rdkit import Chem

    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RpcFault(-32602, "SDF import is not UTF-8") from error
    molecule = Chem.MolFromMolBlock(text, sanitize=True, removeHs=False, strictParsing=True)
    if molecule is None or molecule.GetNumConformers() != 1 or molecule.GetNumAtoms() == 0:
        raise RpcFault(-32602, "SDF import could not be parsed")
    return _document_from_rdkit(molecule, document_id, format_name="sdf", inferred=False)


def _parse_xyz(payload: bytes, document_id: str) -> dict[str, Any]:
    from rdkit import Chem
    from rdkit.Chem import rdDetermineBonds

    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RpcFault(-32602, "XYZ import is not UTF-8") from error
    molecule = Chem.MolFromXYZBlock(text)
    if molecule is None or molecule.GetNumConformers() != 1 or molecule.GetNumAtoms() == 0:
        raise RpcFault(-32602, "XYZ import could not be parsed")
    try:
        rdDetermineBonds.DetermineConnectivity(molecule)
    except (RuntimeError, ValueError) as error:
        raise RpcFault(-32602, "XYZ bond inference failed") from error
    return _document_from_rdkit(molecule, document_id, format_name="xyz", inferred=True)


def import_molecule(peer: JsonRpcPeer, request: Any) -> dict[str, Any]:
    if not _REQUEST_VALIDATOR.is_valid(request):
        raise RpcFault(-32602, "Molecule import request is schema-invalid")
    payload = _read_capability(peer, request)
    parsers = {
        "cjson": _parse_cjson,
        "sdf": _parse_sdf,
        "xyz": _parse_xyz,
    }
    result = {
        "document": parsers[request["format"]](payload, request["documentId"]),
        "extensions": {},
    }
    if not _RESULT_VALIDATOR.is_valid(result):
        raise RpcFault(-32603, "Molecule importer produced a schema-invalid document")
    return result
