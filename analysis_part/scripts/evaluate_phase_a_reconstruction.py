#!/usr/bin/env python3
"""Generate Phase A reconstruction evaluation tables.

This evaluates the same disk/session structures used by the workbench and the
strict memory-only outputs produced by the memory miner. Raw evidence is read
only; outputs are written under analysis/aggregate.
"""

from __future__ import annotations

import csv
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_ROOT = ROOT / "evidence_archive"
ANALYSIS_ROOT = ROOT / "analysis" / "runs"
MEMORY_ROOT = ROOT / "analysis" / "memory"
OUT_ROOT = ROOT / "analysis" / "aggregate"

RUN_ORDER = [
    "CLAUDE-WIN-A-PROMPT-NOTOOL-R01",
    "CLAUDE-WIN-A-READ-FILE-R01",
    "CLAUDE-WIN-A-EDIT-FILE-R01",
    "CLAUDE-WIN-A-SHELL-COMMAND-R01",
    "CLAUDE-WIN-A-MULTIFILE-CREATE-R01",
    "CLAUDE-WIN-A-SETTINGS-READ-R01",
    "CLAUDE-WIN-A-CLAUDEMD-R01",
    "CLAUDE-WIN-A-MCP-BENIGN-R01",
    "CLAUDE-WIN-A-HOOK-BENIGN-R01",
    "CLAUDE-WIN-A-WEBFETCH-BENIGN-R01",
    "CLAUDE-WIN-A-SKILL-BENIGN-R01",
]

EXPECTED_CHAIN_BY_SCENARIO = {
    "PROMPT-NOTOOL": "prompt_only",
    "READ-FILE": "file_read",
    "EDIT-FILE": "file_write",
    "SHELL-COMMAND": "shell",
    "MULTIFILE-CREATE": "file_write",
    "SETTINGS-READ": "settings_read",
    "CLAUDEMD": "claudemd",
    "MCP-BENIGN": "mcp",
    "HOOK-BENIGN": "hook",
    "WEBFETCH-BENIGN": "webfetch",
    "SKILL-BENIGN": "skill",
}

MEMORY_BATCH_DIRS = [
    MEMORY_ROOT / "_memory_only_strict_pilot_v2",
    MEMORY_ROOT / "_memory_only_strict_remaining",
]

MEMORY_CLASSES = [
    "history_jsonl",
    "session_jsonl_graph",
    "assistant_response",
    "account_identity",
    "oauth_credentials",
    "runtime_session_state",
    "capability_surface",
    "tool_use",
    "tool_result",
    "api_metrics_debug",
]


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_markdown_table(path: Path, title: str, rows: list[dict[str, Any]], cols: list[str]) -> None:
    lines = [
        f"# {title}",
        "",
        "Scores: `E`=exact/complete, `P`=partial, `I`=isolated, `N`=not recovered, `X`=not applicable.",
        "",
        "|" + "|".join(cols) + "|",
        "|" + "|".join(["---"] * len(cols)) + "|",
    ]
    for row in rows:
        lines.append("|" + "|".join(str(row.get(c, "")).replace("|", "\\|") for c in cols) + "|")
    path.write_text("\n".join(lines), encoding="utf-8")


def ground_truth(run_id: str) -> dict[str, str]:
    extracted = EVIDENCE_ROOT / run_id / "extracted"
    files = list(extracted.glob("ground_truth_*.md"))
    text = read_text(files[0]) if files else ""
    out = {
        "ground_truth_path": str(files[0]) if files else "",
        "controlled_prompt": "",
        "marker": "",
        "project_path": "",
        "scenario": "",
        "type": "",
    }
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip().strip('"')
        if key in {"CONTROLLED_PROMPT", "PROMPT1_TEXT"}:
            out["controlled_prompt"] = value
        elif key in {"MARKERS", "EXPECTED_MARKER", "MARKER STRING", "EXPECTED HOOK MARKER"}:
            out["marker"] = first_marker(value)
        elif key == "PROJECT_PATH":
            out["project_path"] = value
        elif key in {"PROBE_OR_SCENARIO", "SCENARIO"}:
            out["scenario"] = value
        elif key in {"TYPE", "EXPERIMENT TYPE"}:
            out["type"] = value
    if not out["scenario"]:
        for scenario in EXPECTED_CHAIN_BY_SCENARIO:
            if scenario in run_id:
                out["scenario"] = scenario
                break
    if not out["marker"]:
        out["marker"] = first_marker(text)
    return out


