"""Workspace method projects for Studio, with filesystem paths kept out of the answer.

chemsmart resolves Gaussian and ORCA project YAML relative to the working directory, which Studio owns.
These helpers expose that store to Studio by project *name*: a renderer never receives a path, so a
researcher's directory layout cannot leak through the agent surface.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import stat
from typing import Any

import yaml

from chemsmart.agent.project_yaml import (
    critic_project_yaml,
    validate_project_yaml,
)
from chemsmart.settings.workspace_project import (
    workspace_project_dir,
)

MAX_YAML_CHARS = 20_000
MAX_YAML_BYTES = MAX_YAML_CHARS * 4
PROJECT_PROGRAMS = ("gaussian", "orca")
LISTED_PROGRAMS = (*PROJECT_PROGRAMS, "xtb")
_SECTION_LABELS = {
    "gas": "Gas phase",
    "solv": "Solution phase",
    "td": "Excited states",
    "qmmm": "QM/MM",
    "defaults": "Effective defaults",
    "opt": "Effective optimization",
    "ts": "Effective transition state",
    "sp": "Effective single point",
}
_ROOT_SECTIONS = frozenset({"gas", "solv", "td", "qmmm"})
_RECOGNIZED_FIELDS = frozenset(
    {
        "ab_initio",
        "additional_opt_options_in_route",
        "additional_route_parameters",
        "additional_solvent_options",
        "append_additional_info",
        "aux_basis",
        "basis",
        "charge",
        "charge_high",
        "charge_intermediate",
        "charge_total",
        "chk",
        "custom_solvent",
        "defgrid",
        "delete_la_double_counting",
        "dieze_tag",
        "dipole",
        "dispersion",
        "embedding_type",
        "extrapolation_basis",
        "forces",
        "freq",
        "functional",
        "gbw",
        "gen_genecp",
        "gen_genecp_file",
        "heavy_elements",
        "heavy_elements_basis",
        "high_level_basis",
        "high_level_functional",
        "input_string",
        "intermediate_level_atoms",
        "intermediate_level_basis",
        "intermediate_level_functional",
        "invert_constraints",
        "job_type",
        "jobtype",
        "light_elements_basis",
        "low_level_force_field",
        "mdci_cutoff",
        "mdci_density",
        "medium_level_basis",
        "medium_level_functional",
        "mm_force_field",
        "modred",
        "mult_high",
        "mult_intermediate",
        "mult_total",
        "multiplicity",
        "numfreq",
        "quadrupole",
        "qm2_basis",
        "qm2_functional",
        "qm_basis",
        "qm_functional",
        "route_to_be_written",
        "scf_algorithm",
        "scf_convergence",
        "scf_maxiter",
        "scf_tol",
        "semiempirical",
        "solvent_id",
        "solvent_model",
        "solventfilename",
        "title",
    }
)
_MAX_PROJECTED_FIELDS = 4096
_MAX_PROJECTED_DEPTH = 32
_ProjectRoot = tuple[int, int, int]
_DIRECTORY_OPEN_FLAGS = (
    os.O_RDONLY
    | os.O_DIRECTORY
    | os.O_NOFOLLOW
    | getattr(os, "O_CLOEXEC", 0)
)


def _public_message(value: Any, fallback: str) -> str:
    """Keep useful diagnostics while removing absolute path-shaped tokens."""

    text = str(value or "").strip() or fallback
    text = re.sub(r"(?<![A-Za-z0-9_.-])/(?:[^\s'\"`]+)", "<private-path>", text)
    text = re.sub(
        r"(?<![A-Za-z0-9_.-])[A-Za-z]:\\(?:[^\s'\"`]+)",
        "<private-path>",
        text,
    )
    return text[:2048]


def _public_issues(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    issues: list[dict[str, Any]] = []
    for item in value[:256]:
        if not isinstance(item, dict):
            continue
        rule_id = str(item.get("rule_id") or "project.validation").strip()
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9._-]*", rule_id):
            rule_id = "project.validation"
        severity = str(item.get("severity") or "info").strip()
        if severity not in {"info", "warn", "reject"}:
            severity = "info"
        issues.append(
            {
                "ruleId": rule_id[:256],
                "severity": severity,
                "message": _public_message(
                    item.get("message"),
                    f"ChemSmart reported project rule {rule_id}.",
                ),
                "extensions": {},
            }
        )
    return issues


def _program(value: Any, *, default: str = "") -> str:
    program = str(value or default).strip().lower()
    if program and program not in PROJECT_PROGRAMS:
        raise ValueError(f"unknown project program: {program}")
    return program


def _project_name(value: Any) -> str:
    name = str(value or "").strip()
    if (
        not name
        or len(name) > 128
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name)
        or name.lower() == "defaults"
    ):
        raise ValueError("invalid project name")
    return name


def _node_id(prefix: str, path: list[str]) -> str:
    digest = hashlib.sha256("\0".join(path).encode("utf-8")).hexdigest()[:24]
    return f"{prefix}-{digest}"


def _field_label(path: list[str]) -> str:
    value = path[-1]
    if value.startswith("["):
        value = path[-2] if len(path) > 1 else "Value"
    return value.replace("_", " ").strip().title()[:2048] or "Value"


def _scalar_projection(value: Any) -> tuple[str, Any]:
    if value is None:
        return "null", None
    if isinstance(value, bool):
        return "boolean", value
    if isinstance(value, (int, float)):
        return "number", value
    return "string", str(value)[:12000]


def _flatten_projected_fields(
    value: Any,
    path: list[str],
    *,
    source: str,
    recognized_root: bool,
    output: list[dict[str, Any]],
) -> None:
    if len(path) > _MAX_PROJECTED_DEPTH:
        raise ValueError("project YAML nesting is too deep")
    if len(output) >= _MAX_PROJECTED_FIELDS:
        raise ValueError("project YAML contains too many values")
    if isinstance(value, dict):
        for key, child in value.items():
            _flatten_projected_fields(
                child,
                [*path, str(key)[:256] or "<empty-key>"],
                source=source,
                recognized_root=recognized_root,
                output=output,
            )
        return
    if isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            _flatten_projected_fields(
                child,
                [*path, f"[{index}]"],
                source=source,
                recognized_root=recognized_root,
                output=output,
            )
        return

    kind, projected_value = _scalar_projection(value)
    key = next((part for part in reversed(path) if not part.startswith("[")), "")
    recognized = recognized_root and (
        key in _RECOGNIZED_FIELDS or (len(path) == 1 and key in _ROOT_SECTIONS)
    )
    field = {
        "id": _node_id("field", path),
        "label": _field_label(path),
        "path": path,
        "kind": kind,
        "value": projected_value,
        "source": source,
        "recognized": recognized,
        "extensions": {},
    }
    output.append(field)


def _unknown_node(value: Any, path: list[str]) -> dict[str, Any]:
    """Preserve an unrecognized YAML branch in source order without making it authoritative."""

    if len(path) > _MAX_PROJECTED_DEPTH:
        raise ValueError("project YAML nesting is too deep")
    if isinstance(value, dict):
        children = [
            _unknown_node(child, [*path, str(key)[:256] or "<empty-key>"])
            for key, child in value.items()
        ]
        kind, projected_value = "mapping", None
    elif isinstance(value, (list, tuple)):
        children = [_unknown_node(child, [*path, f"[{index}]"]) for index, child in enumerate(value)]
        kind, projected_value = "sequence", None
    else:
        children = []
        kind, projected_value = "scalar", _scalar_projection(value)[1]
    return {
        "id": _node_id("unknown", path),
        "path": path,
        "kind": kind,
        "value": projected_value,
        "children": children,
        "source": "explicit",
        "extensions": {},
    }


def _collect_unknown_nodes(parsed: dict[Any, Any]) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for raw_key, value in parsed.items():
        key = str(raw_key)[:256] or "<empty-key>"
        if key not in _ROOT_SECTIONS and key not in _RECOGNIZED_FIELDS:
            nodes.append(_unknown_node(value, [key]))
            continue
        if key not in _ROOT_SECTIONS or not isinstance(value, dict):
            continue
        for raw_child_key, child in value.items():
            child_key = str(raw_child_key)[:256] or "<empty-key>"
            if child_key not in _RECOGNIZED_FIELDS:
                nodes.append(_unknown_node(child, [key, child_key]))
    return nodes


def _document_validation(
    validation: dict[str, Any],
    project_name: str,
) -> dict[str, Any]:
    verdict = str(validation.get("verdict") or "reject")
    if verdict not in {"ok", "warn", "reject"}:
        verdict = "reject"
    issues = _public_issues(validation.get("issues"))
    return {
        "verdict": verdict,
        "issues": issues,
        "message": _public_message(
            validation.get("error"),
            (
                f"{project_name} passed ChemSmart validation."
                if verdict == "ok"
                else f"{project_name} validation returned {verdict} with {len(issues)} issue(s)."
            ),
        ),
        "extensions": {},
    }


def project_document(
    project_name: str,
    program: str,
    yaml_text: str,
) -> dict[str, Any]:
    """Project every scalar without changing the authoritative raw YAML."""

    project_name = _project_name(project_name)
    program = _program(program)
    if not isinstance(yaml_text, str) or not yaml_text.strip():
        raise ValueError("yaml must be a non-empty string")
    if len(yaml_text) > MAX_YAML_CHARS:
        raise ValueError("yaml is too large to project")
    validation = validate_project_yaml(yaml_text, program, project_name)
    sections: list[dict[str, Any]] = []
    unknown_nodes: list[dict[str, Any]] = []
    try:
        parsed = yaml.safe_load(yaml_text)
    except yaml.YAMLError:
        parsed = None

    if isinstance(parsed, dict):
        unknown_nodes = _collect_unknown_nodes(parsed)
        top_level_fields: list[dict[str, Any]] = []
        for raw_key, value in parsed.items():
            key = str(raw_key)[:256] or "<empty-key>"
            if key in _ROOT_SECTIONS:
                fields: list[dict[str, Any]] = []
                _flatten_projected_fields(
                    value,
                    [key],
                    source="explicit",
                    recognized_root=True,
                    output=fields,
                )
                sections.append(
                    {
                        "id": _node_id("section", [key]),
                        "label": _SECTION_LABELS[key],
                        "source": "explicit",
                        "fields": fields,
                        "extensions": {},
                    }
                )
                continue
            if key not in _RECOGNIZED_FIELDS:
                continue
            _flatten_projected_fields(
                value,
                [key],
                source="explicit",
                recognized_root=key in _RECOGNIZED_FIELDS,
                output=top_level_fields,
            )
        if top_level_fields:
            sections.insert(
                0,
                {
                    "id": _node_id("section", ["defaults"]),
                    "label": _SECTION_LABELS["defaults"],
                    "source": "explicit",
                    "fields": top_level_fields,
                    "extensions": {},
                },
            )

    runtime_summary = validation.get("runtime_summary")
    if isinstance(runtime_summary, dict):
        for raw_key, value in runtime_summary.items():
            key = str(raw_key)[:256] or "effective"
            fields = []
            _flatten_projected_fields(
                value,
                [key],
                source="inherited",
                recognized_root=True,
                output=fields,
            )
            sections.append(
                {
                    "id": _node_id("section", ["inherited", key]),
                    "label": _SECTION_LABELS.get(
                        key,
                        f"Effective {_field_label([key]).lower()}",
                    ),
                    "source": "inherited",
                    "fields": fields,
                    "extensions": {},
                }
            )

    return {
        "schemaVersion": "2",
        "projectName": project_name,
        "program": program,
        "digest": hashlib.sha256(yaml_text.encode("utf-8")).hexdigest(),
        "yamlText": yaml_text,
        "sections": sections,
        "validation": _document_validation(validation, project_name),
        "unknownNodes": unknown_nodes,
        "extensions": {},
    }


def _close_project_root(descriptors: _ProjectRoot) -> None:
    for descriptor in reversed(descriptors):
        os.close(descriptor)


def _trusted_project_root(program: str) -> _ProjectRoot | None:
    root = workspace_project_dir(program)
    workspace_name = root.parent.name
    program_name = root.name
    if workspace_name != ".chemsmart" or program_name != program:
        raise ValueError("project workspace is unsafe")

    descriptors: list[int] = []
    try:
        current_descriptor = os.open(".", _DIRECTORY_OPEN_FLAGS)
        descriptors.append(current_descriptor)
        workspace_descriptor = os.open(
            workspace_name,
            _DIRECTORY_OPEN_FLAGS,
            dir_fd=current_descriptor,
        )
        descriptors.append(workspace_descriptor)
        root_descriptor = os.open(
            program_name,
            _DIRECTORY_OPEN_FLAGS,
            dir_fd=workspace_descriptor,
        )
        descriptors.append(root_descriptor)
    except FileNotFoundError:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        return None
    except OSError as error:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        raise ValueError("project workspace is unsafe") from error

    try:
        if any(
            not stat.S_ISDIR(os.fstat(descriptor).st_mode)
            for descriptor in descriptors
        ):
            raise ValueError("project workspace is unsafe")
    except (OSError, ValueError):
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        raise
    return current_descriptor, workspace_descriptor, root_descriptor


def _validate_project_root(program: str, descriptors: _ProjectRoot) -> None:
    current_descriptor, workspace_descriptor, root_descriptor = descriptors
    root = workspace_project_dir(program)
    try:
        workspace_metadata = os.fstat(workspace_descriptor)
        root_metadata = os.fstat(root_descriptor)
        current_workspace_metadata = os.stat(
            root.parent.name,
            dir_fd=current_descriptor,
            follow_symlinks=False,
        )
        current_root_metadata = os.stat(
            root.name,
            dir_fd=workspace_descriptor,
            follow_symlinks=False,
        )
    except OSError as error:
        raise ValueError("project workspace changed while being read") from error
    if (
        not stat.S_ISDIR(current_workspace_metadata.st_mode)
        or not stat.S_ISDIR(current_root_metadata.st_mode)
        or (workspace_metadata.st_dev, workspace_metadata.st_ino)
        != (current_workspace_metadata.st_dev, current_workspace_metadata.st_ino)
        or (root_metadata.st_dev, root_metadata.st_ino)
        != (current_root_metadata.st_dev, current_root_metadata.st_ino)
    ):
        raise ValueError("project workspace changed while being read")


def _read_project_file(program: str, project_name: str) -> str:
    project_root = _trusted_project_root(program)
    if project_root is None:
        raise ValueError("project could not be read")
    root_descriptor = project_root[2]
    target_name = f"{project_name}.yaml"
    try:
        try:
            path_metadata = os.stat(
                target_name,
                dir_fd=root_descriptor,
                follow_symlinks=False,
            )
        except (FileNotFoundError, OSError) as error:
            raise ValueError("project could not be read") from error
        if stat.S_ISLNK(path_metadata.st_mode) or not stat.S_ISREG(
            path_metadata.st_mode
        ):
            raise ValueError("project file is unsafe")

        flags = (
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            descriptor = os.open(
                target_name,
                flags,
                dir_fd=root_descriptor,
            )
        except OSError as error:
            raise ValueError("project file is unsafe") from error
        try:
            opened_metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened_metadata.st_mode)
                or (path_metadata.st_dev, path_metadata.st_ino)
                != (opened_metadata.st_dev, opened_metadata.st_ino)
            ):
                raise ValueError("project file is unsafe")
            if opened_metadata.st_size > MAX_YAML_BYTES:
                raise ValueError("project file is too large")
            chunks: list[bytes] = []
            remaining = MAX_YAML_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(64 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            payload = b"".join(chunks)
            if len(payload) > MAX_YAML_BYTES:
                raise ValueError("project file is too large")

            final_metadata = os.fstat(descriptor)
            try:
                final_path_metadata = os.stat(
                    target_name,
                    dir_fd=root_descriptor,
                    follow_symlinks=False,
                )
            except OSError as error:
                raise ValueError("project file is unsafe") from error
            if (
                not stat.S_ISREG(final_metadata.st_mode)
                or (opened_metadata.st_dev, opened_metadata.st_ino)
                != (final_metadata.st_dev, final_metadata.st_ino)
                or (final_path_metadata.st_dev, final_path_metadata.st_ino)
                != (final_metadata.st_dev, final_metadata.st_ino)
                or (
                    opened_metadata.st_size,
                    opened_metadata.st_mtime_ns,
                    opened_metadata.st_ctime_ns,
                )
                != (
                    final_metadata.st_size,
                    final_metadata.st_mtime_ns,
                    final_metadata.st_ctime_ns,
                )
                or final_metadata.st_size != len(payload)
            ):
                raise ValueError("project file changed while being read")
            _validate_project_root(program, project_root)
        except OSError as error:
            raise ValueError("project file is unsafe") from error
        finally:
            os.close(descriptor)
    finally:
        _close_project_root(project_root)

    try:
        yaml_text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("project file is not valid UTF-8") from error
    if not yaml_text.strip():
        raise ValueError("project could not be read")
    if len(yaml_text) > MAX_YAML_CHARS:
        raise ValueError("project file is too large")
    return yaml_text


def _listable_project_name(root_descriptor: int, name: str) -> str | None:
    # ChemSmart resolves method projects as <name>.yaml. Do not advertise a
    # .yml entry that the closed name-based read contract cannot open.
    path = Path(name)
    if path.suffix.lower() != ".yaml":
        return None
    if path.stem.lower() == "defaults":
        return None
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", path.stem):
        return None
    try:
        metadata = os.stat(
            name,
            dir_fd=root_descriptor,
            follow_symlinks=False,
        )
    except OSError:
        return None
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_YAML_BYTES:
        return None
    return path.stem


def list_projects() -> dict[str, Any]:
    """Every method project the workspace holds, grouped by program."""
    programs: list[dict[str, Any]] = []
    for program in LISTED_PROGRAMS:
        names: list[str] = []
        if program != "xtb":
            project_root = _trusted_project_root(program)
            if project_root is not None:
                root_descriptor = project_root[2]
                try:
                    names = sorted(
                        project_name
                        for name in os.listdir(root_descriptor)
                        if (
                            project_name := _listable_project_name(
                                root_descriptor,
                                name,
                            )
                        )
                        is not None
                    )
                    _validate_project_root(program, project_root)
                except OSError as error:
                    raise ValueError("project workspace is unsafe") from error
                finally:
                    _close_project_root(project_root)
        programs.append(
            {
                "program": program,
                "projectNames": names,
                "projectRequired": program != "xtb",
                "extensions": {},
            }
        )
    return {"schemaVersion": "1", "programs": programs, "extensions": {}}


def read_project(params: Any) -> dict[str, Any]:
    params = params if isinstance(params, dict) else {}
    project_name = _project_name(params.get("projectName"))
    program = _program(params.get("program"))
    yaml_text = _read_project_file(program, project_name)
    # Preserve ChemSmart's public validation semantics without handing it the
    # path again: path-based read/selection helpers reopen the verified file.
    validate_project_yaml(yaml_text, program, project_name)
    return {
        "schemaVersion": "1",
        "projectName": project_name,
        "program": program,
        "yamlText": yaml_text,
        "extensions": {},
    }


def document_project(params: Any) -> dict[str, Any]:
    params = params if isinstance(params, dict) else {}
    project_name = _project_name(params.get("projectName"))
    program = _program(params.get("program"))
    return project_document(
        project_name,
        program,
        _read_project_file(program, project_name),
    )


def _yaml_text(params: dict[str, Any]) -> str:
    text = params.get("yamlText")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("yaml must be a non-empty string")
    if len(text) > MAX_YAML_CHARS:
        raise ValueError("yaml is too large to validate")
    return text


def validate_project(params: Any) -> dict[str, Any]:
    params = params if isinstance(params, dict) else {}
    project_name = _project_name(params.get("projectName"))
    program = _program(params.get("program"))
    result = validate_project_yaml(
        _yaml_text(params),
        program,
        project_name,
    )
    verdict = str(result.get("verdict") or "reject")
    if verdict not in {"ok", "warn", "reject"}:
        verdict = "reject"
    issues = _public_issues(result.get("issues"))
    return {
        "schemaVersion": "1",
        "projectName": project_name,
        "program": program,
        "verdict": verdict,
        "issues": issues,
        "message": _public_message(
            result.get("error"),
            (
                "Project YAML passed ChemSmart validation."
                if verdict == "ok"
                else f"Project YAML validation returned {verdict} with {len(issues)} issue(s)."
            ),
        ),
        "extensions": {},
    }


def critic_project(params: Any) -> dict[str, Any]:
    params = params if isinstance(params, dict) else {}
    project_name = _project_name(params.get("projectName"))
    program = _program(params.get("program"))
    result = critic_project_yaml(
        _yaml_text(params),
        None,
        program,
        project_name,
    )
    verdict = str(result.get("verdict") or "reject")
    if verdict not in {"ok", "warn", "reject"}:
        verdict = "reject"
    issues = _public_issues(result.get("issues"))
    return {
        "schemaVersion": "1",
        "projectName": project_name,
        "program": program,
        "verdict": verdict,
        "issues": issues,
        "summary": _public_message(
            result.get("summary"),
            f"Project critique returned {verdict} with {len(issues)} issue(s).",
        )[:12000],
        "unsupportedFeatures": [],
        "extensions": {},
    }
