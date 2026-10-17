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
