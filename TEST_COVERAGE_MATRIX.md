# TEST_COVERAGE_MATRIX

Последняя полная проверка: [Windows CI run #45625694716](https://github.com/maxim505885-jpg/swuk/actions/runs/45625694716), commit `e4af2373ca647fb69d11e513b6719ab4411cbdd9`, Windows `windows-latest`. Это автоматический release gate, не ручная приёмка на Windows 11.

| Область | Проверка в pipeline | Результат | Граница доказательства |
|---|---|---|---|
| JavaScript / проект / DSP | `npm test` | PASS — 114/114 | Набор модульных и регрессионных тестов; не проверяет все сценарии мышью, клавиатурой и устройствами. |
| Нативный C++ аудиомикшер | `npm run native:test` | PASS — 28 тестов | Проверяет core, маршруты, эффекты и метры в тестовом процессе. |
| CLAP offline helper | `npm run native:clap:test` | PASS — 2/2 | Стерео render и отказ для неверного бинарного файла; realtime plugin host отсутствует. |
| WASAPI/native transport smoke | `npm run native:smoke` | PASS — 1/1 | Проверяет запуск, transport и цифровую тишину. Не доказывает слышимый выход или работу физического входа. |
| Signalsmith stretch | `npm run qa:signalsmith` | PASS — 36 000 → 45 000 кадров; 440.38 Hz, RMS 0.494 | Синтетический сигнал в Electron; вокал и сложный реальный материал не оценены на слух. |
| Electron UI smoke | `npm run qa:ui-smoke` | PASS | Покрыты Piano Roll, sampler, drum probability/ratchets, многотактовый sequencer и recovery старого паттерна, Arrangement, split/slicing, EQ, compressor/limiter, undo/redo, project round-trip, WAV export и loop. Это не полный обход 46 элементов UI inventory. |
| Windows x64 installer | `npm run build:win` | PASS — NSIS installer собран и опубликован как CI artifact | CI-сборка не подписана сертификатом издателя и не была установлена вручную на этом компьютере. |
| UI responsive/accessibility | Визуальный/клавиатурный аудит всех тем, размеров и состояний | NOT TESTED как полный критерий | См. точечные статусы и доказательства в `UI_INVENTORY.json`; автоснимки не прикреплены к этому gate. |
| Нагрузка и стабильность | `npm run qa:load`, `npm run qa:stability` | NOT RUN в этом release gate | Текущий CI не выполняет эти отдельные сценарии. |
| Реальный аудиовход/выход | Windows 11 с доступными устройствами | NOT TESTED | Требуется слышимый hardware output и физический вход/запись. |

## Повторяемые команды

- Полный Windows gate: `npm run build:win`.
- Быстрый регрессионный набор: `npm run qa:quick`.
- Раздельные профили: `npm run qa:audio`, `npm run qa:plugin`, `npm run qa:load`, `npm run qa:stability`.
- Hardware output — opt-in: `npm run qa:hardware-output`. Он не заменяет ручную проверку физического устройства.

Не считать этот файл заявлением о полном acceptance. Связанные статусы: `QA_MASTER_PLAN.md`, `BUG_REGISTER.md`, `UI_INVENTORY.json` и `FL_STUDIO_PARITY_PLAN.md`.
