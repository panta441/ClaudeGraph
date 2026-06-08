<#
.SYNOPSIS
    VM-side guided run script for Claude Code forensic experiments.

.DESCRIPTION
    Uses a full manifest file, writes structured ground truth, records operator
    checkpoints in VM local time with offset, collects evidence, hashes it, and
    packages it with a ZIP sidecar SHA256 file for host verification.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$ManifestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-NowVmLocal {
    return (Get-Date).ToString("o")
}

function Get-NowUtc {
    return (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
}

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-NowUtc), $Message
    Write-Host $line
    Add-Content -Path $script:TimingLog -Value $line -Encoding UTF8
}

function Pause-ForOperator {
    param([string]$Instruction)
    Write-Host ""
    Write-Host "=== OPERATOR ACTION REQUIRED ===" -ForegroundColor Yellow
    Write-Host $Instruction -ForegroundColor Cyan
    $null = Read-Host "Press Enter when done"
}

function Add-GT {
    param([string]$Key, [string]$Value)
    "{0}: {1}" -f $Key, $Value | Out-File -FilePath $script:GroundTruth -Append -Encoding UTF8
}

function Add-GT-Time {
    param([string]$Key)
    Add-GT $Key (Get-NowVmLocal)
}

function Add-GT-Json {
    param([string]$Key, $Value)
    Add-GT $Key (($Value | ConvertTo-Json -Compress -Depth 6))
}

if (-not (Test-Path $ManifestPath)) {
    throw "Manifest not found: $ManifestPath"
}

$Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
$RunId = [string]$Manifest.run_id
$RunType = [string]$Manifest.run_type
$ProbeOrScenario = [string]$Manifest.probe_or_scenario
$BaselineSnapshot = [string]$Manifest.baseline_snapshot
$ProjectPath = [string]$Manifest.project_path
$ControlledPrompt = [string]$Manifest.controlled_prompt
$Instrumentation = $Manifest.instrumentation

$DirtySnapshotName = ""
$DirtySnapshotPurpose = ""
if ($Manifest.PSObject.Properties.Name -contains "dirty_snapshot" -and $Manifest.dirty_snapshot) {
    if ($Manifest.dirty_snapshot.PSObject.Properties.Name -contains "expected_snapshot_name" -and $Manifest.dirty_snapshot.expected_snapshot_name) {
        $DirtySnapshotName = [string]$Manifest.dirty_snapshot.expected_snapshot_name
    }
    if ($Manifest.dirty_snapshot.PSObject.Properties.Name -contains "purpose" -and $Manifest.dirty_snapshot.purpose) {
        $DirtySnapshotPurpose = [string]$Manifest.dirty_snapshot.purpose
    }
} else {
    if ($Manifest.PSObject.Properties.Name -contains "dirty_snapshot_name" -and $Manifest.dirty_snapshot_name) {
        $DirtySnapshotName = [string]$Manifest.dirty_snapshot_name
    }
    if ($Manifest.PSObject.Properties.Name -contains "dirty_snapshot_purpose" -and $Manifest.dirty_snapshot_purpose) {
        $DirtySnapshotPurpose = [string]$Manifest.dirty_snapshot_purpose
    }
}

$TSharkEnabled = [bool]$Instrumentation.tshark
$TSharkPath = if ($Instrumentation.PSObject.Properties.Name -contains "tshark_path" -and $Instrumentation.tshark_path) {
    [string]$Instrumentation.tshark_path
} elseif ($Manifest.PSObject.Properties.Name -contains "tshark_path" -and $Manifest.tshark_path) {
    [string]$Manifest.tshark_path
} else {
    "C:\Program Files\Wireshark\tshark.exe"
}
$TSharkInterface = if ($Instrumentation.PSObject.Properties.Name -contains "tshark_interface" -and $Instrumentation.tshark_interface) {
    [int]$Instrumentation.tshark_interface
} elseif ($Manifest.PSObject.Properties.Name -contains "tshark_interface" -and $Manifest.tshark_interface) {
    [int]$Manifest.tshark_interface
} else {
    1
}
$TSharkProcess = $null

