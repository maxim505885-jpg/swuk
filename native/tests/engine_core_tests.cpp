#include "engine_core.hpp"
#include "capture_ring.hpp"
#include "capture_wav_recorder.hpp"
#include "spectrum_analyzer.hpp"
#include "midi_event_queue.hpp"
#include "realtime_plugin_transport.hpp"

#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <thread>
#include <vector>

namespace {

void require(const bool condition, const char* message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        std::exit(EXIT_FAILURE);
    }
}

void testToneFrequencyAndStereoAlignment() {
    constexpr std::size_t kFrameCount = 48'000;
    constexpr std::uint32_t kChannels = 2;
    std::vector<float> output(kFrameCount * kChannels, 0.0F);
    double phase = 0.0;
    require(sonora::audio::renderSine(output.data(), kFrameCount, kChannels, 48'000.0, 440.0, 0.25, phase), "valid sine settings render");
    require(std::abs(output[0]) < 1.0e-6F, "sine begins at zero phase");
    require(std::abs(output[200] - output[201]) < 1.0e-7F, "left and right channels remain identical");

    std::size_t positiveCrossings = 0;
    for (std::size_t frame = 2'000; frame < kFrameCount - 2'000; ++frame) {
        const float previous = output[(frame - 1) * kChannels];
        const float current = output[frame * kChannels];
        if (previous <= 0.0F && current > 0.0F) ++positiveCrossings;
    }
    const double observedHz = static_cast<double>(positiveCrossings) * 48'000.0 / static_cast<double>(kFrameCount - 4'000);
    require(std::abs(observedHz - 440.0) < 2.0, "sine has the requested frequency");
    require(phase >= 0.0 && phase < 1.0, "phase remains wrapped to one cycle");
}

void testInvalidToneIsRejectedWithoutWriting() {
    float output[2]{7.0F, 9.0F};
    double phase = 0.25;
    require(!sonora::audio::renderSine(output, 1, 2, 48'000.0, 24'000.0, 0.1, phase), "Nyquist frequency is rejected");
    require(output[0] == 7.0F && output[1] == 9.0F, "invalid request leaves output untouched");
    require(std::abs(phase - 0.25) < 1.0e-12, "invalid request leaves phase untouched");
}

void testConstantPowerPan() {
    const float input[]{1.0F, 0.5F, -1.0F};
    float output[]{0.0F, 0.0F, 0.0F, 0.0F, 0.0F, 0.0F};
    require(sonora::audio::mixMonoToStereo(input, output, 3, 1.0F, -1.0F), "left pan accepted");
    require(output[0] == 1.0F && output[1] == 0.0F, "hard left has no right-channel signal");
    require(output[2] == 0.5F && output[3] == 0.0F, "left pan preserves source amplitude");

    float center[]{0.0F, 0.0F};
    require(sonora::audio::mixMonoToStereo(input, center, 1, 1.0F, 0.0F), "center pan accepted");
    require(std::abs(center[0] - 0.7071067F) < 1.0e-5F && std::abs(center[1] - center[0]) < 1.0e-6F,
        "center pan uses equal-power gain");
}

void testBeatConversionValidation() {
    const auto seconds = sonora::audio::beatsToSeconds(8.0, 120.0);
    require(seconds.has_value() && std::abs(*seconds - 4.0) < 1.0e-12, "8 beats at 120 BPM is 4 seconds");
    require(!sonora::audio::beatsToSeconds(1.0, 0.0).has_value(), "zero BPM is rejected");
    require(!sonora::audio::beatsToSeconds(-1.0, 120.0).has_value(), "negative beats are rejected");
}

void testProjectClipOffsetGainAndMonoPan() {
    const float samples[]{1.0F, 0.5F, -0.5F, 0.0F};
    const sonora::audio::PcmSourceView source{samples, 4, 1, 4.0};
    const sonora::audio::TrackMixSettings tracks[]{{1.0F, 0.0F, false, false}};
    const sonora::audio::AudioClipView clips[]{{&source, 0, 1, 1, 2, 1.0, 0.5F, 0.0F}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    float output[8]{};

    require(sonora::audio::renderMixBlock(output, 4, 4.0, 0, project), "valid project clip renders");
    require(output[0] == 0.0F && output[1] == 0.0F, "clip start position is respected");
    require(std::abs(output[2] - 0.1767767F) < 1.0e-5F && std::abs(output[3] - output[2]) < 1.0e-6F,
        "mono source is centered and clip gain is applied");
    require(std::abs(output[4] + output[2]) < 1.0e-6F && std::abs(output[5] - output[4]) < 1.0e-6F,
        "source offset is applied");
    require(output[6] == 0.0F && output[7] == 0.0F, "clip duration is respected");
}

void testProjectClipFades() {
    const float samples[]{1.0F, 1.0F, 1.0F, 1.0F};
    const sonora::audio::PcmSourceView source{samples, 4, 1, 4.0};
    const sonora::audio::TrackMixSettings tracks[]{{1.0F, 0.0F, false, false}};
    const sonora::audio::AudioClipView clips[]{{&source, 0, 0, 0, 4, 1.0, 1.0F, 0.0F, 2, 2}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    float output[8]{};
    require(sonora::audio::renderMixBlock(output, 4, 4.0, 0, project), "clip with fades renders");
    const float center = 0.7071067F;
    require(std::abs(output[0]) < 1.0e-6F && std::abs(output[1]) < 1.0e-6F, "clip fade-in begins at silence");
    require(std::abs(output[2] - center * 0.5F) < 1.0e-5F, "clip fade-in ramps linearly");
    require(std::abs(output[4] - center) < 1.0e-5F, "clip reaches full level between fades");
    require(std::abs(output[6] - center * 0.5F) < 1.0e-5F, "clip fade-out ramps linearly");
}

void testProjectClipGainEnvelopeRendersAndValidates() {
    const float samples[]{1.0F, 1.0F, 1.0F, 1.0F};
    const sonora::audio::PcmSourceView source{samples, 4, 1, 4.0};
    const sonora::audio::TrackMixSettings tracks[]{{1.0F, 0.0F, false, false}};
    sonora::audio::AudioClipView clips[]{{&source, 0, 0, 0, 4, 1.0, 1.0F, 0.0F}};
    clips[0].gainEnvelope = {{0, 1.0F}, {2, 0.0F}, {4, 1.0F}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    float output[8]{};
    require(sonora::audio::renderMixBlock(output, 4, 4.0, 0, project), "clip gain envelope renders");
    const float center = 0.7071067F;
    require(std::abs(output[0] - center) < 1.0e-5F, "clip envelope starts at its first gain");
    require(std::abs(output[2] - center * 0.5F) < 1.0e-5F, "clip envelope interpolates linearly");
    require(std::abs(output[4]) < 1.0e-6F, "clip envelope reaches a zero-gain point");
    require(std::abs(output[6] - center * 0.5F) < 1.0e-5F, "clip envelope continues through a block");

    clips[0].gainEnvelope = {{1, 1.0F}, {4, 1.0F}};
    std::fill(std::begin(output), std::end(output), 7.0F);
    require(!sonora::audio::renderMixBlock(output, 4, 4.0, 0, project), "envelope missing its zero-frame endpoint is rejected");
    require(output[0] == 7.0F && output[7] == 7.0F, "invalid clip envelope leaves output untouched");
}

void testProjectSampleRateAndPlaybackRate() {
    const float samples[]{0.0F, 0.25F, 0.5F, 0.75F, 1.0F};
    const sonora::audio::PcmSourceView source{samples, 5, 1, 4.0};
    const sonora::audio::TrackMixSettings tracks[]{{1.0F, -1.0F, false, false}};
    const sonora::audio::AudioClipView clips[]{{&source, 0, 0, 1, 2, 2.0, 1.0F, 0.0F}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    float output[4]{};

    require(sonora::audio::renderMixBlock(output, 2, 4.0, 0, project), "rate-adjusted project clip renders");
    require(std::abs(output[0] - 0.25F) < 1.0e-6F && output[1] == 0.0F,
        "source offset and hard-left track pan are applied");
    require(std::abs(output[2] - 0.75F) < 1.0e-6F && output[3] == 0.0F,
        "playback rate advances the source cursor");
}

void testProjectSoloAndMute() {
    const float sample[]{1.0F};
    const sonora::audio::PcmSourceView source{sample, 1, 1, 48'000.0};
    sonora::audio::TrackMixSettings tracks[]{{0.5F, -1.0F, false, false}, {1.0F, 1.0F, false, true}};
    const sonora::audio::AudioClipView clips[]{
        {&source, 0, 0, 0, 1, 1.0, 1.0F, 0.0F},
        {&source, 1, 0, 0, 1, 1.0, 1.0F, 0.0F},
    };
    const sonora::audio::ProjectMixView project{tracks, 2, clips, 2, 0.8F};
    float output[2]{};

    require(sonora::audio::renderMixBlock(output, 1, 48'000.0, 0, project), "soloed project renders");
    require(std::abs(output[0]) < 1.0e-6F && std::abs(output[1] - 0.8F) < 1.0e-6F, "solo excludes other tracks and master gain applies");
    tracks[1].mute = true;
    require(sonora::audio::renderMixBlock(output, 1, 48'000.0, 0, project), "muted solo project renders");
    require(std::abs(output[0]) < 1.0e-6F && std::abs(output[1]) < 1.0e-6F, "muted solo track produces silence");
}

void testTrackGainAutomationInterpolatesAcrossBlocksAndSeeks() {
    const float samples[6]{1.0F, 1.0F, 1.0F, 1.0F, 1.0F, 1.0F};
    const sonora::audio::PcmSourceView source{samples, 6, 1, 48'000.0};
    sonora::audio::TrackMixSettings tracks[]{{0.5F, 0.0F, false, false}};
    tracks[0].gainAutomation = {{2, 0.0F}, {4, 1.0F}};
    const sonora::audio::AudioClipView clips[]{{&source, 0, 0, 0, 6, 1.0, 1.0F, 0.0F}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    sonora::audio::ProjectMixState state;
    require(sonora::audio::configureProjectMixState(state, project), "gain automation scratch is prepared off the callback");
    float output[12]{};

    require(sonora::audio::renderMixBlock(output, 3, 48'000.0, 0, project, &state), "first automation block renders");
    require(std::abs(output[0] - 0.3535534F) < 1.0e-5F && std::abs(output[2] - output[0]) < 1.0e-6F,
        "track's static gain applies before the first automation point");
    require(output[4] == 0.0F && output[5] == 0.0F, "automation reaches zero at its point frame");
    require(sonora::audio::renderMixBlock(output, 3, 48'000.0, 3, project, &state), "seeking into an automation segment renders");
    require(std::abs(output[0] - 0.3535534F) < 1.0e-5F && std::abs(output[2] - 0.7071068F) < 1.0e-5F &&
        std::abs(output[4] - output[2]) < 1.0e-6F,
        "linear automation remains continuous across blocks and holds its last value");
}

void testTrackPanAutomationInterpolatesAcrossBlocksAndSeeks() {
    const float samples[]{1.0F, 1.0F, 1.0F, 1.0F, 1.0F, 1.0F};
    const sonora::audio::PcmSourceView source{samples, 6, 1, 48'000.0};
    sonora::audio::TrackMixSettings tracks[]{{1.0F, 0.0F, false, false}};
    tracks[0].panAutomation = {{2, -1.0F}, {4, 1.0F}};
    const sonora::audio::AudioClipView clips[]{{&source, 0, 0, 0, 6, 1.0, 1.0F, 0.0F}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    sonora::audio::ProjectMixState state;
    require(sonora::audio::configureProjectMixState(state, project), "pan automation scratch is prepared off the callback");
    float output[12]{};
    require(sonora::audio::renderMixBlock(output, 3, 48'000.0, 0, project, &state), "first pan automation block renders");
    require(std::abs(output[0] - 0.7071068F) < 1.0e-5F && std::abs(output[1] - output[0]) < 1.0e-5F,
        "static center pan applies before the first automation point");
    require(std::abs(output[4] - 1.0F) < 1.0e-5F && std::abs(output[5]) < 1.0e-5F,
        "pan automation reaches full left at its first point");
    require(sonora::audio::renderMixBlock(output, 3, 48'000.0, 3, project, &state), "seeking into a pan automation segment renders");
    require(std::abs(output[0] - 0.7071068F) < 1.0e-5F && std::abs(output[1] - output[0]) < 1.0e-5F,
        "pan automation interpolates continuously across blocks");
    require(std::abs(output[4]) < 1.0e-5F && std::abs(output[5] - 1.0F) < 1.0e-5F,
        "pan automation reaches and holds full right");
}

void testInvalidPanAutomationIsRejectedBeforeWriting() {
    const float sample[]{1.0F};
    const sonora::audio::PcmSourceView source{sample, 1, 1, 48'000.0};
    sonora::audio::TrackMixSettings tracks[]{{}};
    tracks[0].panAutomation = {{2, 0.8F}, {1, -0.2F}};
    const sonora::audio::AudioClipView clips[]{{&source, 0, 0, 0, 1, 1.0, 1.0F, 0.0F}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    sonora::audio::ProjectMixState state;
    require(sonora::audio::configureProjectMixState(state, project), "pan automation state prepares before validation");
    float output[]{0.25F, -0.5F};
    require(!sonora::audio::renderMixBlock(output, 1, 48'000.0, 0, project, &state), "out-of-order pan automation is rejected");
    require(output[0] == 0.25F && output[1] == -0.5F, "invalid pan automation leaves output untouched");
    tracks[0].panAutomation = {{0, 1.1F}};
    require(!sonora::audio::renderMixBlock(output, 1, 48'000.0, 0, project, &state), "pan automation outside [-1, 1] is rejected");
}

void testInvalidTrackGainAutomationIsRejectedBeforeWriting() {
    const float sample[]{1.0F};
    const sonora::audio::PcmSourceView source{sample, 1, 1, 48'000.0};
    sonora::audio::TrackMixSettings tracks[]{{}};
    tracks[0].gainAutomation = {{2, 0.8F}, {1, 0.2F}};
    const sonora::audio::AudioClipView clips[]{{&source, 0, 0, 0, 1, 1.0, 1.0F, 0.0F}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    sonora::audio::ProjectMixState state;
    require(sonora::audio::configureProjectMixState(state, project), "automation state can be prepared before validating malformed events");
    float output[]{0.25F, -0.5F};

    require(!sonora::audio::renderMixBlock(output, 1, 48'000.0, 0, project, &state), "out-of-order automation points are rejected");
    require(output[0] == 0.25F && output[1] == -0.5F, "invalid automation leaves output untouched");
    tracks[0].gainAutomation = {{0, 4.1F}};
    require(!sonora::audio::renderMixBlock(output, 1, 48'000.0, 0, project, &state), "gain automation above the engine limit is rejected");
}

void testTrackPeakMetersReportPostEffectPreMasterLevels() {
    const float sample[]{1.0F};
    const sonora::audio::PcmSourceView source{sample, 1, 1, 48'000.0};
    sonora::audio::TrackMixSettings tracks[]{{0.5F, 0.0F, false, false}, {0.75F, 0.0F, false, false}};
    const sonora::audio::AudioClipView clips[]{
        {&source, 0, 0, 0, 1, 1.0, 1.0F, 0.0F},
        {&source, 1, 0, 0, 1, 1.0, 1.0F, 0.0F},
    };
    const sonora::audio::ProjectMixView project{tracks, 2, clips, 2, 0.5F};
    sonora::audio::ProjectMixState state;
    require(sonora::audio::configureProjectMixState(state, project), "meter scratch is prepared outside the callback");
    std::array<float, 2> trackPeaks{};
    float output[2]{};

    require(sonora::audio::renderMixBlock(output, 1, 48'000.0, 0, project, &state, trackPeaks.data(), trackPeaks.size()),
        "per-track peaks are collected during a normal mix");
    require(std::abs(trackPeaks[0] - 0.3535534F) < 1.0e-5F &&
        std::abs(trackPeaks[1] - 0.5303301F) < 1.0e-5F,
        "track peaks reflect channel pan and track gain before master gain");
    require(std::abs(output[0] - 0.4419417F) < 1.0e-5F && std::abs(output[1] - output[0]) < 1.0e-6F,
        "meter collection preserves the mixed master output");

    tracks[0].mute = true;
    require(sonora::audio::renderMixBlock(output, 1, 48'000.0, 0, project, &state, trackPeaks.data(), trackPeaks.size()),
        "muted track meter update succeeds");
    require(trackPeaks[0] == 0.0F && std::abs(trackPeaks[1] - 0.5303301F) < 1.0e-5F,
        "muted tracks read zero while active track peaks remain isolated");
    require(!sonora::audio::renderMixBlock(output, 1, 48'000.0, 0, project, &state, trackPeaks.data(), 1),
        "an undersized peak buffer is rejected before rendering");
}

void testInvalidProjectMixIsRejectedBeforeWriting() {
    const float sample[]{1.0F};
    const sonora::audio::PcmSourceView source{sample, 1, 1, 48'000.0};
    const sonora::audio::TrackMixSettings tracks[]{{}};
    const sonora::audio::AudioClipView clips[]{{&source, 1, 0, 0, 1, 1.0, 1.0F, 0.0F}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    float output[]{7.0F, 9.0F};

    require(!sonora::audio::renderMixBlock(output, 1, 48'000.0, 0, project), "out-of-range track index is rejected");
    require(output[0] == 7.0F && output[1] == 9.0F, "invalid project does not alter output");
}

void testTrackDelayProducesDelayedTail() {
    const float impulse[]{1.0F};
    const sonora::audio::PcmSourceView source{impulse, 1, 1, 48'000.0};
    const sonora::audio::TrackMixSettings tracks[]{{1.0F, 0.0F, false, false, false, true}};
    const sonora::audio::AudioClipView clips[]{{&source, 0, 0, 0, 1, 1.0, 1.0F, 0.0F}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    sonora::audio::ProjectMixState state;
    require(sonora::audio::configureProjectMixState(state, project), "delay state preallocates off the audio callback");
    std::vector<float> firstBlock(8192 * 2);
    std::vector<float> secondBlock(8192 * 2);
    float firstTrackPeak{};
    float secondTrackPeak{};
    require(sonora::audio::renderMixBlock(firstBlock.data(), 8192, 48'000.0, 0, project, &state, &firstTrackPeak, 1), "delay processes its first block");
    require(sonora::audio::renderMixBlock(secondBlock.data(), 8192, 48'000.0, 8192, project, &state, &secondTrackPeak, 1), "delay preserves state between blocks");
    const auto delayedIndex = (13'440 - 8192) * 2;
    require(std::abs(secondBlock[delayedIndex] - 0.14142136F) < 1.0e-5F &&
        std::abs(secondBlock[delayedIndex + 1] - secondBlock[delayedIndex]) < 1.0e-6F,
        "280 ms delay returns a stereo echo at the configured wet level");
    require(std::abs(secondTrackPeak - 0.14142136F) < 1.0e-5F,
        "meter reads the delayed signal after track effects");
}

void testTrackReverbProducesRoomTail() {
    const float impulse[]{1.0F};
    const sonora::audio::PcmSourceView source{impulse, 1, 1, 48'000.0};
    const sonora::audio::TrackMixSettings tracks[]{{1.0F, 0.0F, false, false, true, false}};
    const sonora::audio::AudioClipView clips[]{{&source, 0, 0, 0, 1, 1.0, 1.0F, 0.0F}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    sonora::audio::ProjectMixState state;
    require(sonora::audio::configureProjectMixState(state, project), "reverb state preallocates off the audio callback");
    std::vector<float> output(2048 * 2);
    require(sonora::audio::renderMixBlock(output.data(), 2048, 48'000.0, 0, project, &state), "reverb processes an impulse");
    const auto firstEcho = 1493 * 2;
    require(output[firstEcho] > 0.04F && output[firstEcho] < 0.06F &&
        std::abs(output[firstEcho + 1] - output[firstEcho]) < 1.0e-6F,
        "room reverb creates a decaying stereo reflection");
}

void testParametricEqualizerBoostsCenterFrequencyAndRejectsInvalidSettings() {
    constexpr std::size_t frameCount = 4800;
    std::vector<float> input(frameCount * 2);
    for (std::size_t frame = 0; frame < frameCount; ++frame) {
        const float sample = 0.2F * std::sin(2.0F * 3.14159265358979323846F * 1000.0F * static_cast<float>(frame) / 48'000.0F);
        input[frame * 2] = sample;
        input[frame * 2 + 1] = sample;
    }
    const sonora::audio::PcmSourceView source{input.data(), frameCount, 2, 48'000.0};
    const sonora::audio::AudioClipView clip{&source, 0, 0, 0, frameCount, 1.0, 1.0F, 0.0F};
    const sonora::audio::TrackMixSettings flatTrack{1.0F, 0.0F, false, false, false, false};
    const sonora::audio::TrackMixSettings eqTrack{1.0F, 0.0F, false, false, false, false, {}, true, 1000.0F, 6.0F, 1.0F};
    const sonora::audio::ProjectMixView flatProject{&flatTrack, 1, &clip, 1, 1.0F};
    const sonora::audio::ProjectMixView eqProject{&eqTrack, 1, &clip, 1, 1.0F};
    sonora::audio::ProjectMixState flatState, eqState;
    require(sonora::audio::configureProjectMixState(flatState, flatProject), "flat EQ reference state configures");
    require(sonora::audio::configureProjectMixState(eqState, eqProject), "parametric EQ state configures");
    std::vector<float> flatOutput(frameCount * 2), eqOutput(frameCount * 2);
    require(sonora::audio::renderMixBlock(flatOutput.data(), frameCount, 48'000.0, 0, flatProject, &flatState), "flat reference renders");
    require(sonora::audio::renderMixBlock(eqOutput.data(), frameCount, 48'000.0, 0, eqProject, &eqState), "parametric EQ renders");
    double flatEnergy = 0.0, eqEnergy = 0.0;
    for (std::size_t frame = 500; frame < frameCount; ++frame) {
        flatEnergy += static_cast<double>(flatOutput[frame * 2]) * flatOutput[frame * 2];
        eqEnergy += static_cast<double>(eqOutput[frame * 2]) * eqOutput[frame * 2];
    }
    const double rmsRatio = std::sqrt(eqEnergy / flatEnergy);
    require(rmsRatio > 1.9 && rmsRatio < 2.1, "6 dB peaking EQ boosts its center tone by approximately 6 dB");

    const sonora::audio::TrackMixSettings invalidEq{1.0F, 0.0F, false, false, false, false, {}, true, 1000.0F, 6.0F, 0.0F};
    const sonora::audio::ProjectMixView invalidProject{&invalidEq, 1, &clip, 1, 1.0F};
    sonora::audio::ProjectMixState invalidState;
    require(!sonora::audio::configureProjectMixState(invalidState, invalidProject), "invalid EQ Q is rejected before playback");
}

void testSevenParametricEqualizerBandsShapeTheirOwnFrequencies() {
    const auto measure = [](const float frequencyHz, const std::size_t bandIndex) {
        constexpr std::size_t frameCount = 4800;
        std::vector<float> input(frameCount * 2);
        for (std::size_t frame = 0; frame < frameCount; ++frame) {
            const float sample = 0.2F * std::sin(2.0F * 3.14159265358979323846F * frequencyHz * static_cast<float>(frame) / 48'000.0F);
            input[frame * 2] = sample;
            input[frame * 2 + 1] = sample;
        }
        const sonora::audio::PcmSourceView source{input.data(), frameCount, 2, 48'000.0};
        const sonora::audio::AudioClipView clip{&source, 0, 0, 0, frameCount, 1.0, 1.0F, 0.0F};
        auto track = sonora::audio::TrackMixSettings{1.0F, 0.0F, false, false, false, false};
        track.equalizer = true;
        track.equalizerBands = sonora::audio::kDefaultEqualizerBands;
        track.equalizerBands[bandIndex].gainDb = 6.0F;
        const sonora::audio::ProjectMixView project{&track, 1, &clip, 1, 1.0F};
        sonora::audio::ProjectMixState state;
        require(sonora::audio::configureProjectMixState(state, project), "seven-band EQ state configures");
        std::vector<float> output(frameCount * 2);
        require(sonora::audio::renderMixBlock(output.data(), frameCount, 48'000.0, 0, project, &state), "seven-band EQ renders");
        double inputEnergy = 0.0, outputEnergy = 0.0;
        for (std::size_t frame = 500; frame < frameCount; ++frame) {
            inputEnergy += static_cast<double>(input[frame * 2]) * input[frame * 2];
            outputEnergy += static_cast<double>(output[frame * 2]) * output[frame * 2];
        }
        return std::sqrt(outputEnergy / inputEnergy);
    };
    const double lowBandRatio = measure(400.0F, 2);
    const double upperBandRatio = measure(2400.0F, 4);
    require(lowBandRatio > 1.9 && lowBandRatio < 2.1, "400 Hz band delivers an independent six-decibel boost");
    require(upperBandRatio > 1.9 && upperBandRatio < 2.1, "2.4 kHz band delivers an independent six-decibel boost");
}

void testTrackCompressorReducesSignalAboveThreshold() {
    constexpr std::size_t frameCount = 48'000;
    std::vector<float> samples(frameCount * 2, 0.8F);
    const sonora::audio::PcmSourceView source{samples.data(), frameCount, 2, 48'000.0};
    sonora::audio::TrackMixSettings track{1.0F, 0.0F, false, false};
    track.compressor = true; track.compressorThresholdDb = -12.0F; track.compressorRatio = 4.0F;
    track.compressorAttackMs = 10.0F; track.compressorReleaseMs = 120.0F; track.compressorMakeupDb = 3.0F;
    const sonora::audio::AudioClipView clip{&source, 0, 0, 0, frameCount, 1.0, 1.0F, 0.0F};
    const sonora::audio::ProjectMixView project{&track, 1, &clip, 1, 1.0F};
    sonora::audio::ProjectMixState state;
    require(sonora::audio::configureProjectMixState(state, project), "compressor runtime is prepared before audio rendering");
    std::array<float, 2> first{};
    require(sonora::audio::renderMixBlock(first.data(), 1, 48'000.0, 0, project, &state), "compressor processes audio");
    std::vector<float> settled(4096 * 2);
    require(sonora::audio::renderMixBlock(settled.data(), 4096, 48'000.0, 4096, project, &state), "compressor reduction persists across blocks");
    const float inputLevelDb = 6.020599913F * std::log2(0.8F);
    const float overThresholdDb = inputLevelDb - track.compressorThresholdDb;
    const float reductionDb = overThresholdDb / track.compressorRatio - overThresholdDb;
    const float gain = std::pow(10.0F, reductionDb / 20.0F);
    const float expected = 0.8F * gain * std::pow(10.0F, track.compressorMakeupDb / 20.0F);
    require(settled[2048 * 2] < 0.8F && std::abs(settled[2048 * 2] - expected) < 0.015F,
        "threshold and ratio produce the expected settled gain reduction");
    track.compressorRatio = 0.0F;
    std::array<float, 2> untouched{0.25F, -0.5F};
    require(!sonora::audio::renderMixBlock(untouched.data(), 1, 48'000.0, 0, project, &state),
        "invalid compressor settings are rejected before mixing");
    require(untouched[0] == 0.25F && untouched[1] == -0.5F, "invalid compressor settings leave output untouched");
}

void testTrackLimiterCapsOutputAtConfiguredCeilingAndRejectsInvalidSettings() {
    constexpr std::size_t frameCount = 4096;
    std::vector<float> samples(frameCount * 2, 0.8F);
    const sonora::audio::PcmSourceView source{samples.data(), frameCount, 2, 48'000.0};
    sonora::audio::TrackMixSettings track{1.0F, 0.0F, false, false};
    track.limiter = true; track.limiterCeilingDb = -6.0F; track.limiterReleaseMs = 80.0F;
    const sonora::audio::AudioClipView clip{&source, 0, 0, 0, frameCount, 1.0, 1.0F, 0.0F};
    const sonora::audio::ProjectMixView project{&track, 1, &clip, 1, 1.0F};
    sonora::audio::ProjectMixState state;
    require(sonora::audio::configureProjectMixState(state, project), "limiter runtime is prepared before audio rendering");
    std::vector<float> output(frameCount * 2);
    require(sonora::audio::renderMixBlock(output.data(), frameCount, 48'000.0, 0, project, &state), "limiter processes audio");
    const float ceiling = std::pow(10.0F, -6.0F / 20.0F);
    float peak = 0.0F;
    for (const float sample : output) peak = std::max(peak, std::abs(sample));
    require(peak <= ceiling + 1.0e-5F && peak > ceiling - 1.0e-5F, "limiter clamps the signal to its configured ceiling");
    track.limiterCeilingDb = 1.0F;
    std::array<float, 2> untouched{0.25F, -0.5F};
    require(!sonora::audio::renderMixBlock(untouched.data(), 1, 48'000.0, 0, project, &state),
        "limiter rejects a ceiling above 0 dB");
    require(untouched[0] == 0.25F && untouched[1] == -0.5F, "invalid limiter settings leave output untouched");
}

void testEffectsRequirePreallocatedRuntimeBeforeWriting() {
    const float impulse[]{1.0F};
    const sonora::audio::PcmSourceView source{impulse, 1, 1, 48'000.0};
    const sonora::audio::TrackMixSettings tracks[]{{1.0F, 0.0F, false, false, false, true}};
    const sonora::audio::AudioClipView clips[]{{&source, 0, 0, 0, 1, 1.0, 1.0F, 0.0F}};
    const sonora::audio::ProjectMixView project{tracks, 1, clips, 1, 1.0F};
    float output[]{0.25F, -0.5F};
    require(!sonora::audio::renderMixBlock(output, 1, 48'000.0, 0, project), "effect graph without preallocated state is rejected");
    require(output[0] == 0.25F && output[1] == -0.5F, "rejected effect render leaves output untouched");
}

void testCaptureRingChannelModes() {
    const float stereo[]{0.25F, -0.5F, 0.75F, -0.25F};
    std::array<float, 4> output{};
    sonora::audio::CaptureRing mono(1, 8, 8);
    require(mono.write(stereo, 2, 2, sonora::audio::CaptureChannelMode::Mono) == 2, "mono capture accepts available frames");
    require(mono.read(output.data(), 2) == 2, "mono capture frames can be drained");
    require(std::abs(output[0] + 0.125F) < 1.0e-6F && std::abs(output[1] - 0.25F) < 1.0e-6F, "mono mode averages left and right input");

    sonora::audio::CaptureRing right(1, 8, 8);
    require(right.write(stereo, 2, 2, sonora::audio::CaptureChannelMode::Right) == 2, "right-channel capture accepts frames");
    require(right.read(output.data(), 2) == 2 && output[0] == -0.5F && output[1] == -0.25F, "right-channel mode selects the right input");

    sonora::audio::CaptureRing stereoOutput(2, 8, 8);
    require(stereoOutput.write(stereo, 2, 2, sonora::audio::CaptureChannelMode::Stereo) == 2, "stereo capture accepts frames");
    require(stereoOutput.read(output.data(), 2) == 2 && output[0] == 0.25F && output[1] == -0.5F && output[2] == 0.75F && output[3] == -0.25F,
        "stereo mode preserves channel order");
}

void testCaptureRingReportsBackpressureAndHonorsFrameLimit() {
    const float input[]{0.1F, 0.2F, 0.3F};
    float output[2]{};
    sonora::audio::CaptureRing ring(1, 2, 2);
    require(ring.write(input, 3, 1, sonora::audio::CaptureChannelMode::Mono) == 2, "capture ring accepts frames only up to its capacity");
    require(ring.droppedFrames() == 1, "capture ring counts frames dropped under backpressure");
    require(ring.read(output, 2) == 2 && std::abs(output[0] - 0.1F) < 1.0e-6F && std::abs(output[1] - 0.2F) < 1.0e-6F,
        "capture ring drains frames in FIFO order");
    require(ring.write(input, 1, 1, sonora::audio::CaptureChannelMode::Mono) == 0, "capture ring never exceeds the file frame limit after draining");
}

void testCaptureRecorderWritesFinalizedPcmWave() {
    const auto timestamp = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto path = std::filesystem::temp_directory_path() / ("sonora-capture-test-" + std::to_string(timestamp) + ".wav");
    {
        sonora::audio::CaptureWavRecorder recorder(path.string(), 1, 48'000);
        require(recorder.ready(), "capture writer opens its file and starts its worker");
        const float input[]{-1.0F, -0.5F, 0.5F, 1.0F};
        require(recorder.push(input, 4, 1, sonora::audio::CaptureChannelMode::Mono) == 4, "capture samples enter the preallocated ring");
        recorder.stop();
        require(!recorder.writeError(), "capture writer finalizes without file errors");
        require(recorder.framesWritten() == 4 && recorder.fileBytes() == 52, "capture writer reports its exact WAV size");
    }
    std::ifstream file(path, std::ios::binary);
    const std::vector<unsigned char> bytes{std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
    std::error_code ignored;
    std::filesystem::remove(path, ignored);
    require(bytes.size() == 52, "recorded file contains a RIFF header and four PCM frames");
    require(std::string(bytes.begin(), bytes.begin() + 4) == "RIFF" && std::string(bytes.begin() + 8, bytes.begin() + 12) == "WAVE",
        "capture file has a finalized RIFF/WAVE container");
    require(bytes[22] == 1 && bytes[24] == 0x80 && bytes[25] == 0xbb && bytes[40] == 8 && bytes[44] == 0 && bytes[45] == 0x80,
        "capture WAV header records mono 48 kHz PCM16 and the first full-scale sample");
    require(bytes[46] == 0 && bytes[47] == 0xc0 && bytes[48] == 0xff && bytes[49] == 0x3f && bytes[50] == 0xff && bytes[51] == 0x7f,
        "capture WAV encodes signed samples without clipping at positive full scale");
}

void testSpectrumAnalyzerFindsToneAndResets() {
    sonora::audio::SpectrumAnalyzer analyzer(48'000.0);
    std::array<float, sonora::audio::kSpectrumWindowFrames * 2> stereo{};
    constexpr double frequency = 1'000.0;
    constexpr double pi = 3.14159265358979323846;
    for (std::size_t frame = 0; frame < sonora::audio::kSpectrumWindowFrames; ++frame) {
        const auto sample = static_cast<float>(0.5 * std::sin(2.0 * pi * frequency * static_cast<double>(frame) / 48'000.0));
        stereo[frame * 2] = sample;
        stereo[frame * 2 + 1] = sample;
    }
    analyzer.process(stereo.data(), sonora::audio::kSpectrumWindowFrames);
    const auto& bands = analyzer.bands();
    const auto expectedBand = static_cast<std::size_t>(std::round(
        std::log(frequency / 30.0) / std::log(18'000.0 / 30.0) *
        static_cast<double>(sonora::audio::kSpectrumBandCount - 1)));
    require(expectedBand < bands.size() && bands[expectedBand] > 0.2F, "spectrum analyzer reports energy near a 1 kHz tone");
    const auto peakBand = static_cast<std::size_t>(std::distance(bands.begin(), std::max_element(bands.begin(), bands.end())));
    require(peakBand + 1 >= expectedBand && peakBand <= expectedBand + 1, "spectrum analyzer peak maps to the tone's log-frequency band");
    analyzer.reset();
    require(std::all_of(analyzer.bands().begin(), analyzer.bands().end(), [](const float value) { return value == 0.0F; }),
        "spectrum analyzer reset clears published bands");
}

} // namespace

void testMidiEventQueuePreservesOrderAndBoundedReads() {
    sonora::midi::EventQueue queue;
    sonora::midi::Event first{}; first.bytes = {0x90, 60, 100}; first.size = 3; first.deltaSeconds = 0.01;
    sonora::midi::Event second{}; second.bytes = {0x80, 60, 0}; second.size = 3; second.deltaSeconds = 0.12;
    require(queue.push(first) && queue.push(second), "MIDI queue accepts events while capacity remains");
    const auto firstBatch = queue.drain(1);
    require(firstBatch.size() == 1 && firstBatch[0].bytes[1] == 60 && firstBatch[0].bytes[0] == 0x90,
        "MIDI queue drains events in order and respects a smaller batch size");
    const auto secondBatch = queue.drain();
    require(secondBatch.size() == 1 && secondBatch[0].bytes[0] == 0x80,
        "MIDI queue retains later events for the next poll");
}

void testMidiEventQueueDropsNewestOnOverflowAndCountsLoss() {
    sonora::midi::EventQueue queue;
    sonora::midi::Event event{}; event.bytes = {0x90, 60, 100}; event.size = 3;
    for (std::size_t index = 0; index < sonora::midi::EventQueue::kCapacity; ++index) {
        require(queue.push(event), "MIDI queue accepts events up to its fixed capacity");
    }
    require(!queue.push(event), "MIDI queue rejects a new event instead of overwriting unread data");
    require(queue.takeDroppedCount() == 1 && queue.takeDroppedCount() == 0, "MIDI queue reports dropped events once");
    std::size_t drained = 0;
    while (drained < sonora::midi::EventQueue::kCapacity) drained += queue.drain().size();
    require(drained == sonora::midi::EventQueue::kCapacity, "MIDI queue drains the complete bounded backlog in batches");
    require(queue.push(event), "MIDI queue resumes after the consumer makes room");
}

void testMixerBusRoutingAndSolo() {
    const float sample[]{1.0F};
    const sonora::audio::PcmSourceView source{sample,1,1,48'000.0};
    sonora::audio::TrackMixSettings tracks[]{{1.0F,0.0F,false,false},{0.5F,1.0F,false,false}};
    tracks[0].outputBusIndex=1; tracks[1].isBus=true;
    const sonora::audio::AudioClipView clips[]{{&source,0,0,0,1,1.0,1.0F,0.0F}};
    const sonora::audio::ProjectMixView project{tracks,2,clips,1,1.0F};
    sonora::audio::ProjectMixState state;
    require(sonora::audio::configureProjectMixState(state,project),"bus graph prepared off callback");
    float output[2]{},peaks[2]{};
    require(sonora::audio::renderMixBlock(output,1,48'000.0,0,project,&state,peaks,2),"routed mix renders");
    require(std::abs(output[0])<1e-6F&&std::abs(output[1]-0.3535534F)<1e-5F,"track feeds bus then bus gain and pan reach master");
    tracks[1].solo=true;
    require(sonora::audio::renderMixBlock(output,1,48'000.0,0,project,&state,peaks,2),"solo bus renders");
    require(std::abs(output[1]-0.3535534F)<1e-5F,"solo bus keeps unmuted inputs");
    tracks[1].mute=true;
    require(sonora::audio::renderMixBlock(output,1,48'000.0,0,project,&state,peaks,2),"muted bus renders");
    require(std::abs(output[0])<1e-6F&&std::abs(output[1])<1e-6F,"bus mute suppresses output");
    tracks[1].mute=false;tracks[1].solo=false;tracks[0].solo=true;
    require(sonora::audio::renderMixBlock(output,1,48'000.0,0,project,&state,peaks,2),"solo track routes through bus");
    require(std::abs(output[1]-0.3535534F)<1e-5F,"solo track keeps its bus audible");
    tracks[0].outputBusIndex=8;
    require(!sonora::audio::renderMixBlock(output,1,48'000.0,0,project,&state),"unknown target bus rejected");
    tracks[0].outputBusIndex=-2;
    require(!sonora::audio::renderMixBlock(output,1,48'000.0,0,project,&state),"invalid negative target bus rejected");
}
void testMixerBusDelayTailContinuesAcrossBlocks() {
    const float impulse[]{1.0F};
    const sonora::audio::PcmSourceView source{impulse,1,1,48'000.0};
    sonora::audio::TrackMixSettings tracks[]{{1.0F,0.0F,false,false},{1.0F,0.0F,false,false}};
    tracks[0].outputBusIndex=1;
    tracks[1].isBus=true;
    tracks[1].delay=true;
    const sonora::audio::AudioClipView clips[]{{&source,0,0,0,1,1.0,1.0F,0.0F}};
    const sonora::audio::ProjectMixView project{tracks,2,clips,1,1.0F};
    sonora::audio::ProjectMixState state;
    require(sonora::audio::configureProjectMixState(state,project),"bus delay state is prepared outside the callback");
    std::vector<float> firstBlock(8192*2),secondBlock(8192*2);
    float firstPeaks[2]{},secondPeaks[2]{};
    require(sonora::audio::renderMixBlock(firstBlock.data(),8192,48'000.0,0,project,&state,firstPeaks,2),"bus delay processes its input block");
    require(sonora::audio::renderMixBlock(secondBlock.data(),8192,48'000.0,8192,project,&state,secondPeaks,2),"bus delay processes the following silent block");
    const auto delayedIndex=(13'440-8192)*2;
    require(std::abs(secondBlock[delayedIndex]-0.14142136F)<1.0e-5F &&
        std::abs(secondBlock[delayedIndex+1]-secondBlock[delayedIndex])<1.0e-6F,
        "bus delay tail reaches the master after its source clip ends");
    require(std::abs(secondPeaks[1]-0.14142136F)<1.0e-5F,"bus meter reports its delayed tail");
}
void testRealtimePluginAudioBlockQueue() {
    sonora::plugin::AudioBlockQueue queue;
    sonora::plugin::AudioBlock block{};
    require(!queue.tryPop(block), "realtime plugin queue begins empty");

    const std::array<float, 6> first{0.1F, -0.1F, 0.2F, -0.2F, 0.3F, -0.3F};
    require(!queue.tryPush(1, first, 4), "realtime plugin queue rejects mismatched frame length");
    require(queue.tryPush(42, first, 3, 1'200, 900), "realtime plugin queue accepts a valid bounded block");
    require(queue.sizeApprox() == 1, "realtime plugin queue reports its bounded depth");
    require(queue.tryPop(block), "realtime plugin queue returns a queued block");
    require(block.sequence == 42 && block.frameCount == 3, "realtime plugin block preserves sequence and frames");
    require(block.projectFrame == 1'200 && block.steadyTime == 900, "realtime plugin block preserves project position and monotonic stream time");
    require(block.samples[0] == first[0] && block.samples[5] == first[5], "realtime plugin block preserves stereo samples");
    require(!queue.tryPop(block), "realtime plugin queue becomes empty after read");
}
void testRealtimePluginAudioBlockQueueBackpressureAndOrder() {
    sonora::plugin::AudioBlockQueue queue;
    const std::array<float, 2> sample{0.25F, -0.25F};
    for (std::uint64_t sequence = 0; sequence < sonora::plugin::kPluginAudioQueueCapacity; ++sequence) {
        require(queue.tryPush(sequence, sample, 1), "realtime plugin queue accepts blocks up to capacity");
    }
    require(!queue.tryPush(99, sample, 1), "realtime plugin queue rejects writes at capacity instead of blocking");
    sonora::plugin::AudioBlock block{};
    for (std::uint64_t expected = 0; expected < sonora::plugin::kPluginAudioQueueCapacity; ++expected) {
        require(queue.tryPop(block), "realtime plugin queue drains queued blocks");
        require(block.sequence == expected && block.samples[0] == sample[0], "realtime plugin queue preserves FIFO order");
    }
    require(queue.sizeApprox() == 0, "realtime plugin queue returns to empty");
}

void testRealtimePluginAudioBlockQueueAcrossThreads() {
    sonora::plugin::AudioBlockQueue queue;
    constexpr std::uint64_t kBlockCount = 20'000;
    std::thread producer([&queue]() {
        std::array<float, 2> samples{};
        for (std::uint64_t sequence = 0; sequence < kBlockCount; ++sequence) {
            samples[0] = static_cast<float>(sequence % 1000) / 1000.0F;
            samples[1] = -samples[0];
            while (!queue.tryPush(sequence, samples, 1)) std::this_thread::yield();
        }
    });

    sonora::plugin::AudioBlock block{};
    for (std::uint64_t expected = 0; expected < kBlockCount; ++expected) {
        while (!queue.tryPop(block)) std::this_thread::yield();
        const float expectedSample = static_cast<float>(expected % 1000) / 1000.0F;
        require(block.sequence == expected, "realtime plugin queue publishes cross-thread blocks in sequence");
        require(block.frameCount == 1 && block.samples[0] == expectedSample && block.samples[1] == -expectedSample,
            "realtime plugin queue publishes complete block data before its sequence");
    }
    producer.join();
}

int main() {
    testToneFrequencyAndStereoAlignment();
    testInvalidToneIsRejectedWithoutWriting();
    testConstantPowerPan();
    testBeatConversionValidation();
    testProjectClipOffsetGainAndMonoPan();
    testProjectClipFades();
    testProjectClipGainEnvelopeRendersAndValidates();
    testProjectSampleRateAndPlaybackRate();
    testProjectSoloAndMute();
    testTrackGainAutomationInterpolatesAcrossBlocksAndSeeks();
    testTrackPanAutomationInterpolatesAcrossBlocksAndSeeks();
    testInvalidPanAutomationIsRejectedBeforeWriting();
    testInvalidTrackGainAutomationIsRejectedBeforeWriting();
    testTrackPeakMetersReportPostEffectPreMasterLevels();
    testInvalidProjectMixIsRejectedBeforeWriting();
    testTrackDelayProducesDelayedTail();
    testTrackReverbProducesRoomTail();
    testParametricEqualizerBoostsCenterFrequencyAndRejectsInvalidSettings();
    testSevenParametricEqualizerBandsShapeTheirOwnFrequencies();
    testTrackCompressorReducesSignalAboveThreshold();
    testTrackLimiterCapsOutputAtConfiguredCeilingAndRejectsInvalidSettings();
    testEffectsRequirePreallocatedRuntimeBeforeWriting();
    testCaptureRingChannelModes();
    testCaptureRingReportsBackpressureAndHonorsFrameLimit();
    testCaptureRecorderWritesFinalizedPcmWave();
    testSpectrumAnalyzerFindsToneAndResets();
    testMixerBusRoutingAndSolo();
    testMixerBusDelayTailContinuesAcrossBlocks();
    testMidiEventQueuePreservesOrderAndBoundedReads();
    testMidiEventQueueDropsNewestOnOverflowAndCountsLoss();
    testRealtimePluginAudioBlockQueue();
    testRealtimePluginAudioBlockQueueBackpressureAndOrder();
    testRealtimePluginAudioBlockQueueAcrossThreads();
    std::cout << "33 native audio core tests passed\n";
    return EXIT_SUCCESS;
}
