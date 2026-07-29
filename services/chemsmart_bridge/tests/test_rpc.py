from __future__ import annotations

import socket
import unittest
from contextlib import contextmanager

from chemsmart_studio_bridge.rpc import MAX_MESSAGE_BYTES, JsonRpcPeer, RpcFault


class JsonRpcPeerTest(unittest.TestCase):
    def test_rpc_fault_behaves_like_a_normal_exception_during_context_unwind(self) -> None:
        @contextmanager
        def passthrough():
            yield

        with self.assertRaisesRegex(RpcFault, "expected fault"):
            with passthrough():
                raise RpcFault(-32603, "expected fault")

    def test_bidirectional_requests_do_not_deadlock(self) -> None:
        left_socket, right_socket = socket.socketpair()
        peers: dict[str, JsonRpcPeer] = {}

        def left_handler(method, params):
            if method == "outer":
                return {"nested": peers["left"].request("inner", params)}
            raise RpcFault(-32601, "unknown")

        def right_handler(method, params):
            if method == "inner":
                return {"echo": params}
            raise RpcFault(-32601, "unknown")

        peers["left"] = JsonRpcPeer(left_socket, left_handler)
        peers["right"] = JsonRpcPeer(right_socket, right_handler)
        peers["left"].start()
        peers["right"].start()
        try:
            self.assertEqual(
                peers["right"].request("outer", {"value": 7}),
                {"nested": {"echo": {"value": 7}}},
            )
        finally:
            peers["left"].close()
            peers["right"].close()
            peers["left"].wait_closed()
            peers["right"].wait_closed()

    def test_authentication_fails_closed(self) -> None:
        server_socket, client_socket = socket.socketpair()
        server = JsonRpcPeer(
            server_socket,
            lambda method, params: {"method": method, "params": params},
            token="correct-token",
            require_authentication=True,
        )
        client = JsonRpcPeer(client_socket, lambda method, params: None)
        server.start()
        client.start()
        try:
            with self.assertRaisesRegex(RpcFault, "Authentication required"):
                client.request("system.ping", {})
            with self.assertRaisesRegex(RpcFault, "Authentication failed"):
                client.request("system.authenticate", {"token": "wrong-token"})
            self.assertEqual(
                client.request("system.authenticate", {"token": "correct-token"}),
                {"authenticated": True},
            )
            self.assertEqual(
                client.request("system.ping", {"value": 1}),
                {"method": "system.ping", "params": {"value": 1}},
            )
        finally:
            client.close()
            server.close()
            client.wait_closed()
            server.wait_closed()

    def test_oversized_outbound_message_is_rejected_before_write(self) -> None:
        left_socket, right_socket = socket.socketpair()
        peer = JsonRpcPeer(left_socket, lambda method, params: None)
        peer.start()
        try:
            with self.assertRaisesRegex(RpcFault, "exceeds size limit"):
                peer.notify("oversized", {"value": "x" * MAX_MESSAGE_BYTES})
        finally:
            peer.close()
            right_socket.close()
            peer.wait_closed()

    def test_oversized_inbound_frame_closes_the_peer(self) -> None:
        left_socket, right_socket = socket.socketpair()
        peer = JsonRpcPeer(left_socket, lambda method, params: None)
        peer.start()
        right_socket.settimeout(2)
        try:
            right_socket.sendall(b"x" * MAX_MESSAGE_BYTES + b"\n")
            self.assertEqual(right_socket.recv(1), b"")
        finally:
            peer.close()
            right_socket.close()
            peer.wait_closed()


if __name__ == "__main__":
    unittest.main()