$ProcmonEnabled = [bool]$Instrumentation.procmon
$ProcmonPath = if ($Instrumentation.PSObject.Properties.Name -contains "procmon_path" -and $Instrumentation.procmon_path) {
    [string]$Instrumentation.procmon_path
} elseif ($Manifest.PSObject.Properties.Name -contains "procmon_path" -and $Manifest.procmon_path) {
    [string]$Manifest.procmon_path
} else {
    "C:\AgentForensics\tools\Procmon\Procmon64.exe"
}
$ProcmonPmlPath = $null

$Root = "C:\AgentForensics\experiments\$RunId"
$EvidDir = "$Root\evidence"
$AgentDir = "$EvidDir\agent"
$ProjectDir = "$EvidDir\project"
$WinDir = "$EvidDir\windows_logs"
$NetDir = "$EvidDir\network"
$MemDir = "$EvidDir\memory"
$HashDir = "$EvidDir\hashes"
$GTDir = "C:\AgentForensics\ground_truth"
$PcapPath = "$NetDir\$RunId.pcapng"
$Dirs = @($Root, $EvidDir, $AgentDir, $ProjectDir, $WinDir, $NetDir, $MemDir, $HashDir, $GTDir)
foreach ($D in $Dirs) {
    New-Item -ItemType Directory -Path $D -Force | Out-Null
}

$script:TimingLog = "$Root\timing_log.txt"
$script:GroundTruth = "$GTDir\ground_truth_$RunId.md"

Write-Log "SCRIPT_START RunId=$RunId"
Add-GT "RUN_ID" $RunId
Add-GT "TYPE" $RunType
Add-GT "PROBE_OR_SCENARIO" $ProbeOrScenario
Add-GT "BASELINE_SNAPSHOT" $BaselineSnapshot
Add-GT "DIRTY_SNAPSHOT_NAME_PLANNED" $DirtySnapshotName
Add-GT "DIRTY_SNAPSHOT_PURPOSE" $DirtySnapshotPurpose
Add-GT "PROJECT_PATH" $ProjectPath
Add-GT "CONTROLLED_PROMPT" $ControlledPrompt
Add-GT "MANIFEST_PATH" $ManifestPath
Add-GT-Json "VM" $Manifest.vm
Add-GT-Json "INSTRUMENTATION" $Instrumentation
Add-GT-Json "MARKERS" $Manifest.markers
Add-GT-Json "EXPECTED_ARTIFACTS" $Manifest.expected_artifacts
Add-GT-Json "EXPECTED_HOST_EFFECTS" $Manifest.expected_host_effects
Add-GT-Json "EXPECTED_NETWORK_EFFECTS" $Manifest.expected_network_effects
Add-GT "NOTES" ([string]$Manifest.notes)
Add-GT-Time "VM_TIME_BEFORE"
Add-GT-Time "INSTRUMENTATION_START_VM_TIME"
Add-GT "VM_HOSTNAME" $env:COMPUTERNAME
Add-GT "TSHARK_ENABLED" ($(if ($TSharkEnabled) { "YES" } else { "NO" }))
Add-GT "TSHARK_PATH" $TSharkPath
Add-GT "TSHARK_INTERFACE" ([string]$TSharkInterface)
Add-GT "PROCMON_ENABLED" ($(if ($ProcmonEnabled) { "YES" } else { "NO" }))
Add-GT "PROCMON_PATH" $ProcmonPath

try {
    $VmLocalIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -notlike "169.*" -and $_.IPAddress -ne "127.0.0.1" } |
        Select-Object -ExpandProperty IPAddress
    Add-GT "VM_LOCAL_IP" (($VmLocalIps | Sort-Object -Unique) -join ",")
} catch {
    Add-GT "VM_LOCAL_IP" "UNAVAILABLE"
}

