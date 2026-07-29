from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
import stat
from typing import Any, Callable

import pytest

from chemsmart_studio_bridge.rpc import JsonRpcPeer, RpcFault


def tool_call_response(message: str) -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-ui",
                            "type": "function",
                            "function": {
                                "name": "emit_studio_ui_update",
                                "arguments": json.dumps(
                                    {
                                        "kind": "status",
                                        "message": message,
                                        "extensions": {},
                                    }
                                ),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }


def final_response(message: str) -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": message},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }


class SidecarProcess:
    def __init__(
        self,
        session_root: Path,
        socket_path: Path,
        responses: list[dict[str, Any]],
        on_model_call: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.live_events: list[dict[str, Any]] = []
        self.model_calls: list[dict[str, Any]] = []
        self.replay_events: list[dict[str, Any]] = []
        self._responses = list(responses)
        self._on_model_call = on_model_call
        self._replay_received = threading.Event()
        token = "sidecar-restart-test-token"
        environment = os.environ.copy()
        environment["CHEMSMART_STUDIO_SESSION_TOKEN"] = token
        self._process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "chemsmart_studio_bridge",
                "--socket",
                str(socket_path),
                "--session-root",
                str(session_root),
            ],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._wait_for_socket(socket_path)
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.connect(str(socket_path))
        self._peer = JsonRpcPeer(connection, self._handle_request)
        self._peer.start()
        assert self._peer.request(
            "system.authenticate", {"token": token}, timeout=5
        ) == {"authenticated": True}

    def request(self, method: str, params: dict[str, Any]) -> Any:
        return self._peer.request(method, params, timeout=60)

    def wait_for_replay(self, expected_count: int = 1) -> None:
        deadline = time.monotonic() + 5
        while len(self.replay_events) < expected_count:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not self._replay_received.wait(remaining):
                raise AssertionError(
                    f"expected {expected_count} replay notifications, received {len(self.replay_events)}"
                )
            self._replay_received.clear()

    def close(self) -> None:
        self._peer.close()
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._process.terminate()
            self._process.wait(timeout=5)
        if self._process.returncode != 0:
            stderr = (
                self._process.stderr.read().decode("utf-8", errors="replace")
                if self._process.stderr
                else ""
            )
            raise AssertionError(
                f"sidecar exited with {self._process.returncode}: {stderr}"
            )

    def _handle_request(self, method: str, params: Any) -> Any:
        if method == "model.generate":
            assert isinstance(params, dict)
            self.model_calls.append(params)
            if self._on_model_call is not None:
                self._on_model_call(params)
            return self._responses.pop(0)
        if method == "studio_ui.event":
            assert isinstance(params, dict)
            self.live_events.append(params)
            return {
                "accepted": True,
                "eventId": params["eventId"],
                "sequence": params["sequence"],
            }
        if method == "studio_ui.replay_event":
            assert isinstance(params, dict)
            self.replay_events.append(params["event"])
            self._replay_received.set()
            return None
        if method == "agent.event":
            return None
        raise RpcFault(-32601, f"Method not found: {method}")

    def _wait_for_socket(self, socket_path: Path) -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if socket_path.exists():
                return
            if self._process.poll() is not None:
                stderr = (
                    self._process.stderr.read().decode("utf-8", errors="replace")
                    if self._process.stderr
                    else ""
                )
                raise AssertionError(
                    f"sidecar exited before opening its socket: {stderr}"
                )
            time.sleep(0.05)
        raise AssertionError("sidecar did not open its socket within 10 seconds")


def test_sidecar_restart_recovers_persisted_sequence_and_replay(tmp_path: Path) -> None:
    session_id = "session-restart"
    with tempfile.TemporaryDirectory(
        prefix="cs-sidecar-", dir="/tmp"
    ) as socket_root_text:
        socket_root = Path(socket_root_text)
        first = SidecarProcess(
            tmp_path,
            socket_root / "first.sock",
            [
                tool_call_response("Before restart."),
                final_response("First turn complete."),
            ],
        )
        try:
            first_result = first.request(
                "agent.run_turn",
                {
                    "sessionId": session_id,
                    "modelId": "provider::model",
                    "request": "Run it now and report status.",
                },
            )
            assert [event["sequence"] for event in first.live_events] == [0, 1]
            assert first.live_events[1]["source"] == "runtime"
            assert first.live_events[1]["payload"]["message"] == "First turn complete."
            first_event_id = first.live_events[0]["eventId"]
        finally:
            first.close()

        second = SidecarProcess(
            tmp_path,
            socket_root / "second.sock",
            [
                tool_call_response("After restart."),
                final_response("Second turn complete."),
            ],
        )
        try:
            replay = second.request(
                "studio_ui.replay",
                {
                    "sessionId": session_id,
                    "replayId": "restart-replay",
                    "afterSequence": -1,
                },
            )
            second.wait_for_replay(2)
            assert replay == {"replayed": 2, "nextSequence": 2}
            assert second.replay_events[0]["eventId"] == first_event_id
            assert second.replay_events[1]["source"] == "runtime"
            assert (
                second.replay_events[1]["payload"]["message"] == "First turn complete."
            )

            second_result = second.request(
                "agent.run_turn",
                {
                    "sessionId": session_id,
                    "modelId": "provider::model",
                    "request": "Run it now and report status again.",
                },
            )
            assert second_result["session_id"] == first_result["session_id"]
            assert "Run it now and report status." in json.dumps(
                second.model_calls[0]["messages"]
            )
            assert [event["sequence"] for event in second.live_events] == [2, 3]
            assert second.live_events[1]["source"] == "runtime"
            assert (
                second.live_events[1]["payload"]["message"] == "Second turn complete."
            )
        finally:
            second.close()

    ledger = tmp_path / session_id / "studio-ui-events.ndjson"
    assert [
        json.loads(line)["sequence"] for line in ledger.read_text().splitlines()
    ] == [0, 1, 2, 3]
    binding = tmp_path / session_id / "agent-session.json"
    assert stat.S_IMODE(binding.stat().st_mode) == 0o600
    assert json.loads(binding.read_text()) == {
        "agentSessionId": first_result["session_id"],
        "schemaVersion": 1,
    }


