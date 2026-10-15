---
name: verify-agent-console
description: Проверка конструктора агентов (копия OpenMA, platform/apps/main-node + консоль platform/apps/console на русском, стиль DDC) через интерфейс консоли в Playwright. Поднимает изолированный экземпляр на SQLite с пустой папкой данных (порт 8791), заводит тестовую учётку и проходит путь «окружение → проверка песочницы LiteBox → настройки окружения (пакет, сеть) в VM → агент → сессия → ход агента с bash в VM → ответ», сверяя побочные эффекты через API, поток событий и файлы. Брать, когда нужно доказать, что окружения, агенты, сессии или ход агента работают после правок, или когда просят «проверить консоль / environment / агента».
---

# verify-agent-console

Скилл поднимает свой экземпляр сервера и консоли и проходит главный сценарий так, как это делает пользователь.
Всё, что пользователь видит, проверяется в браузере. Побочные эффекты (записи в БД, файлы, VM, поток событий) проверяются через API и файловую систему.

Папка скилла: `.claude/skills/verify-agent-console/`, дальше `S=.claude/skills/verify-agent-console/scripts`.
Команды запускаются из корня репозитория `/home/vnkjd/orca/projects/ai-native-backoffice-v3`.

**Статус.** Скилл прогнан целиком 2026-10-15 (прогон `20261015-192728`: Node 24.21.0, Playwright 1.59.1 с Chromium 1243, fake-модель, LiteBox на `/dev/kvm`, git `b62dd98`). Цепочка от launch до конца cleanup заняла 77 с, включая сборку консоли, при образе VM уже в кэше.
Ожидаемый итог на текущем коде — «ПРОВАЛ»: 77 проверок, 7 провалов, и все они — дефекты продукта, а не скилла:
- `env.probe.network`, `env.networking_limited_applied` — сетевой запрос из VM обрывает exec BoxLite, и VM перестаёт отвечать;
- `env.packages_applied` — пакеты окружения на main-node не ставятся;
- `session.title_saved` — название из окна «Новая сессия» теряется;
- `run.ui_prompt_on_send`, `run.ui_prompt_visible` — реплика пользователя не видна в разговоре до перезагрузки страницы;
- `run.ui_tool_output_text` — вывод bash в карточке показан JSON-массивом content-блоков.

Подфункций карты пройдено 16 из 37, остальные 21 идут строками «не проверено» `feature.*`.
Если упало что-то другое, исправьте скрипт и карту функций. Проверки не ослабляйте.

## Предусловия

Один раз на машине (скилл их не ставит, а проверяет и падает с понятной ошибкой):

```sh
eval "$(fnm env)"; fnm use 24                  # Node 24 (launch.sh и journey.sh сами вызывают fnm)
cd platform && pnpm install --frozen-lockfile  # packageManager pnpm@11; нужны tsx в apps/main-node и vite в apps/console
pnpm exec playwright install chromium          # Playwright 1.59.1 ждёт Chromium ревизии 1217
sudo pacman -S sqlite jq                       # sqlite3 и jq нужны launch.sh (на этой машине уже стоят)
```

- `/dev/kvm` доступен на чтение и запись (LiteBox поднимает микро-VM).
- Порты 8791 и 8792 свободны.
- Без `playwright install` сценарий берёт самую новую ревизию из `~/.cache/ms-playwright` с `INSTALLATION_COMPLETE` (на этой машине 1243, а не 1217) или `/usr/bin/google-chrome-stable`. Свой путь: `VERIFY_CHROMIUM=<путь>`.
- `pnpm install` и `playwright install` в прогоне 2026-10-15 не запускались: зависимости уже стояли, Chromium 1217 не скачивался.

