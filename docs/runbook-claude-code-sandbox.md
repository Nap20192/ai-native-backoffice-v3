# Агенты конструктора на Claude Code в песочнице LiteBox

Цель: агент из нашей копии OpenMA (`platform/`) выполняет ход в Claude Code, а
Claude Code работает **внутри VM LiteBox сессии**, а не на ноутбуке. Мост
`oma bridge` и учётные данные Claude владельца на ноутбуке здесь не участвуют
(это другой путь, см. `runbook-claude-code-harness.md`).

## Статус на 2026-10-16

**Работает в режиме fake (без настоящего ключа).** Ход на Claude Code внутри VM LiteBox
проверен сценарием `claude-code` скилла `verify-agent-console`, прогон
`20261016-041100`: «ПРОЙДЕН», 33 проверки, 0 провалов, включая второй ход в той же сессии
(`.verify-evidence/20261016-041100/summary.md`, `screens/`, `api/`). Окружение, агент и
сессия созданы через консоль, ключ (фиктивный) лежит в хранилище, Claude Code в VM записал
и прочитал `verify.txt` в рабочей папке, файл есть в «Файлах сессии» и на хосте, Bash вне
списка разрешений отклонён. Модель: фейк на хосте, совместимый с Anthropic Messages API.

**Не проверено:** настоящий ключ или токен подписки (режим real ни разу не запускался),
второй ход в той же сессии, сеть «Ограниченный», MCP-серверы агента.

## 1. Как устроено

```
консоль ──► main-node (агент: _oma.harness = acp-sandbox, _oma.acp.agent.id = claude-acp)
               │  AcpSandboxHarness (apps/agent/src/harness/acp-sandbox-loop.ts)
               │  ACP по stdio процесса в VM (LiteBoxSandbox.spawnDuplexProcess)
               ▼
          VM LiteBox сессии ── claude-agent-acp ── Claude Code ──► модель
          (/mnt/session/outputs = «Файлы сессии»)        ANTHROPIC_BASE_URL / api.anthropic.com
```

- **Выбор harness.** Поле агента `_oma.harness: acp-sandbox` и блок `_oma.acp`
  (схема `packages/managed-agents-api/src/contracts/agents.ts:239-240`). main-node
  передаёт их в харнесс (`apps/main-node/src/lib/node-managed-agent-codec.ts:298-320`)
  и вызывает `resolveHarness(ctx.agent.harness)` в `buildHarness` (`apps/main-node/src/modules/node-managed.ts`).
  Ход идёт через `runHarnessForTurn` (`apps/main-node/src/lib/node-managed-harness-turn.ts`):
  после хода харнесс закрывается, процесс `claude-agent-acp` в VM завершается.
  `acp-sandbox` зарегистрирован в `apps/agent/src/harness/builtins.ts:16`.
- **ACP-агент.** `_oma.acp.agent.command` задаёт, что запустить в VM, а `_oma.acp.agent.id: claude-acp` задаёт,
  какой профиль состояния взять (`packages/acp-runtime/src/native-state.ts:115`): профиль
  задаёт `CLAUDE_CONFIG_DIR` в `/tmp/openma-harness-state/acp/<сессия>/claude-code/v1/native`
  и сохраняет `projects/` для возобновления. В каталоге известных агентов это
  `claude-acp` → `claude-agent-acp` (`packages/acp-runtime/src/known-agents.ts:117`).
- **Процесс в VM.** Харнесс требует у песочницы `spawnDuplexProcess`
  (`acp-sandbox-loop.ts:83`). У LiteBox его не было; теперь он есть
  (`LiteBoxSandbox.spawnDuplexProcess` в `packages/sandbox-adapter-litebox/src/litebox.ts`): потоковый exec BoxLite
  (stdin, stdout, stderr, сигналы), окружение песочницы плюс `acp.agent.env`, без таймаута.
