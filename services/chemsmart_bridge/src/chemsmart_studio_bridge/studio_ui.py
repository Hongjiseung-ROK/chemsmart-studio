"""Validated append-only Studio UI events for the model-callable presentation tool."""

from __future__ import annotations

import json
import os
import re
import threading
from collections.abc import Callable, Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from .generated_protocol import (
    EMIT_STUDIO_UI_UPDATE_TOOL,
    STUDIO_COMMON_SCHEMA,
    STUDIO_UI_DELIVERY_SCHEMA,
    STUDIO_UI_EVENT_SCHEMA,
)

# Leave room for the JSON-RPC envelope around one canonical event.
MAX_LEDGER_LINE_BYTES = 4 * 1024 * 1024 - 4096
MAX_RUNTIME_NOTICE_CHARS = 2048
_STABLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_PAYLOAD_FIELDS = (
    "documentId",
    "revision",
    "atomIds",
    "bondIds",
    "runId",
    "stepIndex",
    "totalSteps",
    "progress",
    "phase",
    "toolName",
    "target",
)


def _canonical_validator(schema: dict[str, Any]) -> Draft202012Validator:
    common_resource = Resource.from_contents(STUDIO_COMMON_SCHEMA)
    registry = Registry().with_resource(STUDIO_COMMON_SCHEMA["$id"], common_resource)
    return Draft202012Validator(
        schema,
        registry=registry,
        format_checker=FormatChecker(),
    )


_INPUT_VALIDATOR = Draft202012Validator(EMIT_STUDIO_UI_UPDATE_TOOL["inputSchema"])
_EVENT_VALIDATOR = _canonical_validator(STUDIO_UI_EVENT_SCHEMA)
_DELIVERY_VALIDATOR = _canonical_validator(STUDIO_UI_DELIVERY_SCHEMA)


class StudioUiLedgerError(RuntimeError):
    """The append-only UI event ledger cannot be trusted or extended safely."""


