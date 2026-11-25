# Закреплённые аудиорепозитории SONORA

Эти репозитории добавлены как Git submodules с конкретными upstream commit SHA. Это ссылки на исходный код авторов, а не копии и не подтверждение интеграции в SONORA. Подмодули пока не входят в сборку приложения: package.json включает только текущие файлы приложения и native binaries. Каждый компонент подключается к аудиодвижку после отдельной интеграции, аудиотестов и проверки лицензии.

| Компонент | Каталог | Зафиксированный commit | Лицензия / назначение |
|---|---|---|---|
| [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) | `native/vendor/signalsmith-stretch` | `88061fd4eda56a2353c5d65c74aa3f4ccf76f9da` | MIT; основной offline time-stretch через официальный самодостаточный WASM/AudioWorklet release. Зафиксирован исходник upstream; native C++ header пока не подключён. |
| [RtMidi](https://github.com/thestk/rtmidi) | `native/vendor/rtmidi` | `00d855f31fbaeb196da2c0a3507d92f0d6051efb` | MIT-like; сохранить copyright/permission notices. Кандидат для MIDI устройств и hot-plug. |
| [FluidSynth](https://github.com/FluidSynth/fluidsynth) | `native/vendor/fluidsynth` | `5500b60788287ceb7297f628f75c488d2720f61a` | LGPL-2.1; использовать отдельной динамической библиотекой и включить notices/способ получить изменения библиотеки. SF2/SFZ контент проверяется отдельно и в репозиторий не добавлен. |
| [CLAP Host](https://github.com/free-audio/clap-host) | `native/references/clap-host` | `c8ce3ee3800fc605d31ffb077991004f26e8cb03` | MIT; только reference для host lifecycle. Это Qt приложение с дополнительными submodules, не готовый Electron/native модуль. |
| [VST3 SDK](https://github.com/steinbergmedia/vst3sdk) | `native/references/vst3sdk` | `3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96` | Upstream root license на этой версии — MIT. До распространения проверить лицензии всех SDK submodules/собранных компонентов и trademark guidelines. |

## Получение исходников

Клонировать проект с подмодулями:

```sh
git clone --recurse-submodules https://github.com/maxim505885-jpg/swuk.git
```

Или для существующей копии:

```sh
git submodule update --init
```

Обновлять зафиксированную upstream версию следует осознанно: сменить gitlink commit, проверить лицензию/зависимости и повторить тесты. PortMidi не добавлен, потому что дублирует RtMidi; JUCE и LMMS не добавлены из-за несовместимых с выбранной лицензией проекта условий.
