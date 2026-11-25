#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"
#include <clap/clap.h>
#include "realtime_plugin_transport.hpp"

#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <exception>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace {

constexpr ma_uint32 kChannels = 2;
constexpr ma_uint32 kBlockFrames = 1'024;
constexpr std::uint64_t kMaxWavBytes = 256ULL * 1024ULL * 1024ULL;
constexpr ma_uint32 kMaxInfiniteTailSeconds = 3;
constexpr ma_uint32 kMaxFiniteTailSeconds = 30;

struct HostState {
    std::thread::id mainThread{std::this_thread::get_id()};
    std::thread::id processThread{};
    std::atomic<bool> processing{};
};

void CLAP_ABI hostLog(const clap_host_t*, const clap_log_severity severity, const char* message) {
    if (message == nullptr) return;
    std::cerr << "CLAP " << severity << ": " << message << '\n';
}

bool CLAP_ABI hostIsMainThread(const clap_host_t* host) {
    const auto* state = static_cast<const HostState*>(host->host_data);
    return state != nullptr && std::this_thread::get_id() == state->mainThread;
}

bool CLAP_ABI hostIsAudioThread(const clap_host_t* host) {
    const auto* state = static_cast<const HostState*>(host->host_data);
    return state != nullptr && state->processing.load(std::memory_order_relaxed) && std::this_thread::get_id() == state->processThread;
}

const clap_host_log_t kHostLog{hostLog};
const clap_host_thread_check_t kHostThreadCheck{hostIsMainThread, hostIsAudioThread};

const void* CLAP_ABI hostGetExtension(const clap_host_t*, const char* extensionId) {
    if (extensionId == nullptr) return nullptr;
    if (std::string_view(extensionId) == CLAP_EXT_LOG) return &kHostLog;
    if (std::string_view(extensionId) == CLAP_EXT_THREAD_CHECK) return &kHostThreadCheck;
    return nullptr;
}

void CLAP_ABI hostNoop(const clap_host_t*) {}

uint32_t CLAP_ABI emptyEventCount(const clap_input_events_t*) { return 0; }
const clap_event_header_t* CLAP_ABI emptyEventGet(const clap_input_events_t*, uint32_t) { return nullptr; }
bool CLAP_ABI rejectOutputEvent(const clap_output_events_t*, const clap_event_header_t*) { return false; }

const clap_input_events_t kEmptyInputEvents{nullptr, emptyEventCount, emptyEventGet};
const clap_output_events_t kRejectOutputEvents{nullptr, rejectOutputEvent};

struct ParameterEventList {
    const std::vector<clap_event_param_value_t>* events{};
};

uint32_t CLAP_ABI parameterEventCount(const clap_input_events_t* list) {
    return static_cast<uint32_t>(static_cast<const ParameterEventList*>(list->ctx)->events->size());
}

const clap_event_header_t* CLAP_ABI parameterEventGet(const clap_input_events_t* list, uint32_t index) {
    const auto& events = *static_cast<const ParameterEventList*>(list->ctx)->events;
    return index < events.size() ? &events[index].header : nullptr;
}

[[nodiscard]] std::string wideToUtf8(const wchar_t* value) {
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
    if (size <= 0) throw std::runtime_error("Command line contains an invalid path");
    std::string output(static_cast<std::size_t>(size), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, output.data(), size, nullptr, nullptr) <= 0) {
        throw std::runtime_error("Could not convert a Windows path to UTF-8");
    }
    output.pop_back();
    return output;
}

[[nodiscard]] std::string jsonEscape(const std::string_view value) {
    std::string output;
    output.reserve(value.size() + 8);
    for (const unsigned char character : value) {
        switch (character) {
            case '"': output += "\\\""; break;
            case '\\': output += "\\\\"; break;
            case '\n': output += "\\n"; break;
            case '\r': output += "\\r"; break;
            case '\t': output += "\\t"; break;
            default: if (character >= 0x20U) output.push_back(static_cast<char>(character)); break;
        }
    }
    return output;
}

