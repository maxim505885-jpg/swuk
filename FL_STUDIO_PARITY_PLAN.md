# План инструментов SONORA относительно FL Studio

Сверка с публичной страницей функций FL Studio, проверена 25.11.2026: [FL Studio](https://www.image-line.com/fl-studio). Страница указывает 100+ встроенных инструментов/эффектов/звуков, 7-полосный параметрический EQ, Playlist, Piano Roll, MIDI и плагины VST/VST3/CLAP, несколько аудиоредакторов, time stretch, аудиозапись, MIDI hardware, Chord Generator, Loop Starter и Stem Separation.

Это сопоставление рабочих категорий, а не копирование закрытых плагинов, кода, интерфейсов или фирменных звуков Image-Line. У SONORA остаётся собственная идентичность и офлайн-первый режим. Облачные сервисы, аудиобиблиотеки по подписке, AI-ассистент/мастеринг и доставка релиза не входят в текущую локальную архитектуру.

## Текущее состояние и разрывы

| Область | SONORA сейчас | Чего не хватает для зрелого рабочего процесса |
|---|---|---|
| Arrangement / Playlist | Частичная работа с аудио, MIDI, drum и automation clips; grid/snap, перемещение, split и fades | Верифицированные marker/selection сценарии, клиповая огибающая, slicing, tempo-aware time stretch, полный save/open/export и undo acceptance |
| Step Sequencer / Channel Rack | 16 шагов, паттерны ударных, velocity | Развитые channel instruments, step probability/ratchets, полная UI-аудио регрессия, удобная работа с несколькими паттернами |
| Piano Roll | Редактирование MIDI нот, velocity, клавиатурная навигация по диапазону 0–127 | Выразительные инструменты редактирования/квантизации, масштабирование и полный сценарный acceptance; внешний MIDI input/output |
| Audio Browser / Editor | Локальные категории, импорт, preview, waveform, запись; pitch shift и autotune math | Полноценные waveform editor операции, transient/slice workflow, timestretch/warp, denoise/repair, tuner/phase acceptance на реальном аудио |
| Микшер | Уровень, панорама, mute/solo, meters, volume automation, reverb/delay и одна peaking EQ полоса в браузерном/WAV и native source path | Семиполосный EQ с анализатором, compressor/limiter, sends/buses, routing matrix, slot-based effect chain, parameter automation |
| Встроенные инструменты | Базовый синтезатор с waveform/filter/envelope/detune, presets и drum synthesis | Полноценный sampler/SF2/SFZ workflow, многослойные/многотембральные инструменты, modulation, широкая библиотека и preset browser |
| Эффекты | Reverb/delay; CLAP effect только offline-render | Realtime plugin/effect graph, VST3/CLAP host, plugin UI/state/scan, компрессор/лимитер, saturation/distortion, chorus/flanger/phaser, transient shaping, stereo tools, frequency splitting |
| MIDI / hardware | Редактирование внутренних MIDI-клипов | Устройства MIDI input, запись, MIDI Out, CC mapping, clock/sync, hot-plug и проверка hardware round-trip |
| Запись | AudioWorklet и WASAPI recording paths | Проверка с физическим входом, punch/loop take workflow, background audio logger и recovery после сбоя |
| Творческие инструменты | Ручное составление паттернов и MIDI | Chord generator, loop starter, stem separation; эти функции нужно оценивать как отдельные продуктовые модули |
| Release readiness | Electron app, native WASAPI engine, локальные тесты и прошлые x64 packages | Текущий исходник не пересобран/не установлен, host — Windows 10, Windows 11 acceptance, DPI, hardware, длительная нагрузка и полный end-to-end release gate |

## Приоритет выполнения

1. **Довести основную сессию до приёмки:** безопасный проект save/open, Undo/Redo, import/export, markers, selection, браузерные сценарии Arrangement/Step Sequencer/Piano Roll; детерминированные WAV assertions.
2. **Аудиомонтаж:** waveform editor, slicing/transient workflow и tempo-aware stretch с сохранением длительности/тона; сопоставить Web Audio render и WASAPI output.
3. **Инструменты и MIDI:** sampler/SoundFont пресеты, MIDI input/output и mapping; проверка аппаратных устройств.
4. **Mixer:** довести EQ до семи полос, добавить spectrum view и parameter automation; затем компрессор/лимитер, distortion, modulation и send/bus routing.
5. **Плагины:** сначала настоящий realtime CLAP host в отдельном процессе, затем VST3 после закрепления конкретного SDK commit и лицензий. Plugin crash должен оставаться за границей процесса audio engine.
6. **Дополнительные креативные блоки:** chord/loop tools, audio logger и stem separation; решать по локальным вычислительным бюджетам и лицензиям.
7. **Выпуск:** чистая Windows 11 сборка, установщик, WASAPI input/output, DPI/resolution, performance, crash/recovery, soak и документация сторонних лицензий.

## GitHub-кандидаты

Кандидаты и лицензионные замечания собраны в [обзоре GitHub-аудиокомпонентов](docs/GITHUB_AUDIO_COMPONENTS_REVIEW.md). Код не скачивался и не добавлялся в проект в ходе этой сверки. Рекомендуемый следующий внешний компонент для прототипа — Signalsmith Stretch для time-stretch/pitch; сначала проверить latency, качество на вокале/транзиентах и полное лицензирование его FFT/submodule зависимостей.
