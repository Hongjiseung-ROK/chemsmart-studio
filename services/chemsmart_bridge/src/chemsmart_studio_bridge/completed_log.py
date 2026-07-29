"""Strict offline normalization for recorded optimization output."""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from typing import Literal

from chemsmart.utils.periodictable import PeriodicTable
from jsonschema import Draft202012Validator

from .generated_protocol import CompletedLogReplay, OPTIMIZATION_RUNTIME_SCHEMA

Engine = Literal["xtb", "gaussian", "orca"]
ExpectedAtom = tuple[str, int]
ParsedFrame = tuple[list[int], list[list[float]], float]

MAX_COMPLETED_OUTPUT_BYTES = 32 * 1024 * 1024
_STABLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_GAUSSIAN_ENERGY = re.compile(r"SCF Done:.*?=\s*(\S+)", re.IGNORECASE)
_XTB_ENERGY = re.compile(r"\benergy:\s*(\S+)", re.IGNORECASE)
_PERIODIC_TABLE = PeriodicTable()


class CompletedLogError(ValueError):
    """Raised when recorded output cannot be normalized without guessing."""


def parse_completed_replay(
    engine: str,
    output_text: str,
    expected_atoms: Sequence[ExpectedAtom],
    *,
    trajectory_text: str | None = None,
) -> CompletedLogReplay:
    """Normalize completed recorded output without starting an engine process."""

    if engine not in {"xtb", "gaussian", "orca"}:
        raise CompletedLogError(f"Unsupported engine: {engine}")
    _check_size(output_text, trajectory_text)
    atom_ids, atomic_numbers = _validate_expected_atoms(expected_atoms)

    if engine == "gaussian":
        parsed_frames = _parse_gaussian(output_text)
    elif engine == "orca":
        parsed_frames = _parse_orca(output_text)
    else:
        if trajectory_text is None:
            raise CompletedLogError("xTB trajectory is required")
        parsed_frames = _parse_xtb(output_text, trajectory_text)

    frames = []
    for step_index, (observed_numbers, positions, energy) in enumerate(parsed_frames):
        if len(observed_numbers) != len(atomic_numbers):
            raise CompletedLogError("Recorded atom count changed")
        if observed_numbers != atomic_numbers:
            raise CompletedLogError("Recorded element order changed")
        if not math.isfinite(energy) or any(
            not math.isfinite(value) for position in positions for value in position
        ):
            raise CompletedLogError("Recorded coordinates and energy must be finite")
        frames.append(
            {
                "stepIndex": step_index,
                "positions": positions,
                "coordinateUnit": "angstrom",
                "energy": {"value": energy, "unit": "hartree"},
                "extensions": {},
            }
        )

    replay: CompletedLogReplay = {
        "type": "completed_log_replay",
        "engine": engine,
        "completed": True,
        "atomIds": atom_ids,
        "atomicNumbers": atomic_numbers,
        "frames": frames,
        "extensions": {},
    }
    errors = list(Draft202012Validator(OPTIMIZATION_RUNTIME_SCHEMA).iter_errors(replay))
    if errors:
        raise CompletedLogError("Normalized replay failed protocol validation")
    return replay


def _check_size(output_text: str, trajectory_text: str | None) -> None:
    size = len(output_text.encode("utf-8"))
    if trajectory_text is not None:
        size += len(trajectory_text.encode("utf-8"))
    if size > MAX_COMPLETED_OUTPUT_BYTES:
        raise CompletedLogError("Recorded output exceeds the bounded parse limit")


def _validate_expected_atoms(
    expected_atoms: Sequence[ExpectedAtom],
) -> tuple[list[str], list[int]]:
    atom_ids = [atom_id for atom_id, _ in expected_atoms]
    atomic_numbers = [atomic_number for _, atomic_number in expected_atoms]
    if (
        not atom_ids
        or len(set(atom_ids)) != len(atom_ids)
        or any(_STABLE_ID.fullmatch(atom_id) is None for atom_id in atom_ids)
    ):
        raise CompletedLogError("Expected stable atom IDs must be valid and unique")
    if any(number < 1 or number > 118 for number in atomic_numbers):
        raise CompletedLogError("Expected atomic numbers must be between 1 and 118")
    return atom_ids, atomic_numbers


def _parse_gaussian(text: str) -> list[ParsedFrame]:
    lines = text.splitlines()
    frames: list[ParsedFrame] = []
    pending: tuple[list[int], list[list[float]]] | None = None
    optimization_completed = False
    normal_termination = False
    index = 0
    while index < len(lines):
        line = lines[index]
        if "Optimization completed." in line:
            optimization_completed = True
        elif optimization_completed and "Normal termination of Gaussian" in line:
            normal_termination = True
            break
        elif not optimization_completed and "Standard orientation:" in line:
            if pending is not None:
                raise CompletedLogError("Gaussian geometry is missing an energy")
            pending, index = _parse_gaussian_orientation(lines, index)
        elif not optimization_completed:
            match = _GAUSSIAN_ENERGY.search(line)
            if match and pending is not None:
                frames.append((*pending, _number(match.group(1))))
                pending = None
        index += 1
    if not optimization_completed or not normal_termination:
        raise CompletedLogError("Gaussian optimization output is not complete")
    if pending is not None:
        raise CompletedLogError("Gaussian geometry is missing an energy")
    if not frames:
        raise CompletedLogError("Gaussian output contains no complete frames")
    return frames


