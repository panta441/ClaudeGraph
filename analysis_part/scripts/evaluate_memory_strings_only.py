#!/usr/bin/env python3
"""Strings-only memory reconstruction evaluator.

This is the batch equivalent of the memory mode in forensic_workbench_v2.jsx:
schema patterns trigger windows, complete JSON objects are carved from memory
strings, and strict artifact rules classify reconstructed objects.

Important: this script does not read session JSONL, ground truth files, findings,
or project artifacts. Per-run input is only:
analysis/memory/<RUN_ID>/dmp_triage_*/ascii_strings_with_offsets.txt
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
from collections import Counter, deque
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
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

PATTERNS = [
    ("history_display", '{"display":"', "history_jsonl", "high"),
    ("session_parent_uuid_opener", '{"parentUuid":"', "session_graph", "high"),
    ("session_id", '"sessionId":"', "session_graph", "high"),
    ("parent_uuid", '"parentUuid":"', "session_graph", "high"),
    ("uuid", '"uuid":"', "session_graph", "medium"),
    ("leaf_uuid", '"leafUuid":"', "session_graph", "medium"),
    ("prompt_id", '"promptId":"', "session_graph", "high"),
    ("request_id", '"requestId":"', "session_graph", "high"),
    ("message_model", '"message":{"model":', "assistant_response", "high"),
    ("message_role", '"message":{"role":"', "message_content", "high"),
    ("message_content", '"content":[{', "message_content", "high"),
    ("assistant_content", '"role":"assistant","content":[{', "assistant_response", "high"),
    ("permission_mode", '"permissionMode":"', "session_graph", "high"),
    ("file_history_snapshot", '"type":"file-history-snapshot"', "session_graph", "high"),
    ("deferred_tools_delta", '"attachment":{"type":"deferred_tools_delta"', "capability_surface", "high"),
    ("skill_listing", '"attachment":{"type":"skill_listing"', "capability_surface", "high"),
    ("mcp_instructions_delta", '"attachment":{"type":"mcp_instructions_delta"', "capability_surface", "high"),
    ("tool_use_type", '"type":"tool_use"', "tool_use", "high"),
    ("tool_result_type", '"type":"tool_result"', "tool_result", "high"),
    ("tool_use_id", '"tool_use_id":"', "tool_result", "high"),
    ("source_tool_assistant_uuid", '"sourceToolAssistantUUID":"', "tool_result", "high"),
    ("tool_use_result", '"toolUseResult":{', "tool_result", "high"),
    ("tool_name_read", '"name":"Read"', "tool_use", "high"),
    ("tool_name_write", '"name":"Write"', "tool_use", "high"),
    ("tool_name_edit", '"name":"Edit"', "tool_use", "high"),
    ("tool_name_bash", '"name":"Bash"', "tool_use", "high"),
    ("tool_name_toolsearch", '"name":"ToolSearch"', "tool_use", "high"),
    ("tool_name_webfetch", '"name":"WebFetch"', "tool_use", "high"),
    ("mcp_tool", '"name":"mcp__', "mcp_tool_use", "high"),
    ("mcp_meta", '"mcpMeta":', "mcp_tool_result", "high"),
    ("structured_content", '"structuredContent":', "mcp_tool_result", "high"),
    ("file_path_input", '"file_path":"', "file_path", "high"),
    ("file_path_result", '"filePath":"', "file_path", "high"),
    ("structured_patch", '"structuredPatch":', "file_write_result", "high"),
    ("original_file", '"originalFile":', "file_write_result", "high"),
    ("stdout", '"stdout":"', "shell_result", "high"),
    ("stderr", '"stderr":"', "shell_result", "high"),
    ("hook_event", '"hook_event_name":"', "hook", "high"),
    ("hook_success", '"attachment":{"type":"hook_success"', "hook", "high"),
    ("source_tool_use_id", '"sourceToolUseID":"', "skill_meta", "high"),
    ("attribution_skill", '"attributionSkill"', "skill", "high"),
    ("skill_md", "SKILL.md", "skill", "medium"),
    ("claude_md", "CLAUDE.md", "claudemd_context", "medium"),
    ("account_uuid", '"accountUuid":"', "account_identity", "high"),
    ("email_address", '"emailAddress":"', "account_identity", "high"),
    ("organization_uuid", '"organizationUuid":"', "account_identity", "high"),
    ("organization_name", '"organizationName":"', "account_identity", "high"),
    ("oauth_object", '"claudeAiOauth":', "oauth_credentials", "high"),
    ("access_token", '"accessToken":"', "oauth_credentials", "high"),
    ("refresh_token", '"refreshToken":"', "oauth_credentials", "high"),
    ("runtime_pid", '"pid":', "runtime_session_state", "high"),
    ("runtime_cwd", '"cwd":"', "runtime_session_state", "high"),
    ("runtime_started", '"startedAt":"', "runtime_session_state", "high"),
    ("runtime_version", '"version":"', "runtime_session_state", "medium"),
]

PATTERN_BY_VALUE = {pattern: {"id": pid, "class": cls, "specificity": spec} for pid, pattern, cls, spec in PATTERNS}
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
        "Scores: `E`=strict full JSON object recovered, `P`=candidate fragment only, `N`=not recovered.",
        "",
        "|" + "|".join(cols) + "|",
        "|" + "|".join(["---"] * len(cols)) + "|",
    ]
    for row in rows:
        lines.append("|" + "|".join(str(row.get(c, "")).replace("|", "\\|") for c in cols) + "|")
    path.write_text("\n".join(lines), encoding="utf-8")


def find_strings_file(run_id: str) -> Path | None:
    root = MEMORY_ROOT / run_id
    matches = sorted(root.glob("dmp_triage_*/ascii_strings_with_offsets.txt"))
    return matches[0] if matches else None


def parse_offset(raw: str) -> tuple[str, str]:
    line = raw.rstrip("\r\n")
    match = re.match(r"^\s*(0x[0-9a-fA-F]+|\d+)[:\t ](.*)$", line)
    if match:
        return match.group(1), match.group(2)
    return "", line


def compile_patterns() -> re.Pattern[str]:
    body = "|".join(re.escape(pattern) for _pid, pattern, _cls, _spec in sorted(PATTERNS, key=lambda r: len(r[1]), reverse=True))
    return re.compile(body)


def carve_json(text: str) -> tuple[str, dict[str, Any] | None, str]:
    start = text.find("{")
    if start < 0:
        return "", None, "no_object_start"
    depth = 0
    in_string = False
    escape = False
    for idx in range(start, len(text)):
        ch = text[idx]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                raw = text[start : idx + 1]
                parsed, status = parse_json_with_repair(raw)
                return raw, parsed, status
    return text[start:], None, "partial"


def parse_json_with_repair(raw: str) -> tuple[dict[str, Any] | None, str]:
    try:
        obj = json.loads(raw)
        return (obj if isinstance(obj, dict) else None), "full"
    except json.JSONDecodeError as exc:
        repaired = re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", raw)
        if repaired != raw:
            try:
                obj = json.loads(repaired)
                return (obj if isinstance(obj, dict) else None), "full_repaired"
            except json.JSONDecodeError:
                pass
        return None, f"json_error:{exc.msg}"


def all_keys(obj: Any, keys: set[str] | None = None) -> set[str]:
    if keys is None:
        keys = set()
    if isinstance(obj, dict):
        for key, value in obj.items():
            keys.add(str(key))
            all_keys(value, keys)
    elif isinstance(obj, list):
        for value in obj:
            all_keys(value, keys)
    return keys


def get_dict(obj: dict[str, Any], key: str) -> dict[str, Any]:
    value = obj.get(key)
    return value if isinstance(value, dict) else {}


def message_items(obj: dict[str, Any]) -> list[dict[str, Any]]:
    message = get_dict(obj, "message")
    content = message.get("content")
    return [item for item in content if isinstance(item, dict)] if isinstance(content, list) else []


def classify_object(obj: dict[str, Any]) -> tuple[str, str]:
    keys = all_keys(obj)
    typ = str(obj.get("type", ""))
    message = get_dict(obj, "message")
    attachment = get_dict(obj, "attachment")
    attachment_type = str(attachment.get("type", ""))
    items = message_items(obj)
    if {"display", "timestamp", "project", "sessionId"}.issubset(keys):
        return "history_jsonl", "display+timestamp+project+sessionId"
    if {"emailAddress", "accountUuid", "organizationUuid"}.issubset(keys):
        return "account_identity", "emailAddress+accountUuid+organizationUuid"
    if {"claudeAiOauth", "accessToken", "refreshToken"}.issubset(keys):
        return "oauth_credentials", "claudeAiOauth+accessToken+refreshToken"
    if {"pid", "sessionId", "cwd", "startedAt", "version"}.issubset(keys):
        return "runtime_session_state", "pid+sessionId+cwd+startedAt+version"
    if "sessionId" in keys and typ and (
        {"uuid", "parentUuid"}.issubset(keys)
        or ("promptId" in keys and "message" in keys)
        or ("message" in keys and "requestId" in keys)
        or ("leafUuid" in keys and ("lastPrompt" in keys or typ == "last-prompt"))
        or "permissionMode" in keys
        or typ in {"permission-mode", "ai-title"}
        or (typ == "file-history-snapshot" and "messageId" in keys)
    ):
        return "session_jsonl_graph", "sessionId+typed graph keys"
    if typ == "assistant" and message.get("role") == "assistant" and "content" in message:
        return "assistant_response", "assistant message content"
    if attachment_type in {"deferred_tools_delta", "mcp_instructions_delta", "skill_listing"} and "sessionId" in keys:
        return "capability_surface", "capability attachment+sessionId"
    if any(item.get("type") == "tool_use" and str(item.get("id", "")).startswith("toolu_") and item.get("name") for item in items):
        return "tool_use", "tool_use item id+name"
    if any(item.get("type") == "tool_result" and item.get("tool_use_id") for item in items) or "toolUseResult" in keys:
        return "tool_result", "tool_result linkage or toolUseResult"
    if ("usage" in keys and "model" in keys) or "cache_read_input_tokens" in keys or "server_tool_use" in keys:
        return "api_metrics_debug", "api metrics/debug object"
    return "noise", "no strict schema match"


def canonical_hash(obj: dict[str, Any]) -> str:
    text = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def scan_run(run_id: str, path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    regex = compile_patterns()
    prev: deque[tuple[int, str, str]] = deque(maxlen=3)
    active: list[dict[str, Any]] = []
    windows: list[dict[str, Any]] = []
    raw_anchor_hits = 0
    total_lines = 0
    window_id = 0

    with path.open("r", encoding="utf-16-le", errors="replace") as f:
        for line_no, raw in enumerate(f, 1):
            total_lines = line_no
            offset, content = parse_offset(raw)
            still_active = []
            for win in active:
                if win["remaining"] > 0:
                    win["lines"].append((line_no, offset, content))
                    win["remaining"] -= 1
                if win["remaining"] > 0:
                    still_active.append(win)
                else:
                    windows.append(win)
            active = still_active

            matched = {m.group(0) for m in regex.finditer(content)}
            if matched:
                raw_anchor_hits += len(matched)
                triggers = {p for p in matched if PATTERN_BY_VALUE[p]["specificity"] == "high"}
                if triggers:
                    if active:
                        target = active[-1]
                        target["patterns"].update(matched)
                        target["remaining"] = 6
                    else:
                        window_id += 1
                        active.append(
                            {
                                "window_id": f"{run_id}:{window_id}",
                                "start_line": line_no,
                                "start_offset": offset,
                                "pre_count": len(prev),
                                "patterns": set(matched),
                                "lines": list(prev) + [(line_no, offset, content)],
                                "remaining": 6,
                            }
                        )
            prev.append((line_no, offset, content))
    windows.extend(active)

    strict_by_hash: dict[str, dict[str, Any]] = {}
    candidates: list[dict[str, Any]] = []
    for win in windows:
        body_lines = win["lines"][int(win.get("pre_count", 0)) :]
        joined = "".join(part for _line, _offset, part in body_lines)
        raw_json, parsed, parse_status = carve_json(joined)
        fragment = raw_json or (joined[joined.find("{") :] if "{" in joined else joined)
        pattern_ids = sorted({PATTERN_BY_VALUE[p]["id"] for p in win["patterns"]})
        pattern_classes = sorted({PATTERN_BY_VALUE[p]["class"] for p in win["patterns"]})
        offsets = [off for _line, off, _content in win["lines"] if off]
        strict_class = "noise"
        strict_reason = "not full JSON"
        obj_hash = hashlib.sha256(" ".join(fragment.split()).encode("utf-8", errors="replace")).hexdigest()
        if parsed is not None and parse_status in {"full", "full_repaired"}:
            strict_class, strict_reason = classify_object(parsed)
            obj_hash = canonical_hash(parsed)
        base = {
            "run_id": run_id,
            "window_id": win["window_id"],
            "start_line": win["start_line"],
            "start_offset": win["start_offset"],
            "parse_status": parse_status,
            "object_hash": obj_hash,
            "matched_pattern_ids": ";".join(pattern_ids),
            "pattern_classes": ";".join(pattern_classes),
            "strict_artifact_class": strict_class,
            "strict_reason": strict_reason,
            "offsets": ";".join(offsets[:50]),
            "fragment_excerpt": fragment[:1500],
        }
        if parsed is not None and strict_class != "noise":
            existing = strict_by_hash.get(obj_hash)
            if existing:
                existing["hit_count"] += 1
                existing["offsets"] = ";".join(sorted(set(existing["offsets"].split(";") + offsets))[:100])
            else:
                strict_by_hash[obj_hash] = {
                    "run_id": run_id,
                    "artifact_class": strict_class,
                    "object_hash": obj_hash,
                    "hit_count": 1,
                    "first_line": win["start_line"],
                    "first_offset": win["start_offset"],
                    "offsets": ";".join(offsets[:100]),
                    "matched_pattern_ids": ";".join(pattern_ids),
                    "strict_reason": strict_reason,
                    "best_excerpt": fragment[:1500],
                }
        else:
            candidates.append(base)

    strict_rows = list(strict_by_hash.values())
    summary = {
        "run_id": run_id,
        "strings_path": str(path),
        "encoding_used": "utf-16-le",
        "total_lines": total_lines,
        "raw_anchor_hits": raw_anchor_hits,
        "windows": len(windows),
        "strict_reconstructed_objects": len(strict_rows),
        "candidate_fragments": len(candidates),
    }
    return summary, strict_rows, candidates


def score_matrix(run_summaries: list[dict[str, Any]], strict_rows: list[dict[str, Any]], candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    strict_counts: dict[str, Counter[str]] = {run: Counter() for run in RUN_ORDER}
    candidate_counts: dict[str, Counter[str]] = {run: Counter() for run in RUN_ORDER}
    for row in strict_rows:
        strict_counts[row["run_id"]][row["artifact_class"]] += 1
    for row in candidates:
        run = row["run_id"]
        cls = row["strict_artifact_class"]
        if cls == "noise":
            for pattern_cls in str(row.get("pattern_classes", "")).split(";"):
                if pattern_cls in MEMORY_CLASSES:
                    candidate_counts[run][pattern_cls] += 1
        else:
            candidate_counts[run][cls] += 1

    summary_by_run = {row["run_id"]: row for row in run_summaries}
    matrix: list[dict[str, Any]] = []
    for run in RUN_ORDER:
        row: dict[str, Any] = {
            "run_id": run,
            "strict_object_count": summary_by_run.get(run, {}).get("strict_reconstructed_objects", 0),
            "candidate_fragment_count": summary_by_run.get(run, {}).get("candidate_fragments", 0),
            "raw_anchor_hits": summary_by_run.get(run, {}).get("raw_anchor_hits", 0),
            "windows": summary_by_run.get(run, {}).get("windows", 0),
        }
        for cls in MEMORY_CLASSES:
            if strict_counts[run][cls]:
                row[cls] = "E"
            elif candidate_counts[run][cls]:
                row[cls] = "P"
            else:
                row[cls] = "N"
        if row["history_jsonl"] == "E" and row["session_jsonl_graph"] == "E" and row["assistant_response"] == "E":
            outcome = "Full"
        elif int(row["strict_object_count"]) > 0:
            outcome = "Partial"
        elif int(row["candidate_fragment_count"]) > 0:
            outcome = "CandidateOnly"
        else:
            outcome = "Unresolved"
        row["memory_reconstruction_outcome"] = outcome
        row["strict_classes"] = ";".join(sorted(k for k, v in strict_counts[run].items() if v))
        matrix.append(row)
    return matrix


def main() -> None:
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    summaries: list[dict[str, Any]] = []
    strict_rows: list[dict[str, Any]] = []
    candidate_rows: list[dict[str, Any]] = []
    for run in RUN_ORDER:
        path = find_strings_file(run)
        if path is None:
            summaries.append(
                {
                    "run_id": run,
                    "strings_path": "",
                    "encoding_used": "",
                    "total_lines": 0,
                    "raw_anchor_hits": 0,
                    "windows": 0,
                    "strict_reconstructed_objects": 0,
                    "candidate_fragments": 0,
                }
            )
            continue
        print(f"[strings-only] {run}: {path}")
        summary, strict, candidates = scan_run(run, path)
        summaries.append(summary)
        strict_rows.extend(strict)
        candidate_rows.extend(candidates)

    matrix = score_matrix(summaries, strict_rows, candidate_rows)
    write_csv(
        OUT_ROOT / "memory_strings_only_run_summary.csv",
        summaries,
        ["run_id", "strings_path", "encoding_used", "total_lines", "raw_anchor_hits", "windows", "strict_reconstructed_objects", "candidate_fragments"],
    )
    write_csv(
        OUT_ROOT / "memory_strings_only_strict_objects.csv",
        strict_rows,
        ["run_id", "artifact_class", "object_hash", "hit_count", "first_line", "first_offset", "offsets", "matched_pattern_ids", "strict_reason", "best_excerpt"],
    )
    write_csv(
        OUT_ROOT / "memory_strings_only_candidate_fragments.csv",
        candidate_rows,
        ["run_id", "window_id", "start_line", "start_offset", "parse_status", "object_hash", "matched_pattern_ids", "pattern_classes", "strict_artifact_class", "strict_reason", "offsets", "fragment_excerpt"],
    )
    matrix_fields = ["run_id", "strict_object_count", "candidate_fragment_count", "raw_anchor_hits", "windows", *MEMORY_CLASSES, "memory_reconstruction_outcome", "strict_classes"]
    write_csv(OUT_ROOT / "memory_strings_only_recovery_matrix.csv", matrix, matrix_fields)
    write_markdown_table(
        OUT_ROOT / "memory_strings_only_recovery_matrix.md",
        "Memory Strings-Only Recovery Matrix",
        matrix,
        ["run_id", "strict_object_count", "candidate_fragment_count", "history_jsonl", "session_jsonl_graph", "assistant_response", "account_identity", "oauth_credentials", "tool_use", "tool_result", "memory_reconstruction_outcome"],
    )
    print(f"Wrote strings-only memory outputs to {OUT_ROOT}")
    print("Outcomes:", Counter(row["memory_reconstruction_outcome"] for row in matrix))


if __name__ == "__main__":
    main()