- **Как Claude Code попадает в VM.** Пакетом окружения: менеджер `npm`, пакет
  `@agentclientprotocol/claude-agent-acp`. Адаптер ставит пакеты при старте VM
  (`npm install -g`, `packages/sandbox/src/environment-setup.ts:112`), бинарник
  `claude-agent-acp` попадает в `/usr/local/bin`. Пакет весит ~330 МБ (Claude Code
  для linux-x64 внутри `@anthropic-ai/claude-agent-sdk-linux-x64`), а у VM с образом
  `node:22-bookworm` свободно ~120 МБ, поэтому нужен диск VM больше:
  `LITEBOX_DISK_SIZE_GB=4` в окружении сервера (новая настройка адаптера, `sandboxFactory` в `litebox.ts`).
  Установка занимает от 23 до 30 с при каждом старте VM.
- **Модель.** Claude Code сам ходит в модель по `ANTHROPIC_BASE_URL` (если задан) или в
  api.anthropic.com. Поле `model` агента в OpenMA служит подписью хода (`span.model_request_*`),
  Claude Code его не получает; свою модель Claude Code берёт по умолчанию или из
  `ANTHROPIC_MODEL` в `_oma.acp.agent.env`.
- **Ключ.** Из хранилища секретов: учётные данные типа «переменная окружения»
  (`environment_variable`, имя `ANTHROPIC_API_KEY` или `CLAUDE_CODE_OAUTH_TOKEN`).
  При подготовке песочницы main-node читает такие учётные данные хранилищ сессии и
  задаёт их переменными окружения песочницы (`resolveVaultEnvironmentVariables`,
  `apps/main-node/src/lib/node-managed-vault-env.ts`, вызов `applyVaultEnvironment` в `prepareSandbox` файла `node-managed.ts`).
  `spawnDuplexProcess` передаёт их процессу Claude Code.
- **Промпт хода.** Харнесс берёт текст из `ctx.userMessage`. main-node раньше передавал
  туда пустое сообщение (Pi читает историю сам), и ход падал с `Could not extract text
  from user message — empty turn`. Теперь текст берётся из принятых событий хода <!-- unslop-ignore: цитата ошибки -->
  (`apps/main-node/src/lib/node-managed-harness-user-message.ts`, вызов в
  `node-managed.ts:628`).
- **События.** `AcpTranslator` (`apps/agent/src/harness/acp-translate.ts`) превращает
  обновления ACP в `agent.tool_use`/`agent.tool_result`/`agent.message` и
  `span.model_request_*`. Неудачный вызов (`status: failed`) теперь помечается
  `is_error: true`, и консоль показывает у карточки «Ошибка», а не «Готово».
- **Разрешения.** OpenMA не отвечает на запросы разрешений ACP: у `acp-sandbox` нет
  обработчика `requestPermission`, общий ACP-клиент отвечает `cancelled`
  (`@openma/common/dist/acp-runtime/session.js:331`), и Claude Code отклоняет инструмент.
  Нужные инструменты разрешаются списком `permissions.allow` в настройках Claude Code
  (`settings.json` в `CLAUDE_CONFIG_DIR`, `claude-agent-acp` читает источники
  `user`, `project`, `local`). Режим обхода разрешений не используется.

## 2. Сервер

Кроме обычных переменных main-node (`SANDBOX_PROVIDER=litebox`, `SANDBOX_IMAGE=node:22-bookworm`,
`PLATFORM_ROOT_SECRET` для хранилищ) нужна одна:

```sh
LITEBOX_DISK_SIZE_GB=4     # диск VM; без неё npm install claude-agent-acp падает с ENOSPC
```

Память VM в проверке не задавалась (значение BoxLite по умолчанию), Claude Code с ней
отработал; задать явно можно `LITEBOX_MEMORY_MIB`.

## 3. Агент на Claude Code через консоль

1. **Окружение.** «Окружения» → «Новое окружение» → название → «Создать» → открыть
   строку → «Добавить пакет» → «Менеджер пакетов» `npm`, «Пакеты и версии»
   `@agentclientprotocol/claude-agent-acp@0.91.0` → «Сохранить изменения». Версию
   закрепляйте: без неё npm при каждом старте VM ставит последний релиз. Сеть оставить
   «Без ограничений» (про «Ограниченный» см. раздел 6).
