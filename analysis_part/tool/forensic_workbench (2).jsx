import React, { useState, useMemo, useCallback, useRef } from "react";
import {
  Upload, FileJson, ChevronRight, ChevronDown, Shield, Terminal,
  FileText, GitBranch, AlertTriangle, Eye, Layers, Hash, Clock,
  ArrowRight, Webhook, Plug, Globe, Wrench, FileEdit, FileSearch,
  CircleAlert, CircleCheck, Activity, Search, Filter, Cpu, Database,
} from "lucide-react";

/* ============================================================================
   PARSER — JavaScript port of session_parser_v2.py
   Implements the 10 critical parsing rules. Pure functions, deterministic.
   ============================================================================ */

const TOOLSEARCH_NAMES = new Set(["ToolSearch"]);
const MCP_PREFIX = "mcp__";
const WEBFETCH_NAMES = new Set(["WebFetch", "WebSearch"]);
const SKILL_NAMES = new Set(["Skill"]);
const SHELL_NAMES = new Set(["Bash", "PowerShell"]);
const FILE_READ_NAMES = new Set(["Read"]);
const FILE_WRITE_NAMES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const FILE_DISCOVERY_NAMES = new Set(["Glob", "LS"]);

function get(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = cur[k];
    else if (Array.isArray(cur) && typeof k === "number") cur = cur[k];
    else return "";
    if (cur === undefined || cur === null) return "";
  }
  return cur === undefined || cur === null ? "" : cur;
}

function iterMessageItems(node) {
  const content = get(node, "message", "content");
  if (Array.isArray(content)) return content.filter((x) => x && typeof x === "object");
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function flattenText(value, maxLen = 500) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, maxLen);
  if (Array.isArray(value)) return value.map((v) => flattenText(v, 160)).join(" | ").slice(0, maxLen);
  if (typeof value === "object") {
    const t = value.type || "";
    if (t === "text") return (value.text || "").slice(0, maxLen);
    if (t === "thinking") return "[thinking]";
    if (t === "tool_use") return `[tool_use:${value.name || ""}]`;
    if (t === "tool_result") return `[tool_result:${flattenText(value.content || "", 120)}]`;
    try { return JSON.stringify(value).slice(0, maxLen); } catch { return String(value).slice(0, maxLen); }
  }
  return String(value).slice(0, maxLen);
}

function extractMessageText(node, maxLen = 5000) {
  const content = get(node, "message", "content");
  if (typeof content === "string") return content.slice(0, maxLen);
  const texts = [];
  for (const item of iterMessageItems(node)) {
    if (item.type === "text") texts.push(item.text || "");
    else if (item.type === "tool_result") texts.push(flattenText(item.content || "", 500));
  }
  return texts.filter(Boolean).join("\n").slice(0, maxLen);
}

function extractTextItems(node) {
  const content = get(node, "message", "content");
  if (typeof content === "string") return [content];
  const texts = [];
  if (Array.isArray(content)) {
    for (const item of content) if (item && item.type === "text") texts.push(item.text || "");
  }
  return texts;
}

// RULE 1 — type=user is four different things; classify by content + meta fields.
function deriveContentClass(obj) {
  const otype = obj.type || "";
  const subtype = obj.subtype || "";
  if (otype === "mode") return "mode_record";
  if (otype === "permission-mode") return "permission_mode_record";
  if (otype === "file-history-snapshot") return "file_history_snapshot";
  if (otype === "ai-title") return "ai_title";
  if (otype === "last-prompt") return "last_prompt_pointer";
  if (otype === "attachment") {
    const atype = get(obj, "attachment", "type");
    if (atype === "deferred_tools_delta") return "attachment_deferred_tools";
    if (atype === "mcp_instructions_delta") return "attachment_mcp_instructions";
    if (atype === "skill_listing") return "attachment_skill_listing";
    if (atype === "hook_success") return "attachment_hook_success";
    if (atype === "command_permissions") return "attachment_command_permissions";
    return "attachment_other";
  }
  if (otype === "system") {
    if (subtype === "turn_duration") return "system_turn_duration";
    if (subtype === "local_command") return "system_local_command";
    if (subtype === "api_error") return "system_api_error";
    return "unknown";
  }
  if (otype === "user") {
    if (obj.isMeta && obj.sourceToolUseID) return "skill_meta_content";
    const content = get(obj, "message", "content");
    if (typeof content === "string") {
      if (content.includes("<local-command-caveat>")) return "local_command_caveat";
      if (content.includes("<command-name>")) return "local_command";
      if (content.includes("<local-command-stdout>")) return "local_command_stdout";
      return "natural_user_prompt";
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "tool_result") return "tool_result";
        const text = item.type === "text" ? item.text || "" : "";
        if (text.includes("<local-command-caveat>")) return "local_command_caveat";
        if (text.includes("<command-name>")) return "local_command";
        if (text.includes("<local-command-stdout>")) return "local_command_stdout";
      }
      return "natural_user_prompt";
    }
    return "natural_user_prompt";
  }
  if (otype === "assistant") {
    // RULE 2 — one assistant line can carry multiple content item types.
    const types = new Set(iterMessageItems(obj).map((i) => i.type).filter(Boolean));
    if (types.size > 1) return "assistant_composite";
    if (types.has("tool_use")) return "assistant_tool_use";
    if (types.has("thinking")) return "assistant_thinking_fragment";
    return "assistant_text_fragment";
  }
  return "unknown";
}

function toolCategory(name) {
  if (TOOLSEARCH_NAMES.has(name)) return "discovery";       // RULE 8
  if (name.startsWith(MCP_PREFIX)) return "mcp";
  if (WEBFETCH_NAMES.has(name)) return "webfetch";
  if (SKILL_NAMES.has(name)) return "skill";
  if (SHELL_NAMES.has(name)) return "shell";
  if (FILE_READ_NAMES.has(name)) return "file_read";
  if (FILE_WRITE_NAMES.has(name)) return "file_write";
  if (FILE_DISCOVERY_NAMES.has(name)) return "file_discover";
  return "other";
}

function inputPrimaryValue(name, inp) {
  if (!inp || typeof inp !== "object") inp = {};
  if (name === "Read" || FILE_WRITE_NAMES.has(name)) return String(inp.file_path || inp.path || "");
  if (SHELL_NAMES.has(name)) return String(inp.command || "");
  if (WEBFETCH_NAMES.has(name)) return String(inp.url || "");
  if (name === "Glob") { const p = inp.path || "", pat = inp.pattern || ""; return p ? `${p}::${pat}` : String(pat); }
  if (name === "ToolSearch") return String(inp.query || "");
  if (name === "Skill") return String(inp.skill || "");
  if (name.startsWith(MCP_PREFIX)) { try { return JSON.stringify(inp); } catch { return ""; } }
  return String(inp.file_path || inp.path || inp.command || inp.url || inp.pattern || inp.query || inp.skill || "");
}

function parseMcpToolName(name) {
  if (!name.startsWith(MCP_PREFIX)) return ["", ""];
  const rest = name.slice(MCP_PREFIX.length);
  const idx = rest.indexOf("__");
  if (idx >= 0) return [rest.slice(0, idx), rest.slice(idx + 2)];
  return [rest, ""];
}

function parseHookTargets(command) {
  if (!command) return [];
  const targets = [];
  const re = />>?\s*(?:"([^"]+)"|'([^']+)'|([^\r\n&|]+))/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    const t = (m[1] || m[2] || m[3] || "").trim();
    if (t) targets.push(t);
  }
  return targets;
}

function extractResultFields(toolName, resultNode, resultItem) {
  let tur = {};
  let raw = "";
  if (resultNode) {
    tur = resultNode.toolUseResult || {};
    if ((!tur || Object.keys(tur).length === 0) && resultItem) tur = resultItem.toolUseResult || {};
    raw = resultItem && typeof resultItem === "object" ? flattenText(resultItem.content || "", 4000) : "";
  }
  const f = {
    is_error: "", result_type: "", actual_path: "", result_content_excerpt: "",
    original_file: "", structured_patch: "", stdout: "", stderr: "", interrupted: "",
    http_code: "", http_code_text: "", bytes: "", duration_ms: "", mcp_meta_excerpt: "",
  };
  if (resultItem) f.is_error = "is_error" in resultItem ? String(Boolean(resultItem.is_error)) : "false";
  if (tur && typeof tur === "object" && !Array.isArray(tur)) {
    f.result_type = String(tur.type || "");
    f.actual_path = String(get(tur, "file", "filePath") || tur.filePath || tur.url || "");
    f.original_file = flattenText(tur.originalFile || "", 5000);
    const patch = tur.structuredPatch;
    f.structured_patch = patch !== undefined && patch !== "" && patch !== null
      ? (typeof patch === "string" ? patch : JSON.stringify(patch)) : "";
    f.stdout = flattenText(tur.stdout || "", 5000);
    f.stderr = flattenText(tur.stderr || "", 5000);
    f.interrupted = "interrupted" in tur ? String(tur.interrupted) : "";
    f.http_code = String(tur.code || "");
    f.http_code_text = String(tur.codeText || "");
    f.bytes = String(tur.bytes || "");
    f.duration_ms = String(tur.durationMs || "");
    const candidates = [get(tur, "file", "content"), tur.content || "", tur.result || "", tur.stdout || "", raw];
    for (const c of candidates) { if (c !== null && c !== undefined && c !== "") { f.result_content_excerpt = flattenText(c, 800); break; } }
    if (!f.actual_path && Array.isArray(tur.filenames)) f.actual_path = tur.filenames.slice(0, 20).join("|");
    f._tur = tur;
  } else {
    f.result_content_excerpt = flattenText(tur || raw, 800);
  }
  if (resultNode && resultNode.mcpMeta) { try { f.mcp_meta_excerpt = JSON.stringify(resultNode.mcpMeta).slice(0, 2000); } catch {} }
  return f;
}

