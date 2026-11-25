# ADR-0001: Native audio engine for SONORA Studio

- Status: accepted; Windows implementation is a prototype and release qualification is incomplete
- Date: 2026-11-24

## Context

The application is an Electron desktop app with a JavaScript renderer. WAV assets and rendered MIDI/drum patterns can be staged as PCM WAV files into a C++/miniaudio process and mixed through WASAPI. The renderer synthesizes sequencer clips before staging them; the engine owns real-time transport, clip mixing, track/master gain and pan, mute/solo, track delay/reverb, and native device capture. The renderer still owns the user interface, browser AudioWorklet recording fallback, pitch/autotune DSP and WAV export. Native project playback, generated-tone output and the capture bridge have been exercised on this Windows 10 host; this does not qualify Windows 11, physical capture (no capture device was present), acoustic quality, or long-run stability. A project-local Zig 0.17.1 compiler targeting `x86_64-windows-gnu` and CMake 4.4.5 are available, so the native Windows build does not require changing the machine-wide toolchain.

## Decision

Keep the current SONORA interface and `.sonora` projects as the product shell, with a separate C++20 audio-engine process for Windows. The engine owns WASAPI device access, real-time callbacks, capture, project playback and mixing. Offline pitch/autotune, sequencer PCM synthesis and WAV export remain renderer-side operations; processed/rendered audio is staged to the engine for real-time playback. Electron delegates audio operations through a versioned local IPC contract. Audio buffers do not travel through JSON: assets are staged as files and control messages refer to stable asset IDs. During native playback, engine status is authoritative for transport, device and meter readings; otherwise renderer transport/audio state applies.

The target for the first native milestone is Windows 11 x64, WASAPI shared mode, stereo output, mono/stereo capture, configurable device and sample rate, and reliable playback for imported audio plus sequencer-rendered clips. Current implementation builds and has Windows 10 smoke evidence; Windows 11 installation/device qualification remains a release gate. Exclusive-mode / ASIO support is a later capability and must be reported only when implemented and tested. Deterministic WAV export is currently implemented in the renderer and is not an engine-owned capability.

Use miniaudio 0.11.26, pinned to commit `877ea4a7c2601c7b0f2a44e83dfac42e6470fea6`, for WASAPI device enumeration and I/O. Implement SONORA's transport, track graph, effects and project semantics in project-owned C++ code rather than treating the device library as a DAW engine. A separate process hosts stereo CLAP effects for offline rendering so third-party plugin code does not run in the real-time WASAPI callback.

## Licensing

Keep SONORA's current MIT license. Choose miniaudio's upstream MIT No Attribution alternative, preserving the original upstream license file. Use the MIT-licensed CLAP SDK for the first plugin-host milestone, pinned to 1.2.3 / `309d1dae3ef7f24052f81874668d1de78ed224ae`; include its notice in the installer. CLAP plugin binaries are selected and run locally; none ship with the product. Do not copy plugin presets into the product.

Do not introduce JUCE for this architecture decision: JUCE is available under AGPLv3 or a commercial JUCE license, which would add source-disclosure or recurring/perpetual license requirements that are not present in the current MIT project. Revisit only if the project owner explicitly chooses those terms.

References: [miniaudio pinned source](https://github.com/mackron/miniaudio/tree/877ea4a7c2601c7b0f2a44e83dfac42e6470fea6), [miniaudio license alternatives](https://github.com/mackron/miniaudio/blob/877ea4a7c2601c7b0f2a44e83dfac42e6470fea6/LICENSE), [CLAP SDK license](https://github.com/free-audio/clap/blob/main/LICENSE), [Steinberg VST3 licensing FAQ](https://steinbergmedia.github.io/vst3_dev_portal/pages/FAQ/Licensing.html), [JUCE licensing](https://juce.com/get-juce/).

## Migration sequence

1. Use the project-local Zig/CMake build environment where available and record its versions. Do not silently install system toolchains as part of app setup.
2. Done for the initial core: C++20 timeline conversion, clip scheduling, immutable project snapshots, bounded WAV asset loading, native clip mixing, and deterministic core tests.
3. Implemented: miniaudio WASAPI shared-mode enumeration, device selection, playback and capture IPC. Native core and smoke tests pass; this Windows 10 host has no capture input, and device-loss recovery/Windows 11 qualification remain open.
4. Implemented: the C++ mixer supports scheduled PCM clips, offsets, playback rate, clip/track pan and gain, mute/solo, master gain, delay, reverb and per-track peak reporting. The renderer converts MIDI/drum patterns to PCM for native playback. Metronome playback and unsupported/native-start failures use the Web Audio fallback. Test device playback was verified by callback peak, which does not establish physical audibility or sound quality.
5. Implemented: preload/main IPC stages PCM WAV through generated temporary files and does not accept renderer-supplied filesystem paths. The process replaces immutable project snapshots and releases unreferenced decoded assets; smoke tests cover restaging, repeated graph revisions, recording protocol and packaged-engine playback. Broader failure recovery and clean-machine qualification remain open.
6. Browser worker pitch shifting and monophonic autotune, MIDI/drum synthesis, and WAV export are renderer-side. Processed and sequenced PCM can be staged for WASAPI playback. Porting DSP to native is optional until parity, quality, and performance needs are established; real-vocal quality assessment remains open.
7. Implemented: stereo CLAP effects run offline in a separate helper with a timeout, output validation, editable host controls and deterministic test plugin. Plugin GUI/state restoration, automation, instruments and VST3 remain unsupported.
8. Remaining release gate: test the exact installer on clean Windows 11 systems across supported audio devices, recording, project round-trip, export, DPI/resolution and long-duration/load scenarios.

## Consequences

- The desktop release remains a prototype until the exact package passes Windows 11 installation/device, end-to-end workflow, DPI and stability checks; generating an installer alone does not satisfy that requirement.
- The first milestone is intentionally Windows-specific because the requested release target is Windows 11. Other audio backends can follow without changing the engine contract.
- This host enumerated two Windows WASAPI playback devices and no capture device. A generated 440 Hz project produced non-zero WASAPI callback output. That is signal-path evidence, not proof of acoustic audibility or quality; physical capture remains unverified.
- CLAP support is limited to offline stereo effects and host-edited parameter values. Plugin GUI/state recall, automation, instruments, VST3, ASIO/exclusive mode, and production vocal quality remain separate deliverables.
