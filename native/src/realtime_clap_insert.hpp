#pragma once

#include "realtime_clap_process.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string>

namespace sonora::plugin {

// Master insert bridge. The audio callback only copies into fixed buffers and
// touches the lock-free shared queues; plug-in code always runs in the helper.
class RealtimeClapInsert final {
public:
    static constexpr std::uint64_t kPipelineLatencyFrames = 4ULL * kPluginAudioBlockFrames;

    [[nodiscard]] bool start(const std::filesystem::path& pluginPath, std::string& error) {
        pluginPath_.clear();
        if (!host_.start(pluginPath, error)) return false;
        pluginPath_ = pluginPath;
        reset(0);
        return true;
    }

    void stop() noexcept {
        host_.stop();
        pluginPath_.clear();
        for (auto& slot : slots_) slot.sequence = kInvalidSequence;
    }

    [[nodiscard]] bool isActive() const noexcept { return !pluginPath_.empty(); }
    [[nodiscard]] bool isReady() const noexcept { return host_.isReady(); }

    // Call only after the playback device has stopped. Sequence IDs remain
    // monotonic so any in-flight blocks from before a seek can be discarded.
    void reset(const std::uint64_t projectFrame) noexcept {
        nextOutputSequence_ = nextInputSequence_;
        outputOffset_ = 0;
        startupSilenceFrames_ = kPipelineLatencyFrames;
        outputProjectFrame_ = projectFrame;
        for (auto& slot : slots_) slot.sequence = kInvalidSequence;
        AudioBlock stale{};
        while (host_.tryReceive(stale)) {}
    }

    // Replaces the mixed stereo buffer with the isolated effect result. If the
    // helper misses a deadline, the matching dry block is used without waiting.
    void process(float* interleavedStereo, const std::size_t frameCount,
        const std::uint64_t firstProjectFrame) noexcept {
        if (interleavedStereo == nullptr) return;

        std::size_t renderedFrames = 0;
        while (renderedFrames < frameCount) {
            const auto count = static_cast<std::uint32_t>(std::min<std::size_t>(
                kPluginAudioBlockFrames, frameCount - renderedFrames));
            const auto sequence = nextInputSequence_++;
            auto& slot = slots_[sequence % slots_.size()];
            slot.sequence = sequence;
            slot.projectFrame = firstProjectFrame + renderedFrames;
            slot.frameCount = count;
            slot.processed = false;
            slot.outputModeChosen = false;
            slot.outputProcessed = false;
            const auto* const input = interleavedStereo + renderedFrames * kPluginAudioChannels;
            std::copy_n(input, static_cast<std::size_t>(count) * kPluginAudioChannels, slot.dry.data());
            if (host_.isReady()) {
                (void)host_.trySend(sequence,
                    std::span<const float>(input, static_cast<std::size_t>(count) * kPluginAudioChannels),
                    count, slot.projectFrame);
            }
            renderedFrames += count;
        }

        AudioBlock result{};
        while (host_.isReady() && host_.tryReceive(result)) {
            if (result.sequence < nextOutputSequence_ || result.sequence >= nextInputSequence_) continue;
            auto& slot = slots_[result.sequence % slots_.size()];
            if (slot.sequence != result.sequence || slot.frameCount != result.frameCount) continue;
            std::copy_n(result.samples.data(),
                static_cast<std::size_t>(result.frameCount) * kPluginAudioChannels, slot.wet.data());
            slot.processed = true;
        }

        std::size_t outputFrames = 0;
        while (outputFrames < frameCount) {
            if (startupSilenceFrames_ > 0) {
                const auto count = static_cast<std::size_t>(std::min<std::uint64_t>(
                    startupSilenceFrames_, frameCount - outputFrames));
                std::fill_n(interleavedStereo + outputFrames * kPluginAudioChannels,
                    count * kPluginAudioChannels, 0.0F);
                startupSilenceFrames_ -= count;
                outputFrames += count;
                continue;
            }

            auto& slot = slots_[nextOutputSequence_ % slots_.size()];
            if (slot.sequence != nextOutputSequence_ || outputOffset_ >= slot.frameCount) {
                std::fill_n(interleavedStereo + outputFrames * kPluginAudioChannels,
                    (frameCount - outputFrames) * kPluginAudioChannels, 0.0F);
                break;
            }
            const auto count = std::min<std::size_t>(frameCount - outputFrames, slot.frameCount - outputOffset_);
            if (!slot.outputModeChosen) {
                slot.outputModeChosen = true;
                slot.outputProcessed = slot.processed;
                if (!slot.outputProcessed) outputUnderruns_.fetch_add(1, std::memory_order_relaxed);
            }
            const auto* const source = (slot.outputProcessed ? slot.wet.data() : slot.dry.data()) +
                outputOffset_ * kPluginAudioChannels;
            std::copy_n(source, count * kPluginAudioChannels,
                interleavedStereo + outputFrames * kPluginAudioChannels);
            outputProjectFrame_ = slot.projectFrame + outputOffset_ + count;
            outputOffset_ += count;
            outputFrames += count;
            if (outputOffset_ == slot.frameCount) {
                slot.sequence = kInvalidSequence;
                outputOffset_ = 0;
                ++nextOutputSequence_;
            }
        }
    }

    [[nodiscard]] std::uint64_t outputProjectFrame() const noexcept { return outputProjectFrame_; }
    [[nodiscard]] std::uint64_t nextRenderSequence() const noexcept { return nextInputSequence_; }
    [[nodiscard]] std::uint64_t outputUnderruns() const noexcept { return outputUnderruns_.load(std::memory_order_relaxed); }
    [[nodiscard]] const std::filesystem::path& pluginPath() const noexcept { return pluginPath_; }
    [[nodiscard]] const SharedTransport* transport() const noexcept { return host_.transport(); }

private:
    static constexpr std::uint64_t kInvalidSequence = UINT64_MAX;
    struct Slot {
        std::uint64_t sequence{kInvalidSequence};
        std::uint64_t projectFrame{};
        std::uint32_t frameCount{};
        bool processed{};
        bool outputModeChosen{};
        bool outputProcessed{};
        std::array<float, kPluginAudioBlockSamples> dry{};
        std::array<float, kPluginAudioBlockSamples> wet{};
    };

    ClapPluginProcess host_;
    std::filesystem::path pluginPath_;
    std::array<Slot, kPluginAudioQueueCapacity * 4> slots_{};
    std::uint64_t nextInputSequence_{};
    std::uint64_t nextOutputSequence_{};
    std::uint64_t startupSilenceFrames_{};
    std::uint64_t outputProjectFrame_{};
    std::size_t outputOffset_{};
    std::atomic<std::uint64_t> outputUnderruns_{};
};

} // namespace sonora::plugin

