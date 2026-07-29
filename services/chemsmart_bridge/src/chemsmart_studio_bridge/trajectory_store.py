"""Append-only trajectory ledger for controlled optimizations.

Frames live in ``<project>.cmsproj/runs/<runId>/events.ndjson``: one JSON object per
line, the first being ``run_started`` and the rest ``controlled_calculation_frame``
until a terminal event closes the run.

The shape of every event is validated against ``controlled-calculation.schema.json``
rather than re-checked by hand. That schema is the process-boundary source of truth,
and it is where the safety property lives: ``provenance.coordinateSource`` is
``const: "engine"``, so a frame that was interpolated rather than computed cannot
validate. Re-validating on *read* — not only on write — is deliberate: the ledger is
a plain text file inside the project directory, and a hand-edited or corrupted one
must not be able to smuggle a fabricated frame into a replay.

On top of the schema sit the rules a schema cannot express, because they are about
the ledger's history rather than one event: frames are strictly consecutive, the
engine's own step index agrees with ours, the atom identity never changes mid-run,
and nothing may be appended once the run is closed.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from jsonschema import Draft202012Validator

from chemsmart_studio_bridge.generated_protocol import (
    CONTROLLED_CALCULATION_RUNTIME_SCHEMA,
    OPTIMIZATION_TRAJECTORY_RUNTIME_SCHEMA,
)

#: Ledger caps, mirroring the reader they replace. A run that exceeds any of these is
#: refused rather than truncated: a partially read trajectory is indistinguishable
#: from a short one, and silently showing fewer frames than were computed would be a
#: quieter failure than saying the ledger is unusable.
MAX_LEDGER_BYTES = 64 * 1024 * 1024
MAX_LEDGER_EVENTS = 100_000
MAX_EVENT_BYTES = 1024 * 1024
MAX_FRAME_INDEX = 99_999

RUN_STARTED = "run_started"
CONTROLLED_FRAME = "controlled_calculation_frame"
CONTROLLED_TERMINAL = "controlled_calculation_terminal"
FINAL_EVENT_TYPES = {
    "optimization_final_accept_requested",
    "optimization_final_reject_requested",
    "optimization_final_accepted",
    "optimization_final_rejected",
    "optimization_final_accept_failed",
    "optimization_final_reject_failed",
}

_FRAME_VALIDATOR = Draft202012Validator(
    {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": CONTROLLED_CALCULATION_RUNTIME_SCHEMA["$defs"],
        "$ref": "#/$defs/externalFrame",
    }
)
_TERMINAL_VALIDATOR = Draft202012Validator(
    {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": CONTROLLED_CALCULATION_RUNTIME_SCHEMA["$defs"],
        "$ref": "#/$defs/terminal",
    }
)
_FINAL_EVENT_VALIDATOR = Draft202012Validator(
    {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": OPTIMIZATION_TRAJECTORY_RUNTIME_SCHEMA["$defs"],
        "$ref": "#/$defs/finalDecisionEvent",
    }
)


class LedgerError(RuntimeError):
    """A ledger could not be read or appended to. Carries a Studio error code."""

    def __init__(self, message: str, *, studio_code: str = "SCHEMA_INVALID") -> None:
        super().__init__(message)
        self.studio_code = studio_code


class RunNotFound(LedgerError):
    def __init__(self, message: str = "Optimization replay was not found") -> None:
        super().__init__(message, studio_code="RUN_NOT_FOUND")


@dataclass
class ParsedLedger:
    """The state a ledger replays to."""

    run: dict[str, Any]
    frame_count: int = 0
    closed: bool = False
    updated_at: str = ""
    #: How the run ended, taken from its terminal event. A ledger with no terminal is still running
    #: as far as the file is concerned — whether the process behind it is alive is main's to know.
    outcome: str = "running"
    #: Whatever the terminal said about why. Empty while the run is open.
    message: str = ""
    #: Whether the run recorded the input geometry it started from. Without it a trajectory cannot
    #: be replayed against anything, however many frames it holds.
    has_input_snapshot: bool = False
    #: Atom identity taken from the first frame; every later frame must match it.
    atom_ids: list[str] = field(default_factory=list)
    frames: list[dict[str, Any]] = field(default_factory=list)
    terminal: dict[str, Any] | None = None
    final_events: list[dict[str, Any]] = field(default_factory=list)


def _run_directory(project_path: Path, run_id: str) -> Path:
    return project_path / "runs" / run_id


def _ledger_path(project_path: Path, run_id: str) -> Path:
    return _run_directory(project_path, run_id) / "events.ndjson"


def _require_safe_file(path: Path) -> int:
    """Reject anything that is not a plain regular file of a sane size.

    A symlink here would let a ledger point outside the project package, so it is
    refused rather than followed.
    """
    stat = path.lstat()
    if not os.path.isfile(path) or os.path.islink(path):
        raise LedgerError("Optimization run ledger is unsafe")
    if stat.st_size > MAX_LEDGER_BYTES:
        raise LedgerError("Optimization run ledger is oversized")
    return stat.st_size


def _iter_events(path: Path) -> Iterator[dict[str, Any]]:
    """Yields one event per line, refusing a ledger that is not cleanly framed.

    A line without a trailing newline means the writer was interrupted mid-append, so
    the tail is not a fact yet and the ledger is refused rather than half-trusted.
    """
    with path.open("rb") as handle:
        for count, raw in enumerate(handle, start=1):
            if count > MAX_LEDGER_EVENTS:
                raise LedgerError("Optimization run ledger has too many events")
            if len(raw) > MAX_EVENT_BYTES:
                raise LedgerError("Optimization run ledger event is oversized")
            if not raw.endswith(b"\n"):
                raise LedgerError(
                    "Optimization run ledger has an invalid event boundary"
                )
            line = raw[:-1]
            if not line or line.endswith(b"\r"):
                raise LedgerError("Optimization run ledger contains an empty event")
            try:
                event = json.loads(line)
            except json.JSONDecodeError as error:
                raise LedgerError(
                    "Optimization run ledger contains malformed JSON"
                ) from error
            if not isinstance(event, dict):
                raise LedgerError("Optimization run ledger event is not an object")
            yield event


def parse_ledger(
    project_path: Path,
    run_id: str,
    *,
    document_id: str | None = None,
) -> ParsedLedger:
    """Replays a run's ledger, enforcing both the schema and the ordering rules."""
    path = _ledger_path(project_path, run_id)
    if not path.exists():
        raise RunNotFound()
    if _require_safe_file(path) == 0:
        raise RunNotFound()

    ledger: ParsedLedger | None = None
    for position, event in enumerate(_iter_events(path)):
        kind = event.get("type")
        if position == 0:
            if kind != RUN_STARTED or not isinstance(event.get("run"), dict):
                raise LedgerError("Optimization run start is schema-invalid")
            run = event["run"]
            if run.get("runId") != run_id:
                raise LedgerError("Optimization run identity does not match its ledger")
            if document_id is not None and run.get("documentId") != document_id:
                raise LedgerError("Optimization run belongs to another document")
            ledger = ParsedLedger(
                run=run,
                updated_at=str(event.get("timestamp", "")),
                has_input_snapshot=isinstance(event.get("inputSnapshotHash"), str),
            )
            continue

        assert ledger is not None  # position 0 either set it or raised
        if kind == CONTROLLED_FRAME:
            _accept_frame(ledger, event, run_id)
            continue
        if kind == CONTROLLED_TERMINAL:
            _accept_terminal(ledger, event, run_id)
            continue
        if kind in FINAL_EVENT_TYPES:
            _accept_final_event(ledger, event, run_id)
            continue
        # Historical native ledgers used several terminal event names. Preserve their
        # read-only replay behavior until the v1 compatibility decoder is separated in P6.
        if ledger.closed:
            raise LedgerError("Optimization run ledger continues past its terminal event")
        ledger.closed = True
        status = event.get("status")
        if isinstance(status, str) and status:
            ledger.outcome = status
        message = event.get("message")
        if isinstance(message, str):
            ledger.message = message
        ledger.updated_at = str(
            event.get("completedAt") or event.get("timestamp") or ledger.updated_at
        )

    if ledger is None:
        raise RunNotFound()
    return ledger


