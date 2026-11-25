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

bool configureProjectMixState(ProjectMixState& state, const ProjectMixView& project) noexcept;
void resetProjectMixState(ProjectMixState& state) noexcept;
static bool renderRoutedMixBlock(float*, std::size_t, double, std::uint64_t, const ProjectMixView&, ProjectMixState*, float*, std::size_t, TrackAudioProcessor, void*) noexcept;

bool renderMixBlock(
    float* output,
    const std::size_t frameCount,
    const double outputSampleRate,
    const std::uint64_t firstProjectFrame,
    const ProjectMixView& project,
    ProjectMixState* state,
    float* trackPeaks,
    const std::size_t trackPeakCount,
    const TrackAudioProcessor trackProcessor,
    void* const trackProcessorContext) noexcept {
    if (output == nullptr || !std::isfinite(outputSampleRate) || outputSampleRate <= 0.0 ||
        (project.trackCount > 0 && project.tracks == nullptr) || (project.clipCount > 0 && project.clips == nullptr) ||
        !std::isfinite(project.masterGain) || project.masterGain < 0.0F || project.masterGain > 4.0F ||
        firstProjectFrame > std::numeric_limits<std::uint64_t>::max() - frameCount) {
        return false;
    }

    const bool hasRouting = project.trackCount > 0 && std::any_of(project.tracks, project.tracks + project.trackCount,
        [](const TrackMixSettings& track) { return track.isBus || track.outputBusIndex >= 0; });
    if (hasRouting) return renderRoutedMixBlock(output, frameCount, outputSampleRate, firstProjectFrame, project, state, trackPeaks, trackPeakCount, trackProcessor, trackProcessorContext);

    bool anySolo = false;
    bool hasEffects = false;
    bool hasAutomation = false;
    for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
        const auto& track = project.tracks[trackIndex];
        if (!std::isfinite(track.gain) || track.gain < 0.0F || track.gain > 4.0F ||
            !std::isfinite(track.pan) || track.pan < -1.0F || track.pan > 1.0F ||
            (track.compressor && (!std::isfinite(track.compressorThresholdDb) || track.compressorThresholdDb < -60.0F || track.compressorThresholdDb > 0.0F ||
                !std::isfinite(track.compressorRatio) || track.compressorRatio < 1.0F || track.compressorRatio > 20.0F ||
                !std::isfinite(track.compressorAttackMs) || track.compressorAttackMs < 0.1F || track.compressorAttackMs > 100.0F ||
                !std::isfinite(track.compressorReleaseMs) || track.compressorReleaseMs < 10.0F || track.compressorReleaseMs > 1000.0F ||
                !std::isfinite(track.compressorMakeupDb) || track.compressorMakeupDb < 0.0F || track.compressorMakeupDb > 24.0F)) ||
            (track.limiter && (!std::isfinite(track.limiterCeilingDb) || track.limiterCeilingDb < -24.0F || track.limiterCeilingDb > 0.0F ||
                !std::isfinite(track.limiterReleaseMs) || track.limiterReleaseMs < 10.0F || track.limiterReleaseMs > 500.0F))) {
            return false;
        }
        anySolo = anySolo || track.solo;
        hasEffects = hasEffects || track.reverb || track.delay || track.equalizer || track.compressor || track.limiter;
        hasAutomation = hasAutomation || !track.gainAutomation.empty() || !track.panAutomation.empty();
        const auto validAutomation = [](const std::vector<AutomationPoint>& points, const float minimum, const float maximum) noexcept {
            if (points.size() > 8192) return false;
            std::uint64_t previousFrame = 0;
            bool firstPoint = true;
            for (const auto& point : points) {
                if ((!firstPoint && point.frame <= previousFrame) || !std::isfinite(point.value) || point.value < minimum || point.value > maximum) return false;
                previousFrame = point.frame;
                firstPoint = false;
            }
            return true;
        };
        if (!validAutomation(track.gainAutomation, 0.0F, 4.0F) || !validAutomation(track.panAutomation, -1.0F, 1.0F)) return false;
    }

    const bool collectTrackPeaks = trackPeaks != nullptr;
    const bool collectTrackAudio = collectTrackPeaks || trackProcessor != nullptr;
    if ((collectTrackAudio && ((collectTrackPeaks && trackPeakCount < project.trackCount) || state == nullptr || state->maxBlockFrames == 0 ||
        state->maxBlockFrames > state->meterScratch.max_size() / 2 || frameCount > state->maxBlockFrames ||
        project.trackCount > state->meterScratch.max_size() / (state->maxBlockFrames * 2) ||
        state->meterScratch.size() < project.trackCount * state->maxBlockFrames * 2)) ||
        (trackPeaks == nullptr && trackPeakCount != 0)) return false;
    if ((hasEffects || hasAutomation) && (state == nullptr || state->tracks.size() != project.trackCount ||
        state->effectSlots.size() != project.trackCount || frameCount > state->maxBlockFrames)) return false;
    if (hasAutomation) {
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            const auto& settings = project.tracks[trackIndex];
            if (!settings.gainAutomation.empty() && state->tracks[trackIndex].gainAutomationValues.size() < frameCount) return false;
            if (!settings.panAutomation.empty() && state->tracks[trackIndex].panAutomationValues.size() < frameCount) return false;
        }
    }
    if (hasEffects) {
        std::size_t slotCount = 0;
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            if (project.tracks[trackIndex].reverb || project.tracks[trackIndex].delay || project.tracks[trackIndex].equalizer || project.tracks[trackIndex].compressor) {
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
        if (!clip.gainEnvelope.empty()) {
            if (clip.gainEnvelope.size() < 2 || clip.gainEnvelope.size() > 1024 ||
                clip.gainEnvelope.front().frame != 0 || clip.gainEnvelope.back().frame != clip.durationFrames) return false;
            for (std::size_t pointIndex = 0; pointIndex < clip.gainEnvelope.size(); ++pointIndex) {
                const auto& point = clip.gainEnvelope[pointIndex];
                if (point.frame > clip.durationFrames || !std::isfinite(point.value) || point.value < 0.0F || point.value > 1.5F ||
                    (pointIndex > 0 && point.frame <= clip.gainEnvelope[pointIndex - 1].frame)) return false;
            }
        }
    }

    if (hasAutomation) {
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            const auto renderAutomation = [&](const std::vector<AutomationPoint>& points, std::vector<float>& values, const float fallback) {
                if (points.empty()) return;
                auto nextPoint = std::upper_bound(points.begin(), points.end(), firstProjectFrame,
                    [](const std::uint64_t frame, const AutomationPoint& point) { return frame < point.frame; });
                std::size_t currentIndex = nextPoint == points.begin() ? points.size() : static_cast<std::size_t>(nextPoint - points.begin() - 1);
                for (std::size_t frame = 0; frame < frameCount; ++frame) {
                    const auto projectFrame = firstProjectFrame + frame;
                    while (nextPoint != points.end() && nextPoint->frame <= projectFrame) {
                        currentIndex = static_cast<std::size_t>(nextPoint - points.begin());
                        ++nextPoint;
                    }
                    if (currentIndex == points.size()) values[frame] = fallback;
                    else if (nextPoint == points.end()) values[frame] = points[currentIndex].value;
                    else {
                        const auto& start = points[currentIndex];
                        const auto& end = *nextPoint;
                        const float amount = static_cast<float>(projectFrame - start.frame) / static_cast<float>(end.frame - start.frame);
                        values[frame] = start.value + (end.value - start.value) * amount;
                    }
                }
            };
            const auto& settings = project.tracks[trackIndex];
            renderAutomation(settings.gainAutomation, state->tracks[trackIndex].gainAutomationValues, settings.gain);
            renderAutomation(settings.panAutomation, state->tracks[trackIndex].panAutomationValues, settings.pan);
        }
    }

    std::fill_n(output, frameCount * 2, 0.0F);
    if (collectTrackAudio) {
        if (collectTrackPeaks) std::fill_n(trackPeaks, project.trackCount, 0.0F);
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
        float* const destination = collectTrackAudio
            ? state->meterScratch.data() + clip.trackIndex * state->maxBlockFrames * 2
            : effectSlot >= 0
                ? state->trackScratch.data() + static_cast<std::size_t>(effectSlot) * state->maxBlockFrames * 2
                : output;
        const float gain = (collectTrackAudio ? 1.0F : effectSlot >= 0 ? 1.0F : project.masterGain) * clip.gain;
        const auto clipEndFrame = clip.startFrame + clip.durationFrames;
        if (firstProjectFrame >= clipEndFrame || firstProjectFrame + frameCount <= clip.startFrame) continue;

        std::size_t clipEnvelopeIndex = 0;
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
            const float trackPan = track.panAutomation.empty() ? track.pan : state->tracks[clip.trackIndex].panAutomationValues[frame];
            float fadeGain = 1.0F;
            if (clip.fadeInFrames > 0 && relativeFrame < clip.fadeInFrames) {
                fadeGain = std::min(fadeGain, static_cast<float>(relativeFrame) / static_cast<float>(clip.fadeInFrames));
            }
            const auto remainingFrames = clip.durationFrames - relativeFrame;
            if (clip.fadeOutFrames > 0 && remainingFrames <= clip.fadeOutFrames) {
                fadeGain = std::min(fadeGain, static_cast<float>(remainingFrames) / static_cast<float>(clip.fadeOutFrames));
            }
            float clipEnvelopeGain = 1.0F;
            if (!clip.gainEnvelope.empty()) {
                while (clipEnvelopeIndex + 1 < clip.gainEnvelope.size() && clip.gainEnvelope[clipEnvelopeIndex + 1].frame < relativeFrame) ++clipEnvelopeIndex;
                const auto& left = clip.gainEnvelope[clipEnvelopeIndex];
                if (clipEnvelopeIndex + 1 < clip.gainEnvelope.size()) {
                    const auto& right = clip.gainEnvelope[clipEnvelopeIndex + 1];
                    const float amount = static_cast<float>(relativeFrame - left.frame) / static_cast<float>(right.frame - left.frame);
                    clipEnvelopeGain = left.value + (right.value - left.value) * amount;
                } else clipEnvelopeGain = left.value;
            }
            const float frameGain = gain * trackGain * fadeGain * clipEnvelopeGain;
            if (source->channels == 1) {
                const float mono = sampleAt(sourceFrame, 0) * frameGain;
                const float combinedPan = std::clamp(clip.pan + trackPan, -1.0F, 1.0F);
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
                applyBalance(left, right, trackPan);
            }

            destination[frame * 2] += left;
            destination[frame * 2 + 1] += right;
        }
    }

    if (hasEffects) {
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            const auto& track = project.tracks[trackIndex];
            if (!track.reverb && !track.delay && !track.equalizer && !track.compressor && !track.limiter) continue;
            const auto slot = static_cast<std::size_t>(state->effectSlots[trackIndex]);
            const auto& trackState = state->tracks[trackIndex];
            float* const input = collectTrackAudio
                ? state->meterScratch.data() + trackIndex * state->maxBlockFrames * 2
                : state->trackScratch.data() + slot * state->maxBlockFrames * 2;
            float peak = 0.0F;
            auto& mutableTrackState = state->tracks[trackIndex];
            const float compressorAttackCoefficient = track.compressor
                ? std::exp(-1.0F / static_cast<float>(outputSampleRate * track.compressorAttackMs * 0.001)) : 0.0F;
            const float compressorReleaseCoefficient = track.compressor
                ? std::exp(-1.0F / static_cast<float>(outputSampleRate * track.compressorReleaseMs * 0.001)) : 0.0F;
            const float compressorMakeupGain = track.compressor ? std::exp2(track.compressorMakeupDb / 6.020599913F) : 1.0F;
            const float limiterReleaseCoefficient = track.limiter
                ? std::exp(-1.0F / static_cast<float>(outputSampleRate * track.limiterReleaseMs * 0.001)) : 0.0F;
            const float limiterCeiling = track.limiter ? std::exp2(track.limiterCeilingDb / 6.020599913F) : 1.0F;
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
                    auto& mutableTrackState = state->tracks[trackIndex];
                    for (std::size_t bandIndex = 0; bandIndex < kEqualizerBandCount; ++bandIndex) {
                        const auto& coefficients = trackState.equalizerCoefficients[bandIndex];
                        const auto filter = [&](const float inputSample, const std::size_t channel) noexcept {
                            const float outputSample = coefficients[0] * inputSample + mutableTrackState.equalizerZ1[bandIndex][channel];
                            mutableTrackState.equalizerZ1[bandIndex][channel] = coefficients[1] * inputSample - coefficients[3] * outputSample + mutableTrackState.equalizerZ2[bandIndex][channel];
                            mutableTrackState.equalizerZ2[bandIndex][channel] = coefficients[2] * inputSample - coefficients[4] * outputSample;
                            return outputSample;
                        };
                        left = filter(left, 0); right = filter(right, 1);
                    }
                }
                if (track.compressor) {
                    const float detector = std::max(std::abs(left), std::abs(right));
                    const float levelDb = 6.020599913F * std::log2(std::max(detector, 1.0e-9F));
                    const float overThresholdDb = levelDb - track.compressorThresholdDb;
                    constexpr float kneeDb = 6.0F;
                    float reductionDb = 0.0F;
                    if (overThresholdDb >= kneeDb * 0.5F) reductionDb = (overThresholdDb / track.compressorRatio) - overThresholdDb;
                    else if (overThresholdDb > -kneeDb * 0.5F) {
                        const float kneePosition = overThresholdDb + kneeDb * 0.5F;
                        reductionDb = (1.0F / track.compressorRatio - 1.0F) * kneePosition * kneePosition / (2.0F * kneeDb);
                    }
                    const float targetGain = std::exp2(reductionDb / 6.020599913F);
                    const float coefficient = targetGain < mutableTrackState.compressorEnvelope
                        ? compressorAttackCoefficient : compressorReleaseCoefficient;
                    mutableTrackState.compressorEnvelope = coefficient * mutableTrackState.compressorEnvelope + (1.0F - coefficient) * targetGain;
                    left *= mutableTrackState.compressorEnvelope * compressorMakeupGain;
                    right *= mutableTrackState.compressorEnvelope * compressorMakeupGain;
                }
                if (track.limiter) {
                    const float detector = std::max(std::abs(left), std::abs(right));
                    const float targetGain = std::min(1.0F, limiterCeiling / std::max(detector, 1.0e-9F));
                    if (targetGain < mutableTrackState.limiterEnvelope) mutableTrackState.limiterEnvelope = targetGain;
                    else mutableTrackState.limiterEnvelope = limiterReleaseCoefficient * mutableTrackState.limiterEnvelope + (1.0F - limiterReleaseCoefficient) * targetGain;
                    left *= mutableTrackState.limiterEnvelope;
                    right *= mutableTrackState.limiterEnvelope;
                }
                if (collectTrackAudio) {
                    input[frame * 2] = left;
                    input[frame * 2 + 1] = right;
                    peak = std::max({peak, std::abs(left), std::abs(right)});
                }
                if (!trackProcessor) {
                    output[frame * 2] += left * project.masterGain;
                    output[frame * 2 + 1] += right * project.masterGain;
                }
            }
            if (collectTrackPeaks) trackPeaks[trackIndex] = peak;
        }
    }
    if (trackProcessor) {
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            auto* const input = state->meterScratch.data() + trackIndex * state->maxBlockFrames * 2;
            trackProcessor(trackProcessorContext, trackIndex, input, frameCount, firstProjectFrame);
            float peak = 0.0F;
            for (std::size_t frame = 0; frame < frameCount; ++frame) {
                const float left = input[frame * 2];
                const float right = input[frame * 2 + 1];
                peak = std::max({peak, std::abs(left), std::abs(right)});
                output[frame * 2] += left * project.masterGain;
                output[frame * 2 + 1] += right * project.masterGain;
            }
            if (collectTrackPeaks) trackPeaks[trackIndex] = peak;
        }
    } else if (collectTrackPeaks) {
        for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
            const auto& track = project.tracks[trackIndex];
            if (track.reverb || track.delay || track.equalizer || track.compressor || track.limiter) continue;
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

static bool renderRoutedMixBlock(
    float* output,
    const std::size_t frameCount,
    const double outputSampleRate,
    const std::uint64_t firstProjectFrame,
    const ProjectMixView& project,
    ProjectMixState* state,
    float* trackPeaks,
    const std::size_t trackPeakCount,
    const TrackAudioProcessor trackProcessor,
    void* const trackProcessorContext) noexcept {
    if (state == nullptr || !state->usesRouting || state->maxBlockFrames == 0 ||
        frameCount > state->maxBlockFrames || state->routedChannels.size() != project.trackCount ||
        (trackPeaks != nullptr && trackPeakCount < project.trackCount) ||
        (trackPeaks == nullptr && trackPeakCount != 0)) {
        return false;
    }

    const auto busIndexFor = [&](const std::size_t trackIndex) noexcept -> std::size_t {
        const auto& track = project.tracks[trackIndex];
        if (track.isBus || track.outputBusIndex == -1) return project.trackCount;
        if (track.outputBusIndex < -1) return project.trackCount;
        const auto target = static_cast<std::size_t>(track.outputBusIndex);
        if (target >= project.trackCount || !project.tracks[target].isBus ||
            project.tracks[target].outputBusIndex != -1) {
            return project.trackCount;
        }
        return target;
    };

    bool anySolo = false;
    for (std::size_t index = 0; index < project.trackCount; ++index) {
        const auto& track = project.tracks[index];
        if (track.isBus) {
            if (track.outputBusIndex != -1) return false;
        } else if (track.outputBusIndex < -1 ||
                   (track.outputBusIndex >= 0 && busIndexFor(index) == project.trackCount)) {
            return false;
        }
        anySolo = anySolo || track.solo;

        const auto& channel = state->routedChannels[index];
        if (!channel.runtime || channel.outputScratch.size() < state->maxBlockFrames * 2) return false;
        if (track.isBus) {
            if (channel.busInputScratch.size() < state->maxBlockFrames * 2 || channel.clips.size() != 1) return false;
        } else if (channel.busInputScratch.size() != 0 || channel.clips.empty() ||
                   channel.silenceScratch.size() < state->maxBlockFrames * 2 ||
                   channel.silenceView.samples != channel.silenceScratch.data()) {
            return false;
        }
    }

    std::fill_n(output, frameCount * 2, 0.0F);
    if (trackPeaks != nullptr) std::fill_n(trackPeaks, project.trackCount, 0.0F);
    for (std::size_t index = 0; index < project.trackCount; ++index) {
        if (project.tracks[index].isBus) {
            auto& channel = state->routedChannels[index];
            std::fill_n(channel.busInputScratch.data(), frameCount * 2, 0.0F);
        }
    }

    const auto blockEndFrame = firstProjectFrame + frameCount;
    for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
        const auto& track = project.tracks[trackIndex];
        if (track.isBus) continue;
        const auto busIndex = busIndexFor(trackIndex);
        const bool soloedDestination = busIndex < project.trackCount && project.tracks[busIndex].solo;
        auto& channel = state->routedChannels[trackIndex];
        if (track.mute || (anySolo && !track.solo && !soloedDestination)) {
            if (trackProcessor) {
                std::fill_n(channel.outputScratch.data(), frameCount * 2, 0.0F);
                trackProcessor(trackProcessorContext, trackIndex, channel.outputScratch.data(), frameCount, firstProjectFrame);
            }
            continue;
        }
        const auto actualClipCount = channel.clips.size() - 1;
        const bool hasActiveClip = std::any_of(channel.clips.begin(), channel.clips.begin() + actualClipCount,
            [&](const AudioClipView& clip) {
                return clip.durationFrames > 0 && clip.startFrame < blockEndFrame &&
                    clip.startFrame <= std::numeric_limits<std::uint64_t>::max() - clip.durationFrames &&
                    firstProjectFrame < clip.startFrame + clip.durationFrames;
            });
        const bool renderEffectTail = !hasActiveClip && (channel.settings.reverb || channel.settings.delay);
        auto clipCount = actualClipCount;
        if (renderEffectTail) {
            channel.silenceView.frameCount = state->maxBlockFrames;
            auto& silence = channel.clips.back();
            silence = channel.silenceClip;
            silence.source = &channel.silenceView;
            silence.startFrame = firstProjectFrame;
            silence.durationFrames = frameCount;
            clipCount += 1;
        }

        float peak = 0.0F;
        const ProjectMixView isolated{&channel.settings, 1, channel.clips.data(), clipCount, 1.0F};
        if (!renderMixBlock(channel.outputScratch.data(), frameCount, outputSampleRate, firstProjectFrame,
                isolated, channel.runtime.get(), trackPeaks != nullptr ? &peak : nullptr, trackPeaks != nullptr ? 1 : 0)) {
            return false;
        }
        if (trackProcessor) {
            trackProcessor(trackProcessorContext, trackIndex, channel.outputScratch.data(), frameCount, firstProjectFrame);
            peak = 0.0F;
            for (std::size_t sampleIndex = 0; sampleIndex < frameCount * 2; ++sampleIndex)
                peak = std::max(peak, std::abs(channel.outputScratch[sampleIndex]));
        }
        if (trackPeaks != nullptr) trackPeaks[trackIndex] = peak;

        float* const destination = busIndex < project.trackCount
            ? state->routedChannels[busIndex].busInputScratch.data()
            : output;
        for (std::size_t sampleIndex = 0; sampleIndex < frameCount * 2; ++sampleIndex) {
            destination[sampleIndex] += channel.outputScratch[sampleIndex];
        }
    }

    for (std::size_t busIndex = 0; busIndex < project.trackCount; ++busIndex) {
        const auto& bus = project.tracks[busIndex];
        if (!bus.isBus) continue;

        bool soloedInput = false;
        if (anySolo && !bus.solo) {
            for (std::size_t trackIndex = 0; trackIndex < project.trackCount; ++trackIndex) {
                if (!project.tracks[trackIndex].isBus && project.tracks[trackIndex].solo &&
                    busIndexFor(trackIndex) == busIndex) {
                    soloedInput = true;
                    break;
                }
            }
        }
        auto& channel = state->routedChannels[busIndex];
        if (bus.mute || (anySolo && !bus.solo && !soloedInput)) {
            if (trackProcessor) {
                std::fill_n(channel.outputScratch.data(), frameCount * 2, 0.0F);
                trackProcessor(trackProcessorContext, busIndex, channel.outputScratch.data(), frameCount, firstProjectFrame);
            }
            continue;
        }
        channel.busInputView.frameCount = state->maxBlockFrames;
        auto& inputClip = channel.clips.front();
        inputClip.source = &channel.busInputView;
        inputClip.trackIndex = 0;
        inputClip.startFrame = firstProjectFrame;
        inputClip.sourceOffsetFrame = 0;
        inputClip.durationFrames = frameCount;
        inputClip.playbackRate = 1.0;
        inputClip.gain = 1.0F;
        inputClip.pan = 0.0F;
        inputClip.fadeInFrames = 0;
        inputClip.fadeOutFrames = 0;

        float peak = 0.0F;
        const ProjectMixView isolated{&channel.settings, 1, channel.clips.data(), channel.clips.size(), 1.0F};
        if (!renderMixBlock(channel.outputScratch.data(), frameCount, outputSampleRate, firstProjectFrame,
                isolated, channel.runtime.get(), trackPeaks != nullptr ? &peak : nullptr, trackPeaks != nullptr ? 1 : 0)) {
            return false;
        }
        if (trackProcessor) {
            trackProcessor(trackProcessorContext, busIndex, channel.outputScratch.data(), frameCount, firstProjectFrame);
            peak = 0.0F;
            for (std::size_t sampleIndex = 0; sampleIndex < frameCount * 2; ++sampleIndex)
                peak = std::max(peak, std::abs(channel.outputScratch[sampleIndex]));
        }
        if (trackPeaks != nullptr) trackPeaks[busIndex] = peak;
        for (std::size_t sampleIndex = 0; sampleIndex < frameCount * 2; ++sampleIndex) {
            output[sampleIndex] += channel.outputScratch[sampleIndex];
        }
    }

    for (std::size_t sampleIndex = 0; sampleIndex < frameCount * 2; ++sampleIndex) {
        output[sampleIndex] *= project.masterGain;
    }
    return true;
}

