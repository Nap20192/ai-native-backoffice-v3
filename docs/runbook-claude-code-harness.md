# Агенты конструктора на Claude Code ноутбука (oma bridge)

Цель: агент из нашей копии OpenMA (`platform/`) выполняет ход в Claude Code
владельца на ноутбуке. Связка такая: сервер, затем демон `oma bridge daemon` на
ноутбуке, затем `claude-agent-acp`, затем Claude Code.

## Статус на 2026-10-15

**Приёмка не выполнена, задача не засчитывается.** На нашем Node-сервере этот путь
не работает: серверной части моста в копии нет, она есть только в
Cloudflare-варианте upstream (`apps/main/src/routes/runtimes.ts`,
`apps/main/src/runtime-room.ts`). В upstream это тоже записано: `/v1/runtimes
(RuntimeRoom DO)` отмечен как «CF-only» в `docs/self-host.md` (около строки 397).
Событий сессии с harness `claude-acp` нет, `verify.txt` из рабочей папки агента
нет: ход агента выполнить нельзя.

Попытка дописать серверную часть была отклонена системой разрешений Claude Code
(экспорт harness `acp-proxy` из `apps/agent`, причина «Create Unsafe Agents»).
Серверный код не менялся. Возвращаться к серверной части только после решения
владельца (раздел 10) и с условиями из раздела 6.

Сделано на стороне демона (`platform/packages/cli`): изоляция Claude Code от
учётных данных и настроек владельца, allowlist переменных окружения, проверка
`cwd` от сервера, запрет файлов настроек в bundle. Подробности в разделе 6.

Проверка состояния: `scripts/verify-claude-code-harness.sh` (раздел 8). Ответы
маршрутов ниже взяты из его прогона 2026-10-15 18:58, файлы лежат в
`.verify-evidence/claude-code-harness/20261015-185827/` (`verify.txt`,
`summary.md`, `http/*.body`). Прежняя таблица без артефактов заменена.

| Запрос | Ответ |
|---|---|
| `GET /v1/oma/runtimes` | `200 {"data":[]}` (заглушка, `apps/main-node/src/modules/node-http.ts:522`) |
| `POST /v1/oma/runtimes/connect-runtime` | `404` |
| `POST /agents/runtime/exchange` | `404` |
| `GET /agents/runtime/_attach` (Upgrade: websocket) | `404` |
| `node packages/cli/dist/index.js bridge --help` | список подкоманд, код выхода 1 |

## 1. Запуск сервера (порт 8795, SQLite, временная папка)

Значения из `platform/.env` не нужны: секрет генерируется на месте. Папка
создаётся с `umask 077`: в ней будут cookie-jar с сессионным токеном и `auth.db`.

```sh
eval "$(fnm env)"; fnm use 24
umask 077
T=$(mktemp -d /tmp/oma-bridge-XXXXXX)
cd /home/vnkjd/orca/projects/ai-native-backoffice-v3/platform/apps/main-node
env -u DATABASE_URL -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL \
  HOST=127.0.0.1 PORT=8795 PUBLIC_BASE_URL=http://127.0.0.1:8795 \
  DATABASE_PATH=$T/oma.db AUTH_DATABASE_PATH=$T/auth.db \
  MEMORY_BLOB_DIR=$T/memory-blobs FILES_BLOB_DIR=$T/files-blobs \
  SANDBOX_WORKDIR=$T/sandboxes SESSION_OUTPUTS_DIR=$T/session-outputs \
  SANDBOX_PROVIDER=litebox BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  nohup nice -n 15 ./node_modules/.bin/tsx src/index.ts > $T/server.log 2>&1 &
echo $! > $T/server.pid
curl -s http://127.0.0.1:8795/health
```

- `SANDBOX_PROVIDER` обязателен при старте (`apps/main-node/src/sandbox-provider.ts:29`).
  LiteBox при этом не запускается, пока нет сессии.
