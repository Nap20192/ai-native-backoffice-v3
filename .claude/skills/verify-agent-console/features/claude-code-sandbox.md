<!-- scenario: claude-code -->
# Агент на Claude Code в песочнице

Агент конструктора может работать не на встроенном цикле Pi, а на Claude Code. Claude Code запускается внутри VM LiteBox сессии как ACP-агент `claude-acp` (npm-пакет `@agentclientprotocol/claude-agent-acp`, внутри него Claude Code из `@anthropic-ai/claude-agent-sdk`).
main-node ведёт ACP-сессию по stdio процесса в VM, переводит её обновления в события сессии и показывает ход в консоли как обычный: реплика, карточки инструментов Claude Code (`Write`, `Read`, `Bash` …), ответ, файлы сессии.
Ключ модели или токен подписки лежит в хранилище секретов как учётные данные «переменная окружения» и попадает в окружение VM, а не в конфигурацию агента. Переменные хранилища получает только харнесс `acp-sandbox` (`vaultEnvironmentApplies`, `apps/main-node/src/lib/node-managed-vault-env.ts`); скрипт установки пакетов окружения их не видит.

## Sub-features

- `cc-environment`: окружение с npm-пакетом `@agentclientprotocol/claude-agent-acp` (консоль: карточка окружения, «Добавить пакет»).
- `cc-vault`: хранилище с учётными данными «переменная окружения» `ANTHROPIC_API_KEY` или `CLAUDE_CODE_OAUTH_TOKEN` (API; консоль показывает).
- `cc-agent`: агент на `_oma.harness: acp-sandbox` с `_oma.acp.agent.id: claude-acp` (консоль, режим YAML).
- `cc-session`: сессия с этим агентом, окружением и хранилищем (окно «Новая сессия»).
- `cc-turn`: ход: Claude Code в VM пишет и читает `verify.txt` в рабочей папке, отвечает; события сессии в порядке.
- `cc-permissions`: инструмент вне списка `allow` (Bash с записью) отклоняется: режима обхода разрешений нет.
- `cc-tool-cards`: карточки инструментов Claude Code `Write` и `Read` в разговоре.
- `cc-files`: `verify.txt` в панели «Файлы сессии», в `GET /v1/sessions/:id/outputs` и на хосте.
- `cc-key-vault`: Claude Code ходит в модель с ключом из хранилища (sha256 ключа в запросах = значение хранилища).
- `cc-multi-turn`: второй ход в той же сессии: новый `claude-agent-acp` возобновляет ACP-сессию первого хода, процесс первого хода закрыт (в VM один `claude-agent-acp`), на хосте его нет.
- `cc-archive`: архив сессии останавливает VM.
- `cc-real-key`: ход с настоящим ключом или токеном подписки (`VERIFY_CC_MODE=real`). Включается только явно.

## How to get to it (user POV)

- «Окружения» → окружение → «Добавить пакет», менеджер `npm`, «Пакеты и версии» `@agentclientprotocol/claude-agent-acp@0.91.0` (версия закреплена: без неё npm ставит последнюю при каждом старте VM) → «Сохранить изменения». Сеть «Без ограничений» (или «Ограниченный» с хостами из Gotchas).
- «Хранилища секретов» → хранилище. Учётные данные типа «переменная окружения» консоль только показывает (`pages/VaultDetail.tsx:78`), создаются они запросом `POST /v1/vaults/:id/credentials` с `auth.type: "environment_variable"`.
- «Агенты» → «Новый агент» → «Пустой агент» → «Режим правки: YAML» → конфигурация с блоком `_oma` (пример в `scripts/journey-claude-code.mjs`, `agentYaml`) → «Создать агента».
- «Сессии» → «Новая сессия»: агент, окружение, галочка хранилища в «Хранилища секретов» → «Создать» → сообщение.

## Driving it with Playwright (verify-agent-console)

Preconditions:

- Экземпляр поднят с диском VM 4 ГБ и своими портами: `RUN="$(VERIFY_PORT=8795 VERIFY_FAKE_PORT=8796 VERIFY_LITEBOX_DISK_SIZE_GB=4 scripts/launch.sh)"`, затем `doctor.sh` и `seed-user.sh` с `--run "$RUN"`.
- Режим fake: фейковая модель на `127.0.0.1:<VERIFY_FAKE_PORT>`, из VM она видна как `http://host.boxlite.internal:<порт>`.
- Весь путь выполняет `scripts/journey.sh --run "$RUN" --scenario claude-code` (файл `scripts/journey-claude-code.mjs`).

