from __future__ import annotations

import argparse
import os
from pathlib import Path

from .rpc import serve_unix_socket
from .runtime import StudioAgentRuntime


def main() -> None:
    parser = argparse.ArgumentParser(description="ChemSmart Studio AgentSession sidecar")
    parser.add_argument("--socket", required=True)
    parser.add_argument("--session-root", required=True)
    # Optional: a sidecar started before a project is open still serves everything else.
    parser.add_argument("--project-root")
    args = parser.parse_args()
    token = os.environ.get("CHEMSMART_STUDIO_SESSION_TOKEN")
    if not token:
        parser.error("CHEMSMART_STUDIO_SESSION_TOKEN is required")
    runtime = StudioAgentRuntime(
        Path(args.session_root),
        Path(args.project_root) if args.project_root else None,
    )
    serve_unix_socket(args.socket, token, lambda: runtime)


if __name__ == "__main__":
    main()