$ClaudeVersion = ""
try {
    $ClaudeVersion = ((& claude --version 2>&1) | Out-String).Trim()
} catch {
    $ClaudeVersion = "ERROR: $($_.Exception.Message)"
}
Add-GT "CLAUDE_VERSION" $ClaudeVersion
try {
    $ClaudePath = ((where.exe claude 2>&1) | Out-String).Trim()
} catch {
    $ClaudePath = "UNAVAILABLE"
}
Add-GT "CLAUDE_PATH" $ClaudePath
Add-GT "VM_TIMEZONE" ((Get-TimeZone).Id)
Add-GT "VM_USERNAME" $env:USERNAME

if (-not (Test-Path $ProjectPath)) {
    New-Item -ItemType Directory -Path $ProjectPath -Force | Out-Null
    Add-GT "PROJECT_PATH_CREATED" "YES"
} else {
    Add-GT "PROJECT_PATH_CREATED" "NO"
}

$ProjectSetupInstruction = ""
if ($Manifest.PSObject.Properties.Name -contains "project_setup" -and $Manifest.project_setup) {
    $ProjectSetupInstruction = [string]$Manifest.project_setup
} elseif (
    $Manifest.PSObject.Properties.Name -contains "ground_truth_static" -and
    $Manifest.ground_truth_static -and
    $Manifest.ground_truth_static.PSObject.Properties.Name -contains "PROJECT_SETUP_REQUIRED" -and
    $Manifest.ground_truth_static.PROJECT_SETUP_REQUIRED
) {
    $ProjectSetupInstruction = [string]$Manifest.ground_truth_static.PROJECT_SETUP_REQUIRED
}

if ($ProjectSetupInstruction) {
    Add-GT "PROJECT_SETUP_REQUIRED" $ProjectSetupInstruction
    Pause-ForOperator "Project setup required before launch:`n$ProjectSetupInstruction`n`nComplete the project setup in $ProjectPath, then press Enter."
}

# Instrumentation confirmation / baseline
$SysmonRunning = $false
try {
    $svc = Get-Service -Name Sysmon* -ErrorAction SilentlyContinue
    if ($svc -and ($svc | Where-Object { $_.Status -eq "Running" })) {
        $SysmonRunning = $true
    }
} catch { }
Add-GT "SYSMON_RUNNING_AT_START" ($(if ($SysmonRunning) { "YES" } else { "NO" }))

Get-Process | Sort-Object ProcessName | Out-File "$WinDir\processes_pre.txt" -Encoding UTF8
Get-CimInstance Win32_Process |
    Select-Object ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath |
    Export-Csv "$WinDir\process_commandlines_pre.csv" -NoTypeInformation
netstat -ano | Out-File "$NetDir\netstat_pre.txt" -Encoding UTF8
ipconfig /displaydns | Out-File "$NetDir\dns_cache_pre.txt" -Encoding UTF8

if ($TSharkEnabled) {
    if (-not (Test-Path $TSharkPath)) {
        throw "tshark is enabled in the manifest but not found at: $TSharkPath"
    }
    if ($TSharkInterface -lt 1) {
        throw "tshark is enabled in the manifest but tshark_interface is invalid: $TSharkInterface"
    }

    $TSharkArgs = @("-i", "$TSharkInterface", "-w", $PcapPath)
    $TSharkProcess = Start-Process -FilePath $TSharkPath -ArgumentList $TSharkArgs -PassThru -WindowStyle Hidden
    Add-GT "PCAP_PATH" $PcapPath
    Add-GT "TSHARK_PID" ([string]$TSharkProcess.Id)
    Add-GT-Time "PCAP_START_CONFIRMED_VM_TIME"
    Write-Log "TSHARK_STARTED PID=$($TSharkProcess.Id) PCAP=$PcapPath"
}

