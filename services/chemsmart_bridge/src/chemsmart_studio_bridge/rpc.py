"""Small newline-framed, bidirectional JSON-RPC 2.0 peer."""

from __future__ import annotations

import hmac
import json
import os
import socket
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from itertools import count
from typing import Any, Callable

MAX_MESSAGE_BYTES = 4 * 1024 * 1024


@dataclass
class RpcFault(Exception):
    code: int
    message: str
    data: Any = None


class JsonRpcPeer:
    """One socket peer with a dedicated reader and concurrent request handlers."""

    def __init__(
        self,
        connection: socket.socket,
        handler: Callable[[str, Any], Any],
        *,
        token: str | None = None,
        require_authentication: bool = False,
    ) -> None:
        self._connection = connection
        self._handler = handler
        self._token = token
        self._authenticated = not require_authentication
        self._ids = count(1)
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: dict[int, tuple[threading.Event, list[Any]]] = {}
        self._closed = threading.Event()
        self._executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="studio-rpc")
        self._reader = threading.Thread(target=self._read_loop, name="studio-rpc-reader", daemon=True)

    def start(self) -> None:
        self._reader.start()

    def wait_closed(self) -> None:
        self._reader.join()

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        try:
            self._connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._connection.close()
        self._executor.shutdown(wait=False, cancel_futures=True)
        with self._pending_lock:
            for event, slot in self._pending.values():
                slot.append(RpcFault(-32001, "RPC peer closed"))
                event.set()
            self._pending.clear()

    def request(self, method: str, params: Any = None, timeout: float = 120.0) -> Any:
        request_id = next(self._ids)
        event = threading.Event()
        slot: list[Any] = []
        with self._pending_lock:
            self._pending[request_id] = (event, slot)
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        if not event.wait(timeout):
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise RpcFault(-32002, f"RPC request timed out: {method}")
        result = slot[0]
        if isinstance(result, RpcFault):
            raise result
        return result

    def notify(self, method: str, params: Any = None) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _send(self, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
        if len(encoded) > MAX_MESSAGE_BYTES:
            raise RpcFault(-32600, "RPC message exceeds size limit")
        with self._write_lock:
            self._connection.sendall(encoded)

    def _read_loop(self) -> None:
        buffer = bytearray()
        try:
            while not self._closed.is_set():
                chunk = self._connection.recv(65536)
                if not chunk:
                    break
                buffer.extend(chunk)
                if len(buffer) > MAX_MESSAGE_BYTES and b"\n" not in buffer:
                    raise RpcFault(-32600, "RPC frame exceeds size limit")
                while b"\n" in buffer:
                    line, _, remainder = buffer.partition(b"\n")
                    buffer = bytearray(remainder)
                    if not line:
                        continue
                    if len(line) >= MAX_MESSAGE_BYTES:
                        raise RpcFault(-32600, "RPC frame exceeds size limit")
                    self._receive_line(line)
        except RpcFault:
            pass
        except OSError:
            if not self._closed.is_set():
                raise
        finally:
            self.close()

    def _receive_line(self, line: bytes) -> None:
        try:
            payload = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_error(None, -32700, "Parse error")
            return
        if not isinstance(payload, dict) or payload.get("jsonrpc") != "2.0":
            self._send_error(payload.get("id") if isinstance(payload, dict) else None, -32600, "Invalid Request")
            return
        if "method" in payload:
            self._executor.submit(self._dispatch_request, payload)
        elif "id" in payload:
            self._resolve_response(payload)

    def _dispatch_request(self, payload: dict[str, Any]) -> None:
        request_id = payload.get("id")
        method = payload.get("method")
        if not isinstance(method, str):
            self._send_error(request_id, -32600, "Invalid Request")
            return
        if not self._authenticated:
            if method != "system.authenticate":
                self._send_error(request_id, -32010, "Authentication required")
                return
            candidate = (payload.get("params") or {}).get("token")
            if not isinstance(candidate, str) or not self._token or not hmac.compare_digest(candidate, self._token):
                self._send_error(request_id, -32011, "Authentication failed")
                return
            self._authenticated = True
            if request_id is not None:
                self._send({"jsonrpc": "2.0", "id": request_id, "result": {"authenticated": True}})
            return
        try:
            result = self._handler(method, payload.get("params"))
            if request_id is not None:
                self._send({"jsonrpc": "2.0", "id": request_id, "result": result})
        except RpcFault as fault:
            self._send_error(request_id, fault.code, fault.message, fault.data)
        except Exception as exc:
            self._send_error(request_id, -32603, "Internal error", {"type": type(exc).__name__, "message": str(exc)})

    def _resolve_response(self, payload: dict[str, Any]) -> None:
        request_id = payload.get("id")
        if not isinstance(request_id, int):
            return
        with self._pending_lock:
            pending = self._pending.pop(request_id, None)
        if pending is None:
            return
        event, slot = pending
        if "error" in payload:
            error = payload.get("error") or {}
            slot.append(RpcFault(int(error.get("code", -32603)), str(error.get("message", "RPC error")), error.get("data")))
        else:
            slot.append(payload.get("result"))
        event.set()

    def _send_error(self, request_id: Any, code: int, message: str, data: Any = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._send({"jsonrpc": "2.0", "id": request_id, "error": error})


def serve_unix_socket(socket_path: str, token: str, handler_factory: Callable[[], Callable[[str, Any], Any]]) -> None:
    path = os.fspath(socket_path)
    if os.path.exists(path):
        os.unlink(path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        server.bind(path)
        os.chmod(path, 0o600)
        server.listen(1)
        connection, _ = server.accept()
        handler = handler_factory()
        peer = JsonRpcPeer(connection, handler, token=token, require_authentication=True)
        peer._handler = handler.bind_peer(peer) if hasattr(handler, "bind_peer") else handler
        peer.start()
        peer.wait_closed()
    finally:
        server.close()
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
