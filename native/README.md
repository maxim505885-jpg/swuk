# SONORA native audio engine

This is the first native engine milestone for Windows 11 x64. The standalone process uses WASAPI shared mode, reports playback/capture devices, provides a 0.5 second diagnostic sine tone, decodes staged assets, builds immutable project-mixer snapshots and can play those snapshots through a callback. It communicates over newline-delimited JSON on stdin/stdout. The callback reads an atomically published immutable graph and lock-free transport state; it does not allocate, log, or take a mutex.

Protocol version 1 currently supports:

- `{"version":1,"op":"ping"}`
- `{"version":1,"op":"devices"}`
- `{"version":1,"op":"status"}`
- `{"version":1,"op":"diagnostics"}` returns current/peak working set and current private bytes for the native process. It is a control-plane query and is not called from the real-time callback.
- `{"version":1,"op":"start_capture","deviceIndex":0,"sampleRate":48000,"channelMode":"stereo","path":"C:\\...\\capture.wav"}`, `stop_capture`
- `{"version":1,"op":"clear_project"}`
- `{"version":1,"op":"load_asset","assetId":"asset-1","path":"C:\\...\\asset.wav"}`
- `{"version":1,"op":"set_project","masterGain":0.82}`
- `{"version":1,"op":"set_track","index":0,"gain":0.8,"pan":0,"mute":false,"solo":false,"reverb":false,"delay":false,"gainAutomation":[0,0.8,48000,0.2]}` (optional flat `[frame,value,...]` pairs; frame positions are 48 kHz project sample frames, gains are 0..4, max 8192 events per track and project)
- `{"version":1,"op":"add_clip","assetId":"asset-1","trackIndex":0,"startFrame":0,"sourceOffsetFrame":0,"durationFrames":48000,"playbackRate":1,"gain":1,"pan":0,"fadeInFrames":12000,"fadeOutFrames":12000}` (fade fields are optional 48 kHz project-frame durations; their sum cannot exceed `durationFrames`)
- `{"version":1,"op":"commit_project"}`
- `{"version":1,"op":"play_project","deviceIndex":0}`, `pause_project`, `stop_project`
- `{"version":1,"op":"start_test_tone","frequencyHz":440,"gain":0.1,"deviceIndex":0}`
- `{"version":1,"op":"stop"}`
- `{"version":1,"op":"shutdown"}`

Each request produces one JSON response line. Assets are decoded to 48 kHz stereo PCM on the control thread; the callback uses one immutable project snapshot at a time. A commit stops the WASAPI callback before replacing and releasing the previous snapshot, and decoded assets not referenced by the new graph are evicted. This keeps edits from accumulating snapshots or audio from projects that are no longer open. Effect delay lines and per-track scratch buffers are allocated before graph publication, so the playback callback does not allocate. Per-asset decoded PCM is limited to 256 MiB, the temporary service-wide decoded cache to 1 GiB, projects to 128 tracks and 8192 clips. Native capture supports mono, left, right or stereo at 44.1/48/96 kHz. Its WASAPI callback writes into a preallocated single-producer/single-consumer ring; a background thread converts samples to PCM16 WAV so file I/O never runs in the callback. The recorder reports dropped frames under backpressure and caps files at 256 MiB. The deterministic native core tests cover scheduling, capture channel mapping, ring backpressure, WAV header finalization, offsets, rate, gain, pan, mute, solo, master level, delay timing and reverb reflections. The process smoke test loads generated WAVs, checks asset eviction/restaging, commits 300 graph revisions, and confirms the real WASAPI callback advances playhead during digital silence; it does not output audible test content. The diagnostic tone has a deliberately limited gain range and remains separate from project playback. Electron's sandboxed preload/main stage project audio through temporary files and expose bounded capture control; completed WAVs are passed over Electron IPC as binary data and inserted into Arrangement. Audio, MIDI, and drum arrangement projects can use native WASAPI; sequencer notes and drum patterns are pre-rendered to PCM before graph commit. The metronome continues through Web Audio. The native reverb is a lightweight four-line feedback room approximation; it is not sonically identical to the Web Audio convolution reverb. This host exposes no WASAPI capture device, so physical capture remains unverified.

