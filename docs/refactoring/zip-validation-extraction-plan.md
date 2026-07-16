# План: безопасная декомпозиция ZIP-валидации

Статус: **PLAN MODE — код не изменяется до подтверждения.**
Цель: вынести низкоуровневый ZIP-анализ и validation из `src/main/index.ts` (2607 строк)
в изолированный, unit-тестируемый модуль **без изменения поведения**.

Дата анализа: 2026-07-16. Базовая ревизия: `main` @ `e5c1991`.

---

## 0. Итог анализа в одну строку

Самая безопасная граница — вынести **движок чтения ZIP** (`findZipEntry` + magic + лимиты +
типы + чистые vst3-хелперы), но **оставить `assertZipUploadContent` в `index.ts`**. Причина:
`assertZipUploadContent` завязан на content-magic (`isAudioBuffer`, `isFlpBuffer`,
`isVstPresetMagic`, `isFxpMagic`, `AUDIO_FILE_EXTS`) и на `isPeMagic` из `antivirus.ts`.
`antivirus.ts` тянет `electron` и `supabase`. Если утащить `assertZipUploadContent` в новый
модуль — он импортирует либо `index.ts` (→ **циклический импорт**), либо `antivirus.ts`
(→ модуль перестаёт быть unit-тестируемым без Electron). Оставив его на месте, новый модуль
получает зависимости **только `fs` + `yauzl`** и тестируется с реальными временными ZIP.

Это отклонение от предложенной структуры сделано осознанно и разрешено ТЗ
(«Структура предварительная: измени её, если анализ зависимостей покажет более безопасную
границу»), по аналогии с тем, как ТЗ уже разрешает отложить `makeZipExtractionGuard`.

---

## 1. Точный scope

### Переносится в новый модуль (PR-1)

| Символ | Строка сейчас | Тип | Куда |
|---|---|---|---|
| `ZIP_MAGIC_VALUES` | 375 | const (Set) | `zip-validation.ts` (internal) |
| `MAX_EXTRACTED_FILES` | 383 | const | `zip-validation.ts` (export) |
| `MAX_SINGLE_FILE_BYTES` | 384 | const | `zip-validation.ts` (export) |
| `MAX_TOTAL_UNCOMPRESSED_BYTES` | 385 | const | `zip-validation.ts` (export) |
| `ZIP_CONTENT_PEEK_BYTES` | 572 | const | `zip-validation.ts` (export для тестов) |
| `extFromPath` | 443 | pure fn | `zip-validation.ts` (export) |
| `readMagicBytes` | 447 | fs fn | `zip-validation.ts` (export) |
| `isZipMagic` | 469 | pure fn | `zip-validation.ts` (export) |
| `isInsideVst3Bundle` | 559 | pure fn | `zip-validation.ts` (export) |
| `isVst3ZipEntryMatch` | 711 | pure fn | `zip-validation.ts` (export) |
| `findZipEntry` | 585 | async fn (yauzl) | `zip-validation.ts` (export) |
| `zipHasVst3` | 716 | async fn | `zip-validation.ts` (export) |
| `ZipContentEntry` | 563 | interface | `archive-types.ts` (export) |

### Остаётся в `index.ts` (осознанно, для безопасной границы)

| Символ | Строка | Почему остаётся |
|---|---|---|
| `assertZipUploadContent` | 720 | Завязан на content-magic + `isPeMagic` (`antivirus.ts` → electron/supabase). Перенос → цикл или потеря тестируемости. Импортирует `findZipEntry`/`isVst3ZipEntryMatch` из нового модуля. |
| `makeZipExtractionGuard` | 397 | ТЗ разрешает отложить: неотделим от фактической распаковки (`installVst3FromZip`, `extractZip`). Будет **импортировать** `MAX_*` из нового модуля (single source of truth). |
| `ZipEntryLike` | 387 | Используется только `makeZipExtractionGuard`. Едет вместе с ним в будущем PR. |
| `isRarMagic`, `RAR4_MAGIC`, `RAR5_MAGIC` | 376,377,473 | Не ZIP-специфичны (RAR-ветка `validateUploadedFile`). |
| `isImageMagic`, `IMAGE_FILE_EXTS` | 478,373 | Иконки (`validateIconFile`), вне ZIP. |
| content-magic: `isFlpBuffer`, `isAudioBuffer`, `wavDurationSec`, `isVstPresetMagic`, `isFxpMagic`, `AUDIO_FILE_EXTS` | 533,537,814,551,555,372 | Общие для ZIP- и не-ZIP-путей (`assertDirectUploadContent`, `validateAudioPreviewFile`, IPC beat-preview 2211/2447). Перенос расширил бы blast radius на out-of-scope. |
| `validateUploadedFile`, `validateIconFile`, `validateAudioPreviewFile`, `assertDirectUploadContent`, `validateUploadContent`, `assertNonEmptyRegularFile`, `formatBytes` | — | Оркестрация загрузки/IPC, вне scope. |

