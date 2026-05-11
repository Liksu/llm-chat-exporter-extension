<#
.SYNOPSIS
  Build a Chrome Web Store release zip for llm-chat-exporter.

.DESCRIPTION
  Reads the version from manifest.json, packages `manifest.json` + the
  `src/` folder into `releases/llm-chat-exporter-<version>.zip`, excluding
  Photoshop sources, sourcemaps, and OS / editor clutter.

  Optionally prepends a `release-log.txt` entry (under `chrome-web-store/`)
  with the version, today's date, and the supplied notes -- handy as a
  paste-ready source for the "What's new" field in the CWS dashboard.

  The script lives at the project root and runs in the project root
  regardless of where it's invoked from.

  IMPORTANT: This .ps1 file uses ASCII characters only in its source.
  Windows PowerShell 5.1 reads files without a BOM using the system code
  page (usually Windows-1252), so a literal em dash in this file is
  mis-decoded and triggers a parser error. The em dash that appears in
  generated log entries is inserted at runtime via [char]0x2014.

.PARAMETER ReleaseNotes
  Release notes for this version. If provided, prepended to
  `chrome-web-store/release-log.txt`. Multi-line OK -- use a here-string
  (`@"..."@`) when calling from a script, or just a normal quoted string
  for short notes from the prompt.

.PARAMETER Force
  Overwrite an existing zip for the same version. Without this flag the
  script refuses to clobber.

.EXAMPLE
  .\release.ps1

  Builds releases\llm-chat-exporter-<ver>.zip. No release-log change.

.EXAMPLE
  .\release.ps1 -ReleaseNotes "Add Claude create_file support; fix Gemini image fetching."

  Builds the zip AND prepends a v<ver> entry to chrome-web-store\release-log.txt.
#>
[CmdletBinding()]
param(
  [string]$ReleaseNotes,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Run from the script's own directory so relative paths work regardless
# of where the user invokes from.
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $projectRoot
try {
  # --- 1. Read version from manifest --------------------------------------
  $manifestPath = Join-Path $projectRoot 'manifest.json'
  if (-not (Test-Path $manifestPath)) {
    throw "manifest.json not found in $projectRoot"
  }
  $manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json
  $version = $manifest.version
  if (-not $version) {
    throw "manifest.json has no 'version' field"
  }
  Write-Host "Version: $version" -ForegroundColor Cyan

  # --- 2. Resolve target zip path -----------------------------------------
  $releasesDir = Join-Path $projectRoot 'releases'
  if (-not (Test-Path $releasesDir)) {
    New-Item -ItemType Directory -Path $releasesDir | Out-Null
  }
  $zipName = "llm-chat-exporter-$version.zip"
  $zipPath = Join-Path $releasesDir $zipName

  if (Test-Path $zipPath) {
    if (-not $Force) {
      throw "$zipPath already exists. Bump the version in manifest.json or pass -Force."
    }
    Remove-Item $zipPath -Force
  }

  # --- 3. Stage files, prune excluded patterns, zip -----------------------
  # We stage into a temp dir rather than use Compress-Archive's -Include
  # because Compress-Archive doesn't support exclude patterns at all.
  $stagingDir = Join-Path $env:TEMP "llm-chat-exporter-stage-$([Guid]::NewGuid())"
  New-Item -ItemType Directory -Path $stagingDir | Out-Null
  try {
    Copy-Item $manifestPath -Destination $stagingDir
    Copy-Item (Join-Path $projectRoot 'src') -Destination $stagingDir -Recurse

    # Files we never want in the published extension:
    #   *.psd   Photoshop source for the icon (src/icons/icon.psd)
    #   *.map   sourcemaps from any minifier output
    #   *.bak, *.tmp, .DS_Store, Thumbs.db -- dev / OS clutter
    $excludePatterns = @('*.psd', '*.map', '*.bak', '*.tmp', '.DS_Store', 'Thumbs.db')
    $excluded = @()
    foreach ($pattern in $excludePatterns) {
      Get-ChildItem -Path $stagingDir -Recurse -Force -Filter $pattern -ErrorAction SilentlyContinue |
        ForEach-Object {
          $rel = $_.FullName.Substring($stagingDir.Length + 1)
          $excluded += $rel
          Remove-Item $_.FullName -Force
        }
    }
    if ($excluded.Count -gt 0) {
      Write-Host "Excluded: $($excluded -join ', ')" -ForegroundColor DarkGray
    }

    # `-Path "$stagingDir\*"` puts items at the zip root with no wrapper
    # folder -- exactly what Chrome Web Store expects.
    Compress-Archive -Path (Join-Path $stagingDir '*') -DestinationPath $zipPath -Force

    $zipSize = (Get-Item $zipPath).Length
    $zipSizeKB = [Math]::Round($zipSize / 1KB, 1)
    Write-Host "Created $zipPath ($zipSizeKB KB)" -ForegroundColor Green
  }
  finally {
    Remove-Item $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  # --- 4. Update release log (optional) -----------------------------------
  if ($ReleaseNotes) {
    $cwsDir = Join-Path $projectRoot 'chrome-web-store'
    if (-not (Test-Path $cwsDir)) {
      New-Item -ItemType Directory -Path $cwsDir | Out-Null
    }
    $logPath = Join-Path $cwsDir 'release-log.txt'
    $date = Get-Date -Format 'yyyy-MM-dd'

    # Em dash inserted at runtime to keep this .ps1 source ASCII-only.
    $emDash = [char]0x2014

    $entry = @"
## v$version $emDash $date

$ReleaseNotes

"@

    if (Test-Path $logPath) {
      $existing = Get-Content -Raw -Encoding UTF8 $logPath
      # If the log starts with a "# Title" header, keep it pinned at the
      # top and prepend the new entry after it. Otherwise prepend at the
      # very start.
      if ($existing -match '(?s)^(# [^\r\n]*[\r\n]+)(.*)$') {
        $newContent = $Matches[1] + "`r`n" + $entry + $Matches[2].TrimStart()
      }
      else {
        $newContent = $entry + $existing
      }
    }
    else {
      $newContent = "# LLM Chat Exporter $emDash Release Log`r`n`r`n" + $entry
    }

    Set-Content -Path $logPath -Value $newContent -Encoding UTF8 -NoNewline
    Write-Host "Updated $logPath" -ForegroundColor Green
  }
}
finally {
  Pop-Location
}
