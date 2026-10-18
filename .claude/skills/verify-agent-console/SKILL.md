---
name: verify-agent-console
description: Проверка конструктора агентов (копия OpenMA, platform/apps/main-node + консоль platform/apps/console на русском, стиль DDC) через интерфейс консоли в Playwright. Поднимает изолированный экземпляр на SQLite с пустой папкой данных (порт 8791), заводит тестовую учётку и проходит путь «окружение → проверка песочницы LiteBox → настройки окружения (пакет, сеть) в VM → агент → сессия → ход агента с bash в VM → ответ», сверяя побочные эффекты через API, поток событий и файлы. Брать, когда нужно доказать, что окружения, агенты, сессии или ход агента работают после правок, или когда просят «проверить консоль / environment / агента».
---

# verify-agent-console

Скилл поднимает свой экземпляр сервера и консоли и проходит главный сценарий так, как это делает пользователь.
Всё, что пользователь видит, проверяется в браузере. Побочные эффекты (записи в БД, файлы, VM, поток событий) проверяются через API и файловую систему.

Папка скилла: `.claude/skills/verify-agent-console/`, дальше `S=.claude/skills/verify-agent-console/scripts`.
Команды запускаются из корня репозитория `/home/vnkjd/orca/projects/ai-native-backoffice-v3`.

**Ожидаемый итог на текущем коде.** Главный сценарий «ПРОЙДЕН», 91 проверка, 0 провалов, строк «внимание» нет, подфункций карты 26 из 47, остальные идут строками «не проверено» `feature.*` (`20261018-140626`). `mcp-ask` «ПРОЙДЕН», 19 проверок, 0 провалов, строк «внимание» нет, подфункций 6 из 6 (`20261018-140732`). `multiagent` «ПРОЙДЕН», 21 проверка, 0 провалов, строк «внимание» нет, подфункций 12 из 12 (`20261018-141340`). Находка 5 ревью исправлена: Pi больше не пишет своё `agent.thread_message_sent`, журнал сессии с делегированием отвечает 200, и «Разрешить» в потоке субагента идёт кликом в консоли. `crud` «ПРОЙДЕН», 25 проверок, подфункций 7 из 7, на хранилищах git `45694b6` (`20261018-051113`). `builder` «ПРОЙДЕН», 55 проверок, подфункций 20 из 21, не проверена только `builder-qwen`; прежние строки «не проверено» `vb.tunnel_token`, `vb.after_click_window` и `vb.rerun_6_2` на месте (`20261018-045443`).
Когда прогон упал или проверка ведёт себя неожиданно, прочитайте `HISTORY.md`: там прошлые провалы с причинами, снимки дерева и сбои машины по датам. Если упало то, чего там нет, исправьте скрипт и карту функций. Проверки не ослабляйте.

## Предусловия

Один раз на машине (скилл их не ставит, а проверяет и падает с понятной ошибкой):

```sh
eval "$(fnm env)"; fnm use 24                  # Node 24 (launch.sh и journey.sh сами вызывают fnm)
cd platform && pnpm install --frozen-lockfile  # packageManager pnpm@11; нужны tsx в apps/main-node и vite в apps/console
pnpm exec playwright install chromium          # Playwright 1.59.1 ждёт Chromium ревизии 1217
sudo pacman -S sqlite jq                       # sqlite3 и jq нужны launch.sh (на этой машине уже стоят)
```

- `/dev/kvm` доступен на чтение и запись (LiteBox поднимает микро-VM).
- Порты 8791, 8792 и 8793 свободны.
- Без `playwright install` сценарий берёт самую новую ревизию из `~/.cache/ms-playwright` с `INSTALLATION_COMPLETE` (на этой машине 1243, а не 1217) или `/usr/bin/google-chrome-stable`. Свой путь: `VERIFY_CHROMIUM=<путь>`.

**Таймауты инструмента Bash.** По умолчанию команда Bash живёт 120 с, максимум 600 с. Цепочка целиком идёт от 1 до 2 минут при прогретом кэше, но первый прогон с новым `BOXLITE_HOME` скачивает образ, `vac_wait_cool` может ждать до 10 минут, а таймаут первого хода 900 с. Поэтому цепочку запускайте с `run_in_background: true` (и читайте лог), а не в переднем плане. Если сценарий всё же убьют по таймауту, `cleanup.sh` остановит его процессы: PID сценария и Chromium записаны в `state/pids`.

## Правила изоляции (читать до запуска)

