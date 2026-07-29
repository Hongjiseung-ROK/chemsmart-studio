from __future__ import annotations

import copy
import math
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

from chemsmart_studio_bridge.completed_log import (
    CompletedLogError,
    parse_completed_replay,
)
from chemsmart_studio_bridge.generated_protocol import OPTIMIZATION_RUNTIME_SCHEMA


FIXTURES = Path(__file__).with_name("fixtures")
CO2_ATOMS = [("atom-o1", 8), ("atom-c1", 6), ("atom-o2", 8)]
WATER_ATOMS = [("atom-o1", 8), ("atom-h1", 1), ("atom-h2", 1)]


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text()


class CompletedLogReplayTest(unittest.TestCase):
    def assert_valid_replay(self, replay: dict) -> None:
        self.assertFalse(
            list(Draft202012Validator(OPTIMIZATION_RUNTIME_SCHEMA).iter_errors(replay))
        )
        self.assertEqual(replay["type"], "completed_log_replay")
        self.assertTrue(replay["completed"])
        self.assertEqual([frame["stepIndex"] for frame in replay["frames"]], [0, 1])
        for frame in replay["frames"]:
            self.assertEqual(frame["coordinateUnit"], "angstrom")
            self.assertEqual(frame["energy"]["unit"], "hartree")

    def test_gaussian_replays_geometry_and_energy_in_source_order(self) -> None:
        replay = parse_completed_replay(
            "gaussian", fixture("gaussian_completed.log"), CO2_ATOMS
        )

        self.assert_valid_replay(replay)
        self.assertEqual(
            [frame["energy"]["value"] for frame in replay["frames"]],
            [-188.440236949, -188.444679593],
        )
        self.assertEqual(replay["frames"][0]["positions"][0][0], -1.16)
        self.assertEqual(replay["frames"][1]["positions"][0][0], -1.156195)

    def test_orca_replays_geometry_and_energy_in_source_order(self) -> None:
        replay = parse_completed_replay(
            "orca", fixture("orca_completed.out"), CO2_ATOMS
        )

        self.assert_valid_replay(replay)
        self.assertEqual(
            [frame["energy"]["value"] for frame in replay["frames"]],
            [-188.363728668462, -188.370538039014],
        )

    def test_xtb_replays_only_recorded_trajectory_geometry(self) -> None:
        replay = parse_completed_replay(
            "xtb",
            fixture("xtb_completed.out"),
            WATER_ATOMS,
            trajectory_text=fixture("xtbopt.log"),
        )

        self.assert_valid_replay(replay)
        self.assertEqual(
            [frame["energy"]["value"] for frame in replay["frames"]],
            [-5.07045135456, -5.070544443465],
        )
        self.assertEqual(
            replay["atomIds"],
            ["atom-o1", "atom-h1", "atom-h2"],
        )

    def test_rejects_incomplete_gaussian_or_orca_output(self) -> None:
        for engine, name, marker in (
            ("gaussian", "gaussian_completed.log", "Normal termination of Gaussian"),
            ("orca", "orca_completed.out", "ORCA TERMINATED NORMALLY"),
        ):
            with self.subTest(engine=engine), self.assertRaisesRegex(
                CompletedLogError, "not complete"
            ):
                parse_completed_replay(engine, fixture(name).replace(marker, ""), CO2_ATOMS)

    def test_rejects_incomplete_xtb_output_or_missing_trajectory(self) -> None:
        with self.assertRaisesRegex(CompletedLogError, "not complete"):
            parse_completed_replay(
                "xtb",
                fixture("xtb_completed.out").replace("finished run", "interrupted run"),
                WATER_ATOMS,
                trajectory_text=fixture("xtbopt.log"),
            )
        with self.assertRaisesRegex(CompletedLogError, "trajectory is required"):
            parse_completed_replay("xtb", fixture("xtb_completed.out"), WATER_ATOMS)

    def test_rejects_atom_count_or_element_order_changes(self) -> None:
        with self.assertRaisesRegex(CompletedLogError, "atom count changed"):
            parse_completed_replay(
                "gaussian", fixture("gaussian_completed.log"), CO2_ATOMS[:2]
            )
        with self.assertRaisesRegex(CompletedLogError, "element order changed"):
            parse_completed_replay(
                "orca",
                fixture("orca_completed.out"),
                [("atom-c1", 6), ("atom-o1", 8), ("atom-o2", 8)],
            )

    def test_rejects_invalid_or_duplicate_stable_ids(self) -> None:
        for atoms in (
            [("bad id", 8), ("atom-c1", 6), ("atom-o2", 8)],
            [("atom-o1", 8), ("atom-o1", 6), ("atom-o2", 8)],
        ):
            with self.subTest(atoms=atoms), self.assertRaisesRegex(
                CompletedLogError, "stable atom IDs"
            ):
                parse_completed_replay(
                    "gaussian", fixture("gaussian_completed.log"), atoms
                )

    def test_rejects_missing_frame_energy_instead_of_pairing_by_guess(self) -> None:
        source = fixture("orca_completed.out").replace(
            "FINAL SINGLE POINT ENERGY      -188.363728668462", ""
        )
        with self.assertRaisesRegex(CompletedLogError, "missing an energy"):
            parse_completed_replay("orca", source, CO2_ATOMS)

    def test_rejects_non_finite_coordinates_and_energy(self) -> None:
        for source in (
            fixture("gaussian_completed.log").replace("-1.160000", "NaN"),
            fixture("gaussian_completed.log").replace("-188.440236949", "1e309"),
        ):
            with self.subTest(source=source[:30]), self.assertRaisesRegex(
                CompletedLogError, "finite"
            ):
                parse_completed_replay("gaussian", source, CO2_ATOMS)

    def test_rejects_unknown_engine_and_oversized_input(self) -> None:
        with self.assertRaisesRegex(CompletedLogError, "Unsupported engine"):
            parse_completed_replay("avogadro", "complete", CO2_ATOMS)
        with self.assertRaisesRegex(CompletedLogError, "bounded parse limit"):
            parse_completed_replay(
                "gaussian", "x" * (32 * 1024 * 1024 + 1), CO2_ATOMS
            )

    def test_runtime_schema_rejects_unitless_or_per_frame_identity_override(self) -> None:
        replay = parse_completed_replay(
            "gaussian", fixture("gaussian_completed.log"), CO2_ATOMS
        )
        unitless = copy.deepcopy(replay)
        del unitless["frames"][0]["coordinateUnit"]
        identity_override = copy.deepcopy(replay)
        identity_override["frames"][1]["atomIds"] = list(
            reversed(replay["atomIds"])
        )

        validator = Draft202012Validator(OPTIMIZATION_RUNTIME_SCHEMA)
        self.assertTrue(list(validator.iter_errors(unitless)))
        self.assertTrue(list(validator.iter_errors(identity_override)))
        self.assertTrue(math.isfinite(replay["frames"][0]["energy"]["value"]))


if __name__ == "__main__":
    unittest.main()
