# План инструментов SONORA относительно FL Studio

Сверка с публичной страницей функций FL Studio, проверена 25.11.2026: [FL Studio](https://www.image-line.com/fl-studio). Страница указывает 100+ встроенных инструментов/эффектов/звуков, 7-полосный параметрический EQ, Playlist, Piano Roll, MIDI и плагины VST/VST3/CLAP, несколько аудиоредакторов, time stretch, аудиозапись, MIDI hardware, Chord Generator, Loop Starter и Stem Separation.

Это сопоставление рабочих категорий, а не копирование закрытых плагинов, кода, интерфейсов или фирменных звуков Image-Line. У SONORA остаётся собственная идентичность и офлайн-первый режим. Облачные сервисы, аудиобиблиотеки по подписке, AI-ассистент/мастеринг и доставка релиза не входят в текущую локальную архитектуру.

## Текущее состояние и разрывы

| Область | SONORA сейчас | Чего не хватает для зрелого рабочего процесса |
|---|---|---|
| Arrangement / Playlist | Аудио, MIDI, drum и automation clips; grid/snap, перемещение, split, fades, zoom и tempo-aware Signalsmith stretch; редактируемые gain envelopes (Arrangement, playback, WAV, WASAPI, split и project validation); Windows UI smoke покрывает 128-клиповую Arrangement-сессию, no-op selection, trim/offset/rate и move/fade/envelope undo-redo, выравнивание курсора при масштабировании и горизонтальной прокрутке, маркеры, A–B loop, transient slicing, `.sonora` save/open и WAV export | Расширенная регрессия на больших проектах |
| Step Sequencer / Channel Rack | Страница на 16 шагов; bar navigation; длина ограничена 120-секундным рендером при текущем BPM, pattern picker и создание паттернов; velocity, row defaults, per-step probability/ratchets; сериализация, детерминированный browser/WAV/WASAPI рендер, UI smoke | Развитые channel instruments, визуальная оценка длинных реальных партий, полная приёмка физического аудио |
| Piano Roll | Редактирование MIDI нот, velocity, навигация по диапазону 0–127 и между тактами, масштабирование 75–200%, генератор 11 типов аккордов и grid quantization (1/32–1/4, 50–100% strength) | Полный сценарный acceptance; внешний MIDI input/output |
| Audio Browser / Editor | Локальные категории, импорт, preview, waveform, запись, ручное разделение и локальная RMS-нарезка клипа по транзиентам; pitch shift, autotune и tempo-aware Signalsmith stretch | Полноценный waveform editor, warp markers, denoise/repair; оценка детектора на реальных исходниках, ручное прослушивание stretch, длинные рендеры и память |
| Микшер | Уровень, панорама, mute/solo, meters, automation громкости и панорамы в browser/WAV/WASAPI, persisted buses, routing dialog с назначением аудиотреков на шины, reverb/delay, семиполосный peaking EQ, компрессор, лимитер и 24-полосный спектральный анализатор | Sends с несколькими назначениями, slot-based effect chain, автоматизация параметров эффектов |
| Встроенные инструменты | Базовый синтезатор с waveform/filter/envelope/detune, presets, drum synthesis и односэмпловый MIDI sampler (WAV из проекта, root note, транспонирование, ADSR, live/offline/WASAPI) | SoundFont/SF2/SFZ workflow, зоны и слои, многотембральность, modulation, широкая библиотека и preset browser |
| Эффекты | Reverb/delay; track compressor/limiter в playback/export/WASAPI; CLAP effect только offline-render | Realtime plugin/effect graph, VST3/CLAP host, plugin UI/state/scan, saturation/distortion, chorus/flanger/phaser, transient shaping, stereo tools, frequency splitting |
| MIDI / hardware | Редактирование внутренних MIDI-клипов | Устройства MIDI input, запись, MIDI Out, CC mapping, clock/sync, hot-plug и проверка hardware round-trip |
| Запись | AudioWorklet и WASAPI recording paths | Проверка с физическим входом, punch/loop take workflow, background audio logger и recovery после сбоя |
| Творческие инструменты | MIDI chord generator с мажорными/минорными/уменьшёнными/увеличенными/sus и септаккордовыми/нонаккордовыми формами | Loop starter и stem separation; эти функции нужно оценивать как отдельные продуктовые модули |
| Release readiness | main commit ecbfc15 прошёл Windows CI run #45621426854: 114 Node, 28 native core, 2 CLAP tests, native/WASAPI smoke, Signalsmith audio smoke, Electron UI smoke и x64 installer artifact | Артефакт не установлен и не открыт на пользовательском компьютере; Windows 11, DPI на целевых экранах, физические audio input/output, длинная нагрузка и ручной end-to-end acceptance остаются незавершёнными |

## Приоритет выполнения

Статус обновлён после Windows CI run [#45621426854](https://github.com/maxim505885-jpg/swuk/actions/runs/45621426854), commit ecbfc15c5a69a4ce01c7a57722a833a34c287c0c. Build and automated release gate passed; manual Windows 11 and physical-device acceptance remain open.

1. **Довести основную сессию до приёмки:** расширить acceptance для больших проектов, Arrangement/Piano Roll и воспроизведения/экспорта на реальных исходниках; оставить ручную проверку долгих мультитактовых паттернов. Сохранить существующие проверки save/open, Undo/Redo, markers, selection и детерминированных WAV assertions.
2. **Аудиомонтаж:** waveform editor, slicing/transient workflow; Signalsmith stretch уже проверен на Windows в скрытом Electron smoke (36 000 → 45 000 кадров, 440.38 Гц), остаются прослушивание реального вокала/транзиентов, длинные рендеры и оценка памяти.
3. **Инструменты и MIDI:** sampler/SoundFont пресеты, MIDI input/output и mapping; проверка аппаратных устройств.
4. **Mixer:** buses и назначение track-to-bus реализованы и прошли Windows release gate; следующий шаг — slot-based effect chain, автоматизация параметров встроенных эффектов и sends с несколькими назначениями.
5. **Плагины:** сначала настоящий realtime CLAP host в отдельном процессе, затем VST3 после закрепления конкретного SDK commit и лицензий. Plugin crash должен оставаться за границей процесса audio engine.
6. **Дополнительные креативные блоки:** chord/loop tools, audio logger и stem separation; решать по локальным вычислительным бюджетам и лицензиям.
7. **Выпуск:** чистая Windows 11 сборка, установщик, WASAPI input/output, DPI/resolution, performance, crash/recovery, soak и документация сторонних лицензий.

## GitHub-кандидаты

Кандидаты и лицензии описаны в [обзоре GitHub-аудиокомпонентов](docs/GITHUB_AUDIO_COMPONENTS_REVIEW.md); точные версии добавленных upstream submodules указаны в [реестре аудиокомпонентов](docs/UPSTREAM_COMPONENTS.md). В проекте Signalsmith Stretch используется как основной offline time-stretch через WASM/AudioWorklet; локальный WSOLA остаётся fallback. CI проверяет длину и частоту сигнала на реальном Signalsmith runtime. Субъективная оценка на вокале и транзиентах, длительные рендеры и сравнение WASM с native playback ещё требуются.