- **Порты 8787, 8788, 5173, 5174 чужие.** Там работают другой workflow и пробная копия владельца. Процессы на них не трогать. `lib.sh` откажется работать с этими портами.
- **Наши порты.** Сервер с консолью: `VERIFY_PORT=8791`. Фейковая модель: `VERIFY_FAKE_PORT=8792`. Фейковый MCP-сервер: `VERIFY_FAKE_MCP_PORT=8793`.
- **`platform/apps/console/dist` не трогать.** Консоль собирается в папку прогона и отдаётся сервером через `CONSOLE_DIR`.
- **Данные прогона** лежат в `~/.cache/verify-agent-console/runs/<RUN_ID>/`: БД, сборка консоли, логи, учётка и секреты. Cleanup удаляет эту папку.
- **Прогон задаётся только явно.** `launch.sh` печатает на stdout папку прогона; `doctor.sh`, `seed-user.sh`, `journey.sh` и `cleanup.sh` принимают её через `--run <RUN_ID|папка>` или `VERIFY_RUN_DIR=<папка>` и без неё не работают. Общего указателя «текущий прогон» нет: иначе cleanup после отказа launch остановил бы чужой прогон (другого агента или оставленный через `VERIFY_KEEP_SESSION=1`).
- **Кэш между прогонами.** `~/.cache/verify-agent-console/boxlite` это `BOXLITE_HOME` с образами VM, `~/.cache/verify-agent-console/home` это `HOME` сервера.
  Общий `~/.boxlite` не используется, потому что BoxLite разрешает один рантайм на папку.
  Отсюда ограничение: **одновременно может идти только один прогон.** `launch.sh` проверяет все папки в `runs/` и откажется стартовать, пока у какой-то из них жив записанный процесс. Чужой прогон он не останавливает.
- **Тяжёлые команды** (сборка, сервер, Playwright, VM) запускаются через `nice -n 15` и строго по одной.
  Перед ними `vac_wait_cool` проверяет нагрузку и память. Если load1 ≥ 10, CPU ≥ 93°C, свободной памяти (`MemAvailable`) меньше `VERIFY_MIN_FREE_MB` (3072) или свободная память вместе со свободным swap меньше `VERIFY_MIN_HEADROOM_MB` (6144), он ждёт 60 с, не больше 10 раз. Процент swap отдельно не считается: ядро выносит в zram простаивающие страницы.
- **Память и сессия агента.** На машине работает systemd-oomd: когда память и swap заняты больше чем на 90%, он убивает cgroup с самым большим swap. Всё, что агент запускает из Bash, по умолчанию живёт в scope приложения Claude, и oomd может убить этот scope вместе с сессией агента (журнал: `journalctl -u systemd-oomd`). Поэтому цепочку запускайте в своём scope с потолком памяти, тогда при нехватке ядро и oomd бьют прогон, а не сессию:

  ```sh
  systemd-run --user --scope -q --unit=vac-run-$(date +%H%M%S) -p MemoryHigh=4G -p MemoryMax=5G -p MemorySwapMax=3G bash -c '<цепочка из Drive>'
  ```

  Сборку консоли `vite build` лучше делать один раз и передавать прогонам через `VERIFY_CONSOLE_DIR`, если исходники консоли не менялись.
- **Процессы останавливаются только по своим PID.** PID пишутся в `state/pids` вместе со временем старта: `server-tsx`, `server-node`, `fake-model`, `fake-mcp`, `journey`, `journey-child` (Chromium). По имени процессы не убиваются никогда.
- **Чужие контейнеры не трогать.** Это `backoffice-*`, `qm-backoffice-*`, `mvp-test-pg`, `bo-registry`, `oma-dev-pg`.
- **`.env` не читать.** Значения из `platform/.env` не нужны: секреты этого прогона генерируются в `state/secrets.env`. Наличие переменной проверяется только командой `grep -c '^ИМЯ=.' platform/.env`. Исключение составляет режим `real` (см. ниже), он требует согласия владельца.

## Launch

```sh
RUN="$($S/launch.sh)"     # stdout: одна строка, папка прогона; весь журнал идёт в stderr
```

Что делает (`scripts/launch.sh`):

1. Проверяет инструменты, Node 24 через fnm, наличие `/dev/kvm`, что порты свободны и не из чужого списка и что ни один прогон в `runs/` не жив.
2. Создаёт пустую папку прогона `runs/<RUN_ID>` (RUN_ID имеет вид `YYYYmmdd-HHMMSS`) и папку доказательств `.verify-evidence/<RUN_ID>/`. Записывает в `run.env` git HEAD и хэши изменений рабочего дерева консоли и сервера (`git diff HEAD` плюс неотслеживаемые файлы).
3. Собирает консоль командой `nice -n 15 vite build --outDir <прогон>/console`. Чтобы взять готовую сборку и пропустить этот шаг, задайте `VERIFY_CONSOLE_DIR=<папка с index.html>`.
4. В режиме `fake` запускает `fake-model.mjs` на 8792. В любом режиме запускает `fake-mcp.mjs` на 8793 (журнал `logs/fake-mcp.jsonl` прогона), его вызывает сценарий `mcp-ask`.
5. Запускает `main-node` (`nice -n 15 ./node_modules/.bin/tsx src/index.ts`, без watch) с чистым окружением. `DATABASE_URL` не задан, поэтому база SQLite. Все пути данных указывают в папку прогона. Дальше `SANDBOX_PROVIDER=litebox`, `SANDBOX_IMAGE=node:22-bookworm`, `DREAM_CURATOR_MODE=dedup`, в режиме `fake` ещё `ANTHROPIC_API_KEY=verify-local-fake-key` и `ANTHROPIC_BASE_URL=http://127.0.0.1:8792`.

**Готовность.** Это не «процесс отвечает», а все условия ниже. Каждая строка пишется в `logs/launch.txt` с пометкой OK или FAIL:

