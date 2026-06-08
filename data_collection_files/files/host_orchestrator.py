#!/usr/bin/env python3
"""
Host-side wrapper for Claude Code forensic runs.

Flow:
0. Optionally revert VM to baseline before staging.
1. Validate manifest.
2. Stage VM-side script and manifest with vmrun.
3. Print the exact VM command.
4. Wait for operator.
5. Pull ZIP and ZIP sidecar SHA256 with vmrun.
6. Verify hashes automatically.
7. Archive and extract evidence.
8. Optionally revert VM to baseline with vmrun after archive.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def log(msg: str, log_file: Optional[Path] = None) -> None:
    line = f"[{utc_now()}] {msg}"
    print(line)
    if log_file:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def pause(instruction: str) -> None:
    print()
    print("=" * 60)
    print("OPERATOR ACTION REQUIRED")
    print("=" * 60)
    print(instruction)
    print()
    input("Press Enter when done...")


def run_vmrun(vmrun_path: Path, vmx_path: Path, args: list[str], guest_user: str = "", guest_password: str = "",
              needs_guest_auth: bool = False, check: bool = True) -> subprocess.CompletedProcess:
    cmd = [str(vmrun_path), "-T", "ws"]
    if needs_guest_auth:
        cmd.extend(["-gu", guest_user, "-gp", guest_password])
    cmd.extend(args[:1])
    cmd.append(str(vmx_path))
    cmd.extend(args[1:])
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise SystemExit(
            f"vmrun failed ({result.returncode}): {' '.join(cmd)}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result


def wait_for_vmware_tools(
    vmrun_path: Path,
    vmx_path: Path,
    log_file: Optional[Path] = None,
    timeout_seconds: int = 180,
) -> None:
    import time

    deadline = time.time() + timeout_seconds
    attempt = 0
    stdout = ""
    stderr = ""
    while time.time() < deadline:
        attempt += 1
        result = run_vmrun(
            vmrun_path, vmx_path,
            ["checkToolsState"],
            check=False
        )
        stdout = (result.stdout or "").strip().replace("\r", " ").replace("\n", " ")
        stderr = (result.stderr or "").strip().replace("\r", " ").replace("\n", " ")
        log(
            f"VMWARE_TOOLS_POLL attempt={attempt} returncode={result.returncode} stdout='{stdout}' stderr='{stderr}'",
            log_file,
        )
        stdout_lower = stdout.lower()
        if result.returncode == 0 and ("installed" in stdout_lower or "running" in stdout_lower):
            return
        time.sleep(5)
    raise SystemExit(
        "Timed out waiting for VMware Tools after pre-run revert/start.\n"
        f"Last stdout: {stdout}\nLast stderr: {stderr}"
    )


def load_manifest(manifest_path: Path) -> dict:
    with open(manifest_path, encoding="utf-8-sig") as f:
        manifest = json.load(f)

    required = [
        "run_id",
        "run_type",
        "probe_or_scenario",
        "baseline_snapshot",
        "project_path",
        "controlled_prompt",
        "vm",
        "instrumentation",
    ]
    missing = [k for k in required if k not in manifest]
    if missing:
        raise SystemExit(f"Manifest missing required keys: {missing}")

    return manifest


def validate_run_id(run_id: str) -> None:
    import re

    patterns = [
        r"^CLAUDE-WIN-[A-Z]+-[A-Z0-9_]+-R\d+$",
        r"^CLAUDE-WIN-[A-Z]+-[A-Z0-9_]+-[A-Z0-9_]+-R\d+$",
        r"^CC_[A-Z0-9]+_R\d+$",
    ]
    if any(re.match(p, run_id) for p in patterns):
        return
    raise SystemExit(
        "Unsupported run_id format. Expected either "
        "'CLAUDE-WIN-<PHASE>-<SCENARIO>-R<NUMBER>', 'CLAUDE-WIN-<PHASE>-<SCENARIO>-<CONFIG>-R<NUMBER>', or 'CC_<ID>_R<NUMBER>'."
    )


def generate_vm_command(vm_script_path: str, vm_manifest_path: str) -> str:
    return (
        f'powershell -ExecutionPolicy Bypass -File "{vm_script_path}" '
        f'-ManifestPath "{vm_manifest_path}"'
    )


def stage_files(
    manifest_path: Path,
    vm_script_src: Path,
    staging_dir: Path,
    log_file: Path,
    vm_stage_dir: str,
    vmrun_path: Path,
    vmx_path: Path,
    guest_user: str,
    guest_password: str,
) -> tuple[Path, Path, str]:
    staging_dir.mkdir(parents=True, exist_ok=True)
    staged_script = staging_dir / "vm_instrumentation.ps1"
    staged_manifest = staging_dir / manifest_path.name
    shutil.copy2(vm_script_src, staged_script)
    shutil.copy2(manifest_path, staged_manifest)

    log(f"Staged VM script: {staged_script}", log_file)
    log(f"Staged manifest: {staged_manifest}", log_file)
    log(f"VM script SHA256: {sha256_file(staged_script)}", log_file)
    log(f"Manifest SHA256: {sha256_file(staged_manifest)}", log_file)

    vm_script_dest = str(Path(vm_stage_dir) / "vm_instrumentation.ps1")
    vm_manifest_dest = str(Path(vm_stage_dir) / manifest_path.name)
    vm_command = generate_vm_command(vm_script_dest, vm_manifest_dest)

    exists = run_vmrun(
        vmrun_path, vmx_path,
        ["directoryExistsInGuest", vm_stage_dir],
        guest_user, guest_password,
        needs_guest_auth=True, check=False
    )
    if exists.returncode != 0:
        run_vmrun(
            vmrun_path, vmx_path,
            ["createDirectoryInGuest", vm_stage_dir],
            guest_user, guest_password,
            needs_guest_auth=True, check=True
        )

    run_vmrun(
        vmrun_path, vmx_path,
        ["CopyFileFromHostToGuest", str(staged_script), vm_script_dest],
        guest_user, guest_password,
        needs_guest_auth=True, check=True
    )
    run_vmrun(
        vmrun_path, vmx_path,
        ["CopyFileFromHostToGuest", str(staged_manifest), vm_manifest_dest],
        guest_user, guest_password,
        needs_guest_auth=True, check=True
    )
    log(f"Copied script to guest: {vm_script_dest}", log_file)
    log(f"Copied manifest to guest: {vm_manifest_dest}", log_file)
    return staged_script, staged_manifest, vm_command


def pull_file_from_guest(
    vmrun_path: Path,
    vmx_path: Path,
    guest_user: str,
    guest_password: str,
    expected_src: str,
    expected_dest: Path,
) -> None:
    expected_dest.parent.mkdir(parents=True, exist_ok=True)
    run_vmrun(
        vmrun_path, vmx_path,
        ["CopyFileFromGuestToHost", expected_src, str(expected_dest)],
        guest_user, guest_password,
        needs_guest_auth=True, check=True
    )
    if not expected_dest.exists():
        raise SystemExit(f"Expected pulled file not found after vmrun copy: {expected_dest}")


def archive_evidence(
    manifest: dict,
    pulled_zip: Path,
    pulled_sha: Path,
    archive_root: Path,
    manifest_source: Path,
    log_file: Path,
) -> Path:
    run_id = manifest["run_id"]
    archive_dir = archive_root / run_id
    archive_dir.mkdir(parents=True, exist_ok=True)

    archived_zip = archive_dir / pulled_zip.name
    archived_sha = archive_dir / pulled_sha.name
    shutil.copy2(pulled_zip, archived_zip)
    shutil.copy2(pulled_sha, archived_sha)
    archived_zip.chmod(0o444)
    archived_sha.chmod(0o444)

    extracted_dir = archive_dir / "extracted"
    extracted_dir.mkdir(exist_ok=True)
    shutil.unpack_archive(str(archived_zip), str(extracted_dir), "zip")

    extracted_hashes = []
    for p in sorted(extracted_dir.rglob("*")):
        if p.is_file():
            extracted_hashes.append(
                {"path": str(p.relative_to(archive_dir)), "sha256": sha256_file(p)}
            )

    zip_hash = sha256_file(pulled_zip)
    metadata = {
        "run_id": run_id,
        "import_timestamp_utc": utc_now(),
        "archive_dir": str(archive_dir),
        "zip_sha256": zip_hash,
        "baseline_snapshot": manifest.get("baseline_snapshot"),
        "dirty_snapshot_name": manifest.get("dirty_snapshot_name", ""),
        "controlled_prompt": manifest.get("controlled_prompt"),
        "project_path": manifest.get("project_path"),
        "instrumentation": manifest.get("instrumentation"),
        "manifest_source": str(manifest_source.resolve()),
    }

    with open(archive_dir / "import_metadata.json", "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)
    with open(archive_dir / "extracted_hashes.json", "w", encoding="utf-8") as f:
        json.dump(extracted_hashes, f, indent=2)

    log(f"Archived evidence to {archive_dir}", log_file)
    return archive_dir


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--vm-script-src", required=True)
    parser.add_argument("--host-workspace-root", required=True)
    parser.add_argument("--vmrun-path", default=r"C:\Program Files\VMware\VMware Workstation\vmrun.exe")
    parser.add_argument("--vmx-path", required=True)
    parser.add_argument("--guest-user", required=True)
    parser.add_argument("--guest-password", default="")
    parser.add_argument("--vm-stage-dir", default="C:\\AgentForensics\\scripts")
    parser.add_argument("--vm-export-dir", default="C:\\AgentForensics\\evidence")
    parser.add_argument("--pre-run-revert", action="store_true")
    parser.add_argument("--auto-revert", action="store_true")
    parser.add_argument("--stage-only", action="store_true")
    parser.add_argument("--pull-only", action="store_true")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    vm_script_src = Path(args.vm_script_src).resolve()
    workspace_root = Path(args.host_workspace_root).resolve()
    vmrun_path = Path(args.vmrun_path).resolve()
    vmx_path = Path(args.vmx_path).resolve()
    staging_dir = workspace_root / "staging"
    pulled_dir = staging_dir / "pulled"
    archive_root = workspace_root / "evidence_archive"

    manifest = load_manifest(manifest_path)
    run_id = manifest["run_id"]
    validate_run_id(run_id)

    if not vmrun_path.exists():
        raise SystemExit(f"vmrun.exe not found: {vmrun_path}")
    if not vmx_path.exists():
        raise SystemExit(f"VMX not found: {vmx_path}")

    guest_password = args.guest_password or getpass.getpass("Guest password: ")

    staging_dir.mkdir(parents=True, exist_ok=True)
    pulled_dir.mkdir(parents=True, exist_ok=True)
    log_file = staging_dir / f"host_orchestrator_{run_id}.log"
    invocation_file = staging_dir / f"vm_invocation_{run_id}.txt"

    log(f"HOST_ORCHESTRATOR_START {run_id}", log_file)

    if args.pre_run_revert and not args.pull_only:
        log(f"Pre-run revert to baseline snapshot: {manifest['baseline_snapshot']}", log_file)
        revert_result = run_vmrun(
            vmrun_path, vmx_path,
            ["revertToSnapshot", manifest["baseline_snapshot"]],
            check=True
        )
        log(
            f"Revert complete: returncode={revert_result.returncode} stdout='{(revert_result.stdout or '').strip()}' stderr='{(revert_result.stderr or '').strip()}'",
            log_file,
        )
        start_result = run_vmrun(
            vmrun_path, vmx_path,
            ["start"],
            check=False
        )
        log(
            f"VM start command issued: returncode={start_result.returncode} stdout='{(start_result.stdout or '').strip()}' stderr='{(start_result.stderr or '').strip()}'",
            log_file,
        )
        wait_for_vmware_tools(vmrun_path, vmx_path, log_file=log_file)
        log("VMware Tools available after pre-run revert/start", log_file)

    if not args.pull_only:
        if not vm_script_src.exists():
            raise SystemExit(f"VM script not found: {vm_script_src}")

        staged_script, staged_manifest, vm_command = stage_files(
            manifest_path, vm_script_src, staging_dir, log_file, args.vm_stage_dir,
            vmrun_path, vmx_path, args.guest_user, guest_password
        )

        with open(invocation_file, "w", encoding="utf-8") as f:
            f.write(vm_command + "\n")

        print()
        print("=" * 60)
        print("FILES STAGED INTO THE VM")
        print("=" * 60)
        print(f"Script:   {staged_script}")
        print(f"Manifest: {staged_manifest}")
        print(f"VM dir:   {args.vm_stage_dir}")
        print()
        print("RUN THIS INSIDE THE VM AFTER RESTORING THE BASELINE SNAPSHOT")
        print(vm_command)
        print()

        if args.stage_only:
            log("Stage-only complete", log_file)
            return

        input("Press Enter on the HOST when the VM-side run is fully complete and the evidence ZIP is ready...")

    vm_zip_src = f"{args.vm_export_dir}\\{run_id}_evidence.zip"
    vm_sha_src = f"{args.vm_export_dir}\\{run_id}_evidence.zip.sha256"
    local_zip = pulled_dir / f"{run_id}_evidence.zip"
    local_sha = pulled_dir / f"{run_id}_evidence.zip.sha256"

    pull_file_from_guest(vmrun_path, vmx_path, args.guest_user, guest_password, vm_zip_src, local_zip)
    pull_file_from_guest(vmrun_path, vmx_path, args.guest_user, guest_password, vm_sha_src, local_sha)

    actual_zip_hash = sha256_file(local_zip)
    sidecar_text = local_sha.read_text(encoding="utf-8-sig").strip()
    expected_zip_hash = sidecar_text.split()[0] if sidecar_text else ""

    if not expected_zip_hash:
        raise SystemExit("ZIP sidecar SHA256 file is empty or malformed.")
    if actual_zip_hash.lower() != expected_zip_hash.lower():
        raise SystemExit(
            f"ZIP hash mismatch. expected={expected_zip_hash} actual={actual_zip_hash}"
        )

    log(f"ZIP hash verified: {actual_zip_hash}", log_file)
    archive_dir = archive_evidence(
        manifest, local_zip, local_sha, archive_root, manifest_path, log_file
    )

    if args.auto_revert:
        run_vmrun(
            vmrun_path, vmx_path,
            ["revertToSnapshot", manifest["baseline_snapshot"]],
            check=True
        )
        log(f"VM reverted to baseline snapshot: {manifest['baseline_snapshot']}", log_file)
    else:
        pause(
            "Evidence pull and archive are complete.\n"
            f"Archive dir: {archive_dir}\n\n"
            f"Now revert the VM to the baseline snapshot:\n  {manifest['baseline_snapshot']}"
        )
    log("HOST_ORCHESTRATOR_COMPLETE", log_file)


if __name__ == "__main__":
    main()