### Вне scope (не трогаем вообще)

`download-file.ts`, `download-safety.ts`, `antivirus.ts`, VirusTotal/`vt-proxy`, карантин,
`installVst3FromZip`, фактическая распаковка, IPC-handlers, `preload`, auth/referral/streak/
taste/chat, Supabase, Renderer, `444.bat`.

---

## 2. Dependency graph переносимого ядра

```
readMagicBytes ──(fs: openSync/readSync/closeSync)
extFromPath ─────(pure string)
ZIP_MAGIC_VALUES ─(const)
     │
isZipMagic ──────► ZIP_MAGIC_VALUES
isInsideVst3Bundle ─(pure string)
     │
isVst3ZipEntryMatch ─► isInsideVst3Bundle, ZipContentEntry
     │
findZipEntry ────► isZipMagic, readMagicBytes, extFromPath,
                   MAX_EXTRACTED_FILES, MAX_SINGLE_FILE_BYTES,
                   MAX_TOTAL_UNCOMPRESSED_BYTES, ZIP_CONTENT_PEEK_BYTES,
                   ZipContentEntry, yauzl
     │
zipHasVst3 ──────► findZipEntry, isVst3ZipEntryMatch
```

Внешние зависимости нового модуля: **только `fs` и `yauzl`** (+ типы). Нет `electron`,
`supabase`, `antivirus`, content-magic. Граф ацикличен; направление импорта строго
`index.ts → zip-validation.ts → archive-types.ts`.

### Обратные рёбра (что `index.ts` начнёт импортировать)

- `findZipEntry` — из `assertZipUploadContent` (726/738/749/760) и `zipHasVst3` (переехал).
- `isVst3ZipEntryMatch` — из `assertZipUploadContent` (727).
- `zipHasVst3` — из install-флоу (1120).
- `readMagicBytes` — `validateUploadedFile` (497), `validateIconFile` (515).
- `isZipMagic` — `validateUploadedFile` (503).
- `extFromPath` — `validateUploadedFile` (491) + IPC (2167).
- `MAX_EXTRACTED_FILES` / `MAX_SINGLE_FILE_BYTES` / `MAX_TOTAL_UNCOMPRESSED_BYTES` —
  `makeZipExtractionGuard` (403/407/411).
- `ZipContentEntry` — типы колбэков в `assertZipUploadContent`.

Проверено grep-ом по `src/main/!(index).ts`: **никакой другой файл main этих символов не
использует** — блокирующих внешних потребителей нет.

---

## 3. Константы = security policy

Часть политики защиты (менять запрещено, переносим значение 1:1):

- `MAX_EXTRACTED_FILES = 10_000` — анти-DoS по числу записей.
- `MAX_SINGLE_FILE_BYTES = 4 GiB` — лимит одной записи (по объявленному размеру).
- `MAX_TOTAL_UNCOMPRESSED_BYTES = 4 GiB` — анти-zip-bomb по суммарному uncompressed.
- `ZIP_MAGIC_VALUES = {504b0304, 504b0506, 504b0708}` — fail-closed по magic.
- `ZIP_CONTENT_PEEK_BYTES = 1 MiB` — сколько байт записи буферизуем для проверки magic.

**Критично (single source of truth):** три `MAX_*` дублируются как enforcement в двух местах —
`findZipEntry` (inline, скан central directory) и `makeZipExtractionGuard` (onEntry при
распаковке). Значения — одни. После переноса `makeZipExtractionGuard` **обязан импортировать**
их из `zip-validation.ts`, а не переопределять. Иначе появится второй source of truth.

---

## 4. Публичный API нового модуля (минимальный)

### `src/main/archive/archive-types.ts`
```ts
export interface ZipContentEntry {
  relativePath: string
  ext: string
  size: number
}
```