**Таймауты инструмента Bash.** По умолчанию команда Bash живёт 120 с, максимум 600 с. Цепочка целиком идёт около 1–2 минут при прогретом кэше, но первый прогон с новым `BOXLITE_HOME` скачивает образ, `vac_wait_cool` может ждать до 10 минут, а таймаут первого хода 900 с. Поэтому цепочку запускайте с `run_in_background: true` (и читайте лог), а не в переднем плане. Если сценарий всё же убьют по таймауту, `cleanup.sh` остановит его процессы: PID сценария и Chromium записаны в `state/pids`.

## Правила изоляции (читать до запуска)

- **Порты 8787, 8788, 5173, 5174 чужие.** Там работают другой workflow и пробная копия владельца. Процессы на них не трогать. `lib.sh` откажется работать с этими портами.
- **Наши порты.** Сервер с консолью: `VERIFY_PORT=8791`. Фейковая модель: `VERIFY_FAKE_PORT=8792`.
- **`platform/apps/console/dist` не трогать.** Консоль собирается в папку прогона и отдаётся сервером через `CONSOLE_DIR`.
- **Данные прогона** лежат в `~/.cache/verify-agent-console/runs/<RUN_ID>/`: БД, сборка консоли, логи, учётка и секреты. Cleanup удаляет эту папку.
- **Прогон задаётся только явно.** `launch.sh` печатает на stdout папку прогона; `doctor.sh`, `seed-user.sh`, `journey.sh` и `cleanup.sh` принимают её через `--run <RUN_ID|папка>` или `VERIFY_RUN_DIR=<папка>` и без неё не работают. Общего указателя «текущий прогон» нет: иначе cleanup после отказа launch остановил бы чужой прогон (другого агента или оставленный через `VERIFY_KEEP_SESSION=1`).
- **Кэш между прогонами:**
  - `~/.cache/verify-agent-console/boxlite` — это `BOXLITE_HOME`, там образы VM;
  - `~/.cache/verify-agent-console/home` — это `HOME` сервера.

  Общий `~/.boxlite` не используется, потому что BoxLite разрешает один рантайм на папку.
  Отсюда ограничение: **одновременно может идти только один прогон.** `launch.sh` проверяет все папки в `runs/` и откажется стартовать, пока у какой-то из них жив записанный процесс. Чужой прогон он не останавливает.
- **Тяжёлые команды** (сборка, сервер, Playwright, VM) запускаются через `nice -n 15` и строго по одной.
  Перед ними `vac_wait_cool` проверяет нагрузку. Если load1 ≥ 10 или CPU ≥ 93°C, он ждёт 60 с, не больше 10 раз.
- **Процессы останавливаются только по своим PID.** PID пишутся в `state/pids` вместе со временем старта: `server-tsx`, `server-node`, `fake-model`, `journey`, `journey-child` (Chromium). По имени процессы не убиваются никогда.
- **Чужие контейнеры не трогать:** `backoffice-*`, `qm-backoffice-*`, `mvp-test-pg`, `bo-registry`, `oma-dev-pg`.
- **`.env` не читать.** Значения из `platform/.env` не нужны: секреты этого прогона генерируются в `state/secrets.env`. Наличие переменной проверяется только командой `grep -c '^ИМЯ=.' platform/.env`. Исключение — режим `real` (см. ниже), он требует согласия владельца.

## Launch

```sh
RUN="$($S/launch.sh)"     # stdout: одна строка, папка прогона; весь журнал идёт в stderr
```

Что делает (`scripts/launch.sh`):

