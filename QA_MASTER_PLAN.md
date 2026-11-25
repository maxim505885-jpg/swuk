# QA_MASTER_PLAN

Дата сверки: 25.11.2026. Источник проекта: GitHub `main`.

## Текущий вердикт

**Частичная готовность, не 100%.** Автоматический Windows release gate проходит; ручная установка/приёмка Windows 11 и аппаратный звук не подтверждены. Неизвестные проверки остаются `NOT TESTED`, а не `PASS`.

Последний проверенный Windows release gate для PR #37 — [run #45658946297](https://github.com/maxim505885-jpg/swuk/actions/runs/45658946297): 130 JavaScript-тестов, 28 native-тестов, 2 CLAP-теста, native smoke, Electron UI smoke и x64 installer artifact прошли. Это доказывает автоматическую сборку и смоделированные сценарии, но не ручную приёмку Windows 11 и не физический MIDI round-trip. Сводка и границы — в [матрице покрытия](TEST_COVERAGE_MATRIX.md).

## Приоритеты перед выпуском

1. **Приёмка целевой ОС:** чистая установка x64 сборки на Windows 11, запуск после установки, перезапуск, сохранение/открытие проекта и WAV export. Проверить SmartScreen; installer не подписан.
2. **Реальный аудиотракт:** слышимый сигнал через выбранный WASAPI output; записать тестовый сигнал с доступного физического input, проверить сохранённый клип и экспорт.
3. **Рабочая сессия и устойчивость:** длинный проект с импортированными аудио, несколькими drum/MIDI партиями, шинами и эффектами; измерить RAM, поведение при seek/loop, остановку/повторный запуск и длинный проигрыш.
4. **Интерфейс:** пройти все темы, доступные разрешения и DPI; клавиатурный поток, видимый focus, контраст, пустые/ошибочные состояния. Точечные проверки не закрывают всю инвентаризацию.
5. **Функциональные разрывы ТЗ:** crop/audition waveform editor и transient slicing уже реализованы; warp/denoise, richer sample instruments и realtime plugin host остаются открытыми; MIDI input, live monitor и запись note-on/note-off в клипы реализованы частично, а внешний MIDI playback, CC/clock, hot-plug и физическая проверка остаются открытыми по [плану совместимости](FL_STUDIO_PARITY_PLAN.md).

## Gate map

| Gate | Сейчас |
|---|---|
| Windows CI build, tests and x64 package | PASS, exact main tree/run above |
| Deterministic project validation, DSP and renderer tests | PASS in automated suite |
| Electron smoke for representative user flows | PASS; scope listed in `TEST_COVERAGE_MATRIX.md` |
| Native mixer synthetic load benchmark | PASS; PR #37 release gate #45658946297 includes it; benchmark metrics from #45629167866; native core only |
| Physical Windows 11 install and audible WASAPI output | NOT TESTED |
| Physical microphone/input recording | NOT TESTED |
| MIDI controller input/output round-trip and recorded take | NOT TESTED |
| Full visual/accessibility audit at every target viewport/theme | NOT TESTED |
| Soak/load and memory limits on long real projects | NOT RUN |

Перед заявлением о выпуске каждую строку `NOT TESTED`/`NOT RUN` нужно либо закрыть доказательством на целевой системе, либо явно исключить из конкретной версии с указанием причины и влияния. Текущие функциональные разрывы нельзя закрыть одной зелёной сборкой.

## Связанные записи

- [Матрица тестового покрытия](TEST_COVERAGE_MATRIX.md)
- [Реестр дефектов и рисков приёмки](BUG_REGISTER.md)
- [Инвентаризация UI](UI_INVENTORY.json)
- [План совместимости с FL Studio](FL_STUDIO_PARITY_PLAN.md)
