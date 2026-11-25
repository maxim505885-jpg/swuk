#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"
#include <windows.h>
#include <psapi.h>

#include "engine_core.hpp"
#include "capture_wav_recorder.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {

static_assert(std::atomic<float>::is_always_lock_free, "The audio callback requires lock-free float atomics");
static_assert(std::atomic<ma_uint32>::is_always_lock_free, "The audio callback requires lock-free frame counters");

constexpr ma_uint32 kSampleRate = 48'000;
constexpr ma_uint32 kOutputChannels = 2;
constexpr std::size_t kMaxCommandBytes = 1024 * 1024;
constexpr std::uint64_t kMaxStagedAssetBytes = 256ULL * 1024ULL * 1024ULL;
constexpr std::uint64_t kMaxStagedProjectBytes = 1024ULL * 1024ULL * 1024ULL;
constexpr std::size_t kMaxProjectTracks = 128;
constexpr std::size_t kMaxProjectClips = 8192;

[[nodiscard]] std::string errorJson(std::string_view message);

[[nodiscard]] std::optional<bool> booleanField(const std::string_view json, const std::string_view key) {
    const std::string keyToken = "\"" + std::string(key) + "\"";
    const auto keyPosition = json.find(keyToken);
    if (keyPosition == std::string_view::npos) return std::nullopt;
    auto cursor = json.find(':', keyPosition + keyToken.size());
    if (cursor == std::string_view::npos) return std::nullopt;
    ++cursor;
    while (cursor < json.size() && (json[cursor] == ' ' || json[cursor] == '\t' || json[cursor] == '\r' || json[cursor] == '\n')) ++cursor;
    if (json.substr(cursor, 4) == "true") return true;
    if (json.substr(cursor, 5) == "false") return false;
    return std::nullopt;
}

struct OwnedPcmAsset {
    std::vector<float> samples;
    sonora::audio::PcmSourceView view;
};

struct ProjectSnapshot {
    std::vector<sonora::audio::TrackMixSettings> tracks;
    std::vector<sonora::audio::AudioClipView> clips;
    sonora::audio::ProjectMixView view;
    std::uint64_t durationFrames{};
};

[[nodiscard]] std::optional<std::string> stringField(const std::string_view json, const std::string_view key) {
    const std::string keyToken = "\"" + std::string(key) + "\"";
    const auto keyPosition = json.find(keyToken);
    if (keyPosition == std::string_view::npos) return std::nullopt;
    auto cursor = json.find(':', keyPosition + keyToken.size());
    if (cursor == std::string_view::npos) return std::nullopt;
    ++cursor;
    while (cursor < json.size() && (json[cursor] == ' ' || json[cursor] == '\t' || json[cursor] == '\r' || json[cursor] == '\n')) ++cursor;
    if (cursor >= json.size() || json[cursor] != '"') return std::nullopt;
    ++cursor;

    std::string value;
    while (cursor < json.size()) {
        const char character = json[cursor++];
        if (character == '"') return value;
        if (character == '\\') {
            if (cursor >= json.size()) return std::nullopt;
            const char escaped = json[cursor++];
            switch (escaped) {
                case '"': value.push_back('"'); break;
                case '\\': value.push_back('\\'); break;
                case '/': value.push_back('/'); break;
                case 'b': value.push_back('\b'); break;
                case 'f': value.push_back('\f'); break;
                case 'n': value.push_back('\n'); break;
                case 'r': value.push_back('\r'); break;
                case 't': value.push_back('\t'); break;
                default: return std::nullopt;
            }
        } else {
            if (static_cast<unsigned char>(character) < 0x20U) return std::nullopt;
            value.push_back(character);
        }
    }
    return std::nullopt;
}

template <typename Number>
[[nodiscard]] std::optional<Number> numberField(const std::string_view json, const std::string_view key) {
    const std::string keyToken = "\"" + std::string(key) + "\"";
    const auto keyPosition = json.find(keyToken);
    if (keyPosition == std::string_view::npos) return std::nullopt;
    auto cursor = json.find(':', keyPosition + keyToken.size());
    if (cursor == std::string_view::npos) return std::nullopt;
    ++cursor;
    while (cursor < json.size() && (json[cursor] == ' ' || json[cursor] == '\t' || json[cursor] == '\r' || json[cursor] == '\n')) ++cursor;
    const auto end = json.find_first_of(",} \t\r\n", cursor);
    const auto token = json.substr(cursor, (end == std::string_view::npos ? json.size() : end) - cursor);
    if (token.empty()) return std::nullopt;
    Number value{};
    const auto [parsedEnd, error] = std::from_chars(token.data(), token.data() + token.size(), value);
    if (error != std::errc{} || parsedEnd != token.data() + token.size()) return std::nullopt;
    return value;
}

[[nodiscard]] std::optional<std::vector<double>> numberArrayField(
    const std::string_view json,
    const std::string_view key,
    const std::size_t maximumValues) {
    const std::string keyToken = "\"" + std::string(key) + "\"";
    const auto keyPosition = json.find(keyToken);
    if (keyPosition == std::string_view::npos) return std::nullopt;
    auto cursor = json.find(':', keyPosition + keyToken.size());
    if (cursor == std::string_view::npos) return std::nullopt;
    ++cursor;
    const auto skipWhitespace = [&]() {
        while (cursor < json.size() && (json[cursor] == ' ' || json[cursor] == '\t' || json[cursor] == '\r' || json[cursor] == '\n')) ++cursor;
    };
    skipWhitespace();
    if (cursor >= json.size() || json[cursor++] != '[') return std::nullopt;
    std::vector<double> values;
    while (cursor < json.size()) {
        skipWhitespace();
        if (cursor < json.size() && json[cursor] == ']') return values;
        if (values.size() >= maximumValues) return std::nullopt;
        const auto tokenEnd = json.find_first_of(",] \t\r\n", cursor);
        const auto end = tokenEnd == std::string_view::npos ? json.size() : tokenEnd;
        if (end == cursor) return std::nullopt;
        double value{};
        const auto [parsedEnd, error] = std::from_chars(json.data() + cursor, json.data() + end, value);
        if (error != std::errc{} || parsedEnd != json.data() + end || !std::isfinite(value)) return std::nullopt;
        values.push_back(value);
        cursor = end;
        skipWhitespace();
        if (cursor >= json.size()) return std::nullopt;
        if (json[cursor] == ']') return values;
        if (json[cursor++] != ',') return std::nullopt;
    }
    return std::nullopt;
}