- **Окружение.** «Окружения» → «Новое окружение» → «Название» → «Создать» → строка → карточка → «Добавить пакет» → `combobox` «Менеджер пакетов» → `option` `npm` → `textbox` «Пакеты и версии» → «Сохранить изменения» → тост «Окружение сохранено». Результат: `GET /v1/environments/:id` → `config.packages.npm` содержит пакет (`cc.env_package`).
- **Хранилище (обходной путь API).** `POST /v1/vaults {display_name}`, затем `POST /v1/vaults/:id/credentials {auth: {type: "environment_variable", secret_name, secret_value, networking: {type: "unrestricted"}}}`. Ответ без значения секрета (`cc.vault_secret`). Страница `/vaults/:id` показывает строку с именем переменной (`screens/*-cc-vault-detail.png`).
- **Агент.** «Агенты» → «Новый агент» → `button` `/^Пустой агент/` → группа «Режим правки» → «YAML» → `textbox` «Конфигурация агента в формате YAML» заполняется целиком → «Создать агента». Результат: `/agents/:id`; `GET /v1/agents/:id` → `_oma.harness = "acp-sandbox"`, `_oma.acp.agent.id = "claude-acp"`, `cwd = /mnt/session/outputs` (`cc.agent_harness`); ключа и `bypassPermissions` в агенте нет (`cc.agent_no_secret`).
- **Сессия.** «Сессии» → «Новая сессия» → `combobox` 0 агент, 1 окружение → `checkbox` с id хранилища в имени → `#session-title` → «Создать». `GET /v1/sessions/:id` → `vault_ids` содержит хранилище (`cc.session_created`).
- **Ход.** Промпт: «создай в рабочей папке файл verify.txt со словом VERIFY_OK и прочитай его» и строка `VERIFY_CLAUDE_CODE nonce=<n>`. Опрос `/events` до `session.status_idle`. Результат:
  - `agent.tool_use` `Write /mnt/session/outputs/verify.txt` → `agent.tool_result` без ошибки → `agent.tool_use` `Read …` → результат с `VERIFY_OK` → `agent.message` `VERIFY_CC_DONE_<n>` → `session.status_idle{end_turn}` (`cc.tool_write`, `cc.tool_read`, `cc.event_order`, `cc.answer`);
  - контрольный `Bash` `touch …/bash-ran-<n>.txt` → `tool_result.is_error = true`, текст `(status: failed)` (Claude Code получил «Tool permission request failed»), файла нет (`cc.permission_denied`, `cc.outputs_api`, `cc.outputs_file`); в консоли у этой карточки бейдж «Ошибка» (`cc.ui_denied_badge`);
  - в логе сервера `[acp-init] … mode=new` и `[acp-runtime] … command=sh`, `span.model_request_start` перед `Write` (`cc.harness_claude_acp`). Модель хода не проверяется: API событий не отдаёт поле `model` у `span.model_request_start`. Строки `installing environment packages (npm: @agentclientprotocol/claude-agent-acp@0.91.0)` и `environment packages installed in N ms` (`cc.package_installed`).
- **Второй ход.** Промпт «покажи процессы песочницы командой ps» и строка `VERIFY_CLAUDE_CODE nonce=<n> turn=2`. Фейк отвечает `Bash ps -eo pid,ppid,args` (разрешён `Bash(ps:*)` в `permissions.allow`), затем `VERIFY_CC_TURN2_<n> acp_processes=<k>`. Результат:
  - `session.status_idle{end_turn}` без `session.error` (`cc.turn2_no_error`);
  - одна новая строка `[acp-init] … mode=resume` или `mode=load`, в истории запросов к фейку есть реплика первого хода (`history_has_turn1`, `cc.turn2_resumed`);
  - в выводе `ps`, который Claude Code получил от своего Bash и отправил фейку (`acp_lines`, копия в `api/cc-45-turn2-ps.txt`), ровно одна строка главного процесса `node /usr/local/bin/claude-agent-acp` (`cc.acp_in_vm_single`): процесс первого хода закрыт, `ps` выполнен в VM;
  - на хосте среди потомков server-node процесса с `claude-agent-acp` в командной строке не было (опрос `/proc` каждые 2 с, `cc.acp_not_on_host`);
  - в консоли второй `article[data-turn-id]` завершён, ответ `VERIFY_CC_TURN2_<n> acp_processes=1` (`cc.ui_turn2_done`).