1. Проверяет инструменты, Node 24 через fnm, наличие `/dev/kvm`, что порты свободны и не из чужого списка и что ни один прогон в `runs/` не жив.
2. Создаёт пустую папку прогона `runs/<RUN_ID>` (RUN_ID имеет вид `YYYYmmdd-HHMMSS`) и папку доказательств `.verify-evidence/<RUN_ID>/`. Записывает в `run.env` git HEAD и хэши изменений рабочего дерева консоли и сервера (`git diff HEAD` плюс неотслеживаемые файлы).
3. Собирает консоль командой `nice -n 15 vite build --outDir <прогон>/console`. Чтобы взять готовую сборку и пропустить этот шаг, задайте `VERIFY_CONSOLE_DIR=<папка с index.html>`.
4. В режиме `fake` запускает `fake-model.mjs` на 8792.
5. Запускает `main-node` (`nice -n 15 ./node_modules/.bin/tsx src/index.ts`, без watch) с чистым окружением:
   - `DATABASE_URL` не задан, поэтому база SQLite;
   - все пути данных указывают в папку прогона;
   - `SANDBOX_PROVIDER=litebox`, `SANDBOX_IMAGE=node:22-bookworm`;
   - `DREAM_CURATOR_MODE=dedup`;
   - в режиме `fake` дополнительно `ANTHROPIC_API_KEY=verify-local-fake-key` и `ANTHROPIC_BASE_URL=http://127.0.0.1:8792`.

**Готовность.** Это не «процесс отвечает», а все условия ниже. Каждая строка пишется в `logs/launch.txt` с пометкой OK или FAIL:

- `GET /health`:
  - `status=ok`;
  - `backends.db = "sqlite <прогон>/data/oma.db"`;
  - `auth = "better-auth-sqlite"`;
  - `memory_blobs` и `files_blobs` равны `localfs <прогон>/data/...`.
- `GET /auth-info` возвращает `email_password: true`.
- `GET /` отвечает 200 с `text/html`, и sha256 ответа совпадает с sha256 `index.html` этой сборки.
- Строк в `__drizzle_migrations` столько же, сколько записей в `migrations-sqlite/meta/_journal.json`. Сейчас это 28.
- В логе есть `"op":"main-node.listening"`, а строк с `"level":50` ноль.
- Родитель процесса с `/health.pid` — наш tsx, и порт 8791 слушает именно этот node.

Код 0 и строка `ГОТОВО: http://127.0.0.1:8791` в stderr означают, что экземпляр годен; на stdout в этот момент печатается папка прогона.
Код 1: экземпляр не готов. Если папка прогона уже создана, launch сам вызывает `cleanup.sh` для **своей** папки (останавливает всё, что успел запустить) и пишет в `summary.md` итог «ПРЕРВАН на шаге launch» с причиной. Если launch отказался раньше (порт занят, жив другой прогон), он ничего не создаёт и ничего не останавливает.

**Режим real** (настоящая модель, тратит деньги) включается только явно: `VERIFY_MODEL_MODE=real $S/launch.sh`. **Не проверялся ни разу.**
Скрипт проверяет, что `grep -c '^ANTHROPIC_API_KEY=.' platform/.env` равен 1, затем внутри подоболочки сервера берёт `sed`-ом только значения `ANTHROPIC_API_KEY` и `ANTHROPIC_BASE_URL` (без `source` всего файла, значения не печатаются). Это расходится с правилом владельца «.env не читать», поэтому перед первым запуском режима нужно его согласие.
Модель агента `claude-sonnet-4-6`, её можно поменять через `VERIFY_AGENT_MODEL`.

**Остановка:** `$S/cleanup.sh --run "$RUN"`, см. раздел Cleanup.

## Doctor

```sh
$S/doctor.sh --run "$RUN"   # не меняет экземпляр; код 0 = можно вести, 1 = нет
```

Запускать первым, когда что-то выглядит странно, и перед каждым сценарием. Вывод дублируется в `.verify-evidence/<RUN_ID>/logs/doctor-<ЧЧММСС>.txt`. Что проверяет:

