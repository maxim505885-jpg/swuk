#include "engine_core.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <vector>

namespace {

constexpr std::size_t kBlockFrames = 512;
constexpr std::size_t kIterations = 3'000;
constexpr std::size_t kSourceFrames = (kIterations + 256 + 1) * kBlockFrames;
constexpr std::size_t kSourceCount = 4;
constexpr double kSampleRate = 48'000.0;

void runCase(const std::size_t activeClips, const bool withEffects = false, const bool withTrackMeters = false) {
    std::array<std::vector<float>, kSourceCount> sourceSamples;
    std::array<sonora::audio::PcmSourceView, kSourceCount> sources{};
    for (std::size_t sourceIndex = 0; sourceIndex < kSourceCount; ++sourceIndex) {
        auto& samples = sourceSamples[sourceIndex];
        samples.resize(kSourceFrames * 2);
        const double frequency = 220.0 + static_cast<double>(sourceIndex) * 110.0;
        for (std::size_t frame = 0; frame < kSourceFrames; ++frame) {
            const float sample = static_cast<float>(std::sin(2.0 * 3.141592653589793 * frequency * static_cast<double>(frame) / kSampleRate) * 0.1);
            samples[frame * 2] = sample;
            samples[frame * 2 + 1] = sample;
        }
        sources[sourceIndex] = {samples.data(), kSourceFrames, 2, kSampleRate};
    }
    std::vector<sonora::audio::TrackMixSettings> tracks(activeClips);
    if (withEffects) {
        for (auto& track : tracks) { track.reverb = true; track.delay = true; }
    }
    std::vector<sonora::audio::AudioClipView> clips;
    clips.reserve(activeClips);
    for (std::size_t index = 0; index < activeClips; ++index) {
        clips.push_back({&sources[index % kSourceCount], index, 0, 0, kSourceFrames, 1.0, 0.8F, 0.0F});
    }
    const sonora::audio::ProjectMixView project{tracks.data(), tracks.size(), clips.data(), clips.size(), 0.8F};
    sonora::audio::ProjectMixState mixState;
    if ((withEffects || withTrackMeters) && !sonora::audio::configureProjectMixState(mixState, project)) {
        std::cerr << "Could not prepare benchmark mixer state\n";
        std::exit(EXIT_FAILURE);
    }
    std::vector<float> output(kBlockFrames * 2);
    std::vector<float> trackPeaks(withTrackMeters ? activeClips : 0);
    std::vector<double> blockTimesUs;
    blockTimesUs.reserve(kIterations);
    float checksum = 0.0F;

    for (std::size_t iteration = 0; iteration < 256; ++iteration) {
        if (!sonora::audio::renderMixBlock(output.data(), kBlockFrames, kSampleRate, iteration * kBlockFrames, project,
            (withEffects || withTrackMeters) ? &mixState : nullptr, withTrackMeters ? trackPeaks.data() : nullptr, trackPeaks.size())) {
            std::cerr << "Mixer rejected benchmark project\n";
            std::exit(EXIT_FAILURE);
        }
    }

    for (std::size_t iteration = 0; iteration < kIterations; ++iteration) {
        const auto started = std::chrono::steady_clock::now();
        const bool rendered = sonora::audio::renderMixBlock(
            output.data(), kBlockFrames, kSampleRate, (iteration + 256) * kBlockFrames, project,
            (withEffects || withTrackMeters) ? &mixState : nullptr, withTrackMeters ? trackPeaks.data() : nullptr, trackPeaks.size());
        const auto finished = std::chrono::steady_clock::now();
        if (!rendered) {
            std::cerr << "Mixer rejected benchmark project\n";
            std::exit(EXIT_FAILURE);
        }
        blockTimesUs.push_back(std::chrono::duration<double, std::micro>(finished - started).count());
        checksum += std::abs(output[(iteration * 17 % kBlockFrames) * 2]);
        if (withTrackMeters) checksum += trackPeaks[iteration % trackPeaks.size()] * 0.01F;
    }

    std::sort(blockTimesUs.begin(), blockTimesUs.end());
    const double meanUs = std::accumulate(blockTimesUs.begin(), blockTimesUs.end(), 0.0) / static_cast<double>(blockTimesUs.size());
    const double p95Us = blockTimesUs[static_cast<std::size_t>(blockTimesUs.size() * 0.95)];
    const double maxUs = blockTimesUs.back();
    constexpr double kRealtimeBudgetUs = static_cast<double>(kBlockFrames) / kSampleRate * 1'000'000.0;
    std::cout << "clips=" << activeClips
              << " tracks=" << activeClips
              << " mean_us=" << meanUs
              << " p95_us=" << p95Us
              << " max_us=" << maxUs
              << " mean_realtime=" << (meanUs / kRealtimeBudgetUs * 100.0) << "%"
              << " effects=" << (withEffects ? "reverb+delay" : "off")
              << " meters=" << (withTrackMeters ? "on" : "off")
              << " checksum=" << checksum << '\n';
}

} // namespace

int main() {
    std::cout << std::fixed << std::setprecision(2)
              << "Native mixer benchmark: 48 kHz stereo, 512-frame blocks, " << kIterations
              << " measured blocks per case, 4 unique sources; target budget=10666.67 us\n";
    for (const std::size_t clips : {1U, 8U, 32U, 64U, 128U}) runCase(clips);
    runCase(8, true);
    runCase(8, false, true);
    runCase(128, false, true);
    return 0;
}
