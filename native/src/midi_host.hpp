#pragma once

#include "RtMidi.h"
#include "midi_event_queue.hpp"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace sonora::midi {

struct Port {
    unsigned int index{};
    std::string name;
};

class Host final {
public:

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
            events_.clear();
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

    [[nodiscard]] bool sendRealtime(const unsigned int status, const unsigned int count, std::string& error) {
        error.clear();
        const bool clock = status == 0xF8U;
        if ((!clock && status != 0xFAU && status != 0xFBU && status != 0xFCU) ||
            count < 1U || count > (clock ? 96U : 1U)) {
            error = "Unsupported MIDI realtime message or repeat count";
            return false;
        }
        if (!output_ || !output_->isPortOpen()) {
            error = "No MIDI output device is connected";
            return false;
        }
        const unsigned char message = static_cast<unsigned char>(status);
        try {
            for (unsigned int index = 0; index < count; ++index) output_->sendMessage(&message, 1);
            return true;
        } catch (const std::exception& exception) {
            error = exception.what();
            closeOutput();
            return false;
        } catch (...) {
            error = "MIDI realtime output failed";
            closeOutput();
            return false;
        }
    }

    [[nodiscard]] std::vector<Event> readEvents(const std::size_t maximum = EventQueue::kMaxBatch) {
        return events_.drain(maximum);
    }

    [[nodiscard]] std::uint64_t takeDroppedCount() noexcept {
        return events_.takeDroppedCount();
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

    static void receive(const double deltaSeconds, std::vector<unsigned char>* message, void* userData) noexcept {
        auto* const host = static_cast<Host*>(userData);
        if (host == nullptr || message == nullptr || message->empty()) return;
        Event event{};
        event.size = static_cast<unsigned char>(message->size() < event.bytes.size() ? message->size() : event.bytes.size());
        for (std::size_t index = 0; index < event.size; ++index) event.bytes[index] = (*message)[index];
        event.deltaSeconds = std::isfinite(deltaSeconds) && deltaSeconds >= 0.0 ? deltaSeconds : 0.0;
        (void)host->events_.push(event);
    }

    std::unique_ptr<rt::midi::RtMidiIn> input_;
    std::unique_ptr<rt::midi::RtMidiOut> output_;
    std::string inputPortName_;
    std::string outputPortName_;
    EventQueue events_;
};

} // namespace sonora::midi