- Консоль этим рецептом не раздаётся. Если нужна, собрать в свою папку
  (`vite build --outDir $T/console`) и добавить `CONSOLE_DIR=$T/console`.
  Папку `apps/console/dist` не трогать.

Тестовая учётка (заголовок `origin` обязателен):

```sh
B=http://127.0.0.1:8795; O="origin: $B"; PW=$(openssl rand -hex 12)
curl -s -c $T/cj -X POST $B/auth/sign-up/email -H "$O" -H 'content-type: application/json' \
  -d "{\"email\":\"bridge-check@example.test\",\"password\":\"$PW\",\"name\":\"bridge check\"}"
curl -s -b $T/cj -c $T/cj -X POST $B/auth/sign-in/email -H "$O" -H 'content-type: application/json' \
  -d "{\"email\":\"bridge-check@example.test\",\"password\":\"$PW\"}"
```

Остановка и уборка (только этот PID, не по имени):

```sh
kill -TERM $(cat $T/server.pid)
rm -rf "$T"
```

## 2. Сборка CLI

Пакеты `packages/cli`, `packages/managed-agents-runtime`, `packages/runtime-relay`
докопированы из upstream (см. `platform/ORIGIN.md`; `runtime-relay` пока не
используется).

```sh
cd /home/vnkjd/orca/projects/ai-native-backoffice-v3/platform
nice -n 15 pnpm install --no-frozen-lockfile
nice -n 15 pnpm --filter @openma/cli build      # -> packages/cli/dist/index.js (1.3 МБ)
OMA="node $PWD/packages/cli/dist/index.js"
$OMA bridge --help
```

`pnpm install --no-frozen-lockfile` изменил не только записи новых пакетов: у
`ai`, `@anthropic-ai/sdk`, `openai` и других в importers `apps/main-node` и
`packages/session-runtime` peer `zod` сменился с 4.3.6 на 4.4.3 (так же выбирает
upstream). Тесты `apps/main-node` после этого (`test-slot`): 73 файла прошли,
461 тест прошёл; 7 файлов упали на файлах, которые не копировались из upstream
(`platform/test/fakes`, `platform/test/model`, `platform/test/fixtures`,
`packages/harness-runtime-acp`, `apps/main/migrations*`), не на zod. Сравнения
со старым lock не было. Вывод: `main-node-tests.txt` в папке доказательств.

Проверки (2026-10-15):

- `packages/cli`: `tsc --noEmit` без ошибок; `vitest` 9 файлов, 52 теста прошли,
  1 пропущен (upstream). Новые тесты: `test/bridge-isolation.test.ts`, случаи
  отказа в `test/session-start-cwd.test.ts`. Команды через `test-slot`.
- `packages/managed-agents-runtime`: `src` без ошибок; одна ошибка в тестовом
  файле `test/acp-fixtures.ts:27` (у `AcpSession` из `@openma/common` 0.9.1 нет
  `legacyModels`, `forkSupport`). Это код upstream как есть.

## 3. Подключение ноутбука

Команды `oma bridge run` нет. Есть `setup`, `daemon`, `status`, `refresh`,
`agents`, `profiles`, `uninstall` (`packages/cli/src/index.ts:2363-2434`).
Демон на переднем плане: `setup --no-service` или `bridge daemon`.

Нужно на ноутбуке:

- `claude-agent-acp` в `PATH`, поставленный вручную и закреплённой проверенной
  версией. Сейчас его в `PATH` нет. **`setup` не запускать с `--yes`:** он
  проверяет обёртки ACP и с `--yes` без вопроса ставит `npm install -g <пакет>`
  или скачивает бинарники в `~/.local/share/oma/wrappers/` с симлинком в
  `~/.local/bin` (`packages/cli/src/bridge/lib/wrapper-audit.ts:100-160, 291-297`;
  `binary-installer.ts:16-17, 69-70`; `commands/setup.ts:167, 224`). То же у
  `oma bridge agents refresh --yes`.
- Флаг `--server-url` всегда. Без него машина регистрируется на внешнем
  `https://app.openma.dev` (`packages/cli/src/bridge/lib/defaults.ts:7`).
