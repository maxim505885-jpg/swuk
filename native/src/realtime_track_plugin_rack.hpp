#pragma once

#include "realtime_clap_insert.hpp"
#include "realtime_vst3_insert.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace sonora::plugin {

inline constexpr std::size_t kMaxRealtimeTrackPluginInstances = 8;

struct TrackPluginStatus {
    const char* format{"none"};
    bool active{};
    bool ready{};
    std::uint64_t inputOverruns{};
    std::uint64_t outputUnderruns{};
    std::uint64_t outputOverruns{};
};

// Owns one isolated helper per enabled track effect. Unprocessed tracks pass
// through a fixed 512-frame delay while any track insert is active, so all
// channels stay phase-aligned before the bus/master sum.
class RealtimeTrackPluginRack final {
public:
    RealtimeTrackPluginRack() : bypassDelay_(kMaxTracks) {}

    static constexpr std::size_t kMaxTracks = 128;
    static constexpr std::uint64_t kPipelineLatencyFrames = 4ULL * kPluginAudioBlockFrames;

    [[nodiscard]] bool loadClap(
        const std::size_t trackIndex, const std::filesystem::path& pluginPath, std::string& error) {
        if (!canLoad(trackIndex, error)) return false;
        auto candidate = std::make_unique<RealtimeClapInsert>();
        if (!candidate->start(pluginPath, error)) return false;
        if (!clap_[trackIndex] && !vst3_[trackIndex]) ++activeCount_;
        stopAt(trackIndex);
        clap_[trackIndex] = std::move(candidate);
        reset(timelineStart_);
        return true;
    }

    [[nodiscard]] bool loadVst3(
        const std::size_t trackIndex, const std::filesystem::path& pluginPath, std::string& error) {
        if (!canLoad(trackIndex, error)) return false;
        auto candidate = std::make_unique<RealtimeVst3Insert>();
        if (!candidate->start(pluginPath, error)) return false;
        if (!clap_[trackIndex] && !vst3_[trackIndex]) ++activeCount_;
        stopAt(trackIndex);
        vst3_[trackIndex] = std::move(candidate);
        reset(timelineStart_);
        return true;
    }

    void unload(const std::size_t trackIndex) noexcept {
        if (trackIndex >= kMaxTracks || (!clap_[trackIndex] && !vst3_[trackIndex])) return;
        stopAt(trackIndex);
        --activeCount_;
        reset(timelineStart_);
    }

    [[nodiscard]] bool isActive() const noexcept { return activeCount_ != 0; }
    [[nodiscard]] std::size_t activeCount() const noexcept { return activeCount_; }

    // Rebind plugin instances to stable channel IDs after a project graph is
    // rebuilt. Removed tracks release their helper; reordered tracks keep it.
    void reconcileTrackIds(const std::span<const std::string> trackIds) {
        std::array<std::unique_ptr<RealtimeClapInsert>, kMaxTracks> nextClap{};
        std::array<std::unique_ptr<RealtimeVst3Insert>, kMaxTracks> nextVst3{};
        std::array<std::string, kMaxTracks> nextIds{};
        std::array<bool, kMaxTracks> claimed{};
        const auto boundedCount = std::min(trackIds.size(), kMaxTracks);
        for (std::size_t i = 0; i < boundedCount; ++i) nextIds[i] = trackIds[i];

        for (std::size_t oldIndex = 0; oldIndex < kMaxTracks; ++oldIndex) {
            if (!clap_[oldIndex] && !vst3_[oldIndex]) continue;
            std::size_t nextIndex = kMaxTracks;
            const auto& stableId = trackIds_[oldIndex];
            if (!stableId.empty()) {
                for (std::size_t candidate = 0; candidate < boundedCount; ++candidate) {
                    if (!claimed[candidate] && trackIds[candidate] == stableId) {
                        nextIndex = candidate;
                        break;
                    }
                }
            }
            if (nextIndex == kMaxTracks) {
                if (clap_[oldIndex]) clap_[oldIndex]->stop();
                if (vst3_[oldIndex]) vst3_[oldIndex]->stop();
                continue;
            }
            claimed[nextIndex] = true;
            nextClap[nextIndex] = std::move(clap_[oldIndex]);
            nextVst3[nextIndex] = std::move(vst3_[oldIndex]);
        }
        clap_ = std::move(nextClap);
        vst3_ = std::move(nextVst3);
        trackIds_ = std::move(nextIds);
        activeCount_ = 0;
        for (std::size_t i = 0; i < kMaxTracks; ++i)
            if (clap_[i] || vst3_[i]) ++activeCount_;
        reset(timelineStart_);
    }