class PluginSession final {
public:
    explicit PluginSession(const std::string& pluginPath) : pluginPath_(pluginPath) {
        const auto utf8Path = std::u8string(pluginPath_.begin(), pluginPath_.end());
        const auto widePath = std::filesystem::path(utf8Path).wstring();
        module_ = LoadLibraryW(widePath.c_str());
        if (module_ == nullptr) throw std::runtime_error("Windows could not load this CLAP module");

        entry_ = reinterpret_cast<const clap_plugin_entry_t*>(GetProcAddress(module_, "clap_entry"));
        if (entry_ == nullptr) throw std::runtime_error("Selected file does not export clap_entry");
        if (!clap_version_is_compatible(entry_->clap_version)) throw std::runtime_error("CLAP plug-in uses an incompatible API version");
        if (!entry_->init(pluginPath_.c_str())) throw std::runtime_error("CLAP plug-in initialization failed");
        entryInitialized_ = true;

        const auto* factory = static_cast<const clap_plugin_factory_t*>(entry_->get_factory(CLAP_PLUGIN_FACTORY_ID));
        if (factory == nullptr || factory->get_plugin_count(factory) == 0) throw std::runtime_error("CLAP module contains no plug-ins");
        for (std::uint32_t index = 0; index < factory->get_plugin_count(factory); ++index) {
            const auto* descriptor = factory->get_plugin_descriptor(factory, index);
            if (descriptor == nullptr || descriptor->id == nullptr || descriptor->name == nullptr) continue;
            plugin_ = factory->create_plugin(factory, &host_, descriptor->id);
            if (plugin_ == nullptr) continue;
            pluginInitialized_ = plugin_->init(plugin_);
            if (!pluginInitialized_) {
                plugin_->destroy(plugin_);
                plugin_ = nullptr;
                continue;
            }
            const auto* ports = static_cast<const clap_plugin_audio_ports_t*>(plugin_->get_extension(plugin_, CLAP_EXT_AUDIO_PORTS));
            clap_audio_port_info_t input{};
            clap_audio_port_info_t output{};
            if (ports == nullptr || ports->count(plugin_, true) != 1 || ports->count(plugin_, false) != 1 ||
                !ports->get(plugin_, 0, true, &input) || !ports->get(plugin_, 0, false, &output) ||
                input.channel_count != kChannels || output.channel_count != kChannels ||
                (input.flags & CLAP_AUDIO_PORT_IS_MAIN) == 0 || (output.flags & CLAP_AUDIO_PORT_IS_MAIN) == 0) {
                plugin_->destroy(plugin_);
                plugin_ = nullptr;
                pluginInitialized_ = false;
                continue;
            }
            pluginName_ = descriptor->name;
            pluginId_ = descriptor->id;
            break;
        }
        if (plugin_ == nullptr) throw std::runtime_error("CLAP module has no usable stereo audio effect");
    }

    ~PluginSession() {
        if (plugin_ != nullptr) {
            if (processing_) plugin_->stop_processing(plugin_);
            if (active_) plugin_->deactivate(plugin_);
            plugin_->destroy(plugin_);
        }
        if (entryInitialized_ && entry_ != nullptr) entry_->deinit();
        if (module_ != nullptr) FreeLibrary(module_);
    }

    PluginSession(const PluginSession&) = delete;
    PluginSession& operator=(const PluginSession&) = delete;

    [[nodiscard]] const std::string& name() const noexcept { return pluginName_; }
    [[nodiscard]] const std::string& id() const noexcept { return pluginId_; }

    struct Parameter {
        clap_id id{};
        std::string name;
        std::string module;
        double minimum{};
        double maximum{};
        double value{};
        double defaultValue{};
        uint32_t flags{};
        void* cookie{};
    };

