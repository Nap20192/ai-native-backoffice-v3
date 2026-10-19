# Рантайм агента: правила для агентов

Harness (цикл одного хода), инструменты агента, рантайм сессии. Пути ниже от `platform/apps/agent/`. Перед правкой harness или инструментов прочитайте `docs/plans/harness-fixes.md` в корне репозитория: там подтверждённые дефекты с файлами и строками.

## Связь с сервером

- Сервер импортирует пакет как `@open-managed-agents/agent/...`. На Node ход ведёт `DefaultNodeManagedSessionRunner` в `apps/main-node/src/lib/node-managed-session-runner.ts`.
- Сервер берёт из пакета только `src/harness/*`, `src/runtime/history.ts` и `src/runtime/appendable-prompts.ts`. Поведение нашего сервера меняется правкой в `apps/main-node`.
- Воркер Cloudflare (`session-do.ts`, `wrangler.jsonc`, песочница Cloudflare) удалён 2026-10-19 вместе с пакетами, которые нужны были только ему. Список в `platform/ORIGIN.md`, план в `docs/plans/cleanup.md`, раздел 4.2.

## Harness

Контракт `src/harness/interface.ts`, регистрация `src/harness/builtins.ts`, выбор по имени `src/harness/registry.ts`.

| Имя | Класс | Файл |
|---|---|---|
| `default`, `pi` | `PiHarness`, ведёт Qwen | `src/harness/pi-loop.ts` |

- Другого harness нет. ACP-агенты и устаревший `DefaultHarness` удалены 2026-10-17, решение D41 в `docs/decisions-2026-10-17.md`.
- `resolveHarness` переводит старые имена `ai-sdk`, `acp-sandbox` и `acp-proxy` на Pi и пишет одно предупреждение на имя. Так сохранённые агенты со старым harness работают дальше. Неизвестное имя бросает ошибку.
- Поведение только для Pi (монтаж навыков в `agentUsesAssemblySkillMount`) проверяйте через `isPiHarnessName` из `registry.ts`. Тогда старое имя получает то же, что Pi.
- Общие помощники событий инструментов (`emitHarnessToolUseFromCall`, `isMcpTool`, `normalizeToolOutputForWire`) лежат в `src/harness/tool-events.ts`. Их берёт `pi-loop.ts`. Файл `src/runtime/history.ts` их не импортирует: он делает обратное преобразование, и оно совпадает с ними байт в байт.
- Каждое событие хода идёт через `ctx.runtime.broadcast`: это одна запись и в журнал, и в консоль.
- Поток текста, мыслей и ввода инструментов идёт тройкой `broadcast*Start` / `Chunk` / `End`. Каждый открытый поток закрывается, при отмене со статусом `aborted`.
- Отмена приходит через `ctx.runtime.abortSignal`. Перед долгим шагом проверяйте `signal.aborted`: слушатель `abort`, добавленный после отмены, не срабатывает.
- Инструмент `always_ask` приходит без `execute`. Harness кладёт id вызова в `ctx.runtime.pendingConfirmations`, сервер переводит сессию в «нужно действие».
- Сводка сжатия (`agent.thread_context_compacted`) навсегда заменяет историю до себя. Записывается только сводка, завершённая со `stop`.

## Инструменты

`buildTools(agentConfig, sandbox, env?)` в `src/harness/tools.ts`.

- Новое поле `env` протаскивается в оба вызова `buildTools`: `apps/main-node/src/modules/node-foundation.ts` и `node-managed.ts`.
- Ввод модели попадает в shell только через `shellQuote` или позиционный аргумент.
- `glob` раскрывает фигурные скобки сам (`expandBraces`) и передаёт шаблоны bash позиционными аргументами. Bash ищет по ним файлы и не выполняет их как код.
- Pi выполняет вызовы одного шага параллельно. Поэтому `edit` и `write` одного файла идут по очереди через `withPathLock`.
- `edit` вставляет `new_string` срезами строки, без `String.replace`: тот разворачивает `$&` и `$$`.
- `sandbox.exec` отвечает в двух форматах: Cloudflare `exit=N\n<stdout>` и LiteBox `<stdout>\n[exit N]` или `[error: ...]`. Вывод разбирает `parseExecOutput`, он понимает оба.
- Длинный вывод bash режется посередине: начало и конец лога остаются, первая строка называет код выхода.
- Песочница запускает команды через `sh -c`, а sh в образах Debian это dash. Команду, которой нужен `pipefail` или другие возможности bash, оборачивайте в `bash -c`, как grep и glob.
- `MAX_TOOL_RESULT_CHARS` (`tools.ts`) и `MAX_PI_TOOL_TEXT_CHARS` (`pi-loop-tools.ts`) равны 50 000 и меняются вместе.
- В контекст модели идёт только текст. Картинка идёт модели при `toolImages`, PDF превращается в подсказку про `pdftotext`, base64 в истории в заметку `capHistoryText`. Повод: 2026-10-16 base64 PNG переполнил контекст Qwen в 262 144 токена.

## Тесты

| Папка | Запуск |
|---|---|
| `tests/` | из `platform/`: `test-slot pnpm vitest run --config vitest.pi.config.ts --maxWorkers=2` |
| `test/` | из `apps/agent`: `test-slot ../../node_modules/.bin/vitest run --maxWorkers=2` |

- Типы пакета проверяет typecheck сервера: `pnpm --filter @open-managed-agents/main-node typecheck`.
- Тест инструмента идёт на фейковом `SandboxPort` с выводом в формате LiteBox, образец `tests/tool-results-size.test.ts`.
- Доказательство хода: скилл `verify-agent-console` или сессия на Qwen в пробной копии.
