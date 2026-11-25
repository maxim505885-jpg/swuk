#include "realtime_plugin_transport.hpp"

#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"

#include <windows.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {

using sonora::plugin::AudioBlock;
using sonora::plugin::HostStatus;
using sonora::plugin::SharedTransport;
constexpr std::uint32_t kChannels = 2;
constexpr std::uint32_t kFrames = sonora::plugin::kPluginAudioBlockFrames;
constexpr std::uint32_t kSamples = kChannels * kFrames;

class Vst3StereoEffect final {
public:
    [[nodiscard]] bool initialize(const std::filesystem::path& path, std::string& error) {
        const auto pathText = path.u8string();
        const std::string modulePath(reinterpret_cast<const char*>(pathText.data()), pathText.size());
        module_ = VST3::Hosting::Module::create(modulePath, error);
        if (!module_) return false;

        auto factory = module_->getFactory();
        const auto classes = factory.classInfos();
        const auto selected = std::find_if(classes.begin(), classes.end(), [](const auto& info) {
            return info.category() == Steinberg::Vst::kVstAudioEffectClass;
        });
        if (selected == classes.end()) {
            error = "The VST3 bundle contains no audio-effect class";
            return false;
        }

        provider_ = std::make_unique<Steinberg::Vst::PlugProvider>(factory, *selected, true);
        if (!provider_->initialize()) {
            error = "The VST3 effect could not initialize with the SONORA host context";
            return false;
        }
        component_ = provider_->getComponentPtr();
        processor_ = Steinberg::U::cast<Steinberg::Vst::IAudioProcessor>(component_);
        if (!component_ || !processor_) {
            error = "The VST3 audio-effect class does not expose IAudioProcessor";
            return false;
        }
        if (processor_->canProcessSampleSize(Steinberg::Vst::kSample32) != Steinberg::kResultTrue) {
            error = "The VST3 effect does not support 32-bit floating-point audio";
            return false;
        }

        Steinberg::Vst::BusInfo inputInfo{};
        Steinberg::Vst::BusInfo outputInfo{};
        if (component_->getBusInfo(Steinberg::Vst::kAudio, Steinberg::Vst::kInput, 0, inputInfo) != Steinberg::kResultOk ||
            component_->getBusInfo(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput, 0, outputInfo) != Steinberg::kResultOk ||
            inputInfo.channelCount != static_cast<Steinberg::int32>(kChannels) ||
            outputInfo.channelCount != static_cast<Steinberg::int32>(kChannels)) {
            error = "The first VST3 audio buses must provide stereo input and output";
            return false;
        }
        if (component_->activateBus(Steinberg::Vst::kAudio, Steinberg::Vst::kInput, 0, true) != Steinberg::kResultOk ||
            component_->activateBus(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput, 0, true) != Steinberg::kResultOk) {
            error = "The VST3 effect rejected its stereo audio buses";
            return false;
        }

        Steinberg::Vst::ProcessSetup setup{};
        setup.processMode = Steinberg::Vst::kRealtime;
        setup.symbolicSampleSize = Steinberg::Vst::kSample32;
        setup.maxSamplesPerBlock = static_cast<Steinberg::int32>(kFrames);
        setup.sampleRate = 48'000.0;
        if (component_->setActive(true) != Steinberg::kResultOk) {
            error = "The VST3 effect could not be activated";
            return false;
        }
        active_ = true;
        if (processor_->setupProcessing(setup) != Steinberg::kResultOk) {
            error = "The VST3 effect rejected 48 kHz real-time processing";
            return false;
        }
        if (!processData_.prepare(*component_, static_cast<Steinberg::int32>(kFrames), Steinberg::Vst::kSample32)) {
            error = "Could not allocate the VST3 stereo process buffers";
            return false;
        }
        if (processor_->setProcessing(true) != Steinberg::kResultOk) {
            error = "The VST3 effect failed to enter processing state";
            return false;
        }
        processing_ = true;
        return true;
    }

    ~Vst3StereoEffect() {
        if (processing_ && processor_) (void)processor_->setProcessing(false);
        if (active_ && component_) (void)component_->setActive(false);
        processData_.unprepare();
    }

