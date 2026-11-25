cmake_minimum_required(VERSION 3.24)
project(sonora_audio_engine VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(sonora_engine_core STATIC src/engine_core.cpp)
target_include_directories(sonora_engine_core PUBLIC src)
target_compile_options(sonora_engine_core PRIVATE
    $<$<CXX_COMPILER_ID:MSVC>:/W4>
    $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wall;-Wextra;-Wpedantic>)

add_executable(sonora-audio-engine src/main.cpp vendor/rtmidi/RtMidi.cpp)
target_include_directories(sonora-audio-engine PRIVATE src vendor/miniaudio vendor/rtmidi)
target_link_libraries(sonora-audio-engine PRIVATE sonora_engine_core)
target_compile_options(sonora-audio-engine PRIVATE
    $<$<CXX_COMPILER_ID:MSVC>:/W4>
    $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wall;-Wextra;-Wpedantic>)
target_compile_definitions(sonora-audio-engine PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX __WINDOWS_MM__)
target_link_libraries(sonora-audio-engine PRIVATE ole32 oleaut32 winmm uuid avrt ksuser psapi)

if(WIN32)
    add_executable(sonora-clap-offline src/clap_offline_renderer.cpp)
    target_include_directories(sonora-clap-offline PRIVATE src vendor/miniaudio vendor/clap/include)
    target_compile_definitions(sonora-clap-offline PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
    target_link_libraries(sonora-clap-offline PRIVATE ole32 oleaut32 winmm uuid avrt ksuser shell32)
    target_compile_options(sonora-clap-offline PRIVATE
        $<$<CXX_COMPILER_ID:MSVC>:/W4>
        $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wall;-Wextra;-Wpedantic>)
endif()

add_executable(sonora_engine_core_tests tests/engine_core_tests.cpp)
target_link_libraries(sonora_engine_core_tests PRIVATE sonora_engine_core)
target_compile_options(sonora_engine_core_tests PRIVATE
    $<$<CXX_COMPILER_ID:MSVC>:/W4>
    $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wall;-Wextra;-Wpedantic>)

add_executable(sonora_engine_core_bench benchmarks/core_bench.cpp)
target_link_libraries(sonora_engine_core_bench PRIVATE sonora_engine_core)
target_compile_options(sonora_engine_core_bench PRIVATE
    $<$<CXX_COMPILER_ID:MSVC>:/W4>
    $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wall;-Wextra;-Wpedantic>)

enable_testing()
add_test(NAME native_audio_core COMMAND sonora_engine_core_tests)