- **Фейк.** `api/cc-fake-model-requests.json`: решения `cc_write, cc_read, cc_bash_probe, cc_final_text` (плюс служебные `cc_side`), `user_agent` `claude-cli/<версия> (external, sdk-ts, agent-sdk/<версия>)`, `workdir = /mnt/session/outputs`, `api_key_sha256` = sha256 значения из хранилища (`cc.fake_model_*`, `cc.key_from_vault`).
- **Интерфейс.** `article[data-turn-id]` со статусом `completed`, ответ `VERIFY_CC_DONE_<n>` (`cc.ui_turn_done`); карточки `[data-slot="collapsible-trigger"]` с `Write` и `Read`, у Read в содержимом `VERIFY_OK` (`cc.ui_tool_cards`); «Файлы сессии» → ссылка `verify.txt` (`cc.ui_files`).
- **VM и архив.** `boxlite-shim` (pid из лога BoxLite) это потомок server-node (`cc.vm_process`); после `POST /v1/sessions/:id/archive` новая строка «Box stopped» и scratch удалён (`cc.vm_stopped`).
- **Режим real (не запускался).** `VERIFY_CC_MODE=real VERIFY_CC_SECRET_FILE=<файл 600> VERIFY_CC_SECRET_NAME=CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY scripts/journey.sh --run "$RUN" --scenario claude-code`. Секрет читается только из этого файла (не из `~/.claude`), уходит в хранилище; `ANTHROPIC_BASE_URL` у агента не задаётся, Claude Code в VM ходит в api.anthropic.com. Проверяются Write/Read, файл и наличие ответа.

## Gotchas