class StudioUiEventEmitter:
    """Generate trusted event identity, persist in order, and publish best-effort."""

    def __init__(
        self,
        session_id: str,
        ledger_path: Path,
        publish: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None,
        clock: Callable[[], datetime] | None = None,
        event_id_factory: Callable[[], str] | None = None,
    ) -> None:
        if not _STABLE_ID.fullmatch(session_id):
            raise ValueError("session_id must be a valid stable ID")
        self._session_id = session_id
        self._ledger_path = ledger_path
        self._publish = publish
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._event_id_factory = event_id_factory or (lambda: f"ui-{uuid4().hex}")
        self._lock = threading.Lock()
        self._last_delivery_error: str | None = None
        self._next_sequence = self._load_next_sequence()

    @property
    def last_delivery_error(self) -> str | None:
        return self._last_delivery_error

    @property
    def next_sequence(self) -> int:
        with self._lock:
            return self._next_sequence

    def emit(self, arguments: dict[str, Any]) -> dict[str, Any]:
        return self._emit(arguments, source="model_tool")

    def emit_runtime_notice(self, message: str) -> dict[str, Any]:
        if len(message) > MAX_RUNTIME_NOTICE_CHARS:
            message = message[: MAX_RUNTIME_NOTICE_CHARS - 1] + "…"
        return self._emit(
            {
                "kind": "notice",
                "message": message,
                "extensions": {},
            },
            source="runtime",
        )

    def _emit(self, arguments: dict[str, Any], *, source: str) -> dict[str, Any]:
        input_errors = sorted(
            _INPUT_VALIDATOR.iter_errors(arguments),
            key=lambda error: list(error.path),
        )
        if input_errors:
            return self._failure("SCHEMA_INVALID", input_errors[0].message)

        with self._lock:
            sequence = self._next_sequence
            payload = {"message": arguments["message"]}
            for field in _PAYLOAD_FIELDS:
                if field in arguments:
                    payload[field] = arguments[field]
            event = {
                "eventId": self._event_id_factory(),
                "sessionId": self._session_id,
                "sequence": sequence,
                "timestamp": self._timestamp(),
                "source": source,
                "kind": arguments["kind"],
                "payload": payload,
                "extensions": arguments["extensions"],
            }
            event_errors = sorted(
                _EVENT_VALIDATOR.iter_errors(event),
                key=lambda error: list(error.path),
            )
            if event_errors:
                return self._failure("EVENT_INVALID", event_errors[0].message)
            try:
                self._append(event)
            except StudioUiLedgerError as error:
                return self._failure("EVENT_TOO_LARGE", str(error))
            except OSError:
                return self._failure(
                    "LEDGER_WRITE_FAILED",
                    "Studio UI event ledger could not be written",
                )
            self._next_sequence += 1

        delivery = self._publish_best_effort(event)
        if isinstance(delivery, dict):
            delivery_errors = sorted(
                _DELIVERY_VALIDATOR.iter_errors(delivery),
                key=lambda error: list(error.path),
            )
            if (
                delivery_errors
                or delivery.get("eventId") != event["eventId"]
                or delivery.get("sequence") != sequence
            ):
                self._last_delivery_error = "DELIVERY_REJECTED"
                return self._failure(
                    "DELIVERY_REJECTED",
                    "Electron returned an invalid Studio UI delivery response",
                    event_id=event["eventId"],
                    sequence=sequence,
                )
        if isinstance(delivery, dict) and delivery["accepted"] is False:
            error = delivery.get("error")
            return {
                "accepted": False,
                "eventId": event["eventId"],
                "sequence": sequence,
                "error": error,
            }
        return {
            "accepted": True,
            "eventId": event["eventId"],
            "sequence": sequence,
        }

    def replay(
        self, publish: Callable[[dict[str, Any]], None], after_sequence: int = -1
    ) -> int:
        delivered = 0
        for event in self.events():
            if event["sequence"] <= after_sequence:
                continue
            publish(event)
            delivered += 1
        return delivered

    def events(self) -> Iterator[dict[str, Any]]:
        with self._lock:
            snapshot = list(self._read_events())
        return iter(snapshot)

    def _read_events(self) -> Iterator[dict[str, Any]]:
        if not self._ledger_path.exists():
            return
        with self._ledger_path.open("rb") as handle:
            for index, raw_line in enumerate(handle):
                yield self._decode_ledger_line(raw_line, index)

    def _load_next_sequence(self) -> int:
        expected = 0
        for event in self._read_events():
            if event["sessionId"] != self._session_id:
                raise StudioUiLedgerError("UI event ledger session does not match")
            if event["sequence"] != expected:
                raise StudioUiLedgerError(
                    f"UI event ledger sequence mismatch at {expected}"
                )
            expected += 1
        return expected

    def _append(self, event: dict[str, Any]) -> None:
        encoded = (
            json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            + b"\n"
        )
        if len(encoded) > MAX_LEDGER_LINE_BYTES:
            raise StudioUiLedgerError("UI event exceeds ledger line size limit")
        self._ledger_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(
            self._ledger_path,
            os.O_APPEND | os.O_CREAT | os.O_WRONLY,
            0o600,
        )
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "ab") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())

    def _decode_ledger_line(self, raw_line: bytes, index: int) -> dict[str, Any]:
        if len(raw_line) > MAX_LEDGER_LINE_BYTES:
            raise StudioUiLedgerError(
                f"UI event ledger line {index} exceeds size limit"
            )
        try:
            event = json.loads(raw_line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise StudioUiLedgerError(
                f"UI event ledger line {index} is malformed"
            ) from error
        errors = sorted(
            _EVENT_VALIDATOR.iter_errors(event),
            key=lambda validation_error: list(validation_error.path),
        )
        if errors:
            raise StudioUiLedgerError(
                f"UI event ledger line {index} is schema-invalid: {errors[0].message}"
            )
        return event

    def _publish_best_effort(self, event: dict[str, Any]) -> dict[str, Any] | None:
        if self._publish is None:
            return None
        try:
            result = self._publish(event)
            self._last_delivery_error = None
            return result
        except Exception as error:
            self._last_delivery_error = type(error).__name__
            return None

    def _timestamp(self) -> str:
        value = self._clock()
        if value.tzinfo is None:
            raise ValueError("Studio UI event clock must return a timezone-aware value")
        return (
            value.astimezone(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace(
                "+00:00",
                "Z",
            )
        )

    @staticmethod
    def _failure(
        code: str,
        message: str,
        *,
        event_id: str | None = None,
        sequence: int | None = None,
    ) -> dict[str, Any]:
        return {
            "accepted": False,
            **(
                {"eventId": event_id, "sequence": sequence}
                if event_id is not None and sequence is not None
                else {}
            ),
            "error": {
                "code": code,
                "message": message,
            },
        }
