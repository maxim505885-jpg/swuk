#pragma once

#include "capture_ring.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

namespace sonora::audio {

class CaptureWavRecorder final {
public:
    static constexpr std::uint64_t kMaximumWavBytes = 256ULL * 1024ULL * 1024ULL;
    static constexpr std::size_t kRingCapacityFrames = 96'000;
    static constexpr std::size_t kWriterBlockFrames = 2'048;

    CaptureWavRecorder(const std::string& path, const std::uint32_t channels, const std::uint32_t sampleRate)
        : channels_(channels), sampleRate_(sampleRate), maximumFrames_(channels == 0 ? 0 : (kMaximumWavBytes - 44) / (channels * sizeof(std::int16_t))),
          ring_(channels, kRingCapacityFrames, maximumFrames_), scratch_(kWriterBlockFrames * channels),
          pcm_(kWriterBlockFrames * channels), file_(path, std::ios::binary | std::ios::in | std::ios::out | std::ios::trunc) {
        if ((channels != 1 && channels != 2) || sampleRate == 0 || !file_) {
            writeError_.store(true, std::memory_order_relaxed);
            return;
        }
        writeHeader(0);
        file_.seekp(44, std::ios::beg);
        if (!file_) {
            writeError_.store(true, std::memory_order_relaxed);
            return;
        }
        writer_ = std::thread([this] { writerLoop(); });
    }

    ~CaptureWavRecorder() { stop(); }

    CaptureWavRecorder(const CaptureWavRecorder&) = delete;
    CaptureWavRecorder& operator=(const CaptureWavRecorder&) = delete;

    [[nodiscard]] bool ready() const noexcept { return writer_.joinable() && !writeError_.load(std::memory_order_relaxed); }

    [[nodiscard]] std::size_t push(
        const float* input,
        const std::size_t frameCount,
        const std::uint32_t inputChannels,
        const CaptureChannelMode mode) noexcept {
        if (!ready()) return 0;
        return ring_.write(input, frameCount, inputChannels, mode);
    }

    void stop() noexcept {
        stopRequested_.store(true, std::memory_order_release);
        if (writer_.joinable()) writer_.join();
        if (!file_.is_open()) return;
        const auto dataBytes = static_cast<std::uint32_t>(framesWritten_.load(std::memory_order_relaxed) * channels_ * sizeof(std::int16_t));
        writeHeader(dataBytes);
        file_.flush();
        if (!file_) writeError_.store(true, std::memory_order_relaxed);
        file_.close();
    }

    [[nodiscard]] std::uint64_t framesWritten() const noexcept { return framesWritten_.load(std::memory_order_relaxed); }
    [[nodiscard]] std::uint64_t droppedFrames() const noexcept { return ring_.droppedFrames(); }
    [[nodiscard]] std::uint32_t outputChannels() const noexcept { return channels_; }
    [[nodiscard]] bool limitReached() const noexcept { return ring_.acceptedFrames() >= maximumFrames_; }
    [[nodiscard]] bool writeError() const noexcept { return writeError_.load(std::memory_order_relaxed); }
    [[nodiscard]] std::uint64_t fileBytes() const noexcept { return 44ULL + framesWritten() * channels_ * sizeof(std::int16_t); }

private:
    static void write16(std::array<unsigned char, 44>& header, const std::size_t offset, const std::uint16_t value) noexcept {
        header[offset] = static_cast<unsigned char>(value & 0xffU);
        header[offset + 1] = static_cast<unsigned char>((value >> 8U) & 0xffU);
    }

    static void write32(std::array<unsigned char, 44>& header, const std::size_t offset, const std::uint32_t value) noexcept {
        for (std::size_t byte = 0; byte < 4; ++byte) header[offset + byte] = static_cast<unsigned char>((value >> (byte * 8U)) & 0xffU);
    }

    void writeHeader(const std::uint32_t dataBytes) noexcept {
        std::array<unsigned char, 44> header{};
        const auto writeTag = [&](const std::size_t offset, const char* value) {
            for (std::size_t index = 0; index < 4; ++index) header[offset + index] = static_cast<unsigned char>(value[index]);
        };
        writeTag(0, "RIFF"); write32(header, 4, 36U + dataBytes); writeTag(8, "WAVE");
        writeTag(12, "fmt "); write32(header, 16, 16); write16(header, 20, 1); write16(header, 22, static_cast<std::uint16_t>(channels_));
        write32(header, 24, sampleRate_); write32(header, 28, sampleRate_ * channels_ * sizeof(std::int16_t));
        write16(header, 32, static_cast<std::uint16_t>(channels_ * sizeof(std::int16_t))); write16(header, 34, 16);
        writeTag(36, "data"); write32(header, 40, dataBytes);
        file_.seekp(0, std::ios::beg);
        file_.write(reinterpret_cast<const char*>(header.data()), static_cast<std::streamsize>(header.size()));
    }

    void writerLoop() noexcept {
        while (!stopRequested_.load(std::memory_order_acquire) || !ring_.empty()) {
            const auto frames = ring_.read(scratch_.data(), kWriterBlockFrames);
            if (frames == 0) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
                continue;
            }
            const auto sampleCount = frames * channels_;
            for (std::size_t index = 0; index < sampleCount; ++index) {
                const float value = std::clamp(scratch_[index], -1.0F, 1.0F);
                const auto scaled = value < 0.0F ? value * 32768.0F : value * 32767.0F;
                pcm_[index] = static_cast<std::int16_t>(scaled);
            }
            file_.write(reinterpret_cast<const char*>(pcm_.data()), static_cast<std::streamsize>(sampleCount * sizeof(std::int16_t)));
            if (!file_) {
                writeError_.store(true, std::memory_order_relaxed);
                stopRequested_.store(true, std::memory_order_release);
                break;
            }
            framesWritten_.fetch_add(frames, std::memory_order_relaxed);
        }
    }

    const std::uint32_t channels_;
    const std::uint32_t sampleRate_;
    const std::uint64_t maximumFrames_;
    CaptureRing ring_;
    std::vector<float> scratch_;
    std::vector<std::int16_t> pcm_;
    std::fstream file_;
    std::thread writer_;
    std::atomic<std::uint64_t> framesWritten_{};
    std::atomic<bool> stopRequested_{};
    std::atomic<bool> writeError_{};
};

} // namespace sonora::audio