- `GET /health`: `status=ok`, `backends.db = "sqlite <прогон>/data/oma.db"`, `auth = "better-auth-sqlite"`, `memory_blobs` и `files_blobs` равны `localfs <прогон>/data/...`.
- `GET /auth-info` возвращает `email_password: true`.
- `GET /` отвечает 200 с `text/html`, и sha256 ответа совпадает с sha256 `index.html` этой сборки.
- Строк в `__drizzle_migrations` столько же, сколько записей в `migrations-sqlite/meta/_journal.json`. Сейчас это 28.
- В логе есть `"op":"main-node.listening"`, а строк с `"level":50` ноль.
- Родитель процесса с `/health.pid` это наш tsx, и порт 8791 слушает именно этот node.

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

- процессы прогона живы, и это те же PID (сверяется время старта); порт 8791 слушает наш node;
- `/health.pid` указывает на наш процесс, а база и blobs лежат в папке прогона; `GET /` отдаёт `index.html` нашей сборки;
- **Код не менялся после launch.** Git HEAD и хэши изменений консоли (`platform/apps/console`) и сервера (`platform/apps/main-node`, `platform/apps/agent`, `platform/packages`) равны значениям из `run.env`. Сервер идёт без watch, а консоль собрана один раз, поэтому после правок старый экземпляр крутит прежний код; при расхождении FAIL;
- `/auth-info` в порядке; cookie тестовой учётки принимается: `/v1/oma/me` и `/v1/agents` отвечают 200;
- фейковая модель и фейковый MCP-сервер отвечают (у прогонов без `FAKE_MCP_URL` в `run.env` второе не проверяется);
- `/dev/kvm` доступен, `BOXLITE_HOME/.lock` не держит чужой процесс, в логе нет ошибок уровня 50, нагрузка.

Если в выводе есть FAIL, этот экземпляр не вести: остановите его (`$S/cleanup.sh --run "$RUN"`) и запустите заново. При FAIL doctor пишет «ПРЕРВАН на шаге doctor» в `summary.md`, если сценарий его ещё не записал.

**Рабочую копию правят другие агенты.** Тогда doctor падает на сверке хэша. Запускайте прогон из снимка дерева: `git clone --shared` в `~/.cache/verify-agent-console/<имя>-snapshot`, поверх клона изменённые и новые файлы рабочей копии и папка скилла, затем `corepack pnpm install --frozen-lockfile --offline` (глобальный `pnpm` на машине сломан). Скрипты запускаются из снимка, доказательства пишутся в `.verify-evidence/` рабочей копии через `VERIFY_EVIDENCE_ROOT`. Сбои снимков описаны в `HISTORY.md`.

## Drive

Порядок полного прогона (cleanup запускается, только если launch создал прогон, и только для него):

```sh
RUN="$($S/launch.sh)" && { $S/doctor.sh --run "$RUN" && $S/seed-user.sh --run "$RUN" && $S/journey.sh --run "$RUN"; $S/cleanup.sh --run "$RUN"; }
```

Запускайте эту строку через `run_in_background: true` с перенаправлением в лог (см. «Таймауты инструмента Bash») и внутри `systemd-run --user --scope` с потолком памяти (см. «Память и сессия агента»).