def _accept_frame(ledger: ParsedLedger, event: dict[str, Any], run_id: str) -> None:
    """Applies one frame, or refuses it.

    The schema decides the shape — including that the coordinates came from the
    engine. This function decides only what the schema cannot see: where the frame
    sits in the run's history.
    """
    if ledger.closed:
        raise LedgerError("Optimization run ledger continues past its terminal event")
    if not _FRAME_VALIDATOR.is_valid(event):
        raise LedgerError("External optimization frame is schema-invalid")
    if event["runId"] != run_id:
        raise LedgerError("External optimization frame belongs to another run")

    frame_index = event["frameIndex"]
    if frame_index != ledger.frame_count:
        # Strictly consecutive: a gap means a frame was lost, and a repeat means one
        # was replayed. Neither may be shown as a trajectory.
        raise LedgerError("External optimization frame is out of order")
    if event["engineStepIndex"] != frame_index:
        raise LedgerError("External optimization frame step index disagrees")
    if frame_index > MAX_FRAME_INDEX:
        raise LedgerError("Optimization run ledger has too many frames")

    atom_ids = list(event["atomIds"])
    if len(event["atomicNumbers"]) != len(atom_ids) or len(event["positions"]) != len(
        atom_ids
    ):
        raise LedgerError("External optimization frame atom arrays disagree")
    if ledger.frame_count == 0:
        ledger.atom_ids = atom_ids
    elif atom_ids != ledger.atom_ids:
        # The molecule may move during an optimization; it may not become a different
        # molecule. A changed atom set means the frames are not one trajectory.
        raise LedgerError("External optimization atom identity changed")

    ledger.frames.append(event)
    ledger.frame_count += 1
    ledger.updated_at = str(event.get("timestamp", ledger.updated_at))