bool configureProjectMixState(ProjectMixState& state, const ProjectMixView& project) noexcept {
    try {
        constexpr std::size_t kMaxBlockFrames = 8192;
        const bool hasRouting = project.trackCount > 0 && std::any_of(project.tracks, project.tracks + project.trackCount,
            [](const TrackMixSettings& track) { return track.isBus || track.outputBusIndex >= 0; });
        if (hasRouting) {
            if (!project.tracks || (project.clipCount && !project.clips)) return false;
            for (std::size_t i=0;i<project.trackCount;++i) {
                const auto& channel=project.tracks[i];
                if (channel.isBus && channel.outputBusIndex!=-1) return false;
                if (channel.outputBusIndex>=0 && (static_cast<std::size_t>(channel.outputBusIndex)>=project.trackCount ||
                    !project.tracks[static_cast<std::size_t>(channel.outputBusIndex)].isBus)) return false;
            }
            ProjectMixState prepared; prepared.maxBlockFrames=kMaxBlockFrames; prepared.usesRouting=true;
            prepared.routedChannels.resize(project.trackCount);
            for (std::size_t i=0;i<project.trackCount;++i) {
                auto& channel=prepared.routedChannels[i]; channel.settings=project.tracks[i];
                channel.settings.isBus=false; channel.settings.outputBusIndex=-1; channel.settings.mute=false; channel.settings.solo=false;
                channel.outputScratch.assign(kMaxBlockFrames*2,0.0F);
                for (const auto& clip:std::span(project.clips,project.clipCount)) if(clip.trackIndex==i) {
                    if(project.tracks[i].isBus) return false;
                    auto local=clip; local.trackIndex=0; channel.clips.push_back(local);
                }
                if(project.tracks[i].isBus) {
                    if(!channel.clips.empty()) return false;
                    channel.busInputScratch.assign(kMaxBlockFrames*2,0.0F);
                    channel.busInputView={channel.busInputScratch.data(),kMaxBlockFrames,2,48'000.0};
                    channel.busInputClip={&channel.busInputView,0,0,0,kMaxBlockFrames,1.0,1.0F,0.0F};
                    channel.clips.push_back(channel.busInputClip);
                    channel.settings.gainAutomation.clear(); channel.settings.panAutomation.clear();
                } else {
                    channel.silenceScratch.assign(kMaxBlockFrames*2,0.0F);
                    channel.silenceView={channel.silenceScratch.data(),kMaxBlockFrames,2,48'000.0};
                    channel.silenceClip={&channel.silenceView,0,0,0,kMaxBlockFrames,1.0,1.0F,0.0F};
                    channel.clips.push_back(channel.silenceClip);
                }
                channel.runtime=std::make_unique<ProjectMixState>();
                const ProjectMixView isolated{&channel.settings,1,channel.clips.data(),channel.clips.size(),1.0F};
                if(!configureProjectMixState(*channel.runtime,isolated)) return false;
            }
            state=std::move(prepared); return true;
        }
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
            if (settings.compressor && (!std::isfinite(settings.compressorThresholdDb) || settings.compressorThresholdDb < -60.0F || settings.compressorThresholdDb > 0.0F ||
                !std::isfinite(settings.compressorRatio) || settings.compressorRatio < 1.0F || settings.compressorRatio > 20.0F ||
                !std::isfinite(settings.compressorAttackMs) || settings.compressorAttackMs < 0.1F || settings.compressorAttackMs > 100.0F ||
                !std::isfinite(settings.compressorReleaseMs) || settings.compressorReleaseMs < 10.0F || settings.compressorReleaseMs > 1000.0F ||
                !std::isfinite(settings.compressorMakeupDb) || settings.compressorMakeupDb < 0.0F || settings.compressorMakeupDb > 24.0F)) return false;
            if (settings.limiter && (!std::isfinite(settings.limiterCeilingDb) || settings.limiterCeilingDb < -24.0F || settings.limiterCeilingDb > 0.0F ||
                !std::isfinite(settings.limiterReleaseMs) || settings.limiterReleaseMs < 10.0F || settings.limiterReleaseMs > 500.0F)) return false;
            auto& trackState = prepared.tracks[index];
            trackState.reverb = settings.reverb;
            trackState.delay = settings.delay;
            trackState.equalizer = settings.equalizer;
            trackState.compressor = settings.compressor;
            trackState.compressorEnvelope = 1.0F;
            trackState.limiter = settings.limiter;
            trackState.limiterEnvelope = 1.0F;
            if (settings.equalizer) {
                for (std::size_t bandIndex = 0; bandIndex < kEqualizerBandCount; ++bandIndex) {
                    const auto& band = settings.equalizerBands[bandIndex];
                    if (!std::isfinite(band.frequencyHz) || band.frequencyHz < 20.0F || band.frequencyHz > 20'000.0F ||
                        !std::isfinite(band.gainDb) || band.gainDb < -24.0F || band.gainDb > 24.0F ||
                        !std::isfinite(band.q) || band.q < 0.1F || band.q > 18.0F) return false;
                    const float amplitude = std::pow(10.0F, band.gainDb / 40.0F);
                    const float omega = 2.0F * std::numbers::pi_v<float> * band.frequencyHz / 48'000.0F;
                    const float cosine = std::cos(omega), alpha = std::sin(omega) / (2.0F * band.q);
                    const float a0 = 1.0F + alpha / amplitude;
                    trackState.equalizerCoefficients[bandIndex] = {
                        (1.0F + alpha * amplitude) / a0, (-2.0F * cosine) / a0, (1.0F - alpha * amplitude) / a0,
                        (-2.0F * cosine) / a0, (1.0F - alpha / amplitude) / a0,
                    };
                }
            }
            if (!settings.gainAutomation.empty()) trackState.gainAutomationValues.assign(prepared.maxBlockFrames, settings.gain);
            if (!settings.panAutomation.empty()) trackState.panAutomationValues.assign(prepared.maxBlockFrames, settings.pan);
            if (!settings.reverb && !settings.delay && !settings.equalizer && !settings.compressor && !settings.limiter) continue;
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
    if(state.usesRouting) {
        for(auto& channel:state.routedChannels) {
            std::fill(channel.outputScratch.begin(),channel.outputScratch.end(),0.0F);
            std::fill(channel.busInputScratch.begin(),channel.busInputScratch.end(),0.0F);
            if(channel.runtime) resetProjectMixState(*channel.runtime);
        }
        return;
    }
    for (auto& track : state.tracks) {
        std::fill(track.delayBuffer.begin(), track.delayBuffer.end(), 0.0F);
        track.delayPosition = 0;
        std::fill(track.gainAutomationValues.begin(), track.gainAutomationValues.end(), 0.0F);
        std::fill(track.reverbBuffer.begin(), track.reverbBuffer.end(), 0.0F);
        track.limiterEnvelope = 1.0F;
        for (auto& band : track.equalizerZ1) band.fill(0.0F);
        for (auto& band : track.equalizerZ2) band.fill(0.0F);
        track.reverbPositions.fill(0);
        track.compressorEnvelope = 1.0F;
    }
}

std::optional<double> beatsToSeconds(const double beats, const double bpm) noexcept {
    if (!std::isfinite(beats) || beats < 0.0 || !std::isfinite(bpm) || bpm <= 0.0) {
        return std::nullopt;
    }
    return beats * 60.0 / bpm;
}

} // namespace sonora::audio