2. **Хранилище с ключом.** «Хранилища секретов» → создать хранилище. Учётные данные
   типа «переменная окружения» в консоли создать нельзя (форма умеет только MCP-сервер и
   CLI), поэтому запросом (cookie консоли или ключ API рабочего пространства):

   ```sh
   curl -X POST "$OMA/v1/vaults/<vault_id>/credentials" \
     -H 'content-type: application/json' -H 'anthropic-beta: managed-agents-2026-04-01' \
     -H "x-api-key: $OMA_API_KEY" \
     --data @- <<'JSON'
   {"display_name": "Claude Code",
    "auth": {"type": "environment_variable", "secret_name": "CLAUDE_CODE_OAUTH_TOKEN",
             "secret_value": "<значение>", "networking": {"type": "unrestricted"}}}
   JSON
   ```

   Значение API больше не возвращает; консоль показывает строку «Переменная окружения
   CLAUDE_CODE_OAUTH_TOKEN» на странице хранилища.
3. **Агент.** «Агенты» → «Новый агент» → «Пустой агент» → «Режим правки» → «YAML» →
   вставить конфигурацию → «Создать агента»:

   ```yaml
   name: claude-code-agent
   model: claude-sonnet-4-6
   description: "Claude Code внутри песочницы LiteBox"
   _oma:
     harness: acp-sandbox
     acp:
       agent:
         id: claude-acp
         command: sh
         args:
           - "-c"
           - "mkdir -p \"$CLAUDE_CONFIG_DIR\" && printf '%s' \"$OMA_CLAUDE_SETTINGS\" > \"$CLAUDE_CONFIG_DIR/settings.json\" && exec claude-agent-acp"
         cwd: /mnt/session/outputs
         env:
           CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
           OMA_CLAUDE_SETTINGS: "{\"permissions\":{\"allow\":[\"Read\",\"Write\",\"Edit\"]}}"
       per_turn_timeout_ms: 600000
   ```

   - `sh -c` нужен только чтобы записать настройки разрешений Claude Code; сам процесс
     заменяется на `claude-agent-acp` (`exec`). Без обёртки можно указать
     `command: claude-agent-acp`, но тогда Claude Code не получит ни одного разрешения на
     запись и любой `Write`/`Edit` будет отклонён.
   - `id: claude-acp` обязателен при `command: sh`, иначе профиль состояния не найдётся.
   - `cwd: /mnt/session/outputs`: рабочая папка Claude Code совпадает с папкой выводов
     сессии, поэтому созданные файлы видны в «Файлы сессии».
   - Список `allow` расширяйте под задачу: например `"Bash(npm test:*)"`. Не добавляйте
     `defaultMode: bypassPermissions` и не ставьте ключ в `env` агента: конфигурация агента
     отдаётся API целиком (`GET /v1/agents/:id` → `_oma.acp.agent.env`).
4. **Сессия.** «Сессии» → «Новая сессия» → агент, окружение, отметить хранилище в
   «Хранилища секретов» → «Создать» → написать сообщение. Первый ход ждёт старт VM и
   установку пакета (~30 с), затем Claude Code отвечает. Инструменты Claude Code видны
   карточками `Write …`, `Read …`, `Bash …`.

## 4. Настоящий ключ или токен подписки

- **Ключ API.** Учётные данные `ANTHROPIC_API_KEY` в хранилище (раздел 3, шаг 2).
- **Токен подписки.** Владелец сам выполняет `claude setup-token` на своей машине и кладёт
  выданный токен в хранилище как `CLAUDE_CODE_OAUTH_TOKEN`. Claude Code в VM читает его из
  окружения. Файлы `~/.claude` ноутбука в VM не копируются и не нужны.
