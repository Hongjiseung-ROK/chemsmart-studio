from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import chemsmart_studio_bridge.project_workspace as project_workspace
from chemsmart_studio_bridge.project_workspace import (
    MAX_YAML_BYTES,
    critic_project,
    document_project,
    list_projects,
    project_document,
    read_project,
    validate_project,
)

GAUSSIAN_PROJECT = """gas:
  functional: b3lyp
  basis: def2-svp
solv:
  functional: b3lyp
  basis: def2-svp
  solvent_model: smd
  solvent_id: water
"""


class ProjectWorkspaceTest(unittest.TestCase):
    """Project reads and checks have one closed, path-free Studio shape."""

    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)

    def write_fixture(self, program: str, name: str) -> None:
        folder = self.root / ".chemsmart" / program
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{name}.yaml").write_text(
            GAUSSIAN_PROJECT,
            encoding="utf-8",
        )

    def test_lists_projects_by_program_and_marks_projectless_xtb(self) -> None:
        self.write_fixture("gaussian", "b3lyp-water")
        (self.root / ".chemsmart" / "gaussian" / "defaults.yaml").write_text(
            "functional: null\n",
            encoding="utf-8",
        )
        (self.root / ".chemsmart" / "gaussian" / "not-canonical.yml").write_text(
            GAUSSIAN_PROJECT,
            encoding="utf-8",
        )

        result = list_projects()
        by_program = {entry["program"]: entry for entry in result["programs"]}

        self.assertEqual(result["schemaVersion"], "1")
        self.assertEqual(
            by_program["gaussian"]["projectNames"],
            ["b3lyp-water"],
        )
        self.assertEqual(by_program["orca"]["projectNames"], [])
        self.assertTrue(by_program["gaussian"]["projectRequired"])
        self.assertTrue(by_program["orca"]["projectRequired"])
        self.assertFalse(by_program["xtb"]["projectRequired"])
        self.assertEqual(by_program["xtb"]["projectNames"], [])

    def test_reading_a_project_returns_only_the_named_yaml(self) -> None:
        self.write_fixture("gaussian", "b3lyp-water")

        with patch("chemsmart.agent.project_yaml.read_project_yaml") as upstream_read:
            result = read_project(
                {
                    "projectName": "b3lyp-water",
                    "program": "gaussian",
                    "extensions": {},
                }
            )

        upstream_read.assert_not_called()
        self.assertEqual(
            result,
            {
                "schemaVersion": "1",
                "projectName": "b3lyp-water",
                "program": "gaussian",
                "yamlText": GAUSSIAN_PROJECT,
                "extensions": {},
            },
        )
        self.assertNotIn(str(self.root), repr(result))

    def test_projects_every_explicit_unknown_and_inherited_value_without_writing(self) -> None:
        yaml_text = """gas:
  functional: b3lyp
  basis: def2svp
  future_option:
    - alpha
    - 2
solv:
  functional: b3lyp
  basis: def2svp
  freq: false
"""
        before = list(self.root.iterdir())

        with patch(
            "chemsmart_studio_bridge.project_workspace.validate_project_yaml",
            return_value={
                "verdict": "warn",
                "issues": [],
                "runtime_summary": {
                    "sp": {
                        "functional": "b3lyp",
                        "basis": "def2svp",
                        "freq": False,
                    }
                },
            },
        ):
            document = project_document("future-project", "gaussian", yaml_text)

        self.assertEqual(document["schemaVersion"], "2")
        self.assertEqual(
            document["digest"],
            __import__("hashlib").sha256(yaml_text.encode("utf-8")).hexdigest(),
        )
        self.assertEqual(document["yamlText"], yaml_text)
        self.assertEqual(
            [node["path"] for node in document["unknownNodes"]],
            [["gas", "future_option"]],
        )
        unknown = document["unknownNodes"][0]
        self.assertEqual(unknown["kind"], "sequence")
        self.assertEqual(
            [(child["path"], child["kind"], child["value"]) for child in unknown["children"]],
            [
                (["gas", "future_option", "[0]"], "scalar", "alpha"),
                (["gas", "future_option", "[1]"], "scalar", 2),
            ],
        )
        explicit_paths = [
            field["path"]
            for section in document["sections"]
            if section["source"] == "explicit"
            for field in section["fields"]
        ]
        self.assertIn(["gas", "functional"], explicit_paths)
        self.assertIn(["solv", "basis"], explicit_paths)
        self.assertTrue(
            any(section["source"] == "inherited" for section in document["sections"])
        )
        self.assertEqual(list(self.root.iterdir()), before)

    def test_document_route_reads_the_verified_file_without_a_path_field(self) -> None:
        self.write_fixture("gaussian", "b3lyp-water")

        result = document_project(
            {
                "projectName": "b3lyp-water",
                "program": "gaussian",
                "extensions": {},
            }
        )

        self.assertEqual(result["projectName"], "b3lyp-water")
        self.assertEqual(result["program"], "gaussian")
        self.assertEqual(result["yamlText"], GAUSSIAN_PROJECT)
        self.assertNotIn(str(self.root), repr(result))

    def test_defaults_is_reserved_for_loader_settings(self) -> None:
        with self.assertRaises(ValueError):
            project_document("defaults", "gaussian", GAUSSIAN_PROJECT)

    def test_missing_project_raises_without_returning_resolution_details(self) -> None:
        with self.assertRaisesRegex(ValueError, "project could not be read"):
            read_project(
                {
                    "projectName": "absent",
                    "program": "gaussian",
                    "extensions": {},
                }
            )

    def test_symlink_project_is_rejected_before_upstream_read(self) -> None:
        folder = self.root / ".chemsmart" / "gaussian"
        folder.mkdir(parents=True)
        secret = self.root / "private.yaml"
        secret.write_text("secret: must-not-cross-the-boundary\n", encoding="utf-8")
        (folder / "linked.yaml").symlink_to(secret)
        request = {
            "projectName": "linked",
            "program": "gaussian",
            "extensions": {},
        }

        with patch(
            "chemsmart_studio_bridge.project_workspace.validate_project_yaml"
        ) as upstream_validation:
            with self.assertRaises(ValueError) as raised:
                read_project(request)

        upstream_validation.assert_not_called()
        self.assertNotIn("must-not-cross-the-boundary", str(raised.exception))
        self.assertNotIn(str(secret), str(raised.exception))

    def test_oversized_project_is_rejected_before_upstream_read(self) -> None:
        folder = self.root / ".chemsmart" / "gaussian"
        folder.mkdir(parents=True)
        project = folder / "oversized.yaml"
        project.write_bytes(b"x" * (MAX_YAML_BYTES + 1))
        request = {
            "projectName": "oversized",
            "program": "gaussian",
            "extensions": {},
        }

        with patch(
            "chemsmart_studio_bridge.project_workspace.validate_project_yaml"
        ) as upstream_validation:
            with self.assertRaises(ValueError) as raised:
                read_project(request)

        upstream_validation.assert_not_called()
        self.assertNotIn(str(project), str(raised.exception))

    def test_rejects_project_replaced_after_verified_descriptor_is_opened(self) -> None:
        self.write_fixture("gaussian", "swapped")
        folder = self.root / ".chemsmart" / "gaussian"
        project = folder / "swapped.yaml"
        original = folder / "original.yaml"
        replacement = self.root / "private.yaml"
        replacement.write_text(
            "secret: must-not-cross-the-boundary\n",
            encoding="utf-8",
        )
        request = {
            "projectName": "swapped",
            "program": "gaussian",
            "extensions": {},
        }
        real_open = os.open

        def open_then_swap(
            path: os.PathLike[str],
            flags: int,
            mode: int = 0o777,
            *,
            dir_fd: int | None = None,
        ) -> int:
            descriptor = real_open(path, flags, mode, dir_fd=dir_fd)
            if path == "swapped.yaml":
                project.rename(original)
                project.symlink_to(replacement)
            return descriptor

        with (
            patch(
                "chemsmart_studio_bridge.project_workspace.os.open",
                side_effect=open_then_swap,
            ),
            patch(
                "chemsmart_studio_bridge.project_workspace.validate_project_yaml"
            ) as upstream_validation,
        ):
            with self.assertRaises(ValueError) as raised:
                read_project(request)

        upstream_validation.assert_not_called()
        self.assertNotIn("must-not-cross-the-boundary", str(raised.exception))
        self.assertNotIn(str(replacement), str(raised.exception))

    def test_program_directory_swap_cannot_list_or_read_outside_yaml(self) -> None:
        self.write_fixture("gaussian", "trusted")
        folder = self.root / ".chemsmart" / "gaussian"
        original = self.root / ".chemsmart" / "gaussian-owned"
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "private.yaml").write_text(
            "secret: must-not-cross-the-boundary\n",
            encoding="utf-8",
        )
        (outside / "trusted.yaml").write_text(
            "secret: must-not-cross-the-boundary\n",
            encoding="utf-8",
        )
        real_trusted_root = project_workspace._trusted_project_root

        swaps = 0

        def trusted_root_then_swap(
            program: str,
        ) -> project_workspace._ProjectRoot | None:
            nonlocal swaps
            descriptors = real_trusted_root(program)
            if program == "gaussian" and descriptors is not None:
                folder.rename(original)
                folder.symlink_to(outside, target_is_directory=True)
                swaps += 1
            return descriptors

        with patch(
            "chemsmart_studio_bridge.project_workspace._trusted_project_root",
            side_effect=trusted_root_then_swap,
        ):
            with self.assertRaisesRegex(
                ValueError,
                "project workspace changed while being read",
            ):
                list_projects()

        self.assertEqual(swaps, 1)
        self.assertTrue(folder.is_symlink())
        folder.unlink()
        original.rename(folder)
        with (
            patch(
                "chemsmart_studio_bridge.project_workspace._trusted_project_root",
                side_effect=trusted_root_then_swap,
            ),
            patch(
                "chemsmart_studio_bridge.project_workspace.validate_project_yaml"
            ) as upstream_validation,
        ):
            with self.assertRaisesRegex(
                ValueError,
                "project workspace changed while being read",
            ) as raised:
                read_project(
                    {
                        "projectName": "trusted",
                        "program": "gaussian",
                        "extensions": {},
                    }
                )

        self.assertEqual(swaps, 2)
        self.assertTrue(folder.is_symlink())
        upstream_validation.assert_not_called()
        self.assertNotIn("must-not-cross-the-boundary", str(raised.exception))
        self.assertNotIn(str(outside), str(raised.exception))

    def test_refuses_invalid_names_and_programs(self) -> None:
        for name in ("", "../escape", "nested/name", ".hidden"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                read_project(
                    {
                        "projectName": name,
                        "program": "gaussian",
                        "extensions": {},
                    }
                )
        with self.assertRaises(ValueError):
            read_project(
                {
                    "projectName": "demo",
                    "program": "psi4",
                    "extensions": {},
                }
            )

    def test_validation_reports_without_writing_anything(self) -> None:
        before = list(self.root.iterdir())

        result = validate_project(
            {
                "yamlText": GAUSSIAN_PROJECT,
                "program": "gaussian",
                "projectName": "candidate",
                "extensions": {},
            }
        )

        self.assertIn(result["verdict"], {"ok", "warn", "reject"})
        self.assertEqual(result["schemaVersion"], "1")
        self.assertEqual(list(self.root.iterdir()), before)
        self.assertNotIn(str(self.root), repr(result))

    def test_validation_and_critique_redact_absolute_diagnostic_paths(self) -> None:
        raw = {
            "verdict": "reject",
            "issues": [
                {
                    "rule_id": "yaml.invalid",
                    "severity": "reject",
                    "message": f"Invalid source at {self.root}/private.yaml",
                }
            ],
            "error": f"Could not read {self.root}/private.yaml",
            "summary": f"Review {self.root}/private.yaml",
        }
        request = {
            "yamlText": GAUSSIAN_PROJECT,
            "program": "gaussian",
            "projectName": "candidate",
            "extensions": {},
        }

        with patch(
            "chemsmart_studio_bridge.project_workspace.validate_project_yaml",
            return_value=raw,
        ):
            validated = validate_project(request)
        with patch(
            "chemsmart_studio_bridge.project_workspace.critic_project_yaml",
            return_value=raw,
        ):
            critiqued = critic_project(request)

        self.assertNotIn(str(self.root), repr(validated))
        self.assertNotIn(str(self.root), repr(critiqued))
        self.assertIn("<private-path>", repr(validated))
        self.assertIn("<private-path>", repr(critiqued))

    def test_refuses_empty_or_oversized_yaml(self) -> None:
        base = {
            "projectName": "candidate",
            "program": "gaussian",
            "extensions": {},
        }
        with self.assertRaises(ValueError):
            validate_project({**base, "yamlText": "   "})
        with self.assertRaises(ValueError):
            validate_project({**base, "yamlText": "a" * 20_001})


if __name__ == "__main__":
    unittest.main()
