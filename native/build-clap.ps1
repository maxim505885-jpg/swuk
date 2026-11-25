param([switch]$Test)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$zig = Join-Path $repoRoot '.tools/native-toolchain/ziglang/zig.exe'
try { if (-not (Test-Path -LiteralPath $zig -PathType Leaf -ErrorAction Stop)) { $zig = $null } } catch { $zig = $null }
if (-not $zig) {
    $zigCommand = Get-Command zig -ErrorAction SilentlyContinue
    if (-not $zigCommand) { throw 'CLAP build needs Zig C++ from .tools/native-toolchain or PATH.' }
    $zig = $zigCommand.Source
}
$outputDirectory = Join-Path $PSScriptRoot 'build'
$fixtureSource = Join-Path $PSScriptRoot 'tests/clap_gain_plugin.cpp'
$fixture = Join-Path $outputDirectory 'sonora-clap-test-gain.clap'
$includeDirectory = Join-Path $PSScriptRoot 'vendor/clap/include'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
& $zig c++ -std=c++20 -O2 -Wall -Wextra -Wpedantic -DWIN32_LEAN_AND_MEAN -DNOMINMAX "-I$includeDirectory" -shared $fixtureSource -o $fixture
if ($LASTEXITCODE -ne 0) { throw "CLAP test plug-in build failed ($LASTEXITCODE)" }
Write-Output "Built $fixture"
if ($Test) {
    & node --test (Join-Path $repoRoot 'tests/clap-render.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw "CLAP renderer tests failed ($LASTEXITCODE)" }
}