def _parse_gaussian_orientation(
    lines: list[str], start: int
) -> tuple[tuple[list[int], list[list[float]]], int]:
    header = _find_line(lines, start + 1, "Coordinates (Angstroms)", 6)
    rows_start = _find_separator(lines, header + 1) + 1
    atomic_numbers: list[int] = []
    positions: list[list[float]] = []
    index = rows_start
    while index < len(lines) and not _is_separator(lines[index]):
        parts = lines[index].split()
        if len(parts) != 6:
            raise CompletedLogError("Malformed Gaussian coordinate row")
        try:
            atomic_numbers.append(int(parts[1]))
        except ValueError as error:
            raise CompletedLogError("Malformed Gaussian atomic number") from error
        positions.append([_number(value) for value in parts[3:6]])
        index += 1
    if not positions or index >= len(lines):
        raise CompletedLogError("Malformed Gaussian coordinate block")
    return (atomic_numbers, positions), index


def _parse_orca(text: str) -> list[ParsedFrame]:
    lines = text.splitlines()
    frames: list[ParsedFrame] = []
    pending: tuple[list[int], list[list[float]]] | None = None
    converged = False
    normal_termination = False
    index = 0
    while index < len(lines):
        line = lines[index]
        if "THE OPTIMIZATION HAS CONVERGED" in line:
            converged = True
        elif "ORCA TERMINATED NORMALLY" in line:
            normal_termination = True
            break
        elif "CARTESIAN COORDINATES (ANGSTROEM)" in line:
            if pending is not None:
                raise CompletedLogError("ORCA geometry is missing an energy")
            pending, index = _parse_orca_coordinates(lines, index)
        elif "FINAL SINGLE POINT ENERGY" in line and pending is not None:
            frames.append((*pending, _number(line.split()[-1])))
            pending = None
        index += 1
    if not converged or not normal_termination:
        raise CompletedLogError("ORCA optimization output is not complete")
    if pending is not None:
        raise CompletedLogError("ORCA geometry is missing an energy")
    if not frames:
        raise CompletedLogError("ORCA output contains no complete frames")
    return frames


def _parse_orca_coordinates(
    lines: list[str], start: int
) -> tuple[tuple[list[int], list[list[float]]], int]:
    rows_start = _find_separator(lines, start + 1) + 1
    atomic_numbers: list[int] = []
    positions: list[list[float]] = []
    index = rows_start
    while index < len(lines) and lines[index].strip():
        parts = lines[index].split()
        if len(parts) != 4:
            raise CompletedLogError("Malformed ORCA coordinate row")
        atomic_numbers.append(_atomic_number(parts[0]))
        positions.append([_number(value) for value in parts[1:4]])
        index += 1
    if not positions:
        raise CompletedLogError("Malformed ORCA coordinate block")
    return (atomic_numbers, positions), index


def _parse_xtb(output_text: str, trajectory_text: str) -> list[ParsedFrame]:
    lowered = output_text.lower()
    if (
        "geometry optimization converged" not in lowered
        or "finished run" not in lowered
    ):
        raise CompletedLogError("xTB optimization output is not complete")

    lines = trajectory_text.splitlines()
    frames: list[ParsedFrame] = []
    index = 0
    while index < len(lines):
        if not lines[index].strip():
            index += 1
            continue
        try:
            atom_count = int(lines[index].strip())
        except ValueError as error:
            raise CompletedLogError("Malformed xTB trajectory atom count") from error
        if atom_count < 1 or index + atom_count + 1 >= len(lines):
            raise CompletedLogError("Malformed xTB trajectory frame")
        energy_match = _XTB_ENERGY.search(lines[index + 1])
        if energy_match is None:
            raise CompletedLogError("xTB trajectory frame is missing an energy")
        atomic_numbers: list[int] = []
        positions: list[list[float]] = []
        for row in lines[index + 2 : index + 2 + atom_count]:
            parts = row.split()
            if len(parts) != 4:
                raise CompletedLogError("Malformed xTB trajectory coordinate row")
            atomic_numbers.append(_atomic_number(parts[0]))
            positions.append([_number(value) for value in parts[1:4]])
        frames.append(
            (atomic_numbers, positions, _number(energy_match.group(1)))
        )
        index += atom_count + 2
    if not frames:
        raise CompletedLogError("xTB trajectory contains no complete frames")
    return frames


def _find_line(
    lines: list[str], start: int, needle: str, maximum_distance: int
) -> int:
    for index in range(start, min(len(lines), start + maximum_distance)):
        if needle in lines[index]:
            return index
    raise CompletedLogError(f"Missing coordinate header: {needle}")


def _find_separator(lines: list[str], start: int) -> int:
    for index in range(start, min(len(lines), start + 4)):
        if _is_separator(lines[index]):
            return index
    raise CompletedLogError("Missing coordinate separator")


def _is_separator(line: str) -> bool:
    stripped = line.strip()
    return len(stripped) >= 3 and set(stripped) == {"-"}


def _number(value: str) -> float:
    try:
        number = float(value.replace("D", "E").replace("d", "e"))
    except ValueError as error:
        raise CompletedLogError("Recorded coordinates and energy must be finite") from error
    if not math.isfinite(number):
        raise CompletedLogError("Recorded coordinates and energy must be finite")
    return number


def _atomic_number(symbol: str) -> int:
    try:
        return int(_PERIODIC_TABLE.to_atomic_number(symbol))
    except (KeyError, TypeError, ValueError) as error:
        raise CompletedLogError(f"Unknown element symbol: {symbol}") from error


__all__ = [
    "CompletedLogError",
    "MAX_COMPLETED_OUTPUT_BYTES",
    "parse_completed_replay",
]
