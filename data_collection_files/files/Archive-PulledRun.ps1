<#
.SYNOPSIS
    Archive and extract an already-pulled experiment ZIP on the host.

.DESCRIPTION
    Verifies the pulled ZIP against its .sha256 sidecar, copies both into the
    evidence archive for the run, extracts the ZIP, and writes import metadata
    plus extracted file hashes. This is intended for recovery when the host
    wrapper pulled the files successfully but stopped before archive/extract.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$ManifestPath,

    [string]$HostWorkspaceRoot = "<HOST_WORKSPACE_ROOT>"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-UtcNowIso {
    return (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
}

function Get-Sha256Hex {
    param([Parameter(Mandatory=$true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-TextTrimmed {
    param([Parameter(Mandatory=$true)][string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) {
        $text = $text.Substring(1)
    }
    return $text.Trim()
}

$ManifestPath = (Resolve-Path $ManifestPath).Path
$WorkspaceRoot = (Resolve-Path $HostWorkspaceRoot).Path
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$RunId = [string]$Manifest.run_id

if (-not $RunId) {
    throw "Manifest does not contain run_id: $ManifestPath"
}

$PulledDir = Join-Path $WorkspaceRoot "staging\pulled"
$ArchiveRoot = Join-Path $WorkspaceRoot "evidence_archive"
$ArchiveDir = Join-Path $ArchiveRoot $RunId
$ExtractedDir = Join-Path $ArchiveDir "extracted"

$PulledZip = Join-Path $PulledDir "$RunId`_evidence.zip"
$PulledSha = Join-Path $PulledDir "$RunId`_evidence.zip.sha256"

if (-not (Test-Path -LiteralPath $PulledZip)) {
    throw "Pulled ZIP not found: $PulledZip"
}
if (-not (Test-Path -LiteralPath $PulledSha)) {
    throw "Pulled ZIP sidecar not found: $PulledSha"
}

$ActualZipHash = Get-Sha256Hex -Path $PulledZip
$SidecarText = Read-TextTrimmed -Path $PulledSha
$ExpectedZipHash = ""
if ($SidecarText) {
    $ExpectedZipHash = ($SidecarText -split '\s+')[0].ToLowerInvariant()
}

if (-not $ExpectedZipHash) {
    throw "ZIP sidecar SHA256 file is empty or malformed: $PulledSha"
}
if ($ActualZipHash -ne $ExpectedZipHash) {
    throw "ZIP hash mismatch. expected=$ExpectedZipHash actual=$ActualZipHash"
}

New-Item -ItemType Directory -Force -Path $ArchiveDir | Out-Null
New-Item -ItemType Directory -Force -Path $ExtractedDir | Out-Null

$ArchivedZip = Join-Path $ArchiveDir ([System.IO.Path]::GetFileName($PulledZip))
$ArchivedSha = Join-Path $ArchiveDir ([System.IO.Path]::GetFileName($PulledSha))

Copy-Item -LiteralPath $PulledZip -Destination $ArchivedZip -Force
Copy-Item -LiteralPath $PulledSha -Destination $ArchivedSha -Force

Get-ChildItem -LiteralPath $ExtractedDir -Force -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse
Expand-Archive -LiteralPath $ArchivedZip -DestinationPath $ExtractedDir -Force

$ExtractedHashes = Get-ChildItem -LiteralPath $ExtractedDir -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
        [pscustomobject]@{
            path = $_.FullName.Substring($ArchiveDir.Length + 1)
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }

$DirtySnapshotName = ""
if ($Manifest.PSObject.Properties.Name -contains "dirty_snapshot" -and $Manifest.dirty_snapshot) {
    if ($Manifest.dirty_snapshot.PSObject.Properties.Name -contains "expected_snapshot_name") {
        $DirtySnapshotName = [string]$Manifest.dirty_snapshot.expected_snapshot_name
    }
} elseif ($Manifest.PSObject.Properties.Name -contains "dirty_snapshot_name") {
    $DirtySnapshotName = [string]$Manifest.dirty_snapshot_name
}

$Metadata = [ordered]@{
    run_id = $RunId
    import_timestamp_utc = Get-UtcNowIso
    archive_dir = $ArchiveDir
    zip_sha256 = $ActualZipHash
    baseline_snapshot = $Manifest.baseline_snapshot
    dirty_snapshot_name = $DirtySnapshotName
    controlled_prompt = $Manifest.controlled_prompt
    project_path = $Manifest.project_path
    instrumentation = $Manifest.instrumentation
    manifest_source = $ManifestPath
}

$Metadata | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $ArchiveDir "import_metadata.json") -Encoding UTF8
$ExtractedHashes | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $ArchiveDir "extracted_hashes.json") -Encoding UTF8

Write-Host "ZIP hash verified: $ActualZipHash"
Write-Host "Archived ZIP: $ArchivedZip"
Write-Host "Extracted evidence: $ExtractedDir"
