# ADR-0002: Mixer buses and track output routing

- Status: Accepted
- Date: 2026-11-25
- Scope: SONORA project format, browser/WAV playback, native WASAPI playback, mixer UI

## Context

SONORA currently mixes arrangement tracks directly to the master. The user needs a practical mixer workflow for grouping tracks while keeping saved projects and rendered audio consistent across all playback backends. The native callback uses a preallocated track scratch graph; it must not allocate, resize buffers, or traverse an unbounded routing graph while rendering.

## Decision

- Store mixer buses in a top-level `buses` array, separate from arrangement `tracks`. A bus is a mixer channel and never owns arrangement clips.
- Give each audio, instrument, or drum track an optional `outputBusId`. Missing or `null` means Master, preserving existing v1 projects.
- Buses output to Master in this iteration. Track-to-bus-to-master is the complete graph; bus-to-bus routes and feedback cycles are rejected. This provides deterministic topological order and keeps the callback graph bounded.
- A bus carries the same fader, pan, mute/solo, and built-in insert settings as a mixer channel. Its inputs are summed before bus inserts and its output fader/pan are applied once.
- Keep each source track's current fader/pan, automation, and inserts in its source channel path before routing. Track meters read that channel's post-insert signal; bus meters read the summed bus channel after its inserts.
- Use one shared route model for Web Audio playback, WAV rendering, and the native WASAPI project graph. The native graph flattens buses after arrangement tracks and resolves stable bus IDs to bounded indices on the control thread. All route buffers are allocated before playback.
- Soloing a bus includes its unmuted input tracks. Soloing one input keeps its bus path audible. Muting a bus silences all of its inputs. A channel's own mute always wins.
- Provide an accessible routing matrix opened from the mixer and a per-channel output selector in the inspector. New channels default to Master. Creating a bus, changing a route, and deleting a bus are undoable. Deleting a bus routes its inputs back to Master and reports that action.
- Keep the existing compact dark rose design, semantic theme tokens, keyboard-visible focus, native select semantics, and existing mixer density. Do not add remote assets or dependencies.

## Compatibility and validation

- Project format stays at version 1 because buses and output references are additive and older projects omit both fields.
- Validate unique bus IDs, bus count within the existing 128-channel project limit, bounded audio/mixer settings, valid track-to-bus references, and no clips or nested routes on a bus.
- Reject malformed routing references before decoding project audio or staging the native graph.
- Test empty/legacy projects, bus save/open round trips, invalid/unknown destinations, routing changes and undo/redo, browser/WAV signal routing, native bus summing, mute/solo behavior, peak meters, seeks and preallocated callback state.
- Exercise the routing matrix with keyboard navigation, screen-reader names/states, long track names, empty and populated bus lists, and the supported desktop viewport sizes.

## Design contract

- Audience/job: desktop music makers grouping drum, instrument, and audio channels without changing their arrangement.
- Primary actions: create a bus, choose a track's output, inspect the complete signal route.
- Hierarchy: mixer > output route > channel/bus controls > meter; arrange tracks remain separate from mixer buses.
- Targets: 1308×911 reference desktop and 1024×768 minimum desktop.
- Accessibility: native labeled selects/buttons, predictable tab order, visible focus, and status text for route changes/errors.
- Product states: no buses (offer “Создать шину”), populated matrix, no eligible tracks, success/undo feedback, and validation error with a safe return to Master.
- Reference: current SONORA mixer screenshot and existing `theme.css`/mixer strip patterns on branch `codex/mixer-buses-routing`.

## Consequences

The project document and renderers must carry bus data explicitly. Native memory increases by bounded scratch storage proportional to channel count, so the implementation must keep the 128-channel limit and allocate the full graph off the audio callback. Sends and bus-to-bus routing remain separate follow-up work; this ADR does not claim either feature is implemented.
