#include "realtime_clap_insert.hpp"

#include <array>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <string>

int main(const int argumentCount, char** arguments) {
    if (argumentCount != 2) {
        std::cerr << "Usage: sonora-realtime-clap-bridge-tests.exe <gain.clap>\n";
        return 2;
    }

    sonora::plugin::RealtimeClapInsert insert;
    std::string error;
    if (!insert.start(std::filesystem::u8path(arguments[1]), error)) {
        std::cerr << error << '\n';
        return 1;
    }

    bool processedEffectOutput = false;
    for (std::uint64_t block = 0; block < 12; ++block) {
        std::array<float, sonora::plugin::kPluginAudioBlockSamples> audio{};
        audio.fill(0.5F);
        insert.process(audio.data(), sonora::plugin::kPluginAudioBlockFrames,
            block * sonora::plugin::kPluginAudioBlockFrames);
        if (block < 4) {
            for (const auto sample : audio) {
                if (sample != 0.0F) {
                    std::cerr << "The real-time pipeline did not preserve its 512-frame startup latency\n";
                    return 1;
                }
            }
        } else if (std::abs(audio.front() - 0.25F) < 0.0001F) {
            processedEffectOutput = true;
        }
        Sleep(10);
    }

    if (!processedEffectOutput) {
        std::cerr << "The master insert did not return the isolated CLAP gain result\n";
        return 1;
    }
    insert.stop();
    std::cout << "{\"ok\":true,\"isolatedProcess\":true,\"masterInsert\":true,\"pipelineLatencyFrames\":512}\n";
    return 0;
}

