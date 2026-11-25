#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace sonora::audio {

enum class CaptureChannelMode : std::uint8_t { Mono, Left, Right, Stereo };

class CaptureRing final {
public:
    CaptureRing(const std::uint32_t outputChannels, const std::size_t capacityFrames, const std::uint64_t maximumFrames)
        : outputChannels_(outputChannels), capacityFrames_(capacityFrames), maximumFrames_(maximumFrames),
          samples_(capacityFrames * outputChannels) {}

    CaptureRing(const CaptureRing&) = delete;
    CaptureRing& operator=(const CaptureRing&) = delete;

    [[nodiscard]] std::size_t write(
        const float* input,
        const std::size_t frameCount,
        const std::uint32_t inputChannels,
        const CaptureChannelMode mode) noexcept {
        if (input == nullptr || inputChannels == 0 || outputChannels_ == 0 || capacityFrames_ == 0) return 0;

        auto writeFrame = writeFrame_.load(std::memory_order_relaxed);
        const auto readFrame = readFrame_.load(std::memory_order_acquire);
        std::size_t accepted = 0;
        for (std::size_t frame = 0; frame < frameCount; ++frame) {
            if (writeFrame >= maximumFrames_ || writeFrame - readFrame >= capacityFrames_) {
                droppedFrames_.fetch_add(1, std::memory_order_relaxed);
                continue;
            }
            const auto* const source = input + frame * inputChannels;
            auto* const destination = samples_.data() + (writeFrame % capacityFrames_) * outputChannels_;
            if (outputChannels_ == 1) {
                if (mode == CaptureChannelMode::Left || inputChannels == 1) destination[0] = source[0];
                else if (mode == CaptureChannelMode::Right) destination[0] = source[1];
                else destination[0] = (source[0] + source[1]) * 0.5F;
            } else if (inputChannels == 1) {
                destination[0] = source[0];
                destination[1] = source[0];
            } else {
                destination[0] = source[0];
                destination[1] = source[1];
            }
            ++writeFrame;
            ++accepted;
        }
        writeFrame_.store(writeFrame, std::memory_order_release);
        return accepted;
    }

    [[nodiscard]] std::size_t read(float* output, const std::size_t maximumReadFrames) noexcept {
        if (output == nullptr || outputChannels_ == 0 || capacityFrames_ == 0) return 0;
        auto readFrame = readFrame_.load(std::memory_order_relaxed);
        const auto writeFrame = writeFrame_.load(std::memory_order_acquire);
        const auto frames = static_cast<std::size_t>(std::min<std::uint64_t>(writeFrame - readFrame, maximumReadFrames));
        for (std::size_t frame = 0; frame < frames; ++frame) {
            const auto* const source = samples_.data() + (readFrame % capacityFrames_) * outputChannels_;
            auto* const destination = output + frame * outputChannels_;
            std::copy_n(source, outputChannels_, destination);
            ++readFrame;
        }
        readFrame_.store(readFrame, std::memory_order_release);
        return frames;
    }

    [[nodiscard]] std::uint64_t acceptedFrames() const noexcept { return writeFrame_.load(std::memory_order_acquire); }
    [[nodiscard]] std::uint64_t droppedFrames() const noexcept { return droppedFrames_.load(std::memory_order_relaxed); }
    [[nodiscard]] std::size_t outputChannels() const noexcept { return outputChannels_; }
    [[nodiscard]] bool empty() const noexcept { return readFrame_.load(std::memory_order_acquire) == writeFrame_.load(std::memory_order_acquire); }

private:
    const std::uint32_t outputChannels_;
    const std::size_t capacityFrames_;
    const std::uint64_t maximumFrames_;
    std::vector<float> samples_;
    alignas(64) std::atomic<std::uint64_t> writeFrame_{};
    alignas(64) std::atomic<std::uint64_t> readFrame_{};
    std::atomic<std::uint64_t> droppedFrames_{};
};

} // namespace sonora::audio