### `src/main/archive/zip-validation.ts`
```ts
// security-policy limits
export const MAX_EXTRACTED_FILES: number
export const MAX_SINGLE_FILE_BYTES: number
export const MAX_TOTAL_UNCOMPRESSED_BYTES: number
export const ZIP_CONTENT_PEEK_BYTES: number

// byte/path primitives
export function extFromPath(value: string): string
export function readMagicBytes(filePath: string, length?: number): Buffer
export function isZipMagic(buffer: Buffer): boolean

// vst3 matching (pure)
export function isInsideVst3Bundle(relativePath: string): boolean
export function isVst3ZipEntryMatch(entry: ZipContentEntry): boolean

// ZIP engine
export function findZipEntry(
  zipPath: string,
  onEntry: (entry: ZipContentEntry, openContent: () => Promise<Buffer>) => Promise<boolean>
): Promise<boolean>
export function zipHasVst3(zipPath: string): Promise<boolean>
```

`ZIP_MAGIC_VALUES` — module-private (деталь реализации `isZipMagic`).
Тела функций переносятся **байт-в-байт**, включая тексты ошибок и комментарии.

---

## 5. Инварианты поведения, которые фиксируем (fail-closed контракт `findZipEntry`)

Вычитаны из кода (строки 585–700), НЕ проектируются:

1. Плохой magic (`!isZipMagic`) → `throw 'ZIP-архив повреждён или это файл другого типа.'`
   (синхронно, до yauzl).
2. Ошибка `yauzl.open` / событие `error` → тот же текст `'ZIP-архив повреждён...'`.
3. `end` при `sawFile === false` → `throw 'В архиве нет подходящих файлов для загрузки.'`
   (пустой архив ИЛИ только папки ИЛИ только 0-байтные файлы — `sawFile` ставится только при `size > 0`).
4. Файлы есть, но `onEntry` ни разу не вернул `true` → **resolve `false`** (не throw).
5. `fileCount > MAX_EXTRACTED_FILES` → `throw 'В архиве слишком много файлов.'`
6. `size > MAX_SINGLE_FILE_BYTES` (по **объявленному** `entry.uncompressedSize`) →
   `throw 'Файл внутри архива слишком большой.'`
7. Накопленный `totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES` → `throw 'Содержимое архива превышает допустимый размер.'`
8. Записи-папки (`/$/`) пропускаются (не считаются в `fileCount`).
9. Лимиты проверяются на событии `entry` по central directory **до** `openReadStream` —
   zip-бомба с гигантским объявленным размером отсекается без чтения данных.
10. `openContent()` читает поток и резолвит **сразу** по достижении `ZIP_CONTENT_PEEK_BYTES`
    (затем `stream.destroy()`), не дожидаясь `end` — защита от зависания на крупном первом файле.
11. `settled`-guard: промис резолвится/реджектится ровно один раз.
12. `extFromPath('a/b/x.VST3') === 'vst3'` (нижний регистр, split по `[\\/]`, берётся последний сегмент после последней точки).
13. `isInsideVst3Bundle` матчит `.vst3` в **любом** сегменте пути, split по `[\\/]` (Windows и POSIX).
14. `isVst3ZipEntryMatch`: `size > 0 && (ext === 'vst3' || внутри .vst3-бандла)`.

Инвариант безопасности пути: **этот слой НЕ отвечает за path-traversal.** `findZipEntry`/
`zipHasVst3` не отвергают `../` и абсолютные пути — они только классифицируют содержимое для
валидации загрузки. Защита пути — на этапе распаковки (`extract-zip` + `makeZipExtractionGuard`,
out of scope). Тесты это **фиксируют как есть** (см. §7, категория PATH), чтобы регрессия
«extraction начал полагаться на этот слой» была замечена.

---

## 6. Стратегия тестирования (RED → GREEN)

`vitest`, env `node`, файл `test/unit/archive/zip-validation.test.ts`, импорт из
`../../../src/main/archive/zip-validation`. Модуль не тянет Electron — сеть/Electron не нужны.

**Порядок (TDD):**
1. Тесты пишутся **до** переноса и импортируют ещё несуществующий модуль → компиляция/запуск
   RED. Ожидаемые значения выведены из чтения текущей реализации (§5), а не из её прогона.