- Флаг `--no-service`. Без него ставится systemd user-unit с `Restart=always` и
  снимком `PATH` (`packages/cli/src/bridge/lib/service-templates.ts:100-125`).
- Переменные демона из раздела 6 (рабочая папка, вход Claude, allowlist).

Команда (когда серверная часть появится):

```sh
umask 077
W=/tmp/oma-claude-work-$(date +%Y%m%d-%H%M%S)
OMA_BRIDGE_WORK_ROOT=$W $OMA bridge setup --server-url=http://127.0.0.1:8795 --no-service
```

Что происходит: CLI открывает браузер на `<сервер>/connect-runtime?cb=…&state=…`,
страница консоли вызывает `POST /v1/oma/runtimes/connect-runtime`, CLI меняет код
на токен через `POST /agents/runtime/exchange`, пишет
`~/.oma/bridge/credentials.json` и запускает демон, который держит WebSocket
`/agents/runtime/_attach`. **Сейчас setup остановится на шаге с браузером:** оба
маршрута отвечают 404.

Проверка: `$OMA bridge status`.

Другие команды собранного `oma`: `oma mcp connect` раньше слушал порт на всех
интерфейсах и открывал браузер через shell со строкой URL. Исправлено: слушает
`127.0.0.1`, браузер открывается без shell (`packages/cli/src/index.ts:689-706,
2232, 2246`). Мост эту команду не использует.

## 4. Как выбрать Claude Code для агента или сессии

Только на уровне агента, через поле `_oma` в API (`/v1/agents`, заголовок
`anthropic-beta: managed-agents-2026-04-01`) или в режиме YAML/JSON формы
агента в консоли. Отдельных полей в форме нет.

```json
{
  "_oma": {
    "harness": "acp-proxy",
    "runtime_binding": { "runtime_id": "<id из GET /v1/oma/runtimes>", "acp_agent_id": "claude-acp" }
  }
}
```

Схема: `packages/managed-agents-api/src/contracts/agents.ts:188-193, 233-243`.
У сессии своего выбора harness нет: она берёт его из агента
(`packages/managed-agents-api/src/contracts/sessions.ts:56-67, 117-139`).

API принимает такого агента даже с несуществующим `runtime_id` (`201`, прогон
скрипта, `http/agent-acp-proxy.body`): привязка к runtime при создании не
проверяется.

На Node такой агент сейчас не выполнится: `acp-proxy` регистрируется только в
Cloudflare-воркере (`apps/agent/src/index.ts:17`), на Node зарегистрированы
`default`, `pi`, `ai-sdk`, `acp-sandbox` (`apps/agent/src/harness/builtins.ts:12-16`).
Ход упадёт с `Unknown harness: "acp-proxy"` (`apps/agent/src/harness/registry.ts:15`).

## 5. Рабочая папка агента на ноутбуке

- По умолчанию `~/.oma/bridge/sessions/<12 hex>/` (начало sha256 от id сессии,
  `packages/cli/src/bridge/lib/session-cwd.ts:48, 59`). С
  `OMA_BRIDGE_WORK_ROOT=<абсолютный путь>` это `<путь>/sessions/<12 hex>/`
  (`platform.ts:95-98`). Для демо: `/tmp/oma-claude-work-<время>`, не домашняя
  папка: Claude Code ищет `CLAUDE.md` и в родительских папках, а под `~` лежат
  файлы владельца.
- Конфиг Claude Code сессии лежит рядом, но вне рабочей папки агента:
  `<корень>/claude-config/<12 hex>/` (`session-cwd.ts:67`). Обе папки удаляются
  на `session.dispose` (`session-cwd.ts:146`).