def _accept_terminal(
    ledger: ParsedLedger, event: dict[str, Any], run_id: str
) -> None:
    if ledger.closed or ledger.terminal is not None:
        raise LedgerError("Optimization run is already closed")
    if not _TERMINAL_VALIDATOR.is_valid(event):
        raise LedgerError("External optimization terminal is schema-invalid")
    if event["runId"] != run_id or event["frameCount"] != ledger.frame_count:
        raise LedgerError("External terminal frame count disagrees")
    if (
        event["status"] == "completed"
        and (
            ledger.frame_count == 0
            or event.get("outputGeometryHash")
            != ledger.frames[-1].get("structureHash")
        )
    ):
        raise LedgerError("External terminal geometry hash disagrees")

    ledger.closed = True
    ledger.terminal = event
    status = event["status"]
    ledger.outcome = (
        "awaiting_final_geometry" if status == "completed" else status
    )
    if status == "failed":
        ledger.message = str((event.get("error") or {}).get("message", ""))
    elif status == "cancelled":
        ledger.message = str(event.get("reason", ""))
    ledger.updated_at = str(
        event.get("completedAt") or event.get("terminatedAt") or ledger.updated_at
    )


def _accept_final_event(
    ledger: ParsedLedger, event: dict[str, Any], run_id: str
) -> None:
    if (
        not ledger.closed
        or ledger.terminal is None
        or ledger.terminal.get("status") != "completed"
        or not _FINAL_EVENT_VALIDATOR.is_valid(event)
        or event.get("runId") != run_id
    ):
        raise LedgerError("Optimization final decision event is invalid")

    kind = event["type"]
    latest = ledger.final_events[-1] if ledger.final_events else None
    latest_kind = latest.get("type") if latest else None
    requested_kind = (
        "optimization_final_accept_requested"
        if "accept" in kind
        else "optimization_final_reject_requested"
    )
    retryable_predecessors = {
        None,
        "optimization_final_accept_failed",
        "optimization_final_reject_failed",
    }
    if kind.endswith("_requested"):
        if ledger.outcome != "awaiting_final_geometry" or latest_kind not in retryable_predecessors:
            raise LedgerError("Optimization final decision request is out of order")
    elif latest_kind != requested_kind:
        raise LedgerError("Optimization final decision result is out of order")

    if latest and kind != requested_kind:
        for key in ("expectedRevision", "geometryHash"):
            if key in event and key in latest and event[key] != latest[key]:
                raise LedgerError("Optimization final decision identity changed")
        if "revision" in event:
            expected = latest["expectedRevision"] + (
                1 if kind == "optimization_final_accepted" else 0
            )
            if event["revision"] != expected:
                raise LedgerError("Optimization final decision revision disagrees")

    ledger.final_events.append(event)
    if kind == "optimization_final_accepted":
        ledger.outcome = "accepted"
        ledger.message = ""
    elif kind == "optimization_final_rejected":
        ledger.outcome = "rejected"
        ledger.message = ""
    elif kind.endswith("_failed"):
        ledger.outcome = "awaiting_final_geometry"
        ledger.message = str(event["error"]["message"])
    ledger.updated_at = str(event["timestamp"])