- **Диск VM.** У `node:22-bookworm` корневой диск VM BoxLite 0.9.0 занимает 1,3 ГБ, свободно ~120 МБ, а пакет весит ~330 МБ (из них 255 МБ приходится на `claude-agent-sdk-linux-x64`). Без `LITEBOX_DISK_SIZE_GB` (адаптер: `diskSizeGb`, `packages/sandbox-adapter-litebox/src/litebox.ts`) установка падает с `ENOSPC`. Сценарий ставит 4 ГБ (`VERIFY_LITEBOX_DISK_SIZE_GB=4`). Установка занимает от 23 до 30 с при каждом старте VM.
- **Хост из VM.** `host.boxlite.internal` → `192.168.127.254` → `127.0.0.1` хоста (gvproxy BoxLite), запрос к хосту приходит с `127.0.0.1`. `192.168.127.1` (шлюз) на порты хоста не отвечает.
- **Разрешения.** `acp-sandbox` не передаёт обработчик `requestPermission`, поэтому любой запрос разрешения Claude Code получает `cancelled` и инструмент отклоняется. Нужные инструменты разрешаются списком `permissions.allow` в `settings.json` Claude Code. Обёртка `sh -c` из YAML пишет его в `$CLAUDE_CONFIG_DIR` (его задаёт профиль `claude-code`, `packages/acp-runtime/src/native-state.ts`). `claude-agent-acp` читает настройки `user`, `project`, `local`. Команды только для чтения (`echo`, `ls`, `cat`) Claude Code выполняет без запроса, поэтому контрольная команда: `touch`.
- **Отказ инструмента.** ACP-агент сообщает неудачный вызов как `tool_call_update{status: "failed"}`, обычно без вывода. До правки 2026-10-16 `AcpTranslator` писал только текст `(status: failed)` без `is_error`, и консоль рисовала у отклонённого Bash зелёное «Готово» (прогон `20261016-011901`, `screens/14-cc-turn-tool-cards.png`). Теперь `is_error: true` (`apps/agent/src/harness/acp-translate.ts`, `#emitToolResult`; тест `apps/main-node/test/acp-translate-failed-tool.test.ts`). Причину отказа событие не несёт.
- **Ключи `input` в API.** `GET /v1/sessions/:id/events` отдаёт `input` инструментов Claude Code в camelCase: `file_path` → `filePath`. Проверки читают оба ключа (`filePathOf`).
- **Пустой ход.** До правки 2026-10-16 main-node передавал харнессу пустой `userMessage`, и `acp-sandbox` падал с `Could not extract text from user message — empty turn` (прогон `20261016-011625`). Теперь текст берётся из принятых событий хода (`apps/main-node/src/lib/node-managed-harness-user-message.ts`).
- **`_oma.acp.agent.id: claude-acp` обязателен** при `command: sh`: профиль состояния выбирается по id или по имени команды, а имя тут `sh`.
- **Рабочая папка.** `cwd: /mnt/session/outputs` делает рабочую папку Claude Code папкой выводов сессии: всё, что он там пишет, попадает в «Файлы сессии». Claude Code 2.1 сообщает её модели строкой `Primary working directory: …` в сообщении с ролью `system` после реплики пользователя, фейк ищет её по всем сообщениям.
- **Системный промпт агента до Claude Code не доходит.** `AcpSandboxHarness.onSessionInit` пишет его в `/workspace/AGENTS.md`, но main-node этот хук не вызывает, а Claude Code читает `CLAUDE.md`.
- **Каждый ход запускает новый процесс.** main-node создаёт харнесс заново на каждый ход (`buildHarness` в `apps/main-node/src/modules/node-managed.ts`). До 2026-10-16 он не вызывал `dispose`, и прежний `claude-agent-acp` оставался в VM до её остановки. Теперь `runHarnessForTurn` (`apps/main-node/src/lib/node-managed-harness-turn.ts`) после хода вызывает `dispose("shutdown")`: процесс закрывается, ACP-сессия и чекпойнт остаются в VM, и следующий ход возобновляет её (`cc.turn2_resumed`, `cc.acp_in_vm_single`). Сессионного владельца харнесса, как `HarnessLease` upstream (`apps/agent/src/harness/registry.ts`), у main-node нет, поэтому каждый ход платит за старт `claude-agent-acp`.
- **Сигналы процессу в VM не доходят (BoxLite 0.9.0).** `signal()` и `kill()` потокового exec не завершаются и ничего не доставляют: проверено в VM 2026-10-16, процесс живёт до остановки VM. Поэтому `dispose` первого хода оставлял `claude-agent-acp` живым (прогон `20261016-024343`: во втором ходе в VM два процесса, PID 24 и 83). Адаптер LiteBox при `kill` сначала закрывает stdin (`spawnDuplexProcess` в `litebox.ts`): `claude-agent-acp` выходит по EOF. Если процесс пережил и EOF, и сигнал, в логе сервера предупреждение `duplex process … did not exit after …`. После этой правки прогон `20261016-041100`: во втором ходе в VM один `claude-agent-acp` (PID 92), на хосте его нет (`cc.acp_in_vm_single`, `cc.acp_not_on_host`).
- **Вывод Bash Claude Code в событиях не виден.** `agent.tool_result` для `Bash` содержит только `(status: completed)` или `(status: failed)`: ACP присылает вывод терминалом, `AcpTranslator` его не переносит. Карточка Bash в консоли без вывода. Поэтому `cc.acp_in_vm_single` берёт вывод `ps` из запроса Claude Code к фейку (`acp_lines` в `api/cc-fake-model-requests.json`), а в режиме real пишет «не проверено». `Read` и `Write` вывод переносят.
- **Секрет в VM открыт.** Официальный контракт `environment_variable` подставляет секрет на выходе (в VM только заглушка). На main-node такого прокси нет: `applyVaultEnvironment` (`apps/main-node/src/lib/node-managed-vault-env.ts`) кладёт само значение в окружение песочницы (`setEnvVars`), его видят Claude Code, его инструменты и bash. С 2026-10-16 только для харнесса `acp-sandbox`: default-харнесс (Pi) секретов хранилища в песочнице не получает, скрипт установки пакетов окружения тоже (ему адаптер LiteBox передаёт только переменные прокси). `networking` и `injection_location` учётных данных не применяются, о каждой такой учётной записи сервер пишет предупреждение `main-node.vault_env.policy_not_enforced` (без значения).
- **Сеть «Ограниченный»** не проверялась. Понадобятся `registry.npmjs.org` (разрешение менеджерам пакетов) и хост модели: `api.anthropic.com` или `host.boxlite.internal` для фейка.