- `cwd`, присланный сервером, сейчас до демона не доходит:
  `packages/cli/src/bridge/lib/daemon-client.ts:44-46` его не передаёт. Остальная
  цепочка `cwd` принимает. **Включать передачу `cwd` с сервера можно только с
  проверкой на стороне демона.** Она теперь есть: `cwd` должен быть абсолютным,
  существовать и после `realpath` лежать внутри одного из
  `OMA_BRIDGE_CWD_ROOTS` (тоже после `realpath`), иначе `session.error`
  (`spawn-guard.ts:156-189`). Без `OMA_BRIDGE_CWD_ROOTS` любой `cwd` от сервера
  отклоняется. Симлинк изнутри корня наружу отклоняется (тест).

## 6. Права агента на ноутбуке и условия безопасности

### Что было в upstream (поэтому мост в таком виде не запускать)

- `CLAUDE_CONFIG_DIR=<рабочая папка>/.claude-config` с симлинками на весь
  `~/.claude`, кроме `skills`: `.credentials.json`, `settings.json` (у владельца
  это симлинк на `~/dotfiles/.claude/settings.json`), `projects/` со всеми
  транскриптами, `history.jsonl`, плагины. Учётные данные и история владельца
  оказывались внутри рабочей папки агента, запись шла сквозь симлинки.
- Агент получал настройки владельца целиком: `permissions.additionalDirectories`
  и `allow Read(...)` (заранее разрешённое чтение `~/dotfiles/library`,
  `~/.claude/plugins`, `~/.claude/skills`), глобальный `CLAUDE.md`, хуки Orca на
  `PreToolUse`, `PostToolUse` и других событиях. Хуки отправили бы чужие
  запросы и вызовы инструментов в локальный Orca владельца или его spool, а
  транскрипты тенантов легли бы в `~/.claude/projects` владельца.
- Переменные окружения из ресурсов сессии (`type=env`) задаёт тот, кто создаёт
  сессию. Они попадали в процесс `claude-agent-acp` без фильтра (вычищались
  только `CLAUDECODE*`). `NODE_OPTIONS`, `LD_PRELOAD`, `PATH` дают выполнение
  кода на ноутбуке любому пользователю тенанта.
- Файлы bundle писались в рабочую папку без ограничений, в том числе
  `.claude/settings.json` с хуками и `.mcp.json` с командами stdio.
- Демон сообщал серверу список навыков владельца (`~/.claude/skills`, плагины).

### Что сделано в демоне (`platform/packages/cli/src/bridge/lib/`)

- `claude-config-dir.ts`: отдельный `CLAUDE_CONFIG_DIR` вне рабочей папки, права
  0700, внутри только сгенерированный `settings.json`: `disableAllHooks: true`,
  пустые `allow` и `additionalDirectories`, `defaultMode: "default"`,
  `disableBypassPermissionsMode: "disable"`, `enableAllProjectMcpServers: false`,
  `deny` на чтение `~/.claude`, `~/.config`, `~/.ssh`, `~/.gnupg`, `~/.aws`.
  Из `~/.claude` ничего не читается и не линкуется. Старые симлинки в папке
  конфига удаляются. Ошибка настройки прерывает запуск, а не откатывается к
  настоящему `~/.claude`; папка конфига-симлинк отклоняется. Навыки владельца сессиям не передаются,
  `local_skill_blocklist` из bundle не используется.
- Вход Claude: только явный. Демон передаёт ребёнку `CLAUDE_CODE_OAUTH_TOKEN` из
  `OMA_BRIDGE_CLAUDE_CODE_OAUTH_TOKEN` или `ANTHROPIC_API_KEY` из
  `OMA_BRIDGE_ANTHROPIC_API_KEY`. Унаследованные `ANTHROPIC_*` и `CLAUDE*` у
  процесса `claude-acp` удаляются, `OMA_BRIDGE_*` не наследует ни один ребёнок
  (`spawn-guard.ts:126-149`). Без этих переменных у Claude Code входа нет.
  Токен владелец получает сам (`claude setup-token` или ключ организации).