Track gain automation is an optional `gainAutomation` flat array on `set_track`, containing ordered 48 kHz project frame/value pairs. Curves are limited to 8192 events per track and project, require finite values from 0 to 4, and are interpolated into preallocated per-track buffers before the mix loop. This avoids per-sample search and memory allocation inside the WASAPI callback. The native protocol smoke accepts a valid curve and rejects descending frame positions; core tests cover interpolation across callback blocks and seeks.

Audio clip fade-in and fade-out are optional `fadeInFrames`/`fadeOutFrames` values on `add_clip`. Both are non-destructive linear gain ramps applied per sample in the project mix. The core test checks their shape; the native protocol smoke covers accepted durations and rejects a combined fade longer than the clip. These new C++ tests still require a successful native rebuild before they can be counted as passed.

Track EQ is configured on `set_track` with optional `equalizer` (boolean), `equalizerFrequencyHz` (20–20,000 Hz), `equalizerGainDb` (-24–24 dB), and `equalizerQ` (0.1–18). When enabled, the native mix applies one stereo peaking biquad after reverb and delay. Coefficients are prepared before publishing the audio graph; the callback keeps per-channel filter state and does not allocate. Core tests include a 1 kHz, +6 dB tone response and invalid-Q rejection; these tests require a successful native rebuild before they can be counted as passed.

`npm run native:bench` builds a synthetic real-time core benchmark: 48 kHz stereo, 512-frame blocks, four distinct PCM sources, and 1/8/32/64/128 overlapping clips. On the development host (AMD Ryzen 9 3900X, 32 GiB RAM, Windows 10), 3000-block p95 render times measured 3.4/26.5/107.9/214.4/427 μs; an extra 8-track case with reverb and delay enabled measured 104 μs p95. This measures only `renderMixBlock`; it is not a whole-app or Windows 11 performance qualification.

## Build and tests

With the project-local Zig C++ toolchain:

```powershell
npm run native:build
npm run native:test
npm run native:clap:test
```

To build both the engine and its deterministic core tests in one invocation, run `powershell -ExecutionPolicy Bypass -File native/build.ps1 -Mode All`. The script selects the project-local Zig compiler when present, then a `zig` on `PATH`. CMake configuration is also provided for Visual Studio or another Windows C++ toolchain:

```powershell
cmake -S native -B native/build
cmake --build native/build --config Release
ctest --test-dir native/build -C Release --output-on-failure
```

The current local build uses Zig 0.17.1 targeting `x86_64-windows-gnu` and CMake 4.4.5. The diagnostic device path must still be exercised on a physical Windows 11 audio device before this milestone is considered hardware-verified.

## Third-party code

`vendor/miniaudio/miniaudio.h` and its original `LICENSE` are pinned to miniaudio 0.11.26, commit `877ea4a7c2601c7b0f2a44e83dfac42e6470fea6`. SONORA selects miniaudio's MIT No Attribution alternative. The upstream source and both license alternatives are preserved alongside the dependency. Upstream offers either Unlicense/Public Domain or MIT No Attribution; the project pins the latter choice.

`vendor/clap/include` contains the official CLAP 1.2.3 headers at commit `309d1dae3ef7f24052f81874668d1de78ed224ae`. The `sonora-clap-offline.exe` helper loads one locally selected `.clap` binary, reports up to 128 writable parameters and renders a stereo WAV in blocks outside the WASAPI process. Host parameter changes are sent as CLAP events at frame zero of the first block; plugin GUI/state serialization and automation are not implemented. It accepts plugins with exactly one stereo main input and output and does not pass note or other events. A reported finite tail is capped at 30 seconds; infinite tails are limited to 3 seconds. Input and output files are limited to 256 MiB, and the Electron caller stops work after 120 seconds. A subprocess crash or timeout returns an error to the UI without taking down Electron or the WASAPI engine. The CLAP SDK's MIT license is copied into the installer; third-party plugin files are not included.


The helper also serves one real-time stereo master insert over the versioned shared-memory transport. `RealtimeClapInsert` adds a fixed 512-frame delay (10.67 ms at 48 kHz) so the WASAPI callback can poll processed blocks without waiting; it retains dry blocks for fallback when processing is late or the child exits. Activation, child monitoring and shutdown run outside the callback. The desktop mixer selects a local `.clap` file, reports helper health, and can replace or remove the effect while playback is stopped. This first insert is master-only and session-only. Saved plug-in state, per-track slots, plug-in windows, parameter automation and VST3 are not implemented. `npm run native:clap:test` now includes a bridge test that verifies the helper gain result through the fixed-latency insert.
