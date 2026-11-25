#include "engine_core.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <numbers>
#include <span>

namespace sonora::audio {

bool renderSine(
    float* output,
    const std::size_t frameCount,
    const std::uint32_t channels,
    const double sampleRate,
    const double frequencyHz,
    const double gain,
    double& phase) noexcept {
    if (output == nullptr || channels == 0 || !std::isfinite(sampleRate) || sampleRate <= 0.0 ||
        !std::isfinite(frequencyHz) || frequencyHz < 0.0 || frequencyHz >= sampleRate * 0.5 ||
        !std::isfinite(gain) || gain < 0.0 || gain > 1.0 || !std::isfinite(phase)) {
        return false;
    }

    const double phaseStep = frequencyHz / sampleRate;
    for (std::size_t frame = 0; frame < frameCount; ++frame) {
        const auto sample = static_cast<float>(std::sin(phase * 2.0 * std::numbers::pi) * gain);
        for (std::uint32_t channel = 0; channel < channels; ++channel) {
            output[frame * channels + channel] = sample;
        }
        phase += phaseStep;
        phase -= std::floor(phase);
    }
    return true;
}

bool mixMonoToStereo(
    const float* source,
    float* destination,
    const std::size_t frameCount,
    const float gain,
    const float pan) noexcept {
    if (source == nullptr || destination == nullptr || !std::isfinite(gain) || gain < 0.0F ||
        !std::isfinite(pan) || pan < -1.0F || pan > 1.0F) {
        return false;
    }

    constexpr float kQuarterCircleRadians = std::numbers::pi_v<float> * 0.25F;
    const float panAngle = (pan + 1.0F) * kQuarterCircleRadians;
    const float leftGain = std::cos(panAngle) * gain;
    const float rightGain = std::sin(panAngle) * gain;
    for (std::size_t frame = 0; frame < frameCount; ++frame) {
        destination[frame * 2] += source[frame] * leftGain;
        destination[frame * 2 + 1] += source[frame] * rightGain;
    }
    return true;
}

bool renderMixBlock(
    float* output,
    const std::size_t frameCount,
    const double outputSampleRate,
    const std::uint64_t firstProjectFrame,
    const ProjectMixView& project,
    ProjectMixState* state,
    float* trackPeaks,
    const std::size_t trackPeakCount) noexcept {
    if (output == nullptr || !std::isfinite(outputSampleRate) || outputSampleRate <= 0.0 ||
        (project.trackCount > 0 && project.tracks == nullptr) || (project.clipCount > 0 && project.clips == nullptr) ||
        !std::isfinite(project.masterGain) || project.masterGain < 0.0F || project.masterGain > 4.0F ||
        firstProjectFrame > std::numeric_limits<std::uint64_t>::max() - frameCount) {
        return false;
    }

    bool anySolo = false;
    bool hasEffects = false;
    bool hasAutomation = false;
    for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
        const auto& track = project.tracks[trackIndex];
        if (!std::isfinite(track.gain) || track.gain < 0.0F || track.gain > 4.0F ||
            !std::isfinite(track.pan) || track.pan < -1.0F || track.pan > 1.0F) {
            return false;
        }
        anySolo = anySolo || track.solo;
        hasEffects = hasEffects || track.reverb || track.delay || track.equalizer;
        hasAutomation = hasAutomation || !track.gainAutomation.empty();
        if (track.gainAutomation.size() > 8192) return false;
        std::uint64_t previousFrame = 0;
        bool firstPoint = true;
        for (const auto& point : track.gainAutomation) {
            if ((!firstPoint && point.frame <= previousFrame) || !std::isfinite(point.value) || point.value < 0.0F || point.value > 4.0F) return false;
            previousFrame = point.frame;
            firstPoint = false;
        }
    }

