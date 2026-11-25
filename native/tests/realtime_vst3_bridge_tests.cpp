#include "realtime_vst3_insert.hpp"

#include <array>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <string>

int main(const int argumentCount, char** arguments) {
    if (argumentCount != 2) {
        std::cerr << "Usage: sonora-vst3-bridge-tests.exe <mda-vst3.vst3>\n";
        return 2;
    }

    sonora::plugin::RealtimeVst3Insert insert;
    std::string error;
    if (!insert.start(std::filesystem::u8path(arguments[1]), error)) {
        std::cerr << error << '\n';
        return 1;
    }

    bool processedNonSilentOutput = false;
    for (std::uint64_t block = 0; block < 16; ++block) {
        std::array<float, sonora::plugin::kPluginAudioBlockSamples> audio{};
        audio.fill(0.25F);
        insert.process(audio.data(), sonora::plugin::kPluginAudioBlockFrames,
            block * sonora::plugin::kPluginAudioBlockFrames);

        if (block < 4) {
            for (const auto sample : audio) {
                if (sample != 0.0F) {
                    std::cerr << "VST3 master insert did not preserve its 512-frame startup latency\n";
                    return 1;
                }
            }
        } else {
            for (const auto sample : audio) {
                if (!std::isfinite(sample)) {
                    std::cerr << "VST3 helper returned a non-finite sample\n";
                    return 1;
                }
                if (std::abs(sample) > 0.001F) processedNonSilentOutput = true;
            }
        }
        Sleep(10);
    }

    if (!processedNonSilentOutput) {
        std::cerr << "The isolated VST3 effect did not return a non-silent audio block\n";
        return 1;
    }
    if (insert.outputUnderruns() != 0) {
        std::cerr << "The VST3 helper missed a block during the bridge test\n";
        return 1;
    }
    insert.stop();
    std::cout << "{\"ok\":true,\"isolatedProcess\":true,\"vst3EffectProcessed\":true,\"pipelineLatencyFrames\":512}\n";
    return 0;
}
