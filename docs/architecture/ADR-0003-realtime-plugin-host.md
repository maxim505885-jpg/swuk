# ADR-0003: Isolated real-time plugin host

- Status: CLAP master-insert foundation implemented; per-track and VST3 work remains
- Date: 2026-11-25
- Related: [ADR-0001 native audio engine](ADR-0001-native-audio-engine.md)

## Decision

Keep the real-time WASAPI callback free of plugin calls, blocking waits, locks, heap allocation, JSON serialization, and filesystem work. Run each third-party plugin instance in a supervised child process. Exchange stereo float audio through a fixed-size shared-memory transport with single-producer/single-consumer queues. Send discovery, activation, parameter, state, and lifecycle commands through the control plane, never from the audio callback.

The engine processes 128-frame maximum blocks at 48 kHz. A bounded queue carries sequence-numbered blocks; the engine callback never waits for the host process. The first connected milestone is one stereo CLAP master insert, with a fixed 512-frame (10.67 ms) pipeline delay and dry fallback on helper failure or a missed block. The UI reports readiness and the measured-by-design pipeline delay. This milestone does not claim sample-accurate automation or plugin GUI hosting.

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

1. Define and test the allocation-free bounded audio-block transport and its sequence/underrun semantics. **Implemented; Windows CI verification pending.**
2. Refactor/reuse CLAP lifecycle in a persistent child host that opens one selected plugin and exchanges blocks through shared memory. **Implemented for one effect instance.**
3. Connect the native mixer to one bypassable stereo insert and surface health/latency to the renderer. **Implemented for the master bus with a fixed 512-frame delay.**
4. Add project persistence, safe parameter controls, missing-plugin recovery, and Electron UI smoke coverage.
5. Validate against the in-repo test CLAP and independent free CLAP effects, then run a Windows load/soak test.
6. Add VST3 as a separate adapter after confirming the pinned SDK and all included submodule licenses; preserve its MIT notice in the installer.

## Verification limits

A passing unit test of the shared-memory queue does not prove realtime playback. The release gate must include the packaged host process, active plugin processing through WASAPI, measured latency, underrun behavior under CPU pressure, and graceful plugin crash recovery.

The current bridge test exercises the native insert and helper process using the in-repo gain fixture, but it does not measure real WASAPI hardware latency or stress the pipeline under CPU pressure. The master effect is session-only; per-track slots, project persistence, plugin state, parameter automation and VST3 remain future work.

## Implementation note — 2026-11-25

The native `AudioHost` now runs the master mix through `RealtimeClapInsert`, which submits fixed-size blocks to the supervised `sonora-clap-offline.exe serve` child. The callback uses only fixed storage, lock-free queue calls, and atomics. On helper failure, the insert keeps the same delay and returns its retained dry blocks; it does not invoke plug-in code in the WASAPI thread. The Electron renderer selects a local effect through the existing native file dialog and passes only the short-lived selection token back to the main process. The current UI exposes load/replace/unload and health status for the running app session.

The active selection is not persisted in project files yet. This initial insert is master-only, supports stereo CLAP effects at 48 kHz, and has no plug-in GUI, parameter automation, per-track slots, host-side latency measurement, or automatic plugin tail negotiation. The in-repo CLAP bridge test exercises the actual child process and 512-frame bridge path; Windows CI and hardware playback remain required evidence before release.

