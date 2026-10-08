param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)][string]$LicenseDirectory)
$ErrorActionPreference='Stop'
$destination=Join-Path $PSScriptRoot '../src-tauri/resources'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
foreach($name in @('ffmpeg.exe','ffprobe.exe')) {
  $source=Join-Path $Directory $name
  if(-not(Test-Path -LiteralPath $source -PathType Leaf)){throw "Missing $name"}
  Copy-Item -LiteralPath $source -Destination (Join-Path $destination $name) -Force
}
Get-ChildItem -LiteralPath $Directory -Filter '*.dll' -File | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $destination -Force}
Get-ChildItem -LiteralPath $LicenseDirectory -File | Where-Object {$_.Name -match 'LICENSE|COPYING|NOTICE'} | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $destination -Force}
Write-Output 'Staged media tools. Preserve the exact build configuration, licenses and matching source for distribution.'
