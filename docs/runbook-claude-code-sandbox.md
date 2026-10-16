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

**С 2026-10-16 модель идёт через прокси сервера.** Ключа модели в VM больше нет: Claude Code
получает адрес прокси своей сессии и короткий токен хода, прокси подставляет ключ карточки
модели (раздел 1). Это проверяют тесты main-node с поддельным ACP-агентом
(`test/managed-acp-sandbox-proxy.test.ts`). Прогон скилла по новой схеме ещё не делался:
сценарий `claude-code` кладёт ключ в хранилище и `ANTHROPIC_BASE_URL` в env агента, guard
теперь такой агент не сохранит. Сценарий переделывает отдельная задача (раздел 5).

**Не проверено:** настоящий ключ (режим real ни разу не запускался), Claude Code через наш
прокси против настоящего API Anthropic, сеть «Ограниченный», MCP-серверы агента. Токен
подписки больше не поддерживается (раздел 4).

## 1. Как устроено

```
консоль ──► main-node (агент: _oma.harness = acp-sandbox, _oma.acp.agent.id = claude-acp)
               │  AcpSandboxHarness (apps/agent/src/harness/acp-sandbox-loop.ts)
               │  ACP по stdio процесса в VM (LiteBoxSandbox.spawnDuplexProcess)
               ▼
          VM LiteBox сессии ── claude-agent-acp ── Claude Code
          (/mnt/session/outputs = «Файлы сессии»)      │ ANTHROPIC_BASE_URL = <шлюз>/v1/oma/inference-proxy/<сессия>/anthropic
                                                       │ ANTHROPIC_AUTH_TOKEN = токен хода oma_sbx_...
                                                       ▼
          main-node: прокси модели (ключ карточки, model = wire_model) ──► провайдер модели
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
- **Модель.** Модель агента берётся из карточки модели рабочего пространства или из
  `ANTHROPIC_API_KEY` сервера, как у встроенного цикла. На каждом ходе main-node выпускает
  токен песочницы `oma_sbx_` и передаёт харнессу `hostedInference`: адрес шлюза, токен,
  провайдер модели (`prepareAcpTurnInference` в `apps/main-node/src/lib/models-harness-wiring.ts`,
  вызов в `buildHarnessContext` файла `node-managed.ts`). Токен живёт таймаут хода
  (`per_turn_timeout_ms`, по умолчанию 5 минут) плюс 15 минут. В прокси своей сессии он
  открывает только вызовы модели: `messages`, `count_tokens`, `chat/completions`, `responses` и
  список моделей. На файлы, пакетные запросы и любой `DELETE` прокси отвечает 403 и к провайдеру
  не идёт (`isSandboxInferenceCall`). Адаптер Claude ставит `ANTHROPIC_BASE_URL` на прокси,
  `ANTHROPIC_AUTH_TOKEN` на токен, `ANTHROPIC_MODEL` на handle модели агента и убирает
  `ANTHROPIC_API_KEY` из env запуска.
  Прокси (`apps/main-node/src/lib/http-inference-proxy.ts`) подставляет ключ карточки и меняет
  `model` в теле запроса на `wire_model` карточки, служебные вызовы Claude Code с лёгкой моделью тоже.
- **Ключ.** В VM ключа модели нет. Учётные данные хранилища типа «переменная окружения»
  main-node по-прежнему задаёт окружением песочницы (`applyVaultEnvironment` в `prepareSandbox`),
  но ключи моделей (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` и другие) и
  переменные, которые задаёт сервер для прокси, пропускает (`skipModelKeys`). На каждую такую
  переменную сервер пишет предупреждение `main-node.vault_env.model_key_skipped` с именем без значения.
  Те же ключи моделей ход убирает из `_oma.acp.agent.env` агента сессии (`acpTurnAgent`). Так ключ
  не попадёт в VM и из снимка агента, который сохранили до guard.
- **Готовность.** Ходу Claude Code нужны токен и адрес шлюза. Без `PLATFORM_ROOT_SECRET`, без
  `SANDBOX_GATEWAY_BASE_URL` и `PUBLIC_BASE_URL` или с песочницей без `spawnDuplexProcess`
  каталог `GET /v1/oma/harnesses` показывает Claude Code «Недоступно», guard не даёт
  сохранить такого агента, а ход старого агента падает с ошибкой «ACP-агенту нужен прокси
  модели: <причина>». Сессия при этом остаётся.
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

Кроме обычных переменных main-node (`SANDBOX_PROVIDER=litebox`, `SANDBOX_IMAGE=node:22-bookworm`)
нужны:

```sh
PLATFORM_ROOT_SECRET=...   # шифр токена песочницы; без него Claude Code «Недоступно»
SANDBOX_GATEWAY_BASE_URL=http://host.boxlite.internal:8787   # адрес main-node, видимый из VM
LITEBOX_DISK_SIZE_GB=4     # диск VM; без неё npm install claude-agent-acp падает с ENOSPC
```

`SANDBOX_GATEWAY_BASE_URL` задаётся адресом `http` или `https` без пути. Без неё сервер берёт
`PUBLIC_BASE_URL`. Адрес `127.0.0.1` из VM ведёт в саму VM, поэтому локально с LiteBox нужен
`host.boxlite.internal` и порт main-node: gvproxy BoxLite пересылает его на `127.0.0.1` хоста.

Память VM в проверке не задавалась (значение BoxLite по умолчанию), Claude Code с ней
отработал; задать явно можно `LITEBOX_MEMORY_MIB`.

## 3. Агент на Claude Code через консоль

