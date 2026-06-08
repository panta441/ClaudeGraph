# Disk-Only Evaluation Matrix

Scores: `E`=exact/complete, `P`=partial, `I`=isolated, `N`=not recovered, `X`=not applicable.

|run_id|expected_chain|prompt_recovered|tool_sequence_recovered|tool_use_result_pairing|actual_target_recovered|side_effect_or_result_represented_in_jsonl|capability_label_correct|marker_expected_location_recovered|reconstruction_outcome|
|---|---|---|---|---|---|---|---|---|---|
|CLAUDE-WIN-A-PROMPT-NOTOOL-R01|prompt_only|E|E|X|X|X|E|E|Full|
|CLAUDE-WIN-A-READ-FILE-R01|file_read|E|E|E|E|X|E|E|Full|
|CLAUDE-WIN-A-EDIT-FILE-R01|file_write|E|E|E|E|E|E|E|Full|
|CLAUDE-WIN-A-SHELL-COMMAND-R01|shell|E|E|E|E|E|E|N|Partial|
|CLAUDE-WIN-A-MULTIFILE-CREATE-R01|file_write|E|E|E|E|E|E|E|Full|
|CLAUDE-WIN-A-SETTINGS-READ-R01|settings_read|P|E|E|E|X|E|E|Partial|
|CLAUDE-WIN-A-CLAUDEMD-R01|claudemd|E|E|E|E|X|E|E|Full|
|CLAUDE-WIN-A-MCP-BENIGN-R01|mcp|E|E|E|E|E|E|E|Full|
|CLAUDE-WIN-A-HOOK-BENIGN-R01|hook|E|E|E|E|E|E|E|Full|
|CLAUDE-WIN-A-WEBFETCH-BENIGN-R01|webfetch|E|E|E|E|E|E|E|Full|
|CLAUDE-WIN-A-SKILL-BENIGN-R01|skill|E|E|E|X|E|E|E|Full|