    const bool collectTrackPeaks = trackPeaks != nullptr;
    if ((collectTrackPeaks && (trackPeakCount < project.trackCount || state == nullptr || state->maxBlockFrames == 0 ||
        state->maxBlockFrames > state->meterScratch.max_size() / 2 || frameCount > state->maxBlockFrames ||
        project.trackCount > state->meterScratch.max_size() / (state->maxBlockFrames * 2) ||
        state->meterScratch.size() < project.trackCount * state->maxBlockFrames * 2)) ||
        (trackPeaks == nullptr && trackPeakCount != 0)) return false;
    if ((hasEffects || hasAutomation) && (state == nullptr || state->tracks.size() != project.trackCount ||
        state->effectSlots.size() != project.trackCount || frameCount > state->maxBlockFrames)) return false;
    if (hasAutomation) {
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            const auto& points = project.tracks[trackIndex].gainAutomation;
            if (!points.empty() && state->tracks[trackIndex].gainAutomationValues.size() < frameCount) return false;
        }
    }
    if (hasEffects) {
        std::size_t slotCount = 0;
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            if (project.tracks[trackIndex].reverb || project.tracks[trackIndex].delay || project.tracks[trackIndex].equalizer) {
                const int slot = state->effectSlots[trackIndex];
                if (slot < 0 || static_cast<std::size_t>(slot) >= state->tracks.size()) return false;
                slotCount = std::max(slotCount, static_cast<std::size_t>(slot) + 1);
            }
        }
        if (state->trackScratch.size() < slotCount * state->maxBlockFrames * 2) return false;
    }

    for (std::size_t clipIndex = 0; clipIndex < project.clipCount; ++clipIndex) {
        const auto& clip = project.clips[clipIndex];
        const auto* const source = clip.source;
        if (source == nullptr || source->samples == nullptr || source->frameCount == 0 ||
            (source->channels != 1 && source->channels != 2) || !std::isfinite(source->sampleRate) || source->sampleRate <= 0.0 ||
            clip.trackIndex >= project.trackCount || clip.sourceOffsetFrame > source->frameCount ||
            clip.startFrame > std::numeric_limits<std::uint64_t>::max() - clip.durationFrames ||
            !std::isfinite(clip.playbackRate) || clip.playbackRate <= 0.0 || clip.playbackRate > 8.0 ||
            !std::isfinite(clip.gain) || clip.gain < 0.0F || clip.gain > 4.0F ||
            !std::isfinite(clip.pan) || clip.pan < -1.0F || clip.pan > 1.0F ||
            clip.fadeInFrames > clip.durationFrames || clip.fadeOutFrames > clip.durationFrames ||
            clip.fadeInFrames > clip.durationFrames - clip.fadeOutFrames) {
            return false;
        }
    }

    if (hasAutomation) {
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            const auto& points = project.tracks[trackIndex].gainAutomation;
            if (points.empty()) continue;
            auto& values = state->tracks[trackIndex].gainAutomationValues;
            auto nextPoint = std::upper_bound(points.begin(), points.end(), firstProjectFrame,
                [](const std::uint64_t frame, const AutomationPoint& point) { return frame < point.frame; });
            std::size_t currentIndex = nextPoint == points.begin() ? points.size() : static_cast<std::size_t>(nextPoint - points.begin() - 1);
            for (std::size_t frame = 0; frame < frameCount; ++frame) {
                const auto projectFrame = firstProjectFrame + frame;
                while (nextPoint != points.end() && nextPoint->frame <= projectFrame) {
                    currentIndex = static_cast<std::size_t>(nextPoint - points.begin());
                    ++nextPoint;
                }
                if (currentIndex == points.size()) {
                    values[frame] = project.tracks[trackIndex].gain;
                } else if (nextPoint == points.end()) {
                    values[frame] = points[currentIndex].value;
                } else {
                    const auto& start = points[currentIndex];
                    const auto& end = *nextPoint;
                    const float amount = static_cast<float>(projectFrame - start.frame) / static_cast<float>(end.frame - start.frame);
                    values[frame] = start.value + (end.value - start.value) * amount;
                }
            }
        }
    }

    std::fill_n(output, frameCount * 2, 0.0F);
    if (collectTrackPeaks) {
        std::fill_n(trackPeaks, project.trackCount, 0.0F);
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            auto* const trackOutput = state->meterScratch.data() + trackIndex * state->maxBlockFrames * 2;
            std::fill_n(trackOutput, frameCount * 2, 0.0F);
        }
    } else if (hasEffects) {
        std::fill(state->trackScratch.begin(), state->trackScratch.end(), 0.0F);
    }
    for (const auto& clip : std::span(project.clips, project.clipCount)) {
        const auto& track = project.tracks[clip.trackIndex];
        if (track.mute || (anySolo && !track.solo) || clip.durationFrames == 0) continue;

        const auto* const source = clip.source;
        const double sourceStep = source->sampleRate / outputSampleRate * clip.playbackRate;
        const int effectSlot = hasEffects ? state->effectSlots[clip.trackIndex] : -1;
        float* const destination = collectTrackPeaks
            ? state->meterScratch.data() + clip.trackIndex * state->maxBlockFrames * 2
            : effectSlot >= 0
                ? state->trackScratch.data() + static_cast<std::size_t>(effectSlot) * state->maxBlockFrames * 2
                : output;
        const float gain = (collectTrackPeaks ? 1.0F : effectSlot >= 0 ? 1.0F : project.masterGain) * clip.gain;
        const auto clipEndFrame = clip.startFrame + clip.durationFrames;
        if (firstProjectFrame >= clipEndFrame || firstProjectFrame + frameCount <= clip.startFrame) continue;

        for (std::size_t frame = 0; frame < frameCount; ++frame) {
            const auto projectFrame = firstProjectFrame + frame;
            if (projectFrame < clip.startFrame) continue;
            const auto relativeFrame = projectFrame - clip.startFrame;
            if (relativeFrame >= clip.durationFrames) continue;
            const double sourcePosition = static_cast<double>(clip.sourceOffsetFrame) + static_cast<double>(relativeFrame) * sourceStep;
            if (sourcePosition >= static_cast<double>(source->frameCount)) continue;

            const auto sourceFrame = static_cast<std::size_t>(sourcePosition);
            const auto nextSourceFrame = std::min(sourceFrame + 1, source->frameCount - 1);
            const float fraction = static_cast<float>(sourcePosition - static_cast<double>(sourceFrame));
            const auto sampleAt = [&](const std::size_t sourceIndex, const std::uint32_t channel) noexcept {
                const float first = source->samples[sourceIndex * source->channels + (source->channels == 1 ? 0 : channel)];
                const float next = source->samples[nextSourceFrame * source->channels + (source->channels == 1 ? 0 : channel)];
                return first + (next - first) * fraction;
            };

            float left{};
            float right{};
            const float trackGain = track.gainAutomation.empty() ? track.gain : state->tracks[clip.trackIndex].gainAutomationValues[frame];
            float fadeGain = 1.0F;
            if (clip.fadeInFrames > 0 && relativeFrame < clip.fadeInFrames) {
                fadeGain = std::min(fadeGain, static_cast<float>(relativeFrame) / static_cast<float>(clip.fadeInFrames));
            }
            const auto remainingFrames = clip.durationFrames - relativeFrame;
            if (clip.fadeOutFrames > 0 && remainingFrames <= clip.fadeOutFrames) {
                fadeGain = std::min(fadeGain, static_cast<float>(remainingFrames) / static_cast<float>(clip.fadeOutFrames));
            }
            const float frameGain = gain * trackGain * fadeGain;
            if (source->channels == 1) {
                const float mono = sampleAt(sourceFrame, 0) * frameGain;
                const float combinedPan = std::clamp(clip.pan + track.pan, -1.0F, 1.0F);
                const float angle = (combinedPan + 1.0F) * std::numbers::pi_v<float> * 0.25F;
                left = mono * std::cos(angle);
                right = mono * std::sin(angle);
            } else {
                left = sampleAt(sourceFrame, 0) * frameGain;
                right = sampleAt(sourceFrame, 1) * frameGain;
                const auto applyBalance = [](float& leftSample, float& rightSample, const float pan) noexcept {
                    if (pan < 0.0F) rightSample *= 1.0F + pan;
                    else if (pan > 0.0F) leftSample *= 1.0F - pan;
                };
                applyBalance(left, right, clip.pan);
                applyBalance(left, right, track.pan);
            }

            destination[frame * 2] += left;
            destination[frame * 2 + 1] += right;
        }
    }

    if (hasEffects) {
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            const auto& track = project.tracks[trackIndex];
            if (!track.reverb && !track.delay && !track.equalizer) continue;
            const auto slot = static_cast<std::size_t>(state->effectSlots[trackIndex]);
            const auto& trackState = state->tracks[trackIndex];
            float* const input = collectTrackPeaks
                ? state->meterScratch.data() + trackIndex * state->maxBlockFrames * 2
                : state->trackScratch.data() + slot * state->maxBlockFrames * 2;
            float peak = 0.0F;
            for (std::size_t frame = 0; frame < frameCount; ++frame) {
                float left = input[frame * 2];
                float right = input[frame * 2 + 1];
                if (track.reverb) {
                    float wetLeft = 0.0F;
                    float wetRight = 0.0F;
                    std::size_t offset = 0;
                    for (std::size_t comb = 0; comb < trackState.reverbLengths.size(); ++comb) {
                        const auto length = trackState.reverbLengths[comb];
                        const auto position = trackState.reverbPositions[comb];
                        const float delayedLeft = trackState.reverbBuffer[offset + position * 2];
                        const float delayedRight = trackState.reverbBuffer[offset + position * 2 + 1];
                        state->tracks[trackIndex].reverbBuffer[offset + position * 2] = left + delayedLeft * 0.72F;
                        state->tracks[trackIndex].reverbBuffer[offset + position * 2 + 1] = right + delayedRight * 0.72F;
                        wetLeft += delayedLeft * 0.25F;
                        wetRight += delayedRight * 0.25F;
                        state->tracks[trackIndex].reverbPositions[comb] = (position + 1) % length;
                        offset += length * 2;
                    }
                    left = left * 0.82F + wetLeft * 0.28F;
                    right = right * 0.82F + wetRight * 0.28F;
                }
                if (track.delay) {
                    auto& mutableTrackState = state->tracks[trackIndex];
                    const auto position = mutableTrackState.delayPosition;
                    const float delayedLeft = mutableTrackState.delayBuffer[position * 2];
                    const float delayedRight = mutableTrackState.delayBuffer[position * 2 + 1];
                    mutableTrackState.delayBuffer[position * 2] = left + delayedLeft * 0.24F;
                    mutableTrackState.delayBuffer[position * 2 + 1] = right + delayedRight * 0.24F;
                    mutableTrackState.delayPosition = (position + 1) % (mutableTrackState.delayBuffer.size() / 2);
                    left = left * 0.88F + delayedLeft * 0.2F;
                    right = right * 0.88F + delayedRight * 0.2F;
                }
                if (track.equalizer) {
                    const auto& coefficients = trackState.equalizerCoefficients;
                    const auto filter = [&](const float inputSample, const std::size_t channel) noexcept {
                        const float outputSample = coefficients[0] * inputSample + state->tracks[trackIndex].equalizerZ1[channel];
                        state->tracks[trackIndex].equalizerZ1[channel] = coefficients[1] * inputSample - coefficients[3] * outputSample + state->tracks[trackIndex].equalizerZ2[channel];
                        state->tracks[trackIndex].equalizerZ2[channel] = coefficients[2] * inputSample - coefficients[4] * outputSample;
                        return outputSample;
                    };
                    left = filter(left, 0); right = filter(right, 1);
                }
                if (collectTrackPeaks) {
                    input[frame * 2] = left;
                    input[frame * 2 + 1] = right;
                    peak = std::max({peak, std::abs(left), std::abs(right)});
                }
                output[frame * 2] += left * project.masterGain;
                output[frame * 2 + 1] += right * project.masterGain;
            }
            if (collectTrackPeaks) trackPeaks[trackIndex] = peak;
        }
    }
    if (collectTrackPeaks) {
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            const auto& track = project.tracks[trackIndex];
            if (track.reverb || track.delay || track.equalizer) continue;
            const float* const input = state->meterScratch.data() + trackIndex * state->maxBlockFrames * 2;
            float peak = 0.0F;
            for (std::size_t frame = 0; frame < frameCount; ++frame) {
                const float left = input[frame * 2];
                const float right = input[frame * 2 + 1];
                peak = std::max({peak, std::abs(left), std::abs(right)});
                output[frame * 2] += left * project.masterGain;
                output[frame * 2 + 1] += right * project.masterGain;
            }
            trackPeaks[trackIndex] = peak;
        }
    }
    return true;
}

