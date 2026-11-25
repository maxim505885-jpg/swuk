#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <span>
#include <type_traits>

namespace sonora::plugin {

inline constexpr std::uint32_t kPluginAudioChannels = 2;
inline constexpr std::uint32_t kPluginAudioBlockFrames = 128;
inline constexpr std::size_t kPluginAudioBlockSamples =
    static_cast<std::size_t>(kPluginAudioChannels) * kPluginAudioBlockFrames;
inline constexpr std::size_t kPluginAudioQueueCapacity = 8;

static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
    "Shared real-time plugin transport requires lock-free 64-bit atomics");

struct AudioBlock {
    std::uint64_t sequence{};
    std::uint32_t frameCount{};
    std::uint64_t projectFrame{};
    std::array<float, kPluginAudioBlockSamples> samples{};
};

class AudioBlockQueue final {
public:
    AudioBlockQueue() = default;
    AudioBlockQueue(const AudioBlockQueue&) = delete;
    AudioBlockQueue& operator=(const AudioBlockQueue&) = delete;

    [[nodiscard]] bool tryPush(
        const std::uint64_t sequence,
        const std::span<const float> interleavedStereo,
        const std::uint32_t frameCount,
        const std::uint64_t projectFrame = 0) noexcept {
        if (frameCount == 0 || frameCount > kPluginAudioBlockFrames ||
            interleavedStereo.size() != static_cast<std::size_t>(frameCount) * kPluginAudioChannels) {
            return false;
        }
        const auto write = writeIndex_.load(std::memory_order_relaxed);
        const auto read = readIndex_.load(std::memory_order_acquire);
        if (write - read >= kPluginAudioQueueCapacity) return false;

        auto& block = blocks_[write % kPluginAudioQueueCapacity];
        block.sequence = sequence;
        block.frameCount = frameCount;
        block.projectFrame = projectFrame;
        for (std::size_t index = 0; index < interleavedStereo.size(); ++index) block.samples[index] = interleavedStereo[index];
        writeIndex_.store(write + 1, std::memory_order_release);
        return true;
    }

    [[nodiscard]] bool tryPop(AudioBlock& block) noexcept {
        const auto read = readIndex_.load(std::memory_order_relaxed);
        const auto write = writeIndex_.load(std::memory_order_acquire);
        if (read == write) return false;
        block = blocks_[read % kPluginAudioQueueCapacity];
        readIndex_.store(read + 1, std::memory_order_release);
        return true;
    }

    [[nodiscard]] std::size_t sizeApprox() const noexcept {
        const auto write = writeIndex_.load(std::memory_order_acquire);
        const auto read = readIndex_.load(std::memory_order_acquire);
        const auto count = write - read;
        return count > kPluginAudioQueueCapacity ? kPluginAudioQueueCapacity : static_cast<std::size_t>(count);
    }

private:
    alignas(64) std::atomic<std::uint64_t> writeIndex_{};
    alignas(64) std::atomic<std::uint64_t> readIndex_{};
    std::array<AudioBlock, kPluginAudioQueueCapacity> blocks_{};
};

enum class HostStatus : std::uint32_t {
    starting,
    ready,
    failed,
    stopping,
};

struct SharedTransport {
    static constexpr std::uint32_t kMagic = 0x534F4E50U; // "SONP"
    static constexpr std::uint32_t kVersion = 1;

    std::uint32_t magic{kMagic};
    std::uint32_t version{kVersion};
    std::atomic<HostStatus> status{HostStatus::starting};
    std::atomic<std::uint64_t> inputOverruns{};
    std::atomic<std::uint64_t> outputUnderruns{};
    std::atomic<std::uint64_t> outputOverruns{};
    AudioBlockQueue input;
    AudioBlockQueue output;
};

} // namespace sonora::plugin