    [[nodiscard]] std::vector<Parameter> parameters() const {
        std::vector<Parameter> output;
        const auto* extension = static_cast<const clap_plugin_params_t*>(plugin_->get_extension(plugin_, CLAP_EXT_PARAMS));
        if (extension == nullptr) return output;
        const auto count = std::min(extension->count(plugin_), 128U);
        output.reserve(count);
        for (uint32_t index = 0; index < count; ++index) {
            clap_param_info_t info{};
            if (!extension->get_info(plugin_, index, &info) || (info.flags & (CLAP_PARAM_IS_HIDDEN | CLAP_PARAM_IS_READONLY)) != 0 ||
                !std::isfinite(info.min_value) || !std::isfinite(info.max_value) || !std::isfinite(info.default_value) || info.min_value >= info.max_value) continue;
            double value = info.default_value;
            if (extension->get_value(plugin_, info.id, &value) && std::isfinite(value)) value = std::clamp(value, info.min_value, info.max_value);
            else value = info.default_value;
            output.push_back({info.id, info.name, info.module, info.min_value, info.max_value, value, info.default_value, info.flags, info.cookie});
        }
        return output;
    }

    [[nodiscard]] std::vector<clap_event_param_value_t> makeParameterEvents(const std::vector<std::pair<uint32_t, double>>& values) const {
        std::vector<clap_event_param_value_t> events;
        const auto available = parameters();
        events.reserve(values.size());
        for (const auto& [id, value] : values) {
            const auto found = std::find_if(available.begin(), available.end(), [id](const auto& parameter) { return parameter.id == id; });
            if (found == available.end() || !std::isfinite(value) || value < found->minimum || value > found->maximum) {
                throw std::runtime_error("CLAP parameter ID or value is invalid");
            }
            clap_event_param_value_t event{};
            event.header = {sizeof(clap_event_param_value_t), 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE, CLAP_EVENT_IS_LIVE};
            event.param_id = found->id;
            event.cookie = found->cookie;
            event.note_id = -1;
            event.port_index = -1;
            event.channel = -1;
            event.key = -1;
            event.value = value;
            events.push_back(event);
        }
        std::sort(events.begin(), events.end(), [](const auto& left, const auto& right) { return left.param_id < right.param_id; });
        return events;
    }

    [[nodiscard]] ma_uint32 tailFrames(const ma_uint32 sampleRate) const noexcept {
        const auto* tail = static_cast<const clap_plugin_tail_t*>(plugin_->get_extension(plugin_, CLAP_EXT_TAIL));
        if (tail == nullptr) return 0;
        const auto frames = tail->get(plugin_);
        if (frames >= INT32_MAX) return sampleRate * kMaxInfiniteTailSeconds;
        return std::min(frames, sampleRate * kMaxFiniteTailSeconds);
    }

    void activate(const ma_uint32 sampleRate) {
        if (!plugin_->activate(plugin_, static_cast<double>(sampleRate), 1, kBlockFrames)) throw std::runtime_error("CLAP effect activation failed");
        active_ = true;
    }

    void startProcessing() {
        hostState_.processThread = std::this_thread::get_id();
        processing_ = true;
        hostState_.processing.store(true, std::memory_order_relaxed);
        if (!plugin_->start_processing(plugin_)) {
            hostState_.processing.store(false, std::memory_order_relaxed);
            processing_ = false;
            throw std::runtime_error("CLAP effect could not start processing");
        }
    }

    void stopProcessing() noexcept {
        if (!processing_) return;
        plugin_->stop_processing(plugin_);
        hostState_.processing.store(false, std::memory_order_relaxed);
        processing_ = false;
    }