- процессы прогона живы, и это те же PID (сверяется время старта);
- порт 8791 слушает наш node;
- `/health.pid` указывает на наш процесс, а база и blobs лежат в папке прогона;
- `GET /` отдаёт `index.html` нашей сборки;
- **код не менялся после launch:** git HEAD и хэши изменений консоли (`platform/apps/console`) и сервера (`platform/apps/main-node`, `platform/packages`) равны значениям из `run.env`. Сервер идёт без watch, а консоль собрана один раз, поэтому после правок старый экземпляр крутит прежний код; при расхождении FAIL;
- `/auth-info` в порядке;
- cookie тестовой учётки принимается: `/v1/oma/me` и `/v1/agents` отвечают 200;
- фейковая модель отвечает;
- `/dev/kvm` доступен;
- `BOXLITE_HOME/.lock` не держит чужой процесс;
- в логе нет ошибок уровня 50;
- нагрузка.

Если в выводе есть FAIL, этот экземпляр не вести: остановите его (`$S/cleanup.sh --run "$RUN"`) и запустите заново. При FAIL doctor пишет «ПРЕРВАН на шаге doctor» в `summary.md`, если сценарий его ещё не записал.

## Drive

Порядок полного прогона (cleanup запускается, только если launch создал прогон, и только для него):

```sh
RUN="$($S/launch.sh)" && { $S/doctor.sh --run "$RUN" && $S/seed-user.sh --run "$RUN" && $S/journey.sh --run "$RUN"; $S/cleanup.sh --run "$RUN"; }
```

Запускайте эту строку через `run_in_background: true` с перенаправлением в лог (см. «Таймауты инструмента Bash»).

1. **`seed-user.sh`** создаёт тестовую учётку запросом `POST /auth/sign-up/email` с заголовком `origin: http://127.0.0.1:8791`.
   - Почта имеет вид `verify-<RUN_ID>@verify.test`, пароль случайный.
   - Хук Better Auth сам создаёт рабочее пространство `tn_…`.
   - Скрипт сверяет почту и `user.id` через `GET /auth/get-session`, а `user.id`, tenant и роль owner — через `/v1/oma/me`.
   - Почта, пароль, `user_id` и `tenant_id` сохраняются в `state/test-user.json` (права 600, пароль не печатается), cookie — в `state/cookies.txt`.