- `spawn-guard.ts:94-115`: env из bundle проходит только по
  `OMA_BRIDGE_ENV_ALLOWLIST` демона (по умолчанию пусто, то есть ничего), и
  никогда не проходят `NODE_*`, `NPM_CONFIG_*`, `ANTHROPIC_*`, `CLAUDE*`,
  `LD_*`, `DYLD_*`, `OMA_*`, `GIT_*`, `PYTHON*`, `PERL*`, `RUBY*`, `SSL_CERT_*`,
  `PATH`, `HOME`, `SHELL`, `BASH_ENV`, `ENV`, `ZDOTDIR`, `XDG_CONFIG_HOME`,
  `TMPDIR`, `IFS`, `PS4`, `PROMPT_COMMAND`, `*_PROXY` (`spawn-guard.ts:32-62`).
- `session-cwd.ts:111-140`: bundle не может записать `.claude/settings*.json`,
  `.mcp.json`, `.claude.json`, `.envrc`, ничего в `.git/`.
- `cwd` от сервера: раздел 5.
- `commands/daemon.ts:141-144`: в `hello` уходит `local_skills: {}`.
- Обе ветки запуска (managed `node-session-runtime.ts` и старая в
  `session-manager.ts`) идут через одну функцию `spawn-plan.ts:69`.

Подтверждено автотестами (`test/bridge-isolation.test.ts`, обе ветки), не живым
запуском Claude Code. **Не проверено запуском:** что `claude-agent-acp` и Claude
Code действительно применяют `disableAllHooks`, `deny` и
`disableBypassPermissionsMode` из этого конфига и принимают
`CLAUDE_CODE_OAUTH_TOKEN`. Проверять на изолированном конфиге первым же
прогоном, когда появится серверная часть.

### Что остаётся

- Запросы подтверждения (`session/request_permission`) демон отклоняет: колбэка
  нет, ответ `cancelled` (`@openma/common` 0.9.1, `dist/acp-runtime/session.js:331-343`).
  В изолированном конфиге `allow` пуст, значит Bash, Edit, чтение вне рабочей
  папки запрещены; агент может читать и писать только то, что Claude Code
  разрешает без подтверждения. Режимы обхода разрешений не включать.
- Остальное окружение демона (кроме перечисленного) наследуется ребёнком.
  Демон запускать из чистого окружения, без секретов других сервисов.
- Ключи `oma_*` и `sk_machine_*` лежат открытым текстом в
  `~/.oma/bridge/credentials.json`.
- Пока демон работает, ноутбук не засыпает по бездействию
  (`systemd-inhibit --what=idle:sleep --mode=block`,
  `packages/cli/src/bridge/lib/keep-awake.ts:7-8`).

### Условия запуска (обязательны для решения владельца)

1. **Только один пользователь (владелец) и только локальное демо.** Демон
   рассчитан на много тенантов (`session-manager.ts`, `setTenantKeys`). Если
   ноутбук подключён к тенанту, где сессии создают другие люди, каждый их ход
   идёт от имени владельца, по его лимитам и под его учётной записью. Для личной
   подписки это противоречит её условиям, данные тенантов обрабатываются под
   личным аккаунтом, и это одна точка отказа (ноутбук спит или не в сети). Для
   нескольких пользователей нужен ключ API организации или песочница на сервере
   (`acp-sandbox`), а не личный Claude Code.
2. Серверная часть должна разрешать сессии на этом runtime только его владельцу
   (проверка создателя сессии на сервере, демон её сделать не может).
3. Конфиг Claude Code изолирован (сделано), вход только через явную переменную
   демона, лучше отдельный ключ, а не личная подписка.
4. env из bundle только по allowlist демона, с запретом из раздела выше (сделано).
5. `cwd` от сервера только внутри `OMA_BRIDGE_CWD_ROOTS` после `realpath`
   (сделано); рабочая папка во временной папке (`OMA_BRIDGE_WORK_ROOT`).
6. `claude-agent-acp` ставить вручную закреплённой версией, `setup` без `--yes`,
   с `--no-service` и явным `--server-url`.
7. Первый живой прогон: один безобидный короткий ход (ответить словом, создать
   файл в рабочей папке и прочитать его), проверка, что хуки владельца не
   сработали и в `~/.claude/projects` владельца ничего не добавилось.