    [[nodiscard]] bool process(
        float* leftInput,
        float* rightInput,
        float* leftOutput,
        float* rightOutput,
        const ma_uint32 frameCount,
        const std::int64_t steadyTime,
        const clap_input_events_t* inputEvents) {
        float* inputChannels[]{leftInput, rightInput};
        float* outputChannels[]{leftOutput, rightOutput};
        clap_audio_buffer_t input{inputChannels, nullptr, kChannels, 0, 0};
        clap_audio_buffer_t output{outputChannels, nullptr, kChannels, 0, 0};
        const clap_process_t process{
            steadyTime, frameCount, nullptr, &input, &output, 1, 1, inputEvents, &kRejectOutputEvents,
        };
        const auto result = plugin_->process(plugin_, &process);
        return result != CLAP_PROCESS_ERROR;
    }

private:
    std::string pluginPath_;
    std::string pluginName_;
    std::string pluginId_;
    HostState hostState_{};
    clap_host_t host_{CLAP_VERSION, &hostState_, "SONORA Studio", "SONORA", "https://sonora.local", "0.1.0", hostGetExtension, hostNoop, hostNoop, hostNoop};
    HMODULE module_{};
    const clap_plugin_entry_t* entry_{};
    const clap_plugin_t* plugin_{};
    bool entryInitialized_{};
    bool pluginInitialized_{};
    bool active_{};
    bool processing_{};
};

[[nodiscard]] std::string inspectPlugin(const std::string& pluginPath) {
    PluginSession plugin(pluginPath);
    const auto parameters = plugin.parameters();
    std::string json = "{\"ok\":true,\"pluginName\":\"" + jsonEscape(plugin.name()) + "\",\"pluginId\":\"" + jsonEscape(plugin.id()) + "\",\"parameters\":[";
    for (std::size_t index = 0; index < parameters.size(); ++index) {
        const auto& parameter = parameters[index];
        if (index > 0) json += ',';
        json += "{\"id\":" + std::to_string(parameter.id) + ",\"name\":\"" + jsonEscape(parameter.name) + "\",\"module\":\"" +
            jsonEscape(parameter.module) + "\",\"min\":" + std::to_string(parameter.minimum) + ",\"max\":" + std::to_string(parameter.maximum) +
            ",\"value\":" + std::to_string(parameter.value) + ",\"defaultValue\":" + std::to_string(parameter.defaultValue) +
            ",\"stepped\":" + ((parameter.flags & CLAP_PARAM_IS_STEPPED) != 0 ? "true" : "false") + "}";
    }
    json += "]}";
    return json;
}

