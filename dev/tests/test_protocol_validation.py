import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "dev"))

from validate_protocol import fixture_key  # noqa: E402


def test_command_inspection_fixtures_use_the_command_inspection_schema() -> None:
    assert fixture_key(Path("command-inspection.json")) == "command-inspection"
    assert fixture_key(Path("command-inspection-invalid-execution.json")) == "command-inspection"
