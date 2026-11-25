param(
    [ValidateSet('Sdk')]
    [string]$Mode = 'Sdk'
)

$ErrorActionPreference = 'Stop'
$sdkRoot = Join-Path $PSScriptRoot 'references/vst3sdk'
$buildDirectory = Join-Path $PSScriptRoot 'build/vst3-sdk'
$requiredPaths = @(
    (Join-Path $sdkRoot 'CMakeLists.txt'),
    (Join-Path $sdkRoot 'base/CMakeLists.txt'),
    (Join-Path $sdkRoot 'cmake/modules/SMTG_VST3_SDK.cmake'),
    (Join-Path $sdkRoot 'pluginterfaces/CMakeLists.txt'),
    (Join-Path $sdkRoot 'public.sdk/CMakeLists.txt')
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

& $cmake.Source -S $sdkRoot -B $buildDirectory -A x64 -DSMTG_ENABLE_VST3_PLUGIN_EXAMPLES=OFF -DSMTG_ENABLE_VST3_HOSTING_EXAMPLES=OFF -DSMTG_ENABLE_VSTGUI_SUPPORT=OFF
if ($LASTEXITCODE -ne 0) {
    throw "VST3 SDK CMake configure failed with exit code $LASTEXITCODE"
}

& $cmake.Source --build $buildDirectory --config Release --target sdk_hosting
if ($LASTEXITCODE -ne 0) {
    throw "VST3 SDK hosting target build failed with exit code $LASTEXITCODE"
}

Write-Output "Built the pinned VST3 SDK hosting target at $buildDirectory"