1. **`seed-user.sh`** создаёт тестовую учётку запросом `POST /auth/sign-up/email` с заголовком `origin: http://127.0.0.1:8791`. Почта имеет вид `verify-<RUN_ID>@verify.test`, пароль случайный, хук Better Auth сам создаёт рабочее пространство `tn_…`. Скрипт сверяет почту и `user.id` через `GET /auth/get-session`, а `user.id`, tenant и роль owner через `/v1/oma/me`. Почта, пароль, `user_id` и `tenant_id` сохраняются в `state/test-user.json` (права 600, пароль не печатается), cookie в `state/cookies.txt`.
2. **`journey.sh`** записывает свой PID (роль `journey`), проверяет нагрузку и запускает `nice -n 15 node journey-env-to-agent.mjs`. Сценарий пишет PID Chromium (роль `journey-child`). Рецепт каждого шага с зацепками, ожидаемым результатом и ловушками лежит в `features/` (начните с `features/README.md`). Шаги и их проверки:
   - **Вход** (`auth.*`). На `/login` нажать «Продолжить с почтой», заполнить `#auth-email` и `#auth-password`, затем в группе «Действия входа» нажать «Войти». Дождаться навигации и h1 в `main`. Проверяются cookie `better-auth.session_token`, почта и `user.id` в `GET /auth/get-session`, тот же `user.id` и tenant в `/v1/oma/me`.
     `/v1/oma/me` отдаёт почту через `loadUser` в `buildMeRoutes` (`apps/main-node/src/modules/node-http.ts`, маршрут `/oma/me`); строка `auth.me_email`. Источник истины для почты: Better Auth.
   - **Окружение** (`env.list_empty`, `env.created`, `env.detail_ui`, `env.sandbox_catalog`; `features/environments.md`). Перед скриншотом списка сценарий ждёт h1 «Окружения» в `main` и пустое состояние «Окружений пока нет» или строку таблицы, а не смену URL. `env.sandbox_catalog` требует, чтобы каждый запрос консоли к `GET /v1/oma/sandbox-catalog` на списке и карточке отвечал 200 (`api/10-sandbox-catalog.json`): консоль запрашивает каталог молча, и 404 на странице не видно.
   - **Проба окружения, обходной путь** (`env.probe.*`, `env.probe_path`). Действия «проверить окружение» нет ни в консоли, ни в API, а песочница создаётся лениво. Поэтому по API создаются технический агент (только bash) и сессия на новом окружении, и отправляется одна команда. Проба доказывает, что VM поднялась и выполнила команду (`VERIFY_OK_<nonce>`, ядро VM отличается от ядра хоста), что пакета `jq` в образе нет (`env.probe.baseline`), что сессия пробы видна в консоли с репликой и ответом после повторного открытия страницы (`env.probe.ui_visible`) и что сеть «Без ограничений» работает (`env.probe.network`). Затем сессия архивируется, и проверяется, что VM остановилась.
   - **Настройки окружения** (`env.settings_saved`, `env.packages_applied`, `env.networking_limited_applied`, `env.networking_allowed_host`). На карточке «Ограниченный» доступ, сеть для менеджеров пакетов, хост `example.org` и пакет `apt` `jq`. Новая сессия на этом окружении проверяет в VM `jq`, код 000 для `https://example.com` и 200 для `https://example.org`. Главная сессия идёт на том же настроенном окружении. Шаги настроек не обязательные: их сбой пишется провалом, а сценарий идёт к агенту. В конце технический агент пробы архивируется, чтобы шаг агентов шёл по пустому списку.
   - **Агент** (`agent.*`; `features/agents.md`). Модель `claude-sonnet-4-6` по ключу сервера и усилие «Низкое» задаются в режиме «Форма» без YAML, поля «Harness» в форме нет. YAML той же формы проверяется туда и обратно, агент создаётся из режима «Форма».
   - **Сессия** (`session.created`, `session.header_ui`, `session.title_saved`, `session.initial_status`; `features/sessions-and-agent-run.md`). Новая сессия без сообщения должна быть `idle`: в шапке «Ожидает», текста «Агент работает…» нет.
   - **Ход агента** (`run.*`, `session.ui_*`; `features/sessions-and-agent-run.md`). Сценарий слушает тот же поток `GET /v1/sessions/:id/events/stream`, что и консоль, и отправляет промпт с маркером. В новой сессии кнопка подписана «Отправить сообщение» (`run.ui_send_label`). В интерфейсе проверяются реплика в ходе, ответ целиком и длительность хода, страница сессии как в консоли Claude (без токенов, стоимости и бюджета, инспектор, «События», «Инструменты», мини-карта, поиск, 390 px) и файл на вкладке «Ресурсы»: «Скачать» отдаёт его с `VERIFY_OK_<nonce>` (`run.ui_files`).
     Через API и файлы проверяется:
     - порядок событий `user.message → agent.tool_use(bash) → agent.tool_result → agent.message → session.status_idle(end_turn)`;
     - `GET /v1/sessions/:id/outputs` и файл `<прогон>/data/session-outputs/<tenant>/<session>/verify-<nonce>.txt` с содержимым `VERIFY_OK_<nonce>`, записанный внутри VM в `/mnt/session/outputs`;
     - ядро VM отличается от ядра хоста, BoxLite записал третий старт VM, процесс VM это потомок нашего сервера;
     - вывод bash без служебных строк рантайма (`tool_output_clean`): ведущую строку stderr `libcontainer … seccomp not available` срезает адаптер (`stripRuntimeNoise`);
     - решения фейковой модели и `run.fake_model_effort`: у каждого запроса хода `thinking: "adaptive"` и `effort: "low"`, у запросов технического агента пробы `effort: null`.

     В конце сессия архивируется, и проверяется остановка VM.
   - **Итог.** Для каждой подфункции из разделов `Sub-features` в `features/*.md`, которую сценарий не прошёл, в `summary.md` автоматически пишется строка «не проверено» `feature.<id>`. Скриншоты соседних шагов сравниваются по sha256 (`evidence.screens_distinct`).

Чтобы оставить сессии живыми для ручного осмотра, задайте `VERIFY_KEEP_SESSION=1`. Чтобы видеть браузер, задайте `VERIFY_HEADED=1`.
Таймауты ходов: `VERIFY_FIRST_TURN_TIMEOUT_MS` (по умолчанию 900000) и `VERIFY_TURN_TIMEOUT_MS` (по умолчанию 600000). Первый ход с новым `BOXLITE_HOME` скачивает образ `node:22-bookworm` и собирает его диск, поэтому идёт дольше.

## Сценарий builder: ассистент платформы

Сценарий `builder` (`scripts/journey-builder.mjs`, негативные шаги в `scripts/journey-builder-guard.mjs`, решения фейка в `scripts/fake-model-builder.mjs`) проверяет ассистента по разделу 6 `docs/plans/builder-agent.md`. Рецепт и ловушки в `features/builder-agent.md`.

```sh
RUN="$($S/launch.sh)" && { $S/doctor.sh --run "$RUN" && $S/seed-user.sh --run "$RUN" --others && $S/journey.sh --run "$RUN" --scenario builder; $S/cleanup.sh --run "$RUN"; }
```