    [[nodiscard]] bool process(const AudioBlock& block, AudioBlock& output) noexcept {
        if (!processor_ || !processData_.inputs || !processData_.outputs ||
            processData_.numInputs < 1 || processData_.numOutputs < 1 ||
            block.frameCount == 0 || block.frameCount > kFrames) return false;

        auto& input = processData_.inputs[0];
        auto& result = processData_.outputs[0];
        if (input.numChannels != static_cast<Steinberg::int32>(kChannels) ||
            result.numChannels != static_cast<Steinberg::int32>(kChannels) ||
            input.channelBuffers32 == nullptr || result.channelBuffers32 == nullptr) return false;
        for (std::uint32_t frame = 0; frame < block.frameCount; ++frame) {
            input.channelBuffers32[0][frame] = block.samples[frame * kChannels];
            input.channelBuffers32[1][frame] = block.samples[frame * kChannels + 1];
        }
        input.silenceFlags = 0;
        result.silenceFlags = 0;
        processData_.processMode = Steinberg::Vst::kRealtime;
        processData_.symbolicSampleSize = Steinberg::Vst::kSample32;
        processData_.numSamples = static_cast<Steinberg::int32>(block.frameCount);
        processData_.processContext = &processContext_;
        processContext_ = {};
        processContext_.state = Steinberg::Vst::ProcessContext::kPlaying;
        processContext_.sampleRate = 48'000.0;
        processContext_.projectTimeSamples = static_cast<Steinberg::Vst::TSamples>(block.projectFrame);
        processContext_.continuousTimeSamples = static_cast<Steinberg::Vst::TSamples>(block.steadyTime);

        if (processor_->process(processData_) != Steinberg::kResultOk) return false;
        output = block;
        for (std::uint32_t frame = 0; frame < block.frameCount; ++frame) {
            output.samples[frame * kChannels] = result.channelBuffers32[0][frame];
            output.samples[frame * kChannels + 1] = result.channelBuffers32[1][frame];
        }
        return true;
    }

private:
    std::shared_ptr<VST3::Hosting::Module> module_;
    std::unique_ptr<Steinberg::Vst::PlugProvider> provider_;
    Steinberg::IPtr<Steinberg::Vst::IComponent> component_;
    Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor_;
    Steinberg::Vst::HostProcessData processData_;
    Steinberg::Vst::ProcessContext processContext_{};
    bool active_{};
    bool processing_{};
};

void serve(const std::filesystem::path& pluginPath, const std::wstring_view mappingName,
    const DWORD parentProcessId) {
    HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, std::wstring(mappingName).c_str());
    if (!mapping) throw std::runtime_error("Could not open the VST3 shared audio transport");
    auto* transport = static_cast<SharedTransport*>(
        MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedTransport)));
    if (!transport) {
        CloseHandle(mapping);
        throw std::runtime_error("Could not map the VST3 shared audio transport");
    }

    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentProcessId);
    if (!parent) {
        UnmapViewOfFile(transport);
        CloseHandle(mapping);
        throw std::runtime_error("Could not monitor the SONORA audio engine process");
    }

    try {
        if (transport->magic != SharedTransport::kMagic || transport->version != SharedTransport::kVersion) {
            throw std::runtime_error("The VST3 host transport version does not match");
        }

        Steinberg::Vst::HostApplication hostApplication;
        Steinberg::Vst::PluginContextFactory::instance().setPluginContext(&hostApplication);
        Vst3StereoEffect effect;
        std::string error;
        if (!effect.initialize(pluginPath, error)) throw std::runtime_error(error);
        transport->status.store(HostStatus::ready, std::memory_order_release);

        while (transport->status.load(std::memory_order_acquire) != HostStatus::stopping &&
            WaitForSingleObject(parent, 0) == WAIT_TIMEOUT) {
            AudioBlock input{};
            if (!transport->input.tryPop(input)) {
                Sleep(1);
                continue;
            }
            AudioBlock output{};
            if (!effect.process(input, output)) {
                transport->status.store(HostStatus::failed, std::memory_order_release);
                throw std::runtime_error("The VST3 effect failed while processing an audio block");
            }
            if (!transport->output.tryPush(output.sequence,
                    std::span<const float>(output.samples.data(),
                        static_cast<std::size_t>(output.frameCount) * kChannels),
                    output.frameCount, output.projectFrame, output.steadyTime)) {
                transport->outputOverruns.fetch_add(1, std::memory_order_relaxed);
            }
        }
    } catch (...) {
        CloseHandle(parent);
        UnmapViewOfFile(transport);
        CloseHandle(mapping);
        throw;
    }
    transport->status.store(HostStatus::stopping, std::memory_order_release);
    CloseHandle(parent);
    UnmapViewOfFile(transport);
    CloseHandle(mapping);
}

} // namespace

int wmain(const int argc, wchar_t** argv) {
    try {
        if (argc != 5 || std::wstring_view(argv[1]) != L"serve") {
            std::wcerr << L"Usage: sonora-vst3-host.exe serve <plugin.vst3> <shared-memory-name> <parent-pid>\n";
            return 2;
        }

        const std::filesystem::path pluginPath(argv[2]);
        std::error_code pathError;
        if (!pluginPath.is_absolute() || !std::filesystem::is_directory(pluginPath, pathError) ||
            pathError || pluginPath.extension() != L".vst3") {
            throw std::runtime_error("Select an absolute local .vst3 bundle directory");
        }
        serve(pluginPath, argv[3], static_cast<DWORD>(std::stoul(argv[4])));
    } catch (const std::exception& error) {
        std::cerr << "VST3 host: " << error.what() << '\n';
        return 1;
    }
    return 0;
}
