# Происхождение кода

Каталоги `apps/` и `packages/` скопированы из Open Managed Agents
(https://github.com/openma-ai/open-managed-agents), коммит 1e44c89 от 2026-10-15,
лицензия Apache 2.0 (см. LICENSE и NOTICE).

Взяты только приложения self-host сервера (`apps/main-node`, `apps/agent`), консоль
(`apps/console`) и пакеты, от которых они зависят. Cloudflare-развёртывание, `main-fly`,
`main-vercel`, сайт, документация и сервис интеграций не копировались.

Из корневого `test/` upstream взят только `test/model/managed-agents-client-state-model.ts`
(2026-10-16, как есть): его импортирует `apps/main-node/test/managed-agents-route.test.ts`,
без него этот тест не загружался.

2026-10-19 из того же коммита 1e44c89 как есть взят `test/fakes/scripted-mcp-server.ts`
(221 строка). Его импортировал `apps/main-node/test/session-resume-mcp-live.test.ts`. В тот же день
очистка удалила этот тест вместе с мостом интеграций (раздел ниже). Фейк остался, его берёт волна
`../docs/plans/mcp-registry.md`. Файлы `test/fixtures/oauth-mcp-local-server.ts` и
`oauth-mcp-validate-scenarios.ts` для `apps/main-node/test/mcp-oauth-validate.e2e.test.ts`
написаны у нас заново, это не копия файлов upstream с теми же именами.

Изменения поверх исходного кода фиксируются в истории git этого репозитория.

## Докопировано 2026-10-15, удалено 2026-10-17: CLI и мост локальной среды

2026-10-15 из того же коммита 1e44c89 как есть докопировали `packages/cli` (`@openma/cli`,
команда `oma` и демон моста `oma bridge`), `packages/managed-agents-runtime`
(`@open-managed-agents/runtime`, зависимость CLI) и `packages/runtime-relay`
(`@open-managed-agents/runtime-relay`, правила tenant для RuntimeRoom). Серверная часть моста
написана только для Cloudflare и сюда не копировалась, поэтому мост на нашем Node-сервере так и
не заработал. Наши правки изоляции демона в `packages/cli` остались в истории git.

## Удалено 2026-10-17: ACP-агенты и мост

Владелец оставил один harness, встроенный цикл Pi. Решение D41 в
`../docs/decisions-2026-10-17.md`. Пакеты ниже служили только ACP-агентам или мосту и удалены
целиком:

| Пакет | Имя в workspace | Чему служил |
|---|---|---|
| `packages/acp-runtime` | `@open-managed-agents/acp-runtime` | запуск ACP-агентов (Claude Code, Codex, Gemini, OpenCode, Kimi) в VM и на ноутбуке |
| `packages/harness-inference-adapters` | `@open-managed-agents/harness-inference-adapters` | переменные модели для каждого ACP-агента при запуске |
| `packages/inference-proxy` | `@open-managed-agents/inference-proxy` | прокси модели для агента в VM, токены `oma_sbx_` |
| `packages/cli` | `@openma/cli` | команда `oma` и демон `oma bridge` |
| `packages/managed-agents-runtime` | `@open-managed-agents/runtime` | зависимость CLI |
| `packages/runtime-relay` | `@open-managed-agents/runtime-relay` | правила tenant для RuntimeRoom, не использовался |

Вместе с ними удалены harness `acp-sandbox` и `acp-proxy`, устаревший harness `ai-sdk`
(`DefaultHarness`), карточки harness, прокси модели для VM, вид учётных данных
`sandbox_inference` в `packages/auth` и страницы консоли «Harness» и «Локальные среды». Пакеты
`harness-runtime-acp` и `harness-supervisor` в копию не попадали, а корневой `package.json` на
них ссылался. Эти ссылки убраны вместе с `vitest.acp-recovery.config.ts`.

Код до удаления лежит в коммите `1d1a43b`. `@openma/common` остаётся: консоль рисует ходы
через его `projectAcpChatTurn`, а он не зависит от ACP-агентов.

## Удалено 2026-10-19: остатки CLI в консоли и на сервере

После удаления CLI консоль всё ещё показывала на Сводке блок «Запуск агента». Он предлагал
поставить CLI командой `npx -y -p @openma/cli oma`. Эта команда скачивает из npm пакет upstream.
По умолчанию он шлёт запросы на `https://openma.dev`, а не на наш сервер.

Удалены шаги CLI в блоке «Запуск агента» на Сводке, страница `/cli/login`, маршрут `POST /v1/oma/me/cli-tokens` и его
помощник `mintApiKeyOnStorage` в `packages/http-routes`. Вместо шагов CLI блок показывает путь
«быстрый старт, окружение, сессия».

Ключи API, которые выпустил этот маршрут (`source: "cli"`), продолжают работать.

Таблицы моста `runtimes`, `runtime_tokens` и `connect_runtime_codes` остаются в миграции
`0000_consolidated.sql`, поэтому их создаёт и новая база. Код их не читает. Их описание в
`packages/db-schema` удалено (`../docs/plans/cleanup.md`, раздел 4.3), миграции удаления нет.

## Удалено 2026-10-19: воркер Cloudflare в `apps/agent`

Сервер Node берёт из `apps/agent` только `src/harness/*`, `src/runtime/history.ts` и
`src/runtime/appendable-prompts.ts`. Остальной код служил воркеру и Durable Object Cloudflare.
Развёртывание Cloudflare в копию не брали, а его код остался. План в
`../docs/plans/cleanup.md`, раздел 4.2.

Из `apps/agent` удалены воркер `src/index.ts`, `src/runtime/session-do.ts`, песочница Cloudflare
(`src/oma-sandbox.ts`, `src/outbound.ts`, `src/runtime/sandbox.ts`), модули, которые звал только
`SessionDO`, супервизор outcome, `wrangler.jsonc`, `wrangler.dev.jsonc`, `Dockerfile` и
`Dockerfile.sandbox`. Из `src/runtime/history.ts` ушли классы `SqliteHistory` и
`InMemoryHistory`. Из `src/harness/skills.ts` ушли реестр навыков и загрузка навыков из KV и R2.
Из `src/harness/tools.ts` ушёл серверный поиск Anthropic `web_search_20250305`. Агент с этим типом
инструмента теперь получает поиск DuckDuckGo.

Пакеты ниже служили только этому воркеру и удалены целиком:

| Пакет | Чему служил |
|---|---|
| `packages/managed-runtime-cloudflare` | драйвер рантайма песочницы Cloudflare |
| `packages/managed-runtime-host` | хост драйверов рантайма, его брал только драйвер Cloudflare |
| `packages/runtime-resource-fence-sql` | fence ресурсов рантайма для драйвера Cloudflare |
| `packages/services` | сборка сервисов воркера для тенанта |
| `packages/tenant-db`, `packages/tenant-dbs-store` | шардинг тенантов по базам D1 |
| `packages/outbound-snapshots-store`, `packages/session-secrets-store` | хранилища Cloudflare для `packages/services` |
| `packages/session-wakeup`, `packages/session-wakeup-cloudflare` | пробуждение сессии по расписанию Durable Object |
| `packages/cap` | правила подстановки учёток в CLI, его звал только `SessionDO` |

Вместе с ними ушёл вход `./cf-do` пакета `packages/event-log`. Таблицы Durable Object (`events`,
`streams`, `pending_events` и другие) в базах Node не создавались, миграций удаления нет.

## Удалено 2026-10-19: мёртвый код и неиспользуемые функции

Шаги 2 и 3 плана `../docs/plans/cleanup.md`. Шаг 2 убрал код, который наш сервер Node не
запускает. Из шага 3 владелец выбрал четыре пункта: интеграции, маршрут `/openai`, MySQL и
словари en и zh-CN. Остальные пункты шага 3 остались, список в плане. Воркер Cloudflare описан
в разделе выше. Код до удаления лежит в коммите `5dc7d3e`.

Пакеты ниже удалены целиком:

| Пакет | Чему служил |
|---|---|
| `packages/sandbox-adapter-daytona`, `sandbox-adapter-e2b`, `sandbox-adapter-boxrun` | песочницы Daytona, E2B и BoxRun. Сервер работает только с LiteBox |
| `packages/managed-runtime-sprites`, `managed-runtime-sandbox` | рантайм Fly Sprites и общий рантайм песочницы, его брали только Sprites и Cloudflare |
| `packages/quotas`, `packages/rate-limit` | квоты и лимит частоты, сервер их не подключал |
| `packages/dreams-pipeline` | старый маршрут `/v1/oma/dreams` |
| `packages/linear`, `slack`, `github`, `feishu`, `integrations-core`, `integrations-adapters-cf`, `integrations-adapters-node` | интеграции Linear, Slack, GitHub и Feishu |
| `packages/openai-agents-api`, `openai-agents-compat` | маршрут `/openai` |
| `packages/node-database-mysql` | база MySQL |

Из сервера `apps/main-node` ушли:

- старые маршруты `/v1/oma/agents`, `/v1/oma/environments`, `/v1/oma/memory_stores`,
  `/v1/oma/dreams`, `/v1/oma/files`, `/v1/oma/sessions/:id/memory_stores` и заглушки
  `GET /v1/oma/integrations/*/credentials`. Старый `/v1/oma/sessions` остался;
- режим `OPENMA_PROCESS_MODE=serverless` (`src/process-mode.ts`). Каждый процесс теперь запускает
  планировщик и фоновые задачи, переменную сервер не читает;
- мост интеграций, шлюз вебхуков, раннер Feishu, задачи `linear-dispatch` и
  `webhook-events-retention`, переменная `GATEWAY_ORIGIN` и поле `turnstile_site_key` ответа
  `/auth-info`;
- маршрут `/openai` и файлы `src/openai-*.ts`. Правило делегирования субагентов `/v1` перешло в
  `nodeManagedSubagentPolicy` (`src/lib/node-managed-subagents.ts`);
- ветки MySQL. `DATABASE_URL` с `mysql://` или `mysql2://` теперь даёт ошибку конфигурации при
  старте.

Шифр `WebCryptoAesGcm` переехал из `integrations-adapters-node` в
`apps/main-node/src/lib/web-crypto-aes-gcm.ts` без изменений. Тест держит две шифровки старого
класса. Пакет `packages/mcp-access-loss` остался на пути MCP-прокси, но без каталогов провайдеров.
Из реестра `apps/agent/src/runtime/appendable-prompts.ts` ушёл промпт `linear-mcp`: он звал
инструменты Linear, которых больше нет. Реестр пуст, неизвестный id ничего не добавляет.

Из `packages/db-schema` ушли описания TS таблиц `runtimes`, `runtime_tokens`,
`connect_runtime_codes`, `usage_events`, `tenant_shard`, `shard_pool`, `memory_store_tenant`,
`session_threads`, `group_events`, `feishu_message_events`, `memory_confirmations` и
`feishu_apps`, а ещё папка `node-mysql`. Ушли и описания 24 таблиц интеграций `linear_*`,
`slack_*`, `github_*` и `feishu_*`: папка `src/cf-integrations`, файлы
`src/node-pg/cf-integrations-*.ts` и экспорт `./cf-integrations`. Все эти таблицы остаются в базах
и в миграциях вместе с данными, миграций удаления нет.

Из консоли `apps/console` ушли страницы интеграций, папка `src/integrations` и аватары
`public/integration-avatars`, словари `src/i18n/en.ts` и `zh-CN.ts` и переключатель языка.
Консоль теперь только русская. Ещё ушли Turnstile на странице входа, `src/plugins/registry.ts`,
компоненты без импортёров (`BrandLoader`, `ListPage`, `session-detail/Trajectory.tsx`,
`ai-elements/conversation.tsx`, `ai-elements/suggestion.tsx`, `ui/card`, `ui/pagination`,
`ui/accordion`, `ui/scroll-area`, `ui/sidebar`), мёртвые экспорты и стили и 13 зависимостей без
импорта.

Из корня `platform/` ушли скрипты деплоя Cloudflare, Vercel, Fly и сайта документации, скрипты
drizzle-kit и changesets, `test:openai-agents*`, `test:integration:mysql` и скрипты тестов на файлы
вне копии. Вместе с ними ушли корневой `vitest.config.ts` на пуле workerd,
`vitest.harness-tools-wiring.config.ts`, `vitest.harness-web-http.config.ts`,
`vitest.protocol.config.ts`, `tsconfig.test.json`, тест
`apps/main-node/test/provider-chaos-cluster.test.mjs` и зависимости `wrangler`,
`@cloudflare/vitest-pool-workers`, `drizzle-kit`, `@changesets/cli`, `@changesets/changelog-git`,
`bash-parser`, `@ai-sdk/anthropic`. Сборные `test` и `typecheck` остались, из них ушли фильтры
по пакетам, которых в копии нет.
