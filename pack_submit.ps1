# Yuque Firefox Extension - Source Code Submission Packager
# Packages source files required for AMO (addons.mozilla.org) review
# Outputs .zip file to parent directory

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourceDir = $PSScriptRoot
$outputPath = Join-Path (Split-Path $sourceDir -Parent) "yuque-firefox-source.zip"

Write-Host "=== Yuque Firefox Source Code Packager (AMO Submission) ==="
Write-Host ""

# Remove old output
if (Test-Path $outputPath) {
    Remove-Item $outputPath -Force
    Write-Host "[1/3] Removed old file"
}

Write-Host "[2/3] Packaging source files..."

$stream = [System.IO.File]::Open($outputPath, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)

function Add-FileToZip {
    param($zip, $filePath, $entryName)
    if (-not (Test-Path $filePath)) {
        Write-Host "  [SKIP] $entryName (not found)"
        return
    }
    $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $entryStream = $entry.Open()
    $fileStream = [System.IO.File]::OpenRead($filePath)
    $fileStream.CopyTo($entryStream)
    $fileStream.Dispose()
    $entryStream.Dispose()
    Write-Host "  [ADD] $entryName"
}

# --- Firefox adaptation source files (human-readable, unminified) ---
Add-FileToZip $zip (Join-Path $sourceDir "firefox-polyfill.js")          "firefox-polyfill.js"
Add-FileToZip $zip (Join-Path $sourceDir "firefox-sidebar-polyfill.js")  "firefox-sidebar-polyfill.js"
Add-FileToZip $zip (Join-Path $sourceDir "firefox-content-polyfill.js")  "firefox-content-polyfill.js"
Add-FileToZip $zip (Join-Path $sourceDir "manifest.json")               "manifest.json"
Add-FileToZip $zip (Join-Path $sourceDir "tabs\sandbox.html")           "tabs/sandbox.html"
Add-FileToZip $zip (Join-Path $sourceDir "options.html")                "options.html"

# --- Build documentation and tools ---
Add-FileToZip $zip (Join-Path $sourceDir "README.md")                   "README.md"
Add-FileToZip $zip (Join-Path $sourceDir "submit_firefox\README-BUILD.md")  "README-BUILD.md"
Add-FileToZip $zip (Join-Path $sourceDir "submit_firefox\split-esm.py")   "split-esm.py"

$zip.Dispose()
$stream.Dispose()

$verify = [System.IO.Compression.ZipFile]::OpenRead($outputPath)
$fileCount = $verify.Entries.Count
$verify.Dispose()
$zipSize = [math]::Round((Get-Item $outputPath).Length / 1KB, 2)

Write-Host ""
Write-Host "[3/3] Done"
Write-Host ""
Write-Host "Files: $fileCount"
Write-Host "Size:  $zipSize KB"
Write-Host "Output: $outputPath"
Write-Host ""
Write-Host "Submit this file as source code when uploading to addons.mozilla.org"