[[nodiscard]] std::optional<std::vector<sonora::audio::AutomationPoint>> parseGainAutomation(const std::vector<double>& values) {
    constexpr double kMaxSafeFrame = 9'007'199'254'740'991.0;
    if (values.size() % 2 != 0 || values.size() > 16'384) return std::nullopt;
    std::vector<sonora::audio::AutomationPoint> points;
    points.reserve(values.size() / 2);
    for (std::size_t index = 0; index < values.size(); index += 2) {
        const double frame = values[index];
        const double value = values[index + 1];
        if (frame < 0.0 || frame > kMaxSafeFrame || std::trunc(frame) != frame || value < 0.0 || value > 4.0 ||
            (!points.empty() && frame <= static_cast<double>(points.back().frame))) return std::nullopt;
        points.push_back({static_cast<std::uint64_t>(frame), static_cast<float>(value)});
    }
    return points;
}

[[nodiscard]] std::string jsonEscape(const std::string_view text) {
    std::string escaped;
    escaped.reserve(text.size() + 8);
    for (const unsigned char character : text) {
        switch (character) {
            case '"': escaped += "\\\""; break;
            case '\\': escaped += "\\\\"; break;
            case '\b': escaped += "\\b"; break;
            case '\f': escaped += "\\f"; break;
            case '\n': escaped += "\\n"; break;
            case '\r': escaped += "\\r"; break;
            case '\t': escaped += "\\t"; break;
            default:
                if (character >= 0x20U) escaped.push_back(static_cast<char>(character));
                break;
        }
    }
    return escaped;
}

class AudioHost final {
public:
    AudioHost() {
        constexpr ma_backend backends[]{ma_backend_wasapi};
        const ma_result result = ma_context_init(backends, 1, nullptr, &context_);
        if (result != MA_SUCCESS) throw std::runtime_error(std::string("WASAPI initialization failed: ") + ma_result_description(result));
        contextInitialized_ = true;
        refreshDevices();
    }

    ~AudioHost() {
        (void)stopCapture();
        stop();
        if (contextInitialized_) ma_context_uninit(&context_);
    }

    AudioHost(const AudioHost&) = delete;
    AudioHost& operator=(const AudioHost&) = delete;

    [[nodiscard]] std::string devicesJson() {
        refreshDevices();
        std::string response = "{\"version\":1,\"ok\":true,\"devices\":{\"playback\":";
        appendDevices(response, playbackDevices_);
        response += ",\"capture\":";
        appendDevices(response, captureDevices_);
        response += "}}";
        return response;
    }

    [[nodiscard]] std::string statusJson() const {
        const bool playing = remainingToneFrames_.load(std::memory_order_relaxed) > 0 || projectPlaying_.load(std::memory_order_relaxed);
        const auto* const project = activeProject_.load(std::memory_order_acquire);
        std::string response = std::string("{\"version\":1,\"ok\":true,\"status\":{\"playing\":") +
            (playing ? "true" : "false") +
            ",\"deviceOpen\":" + (deviceInitialized_ ? "true" : "false") + ",\"sampleRate\":" + std::to_string(kSampleRate) +
            ",\"playheadFrame\":" + std::to_string(projectFrame_.load(std::memory_order_relaxed)) +
            ",\"peak\":" + std::to_string(projectPeak_.load(std::memory_order_relaxed)) +
            ",\"trackPeaks\":[";
        if (project != nullptr) {
            for (std::size_t trackIndex = 0; trackIndex < project->view.trackCount; ++trackIndex) {
                if (trackIndex != 0) response.push_back(',');
                response += std::to_string(trackPeaks_[trackIndex].load(std::memory_order_relaxed));
            }
        }
        response += "],\"backend\":\"WASAPI shared\"}}";
        return response;
    }

    [[nodiscard]] std::string diagnosticsJson() const {
        PROCESS_MEMORY_COUNTERS_EX counters{};
        counters.cb = sizeof(counters);
        if (GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters), sizeof(counters)) == 0) {
            return errorJson("Native process memory diagnostics are unavailable");
        }
        return "{\"version\":1,\"ok\":true,\"diagnostics\":{\"workingSetBytes\":" +
            std::to_string(counters.WorkingSetSize) + ",\"peakWorkingSetBytes\":" +
            std::to_string(counters.PeakWorkingSetSize) + ",\"privateBytes\":" +
            std::to_string(counters.PrivateUsage) + "}}";
    }

    [[nodiscard]] std::string clearProject() {
        projectPlaying_.store(false, std::memory_order_relaxed);
        projectFrame_.store(0, std::memory_order_relaxed);
        activeProject_.store(nullptr, std::memory_order_release);
        builderTracks_.clear();
        builderClips_.clear();
        builderMasterGain_ = 1.0F;
        return "{\"version\":1,\"ok\":true}";
    }

    [[nodiscard]] std::string loadAsset(const std::string& id, const std::string& path) {
        if (id.empty() || id.size() > 128 || path.empty()) return errorJson("Asset id or path is invalid");
        if (assets_.contains(id)) return errorJson("Asset id has already been loaded");
        if (totalAssetBytes_ >= kMaxStagedProjectBytes) return errorJson("Project audio cache exceeds 1 GiB");

        ma_decoder decoder{};
        const auto decoderConfig = ma_decoder_config_init(ma_format_f32, kOutputChannels, kSampleRate);
        const ma_result initResult = ma_decoder_init_file(path.c_str(), &decoderConfig, &decoder);
        if (initResult != MA_SUCCESS) return errorJson(std::string("Audio asset could not be decoded: ") + ma_result_description(initResult));

        ma_uint64 frameCount = 0;
        const ma_result lengthResult = ma_decoder_get_length_in_pcm_frames(&decoder, &frameCount);
        if (lengthResult != MA_SUCCESS || frameCount == 0 || frameCount > std::numeric_limits<std::size_t>::max() / (kOutputChannels * sizeof(float))) {
            ma_decoder_uninit(&decoder);
            return errorJson("Audio asset has an invalid or unsupported duration");
        }
        const auto byteCount = frameCount * kOutputChannels * sizeof(float);
        if (byteCount > kMaxStagedAssetBytes || byteCount > kMaxStagedProjectBytes - totalAssetBytes_) {
            ma_decoder_uninit(&decoder);
            return errorJson("Decoded project audio exceeds the native engine memory limit");
        }

        auto asset = std::make_unique<OwnedPcmAsset>();
        try {
            asset->samples.resize(static_cast<std::size_t>(frameCount) * kOutputChannels);
        } catch (...) {
            ma_decoder_uninit(&decoder);
            throw;
        }
        ma_uint64 framesRead = 0;
        const ma_result readResult = ma_decoder_read_pcm_frames(&decoder, asset->samples.data(), frameCount, &framesRead);
        ma_decoder_uninit(&decoder);
        if (readResult != MA_SUCCESS || framesRead != frameCount) return errorJson("Audio asset ended before the decoder's reported duration");

        asset->view = {asset->samples.data(), static_cast<std::size_t>(frameCount), kOutputChannels, static_cast<double>(kSampleRate)};
        assets_.emplace(id, std::move(asset));
        totalAssetBytes_ += byteCount;
        return "{\"version\":1,\"ok\":true,\"frames\":" + std::to_string(frameCount) + "}";
    }

    [[nodiscard]] std::string setProjectMix(const float masterGain) {
        if (!std::isfinite(masterGain) || masterGain < 0.0F || masterGain > 4.0F) return errorJson("Master gain must be between 0 and 4");
        builderMasterGain_ = masterGain;
        return "{\"version\":1,\"ok\":true}";
    }

    [[nodiscard]] std::string setTrackMix(
        const std::uint32_t index,
        const float gain,
        const float pan,
        const bool mute,
        const bool solo,
        const bool reverb,
        const bool delay,
        std::vector<sonora::audio::AutomationPoint> gainAutomation = {},
        const bool equalizer = false,
        const float equalizerFrequencyHz = 1000.0F,
        const float equalizerGainDb = 0.0F,
        const float equalizerQ = 1.0F,
        const std::array<sonora::audio::EqualizerBandSettings, sonora::audio::kEqualizerBandCount> equalizerBands = sonora::audio::kDefaultEqualizerBands) {
        if (index >= kMaxProjectTracks) return errorJson("Track index exceeds the project limit");
        if (!std::isfinite(gain) || gain < 0.0F || gain > 4.0F || !std::isfinite(pan) || pan < -1.0F || pan > 1.0F) {
            return errorJson("Track mix values are outside the supported range");
        }
        if (builderTracks_.size() <= index) builderTracks_.resize(static_cast<std::size_t>(index) + 1);
        builderTracks_[index] = {gain, pan, mute, solo, reverb, delay, std::move(gainAutomation), equalizer, equalizerFrequencyHz, equalizerGainDb, equalizerQ};
        builderTracks_[index].equalizerBands = equalizerBands;
        return "{\"version\":1,\"ok\":true}";
    }

    [[nodiscard]] std::string addProjectClip(
        const std::string& assetId,
        const std::uint32_t trackIndex,
        const std::uint64_t startFrame,
        const std::uint64_t sourceOffsetFrame,
        const std::uint64_t durationFrames,
        const double playbackRate,
        const float gain,
        const float pan,
        const std::uint64_t fadeInFrames,
        const std::uint64_t fadeOutFrames) {
        if (builderClips_.size() >= kMaxProjectClips) return errorJson("Project exceeds the native clip limit");
        if (trackIndex >= builderTracks_.size()) return errorJson("Clip references an unknown track");
        const auto asset = assets_.find(assetId);
        if (asset == assets_.end()) return errorJson("Clip references an unloaded audio asset");
        if (fadeInFrames > durationFrames || fadeOutFrames > durationFrames || fadeInFrames > durationFrames - fadeOutFrames) {
            return errorJson("Clip fades exceed its duration");
        }
        builderClips_.push_back({&asset->second->view, trackIndex, startFrame, sourceOffsetFrame, durationFrames, playbackRate, gain, pan, fadeInFrames, fadeOutFrames});
        return "{\"version\":1,\"ok\":true}";
    }

    [[nodiscard]] std::string commitProject() {
        if (builderTracks_.empty()) return errorJson("Project must contain at least one track");
        auto snapshot = std::make_unique<ProjectSnapshot>();
        snapshot->tracks = builderTracks_;
        snapshot->clips = builderClips_;
        snapshot->view = {snapshot->tracks.data(), snapshot->tracks.size(), snapshot->clips.data(), snapshot->clips.size(), builderMasterGain_};
        for (const auto& clip : snapshot->clips) {
            snapshot->durationFrames = std::max(snapshot->durationFrames, clip.startFrame + clip.durationFrames);
        }
        const bool hasEffectClips = std::any_of(snapshot->clips.begin(), snapshot->clips.end(), [&](const auto& clip) {
            const auto& track = snapshot->tracks[clip.trackIndex];
            return track.reverb || track.delay;
        });
        if (hasEffectClips) snapshot->durationFrames += 3ULL * kSampleRate;
        auto mixState = std::make_unique<sonora::audio::ProjectMixState>();
        if (!sonora::audio::configureProjectMixState(*mixState, snapshot->view)) return errorJson("Project effects could not be prepared");
        float probe[2]{};
        if (!sonora::audio::renderMixBlock(probe, 1, kSampleRate, 0, snapshot->view, mixState.get())) return errorJson("Project mixer graph is invalid");

        projectPlaying_.store(false, std::memory_order_relaxed);
        if (deviceInitialized_ && deviceStarted_) {
            const ma_result stopResult = ma_device_stop(&device_);
            if (stopResult != MA_SUCCESS) return errorJson(std::string("Could not pause WASAPI while committing project: ") + ma_result_description(stopResult));
            deviceStarted_ = false;
        }
        projectFrame_.store(0, std::memory_order_relaxed);
        projectPeak_.store(0.0F, std::memory_order_relaxed);
        clearTrackPeaks();
        projectMixState_ = std::move(mixState);
        activeProject_.store(nullptr, std::memory_order_release);
        projectSnapshot_ = std::move(snapshot);
        const auto* const published = projectSnapshot_.get();
        activeProject_.store(published, std::memory_order_release);
        std::unordered_set<const sonora::audio::PcmSourceView*> retainedSources;
        retainedSources.reserve(projectSnapshot_->clips.size());
        for (const auto& clip : projectSnapshot_->clips) retainedSources.insert(clip.source);
        for (auto asset = assets_.begin(); asset != assets_.end();) {
            if (retainedSources.contains(&asset->second->view)) {
                ++asset;
                continue;
            }
            const auto releasedBytes = asset->second->samples.size() * sizeof(float);
            totalAssetBytes_ -= static_cast<std::uint64_t>(releasedBytes);
            asset = assets_.erase(asset);
        }
        return "{\"version\":1,\"ok\":true,\"durationFrames\":" + std::to_string(projectSnapshot_->durationFrames) +
            ",\"loadedAssets\":" + std::to_string(assets_.size()) + ",\"decodedBytes\":" + std::to_string(totalAssetBytes_) + "}";
    }

    [[nodiscard]] std::string playProject(const std::uint32_t deviceIndex, const std::uint64_t startFrame) {
        const auto* const project = activeProject_.load(std::memory_order_acquire);
        if (project == nullptr) return errorJson("No project mixer graph is loaded");
        if (startFrame > project->durationFrames) return errorJson("startFrame is outside the project duration");
        if (deviceIndex > 128) return errorJson("deviceIndex is outside the playback device list");
        if (deviceInitialized_ && selectedOutputDeviceIndex_ != deviceIndex) stop();
        if (!deviceInitialized_) {
            const auto opened = openPlaybackDevice(deviceIndex);
            if (!opened.empty()) return errorJson(opened);
        }
        projectFrame_.store(startFrame == project->durationFrames ? 0 : startFrame, std::memory_order_relaxed);
        if (projectMixState_) sonora::audio::resetProjectMixState(*projectMixState_);
        remainingToneFrames_.store(0, std::memory_order_relaxed);
        projectPeak_.store(0.0F, std::memory_order_relaxed);
        if (!deviceStarted_) {
            const ma_result result = ma_device_start(&device_);
            if (result != MA_SUCCESS) return errorJson(std::string("WASAPI playback could not start: ") + ma_result_description(result));
            deviceStarted_ = true;
        }
        projectPlaying_.store(true, std::memory_order_release);
        return statusJson();
    }

    [[nodiscard]] std::string pauseProject() {
        projectPlaying_.store(false, std::memory_order_release);
        return statusJson();
    }

    [[nodiscard]] std::string stopProject() {
        projectPlaying_.store(false, std::memory_order_release);
        projectFrame_.store(0, std::memory_order_relaxed);
        return statusJson();
    }

    [[nodiscard]] std::string playTestTone(const double frequencyHz, const double gain, const std::uint32_t deviceIndex) {
        if (!std::isfinite(frequencyHz) || frequencyHz < 20.0 || frequencyHz >= static_cast<double>(kSampleRate) * 0.5 ||
            !std::isfinite(gain) || gain <= 0.0 || gain > 0.5) {
            return errorJson("frequencyHz must be at least 20 Hz and below 24000 Hz; gain must be greater than 0 and at most 0.5");
        }
        refreshDevices();
        if (playbackDevices_.empty()) return errorJson("No WASAPI playback devices are available");
        if (deviceIndex >= playbackDevices_.size()) return errorJson("deviceIndex is outside the playback device list");
        stop();

        frequencyHz_.store(static_cast<float>(frequencyHz), std::memory_order_relaxed);
        gain_.store(static_cast<float>(gain), std::memory_order_relaxed);
        phase_ = 0.0;
        remainingToneFrames_.store(kSampleRate / 2, std::memory_order_relaxed);

        ma_device_config config = ma_device_config_init(ma_device_type_playback);
        config.playback.pDeviceID = &playbackDevices_[deviceIndex].id;
        config.playback.format = ma_format_f32;
        config.playback.channels = kOutputChannels;
        config.sampleRate = kSampleRate;
        config.periodSizeInMilliseconds = 10;
        config.performanceProfile = ma_performance_profile_low_latency;
        config.playback.shareMode = ma_share_mode_shared;
        config.dataCallback = dataCallback;
        config.pUserData = this;

        ma_result result = ma_device_init(&context_, &config, &device_);
        if (result != MA_SUCCESS) return errorJson(std::string("Playback device initialization failed: ") + ma_result_description(result));
        deviceInitialized_ = true;
        result = ma_device_start(&device_);
        if (result != MA_SUCCESS) {
            remainingToneFrames_.store(0, std::memory_order_relaxed);
            stop();
            return errorJson(std::string("Playback device start failed: ") + ma_result_description(result));
        }
        deviceStarted_ = true;
        selectedOutputDeviceIndex_ = deviceIndex;
        return statusJson();
    }

    [[nodiscard]] std::string stopJson() {
        stop();
        return statusJson();
    }

    [[nodiscard]] std::string startCapture(
        const std::uint32_t deviceIndex,
        const std::uint32_t sampleRate,
        const std::string& channelMode,
        const std::string& path) {
        if (captureDeviceInitialized_ || captureRecorder_) return errorJson("A WASAPI recording is already active");
        if (sampleRate != 44'100 && sampleRate != 48'000 && sampleRate != 96'000) return errorJson("Capture sample rate must be 44100, 48000 or 96000 Hz");
        if (path.empty() || std::filesystem::path(path).extension() != ".wav") return errorJson("Capture path must point to a WAV file");

        if (channelMode == "mono") captureChannelMode_ = sonora::audio::CaptureChannelMode::Mono;
        else if (channelMode == "left") captureChannelMode_ = sonora::audio::CaptureChannelMode::Left;
        else if (channelMode == "right") captureChannelMode_ = sonora::audio::CaptureChannelMode::Right;
        else if (channelMode == "stereo") captureChannelMode_ = sonora::audio::CaptureChannelMode::Stereo;
        else return errorJson("Unsupported capture channel mode");

        refreshDevices();
        if (captureDevices_.empty()) return errorJson("No WASAPI capture devices are available");
        if (deviceIndex >= captureDevices_.size()) return errorJson("Capture device index is outside the device list");

        const auto channels = captureChannelMode_ == sonora::audio::CaptureChannelMode::Stereo ? 2U : 1U;
        captureSampleRate_ = sampleRate;
        captureRecorder_ = std::make_unique<sonora::audio::CaptureWavRecorder>(path, channels, sampleRate);
        if (!captureRecorder_->ready()) {
            captureRecorder_.reset();
            return errorJson("Could not create the native capture WAV file");
        }

        ma_device_config config = ma_device_config_init(ma_device_type_capture);
        config.capture.pDeviceID = &captureDevices_[deviceIndex].id;
        config.capture.format = ma_format_f32;
        config.capture.channels = 2;
        config.sampleRate = sampleRate;
        config.periodSizeInMilliseconds = 10;
        config.performanceProfile = ma_performance_profile_low_latency;
        config.capture.shareMode = ma_share_mode_shared;
        config.dataCallback = captureDataCallback;
        config.pUserData = this;
        const ma_result initResult = ma_device_init(&context_, &config, &captureDevice_);
        if (initResult != MA_SUCCESS) {
            captureRecorder_->stop();
            captureRecorder_.reset();
            return errorJson(std::string("WASAPI capture device could not be opened: ") + ma_result_description(initResult));
        }
        captureDeviceInitialized_ = true;
        const ma_result startResult = ma_device_start(&captureDevice_);
        if (startResult != MA_SUCCESS) {
            ma_device_uninit(&captureDevice_);
            captureDeviceInitialized_ = false;
            captureRecorder_->stop();
            captureRecorder_.reset();
            return errorJson(std::string("WASAPI capture could not start: ") + ma_result_description(startResult));
        }
        captureDeviceStarted_ = true;
        return std::string("{\"version\":1,\"ok\":true,\"sampleRate\":") + std::to_string(sampleRate) +
            ",\"channels\":" + std::to_string(channels) + "}";
    }

    [[nodiscard]] std::string stopCapture() {
        if (!captureRecorder_) return errorJson("No WASAPI recording is active");
        if (captureDeviceInitialized_) {
            if (captureDeviceStarted_) (void)ma_device_stop(&captureDevice_);
            ma_device_uninit(&captureDevice_);
            captureDeviceInitialized_ = false;
            captureDeviceStarted_ = false;
        }
        captureRecorder_->stop();
        const auto frames = captureRecorder_->framesWritten();
        const auto droppedFrames = captureRecorder_->droppedFrames();
        const auto bytes = captureRecorder_->fileBytes();
        const auto writeError = captureRecorder_->writeError();
        const auto limitReached = captureRecorder_->limitReached();
        const auto sampleRate = captureSampleRate_;
        const auto channels = captureRecorder_->outputChannels();
        captureRecorder_.reset();
        if (writeError) return errorJson("Native capture could not finalize the WAV file");
        return std::string("{\"version\":1,\"ok\":true,\"frames\":") + std::to_string(frames) +
            ",\"bytes\":" + std::to_string(bytes) + ",\"droppedFrames\":" + std::to_string(droppedFrames) +
            ",\"limitReached\":" + (limitReached ? "true" : "false") + ",\"sampleRate\":" + std::to_string(sampleRate) +
            ",\"channels\":" + std::to_string(channels) + "}";
    }

private:
    void clearTrackPeaks() noexcept {
        for (auto& peak : trackPeaks_) peak.store(0.0F, std::memory_order_relaxed);
    }

    static void captureDataCallback(ma_device* device, void*, const void* input, const ma_uint32 frameCount) noexcept {
        auto* const host = static_cast<AudioHost*>(device->pUserData);
        if (host == nullptr || input == nullptr || !host->captureRecorder_) return;
        (void)host->captureRecorder_->push(
            static_cast<const float*>(input), frameCount, device->capture.channels, host->captureChannelMode_);
    }

    static void dataCallback(ma_device* device, void* output, const void*, const ma_uint32 frameCount) noexcept {
        auto* const host = static_cast<AudioHost*>(device->pUserData);
        if (host == nullptr || output == nullptr) return;
        const auto remainingFrames = host->remainingToneFrames_.load(std::memory_order_relaxed);
        if (remainingFrames > 0) {
            host->clearTrackPeaks();
            const auto framesToTone = std::min(frameCount, remainingFrames);
            const bool rendered = sonora::audio::renderSine(
                static_cast<float*>(output), framesToTone, device->playback.channels, device->sampleRate,
                host->frequencyHz_.load(std::memory_order_relaxed), host->gain_.load(std::memory_order_relaxed), host->phase_);
            if (!rendered) ma_silence_pcm_frames(output, frameCount, ma_format_f32, device->playback.channels);
            else if (framesToTone < frameCount) {
                auto* const remainder = static_cast<float*>(output) + static_cast<std::size_t>(framesToTone) * device->playback.channels;
                ma_silence_pcm_frames(remainder, frameCount - framesToTone, ma_format_f32, device->playback.channels);
            }
            host->remainingToneFrames_.store(remainingFrames - framesToTone, std::memory_order_relaxed);
            return;
        }

        const auto* const project = host->activeProject_.load(std::memory_order_acquire);
        if (!host->projectPlaying_.load(std::memory_order_acquire) || project == nullptr || device->playback.channels != 2) {
            host->projectPeak_.store(0.0F, std::memory_order_relaxed);
            host->clearTrackPeaks();
            ma_silence_pcm_frames(output, frameCount, ma_format_f32, device->playback.channels);
            return;
        }
        const auto firstFrame = host->projectFrame_.load(std::memory_order_relaxed);
        if (firstFrame >= project->durationFrames) {
            host->projectPlaying_.store(false, std::memory_order_release);
            host->projectPeak_.store(0.0F, std::memory_order_relaxed);
            host->clearTrackPeaks();
            ma_silence_pcm_frames(output, frameCount, ma_format_f32, device->playback.channels);
            return;
        }
        const auto remainingProjectFrames = project->durationFrames - firstFrame;
        const auto framesToRender = static_cast<std::size_t>(std::min<std::uint64_t>(frameCount, remainingProjectFrames));
        std::array<float, kMaxProjectTracks> trackPeaks{};
        const bool rendered = sonora::audio::renderMixBlock(
            static_cast<float*>(output), framesToRender, device->sampleRate, firstFrame, project->view,
            host->projectMixState_.get(), trackPeaks.data(), project->view.trackCount);
        if (!rendered) {
            host->projectPlaying_.store(false, std::memory_order_release);
            host->projectPeak_.store(0.0F, std::memory_order_relaxed);
            host->clearTrackPeaks();
            ma_silence_pcm_frames(output, frameCount, ma_format_f32, device->playback.channels);
            return;
        }
        if (framesToRender < frameCount) {
            auto* const remainder = static_cast<float*>(output) + framesToRender * device->playback.channels;
            ma_silence_pcm_frames(remainder, frameCount - framesToRender, ma_format_f32, device->playback.channels);
        }
        const auto nextFrame = firstFrame + framesToRender;
        float peak = 0.0F;
        const auto* const stereoOutput = static_cast<const float*>(output);
        for (std::size_t sampleIndex = 0; sampleIndex < framesToRender * device->playback.channels; ++sampleIndex) {
            peak = std::max(peak, std::abs(stereoOutput[sampleIndex]));
        }
        host->projectPeak_.store(peak, std::memory_order_relaxed);
        for (std::size_t trackIndex = 0; trackIndex < kMaxProjectTracks; ++trackIndex) {
            host->trackPeaks_[trackIndex].store(
                trackIndex < project->view.trackCount ? trackPeaks[trackIndex] : 0.0F,
                std::memory_order_relaxed);
        }
        host->projectFrame_.store(nextFrame, std::memory_order_relaxed);
        if (nextFrame >= project->durationFrames) host->projectPlaying_.store(false, std::memory_order_release);
    }

    void stop() noexcept {
        projectPlaying_.store(false, std::memory_order_release);
        if (!deviceInitialized_) return;
        remainingToneFrames_.store(0, std::memory_order_relaxed);
        (void)ma_device_stop(&device_);
        remainingToneFrames_.store(0, std::memory_order_relaxed);
        ma_device_uninit(&device_);
        deviceInitialized_ = false;
        deviceStarted_ = false;
    }

    [[nodiscard]] std::string openPlaybackDevice(const std::uint32_t deviceIndex) {
        refreshDevices();
        if (playbackDevices_.empty()) return "No WASAPI playback devices are available";
        if (deviceIndex >= playbackDevices_.size()) return "deviceIndex is outside the playback device list";

        ma_device_config config = ma_device_config_init(ma_device_type_playback);
        config.playback.pDeviceID = &playbackDevices_[deviceIndex].id;
        config.playback.format = ma_format_f32;
        config.playback.channels = kOutputChannels;
        config.sampleRate = kSampleRate;
        config.periodSizeInMilliseconds = 10;
        config.performanceProfile = ma_performance_profile_low_latency;
        config.playback.shareMode = ma_share_mode_shared;
        config.dataCallback = dataCallback;
        config.pUserData = this;
        const ma_result result = ma_device_init(&context_, &config, &device_);
        if (result != MA_SUCCESS) return std::string("Playback device initialization failed: ") + ma_result_description(result);
        deviceInitialized_ = true;
        selectedOutputDeviceIndex_ = deviceIndex;
        return {};
    }

    void refreshDevices() {
        ma_device_info* playback = nullptr;
        ma_uint32 playbackCount = 0;
        ma_device_info* capture = nullptr;
        ma_uint32 captureCount = 0;
        const ma_result result = ma_context_get_devices(&context_, &playback, &playbackCount, &capture, &captureCount);
        if (result != MA_SUCCESS) throw std::runtime_error(std::string("WASAPI device enumeration failed: ") + ma_result_description(result));
        if (playbackCount == 0) playbackDevices_.clear();
        else playbackDevices_.assign(playback, playback + playbackCount);
        if (captureCount == 0) captureDevices_.clear();
        else captureDevices_.assign(capture, capture + captureCount);
    }

    static void appendDevices(std::string& output, const std::vector<ma_device_info>& devices) {
        output.push_back('[');
        for (std::size_t index = 0; index < devices.size(); ++index) {
            if (index != 0) output.push_back(',');
            output += "{\"index\":" + std::to_string(index) + ",\"name\":\"" +
                jsonEscape(devices[index].name) + "\",\"default\":" +
                (devices[index].isDefault ? "true" : "false") + "}";
        }
        output.push_back(']');
    }

    ma_context context_{};
    ma_device device_{};
    ma_device captureDevice_{};
    std::vector<ma_device_info> playbackDevices_;
    std::vector<ma_device_info> captureDevices_;
    std::unordered_map<std::string, std::unique_ptr<OwnedPcmAsset>> assets_;
    std::unique_ptr<ProjectSnapshot> projectSnapshot_;
    std::unique_ptr<sonora::audio::ProjectMixState> projectMixState_;
    std::unique_ptr<sonora::audio::CaptureWavRecorder> captureRecorder_;
    std::vector<sonora::audio::TrackMixSettings> builderTracks_;
    std::vector<sonora::audio::AudioClipView> builderClips_;
    std::atomic<const ProjectSnapshot*> activeProject_{nullptr};
    std::atomic<float> frequencyHz_{440.0F};
    std::atomic<float> gain_{0.1F};
    std::atomic<ma_uint32> remainingToneFrames_{0};
    std::atomic<bool> projectPlaying_{false};
    std::atomic<std::uint64_t> projectFrame_{0};
    std::atomic<float> projectPeak_{0.0F};
    std::array<std::atomic<float>, kMaxProjectTracks> trackPeaks_{};
    std::uint64_t totalAssetBytes_{};
    float builderMasterGain_{1.0F};
    double phase_{0.0};
    std::uint32_t selectedOutputDeviceIndex_{};
    sonora::audio::CaptureChannelMode captureChannelMode_{sonora::audio::CaptureChannelMode::Mono};
    std::uint32_t captureSampleRate_{kSampleRate};
    bool contextInitialized_{false};
    bool deviceInitialized_{false};
    bool deviceStarted_{false};
    bool captureDeviceInitialized_{false};
    bool captureDeviceStarted_{false};
};