- `seed-user.sh --others` заводит участника пространства тестовой учётки (роль `member`, приглашение и его принятие) и второго пользователя со своим пространством. Файлы `state/member.json`, `state/foreign.json` и их cookie-jar.
- Канарейки, карточка `vb-fake-<n>`, маркеры фейка и `VERIFY_BUILDER_ONLY` описаны в `features/builder-agent.md`.
- Инструменты модели сверяются с таблицей `PLATFORM_TOOL_GROUPS` в `scripts/journey-builder.mjs` (копия `platform-mcp/tool-table.ts` по группам комплекта ассистента): `vb.fake_tools` и `vb.danger_class`. Новый инструмент платформы вписывайте туда, правило в Gotchas `features/builder-agent.md`.
- Шаги: 6.2 (установка по Ctrl I, пачка «окружение, навык, агент», деплоймент на паузе, правка агента, сессия, первое сообщение и ответ сессии, журнал, «Изменения», нижний лист на 390 px), 6.3 (отклонить, прямое подтверждение, `always_allow`, встроенные инструменты и хранилище памяти, выключатель), 6.4 (чужое пространство, второй участник, прямой вход), 6.5 (указания в файле и навыке), 6.6 (агент, путь памяти и сессия поменялись после preview; деплоймент сняли с паузы, затем отправили в архив), 6.7 (канарейки, ротация, подбор секрета). Через 2 минуты после 6.2 сценарий проверяет, что деплоймент на паузе не запускался.
- **Живая модель (6.8).** `VERIFY_BUILDER_MODE=live` на том же экземпляре (сервер в режиме fake, модель задаёт карточка): карточка `VERIFY_LIVE_CARD` (по умолчанию `qwen3.6-35b`), провайдер `VERIFY_LIVE_PROVIDER` (`openai-compatible`), адрес `VERIFY_LIVE_BASE_URL`, модель шлюза `VERIFY_LIVE_WIRE_MODEL`. Ключ из файла `VERIFY_LIVE_SECRET_FILE` (права 600, не из `~/.claude`) или, с согласия владельца, из одной переменной `platform/.env`, имя в `VERIFY_LIVE_ENV_KEY`. Значение не печатается. Сценарий шлёт в панель `VERIFY_LIVE_PROMPT` (по умолчанию просьба владельца про агента со сводкой заявок в xlsx, окружение для документов и сессию с заданием), подтверждает карточки, на вопросы отвечает до трёх раз и пишет `live.*`: агент, окружение, сессия, первое сообщение отдельной карточкой, ответ сессии, ошибки схемы (не больше 2), замеры. `seed-user.sh` без `--others`. На Qwen этот режим не проверялся.

## Сценарий crud: правка, архив и удаление

Сценарий `crud` (`scripts/journey-crud.mjs`, решения фейка `VERIFY_BUILDER_CRUD` и `VERIFY_BUILDER_CRUDDENY` в `scripts/fake-model-builder.mjs`) проверяет запрос владельца «каждая сущность должна иметь возможность обновляться, удаляться» по `docs/plans/crud.md`. Рецепт и ловушки в `features/crud.md`.

```sh
RUN="$(VERIFY_PORT=8797 VERIFY_FAKE_PORT=8798 $S/launch.sh)" && { $S/doctor.sh --run "$RUN" && $S/seed-user.sh --run "$RUN" && $S/journey.sh --run "$RUN" --scenario crud; $S/cleanup.sh --run "$RUN"; }
```

- Порты 8797 и 8798, чтобы не мешать главному сценарию и пробной консоли. Правило «один прогон за раз» общее.
- Исходные объекты (карточка модели на фейк, агент, два окружения, две сессии без сообщений, два файла) создаются по API: их создание через консоль проверяют сценарии `env-to-agent` и `builder`. Это строка «не проверено» `crud.seed_path`. Всё остальное идёт через консоль.
- Проверки по подфункциям `features/crud.md`:
  - `crud-agent-archive` и `crud-env-archive`: `crud.agent_archive`, `crud.agent_unarchive`, `crud.env_archive`, `crud.env_unarchive`;
  - `crud-env-delete`: `crud.env_delete_blocked` (список «Мешает», 409 `dependency_conflict_error`), `crud.session_archive_ui`, `crud.env_delete_after_stop`, `crud.session_delete_after_env_delete`;
  - `crud-deployments`: `crud.deployment_*`; `crud-files`: `crud.file_upload`, `crud.file_delete`;
  - `crud-assistant-danger` и `crud-assistant-deny`: `crud.assistant_*`.

## Сценарий mcp-ask: подтверждение MCP

Сценарий `mcp-ask` (`scripts/journey-mcp-ask.mjs`, сервер `scripts/fake-mcp.mjs`, маркер фейка `VERIFY_TOOL` в `scripts/fake-model.mjs`) проверяет функцию 3.1 `docs/plans/cma-wave-1.md`: инструмент MCP-сервера без явной политики ждёт «Разрешить» на странице сессии. Рецепт и ловушки в `features/mcp-confirmation.md`.

```sh
RUN="$($S/launch.sh)" && { $S/doctor.sh --run "$RUN" && $S/seed-user.sh --run "$RUN" && $S/journey.sh --run "$RUN" --scenario mcp-ask; $S/cleanup.sh --run "$RUN"; }
```

