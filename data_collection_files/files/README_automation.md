# Claude Code Forensics - Automation Quick Reference

## Files in this package

| File | Purpose |
|---|---|
| `experiment_manifest.json` | Per-run configuration file. Edit before each run. |
| `host_orchestrator.py` | Host-side wrapper for `vmrun` staging, waiting, pulling, verifying, archiving, and optional baseline revert. |
| `vm_instrumentation.ps1` | VM-side guided run script for timing, ground truth, collection, packaging. |

---

## Correct run order

Snapshot restore happens before the VM-side script is run.

```text
PRE-RUN
1. Restore VM to baseline snapshot manually, or use `--pre-run-revert`.
2. Boot/login to the VM and confirm VMware Tools is available.

HOST
3. Review experiment manifest.
4. Stage vm_instrumentation.ps1 and manifest into the VM with `vmrun`.
5. Display the exact VM command to run.
6. Wait.

VM
7. Run vm_instrumentation.ps1.
8. Script writes static ground truth from manifest.
9. Script starts or confirms instrumentation.
10. You launch Claude.
11. Script records Claude launch time.
12. You wait for prompt.
13. Script records prompt-visible time.
14. You submit the controlled prompt.
15. Script records prompt-submitted time.
16. You record permission prompt text and decision if present.
17. You wait for Claude completion.
18. Script records agent-done time.
19. Keep Claude open.
20. You take hypervisor memory snapshot.
21. Script records memory snapshot name and time.
22. You exit Claude.
23. Script stops run-specific instrumentation.
24. Script collects artifacts and hashes them.
25. Script packages evidence and writes ZIP + ZIP sidecar SHA256.
26. You optionally take a dirty snapshot and record it.

HOST
27. Press Enter.
28. Host pulls ZIP and ZIP sidecar SHA256 with `vmrun`.
29. Host verifies hashes automatically.
30. Host archives evidence and writes import metadata.
31. Optionally revert VM to baseline for the next run with `vmrun`.
```

---

## Important design rules

- The host script does not run Claude inside the VM.
- The VM script does not restore snapshots.
- Ground truth is written inside the VM during the run, not reconstructed later.
- Hypervisor memory snapshot is taken while Claude is still open.
- ZIP verification uses a pulled sidecar `.sha256` file, not manual retyping.
- `vmrun` is used for file transfer and optional baseline revert, not for subject interaction.
- Do not stage files into the VM and then restore the snapshot. Restore first, then stage.
- If `instrumentation.tshark` is `true`, `vm_instrumentation.ps1` auto-starts and auto-stops `tshark`.
- Set `instrumentation.tshark_interface` explicitly in the manifest. For your current VM, `1` corresponds to `Ethernet0`.
- If `instrumentation.procmon` is `true`, `vm_instrumentation.ps1` auto-starts Procmon with a backing file and auto-stops it at the end.
- Set `instrumentation.procmon_path` only if Procmon is not located at `C:\AgentForensics\tools\Procmon\Procmon64.exe`.

---

## Typical host command

```powershell
python .\files\host_orchestrator.py `
  --manifest .\files\experiment_manifest.json `
  --vm-script-src .\files\vm_instrumentation.ps1 `
  --host-workspace-root "<HOST_WORKSPACE_ROOT>" `
  --vmx-path "<REPO_ROOT>\Windows_VM\<VM_NAME>.vmx" `
  --guest-user ".\<GUEST_USER>" `
  --vm-stage-dir "C:\AgentForensics\scripts" `
  --vm-export-dir "C:\AgentForensics\evidence"
```

To have the host wrapper revert the baseline snapshot before staging, add:

```powershell
  --pre-run-revert
```

---

## Typical VM command

The host script prints the exact command. It will look like this:

```powershell
powershell -ExecutionPolicy Bypass -File C:\AgentForensics\scripts\vm_instrumentation.ps1 `
  -ManifestPath C:\AgentForensics\scripts\experiment_manifest.json
```

---

## Before each run

```text
[ ] Edit the manifest for the exact run ID and scenario
[ ] Set baseline snapshot name
[ ] Set expected dirty snapshot name
[ ] Set project path
[ ] Set controlled prompt
[ ] Set instrumentation flags
[ ] If using pcap, set `instrumentation.tshark_interface`
[ ] Restore the VM baseline snapshot before running the host orchestrator, or use `--pre-run-revert`
[ ] Run the host orchestrator
[ ] Run the printed VM command
```

---

## Ground truth fields expected

The VM script now writes structured key-value ground truth fields such as:

```text
RUN_ID:
TYPE:
PROBE_OR_SCENARIO:
BASELINE_SNAPSHOT:
VM_TIME_BEFORE:
CLAUDE_LAUNCH_VM_TIME:
CLAUDE_PROMPT_VISIBLE_VM_TIME:
PROMPT1_SUBMITTED_VM_TIME:
PERMISSION_PROMPT_SEEN:
PERMISSION_PROMPT_TEXT:
PERMISSION_DECISION:
AGENT_DONE_VM_TIME:
MEMORY_SNAPSHOT_REQUESTED_VM_TIME:
MEMORY_SNAPSHOT_NAME:
MEMORY_SNAPSHOT_COMPLETED_VM_TIME:
CLAUDE_EXIT_VM_TIME:
DIRTY_SNAPSHOT_NAME:
DIRTY_SNAPSHOT_VM_TIME:
VM_TIME_AFTER:
```

---

## Notes

- Use VM local time with offset for ground truth.
- Keep `timing_log.txt` and `timing_summary.md` as derived helpers, but ground truth is the primary record.
- Treat pulled evidence and extracted evidence as read-only on the host.
- The host wrapper now assumes VMware Workstation `vmrun.exe` is available on the host.