[[nodiscard]] std::string errorJson(const std::string_view message) {
    return "{\"version\":1,\"ok\":false,\"error\":\"" + jsonEscape(message) + "\"}";
}

[[nodiscard]] std::string handleCommand(AudioHost& host, const std::string_view line, bool& shouldQuit) {
    const auto operation = stringField(line, "op");
    if (!operation) return errorJson("Missing or invalid string field: op");
    const auto version = numberField<std::uint32_t>(line, "version");
    if (!version) return errorJson("Missing or invalid protocol version");
    if (*version != sonora::audio::kProtocolVersion) {
        return errorJson("Unsupported protocol version");
    }
    if (*operation == "ping") return "{\"version\":1,\"ok\":true,\"engine\":\"SONORA Native Audio\"}";
    if (*operation == "devices") return host.devicesJson();
    if (*operation == "status") return host.statusJson();
    if (*operation == "diagnostics") return host.diagnosticsJson();
    if (*operation == "stop") return host.stopJson();
    if (*operation == "start_capture") {
        const auto deviceIndex = numberField<std::uint32_t>(line, "deviceIndex");
        const auto sampleRate = numberField<std::uint32_t>(line, "sampleRate");
        const auto channelMode = stringField(line, "channelMode");
        const auto path = stringField(line, "path");
        if (!deviceIndex || !sampleRate || !channelMode || !path) return errorJson("start_capture requires deviceIndex, sampleRate, channelMode and path");
        return host.startCapture(*deviceIndex, *sampleRate, *channelMode, *path);
    }
    if (*operation == "stop_capture") return host.stopCapture();
    if (*operation == "clear_project") return host.clearProject();
    if (*operation == "load_asset") {
        const auto assetId = stringField(line, "assetId");
        const auto path = stringField(line, "path");
        if (!assetId || !path) return errorJson("load_asset requires assetId and path");
        return host.loadAsset(*assetId, *path);
    }
    if (*operation == "set_project") {
        const auto masterGain = numberField<float>(line, "masterGain");
        if (!masterGain) return errorJson("set_project requires masterGain");
        return host.setProjectMix(*masterGain);
    }
    if (*operation == "set_track") {
        const auto index = numberField<std::uint32_t>(line, "index");
        const auto gain = numberField<float>(line, "gain");
        const auto pan = numberField<float>(line, "pan");
        const auto mute = booleanField(line, "mute");
        const auto solo = booleanField(line, "solo");
        const auto reverb = booleanField(line, "reverb");
        const auto delay = booleanField(line, "delay");
        const auto equalizer = booleanField(line, "equalizer");
        const auto equalizerFrequencyHz = numberField<float>(line, "equalizerFrequencyHz").value_or(1000.0F);
        const auto equalizerGainDb = numberField<float>(line, "equalizerGainDb").value_or(0.0F);
        const auto equalizerQ = numberField<float>(line, "equalizerQ").value_or(1.0F);
        auto equalizerBands = sonora::audio::kDefaultEqualizerBands;
        if (line.find("\"equalizerBands\"") != std::string_view::npos) {
            const auto values = numberArrayField(line, "equalizerBands", sonora::audio::kEqualizerBandCount * 3);
            if (!values || values->size() != sonora::audio::kEqualizerBandCount * 3) return errorJson("set_track equalizerBands must contain seven frequency/gain/Q triples");
            for (std::size_t bandIndex = 0; bandIndex < sonora::audio::kEqualizerBandCount; ++bandIndex) {
                equalizerBands[bandIndex] = {
                    static_cast<float>((*values)[bandIndex * 3]),
                    static_cast<float>((*values)[bandIndex * 3 + 1]),
                    static_cast<float>((*values)[bandIndex * 3 + 2]),
                };
            }
        } else {
            equalizerBands[3] = {equalizerFrequencyHz, equalizerGainDb, equalizerQ};
        }
        std::vector<sonora::audio::AutomationPoint> gainAutomation;
        if (line.find("\"gainAutomation\"") != std::string_view::npos) {
            const auto values = numberArrayField(line, "gainAutomation", 16'384);
            if (!values) return errorJson("set_track gainAutomation must be a bounded numeric array");
            const auto parsed = parseGainAutomation(*values);
            if (!parsed) return errorJson("set_track gainAutomation points are invalid");
            gainAutomation = *parsed;
        }
        if (!index || !gain || !pan || !mute || !solo) return errorJson("set_track requires index, gain, pan, mute and solo");
        return host.setTrackMix(*index, *gain, *pan, *mute, *solo, reverb.value_or(false), delay.value_or(false), std::move(gainAutomation),
            equalizer.value_or(false), equalizerFrequencyHz, equalizerGainDb, equalizerQ, equalizerBands);
    }
    if (*operation == "add_clip") {
        const auto assetId = stringField(line, "assetId");
        const auto trackIndex = numberField<std::uint32_t>(line, "trackIndex");
        const auto startFrame = numberField<std::uint64_t>(line, "startFrame");
        const auto sourceOffsetFrame = numberField<std::uint64_t>(line, "sourceOffsetFrame");
        const auto durationFrames = numberField<std::uint64_t>(line, "durationFrames");
        const auto playbackRate = numberField<double>(line, "playbackRate");
        const auto gain = numberField<float>(line, "gain");
        const auto pan = numberField<float>(line, "pan");
        const auto fadeInFrames = numberField<std::uint64_t>(line, "fadeInFrames").value_or(0);
        const auto fadeOutFrames = numberField<std::uint64_t>(line, "fadeOutFrames").value_or(0);
        if (!assetId || !trackIndex || !startFrame || !sourceOffsetFrame || !durationFrames || !playbackRate || !gain || !pan) {
            return errorJson("add_clip requires assetId, trackIndex, startFrame, sourceOffsetFrame, durationFrames, playbackRate, gain and pan");
        }
        return host.addProjectClip(*assetId, *trackIndex, *startFrame, *sourceOffsetFrame, *durationFrames, *playbackRate, *gain, *pan, fadeInFrames, fadeOutFrames);
    }
    if (*operation == "commit_project") return host.commitProject();
    if (*operation == "play_project") {
        const auto deviceIndex = numberField<std::uint32_t>(line, "deviceIndex").value_or(0);
        const auto startFrame = numberField<std::uint64_t>(line, "startFrame").value_or(0);
        return host.playProject(deviceIndex, startFrame);
    }
    if (*operation == "pause_project") return host.pauseProject();
    if (*operation == "stop_project") return host.stopProject();
    if (*operation == "start_test_tone") {
        const double frequencyHz = numberField<double>(line, "frequencyHz").value_or(440.0);
        const double gain = numberField<double>(line, "gain").value_or(0.1);
        const auto deviceIndex = numberField<std::uint32_t>(line, "deviceIndex").value_or(0);
        return host.playTestTone(frequencyHz, gain, deviceIndex);
    }
    if (*operation == "shutdown") {
        shouldQuit = true;
        return "{\"version\":1,\"ok\":true,\"shutdown\":true}";
    }
    return errorJson("Unknown operation");
}

} // namespace

int main() {
    try {
        AudioHost host;
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.size() > kMaxCommandBytes) {
                std::cout << errorJson("Command exceeds 1048576 bytes") << '\n' << std::flush;
                continue;
            }
            bool shouldQuit = false;
            std::string response;
            try {
                response = handleCommand(host, line, shouldQuit);
            } catch (const std::exception& error) {
                response = errorJson(error.what());
            }
            std::cout << response << '\n' << std::flush;
            if (shouldQuit) break;
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "SONORA audio engine failed: " << error.what() << '\n';
        return 1;
    }
}
