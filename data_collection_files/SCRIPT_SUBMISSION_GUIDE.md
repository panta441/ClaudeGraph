# SCRIPT_SUBMISSION_GUIDE

This document defines which scripts and manifests should be included in the double-blind artifact package for the Claude Code Windows experiments, and how reviewers should use them.

## Scope

Include only the files needed to reproduce the **Phase A** experiment workflow:

- host-side orchestration
- VM-side experiment execution
- Phase A manifest catalog
- one short runbook for usage

Do **not** include unrelated exploratory scripts, archived `last_experiment` automation, or files that expose operator identity, secrets, or environment-specific clutter.

## Recommended files to submit

### 1. Host / VM orchestration

Include these files from [`files`](./files):

- [`host_orchestrator.py`](./files/host_orchestrator.py)
- [`vm_instrumentation.ps1`](./files/vm_instrumentation.ps1)
- [`Archive-PulledRun.ps1`](./files/Archive-PulledRun.ps1)
- [`README_automation.md`](./files/README_automation.md)

These are the core files for:
- restoring the baseline snapshot
- staging the manifest and VM script into the guest
- guiding the operator through the run
- pulling and archiving the evidence package

### 2. Phase A manifests

Include the Phase A manifests from [`manifest_files/claude_win_manifests_vmrun_compatible/manifests`](./manifest_files/claude_win_manifests_vmrun_compatible/manifests):

- `CLAUDE-WIN-A-PROMPT-NOTOOL-R01.json`
- `CLAUDE-WIN-A-READ-FILE-R01.json`
- `CLAUDE-WIN-A-EDIT-FILE-R01.json`
- `CLAUDE-WIN-A-SHELL-COMMAND-R01.json`
- `CLAUDE-WIN-A-MULTIFILE-CREATE-R01.json`
- `CLAUDE-WIN-A-SETTINGS-READ-R01.json`
- `CLAUDE-WIN-A-CLAUDEMD-R01.json`
- `CLAUDE-WIN-A-MCP-BENIGN-R01.json`
- `CLAUDE-WIN-A-HOOK-BENIGN-R01.json`
- `CLAUDE-WIN-A-SESSION-CONTINUE-R01.json`
- `CLAUDE-WIN-A-MEMORY-DEFAULT-R01.json`
- `CLAUDE-WIN-A-SKILL-BENIGN-R01.json`
- `CLAUDE-WIN-A-WEBFETCH-BENIGN-R01.json`

If you want to simplify the submission package, place these in a dedicated folder such as:

- `submission_artifacts/manifests_phase_a/`

### 3. Optional but useful support file

Include:
- [`Experiment_Log.md`](./Experiment_Log.md)

This is helpful as an operator runbook, but review it for hardcoded local values before submission.

## Files to exclude from the submission package

Exclude these unless the paper explicitly depends on them:

- install/auth convenience scripts:
  - `Prepare-ClaudeInstallRun.ps1`
  - `Prepare-ClaudeAuthRun.ps1`
  - `Start-ClaudeInstallRun.ps1`
  - `Start-ClaudeAuthRun.ps1`
  - `Pull-ClaudeInstallRun.ps1`
- archived scripts under `last_experiment\`
- analysis-only scripts unless they are part of the reproducibility package
- local exploratory notes
- memory dumps, raw credentials, or personal workspace copies

## Double-blind requirements

Before submission, scrub or parameterize the following in the included scripts and docs:

- guest username (currently `<GUEST_USER>`)
- guest password references
- personal host paths if they reveal identity
- VM names if they reveal institution or author identity
- usernames in example paths
- any absolute paths that expose author identity beyond generic Windows conventions

Safe pattern:
- use placeholders in the documentation, for example:
  - `<GUEST_USER>`
  - `<HOST_WORKSPACE_ROOT>`
  - `<VMX_PATH>`
  - `<BASELINE_SNAPSHOT>`

The scripts themselves may still accept concrete command-line arguments; the issue is the **published documentation and examples**, not parameter support.

## Minimal reviewer workflow

A reviewer should be able to do the following with the submitted files:

1. Place the Phase A manifests in the expected manifest directory.
2. Review the manifest for the desired run.
3. Run the host orchestrator with that manifest.
4. Execute the staged VM script inside the Windows VM.
5. Allow the host wrapper to pull and archive the run evidence.

## Example usage template

Use placeholder values in the submission package:

```powershell
python .\files\host_orchestrator.py `
  --manifest ".\manifest_files\claude_win_manifests_vmrun_compatible\manifests\CLAUDE-WIN-A-PROMPT-NOTOOL-R01.json" `
  --vm-script-src ".\files\vm_instrumentation.ps1" `
  --host-workspace-root "<HOST_WORKSPACE_ROOT>" `
  --vmx-path "<VMX_PATH>" `
  --guest-user ".\<GUEST_USER>" `
  --vm-stage-dir "C:\AgentForensics\scripts" `
  --vm-export-dir "C:\AgentForensics\evidence" `
  --pre-run-revert
```

Inside the VM:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\AgentForensics\scripts\vm_instrumentation.ps1" `
  -ManifestPath "C:\AgentForensics\scripts\CLAUDE-WIN-A-PROMPT-NOTOOL-R01.json"
```

## Suggested package layout for submission

```text
submission_artifacts/
  files/
    host_orchestrator.py
    vm_instrumentation.ps1
    Archive-PulledRun.ps1
    README_automation.md
  manifests_phase_a/
    CLAUDE-WIN-A-PROMPT-NOTOOL-R01.json
    CLAUDE-WIN-A-READ-FILE-R01.json
    ...
  SCRIPT_SUBMISSION_GUIDE.md
```

## Final recommendation

For the paper submission, use:
- the **Phase A manifests**
- the **host/VM orchestrator scripts**
- this usage guide

That is the smallest script package that still explains and reproduces the experiment workflow clearly.
