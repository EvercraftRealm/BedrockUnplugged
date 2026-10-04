[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist')
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$behaviorPack = Join-Path $repoRoot 'BedrockUnplugged'
$manifestPath = Join-Path $behaviorPack 'manifest.json'

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Required file not found: $manifestPath"
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$version = $manifest.header.version -join '.'
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Manifest version is invalid: $version"
}

$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("bedrockunplugged-release-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

try {
    $behaviorZip = Join-Path $temporaryRoot 'BedrockUnplugged-BP.zip'
    $behaviorMcpack = Join-Path $temporaryRoot 'BedrockUnplugged-BP.mcpack'
    $addonZip = Join-Path $temporaryRoot "BedrockUnplugged-$version.zip"
    $addonPath = Join-Path $outputRoot "BedrockUnplugged-$version.mcaddon"

    Compress-Archive -Path (Join-Path $behaviorPack '*') -DestinationPath $behaviorZip -CompressionLevel Optimal
    Move-Item -LiteralPath $behaviorZip -Destination $behaviorMcpack
    Compress-Archive -LiteralPath $behaviorMcpack -DestinationPath $addonZip -CompressionLevel Optimal

    if (Test-Path -LiteralPath $addonPath) {
        Remove-Item -LiteralPath $addonPath -Force
    }
    Move-Item -LiteralPath $addonZip -Destination $addonPath

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $addonPath).Hash.ToLowerInvariant()
    Write-Output "Built $addonPath"
    Write-Output "SHA256 $hash"
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
