# План инструментов SONORA относительно FL Studio

Сверка с публичной страницей функций FL Studio, проверена 25.11.2026: [FL Studio](https://www.image-line.com/fl-studio). Страница указывает 100+ встроенных инструментов/эффектов/звуков, 7-полосный параметрический EQ, Playlist, Piano Roll, MIDI и плагины VST/VST3/CLAP, несколько аудиоредакторов, time stretch, аудиозапись, MIDI hardware, Chord Generator, Loop Starter и Stem Separation.

Это сопоставление рабочих категорий, а не копирование закрытых плагинов, кода, интерфейсов или фирменных звуков Image-Line. У SONORA остаётся собственная идентичность и офлайн-первый режим. Облачные сервисы, аудиобиблиотеки по подписке, AI-ассистент/мастеринг и доставка релиза не входят в текущую локальную архитектуру.

## Текущее состояние и разрывы

| Область | SONORA сейчас | Чего не хватает для зрелого рабочего процесса |
|---|---|---|
| Arrangement / Playlist | Аудио, MIDI, drum и automation clips; grid/snap, перемещение, split, fades, zoom и tempo-aware Signalsmith stretch; редактируемые gain envelopes (Arrangement, playback, WAV, WASAPI, split и project validation); Windows UI smoke покрывает 128-клиповую Arrangement-сессию, no-op selection, trim/offset/rate и move/fade/envelope undo-redo, выравнивание курсора при масштабировании и горизонтальной прокрутке, маркеры, A–B loop, transient slicing, `.sonora` save/open и WAV export | Расширенная регрессия на больших проектах |
| Step Sequencer / Channel Rack | 16 шагов, паттерны ударных, velocity | Развитые channel instruments, step probability/ratchets, полная UI-аудио регрессия, удобная работа с несколькими паттернами |
| Piano Roll | Редактирование MIDI нот, velocity, клавиатурная навигация по диапазону 0–127 | Выразительные инструменты редактирования/квантизации, масштабирование и полный сценарный acceptance; внешний MIDI input/output |
| Audio Browser / Editor | Локальные категории, импорт, preview, waveform, запись, ручное разделение и локальная RMS-нарезка клипа по транзиентам; pitch shift, autotune и tempo-aware Signalsmith stretch | Полноценный waveform editor, warp markers, denoise/repair; оценка детектора на реальных исходниках, ручное прослушивание stretch, длинные рендеры и память |
| Микшер | Уровень, панорама, mute/solo, meters, automation громкости и панорамы в browser/WAV/WASAPI, persisted buses, routing dialog с назначением аудиотреков на шины, reverb/delay, семиполосный peaking EQ, компрессор, лимитер и 24-полосный спектральный анализатор | Sends с несколькими назначениями, slot-based effect chain, автоматизация параметров эффектов |
| Встроенные инструменты | Базовый синтезатор с waveform/filter/envelope/detune, presets и drum synthesis | Полноценный sampler/SF2/SFZ workflow, многослойные/многотембральные инструменты, modulation, широкая библиотека и preset browser |
| Эффекты | Reverb/delay; track compressor/limiter в playback/export/WASAPI; CLAP effect только offline-render | Realtime plugin/effect graph, VST3/CLAP host, plugin UI/state/scan, saturation/distortion, chorus/flanger/phaser, transient shaping, stereo tools, frequency splitting |
| MIDI / hardware | Редактирование внутренних MIDI-клипов | Устройства MIDI input, запись, MIDI Out, CC mapping, clock/sync, hot-plug и проверка hardware round-trip |
| Запись | AudioWorklet и WASAPI recording paths | Проверка с физическим входом, punch/loop take workflow, background audio logger и recovery после сбоя |
| Творческие инструменты | Ручное составление паттернов и MIDI | Chord generator, loop starter, stem separation; эти функции нужно оценивать как отдельные продуктовые модули |
| Release readiness | Electron app с собственной SVG-иконкой в Windows EXE/установщике, native WASAPI engine, локальные тесты и x64 package с прошедшим CI release gate | Текущий исходник не пересобран/не установлен, host — Windows 10, Windows 11 acceptance, DPI, hardware, длительная нагрузка и полный end-to-end release gate |

## Приоритет выполнения

1. **Довести основную сессию до приёмки:** безопасный проект save/open, Undo/Redo, import/export, markers, selection, браузерные сценарии Arrangement/Step Sequencer/Piano Roll; детерминированные WAV assertions.
2. **Аудиомонтаж:** waveform editor, slicing/transient workflow; Signalsmith stretch уже проверен на Windows в скрытом Electron smoke (36 000 → 45 000 кадров, 440.38 Гц), остаются прослушивание реального вокала/транзиентов, длинные рендеры и оценка памяти.
3. **Инструменты и MIDI:** sampler/SoundFont пресеты, MIDI input/output и mapping; проверка аппаратных устройств.
4. **Mixer:** buses и назначение track-to-bus реализованы и прошли Windows release gate; следующий шаг — slot-based effect chain, автоматизация параметров встроенных эффектов и sends с несколькими назначениями.
5. **Плагины:** сначала настоящий realtime CLAP host в отдельном процессе, затем VST3 после закрепления конкретного SDK commit и лицензий. Plugin crash должен оставаться за границей процесса audio engine.
6. **Дополнительные креативные блоки:** chord/loop tools, audio logger и stem separation; решать по локальным вычислительным бюджетам и лицензиям.
7. **Выпуск:** чистая Windows 11 сборка, установщик, WASAPI input/output, DPI/resolution, performance, crash/recovery, soak и документация сторонних лицензий.

## GitHub-кандидаты

Кандидаты и лицензии описаны в [обзоре GitHub-аудиокомпонентов](docs/GITHUB_AUDIO_COMPONENTS_REVIEW.md); точные версии добавленных upstream submodules указаны в [реестре аудиокомпонентов](docs/UPSTREAM_COMPONENTS.md). В проекте Signalsmith Stretch используется как основной offline time-stretch через WASM/AudioWorklet; локальный WSOLA остаётся fallback. CI проверяет длину и частоту сигнала на реальном Signalsmith runtime. Субъективная оценка на вокале и транзиентах, длительные рендеры и сравнение WASM с native playback ещё требуются.
