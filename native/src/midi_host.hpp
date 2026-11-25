#pragma once

#include "RtMidi.h"

#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace sonora::midi {

struct Port {
    unsigned int index{};
    std::string name;
};

struct Event {
    std::array<unsigned char, 3> bytes{};
    unsigned char size{};
    double deltaSeconds{};
};

class Host final {
public:
    static constexpr std::size_t kQueueCapacity = 1024;
    static constexpr std::size_t kMaxBatch = 256;

    Host() = default;
    ~Host() { closeInput(); closeOutput(); }

    Host(const Host&) = delete;
    Host& operator=(const Host&) = delete;

    [[nodiscard]] std::vector<Port> inputPorts() const {
        rt::midi::RtMidiIn probe;
        return listPorts(probe);
    }

    [[nodiscard]] std::vector<Port> outputPorts() const {
        rt::midi::RtMidiOut probe;
        return listPorts(probe);
    }

    [[nodiscard]] bool openInput(const unsigned int index, std::string& error) {
        error.clear();
        closeInput();
        try {
            auto input = std::make_unique<rt::midi::RtMidiIn>();
            const auto count = input->getPortCount();
            if (index >= count) {
                error = "MIDI input device is no longer available";
                return false;
            }
            const auto name = input->getPortName(index);
            resetQueue();
            input->ignoreTypes(true, false, true);
            input->setCallback(&Host::receive, this);
            input->openPort(index, "SONORA Studio MIDI Input");
            inputPortName_ = name;
            input_ = std::move(input);
            return true;
        } catch (const std::exception& exception) {
            error = exception.what();
            closeInput();
            return false;
        }
    }

    void closeInput() noexcept {
        if (input_) {
            try { input_->cancelCallback(); } catch (...) {}
            try { input_->closePort(); } catch (...) {}
            input_.reset();
        }
        inputPortName_.clear();
    }

    [[nodiscard]] bool openOutput(const unsigned int index, std::string& error) {
        error.clear();
        closeOutput();
        try {
            auto output = std::make_unique<rt::midi::RtMidiOut>();
            const auto count = output->getPortCount();
            if (index >= count) {
                error = "MIDI output device is no longer available";
                return false;
            }
            const auto name = output->getPortName(index);
            output->openPort(index, "SONORA Studio MIDI Output");
            outputPortName_ = name;
            output_ = std::move(output);
            return true;
        } catch (const std::exception& exception) {
            error = exception.what();
            closeOutput();
            return false;
        }
    }

    void closeOutput() noexcept {
        if (output_) {
            try { output_->closePort(); } catch (...) {}
            output_.reset();
        }
        outputPortName_.clear();
    }

    [[nodiscard]] bool sendNote(
        const unsigned int channel,
        const unsigned int pitch,
        const unsigned int velocity,
        const bool noteOn,
        std::string& error) {
        error.clear();
        if (channel > 15 || pitch > 127 || velocity > 127) {
            error = "MIDI channel, pitch or velocity is outside its valid range";
            return false;
        }
        if (!output_ || !output_->isPortOpen()) {
            error = "No MIDI output device is connected";
            return false;
        }
        const unsigned char message[3]{
            static_cast<unsigned char>((noteOn ? 0x90U : 0x80U) | channel),
            static_cast<unsigned char>(pitch),
            static_cast<unsigned char>(velocity),
        };
        try {
            output_->sendMessage(message, 3);
            return true;
        } catch (const std::exception& exception) {
            error = exception.what();
            closeOutput();
            return false;
        } catch (...) {
            error = "MIDI output failed";
            closeOutput();
            return false;
        }
    }

    [[nodiscard]] std::vector<Event> readEvents(const std::size_t maximum = kMaxBatch) {
        std::vector<Event> events;
        events.reserve(maximum < kMaxBatch ? maximum : kMaxBatch);
        const auto limit = maximum < kMaxBatch ? maximum : kMaxBatch;
        while (events.size() < limit) {
            const auto read = readIndex_.load(std::memory_order_relaxed);
            const auto write = writeIndex_.load(std::memory_order_acquire);
            if (read == write) break;
            events.push_back(queue_[read % kQueueCapacity]);
            readIndex_.store(read + 1, std::memory_order_release);
        }
        return events;
    }

    [[nodiscard]] std::uint64_t takeDroppedCount() noexcept {
        return droppedEvents_.exchange(0, std::memory_order_relaxed);
    }

    [[nodiscard]] bool inputOpen() const noexcept { return input_ && input_->isPortOpen(); }
    [[nodiscard]] bool outputOpen() const noexcept { return output_ && output_->isPortOpen(); }
    [[nodiscard]] const std::string& inputName() const noexcept { return inputPortName_; }
    [[nodiscard]] const std::string& outputName() const noexcept { return outputPortName_; }

private:
    template <typename Midi>
    [[nodiscard]] static std::vector<Port> listPorts(Midi& midi) {
        std::vector<Port> ports;
        const auto count = midi.getPortCount();
        ports.reserve(count);
        for (unsigned int index = 0; index < count; ++index) {
            ports.push_back({index, midi.getPortName(index)});
        }
        return ports;
    }

    void resetQueue() noexcept {
        readIndex_.store(0, std::memory_order_relaxed);
        writeIndex_.store(0, std::memory_order_relaxed);
        droppedEvents_.store(0, std::memory_order_relaxed);
    }

    static void receive(const double deltaSeconds, std::vector<unsigned char>* message, void* userData) noexcept {
        auto* const host = static_cast<Host*>(userData);
        if (host == nullptr || message == nullptr || message->empty()) return;
        const auto write = host->writeIndex_.load(std::memory_order_relaxed);
        const auto read = host->readIndex_.load(std::memory_order_acquire);
        if (write - read >= kQueueCapacity) {
            host->droppedEvents_.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        Event event{};
        event.size = static_cast<unsigned char>(message->size() < event.bytes.size() ? message->size() : event.bytes.size());
        for (std::size_t index = 0; index < event.size; ++index) event.bytes[index] = (*message)[index];
        event.deltaSeconds = std::isfinite(deltaSeconds) && deltaSeconds >= 0.0 ? deltaSeconds : 0.0;
        host->queue_[write % kQueueCapacity] = event;
        host->writeIndex_.store(write + 1, std::memory_order_release);
    }

    std::unique_ptr<rt::midi::RtMidiIn> input_;
    std::unique_ptr<rt::midi::RtMidiOut> output_;
    std::string inputPortName_;
    std::string outputPortName_;
    std::array<Event, kQueueCapacity> queue_{};
    std::atomic<std::uint32_t> readIndex_{};
    std::atomic<std::uint32_t> writeIndex_{};
    std::atomic<std::uint64_t> droppedEvents_{};
};

} // namespace sonora::midi
