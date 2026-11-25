#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
#include <optional>
#include <utility>
#include <vector>

namespace sonora::audio {

inline constexpr std::uint32_t kProtocolVersion = 1;

// Writes a mono oscillator value to each interleaved output channel. The phase
// is normalized to [0, 1) and belongs to the audio callback thread.
[[nodiscard]] bool renderSine(
    float* output,
    std::size_t frameCount,
    std::uint32_t channels,
    double sampleRate,
    double frequencyHz,
    double gain,
    double& phase) noexcept;

// Mixes a mono source into an interleaved stereo destination without clipping.
[[nodiscard]] bool mixMonoToStereo(
    const float* source,
    float* destination,
    std::size_t frameCount,
    float gain,
    float pan) noexcept;

struct PcmSourceView {
    const float* samples{};
    std::size_t frameCount{};
    std::uint32_t channels{};
    double sampleRate{};
};

struct AutomationPoint {
    std::uint64_t frame{};
    float value{};
};

struct TrackMixSettings {
    TrackMixSettings() = default;
    TrackMixSettings(
        const float trackGain,
        const float trackPan,
        const bool isMuted,
        const bool isSolo,
        const bool hasReverb = false,
        const bool hasDelay = false,
        std::vector<AutomationPoint> gainPoints = {},
        const bool hasEqualizer = false,
        const float eqFrequency = 1000.0F,
        const float eqGain = 0.0F,
        const float eqQuality = 1.0F)
        : gain(trackGain), pan(trackPan), mute(isMuted), solo(isSolo), reverb(hasReverb), delay(hasDelay),
          gainAutomation(std::move(gainPoints)), equalizer(hasEqualizer), equalizerFrequencyHz(eqFrequency),
          equalizerGainDb(eqGain), equalizerQ(eqQuality) {}

    float gain{1.0F};
    float pan{};
    bool mute{};
    bool solo{};
    bool reverb{};
    bool delay{};
    std::vector<AutomationPoint> gainAutomation;
    bool equalizer{};
    float equalizerFrequencyHz{1000.0F};
    float equalizerGainDb{};
    float equalizerQ{1.0F};
};

struct AudioClipView {
    const PcmSourceView* source{};
    std::size_t trackIndex{};
    std::uint64_t startFrame{};
    std::uint64_t sourceOffsetFrame{};
    std::uint64_t durationFrames{};
    double playbackRate{1.0};
    float gain{1.0F};
    float pan{};
    std::uint64_t fadeInFrames{};
    std::uint64_t fadeOutFrames{};
};

struct ProjectMixView {
    const TrackMixSettings* tracks{};
    std::size_t trackCount{};
    const AudioClipView* clips{};
    std::size_t clipCount{};
    float masterGain{1.0F};
};

// Mutable, preallocated DSP state owned by the audio callback. Configure this
// on the control thread before publishing the project graph.
struct ProjectMixState {
    struct TrackState {
        std::vector<float> delayBuffer;
        std::vector<float> gainAutomationValues;
        std::size_t delayPosition{};
        std::vector<float> reverbBuffer;
        std::array<std::size_t, 4> reverbLengths{};
        std::array<std::size_t, 4> reverbPositions{};
        std::array<float, 5> equalizerCoefficients{};
        std::array<float, 2> equalizerZ1{};
        std::array<float, 2> equalizerZ2{};
        bool equalizer{};
        bool reverb{};
        bool delay{};
    };

    std::vector<TrackState> tracks;
    std::vector<int> effectSlots;
    std::vector<float> trackScratch;
    std::vector<float> meterScratch;
    std::size_t maxBlockFrames{};
};

[[nodiscard]] bool configureProjectMixState(ProjectMixState& state, const ProjectMixView& project) noexcept;
void resetProjectMixState(ProjectMixState& state) noexcept;

// Zeroes and fills one interleaved stereo output block at an absolute project
// frame. The caller owns and keeps every view alive for the duration of render.
[[nodiscard]] bool renderMixBlock(
    float* output,
    std::size_t frameCount,
    double outputSampleRate,
    std::uint64_t firstProjectFrame,
    const ProjectMixView& project,
    ProjectMixState* state = nullptr,
    float* trackPeaks = nullptr,
    std::size_t trackPeakCount = 0) noexcept;

[[nodiscard]] std::optional<double> beatsToSeconds(double beats, double bpm) noexcept;

} // namespace sonora::audio
