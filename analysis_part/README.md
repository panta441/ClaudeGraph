# Claude Code Forensics Phase A Submission Package

This package contains anonymized aggregate evaluation artifacts and the scripts/tooling needed to reproduce the reported Phase A tables. Raw evidence, memory dumps, raw strings files, `.claude` directories, credentials, and strict memory object excerpts are intentionally excluded.

## Contents

### tables/
- `disk_only_evaluation_matrix.csv` and `.md`: disk/session reconstruction metrics for 11 runs. Columns score prompt recovery, tool sequence, tool-use/result pairing, actual target recovery, side-effect/result evidence, capability label correctness, marker recovery, and reconstruction outcome.
- `parser_integrity_matrix.csv` and `.md`: session graph integrity numbers per run, including record counts, UUID/off-spine counts, root/orphan/dangling-link counts, and tool pairing rate.
- `memory_strings_only_recovery_matrix.csv` and `.md`: memory-only recovery matrix generated only from each run's `ascii_strings_with_offsets.txt` file using schema-pattern anchors and strict JSON carving.
- `memory_strings_only_run_summary.csv`: memory scan volume and recovery counts: total lines scanned, raw anchor hits, windows carved, strict reconstructed objects, and candidate fragments.
- `phase_a_reconstruction_evaluation_summary.md`: short methodology summary for the aggregate tables.

### scripts/
- `evaluate_phase_a_reconstruction.py`: batch disk/session evaluator. It reads local session JSONL and ground-truth files in the full private evidence tree and produces the disk and parser-integrity aggregate tables.
- `evaluate_memory_strings_only.py`: batch memory-only evaluator. It reads only per-run `ascii_strings_with_offsets.txt` files and produces the memory strings-only recovery tables.

### tool/
- `forensic_workbench_v2.jsx`: browser-side forensic workbench UI for individual session JSONL and memory strings review. It includes the same schema-trigger memory reconstruction approach used by the memory-only batch evaluator.

## Redaction Applied

The copied tables were redacted using these substitutions:
- `C:\coding-agent-forensics` -> `<PROJECT_ROOT>`
- `C:\AgentForensics` -> `<AGENT_FORENSICS_ROOT>`
- `C:\Users\<ORIGINAL_USER>` -> `C:\Users\<USER>`
- `C--Users-<ORIGINAL_USER>` -> `C--Users-<USER>`
- email addresses -> `<EMAIL>`
- personal display/name strings observed during review -> `<NAME>`

The scripts retain schema key names such as `emailAddress`, `accountUuid`, `accessToken`, and `refreshToken` because these are detector field names, not recovered secret values.

## Excluded By Design

The following are not included because they may contain private or sensitive data:
- raw memory dumps and `ascii_strings_with_offsets.txt`
- raw `.claude` directories and session JSONL files
- `claude_user_root.json`, `.credentials.json`, and other account/config artifacts
- `memory_strings_only_strict_objects.csv`
- `memory_strings_only_candidate_fragments.csv`
- older `_memory_only_strict_*` outputs with disk-match annotations

## Reproduction Notes

To reproduce the exact tables, run the scripts from the private project root where the raw evidence is available:

```powershell
python scripts\evaluate_phase_a_reconstruction.py
python scripts\evaluate_memory_strings_only.py
```

The memory-only table is the defensible table for volatile-memory claims. It is generated from raw strings only and should be preferred over older derived memory summaries that included disk-match annotations.

