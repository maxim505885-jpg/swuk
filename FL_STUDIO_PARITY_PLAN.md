# План инструментов SONORA относительно FL Studio

Сверка с публичной страницей функций FL Studio, проверена 25.11.2026: [FL Studio](https://www.image-line.com/fl-studio). Страница указывает 100+ встроенных инструментов/эффектов/звуков, 7-полосный параметрический EQ, Playlist, Piano Roll, MIDI и плагины VST/VST3/CLAP, несколько аудиоредакторов, time stretch, аудиозапись, MIDI hardware, Chord Generator, Loop Starter и Stem Separation.

Это сопоставление рабочих категорий, а не копирование закрытых плагинов, кода, интерфейсов или фирменных звуков Image-Line. У SONORA остаётся собственная идентичность и офлайн-первый режим. Облачные сервисы, аудиобиблиотеки по подписке, AI-ассистент/мастеринг и доставка релиза не входят в текущую локальную архитектуру.

## Текущее состояние и разрывы

| Область | SONORA сейчас | Чего не хватает для зрелого рабочего процесса |
|---|---|---|
| Arrangement / Playlist | Аудио, MIDI, drum и automation clips; grid/snap, перемещение, split, fades, zoom и tempo-aware Signalsmith stretch; редактируемые gain envelopes (Arrangement, playback, WAV, WASAPI, split и project validation); Windows UI smoke покрывает 128-клиповую Arrangement-сессию, no-op selection, trim/offset/rate и move/fade/envelope undo-redo, выравнивание курсора при масштабировании и горизонтальной прокрутке, маркеры, A–B loop, transient slicing, `.sonora` save/open и WAV export | Расширенная регрессия на больших проектах |
| Step Sequencer / Channel Rack | Страница на 16 шагов; bar navigation; длина ограничена 120-секундным рендером при текущем BPM, pattern picker и создание паттернов; velocity, row defaults, per-step probability/ratchets; сериализация, детерминированный browser/WAV/WASAPI рендер, UI smoke | Развитые channel instruments, визуальная оценка длинных реальных партий, полная приёмка физического аудио |
| Piano Roll | Редактирование MIDI нот, velocity, навигация по диапазону 0–127 и между тактами, масштабирование 75–200%, генератор 11 типов аккордов и grid quantization (1/32–1/4, 50–100% strength) | Полный сценарный acceptance; внешний MIDI input/output |
| Audio Browser / Editor | Локальные категории, импорт и preview; запись; waveform editor с неразрушающим выбором начала/конца, обрезкой, Undo/Redo и прослушиванием выбранного диапазона; ручное разделение и локальная RMS-нарезка по транзиентам; pitch shift, autotune и tempo-aware Signalsmith stretch | Warp markers, denoise/repair; оценка transient detector на реальных исходниках, ручное прослушивание stretch/autotune, длинные рендеры и измерение памяти |
| Микшер | Уровень, панорама, mute/solo, meters, automation громкости и панорамы в browser/WAV/WASAPI, persisted buses, routing dialog с назначением аудиотреков на шины, reverb/delay, семиполосный peaking EQ, компрессор, лимитер и 24-полосный спектральный анализатор | Sends с несколькими назначениями, slot-based effect chain, автоматизация параметров эффектов |
| Встроенные инструменты | Базовый синтезатор с waveform/filter/envelope/detune, presets, drum synthesis и односэмпловый MIDI sampler (WAV из проекта, root note, транспонирование, ADSR, live/offline/WASAPI) | SoundFont/SF2/SFZ workflow, зоны и слои, многотембральность, modulation, широкая библиотека и preset browser |
| Эффекты | Reverb/delay; track compressor/limiter в playback/export/WASAPI; CLAP effect только offline-render | Realtime plugin/effect graph, VST3/CLAP host, plugin UI/state/scan, saturation/distortion, chorus/flanger/phaser, transient shaping, stereo tools, frequency splitting |
| MIDI / hardware | Редактирование внутренних MIDI-клипов | Устройства MIDI input, запись, MIDI Out, CC mapping, clock/sync, hot-plug и проверка hardware round-trip |
| Запись | AudioWorklet и WASAPI paths; начало клипа рассчитывается по живым часам транспорта при старте захвата, защита от повторного старта во время подготовки; покрыто unit/regression тестами | Проверка с физическим входом, punch/loop take workflow, background audio logger и recovery после сбоя |
| Творческие инструменты | MIDI chord generator с мажорными/минорными/уменьшёнными/увеличенными/sus и септаккордовыми/нонаккордовыми формами | Loop starter и stem separation; эти функции нужно оценивать как отдельные продуктовые модули |
| Release readiness | main commit `85902df63fb20c1bddde585a02ffcdb86cb24be4` имеет проверенное дерево `900850f`; Windows CI run #45648141896 на идентичном PR #34 дереве прошёл build, 122 JavaScript-теста, 28 native-тестов, 2 CLAP-теста, smoke и x64 installer artifact | Артефакт CI ещё не установлен на пользовательском компьютере; Windows 11, DPI на целевых экранах, физические audio input/output, длинная нагрузка и ручной end-to-end acceptance остаются незавершёнными |

## Приоритет выполнения

Статус обновлён после вливания commit [`85902df`](https://github.com/maxim505885-jpg/swuk/commit/85902df63fb20c1bddde585a02ffcdb86cb24be4). Дерево `900850f` прошло полный Windows release gate [#45648141896](https://github.com/maxim505885-jpg/swuk/actions/runs/45648141896); ручная установка на Windows 11 и приёмка физических audio input/output остаются открытыми.

1. **Довести основную сессию до приёмки:** расширить acceptance для больших проектов, Arrangement/Piano Roll и воспроизведения/экспорта на реальных исходниках; оставить ручную проверку долгих мультитактовых паттернов. Сохранить существующие проверки save/open, Undo/Redo, markers, selection и детерминированных WAV assertions.
2. **Аудиомонтаж:** неразрушающая обрезка формы волны, audition выделения и transient slicing реализованы и покрыты Electron smoke; далее нужны warp markers и denoise/repair. Signalsmith stretch прошёл цифровой Windows smoke (36 000 → 45 000 кадров, 440.38 Гц); субъективное прослушивание реального вокала/транзиентов, длинные рендеры и оценка памяти остаются открытыми.
3. **Инструменты и MIDI:** sampler/SoundFont пресеты, MIDI input/output и mapping; проверка аппаратных устройств.
4. **Mixer:** buses и назначение track-to-bus реализованы и прошли Windows release gate; следующий шаг — slot-based effect chain, автоматизация параметров встроенных эффектов и sends с несколькими назначениями.
5. **Плагины:** сначала настоящий realtime CLAP host в отдельном процессе, затем VST3 после закрепления конкретного SDK commit и лицензий. Plugin crash должен оставаться за границей процесса audio engine.
6. **Дополнительные креативные блоки:** chord/loop tools, audio logger и stem separation; решать по локальным вычислительным бюджетам и лицензиям.
7. **Выпуск:** чистая Windows 11 сборка, установщик, WASAPI input/output, DPI/resolution, performance, crash/recovery, soak и документация сторонних лицензий.

## GitHub-кандидаты

Кандидаты и лицензии описаны в [обзоре GitHub-аудиокомпонентов](docs/GITHUB_AUDIO_COMPONENTS_REVIEW.md); точные версии добавленных upstream submodules указаны в [реестре аудиокомпонентов](docs/UPSTREAM_COMPONENTS.md). В проекте Signalsmith Stretch используется как основной offline time-stretch через WASM/AudioWorklet; локальный WSOLA остаётся fallback. CI проверяет длину и частоту сигнала на реальном Signalsmith runtime. Субъективная оценка на вокале и транзиентах, длительные рендеры и сравнение WASM с native playback ещё требуются.