    [[nodiscard]] TrackPluginStatus status(const std::size_t trackIndex) const noexcept {
        if (trackIndex >= kMaxTracks) return {};
        if (clap_[trackIndex]) {
            const auto* transport = clap_[trackIndex]->transport();
            return {"CLAP", true, clap_[trackIndex]->isReady(),
                transport == nullptr ? 0 : transport->inputOverruns.load(std::memory_order_relaxed),
                clap_[trackIndex]->outputUnderruns(),
                transport == nullptr ? 0 : transport->outputOverruns.load(std::memory_order_relaxed)};
        }
        if (vst3_[trackIndex]) {
            const auto* transport = vst3_[trackIndex]->transport();
            return {"VST3", true, vst3_[trackIndex]->isReady(),
                transport == nullptr ? 0 : transport->inputOverruns.load(std::memory_order_relaxed),
                vst3_[trackIndex]->outputUnderruns(),
                transport == nullptr ? 0 : transport->outputOverruns.load(std::memory_order_relaxed)};
        }
        return {};
    }

    void reset(const std::uint64_t projectFrame) noexcept {
        timelineStart_ = projectFrame;
        framesSinceReset_ = 0;
        outputProjectFrame_ = projectFrame;
        for (auto& delay : bypassDelay_) {
            delay.samples.fill(0.0F);
            delay.position = 0;
        }
        for (auto& insert : clap_) if (insert) insert->reset(projectFrame);
        for (auto& insert : vst3_) if (insert) insert->reset(projectFrame);
    }

    // Safe for the WASAPI callback: fixed storage only, no process control,
    // allocation, locks, or waits. Called once for each track/bus per block.
    void process(
        const std::size_t trackIndex, float* interleavedStereo, const std::size_t frameCount,
        const std::uint64_t firstProjectFrame) noexcept {
        if (trackIndex >= kMaxTracks || interleavedStereo == nullptr) return;
        if (trackIndex == 0) {
            framesSinceReset_ += frameCount;
            const auto available = framesSinceReset_ > kPipelineLatencyFrames
                ? framesSinceReset_ - kPipelineLatencyFrames : 0;
            outputProjectFrame_ = timelineStart_ + available;
        }

        if (clap_[trackIndex]) {
            clap_[trackIndex]->process(interleavedStereo, frameCount, firstProjectFrame);
            return;
        }
        if (vst3_[trackIndex]) {
            vst3_[trackIndex]->process(interleavedStereo, frameCount, firstProjectFrame);
            return;
        }
        if (activeCount_ == 0) return;

        auto& delay = bypassDelay_[trackIndex];
        for (std::size_t frame = 0; frame < frameCount; ++frame) {
            const auto offset = frame * kPluginAudioChannels;
            const float inputLeft = interleavedStereo[offset];
            const float inputRight = interleavedStereo[offset + 1];
            interleavedStereo[offset] = delay.samples[delay.position * kPluginAudioChannels];
            interleavedStereo[offset + 1] = delay.samples[delay.position * kPluginAudioChannels + 1];
            delay.samples[delay.position * kPluginAudioChannels] = inputLeft;
            delay.samples[delay.position * kPluginAudioChannels + 1] = inputRight;
            delay.position = (delay.position + 1) % kPipelineLatencyFrames;
        }
    }

    [[nodiscard]] std::uint64_t outputProjectFrame() const noexcept { return outputProjectFrame_; }

private:
    struct DelayLine {
        std::array<float, kPipelineLatencyFrames * kPluginAudioChannels> samples{};
        std::size_t position{};
    };

    [[nodiscard]] bool canLoad(const std::size_t trackIndex, std::string& error) const {
        if (trackIndex >= kMaxTracks) {
            error = "Realtime track plug-in index is outside the project limit";
            return false;
        }
        if (!clap_[trackIndex] && !vst3_[trackIndex] && activeCount_ >= kMaxRealtimeTrackPluginInstances) {
            error = "At most eight realtime track plug-ins can run at once";
            return false;
        }
        return true;
    }

    void stopAt(const std::size_t trackIndex) noexcept {
        if (clap_[trackIndex]) clap_[trackIndex]->stop();
        if (vst3_[trackIndex]) vst3_[trackIndex]->stop();
        clap_[trackIndex].reset();
        vst3_[trackIndex].reset();
    }

    std::array<std::unique_ptr<RealtimeClapInsert>, kMaxTracks> clap_{};
    std::array<std::unique_ptr<RealtimeVst3Insert>, kMaxTracks> vst3_{};
    std::array<std::string, kMaxTracks> trackIds_{};
    std::vector<DelayLine> bypassDelay_;
    std::size_t activeCount_{};
    std::uint64_t timelineStart_{};
    std::uint64_t framesSinceReset_{};
    std::uint64_t outputProjectFrame_{};
};

} // namespace sonora::plugin
