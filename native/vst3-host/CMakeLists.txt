cmake_minimum_required(VERSION 3.25)
project(sonora_vst3_helper LANGUAGES C CXX)

if(NOT DEFINED SONORA_VST3_SDK_ROOT)
    message(FATAL_ERROR "Set SONORA_VST3_SDK_ROOT to the initialized native/references/vst3sdk directory")
endif()

set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)

add_subdirectory("${SONORA_VST3_SDK_ROOT}" "${CMAKE_BINARY_DIR}/vst3sdk")

set(SONORA_NATIVE_ROOT "${CMAKE_CURRENT_LIST_DIR}/..")
add_executable(sonora-vst3-host
    "${SONORA_NATIVE_ROOT}/src/vst3_host_helper.cpp"
    "${SONORA_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp"
    "${SONORA_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp"
)
target_include_directories(sonora-vst3-host PRIVATE "${SONORA_NATIVE_ROOT}/src")
target_compile_features(sonora-vst3-host PRIVATE cxx_std_20)
target_compile_definitions(sonora-vst3-host PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(sonora-vst3-host PRIVATE sdk_hosting)
target_compile_options(sonora-vst3-host PRIVATE
    $<$<CXX_COMPILER_ID:MSVC>:/W4>
    $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wall;-Wextra;-Wpedantic>)
