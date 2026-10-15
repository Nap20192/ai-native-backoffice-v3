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

## Докопировано 2026-10-15: CLI и мост локальной среды

Из того же коммита 1e44c89 как есть (`rsync -a --exclude node_modules --exclude dist`):

| Пакет | Имя в workspace | Зачем |
|---|---|---|
| `packages/cli` | `@openma/cli` | команда `oma`, в том числе `oma bridge` (демон локальной среды) |
| `packages/managed-agents-runtime` | `@open-managed-agents/runtime` | workspace-зависимость CLI (реэкспорт `@openma/common/local-runtime`) |
| `packages/runtime-relay` | `@open-managed-agents/runtime-relay` | правила tenant для RuntimeRoom. **Пока не используется:** CLI от него не зависит, серверной части моста нет. Удалить, если серверная часть не появится |

Остальные workspace-зависимости CLI (`acp-runtime`, `api-types`, `inference-proxy`,
`sandbox`, `observability`, `shared`, `eval-core`) уже были здесь и совпадают с
upstream (`diff -rq` пустой). `pnpm-workspace.yaml` менять не пришлось: его шаблон
`packages/*` покрывает новые пакеты.

Серверная часть моста (`apps/main/src/routes/runtimes.ts`, `apps/main/src/runtime-room.ts`)
написана только для Cloudflare и сюда не копировалась. Подробности в
`../docs/runbook-claude-code-harness.md`.

Правки поверх upstream в `packages/cli` (2026-10-15, изоляция демона моста):
`src/bridge/lib/spawn-guard.ts`, `spawn-plan.ts` (новые), `claude-config-dir.ts`
(переписан: изолированный конфиг вместо симлинков на `~/.claude`), `session-cwd.ts`,
`platform.ts` (`OMA_BRIDGE_WORK_ROOT`), `node-session-runtime.ts`, `session-manager.ts`,
`commands/daemon.ts` (`local_skills: {}`), `src/index.ts` (`oma mcp connect` на
127.0.0.1, браузер без shell); тесты `test/bridge-isolation.test.ts`,
`test/session-start-cwd.test.ts`. Подробности в `../docs/runbook-claude-code-harness.md`.
