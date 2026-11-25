# ADR-0003: Isolated real-time plugin host

- Status: proposed for implementation; CLAP first
- Date: 2026-11-25
- Related: [ADR-0001 native audio engine](ADR-0001-native-audio-engine.md)

## Decision

Keep the real-time WASAPI callback free of plugin calls, blocking waits, locks, heap allocation, JSON serialization, and filesystem work. Run each third-party plugin instance in a supervised child process. Exchange stereo float audio through a fixed-size shared-memory transport with single-producer/single-consumer queues. Send discovery, activation, parameter, state, and lifecycle commands through the control plane, never from the audio callback.

The engine will process 128-frame blocks at 48 kHz. A bounded queue carries sequence-numbered blocks; the engine callback never waits for the host process. The first implementation will expose a single stereo CLAP insert per track, generic parameter controls in SONORA, and explicit bypass on process failure or an audio underrun. The prototype must measure and report the resulting plugin latency and underrun count. It will not claim sample-accurate automation or plugin GUI hosting.

CLAP is first because its MIT SDK is already pinned in the repository and the existing offline renderer has a working plugin lifecycle, stereo port validation, parameter discovery, and a test plugin. VST3 follows after this process boundary, parameter contract, and recovery path are exercised with CLAP. Both APIs use the same audio block protocol and UI slot model, while SDK-specific lifecycle adapters remain separate.

## Safety and compatibility rules

- Load only a user-selected plugin path; do not recursively scan arbitrary locations during startup.
- Never bundle third-party plugin binaries or presets.
- A child crash or timeout must not terminate the Electron UI or enter the WASAPI callback. Mark that slot failed, bypass it, release the child, and show a recoverable error.
- Bound shared queues and control messages. Drop/skip an overdue plugin block rather than blocking the callback.
- Validate plugin audio ports, channel layout, sample rate, maximum block size, parameter IDs, ranges, and serialized state before applying them.
- Persist plugin format, local path, stable plugin ID, enabled/bypass state, and bounded parameter values in the project. Missing plugins reopen as bypassed slots with a clear status.
- The initial milestone is Windows 11 x64, WASAPI shared mode, stereo effect plugins. Instruments, MIDI events to plugins, plugin editor windows, state snapshots, latency compensation, multi-bus plugins, VST3, and cross-platform support remain later milestones.
- Keep offline CLAP rendering independent so existing export behavior remains deterministic.

## Staged implementation

1. Define and test the allocation-free bounded audio-block transport and its sequence/underrun semantics.
2. Refactor/reuse CLAP lifecycle in a persistent child host that opens one selected plugin and exchanges blocks through shared memory.
3. Connect the native mixer to one bypassable stereo insert and surface health/latency to the renderer.
4. Add project persistence, safe parameter controls, missing-plugin recovery, and Electron UI smoke coverage.
5. Validate against the in-repo test CLAP and independent free CLAP effects, then run a Windows load/soak test.
6. Add VST3 as a separate adapter after confirming the pinned SDK and all included submodule licenses; preserve its MIT notice in the installer.

## Verification limits

A passing unit test of the shared-memory queue does not prove realtime playback. The release gate must include the packaged host process, active plugin processing through WASAPI, measured latency, underrun behavior under CPU pressure, and graceful plugin crash recovery.