2. **`journey.sh`** записывает свой PID (роль `journey`), проверяет нагрузку и запускает `nice -n 15 node journey-env-to-agent.mjs`. Сценарий пишет PID Chromium (роль `journey-child`). Шаги:
   - **Вход.** На `/login` нажать «Продолжить с почтой», заполнить `#auth-email` и `#auth-password`, затем в группе «Действия входа» нажать «Войти». Дождаться навигации и h1 в `main`. Проверяются cookie `better-auth.session_token`, почта и `user.id` в `GET /auth/get-session`, тот же `user.id` и tenant в `/v1/oma/me`.
     На main-node `/v1/oma/me` всегда отдаёт `user.email: ""`: `buildMeRoutes` подключён без `loadUser` (`apps/main-node/src/modules/node-http.ts:444-475`). Это строка «внимание» `auth.me_email`, почта сверяется через Better Auth.
   - **Окружение.** Ссылка «Окружения» в навигации «Разделы консоли». Перед скриншотом сценарий ждёт h1 «Окружения» в `main` и пустое состояние «Окружений пока нет» (`env.list_empty`) или строку таблицы, а не смену URL. Дальше «Новое окружение», окно `dialog "Новое окружение"`, поля «Название» и «Описание (необязательно)», «Создать». Затем:
     - строка `[data-testid="data-body-table"] tr[data-slot="table-row"]` с именем окружения;
     - сверка через `GET /v1/environments/:id`;
     - карточка `/environments/:id` (h1 и `#env-name`).
   - **Проба окружения (обходной путь).** Действия «проверить окружение» нет ни в консоли, ни в API, а песочница создаётся лениво (`apps/main-node/src/lib/node-session-router.ts:41`). Поэтому по API создаются технический агент (только bash) и сессия на новом окружении, и отправляется одна команда. Проба доказывает:
     - VM поднялась: `Box started successfully` в логе BoxLite, процесс `libkrun VM` с pid из строки `boxlite-shim subprocess spawned … pid=N` — потомок нашего server-node, папка `.openma/litebox-scratch-*`;
     - VM выполнила команду: `agent.tool_result` содержит `VERIFY_OK_<nonce>`; ядро в VM отличается от ядра хоста;
     - база для настроек: пакета `jq` в образе нет (`env.probe.baseline`);
     - сессия пробы видна в консоли с репликой и ответом (`env.probe.ui_visible`, страница открыта заново, история из `GET /events`);
     - сеть «Без ограничений» (`env.probe.network`): отдельный ход `curl https://example.com` из VM и ещё один ход `echo` — жива ли VM после запроса. База — код того же адреса с хоста. Сейчас **провал**: с хоста код 200, а в VM ход с `curl` заканчивается `Attach stream error … h2 protocol error` и `[exit -1]`, следующий ход получает `Connection refused (os error 111)`. Поэтому сетевые ходы идут последними в сессиях пробы.

     Затем сессия архивируется, и проверяется, что VM остановилась (`Box stopped`, scratch удалён).
   - **Настройки окружения.** Снова «Окружения» → строка → карточка. Изменить `#env-description`, в «Тип доступа» выбрать «Ограниченный», включить «Разрешить сетевой доступ менеджерам пакетов», «Добавить пакет» → менеджер `apt`, «Пакеты и версии» `jq`, «Сохранить изменения», тост «Окружение сохранено». Сверка `GET /v1/environments/:id` (`env.settings_saved`). Затем новая сессия на этом окружении (песочница создаётся заново):
     - `env.packages_applied` — в VM установлен `jq` (`dpkg-query`). Сейчас **провал**: установка пакетов (`ensureSetupApplied`) вызывается только в Cloudflare SessionDO (`apps/agent/src/runtime/session-do.ts:3608`), в `apps/main-node` её нет;
     - `env.networking_limited_applied` — `curl https://example.com` из VM даёт 000, и VM отвечает после запроса. Сейчас **провал**: тот же обрыв exec, что и без ограничений, а в коде LiteBox сеть всегда `enabled` (`packages/sandbox-adapter-litebox/src/litebox.ts:325`). См. Gotchas сети в `features/environments.md`.

     Шаги настроек не обязательные: их сбой пишется провалом, а сценарий идёт к агенту. В конце технический агент пробы архивируется, чтобы шаг агентов шёл по пустому списку.
   - **Агент.** «Агенты» (h1 и пустое состояние «Агентов пока нет», `agent.list_empty`), «Новый агент», шаблон-кнопка `/^Пустой агент/`, `#agent-name` и `#agent-system`, вкладка «Инструменты». Без карточек моделей в форме нет группы «Модель» (строка «внимание» `agent.form_without_model_cards`), поэтому в группе «Режим правки» переключиться на «YAML», в textbox «Конфигурация агента в формате YAML» вписать `model: claude-sonnet-4-6` и нажать «Создать агента». Результат: переход на `/agents/:id`, модель видна в регионе «Свойства агента». Запись сверяется через `GET /v1/agents/:id`.
   - **Сессия.** «Сессии» (h1), «Новая сессия». В окне два безымянных `combobox`: первый — агент, второй — окружение. В каждом выбрать `[data-slot="command-item"]` с нужным id. Заполнить `#session-title`, нажать «Создать». Результат: переход на `/sessions/:id`, в шапке бейджи `[title="Агент: …"]` и `[title="Окружение: …"]`. Сверка через API: `agent.id`, `environment_id`, `archived_at = null`.
     - `session.title_saved` сейчас **провал**: введённое название не сохраняется, `title = null`, в h1 «Сессия без названия». Причина в консоли: `pages/SessionsList.tsx:865-867` ставит `name="oma-session-title"` поверх `{...register("title")}`, а `onChange` react-hook-form 7.75 ищет поле по `event.target.name`. Правка: убрать переопределение `name` (или вести поле через `Controller`).
     - `session.initial_status` — «внимание»: сервер создаёт сессию со `status: "running"` (`packages/managed-agents-application/src/sessions/application.ts:322`), поэтому консоль до первого сообщения показывает «Выполняется» и «Агент работает…».
   - **Ход агента.** Сценарий открывает тот же поток `GET /v1/sessions/:id/events/stream`, что и консоль (cookie браузера), затем в textbox «Сообщение» вводит промпт с маркером и нажимает кнопку отправки. Её подпись зависит от статуса (`SessionComposer.tsx:163-166`): в новой сессии это «Поставить сообщение в очередь» (строка «внимание» `run.ui_send_label`). Проверки в интерфейсе:
     - `run.ui_prompt_on_send` и `run.ui_prompt_visible` — реплика пользователя (`[data-session-turn-prompt]` с `nonce=<n>`) видна в ходе сразу после отправки и после конца хода. Сейчас обе **провал**: реплики нет, пока страницу не перезагрузить (`run.ui_prompt_after_reload` проходит). Поток не отдаёт `user.message` (`run.sse_user_message`, «внимание»), см. Gotchas в `features/sessions-and-agent-run.md`;
     - `article[data-turn-id]` получил `data-session-turn-status=completed`, ответ виден в `[data-session-turn-answer]`;
     - раскрывается карточка `bash` (`[data-chat-reasoning-trigger]` → `[data-slot="collapsible-trigger"]` → содержимое с `VERIFY_OK_<nonce>`);
     - `run.ui_tool_output_text` — вывод в карточке показан текстом (строка `kernel=` отдельно, без `"type": "text"`, без литералов `\n` и `\u001b`). Сейчас **провал**: карточка показывает JSON-массив content-блоков (`components/session/CanonicalSessionTurn.tsx:140-147` делает `JSON.stringify`, `components/ai-elements/tool.tsx:187-209` рисует строку с «[» как JSON). Текст карточки сохраняется в `api/45-tool-card-text.txt`;
     - на вкладке «Хронология» есть строка `[title^="bash · "]`;
     - в панели «Файлы сессии» есть ссылка `verify-<nonce>.txt`.

     Через API и файлы проверяется:
     - порядок событий `user.message → agent.tool_use(bash) → agent.tool_result → agent.message → session.status_idle(end_turn)`;
     - `GET /v1/sessions/:id/outputs`;
     - файл `<прогон>/data/session-outputs/<tenant>/<session>/verify-<nonce>.txt` с содержимым `VERIFY_OK_<nonce>`. Он записан внутри VM в `/mnt/session/outputs`;
     - ядро VM отличается от ядра хоста;
     - записи BoxLite (третий старт VM) и процесс VM — потомок нашего сервера;
     - вывод bash без служебных строк рантайма (`tool_output_clean`). Сейчас «внимание»: в каждый `tool_result` попадает stderr `libcontainer … seccomp not available` с ANSI-цветами;
     - решения фейковой модели.

     В конце сессия архивируется, и проверяется остановка VM.
   - **Итог.** Для каждой подфункции из разделов `Sub-features` в `features/*.md`, которую сценарий не прошёл, в `summary.md` автоматически пишется строка «не проверено» `feature.<id>`. Скриншоты соседних шагов сравниваются по sha256 (`evidence.screens_distinct`).

Чтобы оставить сессии живыми для ручного осмотра, задайте `VERIFY_KEEP_SESSION=1`. Чтобы видеть браузер, задайте `VERIFY_HEADED=1`.
Таймауты ходов: `VERIFY_FIRST_TURN_TIMEOUT_MS` (по умолчанию 900000) и `VERIFY_TURN_TIMEOUT_MS` (по умолчанию 600000).
Первый ход с новым `BOXLITE_HOME` скачивает образ `node:22-bookworm` и собирает его диск: 2026-10-15 это заняло около минуты, кэш вырос до 3 ГБ. Дальше проба идёт за 2–8 с.

Устойчивые зацепки и ловушки по каждой функции описаны в `features/` (начните с `features/README.md`).

## Evidence

Всё лежит в `.verify-evidence/<RUN_ID>/`. Строка `.verify-evidence/` есть в корневом `.gitignore` (закоммичена в `b62dd98`), cleanup эту папку не удаляет.

- `summary.md` — итог «ПРОЙДЕН / ПРОВАЛ / ПРЕРВАН» (при сбое до сценария «ПРЕРВАН на шаге launch / doctor / seed-user / journey» с причиной), id и пути, затем таблица проверок со статусами «проверено», «провал», «внимание», «не проверено» и список скриншотов с sha256.
- `screens/NN-<шаг>.png` — скриншот действия и скриншот результата на каждый шаг. Ширина 1280; оболочка консоли прокручивает `main`, а не документ, поэтому на время снимка окно растягивается на высоту внутренней прокрутки (до 6000 px), и видна вся карточка. Скриншоты `fail-<проверка>.png`, `fail-step-<шаг>.png` и `NN-abort.png` снимаются в момент сбоя и в сравнении sha256 не участвуют.
- `aria/NN-<шаг>.yml` — ARIA-снимки карточек окружения и агента, сохранённых настроек и завершённого хода.
- `api/`:
  - ответы `/health`, `/auth-info`, `/v1/oma/me`, `/auth/get-session` (без токена);
  - окружение до и после настроек, агент, сессии, архивы;
  - полные журналы событий сессий: проба (`21-…`, сеть `21b-…`), проба настроек (`22-…`, `22b-…`), главная сессия (`41-…`);
  - поток событий главной сессии `41-session-stream.json` (что консоль получает вживую);
  - текст карточки bash `45-tool-card-text.txt`, outputs, YAML агента, копия файла из VM;
  - `fake-model-requests.jsonl`.
- `logs/`:
  - `launch.txt`, `console-build.log`, `doctor-<время>.txt`;
  - `main-node.journey.log` (снимок после сценария), `main-node.final.log` (после остановки);
  - `fake-model.log`, `cleanup.txt`.

Стандарты доказательства:

- **Пользовательский путь.** Окружение, его настройки, агент, сессия и сообщение создаются через консоль. API используется для двух вещей: для сверки, и для проб окружения, потому что в продукте для них нет пути. В `summary.md` проба помечена как обходной путь (`env.probe_path`).
- **Действие и результат.** На каждый шаг есть скриншот до действия и скриншот результата. Перед снимком ждём содержимое страницы (h1, строку, пустое состояние, очищенное поле ввода), а не URL. Два подряд одинаковых по sha256 снимка шагов — провал `evidence.screens_distinct`. Состояние после действия подтверждается вторым способом: API, файлом, потоком событий или логом.
- **Побочные эффекты:**
  - записи в БД видны через API;
  - файл из VM лежит на хосте;
  - BoxLite записал старт и остановку VM;
  - процесс VM (`libkrun VM`, pid из лога BoxLite) — потомок нашего server-node.
    Строки `creating box` в логе сервера нет: логгер litebox-sandbox на main-node — заглушка, потому что адаптер грузится в `components.ts:90` раньше `setRootLogger` (`modules/node-foundation.ts:98`), а `getLogger` вызывается при импорте (`litebox.ts:34`). В `summary.md` это строка «внимание» `*.server_log_box`.
- **Где мок.** Мок только один — модель. Это внешний провайдер, и сервер ходит к нему через `ANTHROPIC_BASE_URL`, как в тестах репозитория (`apps/main-node/test/_helpers/openai-node-process.ts`). Песочница настоящая: LiteBox с микро-VM через `/dev/kvm`. Сетевая проба ходит на настоящий `https://example.com` (и с хоста для базы).
- **Что фейк не проверяет:** доступ к api.anthropic.com, работу ключа и качество ответа. Это строка «не проверено» в `summary.md`. Проверить можно только в режиме `real`.

## Cleanup

```sh
$S/cleanup.sh --run "$RUN"               # или --keep-state, чтобы оставить папку прогона для разбора
```

Без `--run` (или `VERIFY_RUN_DIR`) скрипт ничего не делает. Что делает:

0. Останавливает сценарий и Chromium, если они ещё живы (роли `journey`, `journey-child` и потомки `journey`).
1. Пока сервер жив, архивирует сессии из `state/created.json`, чтобы VM остановились штатно.
2. Записывает потомков сервера: PID и время старта.
3. Отправляет SIGTERM tsx (сигнал передаётся node), затем node и фейковой модели. Ждёт 30, 10 и 5 с соответственно, после чего шлёт SIGKILL только этим PID.
4. Останавливает записанных потомков, которые пережили сервер.
5. Копирует финальные логи в доказательства и проверяет, что порты 8791 и 8792 свободны.
6. Сообщает о процессах, у которых в командной строке есть путь `BOXLITE_HOME`, но не убивает их.
7. Удаляет `runs/<RUN_ID>` только если всё освобождено.
8. Если `summary.md` нет (сбой до сценария), пишет «ПРЕРВАН» с причиной; печатает число файлов в папке доказательств.

Доказательства и кэш BoxLite не удаляются. После cleanup проверьте, что `.verify-evidence/<RUN_ID>/summary.md` на месте.
Запускайте cleanup и после неудачного прогона (с тем же `--run`), чтобы не оставлять процессы и порты.

## Helpers

| Скрипт | Вызов | Что делает |
|---|---|---|
| `scripts/lib.sh` | `$S/lib.sh` | Общие функции. При прямом запуске печатает порты, папки и живые прогоны |
| `scripts/launch.sh` | `RUN="$($S/launch.sh)"` | Сборка консоли, фейковая модель, сервер, проверка готовности; stdout — папка прогона |
| `scripts/doctor.sh` | `$S/doctor.sh --run "$RUN"` | Можно ли вести экземпляр, включая сверку кода с моментом launch |
| `scripts/seed-user.sh` | `$S/seed-user.sh --run "$RUN"` | Тестовая учётка и её рабочее пространство |
| `scripts/journey.sh` | `$S/journey.sh --run "$RUN"` | PID сценария, проверка нагрузки, Node 24, `nice` и запуск главного сценария |
| `scripts/journey-env-to-agent.mjs` | через `journey.sh` | Сценарий Playwright, проверки и `summary.md` |
| `scripts/fake-model.mjs` | запускает `launch.sh` (`node fake-model.mjs --port 8792 --log f.jsonl`) | Модель Anthropic Messages (SSE): bash с командой из промпта, затем `VERIFY_DONE_<nonce>` |
| `scripts/cleanup.sh` | `$S/cleanup.sh --run "$RUN" [--keep-state]` | Остановка по своим PID и уборка временных данных одного прогона |

Переопределяемые переменные:

- `VERIFY_PORT`, `VERIFY_FAKE_PORT`;
- `VERIFY_STATE_ROOT`, `VERIFY_BOXLITE_HOME`, `VERIFY_EVIDENCE_ROOT`;
- `VERIFY_MODEL_MODE`, `VERIFY_AGENT_MODEL`, `VERIFY_SANDBOX_IMAGE`;
- `VERIFY_CONSOLE_DIR`, `VERIFY_RUN_DIR`, `VERIFY_RUN_ID`, `VERIFY_START_TIMEOUT_S`;
- сценарий: `VERIFY_KEEP_SESSION`, `VERIFY_HEADED`, `VERIFY_CHROMIUM`, `VERIFY_FIRST_TURN_TIMEOUT_MS`, `VERIFY_TURN_TIMEOUT_MS`.