void processWav(const std::string& pluginPath, const std::string& inputPath, const std::string& outputPath,
                const std::vector<std::pair<uint32_t, double>>& parameterValues) {
    ma_decoder decoder{};
    const auto decoderConfig = ma_decoder_config_init(ma_format_f32, kChannels, 0);
    const auto decoderResult = ma_decoder_init_file(inputPath.c_str(), &decoderConfig, &decoder);
    if (decoderResult != MA_SUCCESS) throw std::runtime_error(std::string("Input audio could not be decoded: ") + ma_result_description(decoderResult));

    ma_uint64 sourceFrames{};
    const auto lengthResult = ma_decoder_get_length_in_pcm_frames(&decoder, &sourceFrames);
    if (lengthResult != MA_SUCCESS || sourceFrames == 0) {
        ma_decoder_uninit(&decoder);
        throw std::runtime_error("Input audio has no decodable frames");
    }
    const auto sampleRate = decoder.outputSampleRate;
    PluginSession plugin(pluginPath);
    const auto parameterEvents = plugin.makeParameterEvents(parameterValues);
    ParameterEventList eventContext{&parameterEvents};
    const clap_input_events_t parameterInputEvents{&eventContext, parameterEventCount, parameterEventGet};
    plugin.activate(sampleRate);
    const auto totalFrames = sourceFrames + plugin.tailFrames(sampleRate);
    const auto maxFrames = (kMaxWavBytes - 44) / (kChannels * sizeof(std::int16_t));
    if (totalFrames > maxFrames) {
        ma_decoder_uninit(&decoder);
        throw std::runtime_error("Processed WAV would exceed the 256 MiB limit");
    }

    ma_encoder encoder{};
    const auto encoderConfig = ma_encoder_config_init(ma_encoding_format_wav, ma_format_s16, kChannels, sampleRate);
    const auto encoderResult = ma_encoder_init_file(outputPath.c_str(), &encoderConfig, &encoder);
    if (encoderResult != MA_SUCCESS) {
        ma_decoder_uninit(&decoder);
        throw std::runtime_error(std::string("Output WAV could not be created: ") + ma_result_description(encoderResult));
    }

    std::vector<float> interleaved(kBlockFrames * kChannels);
    std::vector<float> leftInput(kBlockFrames), rightInput(kBlockFrames), leftOutput(kBlockFrames), rightOutput(kBlockFrames);
    std::vector<std::int16_t> interleavedOutput(kBlockFrames * kChannels);
    ma_uint64 renderedFrames = 0;
    bool sendParameterEvents = !parameterEvents.empty();
    std::exception_ptr renderError;
    std::thread audioThread([&] {
      try {
        plugin.startProcessing();
        while (renderedFrames < totalFrames) {
            const auto frameCount = static_cast<ma_uint32>(std::min<ma_uint64>(kBlockFrames, totalFrames - renderedFrames));
            std::fill_n(interleaved.data(), static_cast<std::size_t>(frameCount) * kChannels, 0.0F);
            const auto inputFrames = renderedFrames < sourceFrames
                ? static_cast<ma_uint64>(std::min<ma_uint64>(frameCount, sourceFrames - renderedFrames))
                : 0;
            if (inputFrames > 0) {
                ma_uint64 framesRead{};
                const auto readResult = ma_decoder_read_pcm_frames(&decoder, interleaved.data(), inputFrames, &framesRead);
                if (readResult != MA_SUCCESS || framesRead != inputFrames) throw std::runtime_error("Input audio ended while rendering");
            }
            for (ma_uint32 frame = 0; frame < frameCount; ++frame) {
                leftInput[frame] = interleaved[frame * kChannels];
                rightInput[frame] = interleaved[frame * kChannels + 1];
            }
            std::fill_n(leftOutput.data(), frameCount, 0.0F);
            std::fill_n(rightOutput.data(), frameCount, 0.0F);
            const auto* inputEvents = sendParameterEvents ? &parameterInputEvents : &kEmptyInputEvents;
            if (!plugin.process(leftInput.data(), rightInput.data(), leftOutput.data(), rightOutput.data(), frameCount, static_cast<std::int64_t>(renderedFrames), inputEvents)) {
                throw std::runtime_error("CLAP effect returned a processing error");
            }
            sendParameterEvents = false;
            for (ma_uint32 frame = 0; frame < frameCount; ++frame) {
                const float left = std::clamp(leftOutput[frame], -1.0F, 1.0F);
                const float right = std::clamp(rightOutput[frame], -1.0F, 1.0F);
                interleavedOutput[frame * kChannels] = static_cast<std::int16_t>(left < 0.0F ? left * 32768.0F : left * 32767.0F);
                interleavedOutput[frame * kChannels + 1] = static_cast<std::int16_t>(right < 0.0F ? right * 32768.0F : right * 32767.0F);
            }
            ma_uint64 framesWritten{};
            const auto writeResult = ma_encoder_write_pcm_frames(&encoder, interleavedOutput.data(), frameCount, &framesWritten);
            if (writeResult != MA_SUCCESS || framesWritten != frameCount) throw std::runtime_error("Processed WAV could not be written");
            renderedFrames += frameCount;
        }
      } catch (...) {
        renderError = std::current_exception();
      }
      plugin.stopProcessing();
    });
    audioThread.join();
    if (renderError) {
        ma_encoder_uninit(&encoder);
        ma_decoder_uninit(&decoder);
        std::rethrow_exception(renderError);
    }
    ma_encoder_uninit(&encoder);
    ma_decoder_uninit(&decoder);
    std::cout << "{\"ok\":true,\"pluginName\":\"" << jsonEscape(plugin.name()) << "\",\"pluginId\":\"" << jsonEscape(plugin.id())
              << "\",\"sampleRate\":" << sampleRate
              << ",\"frames\":" << totalFrames << "}\n";
}