- Окружение «Без ограничений» и хранилище с токеном `verify-mcp-<n>` для `http://127.0.0.1:8793/mcp` создаются по API (строка «не проверено» `mcp.seed_path`). Агент со своим MCP-сервером, сессия с хранилищем, реплики и кнопки идут через консоль.
- Проверки: `mcp.agent_created`, `mcp.session_created`, `mcp.tools_listed`, `mcp.vault_token`, `mcp.write_waits`, `mcp.session_requires_action`, `mcp.allow_once`, `mcp.repeat_allow_none`, `mcp.deny_none`, `mcp.exception_form`, `mcp.exception_read`, `mcp.old_agent_marked`, `mcp.old_agent_kept`, `mcp.ui_waiting_row`, `mcp.ui_waiting_row_reload`, `mcp.ui_rows_after_reload`. Провал `mcp.write_waits` значит, что `write_act` ушёл без человека. Шаги «Разрешить» и «Отклонить» тогда пишутся строками «не проверено», второй вызов не делается, и в `logs/fake-mcp.jsonl` остаётся один `write_act`.
- `mcp.repeat_allow_none` шлёт второе `allow` на исполненный `write_act` по API: кнопки в консоли после первого клика нет. Проверка ждёт, что вызов не ушёл снова и модель не проснулась (нет `agent.message`, `span.model_request_start` и нового запроса к фейку). Старый агент для `mcp.old_agent_*` создаётся по API с набором MCP на явном `always_allow`, как его писала консоль до функции 3.1.
- `mcp.ui_waiting_row` и `mcp.ui_waiting_row_reload` требуют подпись «Ждёт вас» у строки ожидающего вызова в ходе: сразу после хода и после свежей загрузки страницы. Подпись «Прервано» это провал. `mcp.ui_rows_after_reload` после «Разрешить» и «Отклонить» и свежей загрузки требует строку исполненного вызова без подписи и строку отклонённого с подписью «Отклонено». До правки консоли 2026-10-18 первая проверка писала «внимание», причины в Gotchas `features/mcp-confirmation.md`.

## Сценарий multiagent: поток субагента, предел сессии, блок multiagent_20261001

Сценарий `multiagent` (`scripts/journey-multiagent.mjs`, маркер фейка `VERIFY_DELEGATE` в `scripts/fake-model.mjs`) проверяет шаг 1, раздел 3.Б и шаг 2 `docs/plans/multiagent.md`. План называл доказательство шага 1 `journey-subagent-confirm.mjs`, это тот же сценарий. Рецепт и ловушки в `features/multiagent.md`.

```sh
RUN="$(VERIFY_PORT=8801 VERIFY_FAKE_PORT=8802 VERIFY_FAKE_MCP_PORT=8803 $S/launch.sh)" && { $S/doctor.sh --run "$RUN" && $S/seed-user.sh --run "$RUN" && $S/journey.sh --run "$RUN" --scenario multiagent; $S/cleanup.sh --run "$RUN"; }
```

- Окружение, субагент с bash на `always_ask`, основной агент с блоком `coordinator` и агент для предела создаются по API (`ma.seed_path`). Сессия с делегированием и её реплика идут через консоль. Сессия с `max_tokens: 1` создаётся по API (`ma.limit_seed_path`), реплика, заметка и «Поднять предел» идут через консоль.
- Шаг 1: `ma.subagent_waits`, `ma.subagent_wrong_thread`, `ma.ui_subagent_confirm`, `ma.subagent_allow_once`, `ma.subagent_report`, `ma.subagent_repeat_allow_none`. Раздел 3.Б: `ma.limits_count`, `ma.limits_grow`, `ma.limit_stop`, `ma.limit_refuses_message`, `ma.limit_ui_note`, `ma.limit_ui_send_refused`, `ma.limit_raise`. Шаг 2: `ma.block_invalid`, `ma.block_api`, `ma.block_form`, `ma.block_session_copy`, `ma.block_delegation`.
- Журнал основного потока сессий с делегированием сценарий читает из `managed_session_events` базы прогона (`sqlite3 -readonly`). Так повелось, пока `GET /v1/sessions/:id/events` на них отвечал 500 (находка 5 ревью, исправлена 2026-10-18). Теперь маршрут отвечает 200, а `ma.ui_subagent_confirm` жмёт «Разрешить» в потоке субагента.

## Evidence

Всё лежит в `.verify-evidence/<RUN_ID>/`. Строка `.verify-evidence/` есть в корневом `.gitignore` (закоммичена в `b62dd98`), cleanup эту папку не удаляет.