def first_marker(text: str) -> str:
    match = re.search(r"CLAUDE[A-Z0-9_\-]*R01", text or "")
    return match.group(0) if match else ""


def findings_text(run_id: str) -> str:
    return read_text(ANALYSIS_ROOT / run_id / "findings.json")


def expected_chain(run_id: str, scenario: str) -> str:
    upper = (scenario or "").upper()
    for key, value in EXPECTED_CHAIN_BY_SCENARIO.items():
        if key in upper or key in run_id:
            return value
    return "unknown"


def project_jsonl_files(run_id: str) -> list[Path]:
    root = (
        EVIDENCE_ROOT
        / run_id
        / "extracted"
        / "evidence"
        / "agent"
        / "user_dot_claude"
        / "projects"
    )
    return sorted(root.glob("*/*.jsonl")) if root.exists() else []


def primary_project_jsonl(run_id: str) -> Path | None:
    files = project_jsonl_files(run_id)
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_size)


def load_jsonl(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    objects: list[dict[str, Any]] = []
    raw_lines: list[str] = []
    for line_no, line in enumerate(read_text(path).splitlines(), 1):
        if not line.strip():
            continue
        raw_lines.append(line)
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            obj["_line"] = line_no
            obj["_source"] = str(path)
            objects.append(obj)
    return objects, raw_lines


def message_items(obj: dict[str, Any]) -> list[dict[str, Any]]:
    message = obj.get("message") if isinstance(obj.get("message"), dict) else {}
    content = message.get("content")
    return [item for item in content if isinstance(item, dict)] if isinstance(content, list) else []


def text_content(obj: dict[str, Any]) -> str:
    message = obj.get("message") if isinstance(obj.get("message"), dict) else {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            parts.append(str(item.get("text") or item.get("content") or ""))
        return "\n".join(parts)
    return ""


def chain_from_tools(tool_names: list[str], attachments: list[str], prompt_text: str) -> str:
    real = [name for name in tool_names if name and name != "ToolSearch"]
    if any(name.startswith("mcp__") for name in real):
        return "mcp"
    if any(name in {"WebFetch", "WebSearch"} for name in real):
        return "webfetch"
    if any(name in {"Bash", "PowerShell"} for name in real):
        return "shell"
    if "hook_success" in attachments:
        return "hook"
    if any(name in {"Write", "Edit", "MultiEdit"} for name in real):
        return "file_write"
    if "Read" in real:
        return "settings_read" if "settings" in prompt_text.lower() else "file_read"
    if any(name in {"Glob", "Grep", "LS"} for name in real):
        return "claudemd"
    if "Skill" in real or "skill" in prompt_text.lower():
        return "skill"
    return "prompt_only"


def score_prompt(expected_prompt: str, raw_lines: list[str], prompts: list[str]) -> str:
    blob = "\n".join(raw_lines)
    if expected_prompt and expected_prompt in blob:
        return "E"
    if expected_prompt:
        prefix = " ".join(expected_prompt.split()[:6])
        if prefix and prefix in blob:
            return "P"
    return "P" if prompts else "N"


def score_pairing(tool_uses: list[dict[str, Any]], tool_results: list[dict[str, Any]]) -> str:
    if not tool_uses:
        return "X"
    use_ids = {item["id"] for item in tool_uses if item.get("id")}
    result_ids = {item["tool_use_id"] for item in tool_results if item.get("tool_use_id")}
    if use_ids and use_ids <= result_ids:
        return "E"
    if use_ids & result_ids:
        return "P"
    return "N"


def extract_targets(tool_uses: list[dict[str, Any]], tool_results: list[dict[str, Any]]) -> list[str]:
    targets: list[str] = []
    for tool in tool_uses:
        inp = tool.get("input") if isinstance(tool.get("input"), dict) else {}
        for key in ("file_path", "path", "command", "url", "query", "pattern"):
            if inp.get(key):
                targets.append(str(inp[key]))
    for result in tool_results:
        tur = result.get("toolUseResult")
        if not isinstance(tur, dict):
            continue
        for key in ("filePath", "url", "stdout", "stderr", "result"):
            if tur.get(key):
                targets.append(str(tur[key])[:200])
        file_obj = tur.get("file")
        if isinstance(file_obj, dict) and file_obj.get("filePath"):
            targets.append(str(file_obj["filePath"]))
    return targets


def marker_in_project(run_id: str, marker: str) -> tuple[bool, str]:
    if not marker:
        return False, ""
    root = EVIDENCE_ROOT / run_id / "extracted" / "evidence" / "project" / "project_copy"
    if not root.exists():
        return False, ""
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if marker in read_text(path):
            return True, str(path)
    return False, ""


def analyze_session(run_id: str) -> dict[str, Any]:
    gt = ground_truth(run_id)
    scenario = gt["scenario"]
    exp_chain = expected_chain(run_id, scenario)
    path = primary_project_jsonl(run_id)
    objects, raw_lines = load_jsonl(path) if path else ([], [])

    prompts: list[str] = []
    assistants: list[str] = []
    tool_uses: list[dict[str, Any]] = []
    tool_results: list[dict[str, Any]] = []
    attachments: list[str] = []
    capability_surfaces = 0

    for obj in objects:
        typ = obj.get("type")
        txt = text_content(obj)
        items = message_items(obj)
        if typ == "user" and txt and "<local-command" not in txt and not any(i.get("type") == "tool_result" for i in items):
            prompts.append(txt)
        if typ == "assistant":
            if txt:
                assistants.append(txt)
            for item in items:
                if item.get("type") == "tool_use":
                    tool_uses.append(
                        {
                            "id": item.get("id", ""),
                            "name": item.get("name", ""),
                            "input": item.get("input") if isinstance(item.get("input"), dict) else {},
                            "line": obj.get("_line"),
                        }
                    )
        for item in items:
            if item.get("type") == "tool_result":
                tool_results.append(
                    {
                        "tool_use_id": item.get("tool_use_id", ""),
                        "is_error": item.get("is_error"),
                        "content": item.get("content"),
                        "toolUseResult": obj.get("toolUseResult"),
                        "line": obj.get("_line"),
                    }
                )
        attachment = obj.get("attachment")
        if isinstance(attachment, dict):
            atype = str(attachment.get("type", ""))
            attachments.append(atype)
            if atype in {"deferred_tools_delta", "mcp_instructions_delta", "skill_listing"}:
                capability_surfaces += 1

    tool_names = [item["name"] for item in tool_uses]
    real_tool_names = [name for name in tool_names if name and name != "ToolSearch"]
    observed_chain = chain_from_tools(tool_names, attachments, gt["controlled_prompt"] or (prompts[0] if prompts else ""))
    marker = gt["marker"] or first_marker("\n".join(raw_lines) + findings_text(run_id))
    marker_session = bool(marker and marker in "\n".join(raw_lines))
    marker_project, marker_path = marker_in_project(run_id, marker)

    prompt_score = score_prompt(gt["controlled_prompt"], raw_lines, prompts)
    response_score = "E" if assistants else "N"
    if exp_chain == "prompt_only":
        tool_sequence_score = "E" if not real_tool_names else "N"
    elif exp_chain == "skill" and not real_tool_names and assistants:
        tool_sequence_score = "X"
    else:
        tool_sequence_score = "E" if real_tool_names else ("P" if tool_names else "N")
    pairing_score = score_pairing(tool_uses, tool_results)
    targets = extract_targets(tool_uses, tool_results)
    target_score = "X" if exp_chain in {"prompt_only", "skill"} else ("E" if targets else "N")

    side_effect_score = "X"
    if exp_chain in {"file_write", "shell", "mcp", "hook", "webfetch", "skill"}:
        if exp_chain == "file_write":
            side_effect_score = "E" if any(n in {"Write", "Edit", "MultiEdit"} for n in real_tool_names) and tool_results else "N"
        elif exp_chain == "shell":
            side_effect_score = "E" if any("stdout" in json.dumps(r) or "stderr" in json.dumps(r) for r in tool_results) else ("P" if tool_results else "N")
        elif exp_chain == "mcp":
            side_effect_score = "E" if any("mcpMeta" in json.dumps(o) or "structuredContent" in json.dumps(o) for o in objects) else ("P" if tool_results else "N")
        elif exp_chain == "hook":
            side_effect_score = "E" if "hook_success" in attachments else ("P" if "hook" in "\n".join(raw_lines).lower() else "N")
        elif exp_chain == "webfetch":
            side_effect_score = "E" if any("code" in json.dumps(r.get("toolUseResult")) and "url" in json.dumps(r.get("toolUseResult")) for r in tool_results) else ("P" if tool_results else "N")
        elif exp_chain == "skill":
            side_effect_score = "E" if any("attributionSkill" in json.dumps(o) or "skill" in json.dumps(o).lower() for o in objects) else ("P" if assistants else "N")

    label_score = "E" if exp_chain == observed_chain or (exp_chain == "skill" and observed_chain in {"skill", "prompt_only"}) else ("P" if observed_chain != "prompt_only" and exp_chain != "prompt_only" else "N")
    if not marker:
        marker_score = "X"
    elif marker_session or marker_project:
        marker_score = "E"
    elif marker in findings_text(run_id):
        marker_score = "P"
    else:
        marker_score = "N"

    metric_scores = [
        prompt_score,
        response_score,
        tool_sequence_score,
        pairing_score,
        target_score,
        side_effect_score,
        label_score,
        marker_score,
    ]
    applicable = [score for score in metric_scores if score != "X"]
    if applicable and all(score == "E" for score in applicable):
        outcome = "Full"
    elif any(score in {"E", "P"} for score in applicable):
        outcome = "Partial"
    else:
        outcome = "Unresolved"

    notes: list[str] = []
    if observed_chain != exp_chain:
        notes.append(f"observed_chain={observed_chain}")
    if capability_surfaces:
        notes.append(f"capability_surfaces={capability_surfaces}; not counted as invocation")
    if targets:
        notes.append("targets=" + " | ".join(targets[:3]).replace("\n", " ")[:220])
    if marker_path:
        notes.append("marker_project=" + marker_path)

    return {
        "run_id": run_id,
        "scenario": scenario,
        "expected_chain": exp_chain,
        "observed_chain": observed_chain,
        "prompt_recovered": prompt_score,
        "assistant_response_recovered": response_score,
        "tool_sequence_recovered": tool_sequence_score,
        "tool_sequence": " > ".join(tool_names) or "(none)",
        "tool_use_result_pairing": pairing_score,
        "tool_use_count": len(tool_uses),
        "tool_result_count": len(tool_results),
        "actual_target_recovered": target_score,
        "side_effect_or_result_represented_in_jsonl": side_effect_score,
        "capability_label_correct": label_score,
        "marker_expected_location_recovered": marker_score,
        "marker": marker,
        "reconstruction_outcome": outcome,
        "primary_jsonl": str(path or ""),
        "notes": "; ".join(notes),
        "_objects": objects,
        "_tool_uses": tool_uses,
        "_tool_results": tool_results,
    }


def parser_integrity(run_id: str, analysis: dict[str, Any]) -> dict[str, Any]:
    objects = analysis["_objects"]
    uuid_nodes = {obj.get("uuid"): obj for obj in objects if obj.get("uuid")}
    roots = 0
    orphan_nodes: list[str] = []
    dangling_links: list[str] = []
    chained = 0
    for obj in objects:
        uuid = obj.get("uuid")
        if not uuid:
            continue
        parent = obj.get("parentUuid")
        if parent:
            chained += 1
            if parent not in uuid_nodes:
                orphan_nodes.append(str(uuid))
                dangling_links.append(str(parent))
        else:
            roots += 1
    tool_uses = analysis["_tool_uses"]
    tool_results = analysis["_tool_results"]
    use_ids = {item["id"] for item in tool_uses if item.get("id")}
    result_ids = {item["tool_use_id"] for item in tool_results if item.get("tool_use_id")}
    matched = len(use_ids & result_ids)
    pairing_rate = "X" if not use_ids else f"{matched / len(use_ids):.3f}"
    return {
        "run_id": run_id,
        "total_records": len(objects),
        "uuid_records": len(uuid_nodes),
        "chained_records": chained,
        "off_spine_records": len(objects) - len(uuid_nodes),
        "root_count": roots,
        "orphan_nodes": len(orphan_nodes),
        "dangling_parent_links": len(set(dangling_links)),
        "tool_use_count": len(use_ids),
        "tool_result_count": len(result_ids),
        "matched_tool_pairs": matched,
        "tool_pairing_rate": pairing_rate,
        "primary_jsonl": analysis["primary_jsonl"],
    }


def load_memory_rows(filename: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for directory in MEMORY_BATCH_DIRS:
        path = directory / filename
        if not path.exists():
            continue
        with path.open(newline="", encoding="utf-8", errors="replace") as f:
            rows.extend(csv.DictReader(f))
    return rows


def memory_recovery_rows() -> list[dict[str, Any]]:
    strict_rows = load_memory_rows("strict_reconstructed_objects.csv")
    candidate_rows = load_memory_rows("candidate_fragments.csv")
    strict_by_run: dict[str, Counter[str]] = {run: Counter() for run in RUN_ORDER}
    candidate_by_run: dict[str, Counter[str]] = {run: Counter() for run in RUN_ORDER}
    strict_total = Counter()
    candidate_total = Counter()
    hit_count_by_run = Counter()
    for row in strict_rows:
        run = row.get("run_id", "")
        cls = row.get("artifact_class", "")
        if run and cls:
            strict_by_run.setdefault(run, Counter())[cls] += 1
            strict_total[run] += 1
            try:
                hit_count_by_run[run] += int(row.get("hit_count", "0") or 0)
            except ValueError:
                pass
    for row in candidate_rows:
        run = row.get("run_id", "")
        cls = row.get("artifact_class", "")
        if run and cls:
            candidate_by_run.setdefault(run, Counter())[cls] += 1
            candidate_total[run] += 1

    rows: list[dict[str, Any]] = []
    for run in RUN_ORDER:
        gt = ground_truth(run)
        exp_chain = expected_chain(run, gt["scenario"])
        strict_counts = strict_by_run.get(run, Counter())
        candidate_counts = candidate_by_run.get(run, Counter())
        row: dict[str, Any] = {
            "run_id": run,
            "strict_object_count": strict_total[run],
            "candidate_fragment_count": candidate_total[run],
            "strict_duplicate_hit_count": hit_count_by_run[run],
        }
        for cls in MEMORY_CLASSES:
            if strict_counts[cls]:
                row[cls] = "E"
            elif candidate_counts[cls]:
                row[cls] = "P"
            else:
                row[cls] = "N"
        core_ok = row["history_jsonl"] == "E" and row["session_jsonl_graph"] == "E"
        if exp_chain == "prompt_only":
            full_ok = core_ok and row["assistant_response"] == "E"
        elif exp_chain == "skill":
            full_ok = core_ok and (row["assistant_response"] == "E" or row["tool_use"] == "E")
        else:
            full_ok = core_ok and row["tool_use"] == "E" and row["tool_result"] == "E"
        if full_ok:
            outcome = "Full"
        elif strict_total[run] > 0:
            outcome = "Partial"
        else:
            outcome = "Unresolved"
        row["memory_reconstruction_outcome"] = outcome
        row["strict_classes"] = ";".join(sorted(k for k, v in strict_counts.items() if v))
        rows.append(row)
    return rows


def main() -> None:
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    analyses = {run: analyze_session(run) for run in RUN_ORDER}

    disk_fields = [
        "run_id",
        "scenario",
        "expected_chain",
        "observed_chain",
        "prompt_recovered",
        "assistant_response_recovered",
        "tool_sequence_recovered",
        "tool_sequence",
        "tool_use_result_pairing",
        "tool_use_count",
        "tool_result_count",
        "actual_target_recovered",
        "side_effect_or_result_represented_in_jsonl",
        "capability_label_correct",
        "marker_expected_location_recovered",
        "marker",
        "reconstruction_outcome",
        "primary_jsonl",
        "notes",
    ]
    disk_rows = [{k: v for k, v in analyses[run].items() if not k.startswith("_")} for run in RUN_ORDER]
    write_csv(OUT_ROOT / "disk_only_evaluation_matrix.csv", disk_rows, disk_fields)
    write_markdown_table(
        OUT_ROOT / "disk_only_evaluation_matrix.md",
        "Disk-Only Evaluation Matrix",
        disk_rows,
        [
            "run_id",
            "expected_chain",
            "prompt_recovered",
            "tool_sequence_recovered",
            "tool_use_result_pairing",
            "actual_target_recovered",
            "side_effect_or_result_represented_in_jsonl",
            "capability_label_correct",
            "marker_expected_location_recovered",
            "reconstruction_outcome",
        ],
    )

    integrity_rows = [parser_integrity(run, analyses[run]) for run in RUN_ORDER]
    integrity_fields = [
        "run_id",
        "total_records",
        "uuid_records",
        "chained_records",
        "off_spine_records",
        "root_count",
        "orphan_nodes",
        "dangling_parent_links",
        "tool_use_count",
        "tool_result_count",
        "matched_tool_pairs",
        "tool_pairing_rate",
        "primary_jsonl",
    ]
    write_csv(OUT_ROOT / "parser_integrity_matrix.csv", integrity_rows, integrity_fields)
    write_markdown_table(
        OUT_ROOT / "parser_integrity_matrix.md",
        "Parser Integrity Matrix",
        integrity_rows,
        [
            "run_id",
            "total_records",
            "uuid_records",
            "off_spine_records",
            "root_count",
            "orphan_nodes",
            "dangling_parent_links",
            "tool_pairing_rate",
        ],
    )

    memory_rows = memory_recovery_rows()
    memory_fields = [
        "run_id",
        "strict_object_count",
        "candidate_fragment_count",
        "strict_duplicate_hit_count",
        *MEMORY_CLASSES,
        "memory_reconstruction_outcome",
        "strict_classes",
    ]
    write_csv(OUT_ROOT / "memory_recovery_matrix.csv", memory_rows, memory_fields)
    write_markdown_table(
        OUT_ROOT / "memory_recovery_matrix.md",
        "Memory Recovery Matrix",
        memory_rows,
        [
            "run_id",
            "strict_object_count",
            "candidate_fragment_count",
            "history_jsonl",
            "session_jsonl_graph",
            "assistant_response",
            "account_identity",
            "oauth_credentials",
            "tool_use",
            "tool_result",
            "memory_reconstruction_outcome",
        ],
    )

    summary = [
        "# Phase A Reconstruction Evaluation Summary",
        "",
        "Generated from project/session JSONL, ground truth files, and strict memory-only outputs.",
        "",
        "## Outputs",
        "",
        "- `disk_only_evaluation_matrix.csv/.md`",
        "- `parser_integrity_matrix.csv/.md`",
        "- `memory_recovery_matrix.csv/.md`",
        "",
        "## Method Note",
        "",
        "The workbench is browser/UI-only, so these tables evaluate the same reconstruction semantics in batch form rather than manual UI clicks.",
    ]
    (OUT_ROOT / "phase_a_reconstruction_evaluation_summary.md").write_text("\n".join(summary), encoding="utf-8")

    print(f"Wrote outputs to {OUT_ROOT}")
    print("Disk outcomes:", Counter(row["reconstruction_outcome"] for row in disk_rows))
    print("Memory outcomes:", Counter(row["memory_reconstruction_outcome"] for row in memory_rows))


if __name__ == "__main__":
    main()
