param(
    [ValidateSet('Sdk')]
    [string]$Mode = 'Sdk'
)

$ErrorActionPreference = 'Stop'
$sdkRoot = Join-Path $PSScriptRoot 'references/vst3sdk'
$buildDirectory = Join-Path $PSScriptRoot 'build/vst3-sdk'
$requiredPaths = @(
    (Join-Path $sdkRoot 'CMakeLists.txt'),
    (Join-Path $sdkRoot 'base/source/fstring.cpp'),
    (Join-Path $sdkRoot 'cmake/modules/SMTG_VST3_SDK.cmake'),
    (Join-Path $sdkRoot 'pluginterfaces/base/ipluginbase.h'),
    (Join-Path $sdkRoot 'public.sdk/source/vst/hosting/module.h')
)

foreach ($path in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "VST3 SDK dependency is missing: $path. Initialize native/references/vst3sdk and its base, cmake, pluginterfaces, and public.sdk submodules."
    }
}

$cmake = Get-Command cmake -ErrorAction SilentlyContinue
if ($null -eq $cmake) {
    throw 'VST3 hosting SDK build requires CMake 3.25 or newer.'
}
$versionText = (& $cmake.Source --version | Select-Object -First 1)
if ($versionText -notmatch '(\d+)\.(\d+)\.') {
    throw "Could not determine CMake version from: $versionText"
}
$major = [int]$Matches[1]
$minor = [int]$Matches[2]
if (($major -lt 3) -or (($major -eq 3) -and ($minor -lt 25))) {
    throw "VST3 hosting SDK requires CMake 3.25 or newer; found $versionText."
}

& $cmake.Source -S (Join-Path $PSScriptRoot 'vst3-host') -B $buildDirectory -A x64 "-DSONORA_VST3_SDK_ROOT=$sdkRoot"
if ($LASTEXITCODE -ne 0) {
    throw "VST3 helper CMake configure failed with exit code $LASTEXITCODE"
}

& $cmake.Source --build $buildDirectory --config Release --target sonora-vst3-host sonora-vst3-bridge-tests mda-vst3
if ($LASTEXITCODE -ne 0) {
    throw "VST3 helper build failed with exit code $LASTEXITCODE"
}

$mdaBundle = Get-ChildItem -LiteralPath $buildDirectory -Directory -Filter 'mda-vst3.vst3' -Recurse | Select-Object -First 1
if ($null -eq $mdaBundle) {
    throw 'The pinned Steinberg MDA VST3 fixture was not produced by the SDK build.'
}
$bridgeTest = Join-Path $buildDirectory 'Release/sonora-vst3-bridge-tests.exe'
if (-not (Test-Path -LiteralPath $bridgeTest -PathType Leaf)) {
    throw "The VST3 bridge test executable was not produced: $bridgeTest"
}
& $bridgeTest $mdaBundle.FullName
if ($LASTEXITCODE -ne 0) {
    throw "The isolated VST3 bridge test failed with exit code $LASTEXITCODE"
}

Write-Output "Built the isolated VST3 host and processed the SDK effect fixture at $buildDirectory"
