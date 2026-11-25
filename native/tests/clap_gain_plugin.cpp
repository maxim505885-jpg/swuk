#include <clap/clap.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

namespace {

struct GainPlugin {
    clap_plugin_t plugin{};
    const clap_host_t* host{};
    const clap_host_thread_check_t* threadCheck{};
    float gain{0.5F};
};

constexpr char kPluginId[] = "com.sonora.test.gain";
constexpr char kPluginName[] = "SONORA Test Gain";
constexpr char kPluginVendor[] = "SONORA Tests";
constexpr const char* kFeatures[]{CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, nullptr};
const clap_plugin_descriptor_t kDescriptor{
    CLAP_VERSION, kPluginId, kPluginName, kPluginVendor, "", "", "", "1.0.0", "Test-only stereo gain effect", kFeatures,
};

bool CLAP_ABI pluginInit(const clap_plugin_t*) { return true; }
void CLAP_ABI pluginDestroy(const clap_plugin_t* plugin) { delete static_cast<GainPlugin*>(plugin->plugin_data); }
bool CLAP_ABI pluginActivate(const clap_plugin_t*, double, uint32_t, uint32_t) { return true; }
void CLAP_ABI pluginDeactivate(const clap_plugin_t*) {}
bool CLAP_ABI pluginStart(const clap_plugin_t* plugin) {
    const auto* state = static_cast<const GainPlugin*>(plugin->plugin_data);
    return state->threadCheck != nullptr && state->threadCheck->is_main_thread != nullptr && state->threadCheck->is_audio_thread != nullptr &&
        !state->threadCheck->is_main_thread(state->host) && state->threadCheck->is_audio_thread(state->host);
}
void CLAP_ABI pluginStop(const clap_plugin_t*) {}
void CLAP_ABI pluginReset(const clap_plugin_t*) {}

clap_process_status CLAP_ABI pluginProcess(const clap_plugin_t* plugin, const clap_process_t* process) {
    auto* state = static_cast<GainPlugin*>(plugin->plugin_data);
    if (state->threadCheck == nullptr || state->threadCheck->is_main_thread == nullptr || state->threadCheck->is_audio_thread == nullptr ||
        state->threadCheck->is_main_thread(state->host) || !state->threadCheck->is_audio_thread(state->host)) {
        return CLAP_PROCESS_ERROR;
    }
    for (uint32_t index = 0; index < process->in_events->size(process->in_events); ++index) {
        const auto* header = process->in_events->get(process->in_events, index);
        if (header == nullptr || header->type != CLAP_EVENT_PARAM_VALUE || header->size != sizeof(clap_event_param_value_t)) continue;
        const auto* event = reinterpret_cast<const clap_event_param_value_t*>(header);
        if (event->param_id == 1) state->gain = static_cast<float>(event->value);
    }
    const auto* input = process->audio_inputs[0].data32;
    auto* output = process->audio_outputs[0].data32;
    for (std::uint32_t frame = 0; frame < process->frames_count; ++frame) {
        output[0][frame] = input[0][frame] * state->gain;
        output[1][frame] = input[1][frame] * state->gain;
    }
    return CLAP_PROCESS_CONTINUE;
}

uint32_t CLAP_ABI parameterCount(const clap_plugin_t*) { return 1; }
bool CLAP_ABI parameterInfo(const clap_plugin_t*, uint32_t index, clap_param_info_t* info) {
    if (index != 0 || info == nullptr) return false;
    *info = {};
    info->id = 1;
    info->flags = CLAP_PARAM_IS_AUTOMATABLE;
    std::strncpy(info->name, "Gain", sizeof(info->name) - 1);
    info->min_value = 0.0;
    info->max_value = 1.0;
    info->default_value = 0.5;
    return true;
}
bool CLAP_ABI parameterValue(const clap_plugin_t* plugin, clap_id id, double* value) {
    if (id != 1 || value == nullptr) return false;
    *value = static_cast<const GainPlugin*>(plugin->plugin_data)->gain;
    return true;
}
bool CLAP_ABI parameterValueText(const clap_plugin_t*, clap_id id, double value, char* output, uint32_t capacity) {
    if (id != 1 || output == nullptr || capacity == 0) return false;
    return std::snprintf(output, capacity, "%.2f", value) > 0;
}
bool CLAP_ABI parameterTextValue(const clap_plugin_t*, clap_id id, const char* text, double* value) {
    if (id != 1 || text == nullptr || value == nullptr) return false;
    *value = std::strtod(text, nullptr);
    return true;
}
void CLAP_ABI parameterFlush(const clap_plugin_t*, const clap_input_events_t*, const clap_output_events_t*) {}

uint32_t CLAP_ABI audioPortCount(const clap_plugin_t*, bool) { return 1; }

bool CLAP_ABI audioPortGet(const clap_plugin_t*, uint32_t index, bool isInput, clap_audio_port_info_t* info) {
    if (index != 0 || info == nullptr) return false;
    *info = {};
    info->id = isInput ? 1U : 2U;
    std::strncpy(info->name, isInput ? "Input" : "Output", sizeof(info->name) - 1);
    info->flags = CLAP_AUDIO_PORT_IS_MAIN;
    info->channel_count = 2;
    info->port_type = CLAP_PORT_STEREO;
    info->in_place_pair = isInput ? 2U : 1U;
    return true;
}

uint32_t CLAP_ABI tailFrames(const clap_plugin_t*) { return 256; }

const clap_plugin_audio_ports_t kAudioPorts{audioPortCount, audioPortGet};
const clap_plugin_tail_t kTail{tailFrames};
const clap_plugin_params_t kParams{parameterCount, parameterInfo, parameterValue, parameterValueText, parameterTextValue, parameterFlush};

const void* CLAP_ABI pluginExtension(const clap_plugin_t*, const char* extensionId) {
    if (extensionId == nullptr) return nullptr;
    if (std::strcmp(extensionId, CLAP_EXT_AUDIO_PORTS) == 0) return &kAudioPorts;
    if (std::strcmp(extensionId, CLAP_EXT_TAIL) == 0) return &kTail;
    if (std::strcmp(extensionId, CLAP_EXT_PARAMS) == 0) return &kParams;
    return nullptr;
}

void CLAP_ABI pluginMainThread(const clap_plugin_t*) {}

const clap_plugin_t* CLAP_ABI createPlugin(const clap_plugin_factory_t*, const clap_host_t* host, const char* pluginId) {
    if (pluginId == nullptr || std::strcmp(pluginId, kPluginId) != 0) return nullptr;
    auto* state = new (std::nothrow) GainPlugin{};
    if (state == nullptr) return nullptr;
    state->host = host;
    state->threadCheck = static_cast<const clap_host_thread_check_t*>(host->get_extension(host, CLAP_EXT_THREAD_CHECK));
    state->plugin = {
        &kDescriptor, state, pluginInit, pluginDestroy, pluginActivate, pluginDeactivate, pluginStart,
        pluginStop, pluginReset, pluginProcess, pluginExtension, pluginMainThread,
    };
    return &state->plugin;
}

uint32_t CLAP_ABI pluginCount(const clap_plugin_factory_t*) { return 1; }
const clap_plugin_descriptor_t* CLAP_ABI pluginDescriptor(const clap_plugin_factory_t*, uint32_t index) { return index == 0 ? &kDescriptor : nullptr; }
const clap_plugin_factory_t kFactory{pluginCount, pluginDescriptor, createPlugin};

bool CLAP_ABI entryInit(const char*) { return true; }
void CLAP_ABI entryDeinit() {}
const void* CLAP_ABI getFactory(const char* factoryId) {
    return factoryId != nullptr && std::strcmp(factoryId, CLAP_PLUGIN_FACTORY_ID) == 0 ? &kFactory : nullptr;
}

} // namespace

extern "C" CLAP_EXPORT const clap_plugin_entry_t clap_entry{CLAP_VERSION, entryInit, entryDeinit, getFactory};