def list_run_ids(project_path: Path) -> list[str]:
    """Run ids that have a ledger, newest first by directory name."""
    runs_root = project_path / "runs"
    if not runs_root.is_dir():
        return []
    run_ids = [
        entry.name
        for entry in runs_root.iterdir()
        if entry.is_dir() and not entry.is_symlink() and (entry / "events.ndjson").is_file()
    ]
    return sorted(run_ids, reverse=True)


def append_event(project_path: Path, run_id: str, event: dict[str, Any]) -> None:
    """Appends one event, creating the run directory on first write.

    Written with a trailing newline and flushed to the platform before returning, so a
    reader never sees a half-written line as a frame.
    """
    directory = _run_directory(project_path, run_id)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    line = json.dumps(event, separators=(",", ":"), sort_keys=True)
    encoded = f"{line}\n".encode()
    if len(encoded) > MAX_EVENT_BYTES:
        raise LedgerError("Optimization run ledger event is oversized")
    path = _ledger_path(project_path, run_id)
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        written = 0
        while written < len(encoded):
            count = os.write(descriptor, encoded[written:])
            if count <= 0:
                raise LedgerError("Optimization run ledger write was interrupted")
            written += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory_descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


def start_run(project_path: Path, run: dict[str, Any], *, timestamp: str, **hashes: str) -> None:
    """Opens a ledger with its ``run_started`` line.

    Refuses a run id that already has a ledger. Reusing one would append a second run's
    frames onto the first run's history, and the reader — which only checks that frames
    are consecutive — would replay the concatenation as a single trajectory.
    """
    run_id = run.get("runId")
    if not isinstance(run_id, str) or not run_id:
        raise LedgerError("Optimization run is missing its identity")
    if _ledger_path(project_path, run_id).exists():
        raise LedgerError("External optimization run identity already exists")
    if "chemsmart.controlled" not in (run.get("extensions") or {}):
        # The reader only accepts frames on a controlled run; without this marker the
        # ledger would open successfully and then reject every frame appended to it.
        raise LedgerError("Optimization run is not a controlled calculation")
    append_event(
        project_path,
        run_id,
        {"type": RUN_STARTED, "run": run, "timestamp": timestamp, **hashes},
    )


def finish_run(project_path: Path, run_id: str, terminal: dict[str, Any]) -> None:
    """Closes a ledger, checking that the terminal agrees with what was recorded.

    A terminal claiming a different frame count than the ledger holds would misreport the
    trajectory's length to everything downstream, so the claim is checked against the
    frames actually present rather than trusted.
    """
    ledger = parse_ledger(project_path, run_id)
    if ledger.closed:
        raise LedgerError("Optimization run is already closed")
    if terminal.get("runId") != run_id:
        raise LedgerError("Optimization terminal belongs to another run")
    frame_count = terminal.get("frameCount")
    if frame_count != ledger.frame_count:
        raise LedgerError("External terminal frame count disagrees")
    append_event(project_path, run_id, terminal)


def append_frame(project_path: Path, run_id: str, frame: dict[str, Any]) -> None:
    """Appends a frame only if it would also survive being read back.

    Validating before the write keeps a refusable frame out of the file entirely,
    rather than leaving a ledger that parses on write and fails on read.
    """
    ledger = parse_ledger(project_path, run_id)
    candidate = dict(frame)
    candidate.setdefault("type", CONTROLLED_FRAME)
    _accept_frame(ledger, candidate, run_id)
    append_event(project_path, run_id, candidate)


def append_final_event(
    project_path: Path, run_id: str, event: dict[str, Any]
) -> None:
    """Appends one validated final-decision write-ahead event."""
    ledger = parse_ledger(project_path, run_id)
    _accept_final_event(ledger, event, run_id)
    append_event(project_path, run_id, event)