void serveRealtimePlugin(const std::string& pluginPath, const std::wstring_view mappingName, const DWORD parentProcessId) {
    HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, std::wstring(mappingName).c_str());
    if (mapping == nullptr) throw std::runtime_error("Realtime plugin shared memory could not be opened");
    auto* const transport = static_cast<sonora::plugin::SharedTransport*>(
        MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(sonora::plugin::SharedTransport)));
    if (transport == nullptr) {
        CloseHandle(mapping);
        throw std::runtime_error("Realtime plugin shared memory could not be mapped");
    }

    HANDLE parentProcess = nullptr;
    try {
        if (parentProcessId == 0) throw std::runtime_error("Realtime plugin parent process ID is invalid");
        parentProcess = OpenProcess(SYNCHRONIZE, FALSE, parentProcessId);
        if (parentProcess == nullptr) throw std::runtime_error("Realtime plugin parent process could not be monitored");
        if (transport->magic != sonora::plugin::SharedTransport::kMagic ||
            transport->version != sonora::plugin::SharedTransport::kVersion) {
            throw std::runtime_error("Realtime plugin transport version is incompatible");
        }
        PluginSession plugin(pluginPath);
        plugin.activate(48'000);
        std::exception_ptr processingError;
        std::thread audioThread([&] {
            try {
                plugin.startProcessing();
                transport->status.store(sonora::plugin::HostStatus::ready, std::memory_order_release);
                std::array<float, sonora::plugin::kPluginAudioBlockFrames> leftInput{};
                std::array<float, sonora::plugin::kPluginAudioBlockFrames> rightInput{};
                std::array<float, sonora::plugin::kPluginAudioBlockFrames> leftOutput{};
                std::array<float, sonora::plugin::kPluginAudioBlockFrames> rightOutput{};
                std::array<float, sonora::plugin::kPluginAudioBlockSamples> interleavedOutput{};
                sonora::plugin::AudioBlock block{};
                while (transport->status.load(std::memory_order_acquire) == sonora::plugin::HostStatus::ready &&
                       WaitForSingleObject(parentProcess, 0) == WAIT_TIMEOUT) {
                    if (!transport->input.tryPop(block)) {
                        Sleep(1);
                        continue;
                    }
                    if (block.frameCount == 0 || block.frameCount > sonora::plugin::kPluginAudioBlockFrames) {
                        throw std::runtime_error("Realtime plugin received an invalid audio block");
                    }
                    for (std::uint32_t frame = 0; frame < block.frameCount; ++frame) {
                        leftInput[frame] = block.samples[frame * 2];
                        rightInput[frame] = block.samples[frame * 2 + 1];
                    }
                    std::fill_n(leftOutput.data(), block.frameCount, 0.0F);
                    std::fill_n(rightOutput.data(), block.frameCount, 0.0F);
                    const auto steadyTime = static_cast<std::int64_t>(block.steadyTime);
                    if (!plugin.process(leftInput.data(), rightInput.data(), leftOutput.data(), rightOutput.data(),
                            block.frameCount, steadyTime, &kEmptyInputEvents)) {
                        throw std::runtime_error("CLAP effect returned a real-time processing error");
                    }
                    for (std::uint32_t frame = 0; frame < block.frameCount; ++frame) {
                        interleavedOutput[frame * 2] = leftOutput[frame];
                        interleavedOutput[frame * 2 + 1] = rightOutput[frame];
                    }
                    const auto output = std::span<const float>(interleavedOutput.data(),
                        static_cast<std::size_t>(block.frameCount) * sonora::plugin::kPluginAudioChannels);
                    if (!transport->output.tryPush(block.sequence, output, block.frameCount, block.projectFrame, block.steadyTime)) {
                        transport->outputOverruns.fetch_add(1, std::memory_order_relaxed);
                    }
                }
            } catch (...) {
                processingError = std::current_exception();
                transport->status.store(sonora::plugin::HostStatus::failed, std::memory_order_release);
            }
            plugin.stopProcessing();
        });

        while ((transport->status.load(std::memory_order_acquire) == sonora::plugin::HostStatus::starting ||
                transport->status.load(std::memory_order_acquire) == sonora::plugin::HostStatus::ready) &&
               WaitForSingleObject(parentProcess, 0) == WAIT_TIMEOUT) {
            Sleep(10);
        }
        if (WaitForSingleObject(parentProcess, 0) != WAIT_TIMEOUT) {
            transport->status.store(sonora::plugin::HostStatus::stopping, std::memory_order_release);
        }
        audioThread.join();
        if (processingError) std::rethrow_exception(processingError);
        if (transport->status.load(std::memory_order_acquire) == sonora::plugin::HostStatus::failed) {
            throw std::runtime_error("Realtime CLAP host failed");
        }
    } catch (...) {
        if (parentProcess != nullptr) CloseHandle(parentProcess);
        UnmapViewOfFile(transport);
        CloseHandle(mapping);
        throw;
    }
    if (parentProcess != nullptr) CloseHandle(parentProcess);
    UnmapViewOfFile(transport);
    CloseHandle(mapping);
}