- `summary.md` содержит итог «ПРОЙДЕН / ПРОВАЛ / ПРЕРВАН» (при сбое до сценария «ПРЕРВАН на шаге launch / doctor / seed-user / journey» с причиной), id и пути, затем таблицу проверок со статусами «проверено», «провал», «внимание», «не проверено» и список скриншотов с sha256.
- `screens/NN-<шаг>.png` хранит скриншот действия и скриншот результата на каждый шаг. Ширина 1280; оболочка консоли прокручивает `main`, а не документ, поэтому на время снимка окно растягивается на высоту внутренней прокрутки (до 6000 px), и видна вся карточка. Скриншоты `fail-<проверка>.png`, `fail-step-<шаг>.png` и `NN-abort.png` снимаются в момент сбоя и в сравнении sha256 не участвуют.
- `aria/NN-<шаг>.yml` хранит ARIA-снимки карточек окружения и агента, сохранённых настроек и завершённого хода.
- `api/` хранит ответы `/health`, `/auth-info`, `/v1/oma/me`, `/auth/get-session` (без токена), окружение до и после настроек, агента, сессии, архивы и полные журналы событий сессий: проба (`21-…`, сеть `21b-…`), проба настроек (`22-…`, `22b-…`), главная сессия (`41-…`). Ещё там поток событий главной сессии `41-session-stream.json`, текст вывода bash `45-tool-card-text.txt`, текст ответа хода `46-turn-answer-text.txt`, журнал для проверок страницы `47-session-page-events.json`, outputs, YAML агента, копия файла из VM, каталог моделей формы `29-model-options.json` и `fake-model-requests.jsonl` (у каждого запроса `thinking` и `effort`).
- `logs/` хранит `launch.txt`, `console-build.log`, `doctor-<время>.txt`, `main-node.journey.log` (снимок после сценария), `main-node.final.log` (после остановки), `fake-model.log`, `cleanup.txt`, `fake-mcp.log` и `fake-mcp.jsonl` (журнал фейкового MCP-сервера, сценарий `mcp-ask`), после cleanup ещё `fake-mcp.final.*`.

Стандарты доказательства (общие правила в `features/README.md`, раздел «Proof and skip reporting»):

- **Пользовательский путь.** Окружение, его настройки, агент, сессия и сообщение создаются через консоль. API используется для двух вещей: для сверки, и для проб окружения, потому что в продукте для них нет пути. В `summary.md` проба помечена как обходной путь (`env.probe_path`).
- **Побочные эффекты.** Записи в БД видны через API, файл из VM лежит на хосте, BoxLite записал старт и остановку VM, процесс VM (`libkrun VM`, pid из лога BoxLite) это потомок нашего server-node. В логе сервера есть строка `creating box (image=…, network=…)` от `litebox-sandbox` (`*.server_log_box`): логгер берётся в момент записи (`moduleLogger` в `litebox.ts`), а не при импорте.
- **Где мок.** Мок только один, это модель. Это внешний провайдер, и сервер ходит к нему через `ANTHROPIC_BASE_URL`, как в тестах репозитория (`apps/main-node/test/_helpers/openai-node-process.ts`). Песочница настоящая: LiteBox с микро-VM через `/dev/kvm`. Сетевая проба ходит на настоящий `https://example.com` (и с хоста для базы).
- **Пробелы фейка.** Фейк не проверяет доступ к api.anthropic.com, работу ключа и качество ответа. Это строка «не проверено» в `summary.md`. Проверить можно только в режиме `real`.

## Cleanup

```sh
$S/cleanup.sh --run "$RUN"               # или --keep-state, чтобы оставить папку прогона для разбора
```

Без `--run` (или `VERIFY_RUN_DIR`) скрипт ничего не делает. Что делает:

1. Останавливает сценарий и Chromium, если они ещё живы (роли `journey`, `journey-child` и потомки `journey`). Пока сервер жив, архивирует сессии из `state/created.json`, чтобы VM остановились штатно.
2. Записывает потомков сервера (PID и время старта), шлёт SIGTERM tsx (сигнал передаётся node), затем node, фейковой модели и фейковому MCP-серверу. Ждёт 30, 10, 5 и 5 с соответственно, после чего шлёт SIGKILL только этим PID. Потом останавливает записанных потомков, которые пережили сервер.
3. Копирует финальные логи в доказательства (с ними `fake-mcp.final.log` и `fake-mcp.final.jsonl`) и проверяет, что порты 8791, 8792 и 8793 свободны. О процессах, у которых в командной строке есть путь `BOXLITE_HOME`, сообщает, но не убивает их.
4. Удаляет `runs/<RUN_ID>` только если всё освобождено. Если `summary.md` нет (сбой до сценария), пишет «ПРЕРВАН» с причиной; печатает число файлов в папке доказательств.

Доказательства и кэш BoxLite не удаляются. После cleanup проверьте, что `.verify-evidence/<RUN_ID>/summary.md` на месте.
Запускайте cleanup и после неудачного прогона (с тем же `--run`), чтобы не оставлять процессы и порты.

## Helpers

