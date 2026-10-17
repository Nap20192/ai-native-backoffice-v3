# platform: правила для агентов

Общие правила в корневом `AGENTS.md`. Пути ниже от `platform/`.

## Неполная копия

Из Open Managed Agents взяты только `apps/main-node`, `apps/agent`, `apps/console` и их зависимости. Корневые `pnpm test`, `pnpm typecheck`, `pnpm dev`, `db:generate:*`, корневой `vitest.config.ts` и часть `vitest.*.config.ts` ссылаются на файлы, которых в копии нет, и падают. Их падение это свойство копии, а не ваша ошибка. Проверяйте по пакетам:

| Что | Команда |
|---|---|
| Сервер | `pnpm --filter @open-managed-agents/main-node test -- test/<файл>.test.ts`, `... typecheck` |
| Консоль | `pnpm --filter managed-agents-console exec vitest run <путь>`, `... typecheck` |
| Pi harness | `pnpm vitest run --config vitest.pi.config.ts` |
| Восстановление ACP | `pnpm vitest run --config vitest.acp-recovery.config.ts` |
| Очередь и аренда | `pnpm vitest run --config vitest.session-coordination.config.ts` |
| Пакет со скриптом `test` | `pnpm --filter <пакет> test` |

- Пакеты `managed-agents-application`, `managed-agents-api`, `http-routes`, `shared`, `db-schema` проверяются тестами `apps/main-node`: своего рабочего раннера у них нет.
- Если у пакета нет `node_modules/.bin/vitest`, берите `platform/node_modules/.bin/vitest`.
- Lint не настроен, стиль держат typecheck и тесты.

## Два API

| | `/v1/*` | `/v1/oma/*` |
|---|---|---|
| Что | Совместимо с Claude Managed Agents: agents, sessions, environments, vaults, memory_stores, skills, files, deployments | Расширения: model_cards, harness_cards, trace, platform-mcp, tenants, api-keys, evals |
| Код | `packages/managed-agents-api` | `packages/http-routes`, `apps/main-node/src/lib/*` |
| Заголовок | `anthropic-beta: managed-agents-2026-04-01`, без него 400 | не нужен |
| Ошибки | `{type:"error", error:{type, message}}` | `{error: "..."}` |
| id | `agent_x`, `env_x` (`managed-ids.ts`) | `agent-x`, `sess-x` (`packages/shared/src/id.ts`) |

- Маршруты подключаются в `apps/main-node/src/modules/node-http.ts`.
- Wire-контракт `/v1` это типы `@anthropic-ai/sdk@0.120.0`. Поля OMA живут в `/v1/oma/*`, DTO `/v1` остаются чистыми. Правила в `packages/managed-agents-api/API_LAYER.md`.
- Консоль и помощник работают через `/v1`. Старые `/v1/oma/agents`, `/environments`, `/sessions` пишут в другие таблицы. Новые функции этих сущностей идут в `/v1`.

## Слои `/v1`

Маршрут Hono → zod-схема → mapper → inbound Port (`managed-agents-application/src/ports`) → сервис → outbound Port → адаптер (`managed-agents-adapters-sql`, тройки `<x>-store` / `<x>-store-sql` / `<x>-store-memory`). Домен в `managed-agents-domain`, DI в `managed-agents-app`.

- Границы слоёв держат тесты `*-boundary.test.ts`, правила в `managed-agents-application/PORT_BOUNDARIES.md`. Слой приложения видит только домен, store-интерфейсы и `session-runtime*`. Адаптер SQL работает через `SqlClient`.
- Новый эндпоинт `/v1` пишется снаружи внутрь: сначала красный контракт-тест через SDK, потом маршрут, порт, сервис, адаптер.
- Чтение и запись отдают `ETag: "<revision>"`. Запись с `If-Match` проверяет ревизию: несовпадение даёт 412 `precondition_failed_error`.
- Архив и удаление с зависимостями отвечают 409 `dependency_conflict_error` со списком. Таблицы `managed_*` без внешних ключей, поэтому зависимости проверяет сервис. Контракт в `docs/plans/crud.md`.

## База данных

- Для разработки SQLite (`DATABASE_PATH`). Postgres включает `DATABASE_URL`, но захват исполнений там падает с `42P18` (`docs/runbook-local.md`).
- Относительные пути считаются от `apps/main-node`.
- Миграция пишется руками в две папки одинаково: `apps/main-node/migrations/` (Postgres) и `migrations-sqlite/` (SQLite, MySQL), вместе с записью в `meta/_journal.json`. Генератор Drizzle не работает. Номера существующих миграций постоянны, регрессию ловит `test/migration-merge.test.ts`.
- Таблицы наших модулей (`lib/platform-mcp/schema.ts`, `lib/harness-cards/schema.ts`, `lib/trace/store.ts`) создаются кодом через `CREATE TABLE IF NOT EXISTS` одним SQL для обеих баз.

## Вход и тенант

`AUTH_DISABLED=1` даёт тенант `default`. Иначе `x-api-key` или cookie better-auth. Тенант берётся из заголовка `x-active-tenant`, если пользователь в нём состоит (иначе 403 `not_a_member`), а без заголовка из первого членства. Код в `packages/auth/src/index.ts`.

## Ход агента на сервере

`POST /v1/sessions/:id/events` → журнал и SSE → очередь → `NodeSessionExecutionWorker` берёт ход с арендой (30 с, продление 10 с) → `DefaultNodeManagedSessionRunner` готовит VM и зовёт harness.

- Каждое событие хода пишется условной вставкой по fence аренды: запись воркера, потерявшего аренду, отклоняется.
- Harness, инструменты и форматы вывода песочницы описаны в `apps/agent/AGENTS.md`.

## LiteBox

- Адаптер `packages/sandbox-adapter-litebox/src/litebox.ts`, включается `SANDBOX_PROVIDER=litebox`, нужен `/dev/kvm`.
- `copyIn` и `copyOut` не видят tmpfs `/tmp` и virtiofs `/mnt/session/outputs`. Файлы туда идут через временный файл в `/var/tmp` и `cat` внутри VM.
- Хост из VM: `http://host.boxlite.internal:<порт>`.

## Помощник

- Код `apps/main-node/src/lib/platform-mcp/`, промпт `assistant/prompt.md`, справка `assistant/docs/*.md`.
- Запись идёт в два шага: preview отдаёт digest, confirm с тем же digest выполняет.
- Новый инструмент получает класс в `ports.ts` и правило маршрута в `route-rules.ts`. Тесты `apps/main-node/test/platform-mcp-*.test.ts`.