- `ANTHROPIC_BASE_URL` в агенте не задавать: Claude Code пойдёт в api.anthropic.com.
- Проверка скиллом (включается только явно, тратит лимит):
  ```sh
  install -m 600 /dev/null ~/.config/oma-claude-token && $EDITOR ~/.config/oma-claude-token
  RUN="$(VERIFY_PORT=8795 VERIFY_FAKE_PORT=8796 VERIFY_LITEBOX_DISK_SIZE_GB=4 .claude/skills/verify-agent-console/scripts/launch.sh)"
  S=.claude/skills/verify-agent-console/scripts
  $S/doctor.sh --run "$RUN" && $S/seed-user.sh --run "$RUN" && \
    VERIFY_CC_MODE=real VERIFY_CC_SECRET_FILE=~/.config/oma-claude-token VERIFY_CC_SECRET_NAME=CLAUDE_CODE_OAUTH_TOKEN \
    $S/journey.sh --run "$RUN" --scenario claude-code; $S/cleanup.sh --run "$RUN"
  ```
  Файл должен иметь права 600 и лежать не в `~/.claude`; значение не печатается.
  **Этот режим ни разу не запускался.**

## 5. Проверка без ключа (фейковая модель)

Сценарий `claude-code` скилла `verify-agent-console` (раздел «Сценарий Claude Code» в
`SKILL.md`, рецепт `features/claude-code-sandbox.md`):

```sh
S=.claude/skills/verify-agent-console/scripts
RUN="$(VERIFY_PORT=8795 VERIFY_FAKE_PORT=8796 VERIFY_LITEBOX_DISK_SIZE_GB=4 $S/launch.sh)" && \
  { $S/doctor.sh --run "$RUN" && $S/seed-user.sh --run "$RUN" && $S/journey.sh --run "$RUN" --scenario claude-code; $S/cleanup.sh --run "$RUN"; }
```

Claude Code в VM ходит в фейковую модель хоста по `http://host.boxlite.internal:8796`
(gvproxy BoxLite отдаёт хосту адрес `192.168.127.254` и пересылает его на `127.0.0.1`),
ключ фиктивный и лежит в хранилище. Фейк (`scripts/fake-model.mjs`, режим
`VERIFY_CLAUDE_CODE`) ведёт ход: `Write verify.txt` → `Read` → контрольный `Bash touch`
(должен быть отклонён) → ответ `VERIFY_CC_DONE_<n>`.

## 6. Ограничения

- **Секрет в VM открыт.** Официальный контракт `environment_variable` подставляет секрет
  на выходе из песочницы, внутри только заглушка. На main-node такого прокси нет: в VM
  лежит само значение, его могут прочитать Claude Code, его инструменты и bash агента.
  С 2026-10-16 переменные хранилища получает только харнесс `acp-sandbox`
  (`vaultEnvironmentApplies` в `node-managed-vault-env.ts`); default-харнесс (Pi) и скрипт
  установки пакетов окружения их не видят.
  Поля `networking` и `injection_location` учётных данных не применяются, сервер пишет об
  этом предупреждение `main-node.vault_env.policy_not_enforced`. Возможная
  доработка: секреты BoxLite (`JsBoxOptions.secrets`: имя, значение, хосты, заглушка),
  не проверялась.
- **Каждый ход запускает новый процесс Claude Code.** main-node создаёт харнесс на каждый ход
  (`buildHarness` в `node-managed.ts`). С 2026-10-16 после хода он вызывает
  `dispose("shutdown")` (`runHarnessForTurn`, `node-managed-harness-turn.ts`): процесс
  закрывается, ACP-сессия и чекпойнт остаются в VM, следующий ход поднимает новый
  `claude-agent-acp` и возобновляет её. Сценарий `claude-code` проверяет второй ход: в VM
  один `claude-agent-acp`, `[acp-init] mode=resume|load`. Каждый ход платит за старт процесса.
  BoxLite 0.9.0 не доставляет сигналы потоковому exec (`signal()`/`kill()` не завершаются,
  проверено в VM), поэтому адаптер LiteBox при остановке процесса сначала закрывает его stdin:
  `claude-agent-acp` выходит по EOF.