| Скрипт | Вызов | Что делает |
|---|---|---|
| `scripts/lib.sh` | `$S/lib.sh` | Общие функции. При прямом запуске печатает порты, папки и живые прогоны |
| `scripts/launch.sh` | `RUN="$($S/launch.sh)"` | Сборка консоли, фейковая модель, сервер, проверка готовности; stdout: папка прогона |
| `scripts/doctor.sh` | `$S/doctor.sh --run "$RUN"` | Можно ли вести экземпляр, включая сверку кода с моментом launch |
| `scripts/seed-user.sh` | `$S/seed-user.sh --run "$RUN" [--others]` | Тестовая учётка и её рабочее пространство; с `--others` участник этого пространства и второй пользователь со своим |
| `scripts/journey.sh` | `$S/journey.sh --run "$RUN" [--scenario builder\|crud\|mcp-ask\|multiagent]` | PID сценария, проверка нагрузки, Node 24, `nice` и запуск сценария (по умолчанию главного) |
| `scripts/journey-builder.mjs` | через `journey.sh --scenario builder` | Сценарий ассистента: шаги 6.2, 6.3, 6.4 и 6.7 плана, живой режим 6.8, `summary.md` |
| `scripts/journey-crud.mjs` | через `journey.sh --scenario crud` | Сценарий «правка, архив и удаление»: списки агентов, окружений, сессий и файлов, страница деплойментов, красные карточки помощника, `summary.md` |
| `scripts/journey-mcp-ask.mjs` | через `journey.sh --scenario mcp-ask` | Сценарий «подтверждение MCP»: агент со своим MCP-сервером из формы, сессия с хранилищем, вызов `write_act` ждёт «Разрешить», «Разрешить» и «Отклонить» на странице сессии, журнал fake-mcp, `summary.md` |
| `scripts/journey-multiagent.mjs` | через `journey.sh --scenario multiagent` | Сценарий «мультиагент»: делегирование с подтверждением в потоке субагента, страница такой сессии, повтор подтверждения, счётчики и предел сессии с заметкой и «Поднять предел», блок `multiagent_20261001` по API, в форме и в ходе, `summary.md` |
| `scripts/journey-builder-guard.mjs` | модуль `journey-builder.mjs` | Шаги 6.5 и 6.6: подложенные указания и смена объекта после preview |
| `scripts/fake-model-builder.mjs` | модуль `fake-model.mjs` | Решения фейка по маркерам `VERIFY_BUILDER*`, поиск канареек в сыром теле |
| `scripts/journey-env-to-agent.mjs` | через `journey.sh` | Главный сценарий Playwright, проверки и `summary.md` |
| `scripts/fake-model.mjs` | запускает `launch.sh` (`node fake-model.mjs --port 8792 --log f.jsonl`) | Модель Anthropic Messages (SSE): bash с командой из промпта, затем `VERIFY_DONE_<nonce>` (в ходе агента `VERIFY_AGENT_RUN` перед bash ещё текст, а ответ состоит из блока кода с `VERIFY_DONE_<nonce>` и строки после него); запрос без потока получает `ok`; отвечает на проверку ключа карточки OpenAI (`/chat/completions`); пишет в журнал `thinking`, `effort` и начало последнего сообщения пользователя (`last_user_text`) каждого запроса; маркер `VERIFY_TOOL` вызывает инструмент из строки `Инструмент:` с входом из строки `Вход:` (сценарий `mcp-ask`); маркер `VERIFY_DELEGATE` вызывает `call_agent_<id>` из строки `Агент:` с командой из строки `Команда субагента:` и отвечает по результату и по отчёту субагента (сценарий `multiagent`) |
| `scripts/fake-mcp.mjs` | запускает `launch.sh` (`node fake-mcp.mjs --port 8793 --log fake-mcp.jsonl`) | MCP-сервер Streamable HTTP без сессии на `/mcp`, ответы JSON: инструменты `read_report` и `write_act`, 401 без Bearer, -32601 на `server/discover`; журнал JSONL с sha256 токена, методом, инструментом и аргументами каждого сообщения |
| `scripts/cleanup.sh` | `$S/cleanup.sh --run "$RUN" [--keep-state]` | Остановка по своим PID и уборка временных данных одного прогона |

Переопределяемые переменные:

- `VERIFY_PORT`, `VERIFY_FAKE_PORT`, `VERIFY_FAKE_MCP_PORT`;
- `VERIFY_STATE_ROOT`, `VERIFY_BOXLITE_HOME`, `VERIFY_EVIDENCE_ROOT`;
- `VERIFY_MODEL_MODE`, `VERIFY_AGENT_MODEL`, `VERIFY_SANDBOX_IMAGE`, `VERIFY_LITEBOX_DISK_SIZE_GB`, `VERIFY_LITEBOX_MEMORY_MIB`;
- `VERIFY_CONSOLE_DIR`, `VERIFY_RUN_DIR`, `VERIFY_RUN_ID`, `VERIFY_START_TIMEOUT_S`;
- память перед тяжёлой командой (`vac_wait_cool`): `VERIFY_MIN_FREE_MB` (3072), `VERIFY_MIN_HEADROOM_MB` (6144);
- сценарий: `VERIFY_KEEP_SESSION`, `VERIFY_HEADED`, `VERIFY_CHROMIUM`, `VERIFY_FIRST_TURN_TIMEOUT_MS`, `VERIFY_TURN_TIMEOUT_MS`;
- сценарий `builder`: `VERIFY_BUILDER_ONLY`, `VERIFY_BUILDER_MODE` (`live`), `VERIFY_LIVE_CARD`, `VERIFY_LIVE_PROVIDER`, `VERIFY_LIVE_BASE_URL`, `VERIFY_LIVE_WIRE_MODEL`, `VERIFY_LIVE_SECRET_FILE`, `VERIFY_LIVE_ENV_KEY`, `VERIFY_LIVE_PROMPT`, `VERIFY_LIVE_TIMEOUT_MS`, `VERIFY_LIVE_CHILD_TIMEOUT_MS`.

Значения `VERIFY_*` можно передавать в окружении `launch.sh` (`VERIFY_PORT=8795 $S/launch.sh`).