bool configureProjectMixState(ProjectMixState& state, const ProjectMixView& project) noexcept {
    try {
        constexpr std::size_t kMaxBlockFrames = 8192;
        constexpr std::array<std::size_t, 4> kReverbLengths{1493, 2111, 2639, 2957};
        ProjectMixState prepared;
        prepared.tracks.resize(project.trackCount);
        prepared.effectSlots.assign(project.trackCount, -1);
        prepared.maxBlockFrames = kMaxBlockFrames;
        if (project.trackCount > prepared.meterScratch.max_size() / (prepared.maxBlockFrames * 2)) return false;
        prepared.meterScratch.assign(project.trackCount * prepared.maxBlockFrames * 2, 0.0F);
        std::size_t effectCount = 0;
        for (std::size_t index = 0; index < project.trackCount; ++index) {
            const auto& settings = project.tracks[index];
            auto& trackState = prepared.tracks[index];
            trackState.reverb = settings.reverb;
            trackState.delay = settings.delay;
            trackState.equalizer = settings.equalizer;
            if (settings.equalizer) {
                if (!std::isfinite(settings.equalizerFrequencyHz) || settings.equalizerFrequencyHz < 20.0F || settings.equalizerFrequencyHz > 20'000.0F ||
                    !std::isfinite(settings.equalizerGainDb) || settings.equalizerGainDb < -24.0F || settings.equalizerGainDb > 24.0F ||
                    !std::isfinite(settings.equalizerQ) || settings.equalizerQ < 0.1F || settings.equalizerQ > 18.0F) return false;
                const float amplitude = std::pow(10.0F, settings.equalizerGainDb / 40.0F);
                const float omega = 2.0F * std::numbers::pi_v<float> * settings.equalizerFrequencyHz / 48'000.0F;
                const float cosine = std::cos(omega), alpha = std::sin(omega) / (2.0F * settings.equalizerQ);
                const float a0 = 1.0F + alpha / amplitude;
                trackState.equalizerCoefficients = {
                    (1.0F + alpha * amplitude) / a0, (-2.0F * cosine) / a0, (1.0F - alpha * amplitude) / a0,
                    (-2.0F * cosine) / a0, (1.0F - alpha / amplitude) / a0,
                };
            }
            if (!settings.gainAutomation.empty()) trackState.gainAutomationValues.assign(prepared.maxBlockFrames, settings.gain);
            if (!settings.reverb && !settings.delay && !settings.equalizer) continue;
            prepared.effectSlots[index] = static_cast<int>(effectCount++);
            if (settings.reverb) {
                trackState.reverbLengths = kReverbLengths;
                std::size_t sampleCount = 0;
                for (const auto length : kReverbLengths) sampleCount += length * 2;
                trackState.reverbBuffer.assign(sampleCount, 0.0F);
            }
            if (settings.delay) trackState.delayBuffer.assign(13'440 * 2, 0.0F);
        }
        prepared.trackScratch.assign(effectCount * prepared.maxBlockFrames * 2, 0.0F);
        state = std::move(prepared);
        return true;
    } catch (...) {
        return false;
    }
}

void resetProjectMixState(ProjectMixState& state) noexcept {
    for (auto& track : state.tracks) {
        std::fill(track.delayBuffer.begin(), track.delayBuffer.end(), 0.0F);
        track.delayPosition = 0;
        std::fill(track.gainAutomationValues.begin(), track.gainAutomationValues.end(), 0.0F);
        std::fill(track.reverbBuffer.begin(), track.reverbBuffer.end(), 0.0F);
        track.equalizerZ1.fill(0.0F);
        track.equalizerZ2.fill(0.0F);
        track.reverbPositions.fill(0);
    }
}

std::optional<double> beatsToSeconds(const double beats, const double bpm) noexcept {
    if (!std::isfinite(beats) || beats < 0.0 || !std::isfinite(bpm) || bpm <= 0.0) {
        return std::nullopt;
    }
    return beats * 60.0 / bpm;
}

} // namespace sonora::audio
