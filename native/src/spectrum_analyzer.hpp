#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace sonora::audio {

inline constexpr std::size_t kSpectrumWindowFrames = 2048;
inline constexpr std::size_t kSpectrumBandCount = 24;

// Fixed-size radix-2 FFT with logarithmic bands. process() performs no allocation,
// and publishes one magnitude frame every 2048 stereo samples.
class SpectrumAnalyzer final {
public:
    explicit SpectrumAnalyzer(const double sampleRate = 48'000.0) noexcept : sampleRate_(sampleRate) {
        constexpr double pi = 3.14159265358979323846;
        constexpr double lowHz = 30.0;
        constexpr double highHz = 18'000.0;
        windowSum_ = 0.0F;
        for (std::size_t frame = 0; frame < kSpectrumWindowFrames; ++frame) {
            const double position = static_cast<double>(frame) / static_cast<double>(kSpectrumWindowFrames - 1);
            window_[frame] = static_cast<float>(0.5 - 0.5 * std::cos(2.0 * pi * position));
            windowSum_ += window_[frame];
        }
        for (std::size_t index = 0; index < kSpectrumWindowFrames / 2; ++index) {
            const double angle = -2.0 * pi * static_cast<double>(index) / static_cast<double>(kSpectrumWindowFrames);
            twiddleReal_[index] = static_cast<float>(std::cos(angle));
            twiddleImag_[index] = static_cast<float>(std::sin(angle));
        }
        for (std::size_t bin = 0; bin < binBands_.size(); ++bin) {
            const double frequency = static_cast<double>(bin) * sampleRate_ / static_cast<double>(kSpectrumWindowFrames);
            if (frequency < lowHz || frequency > highHz) {
                binBands_[bin] = 0xffU;
                continue;
            }
            const double position = std::log(frequency / lowHz) / std::log(highHz / lowHz);
            const auto band = static_cast<std::size_t>(std::round(position * static_cast<double>(kSpectrumBandCount - 1)));
            binBands_[bin] = static_cast<std::uint8_t>(std::min(band, kSpectrumBandCount - 1));
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
        for (std::size_t frame = 0; frame < kSpectrumWindowFrames; ++frame) {
            real_[frame] = samples_[frame] * window_[frame];
            imag_[frame] = 0.0F;
        }

        // In-place bit-reversal permutation.
        for (std::size_t index = 1, reversed = 0; index < kSpectrumWindowFrames; ++index) {
            std::size_t bit = kSpectrumWindowFrames >> 1;
            while ((reversed & bit) != 0) {
                reversed ^= bit;
                bit >>= 1;
            }
            reversed ^= bit;
            if (index < reversed) {
                std::swap(real_[index], real_[reversed]);
                std::swap(imag_[index], imag_[reversed]);
            }
        }

        for (std::size_t length = 2; length <= kSpectrumWindowFrames; length <<= 1) {
            const std::size_t halfLength = length >> 1;
            const std::size_t twiddleStep = kSpectrumWindowFrames / length;
            for (std::size_t start = 0; start < kSpectrumWindowFrames; start += length) {
                for (std::size_t offset = 0; offset < halfLength; ++offset) {
                    const std::size_t even = start + offset;
                    const std::size_t odd = even + halfLength;
                    const std::size_t twiddle = offset * twiddleStep;
                    const float productReal = twiddleReal_[twiddle] * real_[odd] - twiddleImag_[twiddle] * imag_[odd];
                    const float productImag = twiddleReal_[twiddle] * imag_[odd] + twiddleImag_[twiddle] * real_[odd];
                    const float evenReal = real_[even], evenImag = imag_[even];
                    real_[even] = evenReal + productReal;
                    imag_[even] = evenImag + productImag;
                    real_[odd] = evenReal - productReal;
                    imag_[odd] = evenImag - productImag;
                }
            }
        }

        bands_.fill(0.0F);
        const float amplitudeScale = windowSum_ > 0.0F ? 2.0F / windowSum_ : 0.0F;
        for (std::size_t bin = 1; bin < kSpectrumWindowFrames / 2; ++bin) {
            const auto band = binBands_[bin];
            if (band >= kSpectrumBandCount) continue;
            const float magnitude = std::sqrt(real_[bin] * real_[bin] + imag_[bin] * imag_[bin]) * amplitudeScale;
            bands_[band] = std::max(bands_[band], magnitude);
        }
        for (auto& band : bands_) band *= 0.72F;
    }

    double sampleRate_{};
    float windowSum_{};
    std::array<float, kSpectrumWindowFrames> window_{};
    std::array<float, kSpectrumWindowFrames> samples_{};
    std::array<float, kSpectrumWindowFrames> real_{};
    std::array<float, kSpectrumWindowFrames> imag_{};
    std::array<float, kSpectrumWindowFrames / 2> twiddleReal_{};
    std::array<float, kSpectrumWindowFrames / 2> twiddleImag_{};
    std::array<std::uint8_t, kSpectrumWindowFrames / 2> binBands_{};
    std::array<float, kSpectrumBandCount> bands_{};
    std::size_t writePosition_{};
};

} // namespace sonora::audio
