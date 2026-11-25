param(
    [ValidateSet('Build', 'Test', 'Bench', 'All')]
    [string]$Mode = 'All'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$outputDirectory = Join-Path $PSScriptRoot 'build'
$engineOutput = Join-Path $outputDirectory 'sonora-audio-engine.exe'
$testOutput = Join-Path $outputDirectory 'sonora-audio-engine-tests.exe'
$coreSource = Join-Path $PSScriptRoot 'src/engine_core.cpp'
$engineSource = Join-Path $PSScriptRoot 'src/main.cpp'
$testSource = Join-Path $PSScriptRoot 'tests/engine_core_tests.cpp'
$benchSource = Join-Path $PSScriptRoot 'benchmarks/core_bench.cpp'
$clapRendererSource = Join-Path $PSScriptRoot 'src/clap_offline_renderer.cpp'
$clapRendererOutput = Join-Path $outputDirectory 'sonora-clap-offline.exe'
$includeDirectory = Join-Path $PSScriptRoot 'src'
$miniaudioDirectory = Join-Path $PSScriptRoot 'vendor/miniaudio'
$clapIncludeDirectory = Join-Path $PSScriptRoot 'vendor/clap/include'
$rtMidiDirectory = Join-Path $PSScriptRoot 'vendor/rtmidi'
$rtMidiSource = Join-Path $rtMidiDirectory 'RtMidi.cpp'
if (-not (Test-Path -LiteralPath $rtMidiSource -PathType Leaf)) { throw 'RtMidi is missing. Run git submodule update --init native/vendor/rtmidi.' }
$localZig = Join-Path $repoRoot '.tools/native-toolchain/ziglang/zig.exe'
$zig = $null

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

try {
    if (Test-Path -LiteralPath $localZig -PathType Leaf -ErrorAction Stop) { $zig = $localZig }
} catch { }
if (-not $zig) {
    $zigCommand = Get-Command zig -ErrorAction SilentlyContinue
    if ($null -eq $zigCommand) { throw 'Native build needs Zig C++ (the project-local toolchain was not found). Install Zig or set up the documented build toolchain.' }
    $zig = $zigCommand.Source
}

function Invoke-ZigCompiler([string[]]$Arguments) {
    & $zig c++ @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Zig C++ exited with code $LASTEXITCODE"
    }
}

$commonArguments = @(
    '-std=c++20', '-O2', '-Wall', '-Wextra', '-Wpedantic',
    '-DWIN32_LEAN_AND_MEAN', '-DNOMINMAX', '-D__WINDOWS_MM__',
    "-I$includeDirectory"
)

if ($Mode -in @('Build', 'All')) {
    Invoke-ZigCompiler ($commonArguments + @(
        "-I$miniaudioDirectory", "-I$rtMidiDirectory", $coreSource, $engineSource, $rtMidiSource, '-o', $engineOutput,
        '-lole32', '-loleaut32', '-lwinmm', '-luuid', '-lavrt', '-lksuser', '-lpsapi'
    ))
    Write-Output "Built $engineOutput"
    Invoke-ZigCompiler ($commonArguments + @(
        "-I$miniaudioDirectory", "-I$clapIncludeDirectory", $clapRendererSource, '-o', $clapRendererOutput,
        '-lole32', '-loleaut32', '-lwinmm', '-luuid', '-lavrt', '-lksuser', '-lshell32'
    ))
    Write-Output "Built $clapRendererOutput"
}

if ($Mode -in @('Test', 'All')) {
    Invoke-ZigCompiler ($commonArguments + @($coreSource, $testSource, '-o', $testOutput))
    & $testOutput
    if ($LASTEXITCODE -ne 0) {
        throw "Native audio tests exited with code $LASTEXITCODE"
    }
}

if ($Mode -eq 'Bench') {
    $benchmarkOutput = Join-Path $outputDirectory 'sonora-audio-engine-bench.exe'
    Invoke-ZigCompiler ($commonArguments + @($coreSource, $benchSource, '-o', $benchmarkOutput))
    & $benchmarkOutput
    if ($LASTEXITCODE -ne 0) {
        throw "Native audio benchmark exited with code $LASTEXITCODE"
    }
}