## 7. Остановка

- Демон на переднем плане: Ctrl-C или `kill -TERM <PID>`.
- systemd-вариант: `systemctl --user stop dev.openma.bridge`
  (`packages/cli/src/bridge/lib/platform.ts:80, 96`).
- `$OMA bridge uninstall` останавливает сервис и удаляет `credentials.json`, но
  на сервере ключи не отзывает: делает `DELETE` без входа и ждёт 401
  (`packages/cli/src/bridge/commands/uninstall.ts:46-61`). Отзывать из консоли.
- Сервер: `kill -TERM $(cat $T/server.pid)`, затем `rm -rf "$T"`.
- Рабочая папка агента: `rm -rf "$W"` после того, как нужные файлы скопированы
  в доказательства.

## 8. Перезапускаемая проверка

```sh
test-slot scripts/verify-claude-code-harness.sh   # папка по умолчанию: .verify-evidence/claude-code-harness/<время>/
```

Скрипт поднимает сервер на 8795 (`umask 077`, временная папка), заводит учётку,
сохраняет ответы маршрутов моста в `http/`, проверяет `oma bridge --help`, гоняет
тесты `packages/cli`, останавливает свой сервер по PID (группа процессов) и
удаляет временную папку. Пишет `verify.txt` и `summary.md`. Claude Code не
запускает. Код выхода 0 значит «состояние совпало с этим рецептом», а не
«мост работает»: приёмка записана отдельной строкой `ACCEPTANCE`.

## 9. Что есть вместо моста сейчас

- `acp-sandbox`: Claude Code (`claude-agent-acp`) работает внутри песочницы
  сервера (LiteBox), не на хосте и не с входом владельца. Есть e2e-тест
  `apps/main-node/test/acp-sandbox-harness.e2e.test.ts`. **Рекомендуется
  начинать с него:** он не трогает ноутбук и учётные данные владельца.
- self_hosted Environment Work (`/v1/environments/:id/work/*`): очередь на Node
  есть, готового воркера для ноутбука в репозитории нет.

## 10. Чего не хватает серверу для моста

Это описание пробела, а не сделанная работа.

1. Маршруты `/v1/oma/runtimes` (список в формате `{runtimes:[...]}`, его ждёт
   консоль), `connect-runtime`, `DELETE /:id`; `/agents/runtime/exchange`, `me`,
   `:id/refresh`, `sessions/:sid/bundle`.
2. WebSocket `/agents/runtime/_attach` и замена RuntimeRoom в процессе Node.
   Сейчас `serve.ts` не обрабатывает upgrade, пакета `ws` в `apps/main-node` нет.
3. Таблицы `runtimes`, `runtime_tokens`, `connect_runtime_codes` в миграциях Node
   есть, `runtime_tenants` нет.
4. Регистрация `acp-proxy` на Node и `RUNTIME_ROOM` в контексте harness.
5. Для таких сессий на managed-пути Node: режим без песочницы. Выбор режима уже
   есть (`apps/main-node/src/modules/node-managed.ts:426` вызывает
   `resolveSessionSandboxMode`), и режим `none` уже реализован для
   `environment.type === "none"`
   (`packages/openai-agents-compat/src/session-mapping.ts:64-69`); его можно
   переиспользовать. Ещё: без ключа модели (иначе ошибка,
   `apps/main-node/src/modules/node-foundation.ts:331`), текст пользователя в
   `userMessage` (сейчас пустой, `node-managed.ts:617`).
6. `notifyDaemonDispose` для Node.
7. Проверка на сервере, что сессию на runtime создаёт только его владелец
   (условие 2 раздела 6).

Эта работа даёт серверу запускать задания в Claude Code владельца на ноутбуке.
Её начало было заблокировано системой разрешений. Продолжать можно только после
явного решения владельца и с условиями раздела 6. Рекомендация: сначала
`acp-sandbox` на сервере.