2. Перенос кода 1:1 → GREEN.
3. Добавляются regression/adversarial-кейсы.

**Фикстуры.** `findZipEntry` принимает путь к файлу → тесты пишут временный ZIP в `os.tmpdir()`
(cleanup в `afterEach`). Нужен низкоуровневый билдер ZIP, умеющий:
- задавать произвольные имена (в т.ч. `../`, абсолютные, mixed `\`/`/`);
- **подделывать** `uncompressedSize` в central directory независимо от реальных данных
  (кейсы «слишком большой файл» и «превышение суммарного размера» невозможно сделать реальными
  4 GiB — только форжем поля размера);
- писать валидный central directory для yauzl (`lazyEntries`).

Реализация билдера: минимальный writer локальных заголовков + central directory (STORED,
без компрессии), ~80 строк в `test/unit/archive/_zipFixture.ts`. Альтернатива — `yazl`, но он
не даёт подделать `uncompressedSize` (нужно для zip-bomb-кейсов), поэтому — свой билдер.
Проверить при реализации: `findZipEntry` открывает yauzl с дефолтными опциями
(`validateEntrySizes` по умолчанию `true`), но лимит-кейсы **не открывают поток** переросшей
записи (guard на событии `entry`), поэтому расхождение declared/actual для них не срабатывает.

---

## 7. Тестовая матрица (все обязательные сценарии ТЗ)

| # | Категория | Кейс | Ожидание (из §5) |
|---|---|---|---|
| 1 | OK | корректный ZIP с `.vst3` | `zipHasVst3` → `true`; `findZipEntry` c matcher → `true` |
| 2 | CORRUPT | битый ZIP (мусорные байты) | `findZipEntry` throw `'ZIP-архив повреждён или это файл другого типа.'` |
| 3 | CORRUPT | валидный magic, но ломаный central dir | throw `'ZIP-архив повреждён...'` (yauzl error path) |
| 4 | EMPTY | ZIP без записей | throw `'В архиве нет подходящих файлов для загрузки.'` |
| 5 | EMPTY | ZIP только с папками (`foo/`) | throw `'В архиве нет подходящих файлов...'` |
| 6 | EMPTY | ZIP c единственным 0-байтным файлом | throw `'В архиве нет подходящих файлов...'` (`sawFile` только при size>0) |
| 7 | NO-MATCH | файлы есть, matcher всегда `false` | resolve **`false`** (не throw) |
| 8 | NO-VST3 | архив с `.txt`, без `.vst3` | `zipHasVst3` → `false` |
| 9 | LIMIT | `MAX_EXTRACTED_FILES + 1` файлов | throw `'В архиве слишком много файлов.'` |
| 10 | LIMIT | одна запись declared > `MAX_SINGLE_FILE_BYTES` | throw `'Файл внутри архива слишком большой.'` |
| 11 | LIMIT | суммарный declared > `MAX_TOTAL_UNCOMPRESSED_BYTES` | throw `'Содержимое архива превышает допустимый размер.'` |
| 12 | SPOOF | `.exe` без PE (сам matcher) | matcher(`isPeMagic`) → запись не матчится → `false`* |
| 13 | SPOOF | настоящий PE (`MZ...`) в matcher | matcher → `true`* |
| 14 | EXT | `x.VST3` (верхний регистр) | `extFromPath` → `'vst3'`; `isVst3ZipEntryMatch` → `true` |
| 15 | PATH | абсолютный путь `C:\p\x.vst3` / `/p/x.vst3` | НЕ отвергается; `isInsideVst3Bundle` → `true` (фиксируем как есть) |
| 16 | PATH | traversal `../x.vst3` | НЕ отвергается; матч по расширению → `true` (фиксируем) |
| 17 | PATH | mixed separators `a\b/c.vst3` | split по `[\\/]`; `isVst3ZipEntryMatch` → `true` |
| 18 | MULTI | несколько `.vst3` записей | резолвит на первой совпавшей; `readEntry` не зациклен; single-settle |
| 19 | BUNDLE | `MyPlug.vst3/Contents/x64/p.dll` (бандл) | `isInsideVst3Bundle` → `true`, `isVst3ZipEntryMatch` → `true` |
| 20 | PEEK | первый файл > 1 MiB | `openContent()` резолвит по `ZIP_CONTENT_PEEK_BYTES`, не виснет (таймаут теста 10s) |

\* Кейсы 12/13 (PE) тестируются на уровне **matcher-колбэка `findZipEntry`** (передаём тестовый
matcher, вызывающий реальный `isPeMagic` из `antivirus.ts` или локальный стаб `MZ`-проверки),
потому что `isPeMagic` вне scope модуля. `assertZipUploadContent` (где PE реально применяется)
остаётся в `index.ts` и здесь напрямую не тестируется — его характеризация возможна отдельным
PR после выноса content-magic. В этом PR фиксируем, что `findZipEntry` корректно **прокидывает**
`openContent()` в matcher.

### Characterization tests (до переноса, лочат текущее поведение)
Кейсы 1–11, 14, 18–20 — прямая фиксация контракта `findZipEntry`/`zipHasVst3`/`extFromPath`/
`isVst3ZipEntryMatch`/`isInsideVst3Bundle` по §5. Все тексты ошибок сверяются дословно.

### Regression / adversarial tests (после переноса)
- 15–17 (PATH) — фиксируют, что path-safety НЕ на этом слое (страж против будущей регрессии).
- Граничные: ровно `MAX_EXTRACTED_FILES` (не throw) vs `+1` (throw); ровно
  `MAX_SINGLE_FILE_BYTES` (не throw) vs `+1`; сумма ровно `= MAX_TOTAL` (не throw) vs `+1`
  — ловит off-by-one (`>` vs `>=`).
- `uncompressedSize` = `NaN`/отрицательный/строка → `Number(...) || 0` даёт 0 (не ломает счётчик).
- Single-settle: matcher, кидающий после первого совпадения, не вызывает повторный reject.

---

## 8. Последовательность реализации (мелкие шаги)

1. **S1.** Создать `src/main/archive/archive-types.ts` c `ZipContentEntry`. `tsc`.
2. **S2.** Написать `test/unit/archive/_zipFixture.ts` (билдер ZIP с форжем размера/имён).
3. **S3.** Написать `test/unit/archive/zip-validation.test.ts` (characterization, кейсы §7).
   Запуск → **RED** (модуля нет).
4. **S4.** Создать `src/main/archive/zip-validation.ts`: перенести символы §1 **байт-в-байт**
   (`readMagicBytes`, `extFromPath`, `isZipMagic`, `ZIP_MAGIC_VALUES`, `isInsideVst3Bundle`,
   `isVst3ZipEntryMatch`, `findZipEntry`, `zipHasVst3`, четыре `MAX_*`/`PEEK`). Импорт
   `ZipContentEntry` из `archive-types`. Экспорты по §4.
5. **S5.** В `index.ts`: удалить перенесённые определения; добавить импорт из
   `./archive/zip-validation` и `./archive/archive-types`. `makeZipExtractionGuard` и
   `assertZipUploadContent` оставить, переключить на импортированные символы.
6. **S6.** `npx tsc --noEmit` — доказать, что все call sites (§2) резолвятся.
7. **S7.** `npx vitest run test/unit/archive` → **GREEN**.
8. **S8.** Добавить regression/adversarial-кейсы (§7), снова GREEN.
9. **S9.** Полный `npx vitest run` + `npx tsc --noEmit` — регрессий нет.
10. **S10.** adversarial-review диффа (3 персоны), затем самопроверка замечаний по коду.

Каждый шаг — отдельный логический коммит; после S4–S5 сборка обязана быть зелёной.

---

## 9. Риски, циклы, откат

| Риск | Митигирование |
|---|---|
| **Цикл** `index ↔ zip-validation` | Новый модуль не импортирует `index`/`antivirus`/content-magic. Направление строго `index → zip-validation → archive-types`. `assertZipUploadContent` намеренно оставлен в `index`. |
| **Второй source of truth** для `MAX_*` | `makeZipExtractionGuard` импортирует константы, не переопределяет. Проверить grep-ом отсутствие повторных литералов `10_000`/`4 * 1024...` в `index.ts`. |
| Расхождение поведения при переносе | Перенос байт-в-байт; characterization-тесты написаны ДО и лочат тексты ошибок и ветвления. |
| Изменение текста ошибок | Тесты сверяют строки дословно; тексты в diff не редактируются. |
| Fail-open на битом архиве | Кейсы 2–6 явно проверяют throw (fail-closed). |
| Ложное расширение как «доказательство» | Кейс 12: `.exe` без PE не матчится (проверка в matcher, не по ext). |
| yauzl `validateEntrySizes` и потоки | Лимит-кейсы не открывают поток переросшей записи; PEEK-кейс (20) проверяет отсутствие зависания. |
| Fixture-билдер некорректен | S3 включает 1–2 «санити»-кейса против реального `yazl`-архива, чтобы убедиться, что наш билдер читается yauzl так же. |
| **Откат** | Ревертом одного диапазона коммитов (S4–S8). Новые файлы удаляются, импорты в `index.ts` откатываются — `index.ts` возвращается к исходному состоянию без остаточных зависимостей. |

---

## 10. Adversarial review плана (3 персоны) + самопроверка

**Saboteur (что сломается в проде):**
- «Ты переносишь `readMagicBytes`, но `validateIconFile`/`validateUploadedFile` зовут её на
  не-ZIP путях — если сигнатура (`length = 12` по умолчанию) не сохранится, сломаются иконки.»
  → Проверено по коду (447, 497, 515): дефолт `length=12` переносится 1:1. Верно, риск снят.
- «`makeZipExtractionGuard` после переноса констант — если забыть импорт, TS даст `Cannot find
  name`.» → Ловится S6 `tsc`. Верно.

**New Hire (сопровождаемость):**
- «Почему `assertZipUploadContent` и `zipHasVst3` в разных файлах, хотя оба про содержимое
  ZIP?» → Обосновано в §0/§1 (цикл через content-magic). Задокументировано в плане и будет
  в шапке модуля. Принято как осознанный компромисс.
- «`extFromPath`/`readMagicBytes` generic, но живут в `zip-validation`.» → Допустимо: один дом,
  импорт назад, без цикла. Альтернатива (`file-bytes.ts`) отложена, чтобы не плодить файлы.

**Security Auditor (OWASP):**
- «Path traversal не отвергается новым модулем.» → Верно и **намеренно**: это upload-классификатор,
  не extractor. Защита пути — downstream (out of scope). Зафиксировано тестами 15–17 как страж.
- «Лимит по declared size, а не actual — доверяем заголовку злоумышленника?» → Да, и это
  корректно для анти-zip-bomb: отсекаем ДО чтения по объявленному размеру; actual-контроль —
  на распаковке (`extract-zip`/yauzl `validateEntrySizes`). Поведение существующее, не меняется.
- «Off-by-one на границах лимитов.» → Добавлены граничные regression-тесты (§7).

Самопроверка по коду: все четыре технических замечания сверены с исходником (строки указаны),
ложных срабатываний не выявлено; расширения scope замечания не требуют.

---

## 11. Критерии готовности (Definition of Done, PR-1)

- [ ] Созданы `src/main/archive/archive-types.ts`, `src/main/archive/zip-validation.ts`.
- [ ] Создан `test/unit/archive/zip-validation.test.ts` (+ `_zipFixture.ts`), покрыты все 20 кейсов §7.
- [ ] Перенос байт-в-байт: тексты ошибок и лимиты не изменены (verify grep-diff).
- [ ] `npx tsc --noEmit` — без ошибок (все call sites §2 резолвятся).
- [ ] `npx vitest run` — весь набор зелёный, включая ранее существующие тесты.
- [ ] В `index.ts` нет дублей `MAX_*`/magic-констант (один source of truth).
- [ ] Новый модуль не импортирует `electron`/`supabase`/`antivirus`/`index` (проверка импортов).
- [ ] `assertZipUploadContent`, `makeZipExtractionGuard`, downloader, VT, карантин, install-флоу,
      IPC, preload, Renderer — не изменены по существу (только переключены импорты).
- [ ] `444.bat` не тронут.

---

## Приложение A. Отложено на PR-2 (не делать сейчас)

Вынести content-magic (`isFlpBuffer`, `isAudioBuffer`, `wavDurationSec`, `isVstPresetMagic`,
`isFxpMagic`, `AUDIO_FILE_EXTS`) в `src/main/archive/file-magic.ts`, затем перенести
`assertZipUploadContent` в `zip-validation.ts` (импортируя `file-magic` + `isPeMagic`). Это
завершит перенос всего списка ТЗ без цикла, но расширяет blast radius на out-of-scope IPC-пути
(beat-preview, direct upload, иконки) — поэтому отдельным PR с собственной characterization-сеткой.
