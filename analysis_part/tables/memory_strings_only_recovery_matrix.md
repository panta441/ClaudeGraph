# Memory Strings-Only Recovery Matrix

Scores: `E`=strict full JSON object recovered, `P`=candidate fragment only, `N`=not recovered.

|run_id|strict_object_count|candidate_fragment_count|history_jsonl|session_jsonl_graph|assistant_response|account_identity|oauth_credentials|tool_use|tool_result|memory_reconstruction_outcome|
|---|---|---|---|---|---|---|---|---|---|---|
|CLAUDE-WIN-A-PROMPT-NOTOOL-R01|14|56|E|E|P|E|N|P|P|Partial|
|CLAUDE-WIN-A-READ-FILE-R01|15|52|E|E|P|E|E|P|P|Partial|
|CLAUDE-WIN-A-EDIT-FILE-R01|14|47|E|E|P|E|E|P|P|Partial|
|CLAUDE-WIN-A-SHELL-COMMAND-R01|14|56|E|E|P|E|E|P|P|Partial|
|CLAUDE-WIN-A-MULTIFILE-CREATE-R01|18|63|E|E|P|E|E|P|P|Partial|
|CLAUDE-WIN-A-SETTINGS-READ-R01|12|59|E|E|P|E|E|P|P|Partial|
|CLAUDE-WIN-A-CLAUDEMD-R01|12|46|E|E|P|E|E|P|P|Partial|
|CLAUDE-WIN-A-MCP-BENIGN-R01|15|65|E|E|P|E|E|P|P|Partial|
|CLAUDE-WIN-A-HOOK-BENIGN-R01|12|51|N|E|N|E|E|P|P|Partial|
|CLAUDE-WIN-A-WEBFETCH-BENIGN-R01|13|48|E|E|N|E|E|P|P|Partial|
|CLAUDE-WIN-A-SKILL-BENIGN-R01|14|43|E|E|P|E|E|P|P|Partial|
