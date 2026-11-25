# TEST_COVERAGE_MATRIX

Текущее main-дерево commit `09d3635a` совпадает с проверенным PR-head, для которого прошёл полный Windows release gate [#45630452982](https://github.com/maxim505885-jpg/swuk/actions/runs/45630452982). Отдельные benchmark-метрики приведены по [run #45629167866](https://github.com/maxim505885-jpg/swuk/actions/runs/45629167866). Это автоматические проверки на Windows `windows-latest`, не ручная приёмка на Windows 11.

| Область | Проверка в pipeline | Результат | Граница доказательства |
|---|---|---|---|
| JavaScript / проект / DSP | `npm test` | PASS — 114/114 | Набор модульных и регрессионных тестов; не проверяет все сценарии мышью, клавиатурой и устройствами. |
| Нативный C++ аудиомикшер | `npm run native:test` | PASS — 28 тестов | Проверяет core, маршруты, эффекты и метры в тестовом процессе. |
| CLAP offline helper | `npm run native:clap:test` | PASS — 2/2 | Стерео render и отказ для неверного бинарного файла; realtime plugin host отсутствует. |
| WASAPI/native transport smoke | `npm run native:smoke` | PASS — 1/1 | Проверяет запуск, transport и цифровую тишину. Не доказывает слышимый выход или работу физического входа. |
| Signalsmith stretch | `npm run qa:signalsmith` | PASS — 36 000 → 45 000 кадров; 440.38 Hz, RMS 0.494 | Синтетический сигнал в Electron; вокал и сложный реальный материал не оценены на слух. |
| Electron UI smoke | `npm run qa:ui-smoke` | PASS — Windows run #45643005661 | Покрыты Piano Roll, sampler, drum probability/ratchets, многотактовый sequencer и recovery старого паттерна, Arrangement, split/slicing, crop waveform с Undo/Redo и audition выделения, EQ, compressor/limiter, project round-trip, WAV export и loop. Это не полный обход всех элементов UI inventory и не подтверждение слышимого hardware output. |
| Windows x64 installer | `npm run build:win` | PASS — NSIS installer собран и опубликован как CI artifact | CI-сборка не подписана сертификатом издателя и не была установлена вручную на этом компьютере. |
| UI responsive/accessibility | Визуальный/клавиатурный аудит всех тем, размеров и состояний | NOT TESTED как полный критерий | См. точечные статусы и доказательства в `UI_INVENTORY.json`; автоснимки не прикреплены к этому gate. |
| Нативная нагрузка ядра | `npm run qa:load` | PASS — run #45629167866: p95 340.8 мкс (128 клипов), 426.7 мкс (128 клипов + meters), 61.6 мкс (8 дорожек + reverb/delay) | Синтетический C++ mixer benchmark на `windows-latest`; порог не задан, Electron/UI/underruns не измеряются. |
| Soak и стабильность приложения | `npm run qa:stability` | NOT RUN в этом release gate | 2-минутный WASAPI silent soak остаётся отдельным; тест реального проекта и физического устройства не выполнялся. |
| Реальный аудиовход/выход | Windows 11 с доступными устройствами | NOT TESTED | Требуется слышимый hardware output и физический вход/запись. |

## Повторяемые команды

- Полный Windows gate: `npm run build:win`.
- Быстрый регрессионный набор: `npm run qa:quick`.
- Раздельные профили: `npm run qa:audio`, `npm run qa:plugin`, `npm run qa:load` (native mixer microbenchmark входит в Windows release gate), `npm run qa:stability`.
- Hardware output — opt-in: `npm run qa:hardware-output`. Он не заменяет ручную проверку физического устройства.

Не считать этот файл заявлением о полном acceptance. Связанные статусы: `QA_MASTER_PLAN.md`, `BUG_REGISTER.md`, `UI_INVENTORY.json` и `FL_STUDIO_PARITY_PLAN.md`.