void selfTestRealtimePluginProcess(const std::wstring_view pluginPath) {
    const std::wstring mappingName = L"Local\\SONORA_CLAP_TEST_" + std::to_wstring(GetCurrentProcessId()) +
        L"_" + std::to_wstring(GetTickCount64());
    HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
        static_cast<DWORD>(sizeof(sonora::plugin::SharedTransport)), mappingName.c_str());
    if (mapping == nullptr) throw std::runtime_error("Realtime plugin self-test mapping could not be created");
    auto* const transport = static_cast<sonora::plugin::SharedTransport*>(
        MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(sonora::plugin::SharedTransport)));
    if (transport == nullptr) {
        CloseHandle(mapping);
        throw std::runtime_error("Realtime plugin self-test mapping could not be mapped");
    }
    std::construct_at(transport);

    PROCESS_INFORMATION process{};
    auto cleanup = [&] {
        transport->status.store(sonora::plugin::HostStatus::stopping, std::memory_order_release);
        if (process.hProcess != nullptr) {
            if (WaitForSingleObject(process.hProcess, 5'000) == WAIT_TIMEOUT) {
                TerminateProcess(process.hProcess, 1);
                WaitForSingleObject(process.hProcess, 1'000);
            }
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
        UnmapViewOfFile(transport);
        CloseHandle(mapping);
    };
    try {
        std::array<wchar_t, 32'768> executable{};
        const auto executableLength = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
        if (executableLength == 0 || executableLength >= executable.size()) {
            throw std::runtime_error("Realtime plugin self-test could not locate its host executable");
        }
        std::wstring command = L"\"" + std::wstring(executable.data(), executableLength) + L"\" serve \"" +
            std::wstring(pluginPath) + L"\" \"" + mappingName + L"\" " + std::to_wstring(GetCurrentProcessId());
        std::vector<wchar_t> mutableCommand(command.begin(), command.end());
        mutableCommand.push_back(L'\0');
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        if (!CreateProcessW(nullptr, mutableCommand.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                nullptr, nullptr, &startup, &process)) {
            throw std::runtime_error("Realtime CLAP host process could not be started");
        }

        const auto deadline = GetTickCount64() + 5'000;
        while (transport->status.load(std::memory_order_acquire) != sonora::plugin::HostStatus::ready) {
            if (transport->status.load(std::memory_order_acquire) == sonora::plugin::HostStatus::failed ||
                WaitForSingleObject(process.hProcess, 0) == WAIT_OBJECT_0 || GetTickCount64() >= deadline) {
                throw std::runtime_error("Realtime CLAP host process did not become ready");
            }
            Sleep(5);
        }

        std::array<float, 64> input{};
        input.fill(0.8F);
        if (!transport->input.tryPush(7, input, 32)) throw std::runtime_error("Realtime CLAP self-test input block was rejected");
        sonora::plugin::AudioBlock output{};
        bool received = false;
        const auto outputDeadline = GetTickCount64() + 5'000;
        while (!received && GetTickCount64() < outputDeadline) {
            received = transport->output.tryPop(output);
            if (!received) Sleep(1);
        }
        if (!received || output.sequence != 7 || output.frameCount != 32 ||
            std::abs(output.samples[0] / input[0] - 0.5F) > 0.01F ||
            std::abs(output.samples[1] / input[1] - 0.5F) > 0.01F) {
            throw std::runtime_error("Realtime CLAP child did not process the shared stereo audio block correctly");
        }
        cleanup();
        std::cout << "{\"ok\":true,\"isolatedProcess\":true,\"frames\":32}\n";
    } catch (...) {
        cleanup();
        throw;
    }
}

[[nodiscard]] std::pair<uint32_t, double> parseParameterValue(const std::wstring_view argument) {
    const auto utf8 = wideToUtf8(std::wstring(argument).c_str());
    const auto separator = utf8.find('=');
    if (separator == std::string::npos || separator == 0 || separator + 1 >= utf8.size()) throw std::runtime_error("Parameter arguments must use id=value");
    uint32_t id{};
    const auto idResult = std::from_chars(utf8.data(), utf8.data() + separator, id);
    double value{};
    const auto valueResult = std::from_chars(utf8.data() + separator + 1, utf8.data() + utf8.size(), value, std::chars_format::general);
    if (idResult.ec != std::errc{} || idResult.ptr != utf8.data() + separator || valueResult.ec != std::errc{} ||
        valueResult.ptr != utf8.data() + utf8.size() || !std::isfinite(value)) {
        throw std::runtime_error("Parameter ID or value is invalid");
    }
    return {id, value};
}

} // namespace

int main() {
    int argumentCount{};
    wchar_t** wideArguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
    if (wideArguments == nullptr) {
        std::cerr << "Could not read Windows command line\n";
        return 2;
    }
    try {
        const std::wstring_view command(wideArguments[1]);
        if (command == L"inspect" && argumentCount == 3) {
            std::cout << inspectPlugin(wideToUtf8(wideArguments[2])) << '\n';
        } else if (command == L"serve" && argumentCount == 5) {
            serveRealtimePlugin(wideToUtf8(wideArguments[2]), wideArguments[3], static_cast<DWORD>(std::stoul(wideArguments[4])));
        } else if (command == L"selftest" && argumentCount == 3) {
            selfTestRealtimePluginProcess(wideArguments[2]);
        } else if (command == L"process" && argumentCount >= 5 && argumentCount <= 133) {
            std::vector<std::pair<uint32_t, double>> parameters;
            parameters.reserve(static_cast<std::size_t>(argumentCount - 5));
            for (int index = 5; index < argumentCount; ++index) parameters.push_back(parseParameterValue(wideArguments[index]));
            processWav(wideToUtf8(wideArguments[2]), wideToUtf8(wideArguments[3]), wideToUtf8(wideArguments[4]), parameters);
        } else {
            throw std::runtime_error("Usage: sonora-clap-offline.exe inspect <plugin.clap> | serve <plugin.clap> <shared-memory-name> <parent-pid> | selftest <plugin.clap> | process <plugin.clap> <input.wav> <output.wav> [id=value ...]");
        }
        LocalFree(wideArguments);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        LocalFree(wideArguments);
        return 1;
    }
}