- **Системный промпт агента до Claude Code не доходит.** `onSessionInit` харнесса (пишет
  `/workspace/AGENTS.md`) main-node не вызывает, а Claude Code читает `CLAUDE.md`.
- **MCP-серверы агента** по URL требуют шлюз с токеном Work (`projectAcpSandboxMcpServers`),
  в main-node его для этого пути нет: агент с URL-MCP упадёт с ошибкой. Не проверялось.
- **Сеть «Ограниченный»** не проверялась: нужны `registry.npmjs.org` (разрешение менеджерам
  пакетов) и хост модели (`api.anthropic.com`); фильтр BoxLite 0.9.0 пропускает по имени
  только порты 80 и 443, поэтому фейк на 8796 с такой сетью недоступен.
- **Разрешения.** Ответить на запрос разрешения из консоли нельзя: всё, чего нет в
  `permissions.allow`, отклоняется. Команды только для чтения (`echo`, `ls`, `cat`) Claude
  Code выполняет без запроса.
- **Учётные данные «переменная окружения» в консоли** только отображаются, создаются через API.
- В консоли над ходом написано «Работал 0 с», хотя ход шёл 28 с (старт VM и установка
  пакета до первого события). Причину не разбирал.
- Ключи `input` инструментов в `GET /v1/sessions/:id/events` приходят в camelCase
  (`file_path` → `filePath`), так же их показывает карточка в консоли.
- Пакет ставится из npm при каждом старте VM (нужна сеть к registry.npmjs.org, ~30 с).
  Без версии берётся последний релиз, поэтому рецепт и сценарий закрепляют
  `@agentclientprotocol/claude-agent-acp@0.91.0`.

## 7. Что изменено в коде (2026-10-16)

| Файл | Что | Тест |
|---|---|---|
| `platform/packages/sandbox-adapter-litebox/src/litebox.ts` | `spawnDuplexProcess` (потоковый exec BoxLite для ACP), `diskSizeGb` / `LITEBOX_DISK_SIZE_GB` | `test/litebox-duplex.test.ts` (12), `test/litebox.test.ts` (+1); покрытие пакета 100% |
| `platform/apps/main-node/src/lib/node-managed-vault-env.ts`, вызов в `src/modules/node-managed.ts` (prepareSandbox) | учётные данные `environment_variable` хранилищ сессии → окружение песочницы | `test/managed-session-vault-env.test.ts` (3) |
| `platform/apps/main-node/src/lib/node-managed-harness-user-message.ts`, вызов в `node-managed.ts` (buildHarnessContext) | текст хода в `ctx.userMessage` | `test/managed-session-harness-user-message.test.ts` (3) |
| `platform/apps/agent/src/harness/acp-translate.ts` | `is_error: true` для `status: failed` | `apps/main-node/test/acp-translate-failed-tool.test.ts` (2) |
| `platform/apps/main-node/src/lib/node-managed-harness-turn.ts`, вызов в `node-managed.ts` (buildHarness) | `dispose("shutdown")` харнесса после хода: прежний `claude-agent-acp` не остаётся в VM | `test/managed-session-harness-turn.test.ts` (4), сценарий `claude-code`: `cc.acp_in_vm_single`, `cc.turn2_resumed` |
| `node-managed-vault-env.ts` (`applyVaultEnvironment`), `litebox.ts` (`installEnv`) | переменные хранилища только для `acp-sandbox`, предупреждение о неприменённых `networking`/`injection_location`; скрипт установки пакетов получает только переменные прокси | `test/managed-session-vault-env.test.ts`, `test/litebox.test.ts` |
| `.claude/skills/verify-agent-console/` | сценарий `claude-code`, режим фейка для Claude Code, `--scenario`, размер VM, исправление `VERIFY_*` в launch, `apps/agent` в хэше кода, второй ход и процессы `claude-agent-acp` в VM | прогоны `20261016-012333`, `20261016-041100` |

Рецепт моста на ноутбук (`runbook-claude-code-harness.md`) не использовался и не менялся.