if ($ProcmonEnabled) {
    if (-not (Test-Path $ProcmonPath)) {
        throw "Procmon is enabled in the manifest but not found at: $ProcmonPath"
    }
    $ProcmonDir = "$EvidDir\procmon"
    New-Item -ItemType Directory -Path $ProcmonDir -Force | Out-Null
    $ProcmonPmlPath = "$ProcmonDir\$RunId.pml"
    $ProcmonArgs = "/AcceptEula /Quiet /Minimized /BackingFile `"$ProcmonPmlPath`""
    Start-Process -FilePath $ProcmonPath -ArgumentList $ProcmonArgs | Out-Null
    Add-GT "PROCMON_PML_PATH" $ProcmonPmlPath
    Add-GT-Time "PROCMON_START_CONFIRMED_VM_TIME"
    Write-Log "PROCMON_STARTED PML=$ProcmonPmlPath"
}

Pause-ForOperator "Launch Claude in the project now.`ncd $ProjectPath`nclaude"
Add-GT-Time "CLAUDE_LAUNCH_VM_TIME"

Pause-ForOperator "Wait until the Claude prompt is visible, then press Enter."
Add-GT-Time "CLAUDE_PROMPT_VISIBLE_VM_TIME"

Write-Host ""
Write-Host "Submit this exact prompt:" -ForegroundColor Green
Write-Host $ControlledPrompt
Pause-ForOperator "Submit the prompt now, then press Enter."
Add-GT-Time "PROMPT1_SUBMITTED_VM_TIME"

$permSeen = Read-Host "Did Claude show a permission prompt? Y/N"
Add-GT "PERMISSION_PROMPT_SEEN" $permSeen
if ($permSeen -match '^[Yy]') {
    Add-GT-Time "PERMISSION_PROMPT_VM_TIME"
    $permText = Read-Host "Copy/type the permission prompt text"
    Add-GT "PERMISSION_PROMPT_TEXT" $permText
    $permDecision = Read-Host "Permission decision? ALLOWED / DENIED / OTHER"
    Add-GT "PERMISSION_DECISION" $permDecision
} else {
    Add-GT "PERMISSION_PROMPT_TEXT" "NONE"
    Add-GT "PERMISSION_DECISION" "N/A"
}

Pause-ForOperator "Wait until Claude is done and the prompt returns, then press Enter."
Add-GT-Time "AGENT_DONE_VM_TIME"

Pause-ForOperator "Keep Claude open. Take the hypervisor memory snapshot now."
Add-GT-Time "MEMORY_SNAPSHOT_REQUESTED_VM_TIME"
$MemorySnapshotName = Read-Host "Enter the exact memory snapshot name"
Add-GT "MEMORY_SNAPSHOT_NAME" $MemorySnapshotName
Add-GT-Time "MEMORY_SNAPSHOT_COMPLETED_VM_TIME"
Set-Content -Path "$MemDir\memory_snapshot_info.txt" -Value @(
    "MEMORY_SNAPSHOT_NAME: $MemorySnapshotName"
    "MEMORY_SNAPSHOT_COMPLETED_VM_TIME: $(Get-NowVmLocal)"
) -Encoding UTF8

Pause-ForOperator "Exit Claude now, then press Enter."
Add-GT-Time "CLAUDE_EXIT_VM_TIME"

if ($TSharkEnabled) {
    try {
        if ($TSharkProcess -and (Get-Process -Id $TSharkProcess.Id -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $TSharkProcess.Id -Force
            Write-Log "TSHARK_STOPPED PID=$($TSharkProcess.Id)"
        } else {
            Write-Log "TSHARK_PID_NOT_FOUND_AT_STOP"
        }
    } catch {
        Write-Log "TSHARK_STOP_ERROR $($_.Exception.Message)"
        Pause-ForOperator "Automatic tshark stop failed. Stop tshark manually now, then press Enter."
    }
    Add-GT-Time "PCAP_STOP_CONFIRMED_VM_TIME"
}

if ($ProcmonEnabled) {
    try {
        Start-Process -FilePath $ProcmonPath -ArgumentList "/Terminate" -Wait | Out-Null
        Write-Log "PROCMON_TERMINATE_SENT"
    } catch {
        Write-Warning "Could not terminate Procmon automatically: $($_.Exception.Message)"
        Pause-ForOperator "Automatic Procmon stop failed. Stop Procmon manually now, then press Enter."
    }
    Add-GT-Time "PROCMON_STOP_CONFIRMED_VM_TIME"
    Start-Sleep -Seconds 2
    if ($ProcmonPmlPath -and (Test-Path $ProcmonPmlPath)) {
        Add-GT "PROCMON_PML_COLLECTED" "YES"
    } else {
        Write-Warning "Procmon PML was not found at the expected path: $ProcmonPmlPath"
        Add-GT "PROCMON_PML_COLLECTED" "NO"
    }
}

Add-GT-Time "INSTRUMENTATION_STOP_VM_TIME"

Get-Process | Sort-Object ProcessName | Out-File "$WinDir\processes_post.txt" -Encoding UTF8
Get-CimInstance Win32_Process |
    Select-Object ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath |
    Export-Csv "$WinDir\process_commandlines_post.csv" -NoTypeInformation
netstat -ano | Out-File "$NetDir\netstat_post.txt" -Encoding UTF8
ipconfig /displaydns | Out-File "$NetDir\dns_cache_post.txt" -Encoding UTF8

if ($Instrumentation.collect_dot_claude -and (Test-Path "$env:USERPROFILE\.claude")) {
    robocopy "$env:USERPROFILE\.claude" "$AgentDir\user_dot_claude" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 | Out-Null
}
if (Test-Path "$env:USERPROFILE\.claude.json") {
    Copy-Item "$env:USERPROFILE\.claude.json" "$AgentDir\claude_user_root.json" -Force
}
if (Test-Path "$env:USERPROFILE\.cache\claude") {
    robocopy "$env:USERPROFILE\.cache\claude" "$AgentDir\user_cache_claude" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 | Out-Null
}
if (Test-Path "$env:USERPROFILE\.local\share\claude") {
    robocopy "$env:USERPROFILE\.local\share\claude" "$AgentDir\user_local_share_claude" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 | Out-Null
}
if (Test-Path "$env:USERPROFILE\.local\state\claude") {
    robocopy "$env:USERPROFILE\.local\state\claude" "$AgentDir\user_local_state_claude" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 | Out-Null
}
Get-ChildItem "$env:USERPROFILE" -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*claude*" } |
    Select-Object FullName, Length, CreationTimeUtc, LastWriteTimeUtc |
    Export-Csv "$AgentDir\claude_home_search.csv" -NoTypeInformation

if ($Instrumentation.collect_project -and (Test-Path $ProjectPath)) {
    robocopy "$ProjectPath" "$ProjectDir\project_copy" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 | Out-Null
}

wevtutil epl Microsoft-Windows-Sysmon/Operational "$WinDir\sysmon.evtx" 2>> "$Root\wevtutil_errors.txt"
wevtutil epl Security "$WinDir\security.evtx" 2>> "$Root\wevtutil_errors.txt"
wevtutil epl System "$WinDir\system.evtx" 2>> "$Root\wevtutil_errors.txt"
wevtutil epl Application "$WinDir\application.evtx" 2>> "$Root\wevtutil_errors.txt"
wevtutil epl Microsoft-Windows-PowerShell/Operational "$WinDir\powershell.evtx" 2>> "$Root\wevtutil_errors.txt"

$PSHist = "$env:APPDATA\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt"
if (Test-Path $PSHist) {
    Copy-Item $PSHist "$WinDir\ConsoleHost_history.txt" -Force
}
systeminfo 2>&1 | Out-File "$WinDir\systeminfo.txt" -Encoding UTF8

Copy-Item $ManifestPath "$Root\manifest_$RunId.json" -Force

Get-ChildItem "$EvidDir" -Recurse -File |
    Where-Object { $_.FullName -ne "$HashDir\evidence_hashes.csv" } |
    Get-FileHash -Algorithm SHA256 |
    Export-Csv "$HashDir\evidence_hashes.csv" -NoTypeInformation

$DirtySnapshotRequired = $false
if ($Manifest.PSObject.Properties.Name -contains "dirty_snapshot" -and $Manifest.dirty_snapshot) {
    if ($Manifest.dirty_snapshot.PSObject.Properties.Name -contains "required") {
        $DirtySnapshotRequired = [bool]$Manifest.dirty_snapshot.required
    }
}

if ($DirtySnapshotRequired) {
    Pause-ForOperator "If you are taking a dirty snapshot for this run, take it now, then press Enter."
    if ($DirtySnapshotName) {
        Add-GT "DIRTY_SNAPSHOT_NAME" $DirtySnapshotName
        Add-GT-Time "DIRTY_SNAPSHOT_VM_TIME"
        Add-GT "DIRTY_SNAPSHOT_PURPOSE" $DirtySnapshotPurpose
    } else {
        $ActualDirtyName = Read-Host "Enter dirty snapshot name, or leave blank if none"
        if ($ActualDirtyName) {
            Add-GT "DIRTY_SNAPSHOT_NAME" $ActualDirtyName
            Add-GT-Time "DIRTY_SNAPSHOT_VM_TIME"
            Add-GT "DIRTY_SNAPSHOT_PURPOSE" $DirtySnapshotPurpose
        }
    }
}

Add-GT-Time "VM_TIME_AFTER"
Copy-Item $script:GroundTruth "$Root\ground_truth_$RunId.md" -Force

$TimingSummary = @"
# Timing Summary: $RunId

- CLAUDE_LAUNCH_VM_TIME: $(Select-String -Path $script:GroundTruth -Pattern '^CLAUDE_LAUNCH_VM_TIME:' | ForEach-Object { $_.Line })
- CLAUDE_PROMPT_VISIBLE_VM_TIME: $(Select-String -Path $script:GroundTruth -Pattern '^CLAUDE_PROMPT_VISIBLE_VM_TIME:' | ForEach-Object { $_.Line })
- PROMPT1_SUBMITTED_VM_TIME: $(Select-String -Path $script:GroundTruth -Pattern '^PROMPT1_SUBMITTED_VM_TIME:' | ForEach-Object { $_.Line })
- AGENT_DONE_VM_TIME: $(Select-String -Path $script:GroundTruth -Pattern '^AGENT_DONE_VM_TIME:' | ForEach-Object { $_.Line })
- MEMORY_SNAPSHOT_NAME: $(Select-String -Path $script:GroundTruth -Pattern '^MEMORY_SNAPSHOT_NAME:' | ForEach-Object { $_.Line })
- CLAUDE_EXIT_VM_TIME: $(Select-String -Path $script:GroundTruth -Pattern '^CLAUDE_EXIT_VM_TIME:' | ForEach-Object { $_.Line })
"@
Set-Content -Path "$Root\timing_summary.md" -Value $TimingSummary -Encoding UTF8

$ZipPath = "C:\AgentForensics\evidence\$RunId`_evidence.zip"
$ZipShaPath = "$ZipPath.sha256"

if (Test-Path $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}
if (Test-Path $ZipShaPath) {
    Remove-Item -LiteralPath $ZipShaPath -Force
}

$SevenZip = @(
    "C:\Program Files\7-Zip\7z.exe",
    "C:\Program Files (x86)\7-Zip\7z.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $SevenZip) {
    throw "7-Zip not found. Install 7-Zip or update the script path."
}

& $SevenZip a -tzip $ZipPath "$Root\*" | Out-Null
$ZipHash = (Get-FileHash $ZipPath -Algorithm SHA256).Hash
"$ZipHash  $(Split-Path $ZipPath -Leaf)" | Set-Content $ZipShaPath -Encoding ASCII

Write-Log "SCRIPT_COMPLETE RunId=$RunId"
Write-Host ""
Write-Host "Evidence ZIP: $ZipPath"
Write-Host "Evidence ZIP SHA256: $ZipHash"
Write-Host "ZIP sidecar: $ZipShaPath"
Write-Host "Ground truth: $script:GroundTruth"
Write-Host "Now return to the host and press Enter there to pull the evidence."
