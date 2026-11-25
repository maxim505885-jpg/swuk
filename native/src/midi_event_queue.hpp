#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace sonora::midi {

struct Event {
    std::array<unsigned char, 3> bytes{};
    unsigned char size{};
    double deltaSeconds{};
};

class EventQueue final {
public:
    static constexpr std::size_t kCapacity = 1024;
    static constexpr std::size_t kMaxBatch = 256;

    [[nodiscard]] bool push(const Event& event) noexcept {
        const auto write = writeIndex_.load(std::memory_order_relaxed);
        const auto read = readIndex_.load(std::memory_order_acquire);
        if (write - read >= kCapacity) {
            dropped_.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        events_[write % kCapacity] = event;
        writeIndex_.store(write + 1, std::memory_order_release);
        return true;
    }

    [[nodiscard]] std::vector<Event> drain(const std::size_t maximum = kMaxBatch) {
        const auto limit = maximum < kMaxBatch ? maximum : kMaxBatch;
        std::vector<Event> result;
        result.reserve(limit);
        while (result.size() < limit) {
            const auto read = readIndex_.load(std::memory_order_relaxed);
            const auto write = writeIndex_.load(std::memory_order_acquire);
            if (read == write) break;
            result.push_back(events_[read % kCapacity]);
            readIndex_.store(read + 1, std::memory_order_release);
        }
        return result;
    }

    void clear() noexcept {
        readIndex_.store(0, std::memory_order_relaxed);
        writeIndex_.store(0, std::memory_order_relaxed);
        dropped_.store(0, std::memory_order_relaxed);
    }

    [[nodiscard]] std::uint64_t takeDroppedCount() noexcept {
        return dropped_.exchange(0, std::memory_order_relaxed);
    }

private:
    std::array<Event, kCapacity> events_{};
    std::atomic<std::uint32_t> readIndex_{};
    std::atomic<std::uint32_t> writeIndex_{};
    std::atomic<std::uint64_t> dropped_{};
};

} // namespace sonora::midi
