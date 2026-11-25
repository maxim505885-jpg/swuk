#pragma once

#include "realtime_plugin_transport.hpp"

#include <windows.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace sonora::plugin {

class ClapPluginProcess final {
public:
    ClapPluginProcess() = default;
    ~ClapPluginProcess() { stop(); }

    ClapPluginProcess(const ClapPluginProcess&) = delete;
    ClapPluginProcess& operator=(const ClapPluginProcess&) = delete;

    [[nodiscard]] bool start(const std::filesystem::path& pluginPath, std::string& error) {
        stop();
        error.clear();
        std::error_code filesystemError;
        if (!pluginPath.is_absolute() || !std::filesystem::is_regular_file(pluginPath, filesystemError) ||
            filesystemError || lowerExtension(pluginPath.extension().wstring()) != L".clap") {
            error = "Select an existing local .clap effect file";
            return false;
        }

        const auto moduleDirectory = currentDirectory();
        if (moduleDirectory.empty()) {
            error = "Could not locate the audio engine executable directory";
            return false;
        }
        const auto helperPath = moduleDirectory / L"sonora-clap-offline.exe";
        if (!std::filesystem::is_regular_file(helperPath, filesystemError) || filesystemError) {
            error = "The isolated CLAP host executable is missing";
            return false;
        }

        const auto instanceId = nextInstanceId_.fetch_add(1, std::memory_order_relaxed);
        mappingName_ = L"Local\\SONORA_CLAP_" + std::to_wstring(GetCurrentProcessId()) + L"_" + std::to_wstring(instanceId);
        mapping_ = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
            static_cast<DWORD>(sizeof(SharedTransport)), mappingName_.c_str());
        if (mapping_ == nullptr) {
            error = "Could not create shared memory for the CLAP host";
            return false;
        }
        transport_ = static_cast<SharedTransport*>(
            MapViewOfFile(mapping_, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedTransport)));
        if (transport_ == nullptr) {
            error = "Could not map shared memory for the CLAP host";
            stop();
            return false;
        }
        std::construct_at(transport_);

        const std::wstring command = quote(helperPath.wstring()) + L" serve " + quote(pluginPath.wstring()) + L" " +
            quote(mappingName_) + L" " + std::to_wstring(GetCurrentProcessId());
        std::vector<wchar_t> mutableCommand(command.begin(), command.end());
        mutableCommand.push_back(L'\0');
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        if (!CreateProcessW(helperPath.c_str(), mutableCommand.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                nullptr, helperPath.parent_path().c_str(), &startup, &process_)) {
            error = "Could not start the isolated CLAP host process";
            stop();
            return false;
        }

        const ULONGLONG deadline = GetTickCount64() + 15'000;
        while (GetTickCount64() < deadline) {
            const auto status = transport_->status.load(std::memory_order_acquire);
            if (status == HostStatus::ready) {
                processAlive_.store(true, std::memory_order_release);
                processMonitor_ = std::jthread([this](const std::stop_token stopToken) {
                    while (!stopToken.stop_requested() && process_.hProcess != nullptr) {
                        if (WaitForSingleObject(process_.hProcess, 50) == WAIT_OBJECT_0) {
                            processAlive_.store(false, std::memory_order_release);
                            return;
                        }
                    }
                });
                return true;
            }
            if (status == HostStatus::failed || WaitForSingleObject(process_.hProcess, 0) == WAIT_OBJECT_0) {
                error = "The CLAP plug-in failed during initialization";
                stop();
                return false;
            }
            Sleep(2);
        }
        error = "The CLAP plug-in took more than 15 seconds to initialize";
        stop();
        return false;
    }

    void stop() noexcept {
        if (transport_ != nullptr) transport_->status.store(HostStatus::stopping, std::memory_order_release);
        processMonitor_.request_stop();
        if (processMonitor_.joinable()) processMonitor_.join();
        if (process_.hProcess != nullptr) {
            if (WaitForSingleObject(process_.hProcess, 3'000) == WAIT_TIMEOUT) {
                TerminateProcess(process_.hProcess, 1);
                (void)WaitForSingleObject(process_.hProcess, 1'000);
            }
            if (process_.hThread != nullptr) CloseHandle(process_.hThread);
            CloseHandle(process_.hProcess);
            process_ = {};
        }
        if (transport_ != nullptr) {
            std::destroy_at(transport_);
            UnmapViewOfFile(transport_);
            transport_ = nullptr;
        }
        if (mapping_ != nullptr) {
            CloseHandle(mapping_);
            mapping_ = nullptr;
        }
        mappingName_.clear();
        processAlive_.store(false, std::memory_order_release);
    }

    [[nodiscard]] bool isReady() const noexcept {
        return transport_ != nullptr && transport_->status.load(std::memory_order_acquire) == HostStatus::ready &&
            processAlive_.load(std::memory_order_acquire);
    }

    [[nodiscard]] SharedTransport* transport() noexcept { return transport_; }
    [[nodiscard]] const SharedTransport* transport() const noexcept { return transport_; }

    [[nodiscard]] bool trySend(
        const std::uint64_t sequence,
        const std::span<const float> samples,
        const std::uint32_t frameCount,
        const std::uint64_t projectFrame,
        const std::uint64_t steadyTime) noexcept {
        if (!isReady()) return false;
        if (transport_->input.tryPush(sequence, samples, frameCount, projectFrame, steadyTime)) return true;
        transport_->inputOverruns.fetch_add(1, std::memory_order_relaxed);
        return false;
    }

    [[nodiscard]] bool tryReceive(AudioBlock& block) noexcept {
        return isReady() && transport_->output.tryPop(block);
    }

private:
    [[nodiscard]] static std::filesystem::path currentDirectory() {
        std::array<wchar_t, 32'768> path{};
        const auto length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
        if (length == 0 || length >= path.size()) return {};
        return std::filesystem::path(std::wstring(path.data(), length)).parent_path();
    }

    [[nodiscard]] static std::wstring lowerExtension(std::wstring extension) {
        for (auto& character : extension) {
            if (character >= L'A' && character <= L'Z') character = static_cast<wchar_t>(character - L'A' + L'a');
        }
        return extension;
    }

    [[nodiscard]] static std::wstring quote(const std::wstring& argument) {
        std::wstring result(1, L'"');
        std::size_t backslashes = 0;
        for (const wchar_t character : argument) {
            if (character == L'\\') {
                ++backslashes;
            } else if (character == L'"') {
                result.append(backslashes * 2 + 1, L'\\');
                result.push_back(L'"');
                backslashes = 0;
            } else {
                result.append(backslashes, L'\\');
                backslashes = 0;
                result.push_back(character);
            }
        }
        result.append(backslashes * 2, L'\\');
        result.push_back(L'"');
        return result;
    }

    inline static std::atomic<std::uint32_t> nextInstanceId_{1};
    HANDLE mapping_{};
    SharedTransport* transport_{};
    PROCESS_INFORMATION process_{};
    std::wstring mappingName_;
    std::atomic<bool> processAlive_{};
    std::jthread processMonitor_;
};

} // namespace sonora::plugin