function extractTargetsFromPrompt(text) {
  if (!text) return [];
  const targets = new Set();
  (text.match(/https?:\/\/[^\s'"<>]+/g) || []).forEach((m) => targets.add(m.replace(/[.,);\]]+$/, "")));
  (text.match(/[A-Za-z]:\\[^\s'"<>]+/g) || []).forEach((m) => targets.add(m.replace(/[.,);\]]+$/, "")));
  (text.match(/\b[\w.\-]+\.(?:py|md|txt|json|html|csv|ps1|js|ts|toml|yaml|yml)\b/gi) || []).forEach((m) => targets.add(m));
  return [...targets].sort();
}

function detectTargetDivergence(requested, actual) {
  if (!requested.length || !actual.length) return false;
  const joined = actual.map((a) => String(a).toLowerCase()).join("\n");
  for (const req of requested) {
    const r = req.toLowerCase();
    if (r.startsWith("http") && !joined.includes(r)) return true;
    const base = r.split(/[\\/]/).pop();
    if (base && !joined.includes(base) && !joined.includes(r)) return true;
  }
  return false;
}

function parseSession(text) {
  // Parse JSONL → nodes with line numbers + content_class.
  const nodes = [];
  const lines = text.split(/\r?\n/);
  let ln = 0;
  for (const raw of lines) {
    ln += 1;
    if (!raw.trim()) continue;
    let obj;
    try { obj = JSON.parse(raw); }
    catch (e) { obj = { _parse_error: true, raw: raw.slice(0, 500) }; }
    obj._line_number = ln;
    obj._content_class = deriveContentClass(obj);
    nodes.push(obj);
  }

  // Build pairing indexes (RULE 3).
  const byUuid = {}, toolUseNodeById = {}, toolUseItemById = {};
  const toolResultNodeById = {}, toolResultItemById = {};
  const hooksByToolUseId = {}, snapshotsByMessageId = {};
  for (const node of nodes) {
    if (node.uuid) byUuid[node.uuid] = node;
  }
  for (const node of nodes) {
    if (node.type === "assistant") {
      iterMessageItems(node).forEach((item, idx) => {
        if (item.type === "tool_use" && item.id) {
          toolUseNodeById[item.id] = node;
          toolUseItemById[item.id] = { ...item, _item_index: idx };
        }
      });
    }
    if (node._content_class === "tool_result") {
      iterMessageItems(node).forEach((item) => {
        if (item.type === "tool_result" && item.tool_use_id) {
          toolResultNodeById[item.tool_use_id] = node;
          toolResultItemById[item.tool_use_id] = item;
        }
      });
    }
    if (node._content_class === "attachment_hook_success") {
      const tid = get(node, "attachment", "toolUseID");
      if (tid) (hooksByToolUseId[tid] ||= []).push(node);
    }
    if (node._content_class === "file_history_snapshot") {
      const mid = node.messageId || get(node, "snapshot", "messageId");
      if (mid) (snapshotsByMessageId[mid] ||= []).push(node);
    }
  }

  // Annotate root prompt id by walking parentUuid back to a natural_user_prompt.
  function rootPromptFor(node) {
    let start = node;
    const cc = node._content_class;
    if (cc === "natural_user_prompt") return [node.promptId || node.uuid || "", node.uuid || ""];
    if (cc === "file_history_snapshot") {
      const anchor = node.messageId || get(node, "snapshot", "messageId");
      if (anchor && byUuid[anchor]) start = byUuid[anchor];
    } else if (cc === "attachment_hook_success") {
      const tid = get(node, "attachment", "toolUseID");
      if (toolUseNodeById[tid]) start = toolUseNodeById[tid];
    } else if (cc === "skill_meta_content") {
      const tid = node.sourceToolUseID;
      if (toolUseNodeById[tid]) start = toolUseNodeById[tid];
    } else if (cc === "tool_result") {
      const su = node.sourceToolAssistantUUID;
      if (su && byUuid[su]) start = byUuid[su];
    }
    const seen = new Set();
    let cur = start, depth = 0;
    while (cur && typeof cur === "object") {
      const u = cur.uuid || "";
      if (u && seen.has(u)) break;
      if (u) seen.add(u);
      if (cur._content_class === "natural_user_prompt") return [cur.promptId || cur.uuid || "", cur.uuid || ""];
      const parent = cur.parentUuid;
      if (!parent || !byUuid[parent]) break;
      cur = byUuid[parent];
      depth += 1;
      if (depth > 5000) break;
    }
    // fallback: nearest previous prompt by line
    for (let i = nodes.length - 1; i >= 0; i--) {
      const prev = nodes[i];
      if ((prev._line_number || 0) >= (node._line_number || 0)) continue;
      if (prev._content_class === "natural_user_prompt") return [prev.promptId || prev.uuid || "", prev.uuid || ""];
    }
    return ["", ""];
  }
  for (const node of nodes) {
    const [rid, ruid] = rootPromptFor(node);
    node._root_prompt_id = rid;
    node._root_prompt_uuid = ruid;
  }

  // Build tool chain rows (RULE 3 pairing, RULE 9 hook linkage).
  const toolRows = [];
  for (const node of nodes) {
    if (node.type !== "assistant") continue;
    iterMessageItems(node).forEach((item, idx) => {
      if (item.type !== "tool_use") return;
      const name = item.name || "";
      const tid = item.id || "";
      const inp = item.input && typeof item.input === "object" ? item.input : {};
      const resultNode = toolResultNodeById[tid] || null;
      const resultItem = toolResultItemById[tid] || null;
      const rf = extractResultFields(name, resultNode, resultItem);
      const hooks = hooksByToolUseId[tid] || [];
      const hookCommands = hooks.map((h) => String(get(h, "attachment", "command"))).filter(Boolean);
      const hookTargets = [];
      hookCommands.forEach((c) => hookTargets.push(...parseHookTargets(c)));
      const [mcpServer, mcpTool] = parseMcpToolName(name);
      toolRows.push({
        root_prompt_id: node._root_prompt_id || "",
        tool_use_line: node._line_number || "",
        tool_result_line: resultNode ? resultNode._line_number || "" : "",
        tool_name: name,
        tool_category: toolCategory(name),
        tool_use_id: tid,
        tool_use_timestamp: node.timestamp || "",
        tool_result_timestamp: resultNode ? resultNode.timestamp || "" : "",
        assistant_uuid: node.uuid || "",
        input_path: inputPrimaryValue(name, inp).slice(0, 1000),
        input_json: (() => { try { return JSON.stringify(inp); } catch { return ""; } })(),
        input_content: flattenText(inp.content || inp.prompt || "", 2000),
        is_error: rf.is_error,
        result_type: rf.result_type,
        actual_path: rf.actual_path.slice(0, 1000),
        result_content_excerpt: rf.result_content_excerpt.slice(0, 1000),
        original_file: rf.original_file.slice(0, 4000),
        structured_patch: rf.structured_patch.slice(0, 8000),
        stdout: rf.stdout.slice(0, 4000),
        stderr: rf.stderr.slice(0, 4000),
        http_code: rf.http_code,
        http_code_text: rf.http_code_text,
        bytes: rf.bytes,
        duration_ms: rf.duration_ms,
        mcp_server: mcpServer,
        mcp_tool: mcpTool,
        mcp_meta_excerpt: rf.mcp_meta_excerpt,
        hook_fired: String(hooks.length > 0),
        hook_command: hookCommands.join(" | ").slice(0, 1000),
        hook_targets: hookTargets.join("|"),
        hook_exit_code: hooks.map((h) => String(get(h, "attachment", "exitCode"))).join("|"),
        hook_stderr: hooks.map((h) => String(get(h, "attachment", "stderr")).slice(0, 400)).join(" | "),
      });
    });
  }

  // Build prompt chain.
  const prompts = {};
  for (const node of nodes) {
    if (node._content_class === "natural_user_prompt") {
      const pid = node.promptId || node.uuid || "";
      if (!(pid in prompts)) {
        prompts[pid] = {
          root_prompt_id: pid,
          root_prompt_uuid: node.uuid || "",
          prompt_text: extractMessageText(node, 5000),
          prompt_timestamp: node.timestamp || "",
          cwd: node.cwd || "",
          session_id: node.sessionId || "",
          version: node.version || "",
        };
      }
    }
  }
  const toolsByPrompt = {};
  for (const r of toolRows) (toolsByPrompt[r.root_prompt_id] ||= []).push(r);

  const finalResp = {}, finalRespUuid = {}, attrSkill = {}, attrMcpServer = {}, attrMcpTool = {};
  const turnDur = {}, apiRetry = {};
  for (const node of nodes) {
    const pid = node._root_prompt_id || "";
    if (!pid) continue;
    if (node._content_class === "system_api_error") apiRetry[pid] = (apiRetry[pid] || 0) + 1;
    if (node._content_class === "system_turn_duration") turnDur[pid] = { duration_ms: node.durationMs || "", message_count: node.messageCount || "" };
    if (node.type === "assistant" && get(node, "message", "stop_reason") === "end_turn") {
      const text = extractTextItems(node).join("\n").trim();
      if (text) { finalResp[pid] = text; finalRespUuid[pid] = node.uuid || ""; }
      if (node.attributionSkill) attrSkill[pid] = node.attributionSkill;
      if (node.attributionMcpServer) attrMcpServer[pid] = node.attributionMcpServer;
      if (node.attributionMcpTool) attrMcpTool[pid] = node.attributionMcpTool;
    }
  }

  const promptRows = Object.values(prompts).map((p) => {
    const pid = p.root_prompt_id;
    const trs = toolsByPrompt[pid] || [];
    const real = trs.filter((r) => r.tool_category !== "discovery");
    const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
    const requested = extractTargetsFromPrompt(p.prompt_text);
    const actual = real.map((r) => r.actual_path || r.input_path).filter(Boolean);
    return {
      ...p,
      tool_names_used: uniq(real.map((r) => r.tool_name)),
      discovery_steps: uniq(trs.filter((r) => r.tool_category === "discovery").map((r) => r.tool_name)),
      files_read: uniq(real.filter((r) => r.tool_category === "file_read").map((r) => r.actual_path || r.input_path)),
      files_written: uniq(real.filter((r) => r.tool_category === "file_write").map((r) => r.actual_path || r.input_path)),
      commands_run: real.filter((r) => r.tool_category === "shell").map((r) => r.input_path),
      webfetch_urls: uniq(real.filter((r) => r.tool_category === "webfetch").map((r) => r.input_path)),
      mcp_tools_called: uniq(real.filter((r) => r.tool_category === "mcp").map((r) => r.tool_name)),
      skills_invoked: uniq(real.filter((r) => r.tool_category === "skill").map((r) => r.input_path)),
      hooks: trs.filter((r) => r.hook_fired === "true"),
      tool_rows: trs,
      final_response_text: finalResp[pid] || "",
      attribution_skill: attrSkill[pid] || "",
      attribution_mcp_server: attrMcpServer[pid] || "",
      attribution_mcp_tool: attrMcpTool[pid] || "",
      turn_duration_ms: (turnDur[pid] || {}).duration_ms || "",
      message_count: (turnDur[pid] || {}).message_count || "",
      api_retry_count: apiRetry[pid] || 0,
      had_error_recovery: trs.some((r) => r.is_error === "true") && trs.some((r) => r.is_error === "false"),
      target_divergence_detected: detectTargetDivergence(requested, actual),
      requested_targets: requested,
      actual_targets: actual.slice(0, 20),
    };
  }).sort((a, b) => String(a.prompt_timestamp).localeCompare(String(b.prompt_timestamp)));

  // Session summary + flags.
  const sessionIds = [...new Set(nodes.map((n) => n.sessionId).filter(Boolean))];
  const versions = [...new Set(nodes.map((n) => n.version).filter(Boolean))];
  const cwds = [...new Set(nodes.map((n) => n.cwd).filter(Boolean))];
  const permModes = [...new Set(nodes.map((n) => n.permissionMode).filter(Boolean))];
  const timestamps = [...new Set(nodes.map((n) => n.timestamp).filter(Boolean))].sort();
  const realToolNames = [...new Set(toolRows.filter((r) => r.tool_category !== "discovery").map((r) => r.tool_name).filter(Boolean))].sort();
  const mcp = [...new Set(toolRows.filter((r) => r.tool_category === "mcp").map((r) => r.tool_name))];
  const urls = [...new Set(toolRows.filter((r) => r.tool_category === "webfetch").map((r) => r.input_path || r.actual_path).filter(Boolean))];
  const skills = [...new Set(toolRows.filter((r) => r.tool_category === "skill").map((r) => r.input_path).filter(Boolean))];
  const apiRetryCount = nodes.filter((n) => n._content_class === "system_api_error").length;

  const summary = {
    run_id: "",
    session_id: sessionIds.length === 1 ? sessionIds[0] : sessionIds,
    cwd: cwds.length === 1 ? cwds[0] : cwds,
    version: versions.length === 1 ? versions[0] : versions,
    permission_mode: permModes.length === 1 ? permModes[0] : permModes,
    first_timestamp: timestamps[0] || "",
    last_timestamp: timestamps[timestamps.length - 1] || "",
    record_count: nodes.length,
    prompt_count: promptRows.length,
    tool_pair_count: toolRows.length,
    real_tool_names_used: realToolNames,
    files_read: [...new Set(toolRows.filter((r) => r.tool_category === "file_read").map((r) => r.actual_path || r.input_path).filter(Boolean))].sort(),
    files_written: [...new Set(toolRows.filter((r) => r.tool_category === "file_write").map((r) => r.actual_path || r.input_path).filter(Boolean))].sort(),
    flags: {
      has_tool_use: realToolNames.length > 0,
      has_hook: nodes.some((n) => n._content_class === "attachment_hook_success"),
      has_mcp: mcp.length > 0,
      has_webfetch: urls.length > 0,
      has_skill: skills.length > 0,
      has_error_recovery: promptRows.some((r) => r.had_error_recovery),
      has_api_retry: apiRetryCount > 0,
      api_retry_count: apiRetryCount,
      has_version_drift: versions.length > 1,
      has_target_divergence: promptRows.some((r) => r.target_divergence_detected),
    },
  };

  const classCounts = {};
  for (const n of nodes) classCounts[n._content_class] = (classCounts[n._content_class] || 0) + 1;

  const patternHits = buildPatternHits(nodes, toolRows, promptRows, classCounts);

  return { nodes, toolRows, promptRows, summary, classCounts, patternHits };
}

/* ---- Pattern detection (subset most relevant for the UI) ---- */
function buildPatternHits(nodes, toolRows, promptRows, cc) {
  const hits = [];
  const add = (id, name, detected, category, manual = false, note = "") =>
    hits.push({ id, name, detected, category, manual, note });
  const has = (k) => (cc[k] || 0) > 0;
  const tnames = toolRows.map((r) => r.tool_name);

  add("P01", "Session container", has("natural_user_prompt") || nodes.length > 0, "session");
  add("P02", "Mode / permission-mode records", has("mode_record") || has("permission_mode_record"), "session");
  add("P03", "File-history snapshot anchor", has("file_history_snapshot"), "session");
  add("P06", "Natural user prompt", has("natural_user_prompt"), "session");
  add("P07", "Deferred-tools capability surface", has("attachment_deferred_tools"), "session");
  add("P08", "MCP instructions surface", has("attachment_mcp_instructions"), "session");
  add("P09", "Skill listing surface", has("attachment_skill_listing"), "session");
  add("P12", "Turn-duration summary", has("system_turn_duration"), "session");
  add("P13", "Last-prompt leaf pointer", has("last_prompt_pointer"), "session");

  const msgIds = {};
  nodes.forEach((n) => { if (String(n._content_class).startsWith("assistant")) { const id = get(n, "message", "id"); if (id) msgIds[id] = (msgIds[id] || 0) + 1; } });
  add("P16", "Assistant message fragmentation", Object.values(msgIds).some((v) => v > 1), "tool_loop", false, "≥2 assistant nodes share one message.id");
  add("P17", "Tool-use loop branch", has("assistant_tool_use") || has("assistant_composite"), "tool_loop");
  add("P18", "Tool-result pseudo-user record", has("tool_result"), "tool_loop");
  add("P19", "Tool-use/result ID pairing", toolRows.some((r) => r.result_type || r.is_error !== ""), "tool_loop");
  add("P21", "Failed tool then recovery", promptRows.some((r) => r.had_error_recovery), "tool_loop");
  add("P22", "Requested vs actual target divergence", promptRows.some((r) => r.target_divergence_detected), "tool_loop", false, "prompt target ≠ accessed target");
  add("P23", "Content-class classification needed", nodes.some((n) => n.type === "user" && n._content_class !== "natural_user_prompt"), "tool_loop");
  add("P44", "Composite assistant node", has("assistant_composite"), "tool_loop", false, "thinking+text+tool_use in one node");

  add("P27", "Write result with structuredPatch", toolRows.some((r) => r.structured_patch && r.result_type === "update"), "file_mod");
  add("P36", "Sequential multi-file create", toolRows.filter((r) => r.tool_name === "Write").length > 1, "file_mod");
  add("P37", "Create result metadata", toolRows.some((r) => r.result_type === "create"), "file_mod");
  add("P39", "Snapshot precedes Write in line order", (() => {
    const byUuid = {}; nodes.forEach((n) => { if (n.uuid) byUuid[n.uuid] = n._line_number; });
    return nodes.some((n) => { if (n._content_class !== "file_history_snapshot") return false; const mid = n.messageId || get(n, "snapshot", "messageId"); return mid && byUuid[mid] && n._line_number < byUuid[mid]; });
  })(), "file_mod", false, "line order ≠ execution order");

  add("P41", "API overload retry branch", has("system_api_error"), "tool_loop", false, "529 retries inflate turn duration");

  add("P53", "ToolSearch before MCP", toolRows.some((r) => r.tool_name === "ToolSearch") && toolRows.some((r) => r.tool_category === "mcp"), "mcp");
  add("P55", "MCP namespaced tool_use", toolRows.some((r) => r.tool_category === "mcp"), "mcp");
  add("P57", "Final assistant MCP attribution", promptRows.some((r) => r.attribution_mcp_server || r.attribution_mcp_tool), "mcp");

  add("P60", "Hook side-effect branch", has("attachment_hook_success"), "hook");
  add("P61", "Hook linked to Write tool_use", nodes.some((n) => n._content_class === "attachment_hook_success" && get(n, "attachment", "toolUseID")), "hook");
  add("P63", "Hook stderr anomaly (exit 0)", nodes.some((n) => n._content_class === "attachment_hook_success" && get(n, "attachment", "stderr") && get(n, "attachment", "exitCode") === 0), "hook", false, "stderr non-empty with exitCode=0");
  add("P64", "Hook file absent from Write tool_use", toolRows.some((r) => r.hook_fired === "true" && r.hook_targets), "hook", true, "hook-created file not in any Write record");
  add("P66", "Final response omits hook side effects", has("attachment_hook_success"), "hook", true, "verify against final response text");

  add("P68", "WebFetch external-content branch", toolRows.some((r) => r.tool_name === "WebFetch"), "webfetch");
  add("P69", "ToolSearch before WebFetch", toolRows.some((r) => r.tool_name === "ToolSearch") && toolRows.some((r) => r.tool_name === "WebFetch"), "webfetch");

  add("P76", "Skill tool invocation", toolRows.some((r) => r.tool_name === "Skill"), "skill");
  add("P78", "Skill content as meta user node", has("skill_meta_content"), "skill");
  add("P80", "Final assistant skill attribution", promptRows.some((r) => r.attribution_skill), "skill");
  return hits;
}

/* ============================================================================
   UI
   ============================================================================ */

const CAT_LABELS = {
  session: "Session Structure", tool_loop: "Tool Loop", file_mod: "File Modification",
  hook: "Hook", mcp: "MCP", webfetch: "WebFetch", skill: "Skill",
};

const TOOL_ICON = {
  file_read: FileSearch, file_write: FileEdit, shell: Terminal, mcp: Plug,
  webfetch: Globe, skill: Cpu, discovery: Search, file_discover: FileSearch, other: Wrench,
};

function fmtDur(ms) {
  const n = parseInt(ms, 10);
  if (!n || isNaN(n)) return "—";
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}
function shortTime(ts) {
  if (!ts) return "—";
  const t = String(ts).split("T")[1];
  return t ? t.replace("Z", "").slice(0, 8) : ts;
}

export default function ForensicWorkbench() {
  const [session, setSession] = useState(null);
  const [fileName, setFileName] = useState("");
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  const handleText = useCallback((text, name) => {
    try {
      const parsed = parseSession(text);
      if (!parsed.nodes.length) { setError("No JSONL records found in this file."); return; }
      setSession(parsed); setFileName(name || "pasted session"); setError(""); setTab("overview");
    } catch (e) { setError("Parse failure: " + e.message); }
  }, []);

  const onFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => handleText(String(r.result), f.name);
    r.readAsText(f);
  };
  const onDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => handleText(String(r.result), f.name);
    r.readAsText(f);
  };

  return (
    <div style={styles.root}>
      <style>{CSS}</style>
      <Header fileName={fileName} session={session} onReset={() => { setSession(null); setFileName(""); }} />
      {!session ? (
        <Landing onFile={onFile} onDrop={onDrop} fileRef={fileRef} error={error} onText={handleText} />
      ) : (
        <div className="fw-body">
          <Tabs tab={tab} setTab={setTab} session={session} />
          <div className="fw-content">
            {tab === "overview" && <OverviewTab session={session} />}
            {tab === "timeline" && <TimelineTab session={session} />}
            {tab === "actions" && <ActionsTab session={session} />}
            {tab === "files" && <FilesTab session={session} />}
            {tab === "patterns" && <PatternsTab session={session} />}
            {tab === "raw" && <RawTab session={session} />}
          </div>
        </div>
      )}
    </div>
  );
}

function Header({ fileName, session, onReset }) {
  return (
    <header className="fw-header">
      <div className="fw-brand">
        <Shield size={20} className="fw-brand-icon" />
        <div>
          <div className="fw-brand-name">CLAUDE CODE · SESSION WORKBENCH</div>
          <div className="fw-brand-sub">forensic reconstruction of one project JSONL · evidence stays in-browser</div>
        </div>
      </div>
      {session && (
        <div className="fw-header-right">
          <span className="fw-file-chip"><FileJson size={13} /> {fileName}</span>
          <button className="fw-reset" onClick={onReset}>Load another</button>
        </div>
      )}
    </header>
  );
}

function Landing({ onFile, onDrop, fileRef, error, onText }) {
  const [paste, setPaste] = useState("");
  return (
    <div className="fw-landing">
      <div className="fw-drop" onDrop={onDrop} onDragOver={(e) => e.preventDefault()} onClick={() => fileRef.current?.click()}>
        <Upload size={30} />
        <div className="fw-drop-title">Drop a session JSONL file</div>
        <div className="fw-drop-sub">…or click to browse · <code>.claude/projects/&lt;key&gt;/&lt;uuid&gt;.jsonl</code></div>
        <input type="file" ref={fileRef} onChange={onFile} accept=".jsonl,.json,.txt" hidden />
      </div>
      <div className="fw-paste">
        <div className="fw-paste-label">or paste JSONL content</div>
        <textarea className="fw-paste-area" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"type":"mode",...}&#10;{"type":"user",...}' />
        <button className="fw-paste-btn" disabled={!paste.trim()} onClick={() => onText(paste, "pasted session")}>Reconstruct session</button>
      </div>
      {error && <div className="fw-error"><CircleAlert size={15} /> {error}</div>}
      <div className="fw-landing-note">
        Reads one JSONL file only. Does not read Sysmon, Procmon, network, memory, or other <code>.claude</code> files.
        Claims requiring those sources are flagged, not assumed.
      </div>
    </div>
  );
}

const TABS = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "timeline", label: "Prompt Timeline", icon: Layers },
  { id: "actions", label: "Action Chain", icon: Wrench },
  { id: "files", label: "File Effects", icon: FileText },
  { id: "patterns", label: "Patterns", icon: Hash },
  { id: "raw", label: "Raw Graph", icon: Database },
];

function Tabs({ tab, setTab, session }) {
  const f = session.summary.flags;
  const dot = (id) => {
    if (id === "actions" && (f.has_hook || f.has_mcp || f.has_webfetch)) return "warn";
    if (id === "patterns" && session.patternHits.some((p) => p.detected && p.manual)) return "warn";
    return null;
  };
  return (
    <nav className="fw-tabs">
      {TABS.map((t) => {
        const Icon = t.icon; const d = dot(t.id);
        return (
          <button key={t.id} className={`fw-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            <Icon size={15} /> <span>{t.label}</span>
            {d && <span className={`fw-tab-dot ${d}`} />}
          </button>
        );
      })}
    </nav>
  );
}

/* ---- Tab 1: Overview ---- */
function OverviewTab({ session }) {
  const { summary, classCounts, patternHits } = session;
  const s = summary; const f = s.flags;
  const detected = patternHits.filter((p) => p.detected).length;
  const manual = patternHits.filter((p) => p.detected && p.manual).length;
  const maxCount = Math.max(...Object.values(classCounts), 1);
  const sortedClasses = Object.entries(classCounts).sort((a, b) => b[1] - a[1]);

  const flagDefs = [
    ["has_tool_use", "Tool use", Wrench], ["has_hook", "Hook fired", Webhook],
    ["has_mcp", "MCP called", Plug], ["has_webfetch", "WebFetch", Globe],
    ["has_skill", "Skill", Cpu], ["has_error_recovery", "Error recovery", AlertTriangle],
    ["has_api_retry", "API retry", Clock], ["has_version_drift", "Version drift", GitBranch],
    ["has_target_divergence", "Target divergence", ArrowRight],
  ];

  return (
    <div className="fw-tab-pane">
      <div className="fw-grid">
        <div className="fw-card fw-card-wide">
          <div className="fw-card-h"><Hash size={14} /> Session header</div>
          <div className="fw-kv-grid">
            <KV k="Session ID" v={Array.isArray(s.session_id) ? s.session_id.join(", ") : s.session_id} mono />
            <KV k="Project (cwd)" v={Array.isArray(s.cwd) ? s.cwd.join(", ") : s.cwd} mono />
            <KV k="Version" v={Array.isArray(s.version) ? <span className="fw-warn-text">{s.version.join(" → ")} (drift)</span> : s.version} mono />
            <KV k="Permission mode" v={Array.isArray(s.permission_mode) ? s.permission_mode.join(", ") : s.permission_mode} />
            <KV k="First event" v={shortTime(s.first_timestamp)} mono />
            <KV k="Last event" v={shortTime(s.last_timestamp)} mono />
            <KV k="Records" v={s.record_count} />
            <KV k="Prompt turns" v={s.prompt_count} />
            <KV k="Tool pairs" v={s.tool_pair_count} />
          </div>
        </div>
        <div className="fw-card fw-card-pattern">
          <div className="fw-card-h"><Hash size={14} /> Pattern coverage</div>
          <div className="fw-bignum">{detected}<span className="fw-bignum-sub"> / 82</span></div>
          <div className="fw-bignum-label">structural patterns detected</div>
          {manual > 0 && <div className="fw-manual-pill"><AlertTriangle size={12} /> {manual} need manual corroboration</div>}
        </div>
      </div>

      <div className="fw-card">
        <div className="fw-card-h"><Activity size={14} /> Capability flags</div>
        <div className="fw-flags">
          {flagDefs.map(([key, label, Icon]) => {
            const on = f[key];
            return (
              <div key={key} className={`fw-flag ${on ? "on" : "off"}`}>
                <Icon size={14} />
                <span>{label}</span>
                {key === "has_api_retry" && on ? <b>{f.api_retry_count}×</b> : on ? <CircleCheck size={13} /> : <span className="fw-flag-no">—</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="fw-card">
        <div className="fw-card-h"><Layers size={14} /> Content-class distribution</div>
        <div className="fw-bars">
          {sortedClasses.map(([cls, n]) => (
            <div key={cls} className="fw-bar-row">
              <div className="fw-bar-label">{cls}</div>
              <div className="fw-bar-track"><div className="fw-bar-fill" style={{ width: `${(n / maxCount) * 100}%` }} /></div>
              <div className="fw-bar-num">{n}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function KV({ k, v, mono }) {
  return (
    <div className="fw-kv">
      <div className="fw-kv-k">{k}</div>
      <div className={`fw-kv-v ${mono ? "mono" : ""}`}>{v || <span className="fw-dim">—</span>}</div>
    </div>
  );
}

/* ---- Tab 2: Prompt Timeline ---- */
function TimelineTab({ session }) {
  const { promptRows } = session;
  if (!promptRows.length) return <Empty msg="No user prompt turns found in this session." />;
  return (
    <div className="fw-tab-pane">
      <div className="fw-timeline">
        {promptRows.map((p, i) => <TurnCard key={p.root_prompt_id || i} turn={p} idx={i + 1} />)}
      </div>
    </div>
  );
}

function turnStatus(t) {
  if (t.had_error_recovery || t.api_retry_count > 0) return "red";
  if (t.hooks.length || t.mcp_tools_called.length || t.webfetch_urls.length || t.skills_invoked.length) return "yellow";
  return "green";
}

function TurnCard({ turn, idx }) {
  const [open, setOpen] = useState(false);
  const status = turnStatus(turn);
  const real = turn.tool_rows.filter((r) => r.tool_category !== "discovery");
  const sideEffects = turn.tool_rows.filter((r) => r.hook_fired === "true" || ["mcp", "webfetch", "skill"].includes(r.tool_category));
  return (
    <div className={`fw-turn ${status} ${open ? "open" : ""}`}>
      <button className="fw-turn-head" onClick={() => setOpen(!open)}>
        <span className="fw-turn-idx">{idx}</span>
        <span className={`fw-turn-bar ${status}`} />
        <span className="fw-turn-prompt">{turn.prompt_text.slice(0, 130) || <em className="fw-dim">[no prompt text]</em>}</span>
        <span className="fw-turn-tools">
          {turn.tool_names_used.slice(0, 4).map((t) => <span key={t} className="fw-chip">{t}</span>)}
          {turn.tool_names_used.length > 4 && <span className="fw-chip dim">+{turn.tool_names_used.length - 4}</span>}
        </span>
        <span className="fw-turn-time">{shortTime(turn.prompt_timestamp)}</span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && (
        <div className="fw-turn-body">
          {turn.target_divergence_detected && (
            <div className="fw-divergence">
              <ArrowRight size={14} /> Target divergence — requested <code>{turn.requested_targets.join(", ")}</code> · accessed <code>{turn.actual_targets.join(", ")}</code>
            </div>
          )}
          <Section label="Prompt"><pre className="fw-pre">{turn.prompt_text}</pre></Section>

          <Section label={`Tool chain (${real.length})`}>
            {real.length ? real.map((r, i) => <ActionRow key={i} row={r} compact />) : <span className="fw-dim">No direct tool calls.</span>}
            {turn.discovery_steps.length > 0 && (
              <div className="fw-discovery-note"><Search size={12} /> discovery: {turn.discovery_steps.join(", ")} (ToolSearch — not the action itself)</div>
            )}
          </Section>

          {sideEffects.length > 0 && (
            <Section label="Side effects" warn>
              {sideEffects.map((r, i) => (
                r.hook_fired === "true"
                  ? <HookRow key={i} row={r} />
                  : <ActionRow key={i} row={r} compact />
              ))}
            </Section>
          )}

          {(turn.attribution_mcp_server || turn.attribution_skill) && (
            <Section label="Attribution">
              {turn.attribution_mcp_server && <div className="fw-attr">MCP server: <code>{turn.attribution_mcp_server}</code> · tool <code>{turn.attribution_mcp_tool}</code></div>}
              {turn.attribution_skill && <div className="fw-attr">Skill: <code>{turn.attribution_skill}</code></div>}
            </Section>
          )}

          <Section label="Final response">
            <pre className="fw-pre">{turn.final_response_text || <span className="fw-dim">[none recorded]</span>}</pre>
          </Section>

          <div className="fw-turn-meta">
            <span><Clock size={12} /> {fmtDur(turn.turn_duration_ms)}</span>
            {turn.api_retry_count > 0 && <span className="warn"><AlertTriangle size={12} /> {turn.api_retry_count} API retries</span>}
            {turn.message_count && <span>{turn.message_count} messages</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ label, warn, children }) {
  return (
    <div className={`fw-section ${warn ? "warn" : ""}`}>
      <div className="fw-section-label">{label}</div>
      <div className="fw-section-body">{children}</div>
    </div>
  );
}

/* ---- Tab 3: Action Chain ---- */
function ActionsTab({ session }) {
  const { promptRows } = session;
  const hasAny = promptRows.some((p) => p.tool_rows.length);
  if (!hasAny) return <Empty msg="No tool operations in this session." />;
  return (
    <div className="fw-tab-pane">
      {promptRows.filter((p) => p.tool_rows.length).map((p, i) => (
        <div key={i} className="fw-action-group">
          <div className="fw-action-group-h">
            <span className="fw-turn-idx sm">{i + 1}</span>
            {p.prompt_text.slice(0, 90)}
          </div>
          {p.tool_rows.map((r, j) => (
            r.hook_fired === "true" ? <HookRow key={j} row={r} /> : <ActionRow key={j} row={r} />
          ))}
        </div>
      ))}
    </div>
  );
}

function ActionRow({ row, compact }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICON[row.tool_category] || Wrench;
  const isErr = row.is_error === "true";
  const isDiscovery = row.tool_category === "discovery";
  const expandable = row.input_content || row.result_content_excerpt || row.stdout || row.stderr || row.structured_patch;
  return (
    <div className={`fw-act ${isErr ? "err" : ""} ${isDiscovery ? "discovery" : ""} ${compact ? "compact" : ""}`}>
      <button className="fw-act-head" onClick={() => expandable && setOpen(!open)} style={{ cursor: expandable ? "pointer" : "default" }}>
        <Icon size={14} className="fw-act-icon" />
        <span className="fw-act-name">{row.tool_name}</span>
        <span className="fw-act-cat">{row.tool_category}</span>
        <span className="fw-act-path mono">{row.input_path || <span className="fw-dim">—</span>}</span>
        {row.actual_path && row.actual_path !== row.input_path && (
          <span className="fw-act-actual mono"><ArrowRight size={11} /> {row.actual_path}</span>
        )}
        {row.result_type && <span className="fw-act-rtype">{row.result_type}</span>}
        {row.http_code && <span className="fw-act-http">{row.http_code}</span>}
        {isErr && <span className="fw-act-err"><CircleAlert size={12} /> error</span>}
        <span className="fw-act-time">{fmtDur(row.duration_ms)}</span>
        {expandable && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
      </button>
      {open && expandable && (
        <div className="fw-act-body">
          {row.input_content && <Field label="input"><pre className="fw-pre sm">{row.input_content}</pre></Field>}
          {row.result_content_excerpt && <Field label="result"><pre className="fw-pre sm">{row.result_content_excerpt}</pre></Field>}
          {row.stdout && <Field label="stdout"><pre className="fw-pre sm">{row.stdout}</pre></Field>}
          {row.stderr && <Field label="stderr"><pre className="fw-pre sm err">{row.stderr}</pre></Field>}
        </div>
      )}
    </div>
  );
}

function HookRow({ row }) {
  const exit = row.hook_exit_code;
  const anomaly = row.hook_stderr && (exit === "0" || exit === 0);
  return (
    <div className="fw-hook">
      <div className="fw-hook-head">
        <Webhook size={14} />
        <span className="fw-hook-tag">HOOK SIDE EFFECT</span>
        <span className="fw-hook-note">triggered by a configured hook — not directly requested</span>
        <span className={`fw-hook-exit ${exit === "0" || exit === 0 ? "ok" : "bad"}`}>exit {exit || "?"}</span>
      </div>
      <div className="fw-hook-cmd mono">{row.hook_command}</div>
      {row.hook_targets && <div className="fw-hook-target">writes → <code>{row.hook_targets}</code> <span className="fw-hook-caveat">(not in any Write tool_use — confirm with host logs)</span></div>}
      {anomaly && <div className="fw-hook-anomaly"><AlertTriangle size={12} /> stderr present despite exit 0 — verify hook outcome independently</div>}
      {row.hook_stderr && <pre className="fw-pre sm err">{row.hook_stderr}</pre>}
    </div>
  );
}

function Field({ label, children }) {
  return <div className="fw-field"><span className="fw-field-label">{label}</span>{children}</div>;
}

/* ---- Tab 4: File Effects ---- */
function FilesTab({ session }) {
  const { toolRows } = session;
  const reads = toolRows.filter((r) => r.tool_category === "file_read");
  const writes = toolRows.filter((r) => r.tool_category === "file_write");
  if (!reads.length && !writes.length) return <Empty msg="No file reads or writes in this session." />;
  return (
    <div className="fw-tab-pane">
      <div className="fw-caveat-banner"><AlertTriangle size={13} /> File presence on disk requires the project copy or Procmon. This view reconstructs from the session JSONL only.</div>
      {writes.length > 0 && (
        <div className="fw-fsec">
          <div className="fw-fsec-h"><FileEdit size={15} /> Files written ({writes.length})</div>
          {writes.map((r, i) => <WriteCard key={i} row={r} />)}
        </div>
      )}
      {reads.length > 0 && (
        <div className="fw-fsec">
          <div className="fw-fsec-h"><FileSearch size={15} /> Files read ({reads.length})</div>
          {reads.map((r, i) => (
            <div key={i} className="fw-read">
              <div className="fw-read-path mono">{r.actual_path || r.input_path}</div>
              {r.result_content_excerpt && <pre className="fw-pre sm">{r.result_content_excerpt}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WriteCard({ row }) {
  const isUpdate = row.result_type === "update";
  let patch = null;
  if (row.structured_patch) { try { patch = JSON.parse(row.structured_patch); } catch {} }
  return (
    <div className="fw-write">
      <div className="fw-write-h">
        <span className="fw-write-path mono">{row.actual_path || row.input_path}</span>
        <span className={`fw-write-type ${isUpdate ? "upd" : "new"}`}>{row.result_type || "write"}</span>
        {row.actual_path && row.actual_path !== row.input_path && <span className="fw-warn-text mono">(requested {row.input_path})</span>}
      </div>
      {isUpdate && patch ? (
        <div className="fw-diff">{renderPatch(patch)}</div>
      ) : isUpdate && row.original_file ? (
        <div className="fw-panels">
          <div className="fw-panel"><div className="fw-panel-h">before (originalFile)</div><pre className="fw-pre sm">{row.original_file}</pre></div>
          <div className="fw-panel"><div className="fw-panel-h">after</div><pre className="fw-pre sm">{row.input_content || row.result_content_excerpt}</pre></div>
        </div>
      ) : (
        <pre className="fw-pre sm">{row.input_content || row.result_content_excerpt || <span className="fw-dim">[content not recorded]</span>}</pre>
      )}
    </div>
  );
}

function renderPatch(patch) {
  if (!Array.isArray(patch)) return <span className="fw-dim">[unparseable patch]</span>;
  return patch.map((hunk, hi) => (
    <div key={hi} className="fw-hunk">
      <div className="fw-hunk-h mono">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>
      {(hunk.lines || []).map((line, li) => {
        const sign = line[0];
        const cls = sign === "+" ? "add" : sign === "-" ? "del" : "ctx";
        return <div key={li} className={`fw-diff-line ${cls} mono`}>{line}</div>;
      })}
    </div>
  ));
}

/* ---- Tab 5: Patterns ---- */
function PatternsTab({ session }) {
  const { patternHits } = session;
  const byCat = {};
  patternHits.forEach((p) => (byCat[p.category] ||= []).push(p));
  return (
    <div className="fw-tab-pane">
      {Object.entries(byCat).map(([cat, pats]) => (
        <div key={cat} className="fw-pcat">
          <div className="fw-pcat-h">{CAT_LABELS[cat] || cat}</div>
          <div className="fw-pgrid">
            {pats.map((p) => {
              const cls = !p.detected ? "absent" : p.manual ? "manual" : "detected";
              return (
                <div key={p.id} className={`fw-pat ${cls}`}>
                  <div className="fw-pat-top">
                    <span className="fw-pat-id">{p.id}</span>
                    {p.detected ? (p.manual ? <AlertTriangle size={13} /> : <CircleCheck size={13} />) : <span className="fw-dim">○</span>}
                  </div>
                  <div className="fw-pat-name">{p.name}</div>
                  {p.note && <div className="fw-pat-note">{p.note}</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- Tab 6: Raw Graph ---- */
function RawTab({ session }) {
  const { nodes } = session;
  const [filter, setFilter] = useState("all");
  const classes = ["all", ...Object.keys(session.classCounts).sort()];
  const rows = filter === "all" ? nodes : nodes.filter((n) => n._content_class === filter);
  return (
    <div className="fw-tab-pane">
      <div className="fw-filter">
        <Filter size={14} />
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {classes.map((c) => <option key={c} value={c}>{c}{c !== "all" ? ` (${session.classCounts[c]})` : ` (${nodes.length})`}</option>)}
        </select>
        <span className="fw-filter-count">{rows.length} nodes</span>
      </div>
      <div className="fw-rawtable">
        <div className="fw-raw-head">
          <span>#</span><span>content_class</span><span>role</span><span>tool</span><span>uuid</span><span>summary</span>
        </div>
        {rows.map((n, i) => (
          <div key={i} className="fw-raw-row">
            <span className="mono dim">{n._line_number}</span>
            <span className="fw-raw-cc">{n._content_class}</span>
            <span className="mono">{get(n, "message", "role") || n.type}</span>
            <span className="mono">{(() => { const ti = iterMessageItems(n).find((x) => x.type === "tool_use"); return ti ? ti.name : ""; })()}</span>
            <span className="mono dim">{(n.uuid || "").slice(0, 8)}</span>
            <span className="fw-raw-sum">{rawSummary(n)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function rawSummary(n) {
  const cc = n._content_class;
  if (cc === "natural_user_prompt") return "PROMPT: " + extractMessageText(n, 90);
  if (cc.startsWith("assistant")) {
    return iterMessageItems(n).map((it) => it.type === "tool_use" ? `tool_use:${it.name}` : it.type === "text" ? `text:${(it.text || "").slice(0, 50)}` : it.type).join(" | ").slice(0, 120);
  }
  if (cc === "tool_result") { const it = iterMessageItems(n).find((x) => x.type === "tool_result"); return it ? (it.is_error ? "ERROR " : "OK ") + flattenText(it.content, 80) : ""; }
  if (cc === "attachment_hook_success") return "HOOK " + get(n, "attachment", "command").slice(0, 80);
  if (cc === "system_api_error") return "API_ERROR retry=" + (n.retryAttempt || "");
  if (cc === "system_turn_duration") return `turn ${n.durationMs}ms / ${n.messageCount} msgs`;
  return cc;
}

function Empty({ msg }) {
  return <div className="fw-empty"><FileText size={28} /><div>{msg}</div></div>;
}

const styles = { root: {} };

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');

:root{
  --bg:#ffffff; --bg2:#f8f8f6; --panel:#ffffff; --panel2:#f4f3ef;
  --line:#e4e2db; --line2:#d4d2cb;
  --ink:#1a1916; --ink2:#5a5850; --dim:#9e9b92;
  --blue:#1a56b0; --blue-bg:#eef3fb; --blue-bd:#b8ccee;
  --green:#1a7a45; --green-bg:#ecf7f1; --green-bd:#a8d9be;
  --red:#b52b2b; --red-bg:#fdf0f0; --red-bd:#e8b4b4;
  --yellow:#8a6000; --yellow-bg:#fdf6e3; --yellow-bd:#e8d08a;
  --teal:#0d6e6e; --teal-bg:#eaf5f5; --teal-bd:#9dd1d1;
  --mono:'IBM Plex Mono',monospace; --display:'DM Sans',sans-serif;
  --r4:4px; --r6:6px; --r8:8px; --r10:10px; --r12:12px;
}
*{box-sizing:border-box; margin:0; padding:0;}
body,#root{background:var(--bg2); min-height:100vh;}
[class^="fw-"]{font-family:var(--display);}
.mono,.fw-pre code,.fw-pre{font-family:var(--mono)!important;}

.fw-header{
  display:flex; justify-content:space-between; align-items:center;
  padding:12px 24px; background:var(--bg); border-bottom:1px solid var(--line);
  position:sticky; top:0; z-index:20;
}
.fw-brand{display:flex;align-items:center;gap:11px;}
.fw-brand-icon{color:var(--blue); flex-shrink:0;}
.fw-brand-name{font-weight:700;letter-spacing:.04em;font-size:13px;color:var(--ink); line-height:1.2;}
.fw-brand-sub{font-size:11px;color:var(--dim);margin-top:2px; letter-spacing:.01em;}
.fw-header-right{display:flex;align-items:center;gap:10px;}
.fw-file-chip{
  display:flex;align-items:center;gap:6px;font-family:var(--mono);
  font-size:11px;color:var(--blue);background:var(--blue-bg);
  padding:5px 10px;border-radius:var(--r6);border:1px solid var(--blue-bd);
}
.fw-reset{
  background:var(--bg); border:1px solid var(--line2); color:var(--ink2);
  padding:5px 12px; border-radius:var(--r6); font-size:12px; cursor:pointer;
  font-family:var(--display); font-weight:500; transition:.12s;
}
.fw-reset:hover{border-color:var(--blue);color:var(--blue);}

.fw-landing{max-width:640px;margin:64px auto;padding:0 24px;display:flex;flex-direction:column;gap:16px;}
.fw-drop{
  border:1.5px dashed var(--line2); border-radius:var(--r12); padding:48px;
  text-align:center; cursor:pointer; color:var(--ink2); background:var(--bg);
  transition:.15s;
}
.fw-drop:hover{border-color:var(--blue);background:var(--blue-bg);}
.fw-drop svg{color:var(--blue);margin-bottom:10px;}
.fw-drop-title{font-weight:600;font-size:16px;color:var(--ink);margin-bottom:6px;}
.fw-drop-sub{font-size:12px;color:var(--dim);}
.fw-drop-sub code{font-family:var(--mono);font-size:11px;}
.fw-paste{display:flex;flex-direction:column;gap:7px;}
.fw-paste-label{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.07em;font-weight:600;}
.fw-paste-area{
  min-height:110px; background:var(--bg); border:1px solid var(--line2); border-radius:var(--r8);
  color:var(--ink); padding:11px 13px; font-family:var(--mono); font-size:11.5px; resize:vertical;
}
.fw-paste-area:focus{outline:none;border-color:var(--blue);}
.fw-paste-btn{
  align-self:flex-start; background:var(--blue); color:#fff; border:none;
  padding:9px 18px; border-radius:var(--r8); font-weight:600; cursor:pointer;
  font-family:var(--display); font-size:13px; transition:.12s;
}
.fw-paste-btn:hover{background:#154a96;}
.fw-paste-btn:disabled{opacity:.4;cursor:not-allowed;}
.fw-error{
  display:flex;align-items:center;gap:8px;color:var(--red);
  background:var(--red-bg);border:1px solid var(--red-bd);
  padding:10px 14px;border-radius:var(--r8);font-size:12.5px;
}
.fw-landing-note{font-size:11.5px;color:var(--dim);line-height:1.65;border-top:1px solid var(--line);padding-top:14px;}
.fw-landing-note code{font-family:var(--mono);color:var(--ink2);}

.fw-body{display:flex;min-height:calc(100vh - 54px);}
.fw-tabs{
  width:200px; flex-shrink:0; background:var(--bg); border-right:1px solid var(--line);
  padding:12px 8px; display:flex; flex-direction:column; gap:2px;
  position:sticky; top:54px; height:calc(100vh - 54px); overflow-y:auto;
}
.fw-tab{
  display:flex; align-items:center; gap:9px; padding:9px 11px;
  border-radius:var(--r8); border:none; background:transparent;
  color:var(--ink2); font-size:12.5px; font-weight:500; cursor:pointer;
  text-align:left; font-family:var(--display); position:relative; transition:.11s;
}
.fw-tab:hover{background:var(--bg2);color:var(--ink);}
.fw-tab.active{background:var(--blue-bg);color:var(--blue);}
.fw-tab.active::before{
  content:""; position:absolute; left:0; top:7px; bottom:7px;
  width:2.5px; background:var(--blue); border-radius:0 2px 2px 0;
}
.fw-tab-dot{position:absolute;right:10px;width:6px;height:6px;border-radius:50%;}
.fw-tab-dot.warn{background:var(--yellow);}

.fw-content{flex:1;overflow:auto;background:var(--bg2);}
.fw-tab-pane{padding:24px 28px;max-width:1060px;}

.fw-grid{display:grid;grid-template-columns:1fr 260px;gap:14px;margin-bottom:14px;}
.fw-card{
  background:var(--bg);border:1px solid var(--line);border-radius:var(--r12);
  padding:16px 18px;margin-bottom:14px;
}
.fw-card-wide{margin-bottom:0;}
.fw-card-h{
  display:flex;align-items:center;gap:7px;font-size:10.5px;text-transform:uppercase;
  letter-spacing:.09em;color:var(--dim);font-weight:700;margin-bottom:13px;
}
.fw-card-pattern{margin-bottom:0;display:flex;flex-direction:column;}
.fw-bignum{font-size:44px;font-weight:700;color:var(--ink);line-height:1;}
.fw-bignum-sub{font-size:18px;color:var(--dim);}
.fw-bignum-label{font-size:12px;color:var(--ink2);margin-top:5px;}
.fw-manual-pill{
  display:inline-flex;align-items:center;gap:5px;margin-top:11px;
  font-size:11px;color:var(--yellow);background:var(--yellow-bg);
  padding:5px 9px;border-radius:var(--r6);border:1px solid var(--yellow-bd);align-self:flex-start;
}

.fw-kv-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:13px;}
.fw-kv-k{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin-bottom:3px;font-weight:600;}
.fw-kv-v{font-size:12.5px;color:var(--ink);word-break:break-all;line-height:1.4;}
.fw-kv-v.mono{font-size:11px;}
.fw-dim{color:var(--dim);}
.fw-warn-text{color:var(--yellow);}

.fw-flags{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;}
.fw-flag{
  display:flex;align-items:center;gap:7px;padding:8px 10px;border-radius:var(--r8);
  font-size:12px;font-weight:500;border:1px solid var(--line);background:var(--bg2);
}
.fw-flag.on{background:var(--green-bg);border-color:var(--green-bd);color:var(--green);}
.fw-flag.on svg:last-child{color:var(--green);margin-left:auto;}
.fw-flag.off{color:var(--dim);}
.fw-flag.off svg{opacity:.4;}
.fw-flag b{margin-left:auto;color:var(--yellow);font-weight:600;}
.fw-flag-no{margin-left:auto;font-size:11px;color:var(--dim);}

.fw-bars{display:flex;flex-direction:column;gap:4px;}
.fw-bar-row{display:flex;align-items:center;gap:10px;}
.fw-bar-label{width:190px;font-family:var(--mono);font-size:10.5px;color:var(--ink2);text-align:right;flex-shrink:0;}
.fw-bar-track{flex:1;height:12px;background:var(--bg2);border-radius:3px;overflow:hidden;border:1px solid var(--line);}
.fw-bar-fill{height:100%;background:var(--blue);border-radius:2px;opacity:.75;}
.fw-bar-num{width:30px;font-family:var(--mono);font-size:10px;color:var(--ink2);}

.fw-timeline{display:flex;flex-direction:column;gap:6px;}
.fw-turn{background:var(--bg);border:1px solid var(--line);border-radius:var(--r10);overflow:hidden;}
.fw-turn.open{border-color:var(--line2);box-shadow:0 1px 4px rgba(0,0,0,.05);}
.fw-turn-head{
  width:100%;display:flex;align-items:center;gap:11px;padding:11px 14px;
  background:none;border:none;cursor:pointer;text-align:left;color:var(--ink);
}
.fw-turn-head:hover{background:var(--bg2);}
.fw-turn-idx{
  width:22px;height:22px;border-radius:var(--r4);background:var(--bg2);
  color:var(--ink2);display:flex;align-items:center;justify-content:center;
  font-size:10.5px;font-weight:700;flex-shrink:0;font-family:var(--mono);
  border:1px solid var(--line);
}
.fw-turn-idx.sm{width:19px;height:19px;font-size:9.5px;}
.fw-turn-bar{width:3px;height:22px;border-radius:2px;flex-shrink:0;}
.fw-turn-bar.green{background:var(--green);}
.fw-turn-bar.yellow{background:#d4a017;}
.fw-turn-bar.red{background:var(--red);}
.fw-turn-prompt{flex:1;font-size:12.5px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);}
.fw-turn-tools{display:flex;gap:3px;flex-shrink:0;}
.fw-chip{
  font-family:var(--mono);font-size:9.5px;background:var(--bg2);color:var(--ink2);
  padding:2px 6px;border-radius:var(--r4);border:1px solid var(--line);
}
.fw-chip.dim{color:var(--dim);}
.fw-turn-time{font-family:var(--mono);font-size:10px;color:var(--dim);flex-shrink:0;}
.fw-turn-body{padding:4px 16px 16px;border-top:1px solid var(--line);background:var(--bg2);}

.fw-divergence{
  display:flex;align-items:center;gap:7px;background:var(--yellow-bg);
  border:1px solid var(--yellow-bd);color:var(--yellow);border-radius:0;
  border-left:3px solid #d4a017;padding:8px 11px;font-size:11.5px;margin:10px 0;
}
.fw-divergence code{font-family:var(--mono);color:var(--ink);}

.fw-section{margin-top:13px;}
.fw-section-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);font-weight:700;margin-bottom:6px;}
.fw-section.warn .fw-section-label{color:var(--yellow);}
.fw-pre{
  background:var(--bg);border:1px solid var(--line);border-radius:var(--r8);
  padding:10px 12px;font-size:11px;color:var(--ink2);white-space:pre-wrap;
  word-break:break-word;line-height:1.6;max-height:260px;overflow:auto;
}
.fw-pre.sm{font-size:10.5px;padding:8px 11px;max-height:180px;}
.fw-pre.err{color:var(--red);background:var(--red-bg);border-color:var(--red-bd);}

.fw-discovery-note{font-size:11px;color:var(--dim);display:flex;align-items:center;gap:6px;margin-top:5px;font-style:italic;}
.fw-attr{font-size:11.5px;color:var(--ink2);margin-bottom:3px;}
.fw-attr code{font-family:var(--mono);color:var(--blue);}
.fw-turn-meta{display:flex;gap:14px;margin-top:12px;padding-top:11px;border-top:1px solid var(--line);font-size:11px;color:var(--dim);}
.fw-turn-meta span{display:flex;align-items:center;gap:4px;}
.fw-turn-meta .warn{color:var(--yellow);}

.fw-act{
  border:1px solid var(--line);border-radius:var(--r8);margin-bottom:4px;
  background:var(--bg);overflow:hidden;
}
.fw-act.compact{background:var(--bg2);}
.fw-act.err{border-left:3px solid var(--red);}
.fw-act.discovery{opacity:.55;}
.fw-act-head{
  width:100%;display:flex;align-items:center;gap:8px;padding:8px 12px;
  background:none;border:none;text-align:left;color:var(--ink);
}
.fw-act-icon{color:var(--blue);flex-shrink:0;}
.fw-act.err .fw-act-icon{color:var(--red);}
.fw-act-name{font-weight:600;font-size:12px;flex-shrink:0;}
.fw-act-cat{
  font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);
  background:var(--bg2);padding:2px 5px;border-radius:3px;border:1px solid var(--line);flex-shrink:0;
}
.fw-act-path{flex:1;font-size:10.5px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);}
.fw-act-actual{font-size:10px;color:var(--yellow);display:flex;align-items:center;gap:3px;flex-shrink:0;font-family:var(--mono);}
.fw-act-rtype{font-size:9.5px;color:var(--blue);flex-shrink:0;}
.fw-act-http{font-family:var(--mono);font-size:9.5px;color:var(--green);flex-shrink:0;}
.fw-act-err{display:flex;align-items:center;gap:3px;font-size:10px;color:var(--red);flex-shrink:0;}
.fw-act-time{font-family:var(--mono);font-size:10px;color:var(--dim);flex-shrink:0;}
.fw-act-body{padding:4px 12px 10px;border-top:1px solid var(--line);background:var(--bg2);}
.fw-field{margin-top:7px;}
.fw-field-label{font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);display:block;margin-bottom:3px;font-weight:600;}

.fw-action-group{margin-bottom:16px;}
.fw-action-group-h{
  display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--ink2);
  margin-bottom:7px;font-weight:500;padding-bottom:6px;border-bottom:1px solid var(--line);
}

.fw-hook{
  border:1px solid var(--yellow-bd);border-left:3px solid #d4a017;border-radius:var(--r8);
  margin-bottom:5px;background:var(--yellow-bg);padding:11px 13px;
}
.fw-hook-head{display:flex;align-items:center;gap:8px;color:var(--yellow);}
.fw-hook-tag{font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;}
.fw-hook-note{font-size:10.5px;color:var(--ink2);font-style:italic;flex:1;}
.fw-hook-exit{font-family:var(--mono);font-size:10px;padding:2px 6px;border-radius:var(--r4);}
.fw-hook-exit.ok{background:var(--green-bg);color:var(--green);border:1px solid var(--green-bd);}
.fw-hook-exit.bad{background:var(--red-bg);color:var(--red);border:1px solid var(--red-bd);}
.fw-hook-cmd{font-size:11px;color:var(--ink);margin-top:8px;background:var(--bg);padding:7px 9px;border-radius:var(--r6);border:1px solid var(--line);word-break:break-all;font-family:var(--mono);}
.fw-hook-target{font-size:11px;color:var(--ink2);margin-top:6px;}
.fw-hook-target code{font-family:var(--mono);color:var(--teal);}
.fw-hook-caveat{color:var(--dim);font-style:italic;font-size:10px;}
.fw-hook-anomaly{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--yellow);margin-top:6px;}

.fw-caveat-banner{
  display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--ink2);
  background:var(--bg);border:1px solid var(--line);border-left:3px solid #d4a017;
  padding:9px 12px;border-radius:0 var(--r6) var(--r6) 0;margin-bottom:14px;
}
.fw-fsec{margin-bottom:20px;}
.fw-fsec-h{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--ink);margin-bottom:9px;}
.fw-read{background:var(--bg);border:1px solid var(--line);border-radius:var(--r8);padding:10px 13px;margin-bottom:6px;}
.fw-read-path{font-size:11.5px;color:var(--blue);margin-bottom:6px;word-break:break-all;font-family:var(--mono);}
.fw-write{background:var(--bg);border:1px solid var(--line);border-radius:var(--r10);padding:13px 15px;margin-bottom:9px;}
.fw-write-h{display:flex;align-items:center;gap:9px;margin-bottom:9px;flex-wrap:wrap;}
.fw-write-path{font-size:12px;color:var(--ink);font-weight:600;word-break:break-all;font-family:var(--mono);}
.fw-write-type{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:4px;font-weight:700;}
.fw-write-type.upd{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-bd);}
.fw-write-type.new{background:var(--green-bg);color:var(--green);border:1px solid var(--green-bd);}
.fw-panels{display:grid;grid-template-columns:1fr 1fr;gap:9px;}
.fw-panel-h{font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin-bottom:4px;font-weight:600;}
.fw-diff{background:var(--bg);border:1px solid var(--line);border-radius:var(--r8);overflow:hidden;}
.fw-hunk-h{background:var(--bg2);color:var(--blue);padding:4px 10px;font-size:10px;border-bottom:1px solid var(--line);font-family:var(--mono);}
.fw-diff-line{padding:1px 10px;font-size:10.5px;white-space:pre-wrap;word-break:break-all;font-family:var(--mono);}
.fw-diff-line.add{background:var(--green-bg);color:var(--green);}
.fw-diff-line.del{background:var(--red-bg);color:var(--red);}
.fw-diff-line.ctx{color:var(--ink2);}

.fw-pcat{margin-bottom:20px;}
.fw-pcat-h{
  font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink2);
  font-weight:700;margin-bottom:9px;padding-bottom:6px;border-bottom:1px solid var(--line);
}
.fw-pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(195px,1fr));gap:7px;}
.fw-pat{border:1px solid var(--line);border-radius:var(--r8);padding:9px 11px;background:var(--bg);}
.fw-pat.detected{border-color:var(--green-bd);background:var(--green-bg);}
.fw-pat.detected .fw-pat-id{color:var(--green);}
.fw-pat.manual{border-color:var(--yellow-bd);border-left:3px solid #d4a017;background:var(--yellow-bg);}
.fw-pat.manual .fw-pat-id{color:var(--yellow);}
.fw-pat.absent{background:var(--bg2);}
.fw-pat-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;}
.fw-pat-id{font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--dim);}
.fw-pat.detected svg{color:var(--green);}
.fw-pat.manual svg{color:var(--yellow);}
.fw-pat-name{font-size:11.5px;color:var(--ink);font-weight:500;line-height:1.35;}
.fw-pat.absent .fw-pat-name{color:var(--dim);}
.fw-pat-note{font-size:10px;color:var(--dim);margin-top:4px;font-style:italic;line-height:1.4;}

.fw-filter{display:flex;align-items:center;gap:9px;margin-bottom:12px;color:var(--ink2);}
.fw-filter select{
  background:var(--bg);border:1px solid var(--line2);color:var(--ink);
  padding:6px 10px;border-radius:var(--r6);font-family:var(--mono);font-size:11.5px;
}
.fw-filter-count{font-size:11px;color:var(--dim);}
.fw-rawtable{border:1px solid var(--line);border-radius:var(--r10);overflow:hidden;background:var(--bg);}
.fw-raw-head,.fw-raw-row{
  display:grid;grid-template-columns:46px 195px 80px 125px 85px 1fr;
  gap:8px;padding:7px 12px;font-size:10.5px;align-items:center;
}
.fw-raw-head{background:var(--bg2);color:var(--dim);text-transform:uppercase;letter-spacing:.06em;font-size:9.5px;font-weight:700;border-bottom:1px solid var(--line);}
.fw-raw-row{border-top:1px solid var(--line);color:var(--ink2);}
.fw-raw-row:hover{background:var(--bg2);}
.fw-raw-cc{color:var(--blue);font-family:var(--mono);font-size:10px;}
.fw-raw-sum{color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fw-raw-row .dim{color:var(--dim);}
.fw-raw-row .mono{font-family:var(--mono);}

.fw-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:11px;padding:80px 20px;color:var(--dim);font-size:13px;}
.fw-section-body .fw-dim{font-style:italic;}

@media(max-width:880px){.fw-grid{grid-template-columns:1fr;}.fw-kv-grid{grid-template-columns:1fr 1fr;}.fw-flags{grid-template-columns:1fr 1fr;}.fw-panels{grid-template-columns:1fr;}}
`;