1. **Окружение.** «Окружения» → «Новое окружение» → название → «Создать» → открыть
   строку → «Добавить пакет» → «Менеджер пакетов» `npm`, «Пакеты и версии»
   `@agentclientprotocol/claude-agent-acp@0.91.0` → «Сохранить изменения». Версию
   закрепляйте: без неё npm при каждом старте VM ставит последний релиз. Сеть оставить
   «Без ограничений» (про «Ограниченный» см. раздел 6).
2. **Модель.** «Карточки моделей» → новая карточка: провайдер `anthropic`, модель, ключ API.
   Ключ остаётся на сервере, Claude Code его не видит. Без карточки подойдёт модель Anthropic
   по `ANTHROPIC_API_KEY` сервера. Хранилище с ключом больше не нужно: ключ модели из
   хранилища до VM не доходит.
3. **Агент.** «Агенты» → «Новый агент» → «Пустой агент». В разделе «Основное» выбрать
   Harness «Claude Code в песочнице» и модель: форма сама запишет блок `_oma.acp` ниже и
   уберёт усилие и скорость, Claude Code их не принимает. То же можно задать в «YAML»:

   ```yaml
   name: claude-code-agent
   model: verify-fake        # handle карточки модели или модели из GET /v1/oma/model_options
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
     `defaultMode: bypassPermissions`.
   - Guard на `POST /v1/agents` не сохранит агента с ключом или с адресом модели в `env`:
     `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` и другие переменные прокси
     задаёт сервер, имя вида `*_TOKEN` или `*_KEY` и значение вида `sk-...` похожи на секрет.
     Ещё guard проверяет, что модель есть в `GET /v1/oma/model_options` и работает с протоколом
     `anthropic-messages`.
4. **Сессия.** «Сессии» → «Новая сессия» → агент, окружение → «Создать» → написать сообщение. Первый ход ждёт старт VM и
   установку пакета (~30 с), затем Claude Code отвечает. Инструменты Claude Code видны
   карточками `Write …`, `Read …`, `Bash …`.

## 4. Настоящий ключ

- **Ключ API.** Карточка модели с провайдером `anthropic` и настоящим ключом (раздел 3, шаг 2).
  Прокси шлёт ключ заголовком `x-api-key`.
- **Токен подписки не поддерживается.** `CLAUDE_CODE_OAUTH_TOKEN` из хранилища в VM больше не
  попадает, а работу токена подписки через прокси никто не проверял. Подписка через прокси
  возможна отдельной задачей.
- `ANTHROPIC_BASE_URL` в агенте не задавать: его ставит сервер.
- Проверка скиллом ниже написана под старую схему с токеном в хранилище и после перехода на
  прокси не работает. Сценарий переводит на карточку модели отдельная задача. Старая команда
  (включается только явно, тратит лимит):
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

До перехода на прокси Claude Code в VM ходил в фейковую модель хоста по
`http://host.boxlite.internal:8796` (gvproxy BoxLite отдаёт хосту адрес `192.168.127.254` и
пересылает его на `127.0.0.1`), ключ фиктивный лежал в хранилище. Теперь guard отклонит агента
сценария (`ANTHROPIC_BASE_URL` в env), а ключ из хранилища до VM не дойдёт. Новый сценарий
задаёт `SANDBOX_GATEWAY_BASE_URL=http://host.boxlite.internal:<VERIFY_PORT>` в `launch.sh`,
создаёт карточку модели с `base_url` фейка и проверяет в журнале фейка ключ карточки и
`model = wire_model`. Его делает отдельная задача, до неё команда выше не пройдёт. Фейк (`scripts/fake-model.mjs`, режим
`VERIFY_CLAUDE_CODE`) ведёт ход: `Write verify.txt` → `Read` → контрольный `Bash touch`
(должен быть отклонён) → ответ `VERIFY_CC_DONE_<n>`.

## 6. Ограничения

- **Ключа модели в VM нет, токен хода есть.** Токен `oma_sbx_` лежит в окружении процесса
  Claude Code, его видят инструменты агента и bash в VM. Токен открывает только вызовы модели в
  прокси своей сессии и живёт таймаут хода плюс 15 минут.
- **Другие секреты хранилища в VM открыты.** Официальный контракт `environment_variable`
  подставляет секрет на выходе из песочницы, внутри только заглушка. На main-node такого прокси
  нет: переменные хранилища, кроме ключей моделей (например `GITHUB_TOKEN`), лежат в VM
  значением, их могут прочитать Claude Code, его инструменты и bash агента.
  Переменные хранилища получает только харнесс `acp-sandbox`
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
  пакетов) и хост шлюза из `SANDBOX_GATEWAY_BASE_URL`. Хост модели VM больше не нужен, в модель
  ходит сервер. Фильтр BoxLite 0.9.0 пропускает по имени только порты 80 и 443, поэтому шлюз на
  другом порту из такой сети недоступен.
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
| `platform/apps/main-node/src/lib/models-harness-wiring.ts`, вызовы в `node-http.ts` и `node-managed.ts`, `SANDBOX_GATEWAY_BASE_URL` в `config.ts` | каталог моделей и harness, карточки harness, guard агента, токен песочницы в auth, `hostedInference` или переменные карточки на ходе ACP, `skipModelKeys: true` | `test/models-harness-http.test.ts`, `test/managed-acp-sandbox-proxy.test.ts`, `test/config.test.ts` |
| `.claude/skills/verify-agent-console/` | сценарий `claude-code`, режим фейка для Claude Code, `--scenario`, размер VM, исправление `VERIFY_*` в launch, `apps/agent` в хэше кода, второй ход и процессы `claude-agent-acp` в VM | прогоны `20261016-012333`, `20261016-041100` |

Рецепт моста на ноутбук (`runbook-claude-code-harness.md`) не использовался и не менялся.

