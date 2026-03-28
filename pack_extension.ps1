# Yuque Firefox Extension Packager
# Outputs .xpi file to parent directory
# Excludes development files, build artifacts, and packaging scripts

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourceDir = $PSScriptRoot
$outputPath = Join-Path (Split-Path $sourceDir -Parent) "yuque-firefox-extension.xpi"

# Files and directories to exclude from the extension package
$excludeList = @(
    '.claude'
    '.git'
    '__MACOSX'
    '_metadata'
    'README.md'
    'pack_extension.ps1'
    'pack_submit.ps1'
    'pack.ps1'
    'offscreen.c4adff84.html'
    'offscreen.eefccdc5.js'
    'submit_firefox'
)

Write-Host "=== Yuque Firefox Extension Packager ==="
Write-Host ""

# Remove old output
if (Test-Path $outputPath) {
    Remove-Item $outputPath -Force
    Write-Host "[1/3] Removed old file"
}

Write-Host "[2/3] Packaging..."

# Create the XPI (ZIP format)
$stream = [System.IO.File]::Open($outputPath, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)

function Add-DirToZip {
    param($zip, $dirPath, $entryPrefix)
    foreach ($item in Get-ChildItem -Path $dirPath) {
        if ($excludeList -contains $item.Name) { continue }
        if ($item.PSIsContainer) {
            Add-DirToZip $zip $item.FullName ($entryPrefix + $item.Name + "/")
        } else {
            $entryName = $entryPrefix + $item.Name
            $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            $fileStream = [System.IO.File]::OpenRead($item.FullName)
            $fileStream.CopyTo($entryStream)
            $fileStream.Dispose()
            $entryStream.Dispose()
        }
    }
}

Add-DirToZip $zip $sourceDir ""
$zip.Dispose()
$stream.Dispose()

# Verify
$verify = [System.IO.Compression.ZipFile]::OpenRead($outputPath)
$fileCount = $verify.Entries.Count
$verify.Dispose()
$xpiSize = [math]::Round((Get-Item $outputPath).Length / 1MB, 2)

Write-Host "[3/3] Done"
Write-Host ""
Write-Host "Files: $fileCount"
Write-Host "Size:  $xpiSize MB"
Write-Host "Output: $outputPath"
Write-Host ""
Write-Host "Install: Firefox -> about:debugging -> Load Temporary Add-on -> select the .xpi"
