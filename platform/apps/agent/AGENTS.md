# Рантайм агента: правила для агентов

Harness (цикл одного хода), инструменты агента, рантайм сессии. Пути ниже от `platform/apps/agent/`. Перед правкой harness или инструментов прочитайте `docs/plans/harness-fixes.md` в корне репозитория: там подтверждённые дефекты с файлами и строками.

## Связь с сервером

- Сервер импортирует пакет как `@open-managed-agents/agent/...`. На Node ход ведёт `DefaultNodeManagedSessionRunner` в `apps/main-node/src/lib/node-managed-session-runner.ts`.
- `src/runtime/session-do.ts` и `wrangler.jsonc` работают только на Cloudflare. Поведение нашего сервера меняется правкой в `apps/main-node`.

## Harness

Контракт `src/harness/interface.ts`, регистрация `src/harness/builtins.ts`.

| Имя | Класс | Файл |
|---|---|---|
| `default`, `pi` | `PiHarness`, ведёт Qwen | `src/harness/pi-loop.ts` |
| `ai-sdk` | `DefaultHarness`, устаревший | `src/harness/default-loop.ts` |
| `acp-sandbox` | внешний агент (Claude Code, Codex) внутри VM | `src/harness/acp-sandbox-loop.ts` |

- PiHarness импортирует `emitHarnessToolUseFromCall` из `default-loop.ts`, этот экспорт живёт, пока не переедет в общий модуль.
- Каждое событие хода идёт через `ctx.runtime.broadcast`: это одна запись и в журнал, и в консоль.
- Поток текста, мыслей и ввода инструментов идёт тройкой `broadcast*Start` / `Chunk` / `End`. Каждый открытый поток закрывается, при отмене со статусом `aborted`.
- Отмена приходит через `ctx.runtime.abortSignal`. Перед долгим шагом проверяйте `signal.aborted`: слушатель `abort`, добавленный после отмены, не срабатывает.
- Инструмент `always_ask` приходит без `execute`. Harness кладёт id вызова в `ctx.runtime.pendingConfirmations`, сервер переводит сессию в «нужно действие».
- Сводка сжатия (`agent.thread_context_compacted`) навсегда заменяет историю до себя. Записывается только сводка, завершённая со `stop`.

## Инструменты

`buildTools(agentConfig, sandbox, env?)` в `src/harness/tools.ts`.

- Новое поле `env` протаскивается в оба вызова `buildTools`: `apps/main-node/src/modules/node-foundation.ts` и `node-managed.ts`.
- Ввод модели попадает в shell только через `shellQuote` или позиционный аргумент.
- `sandbox.exec` отвечает в двух форматах: Cloudflare `exit=N\n<stdout>` и LiteBox `<stdout>\n[exit N]` или `[error: ...]`. Разбор вывода понимает оба, образец `parseBase64ExecOutput`.
- `MAX_TOOL_RESULT_CHARS` (`tools.ts`) и `MAX_PI_TOOL_TEXT_CHARS` (`pi-loop-tools.ts`) равны 50 000 и меняются вместе.
- В контекст модели идёт только текст. Картинка идёт модели при `toolImages`, PDF превращается в подсказку про `pdftotext`, base64 в истории в заметку `capHistoryText`. Повод: 2026-10-16 base64 PNG переполнил контекст Qwen в 262 144 токена.

## Тесты

| Папка | Запуск |
|---|---|
| `tests/` | из `platform/`: `test-slot pnpm vitest run --config vitest.pi.config.ts --maxWorkers=2` (или `vitest.acp-recovery.config.ts`) |
| `test/` | из `apps/agent`: `test-slot ../../node_modules/.bin/vitest run --maxWorkers=2` |

- Типы пакета проверяет typecheck сервера: `pnpm --filter @open-managed-agents/main-node typecheck`.
- Тест инструмента идёт на фейковом `SandboxPort` с выводом в формате LiteBox, образец `tests/tool-results-size.test.ts`.
- Доказательство хода: скилл `verify-agent-console` или сессия на Qwen в пробной копии.