def test_sidecar_binds_new_session_before_first_model_call_and_allows_explicit_retry(
    tmp_path: Path,
) -> None:
    session_id = "session-first-turn-interrupted"
    binding = tmp_path / session_id / "agent-session.json"

    def interrupt_after_binding(_: dict[str, Any]) -> None:
        assert binding.is_file()
        value = json.loads(binding.read_text())
        assert (tmp_path / value["agentSessionId"] / "session.json").is_file()
        raise RpcFault(-32603, "simulated model interruption")

    with tempfile.TemporaryDirectory(
        prefix="cs-sidecar-", dir="/tmp"
    ) as socket_root_text:
        socket_root = Path(socket_root_text)
        first = SidecarProcess(
            tmp_path,
            socket_root / "first-interrupted.sock",
            [final_response("This response must not be used.")],
            on_model_call=interrupt_after_binding,
        )
        try:
            with pytest.raises(
                RpcFault,
                match="stopped before completion.*provider_errors",
            ):
                first.request(
                    "agent.run_turn",
                    {
                        "sessionId": session_id,
                        "modelId": "provider::model",
                        "request": "Inspect the current molecule.",
                    },
                )
            # AgentSession's bounded provider-error budget makes two attempts. The callback above proves
            # the durable binding exists before each one; no tool can run during either failed call.
            assert len(first.model_calls) == 2
        finally:
            first.close()

        second = SidecarProcess(
            tmp_path,
            socket_root / "second-interrupted.sock",
            [final_response("Explicit retry complete.")],
        )
        try:
            retry_result = second.request(
                "agent.run_turn",
                {
                    "sessionId": session_id,
                    "modelId": "provider::model",
                    "request": "Retry the interrupted request.",
                },
            )
            assert retry_result["blocked"] is False
            assert retry_result["limit_reason"] is None
            assert retry_result["assistant_output"] == "Explicit retry complete."
            assert len(second.model_calls) == 1
            retry_context = json.dumps(second.model_calls[0]["messages"])
            assert "Inspect the current molecule." in retry_context
            assert "Retry the interrupted request." in retry_context
        finally:
            second.close()


def test_sidecar_restart_rejects_corrupt_session_binding_before_model_call(
    tmp_path: Path,
) -> None:
    session_id = "session-corrupt"
    session_directory = tmp_path / session_id
    session_directory.mkdir()
    (session_directory / "agent-session.json").write_text("{invalid")

    with tempfile.TemporaryDirectory(
        prefix="cs-sidecar-", dir="/tmp"
    ) as socket_root_text:
        sidecar = SidecarProcess(
            tmp_path,
            Path(socket_root_text) / "corrupt.sock",
            [final_response("This response must not be used.")],
        )
        try:
            with pytest.raises(
                RpcFault, match="Agent session binding is invalid"
            ) as caught:
                sidecar.request(
                    "agent.run_turn",
                    {
                        "sessionId": session_id,
                        "modelId": "provider::model",
                        "request": "Continue the previous task.",
                    },
                )
            assert caught.value.code == -32603
            assert sidecar.model_calls == []
        finally:
            sidecar.close()


def test_sidecar_restart_rejects_dangling_session_binding_before_model_call(
    tmp_path: Path,
) -> None:
    session_id = "session-dangling"
    session_directory = tmp_path / session_id
    session_directory.mkdir()
    (session_directory / "agent-session.json").symlink_to(
        tmp_path / "missing-agent-session.json"
    )

    with tempfile.TemporaryDirectory(
        prefix="cs-sidecar-", dir="/tmp"
    ) as socket_root_text:
        sidecar = SidecarProcess(
            tmp_path,
            Path(socket_root_text) / "dangling.sock",
            [final_response("This response must not be used.")],
        )
        try:
            with pytest.raises(
                RpcFault, match="Agent session binding is invalid"
            ) as caught:
                sidecar.request(
                    "agent.run_turn",
                    {
                        "sessionId": session_id,
                        "modelId": "provider::model",
                        "request": "Continue the previous task.",
                    },
                )
            assert caught.value.code == -32603
            assert sidecar.model_calls == []
        finally:
            sidecar.close()
