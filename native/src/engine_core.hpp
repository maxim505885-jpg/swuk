#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
#include <optional>
#include <utility>
#include <vector>

namespace sonora::audio {

inline constexpr std::uint32_t kProtocolVersion = 1;
inline constexpr std::size_t kEqualizerBandCount = 7;
struct EqualizerBandSettings { float frequencyHz{1000.0F}; float gainDb{}; float q{1.0F}; };
inline constexpr std::array<EqualizerBandSettings, kEqualizerBandCount> kDefaultEqualizerBands{{
    {60.0F, 0.0F, 1.0F}, {150.0F, 0.0F, 1.0F}, {400.0F, 0.0F, 1.0F}, {1000.0F, 0.0F, 1.0F},
    {2400.0F, 0.0F, 1.0F}, {6000.0F, 0.0F, 1.0F}, {14000.0F, 0.0F, 1.0F},
}};

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
          equalizerGainDb(eqGain), equalizerQ(eqQuality) { equalizerBands[3] = {eqFrequency, eqGain, eqQuality}; }

    float gain{1.0F};
    float pan{};
    bool mute{};
    bool solo{};
    bool reverb{};
    bool delay{};
    bool compressor{};
    bool limiter{};
    float limiterCeilingDb{-1.0F};
    float limiterReleaseMs{80.0F};
    float compressorThresholdDb{-18.0F};
    float compressorRatio{4.0F};
    float compressorAttackMs{10.0F};
    float compressorReleaseMs{120.0F};
    float compressorMakeupDb{};
    std::vector<AutomationPoint> gainAutomation;
    std::vector<AutomationPoint> panAutomation;
    bool equalizer{};
    float equalizerFrequencyHz{1000.0F};
    float equalizerGainDb{};
    float equalizerQ{1.0F};
    std::array<EqualizerBandSettings, kEqualizerBandCount> equalizerBands = kDefaultEqualizerBands;
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
        std::vector<float> panAutomationValues;
        std::size_t delayPosition{};
        std::vector<float> reverbBuffer;
        std::array<std::size_t, 4> reverbLengths{};
        std::array<std::size_t, 4> reverbPositions{};
        std::array<std::array<float, 5>, kEqualizerBandCount> equalizerCoefficients{};
        std::array<std::array<float, 2>, kEqualizerBandCount> equalizerZ1{};
        std::array<std::array<float, 2>, kEqualizerBandCount> equalizerZ2{};
        bool equalizer{};
        bool reverb{};
        bool delay{};
        bool compressor{};
        float compressorEnvelope{1.0F};
        bool limiter{};
        float limiterEnvelope{1.0F};
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
