#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>

namespace sonora::audio {

inline constexpr std::size_t kSpectrumWindowFrames = 2048;
inline constexpr std::size_t kSpectrumBandCount = 24;

// Fixed-size log-spaced Goertzel analyzer. Call process from the audio callback;
// it performs no allocation and publishes one magnitude frame every 2048 samples.
class SpectrumAnalyzer final {
public:
    explicit SpectrumAnalyzer(const double sampleRate = 48'000.0) noexcept : sampleRate_(sampleRate) {
        constexpr double pi = 3.14159265358979323846;
        constexpr double lowHz = 30.0;
        constexpr double highHz = 18'000.0;
        for (std::size_t index = 0; index < kSpectrumBandCount; ++index) {
            const double position = static_cast<double>(index) / static_cast<double>(kSpectrumBandCount - 1);
            const double frequency = lowHz * std::pow(highHz / lowHz, position);
            coefficients_[index] = static_cast<float>(2.0 * std::cos(2.0 * pi * frequency / sampleRate_));
        }
        for (std::size_t frame = 0; frame < kSpectrumWindowFrames; ++frame) {
            const double position = static_cast<double>(frame) / static_cast<double>(kSpectrumWindowFrames - 1);
            window_[frame] = static_cast<float>(0.5 - 0.5 * std::cos(2.0 * pi * position));
        }
    }

    void process(const float* interleavedStereo, const std::size_t frameCount) noexcept {
        if (interleavedStereo == nullptr) return;
        for (std::size_t frame = 0; frame < frameCount; ++frame) {
            samples_[writePosition_++] = (interleavedStereo[frame * 2] + interleavedStereo[frame * 2 + 1]) * 0.5F;
            if (writePosition_ == kSpectrumWindowFrames) {
                analyzeWindow();
                writePosition_ = 0;
            }
        }
    }

    [[nodiscard]] const std::array<float, kSpectrumBandCount>& bands() const noexcept { return bands_; }

    void reset() noexcept {
        samples_.fill(0.0F);
        bands_.fill(0.0F);
        writePosition_ = 0;
    }

private:
    void analyzeWindow() noexcept {
        constexpr float frameScale = 4.0F / static_cast<float>(kSpectrumWindowFrames);
        for (std::size_t band = 0; band < kSpectrumBandCount; ++band) {
            const float coefficient = coefficients_[band];
            float previous = 0.0F;
            float previous2 = 0.0F;
            for (std::size_t frame = 0; frame < kSpectrumWindowFrames; ++frame) {
                const float current = samples_[frame] * window_[frame] + coefficient * previous - previous2;
                previous2 = previous;
                previous = current;
            }
            const float power = std::max(0.0F, previous * previous + previous2 * previous2 - coefficient * previous * previous2);
            const float magnitude = std::sqrt(power) * frameScale;
            // Fast rise and a short decay keep the display readable between FFT frames.
            bands_[band] = std::max(magnitude, bands_[band] * 0.72F);
        }
    }

    double sampleRate_{};
    std::array<float, kSpectrumBandCount> coefficients_{};
    std::array<float, kSpectrumWindowFrames> window_{};
    std::array<float, kSpectrumWindowFrames> samples_{};
    std::array<float, kSpectrumBandCount> bands_{};
    std::size_t writePosition_{};
};

} // namespace sonora::audio
