---
name: verify-agent-console
description: Проверка конструктора агентов (копия OpenMA, platform/apps/main-node + консоль platform/apps/console на русском, стиль DDC) через интерфейс консоли в Playwright. Поднимает изолированный экземпляр на SQLite с пустой папкой данных (порт 8791), заводит тестовую учётку и проходит путь «окружение → проверка песочницы LiteBox → настройки окружения (пакет, сеть) в VM → агент → сессия → ход агента с bash в VM → ответ», сверяя побочные эффекты через API, поток событий и файлы. Брать, когда нужно доказать, что окружения, агенты, сессии или ход агента работают после правок, или когда просят «проверить консоль / environment / агента».
---

# verify-agent-console

Скилл поднимает свой экземпляр сервера и консоли и проходит главный сценарий так, как это делает пользователь.
Всё, что пользователь видит, проверяется в браузере. Побочные эффекты (записи в БД, файлы, VM, поток событий) проверяются через API и файловую систему.

Папка скилла: `.claude/skills/verify-agent-console/`, дальше `S=.claude/skills/verify-agent-console/scripts`.
Команды запускаются из корня репозитория `/home/vnkjd/orca/projects/ai-native-backoffice-v3`.

**Статус.** Последний полный прогон 2026-10-16 `20261016-082706`: «ПРОЙДЕН», 90 проверок, 0 провалов. Node 24.21.0, Playwright 1.59.1 с Chromium 1243, fake-модель, LiteBox на `/dev/kvm`, git `8c1a64d` с незакоммиченными правками рабочей копии на 07:40 (хэши изменений: консоль `7b84408f28c237ea`, сервер `b6f30487b05fe73d`). Консоль собрана один раз в прогоне `20261016-074730` и передана прогонам через `VERIFY_CONSOLE_DIR`. Цепочка шла в своём scope с потолком памяти (см. «Память и сессия агента») и от launch до конца cleanup заняла 67 с. Прогон `20261016-081718` на том же снимке тоже прошёл, 60 с из его 132 с ушли на паузу `vac_wait_cool` (CPU 94°C).
Прогон шёл из снимка дерева, а не из рабочей копии: пока он идёт, другие агенты правят консоль и сервер, и doctor падает на сверке хэша (`20261016-034810` остановлен по этой причине). Снимок это `git clone --shared` в `~/.cache/verify-agent-console/models-harness-snapshot` (раньше `no-cost-snapshot`, `session-snapshot` и `w4-snapshot`). Поверх клона лежат изменённые и новые файлы рабочей копии на 07:40 и папка скилла. Правки волн страницы сессии, трейса и окружений после 07:40 в прогон не попали. Код формы агента, страницы «Harness», guard, прокси модели и карточек harness в снимке тот же, что в рабочей копии на 08:20. Затем идёт `corepack pnpm install --frozen-lockfile --offline` (глобальный `pnpm` на машине сломан). До `8c1a64d` `src/data/` закрывала строка `data/` в `.gitignore`, clone его не переносил, и сборка консоли падала на `../data/mcp-registry` (прогон `20261016-055926`, «ПРЕРВАН на шаге launch»). Теперь папка в git. `sandbox-hosted-inference.ts` не закоммичен, хотя `apps/main-node/src/config.ts` импортирует его с `ae270e4`. Без этого файла сервер из чистого клона падает при старте с `ERR_MODULE_NOT_FOUND` (прогон `20261016-065026`, «ПРЕРВАН на шаге launch»). Скрипты запускаются из снимка, доказательства пишутся в эту папку (`VERIFY_EVIDENCE_ROOT`).
Ожидаемый итог на текущем коде: «ПРОЙДЕН», 90 проверок, 0 провалов, строк «внимание» нет. С волной «модели и harness» (2026-10-16) агент создаётся в режиме «Форма» без YAML: модель по ключу сервера и усилие «Низкое» (`agent.form_model_effort`), YAML той же формы туда и обратно (`agent.yaml_roundtrip`), `agent.created` сверяет `model.effort`, `agent.detail_ui` ищет «Усилие: низкое», `run.fake_model_effort` сверяет журнал фейка. Строка «внимание» `agent.form_without_model_cards` ушла вместе с YAML-обходом. С 2026-10-16 добавлены `run.answer_full` и `run.turn_duration` (без правки консоли по срезу ответа и «Работал 0 с» падают они и `run.ui_turn_done`) и `env.networking_allowed_host`. Тогда же страница сессии переделана как в консоли Claude, и сценарий получил её проверки: `session.ui_no_usage`, `session.ui_inspector`, `session.ui_select_sync`, `session.ui_events`, `session.ui_tools`, `session.ui_minimap`, `session.ui_search`, `session.ui_mobile_390`, `run.ui_tool_duration`; `run.ui_tool_card`, `run.ui_tool_output_text`, `run.ui_files` и `session.header_ui` переведены на новую страницу, `run.ui_timeline` («Хронология») убран вместе с вкладкой. `session.ui_no_usage` заменила `session.ui_header_tokens`, которая сверяла чип токенов в шапке с журналом. Владелец отменил токены, стоимость и бюджет, потому что модели внутренние. На консоли без этой правки (`b03c0d9`) проверка падает и перечисляет всё найденное: чипы `tokens` и `cost`, «нет цены», токены и бюджет в подсказках чипов, пункт «Изменить бюджет» в меню, «Стоимость», токены и кнопку бюджета на вкладке «Сессия» (прогон `20261016-065601`).

`session.initial_status` и `run.ui_send_label` это настоящие проверки: новая сессия без сообщения должна быть `idle` («Ожидает», без «Агент работает…», кнопка «Отправить сообщение»). Их провал значит, что вернулся дефект 2026-10-16, когда новая сессия создавалась со `status: "running"` и консоль бесконечно показывала «Агент работает…».

Подфункций карты пройдено 26 из 47 (с 2026-10-16 добавлены `agent-model`, `agent-effort`, `session-answer` и подфункции страницы сессии `session-no-usage`, `session-inspector`, `session-inspector-events`, `session-inspector-tools`, `session-select-sync`, `session-minimap`, `session-search`, `session-mobile`; `session-timeline` убрана), остальные 21 идут строками «не проверено» `feature.*`.
История: 2026-10-15 (`20261015-193100`) было 7 провалов (сеть VM, пакеты окружения, название сессии, реплика в ходе, вывод bash); 2026-10-16 первый прогон после правок (`20261016-001648`) дал 12 провалов из-за ошибки DNS allowlist BoxLite 0.9.0, см. Gotchas в `features/environments.md`; `20261016-021532` дал 13 провалов `run.*` из-за разового сбоя BoxLite `spawn_failed … InitReady` в VM главной сессии (повтор прошёл, см. Gotchas в `features/sessions-and-agent-run.md`); `20261016-040821` дал 1 провал `env.probe.network` из-за того же сбоя на сетевом ходе пробы, повтор `20261016-041400` на том же дереве прошёл. Первый прогон с проверками страницы сессии (`20261016-060057`) дал 2 провала: `session.ui_events` (строка `user.message` во «Событиях» несла id `local-user-…` вместо id журнала, дефект консоли, исправлен, см. Gotchas в `features/sessions-and-agent-run.md`) и `evidence.screens_distinct` (снимок `turn-answer-full` совпадал с `turn-done`: раскрывать стало нечего, исправлено в сценарии). Красные прогоны `session.ui_no_usage` на консоли `b03c0d9` без правки: `20261016-065145` дал 1 провал, но подсказку чипа токенов не нашёл, потому что прочитал подсказку чипа длительности, которая ещё стояла в DOM; меню на снимке вышло полупрозрачным. Оба места исправлены в сценарии (Gotchas в `features/sessions-and-agent-run.md`), и `20261016-065601` дал тот же 1 провал со всеми находками. Прогоны волны «модели и harness»: `20261016-074035` прерван на шаге агента (strict mode violation: «Модель» без `exact` находила и «Вспомогательную модель», исправлено в сценарии); `20261016-074730` оборвался на launch, когда systemd-oomd убил scope Claude вместе с прогоном (см. «Память и сессия агента»); `20261016-080856` дал 1 провал `agent.created`: API отдаёт усилие объектом `{type: "low"}`, а сценарий ждал строку (исправлено в сценарии, Gotchas в `features/agents.md`).
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
  Перед ними `vac_wait_cool` проверяет нагрузку и память. Если load1 ≥ 10, CPU ≥ 93°C, свободной памяти (`MemAvailable`) меньше `VERIFY_MIN_FREE_MB` (3072) или свободная память вместе со свободным swap меньше `VERIFY_MIN_HEADROOM_MB` (6144), он ждёт 60 с, не больше 10 раз. Процент swap отдельно не считается: ядро выносит в zram простаивающие страницы и при 7 ГБ свободной памяти, 2026-10-16 swap держался от 60 до 80%.
- **Память и сессия агента.** На машине работает systemd-oomd: когда память и swap заняты больше чем на 90%, он убивает cgroup с самым большим swap. Всё, что агент запускает из Bash, по умолчанию живёт в scope приложения Claude. 2026-10-16 в 07:55 oomd убил этот scope целиком: сессия агента оборвалась вместе с прогоном `20261016-074730` (журнал: `journalctl -u systemd-oomd`). Поэтому цепочку запускайте в своём scope с потолком памяти, тогда при нехватке ядро и oomd бьют прогон, а не сессию:

  ```sh
  systemd-run --user --scope -q --unit=vac-run-$(date +%H%M%S) -p MemoryHigh=4G -p MemoryMax=5G -p MemorySwapMax=3G bash -c '<цепочка из Drive>'
  ```

  Прогоны 2026-10-16 с `VERIFY_CONSOLE_DIR` (без сборки консоли) держали в scope до 2 ГБ памяти и до 1 ГБ swap (замер раз в 30 с). Сборку консоли `vite build` лучше делать один раз и передавать прогонам через `VERIFY_CONSOLE_DIR`, если исходники консоли не менялись.
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
   - `SANDBOX_GATEWAY_BASE_URL=http://host.boxlite.internal:<VERIFY_PORT>`: адрес сервера для ACP-агентов в VM (прокси модели). `127.0.0.1` из VM ведёт в саму VM, а `host.boxlite.internal` gvproxy BoxLite пересылает на `127.0.0.1` хоста. Без неё сервер взял бы `PUBLIC_BASE_URL`;
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
- **Код не менялся после launch.** Git HEAD и хэши изменений консоли (`platform/apps/console`) и сервера (`platform/apps/main-node`, `platform/apps/agent`, `platform/packages`) равны значениям из `run.env`. `apps/agent` (харнессы) добавлен 2026-10-16: до этого правка `acp-translate.ts` после launch не ловилась. Сервер идёт без watch, а консоль собрана один раз, поэтому после правок старый экземпляр крутит прежний код; при расхождении FAIL;
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

Запускайте эту строку через `run_in_background: true` с перенаправлением в лог (см. «Таймауты инструмента Bash») и внутри `systemd-run --user --scope` с потолком памяти (см. «Память и сессия агента»).

1. **`seed-user.sh`** создаёт тестовую учётку запросом `POST /auth/sign-up/email` с заголовком `origin: http://127.0.0.1:8791`.
   - Почта имеет вид `verify-<RUN_ID>@verify.test`, пароль случайный.
   - Хук Better Auth сам создаёт рабочее пространство `tn_…`.
   - Скрипт сверяет почту и `user.id` через `GET /auth/get-session`, а `user.id`, tenant и роль owner — через `/v1/oma/me`.
   - Почта, пароль, `user_id` и `tenant_id` сохраняются в `state/test-user.json` (права 600, пароль не печатается), cookie — в `state/cookies.txt`.
2. **`journey.sh`** записывает свой PID (роль `journey`), проверяет нагрузку и запускает `nice -n 15 node journey-env-to-agent.mjs`. Сценарий пишет PID Chromium (роль `journey-child`). Шаги:
   - **Вход.** На `/login` нажать «Продолжить с почтой», заполнить `#auth-email` и `#auth-password`, затем в группе «Действия входа» нажать «Войти». Дождаться навигации и h1 в `main`. Проверяются cookie `better-auth.session_token`, почта и `user.id` в `GET /auth/get-session`, тот же `user.id` и tenant в `/v1/oma/me`.
     `/v1/oma/me` отдаёт почту через `loadUser` в `buildMeRoutes` (`apps/main-node/src/modules/node-http.ts`, маршрут `/oma/me`); строка `auth.me_email`. Источник истины для почты: Better Auth.
   - **Окружение.** Ссылка «Окружения» в навигации «Разделы консоли». Перед скриншотом сценарий ждёт h1 «Окружения» в `main` и пустое состояние «Окружений пока нет» (`env.list_empty`) или строку таблицы, а не смену URL. Дальше «Новое окружение», окно `dialog "Новое окружение"`, поля «Название» и «Описание (необязательно)», «Создать». Затем:
     - строка `[data-testid="data-body-table"] tr[data-slot="table-row"]` с именем окружения;
     - сверка через `GET /v1/environments/:id`;
     - карточка `/environments/:id` (h1 и `#env-name`).
   - **Проба окружения (обходной путь).** Действия «проверить окружение» нет ни в консоли, ни в API, а песочница создаётся лениво (`NodeSessionRouter.init`, `apps/main-node/src/lib/node-session-router.ts`). Поэтому по API создаются технический агент (только bash) и сессия на новом окружении, и отправляется одна команда. Проба доказывает:
     - VM поднялась: `Box started successfully` в логе BoxLite, процесс `libkrun VM` с pid из строки `boxlite-shim subprocess spawned … pid=N` — потомок нашего server-node, папка `.openma/litebox-scratch-*`;
     - VM выполнила команду: `agent.tool_result` содержит `VERIFY_OK_<nonce>`; ядро в VM отличается от ядра хоста;
     - база для настроек: пакета `jq` в образе нет (`env.probe.baseline`);
     - сессия пробы видна в консоли с репликой и ответом (`env.probe.ui_visible`, страница открыта заново, история из `GET /events`);
     - сеть «Без ограничений» (`env.probe.network`): отдельный ход `curl https://example.com` и `curl https://example.org` из VM и ещё один ход `echo`, чтобы проверить, жива ли VM после запроса. База: код того же адреса с хоста. До 2026-10-16 запрос ронял boxlite-shim (`Attach stream error … h2 protocol error`, затем `Connection refused`); причина и обход в `features/environments.md`. Сетевые ходы по-прежнему идут последними в сессиях пробы.

     Затем сессия архивируется, и проверяется, что VM остановилась (`Box stopped`, scratch удалён).
   - **Настройки окружения.** Снова «Окружения» → строка → карточка. Изменить `#env-description`, в «Тип доступа» выбрать «Ограниченный», включить «Разрешить сетевой доступ менеджерам пакетов», в «Разрешённые хосты» вписать `example.org`, «Добавить пакет» → менеджер `apt`, «Пакеты и версии» `jq`, «Сохранить изменения», тост «Окружение сохранено». Сверка `GET /v1/environments/:id` (`env.settings_saved`). Затем новая сессия на этом окружении (песочница создаётся заново):
     - `env.packages_applied`: в VM установлен `jq` (`dpkg-query`). Окружение доходит до адаптера через `buildSandbox` в `createManagedNodeRuntime` (`apps/main-node/src/modules/node-managed.ts`), пакеты ставит `initializeBox` (`packages/sandbox-adapter-litebox/src/litebox.ts`);
     - `env.networking_limited_applied`: неразрешённый `https://example.com` из VM даёт 000, и VM отвечает после запроса;
     - `env.networking_allowed_host`: разрешённый пользователем `https://example.org` из VM отвечает 200, как с хоста. «Ограниченный» превращается в `allowNet` BoxLite (`liteBoxNetwork` в `litebox.ts`), разрешённые имена закрепляются в `/etc/hosts` VM из-за ошибки DNS allowlist BoxLite 0.9.0. См. Gotchas сети в `features/environments.md`.

     Главная сессия идёт на том же настроенном окружении, поэтому её VM тоже ставит `jq` и живёт с «Ограниченной» сетью.

     Шаги настроек не обязательные: их сбой пишется провалом, а сценарий идёт к агенту. В конце технический агент пробы архивируется, чтобы шаг агентов шёл по пустому списку.
   - **Агент.** «Агенты» (h1 и пустое состояние «Агентов пока нет», `agent.list_empty`), «Новый агент», шаблон-кнопка `/^Пустой агент/`, `#agent-name` и `#agent-system`. Модель и усилие задаются в режиме «Форма», без YAML: `combobox "Модель"` → пункт `[data-slot="command-item"][data-value^="claude-sonnet-4-6 "]` (группа «Ключ сервера», список из `GET /v1/oma/model_options`, карточек моделей нет), `combobox "Усилие"` → «Низкое» (`agent.form_model_effort`, Harness «Встроенный цикл»). Вкладка «Инструменты», затем «YAML» той же формы: блок `model:` с `id: claude-sonnet-4-6` и `effort: low`, после возврата в «Форму» выбор на месте (`agent.yaml_roundtrip`). «Создать агента» из режима «Форма». Результат: переход на `/agents/:id`, в регионе «Свойства агента» модель, «Усилие: низкое» и «Встроенный цикл» (`agent.detail_ui`); `GET /v1/agents/:id` → `model: {id: "claude-sonnet-4-6", effort: {type: "low"}}` (`agent.created`; API отдаёт усилие объектом, YAML формы пишет строку `effort: low`). До 2026-10-16 без карточек в форме не было поля модели, и модель задавал YAML (строка «внимание» `agent.form_without_model_cards`, её больше нет).
   - **Сессия.** «Сессии» (h1), «Новая сессия». В окне два безымянных `combobox`: первый для агента, второй для окружения. В каждом выбрать `[data-slot="command-item"]` с нужным id. Заполнить `#session-title`, нажать «Создать». Результат: переход на `/sessions/:id`, в шапке чипы-ссылки `a[href="/agents/<id>"]` и `a[href="/environments/<id>"]` с именами (`session.header_ui`). Сверка через API: `agent.id`, `environment_id`, `archived_at = null`.
     - `session.title_saved`: название из окна сохранено (API и h1). Поле ведёт `Controller` (`pages/SessionsList.tsx`, поле `title` окна «Новая сессия»); до правки 2026-10-15 `{...register("title")}` с подменённым `name` терял ввод.
     - `session.initial_status`: новая сессия без сообщения: в API `status = idle`, в шапке «Ожидает», в разговоре «Отправьте сообщение, чтобы начать сессию.», текста «Агент работает…» нет (снимок `session-new`). Статус при создании считает `createSession` в `packages/managed-agents-application/src/sessions/application.ts` (`admitsBootstrapTurn`): `running` только если начальные события ставят ход в очередь.
   - **Ход агента.** Сценарий открывает тот же поток `GET /v1/sessions/:id/events/stream`, что и консоль (cookie браузера), затем в textbox «Сообщение» вводит промпт с маркером и нажимает кнопку отправки. Её подпись зависит от статуса (`ComposerPrimaryAction` в `SessionComposer.tsx`): в новой сессии это «Отправить сообщение» (`run.ui_send_label`; «Поставить сообщение в очередь» значит, что сессия ошибочно `running`). Проверки в интерфейсе:
     - `run.ui_prompt_on_send` и `run.ui_prompt_visible`: реплика пользователя (`[data-session-turn-prompt]` с `nonce=<n>`) видна в ходе сразу после отправки и после конца хода; `run.sse_user_message`: поток отдаёт `user.message` с маркером. Как реплика попадает в ход, см. Gotchas в `features/sessions-and-agent-run.md`;
     - `article[data-turn-id]` получил `data-session-turn-status=completed`, ответ виден в `[data-session-turn-answer]`;
     - `run.answer_full`: итоговый ответ (строка, блок кода с `VERIFY_DONE_<nonce>`, строка после него) виден целиком, первое сообщение хода (текст модели перед `tool_use`) тоже, повторов нет. «Виден» значит и в тексте страницы, и на экране: `clippedLine` проверяет, что строку не срезает предок с `overflow: hidden` (сценарий ждёт конца анимации раскрытия блока процесса, `settleAnimations`). `run.turn_duration`: нет «Работал 0 с» при ходе дольше секунды. Почему ответ резался (`streamPrefixes`), см. Gotchas в `features/sessions-and-agent-run.md`;
     - страница сессии как в консоли Claude (`docs/plans/session-page.md`), id событий берутся из `GET /events` (`api/47-session-page-events.json`), рецепты в `features/sessions-and-agent-run.md`:
       - `session.ui_no_usage`: шапка, подсказки её чипов, меню «Действия» и вкладка «Сессия» без токенов, стоимости и бюджета. На странице нет `[data-session-chip="tokens"]` и `[data-session-chip="cost"]`, текста «нет цены», пункта меню и кнопки «Изменить бюджет». При этом журнал хранит `model_usage` всех `span.model_request_end`, чипы `duration` и `activity` на месте, в таблице «Использование» есть «Активное время». Находки идут списком, снимки `session-actions-menu` и `session-tab`;
       - `session.ui_inspector`: «Инспектор сессии» закрывается крестиком и открывается кнопкой «Инспектор», в адресе `inspector=`, ширина 360..720 px, ровно 5 вкладок: «Сессия», «События», «Инструменты», «Ресурсы», «Потоки»;
       - `run.ui_tool_card` и `session.ui_select_sync`: при открытых «Событиях» клик по строке `[data-tool-call][data-event-id=<id agent.tool_use>]` в ходе раскрывает вызов (`[data-tool-command]`, `[data-tool-output]` с `VERIFY_OK_<nonce>`), ставит `?event=<id>` и выделяет одну строку с этим id во «Событиях» с её JSON;
       - `run.ui_tool_output_text`: вывод показан текстом (строка `kernel=` отдельно, без `"type": "text"`, без литералов `\n` и `\u001b`, текст в `api/45-tool-card-text.txt`); `run.ui_tool_duration`: длительность в строке вызова равна разнице `processed_at` у `agent.tool_use` и `agent.tool_result` (допуск 0,25 с) и не 0;
       - `session.ui_events`: во «Событиях» строки `user.message` и `agent.tool_use` хода с id из журнала, клик показывает «Событие <тип>» и JSON с тем же `"id"` и маркером;
       - `session.ui_tools`: во «Инструментах» у `bash` 1 вызов и 0 ошибок, как в журнале;
       - `session.ui_minimap`: «Карта хода» держит отрезок реплики и по отрезку на каждый `span.model_request_start`, наведение показывает карточку с именем агента;
       - `session.ui_search`: nonce в «Найти в разговоре» даёт счётчик `1/N` при N ≥ 2, подсветку `CSS.highlights` «session-search» с текстом nonce и метки на мини-карте;
       - `run.ui_files`: на вкладке «Ресурсы» ссылка `/mnt/session/outputs/verify-<nonce>.txt` на `GET /v1/sessions/:id/outputs/verify-<nonce>.txt`;
       - `session.ui_mobile_390`: на 390 x 844 у документа и `main` нет горизонтальной прокрутки, и с закрытым инспектором, и с нижним листом `?inspector=events`.

     Через API и файлы проверяется:
     - порядок событий `user.message → agent.tool_use(bash) → agent.tool_result → agent.message → session.status_idle(end_turn)`;
     - `GET /v1/sessions/:id/outputs`;
     - файл `<прогон>/data/session-outputs/<tenant>/<session>/verify-<nonce>.txt` с содержимым `VERIFY_OK_<nonce>`. Он записан внутри VM в `/mnt/session/outputs`;
     - ядро VM отличается от ядра хоста;
     - записи BoxLite (третий старт VM) и процесс VM — потомок нашего сервера;
     - вывод bash без служебных строк рантайма (`tool_output_clean`): ведущую строку stderr `libcontainer … seccomp not available` срезает адаптер (`stripRuntimeNoise`);
     - решения фейковой модели;
     - `run.fake_model_effort`: усилие из формы дошло до модели. У каждого запроса хода в журнале фейка `thinking: "adaptive"` и `effort: "low"` (pi-ai шлёт `output_config.effort`), у запросов технического агента пробы без усилия `effort: null`.

     В конце сессия архивируется, и проверяется остановка VM.
   - **Итог.** Для каждой подфункции из разделов `Sub-features` в `features/*.md`, которую сценарий не прошёл, в `summary.md` автоматически пишется строка «не проверено» `feature.<id>`. Скриншоты соседних шагов сравниваются по sha256 (`evidence.screens_distinct`).

Чтобы оставить сессии живыми для ручного осмотра, задайте `VERIFY_KEEP_SESSION=1`. Чтобы видеть браузер, задайте `VERIFY_HEADED=1`.
Таймауты ходов: `VERIFY_FIRST_TURN_TIMEOUT_MS` (по умолчанию 900000) и `VERIFY_TURN_TIMEOUT_MS` (по умолчанию 600000).
Первый ход с новым `BOXLITE_HOME` скачивает образ `node:22-bookworm` и собирает его диск: 2026-10-15 это заняло около минуты, кэш вырос до 3 ГБ. Дальше проба идёт за 2–8 с.

Устойчивые зацепки и ловушки по каждой функции описаны в `features/` (начните с `features/README.md`).

## Сценарий Claude Code в песочнице

Отдельный сценарий `claude-code` (`scripts/journey-claude-code.mjs`, рецепт и ловушки в `features/claude-code-sandbox.md`): агент конструктора на harness `acp-sandbox` с ACP-агентом `claude-acp`, Claude Code запускается **внутри VM LiteBox** сессии. Рецепт для людей: `docs/runbook-claude-code-sandbox.md`.

```sh
RUN="$(VERIFY_PORT=8795 VERIFY_FAKE_PORT=8796 VERIFY_LITEBOX_DISK_SIZE_GB=4 $S/launch.sh)" && { $S/doctor.sh --run "$RUN" && $S/seed-user.sh --run "$RUN" && $S/journey.sh --run "$RUN" --scenario claude-code; $S/cleanup.sh --run "$RUN"; }
```

- Порты 8795 и 8796, чтобы не мешать главному сценарию и пробной копии; правило «один прогон за раз» общее (кэш BoxLite один).
- `VERIFY_LITEBOX_DISK_SIZE_GB=4` обязателен: launch передаёт его серверу как `LITEBOX_DISK_SIZE_GB`, без него `npm install -g @agentclientprotocol/claude-agent-acp@0.91.0` в VM падает с `ENOSPC` (диск образа 1,3 ГБ, пакет ~330 МБ). Версия пакета закреплена в `CC_PACKAGE`: npm ставит его при каждом старте VM, и новый релиз Claude Code не должен менять прогон.
- Путь пользователя через консоль: карточки моделей, окружение с npm-пакетом, страница «Harness» с карточкой своего ACP-агента, агент Claude Code в форме (Harness «Claude Code в песочнице», модель карточки; список `allow` расширен в YAML той же формы), сессия с хранилищем, агент на своей карточке и его сессия. Учётные данные «переменная окружения» создаются по API (в консоли нет такой формы), это строка «внимание» `cc.vault_api_path`.
- **Модель через прокси.** Claude Code и свой агент в VM ходят в модель через `/v1/oma/inference-proxy/<сессия>` сервера с токеном хода `oma_sbx_`, прокси ставит ключ карточки и меняет `model` на `wire_model`. Ключа модели в VM нет: в хранилище сессии лежит фиктивный `ANTHROPIC_API_KEY`, и сценарий доказывает, что он до VM не дошёл (`cc.vm_env_no_key`), а обычная переменная хранилища дошла.
- **Режим fake (по умолчанию).** Карточка `verify-cc-<n>` указывает на `fake-model.mjs` хоста, ключ фиктивный. Фейк ведёт ход `Write verify.txt` → `Read` → контрольный `Bash touch …` (должен быть отклонён: режима обхода разрешений нет) → `VERIFY_CC_DONE_<n>`. Второй ход той же сессии (`… turn=2`): `Bash ps -eo pid,ppid,args` → `Bash ps eww -o args= -p <pid>` (окружение `claude-agent-acp`, в журнал идут только имена и sha256) → `VERIFY_CC_TURN2_<n> acp_processes=<k>`. Проверки в `summary.md`:
  - `cc.model_cards`, `cc.guard_*` (400 на секрет и ключ модели в env, неизвестный harness, несовместимую модель; отказ в окне агента), `cc.form_*` (несовместимая модель выключена с причиной, замена модели, подсказки ACP), `cc.agent_*`;
  - события хода, карточки в консоли, `verify.txt` в выводах и на хосте, VM запущена сервером, user-agent `claude-cli/…`;
  - `cc.proxy_card_key`: во всех запросах хода ключ карточки, без Bearer, `model` = `wire_model`;
  - второй ход возобновил ACP-сессию (`[acp-init] mode=resume|load`, реплика первого хода в истории), в VM ровно один `claude-agent-acp`, на хосте среди потомков сервера его нет;
  - `cc.vm_env_proxy`, `cc.vm_env_no_key`: у `claude-agent-acp` адрес прокси этой сессии, токен `oma_sbx_…`, handle карточки, ключей моделей нет;
  - `harness.*`: страница «Harness», карточка своего агента в API, каталоге и форме, ход агента на карточке в VM через прокси, ответ в консоли (`features/harnesses.md`);
  - остановка VM после архива. sha256 ключей печатается только в режиме fake.
- **Режим real.** Включается только явно, тратит лимит и ни разу не запускался. Команда: `VERIFY_CC_MODE=real VERIFY_CC_SECRET_FILE=<файл с ключом API Anthropic, права 600> $S/journey.sh --run "$RUN" --scenario claude-code`. Ключ читается только из этого файла (файлы в `~/.claude` сценарий отвергает), значение не печатается и уходит в карточку модели без адреса. Токен подписки (`VERIFY_CC_SECRET_NAME=CLAUDE_CODE_OAUTH_TOKEN`) через прокси не поддерживается. Сервер при этом остаётся в режиме fake: Pi-модель ему не нужна.
- Подфункции сценария (`cc-*` и `harness-card-*`) помечены в `features/claude-code-sandbox.md` и `features/harnesses.md` строкой `<!-- scenario: claude-code -->`: главный сценарий их не считает, сценарий `claude-code` считает только их.

**Статус сценария.** Прогон 2026-10-16 `20261016-082329` (порт 8795, fake, тот же снимок, та же сборка консоли и те же хэши, что у `20261016-082706`): «ПРОЙДЕН», 57 проверок, 0 провалов, две строки «внимание» (`cc.vault_api_path`, `cc.vault_plain_in_vm`), подфункций сценария 18 из 19 (`cc-real-key` не запускался). Цепочка от launch до конца cleanup заняла 107 с. Первый ход Claude Code с установкой пакета в новой VM занял 24 с, второй 2 с, ход своего агента 35 с (VM ставит пакеты окружения Claude Code). Второй ход в той же сессии возобновил ACP-сессию, в VM во время второго хода один `claude-agent-acp`, на хосте его нет. С волной «модели и harness» сценарий проверяет guard (`cc.guard_*`), форму агента (`cc.form_*`), прокси модели (`cc.proxy_card_key`, `cc.vm_env_proxy`, `cc.vm_env_no_key`) и свой harness (`harness.*`). Прогон `20261016-081059` на той же сборке дал 3 провала: `cc.ui_tool_cards`, `cc.ui_denied_badge` и `cc.ui_files` искали карточки `[data-slot="collapsible-trigger"]` и панель «Файлы сессии» старой страницы сессии. Сценарий переведён на строки `[data-tool-call]` и вкладку «Ресурсы» инспектора, и `20261016-081527` прошёл. С `20261016-082329` `harness.card_proxy` сверяет и значения: тестовый агент помечает каждую переменную с KEY, TOKEN, SECRET или PASSWORD в имени, равна ли она токену хода. Более ранние прогоны того же дня нашли дефекты продукта и скрипта:
- `20261016-024343`: во втором ходе в VM два `claude-agent-acp`, процесс первого хода не закрылся (BoxLite не доставляет сигнал, исправлено закрытием stdin в `spawnDuplexProcess`);
- `20261016-011416`: ПРЕРВАН на launch: `VERIFY_PORT: unbound variable` (исправлено в `start_server`, см. Helpers);
- `20261016-011625`: `session.error` «Could not extract text from user message — empty turn»: main-node отдавал харнессу пустой `userMessage` (исправлено, `apps/main-node/src/lib/node-managed-harness-user-message.ts`); <!-- unslop-ignore: цитата ошибки -->
- `20261016-011901`: ход прошёл, но отклонённый Bash приходил без `is_error` и в консоли был «Готово» (исправлено в `AcpTranslator`), плюс неверные ожидания скрипта о форме событий API;
- `20261016-012056`: doctor отказался вести экземпляр: код сервера менялся после launch (так и должно быть).

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
  - текст вывода bash `45-tool-card-text.txt`, текст ответа хода со страницы `46-turn-answer-text.txt`, журнал главной сессии для проверок страницы `47-session-page-events.json`, outputs, YAML агента, копия файла из VM;
  - каталог моделей формы агента `29-model-options.json`;
  - `fake-model-requests.jsonl` (у каждого запроса `thinking` и `effort`);
  - сценарий `claude-code`: `cc-05-model-options.json`, `cc-20-vault-credentials.json`, ответы guard `cc-25-guard.json`, карточки harness и каталог `cc-26-harness-cards.json`, `cc-27-harnesses.json`, окружение `claude-agent-acp` в VM без значений `cc-46-turn2-env.json`, агент, журнал и запросы к фейку своего harness `cc-60-card-agent.json`, `cc-61-card-session-events.json`, `cc-62-card-fake-requests.json`.
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
    В логе сервера есть строка `creating box (image=…, network=…)` от `litebox-sandbox` (`*.server_log_box`): логгер берётся в момент записи (`moduleLogger` в `litebox.ts`), а не при импорте.
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
| `scripts/journey.sh` | `$S/journey.sh --run "$RUN" [--scenario claude-code]` | PID сценария, проверка нагрузки, Node 24, `nice` и запуск сценария (по умолчанию главного) |
| `scripts/journey-env-to-agent.mjs` | через `journey.sh` | Главный сценарий Playwright, проверки и `summary.md` |
| `scripts/journey-claude-code.mjs` | через `journey.sh --scenario claude-code` | Сценарий «Claude Code и свой harness в VM»: карточки моделей, окружение, хранилище, guard, страница «Harness», агент Claude Code из формы, два хода через прокси модели, агент на своей карточке, `summary.md` |
| `scripts/acp-echo-agent.cjs` | аргумент `-e` карточки своего harness (сценарий склеивает файл в строку до 2000 знаков) | Тестовый ACP-агент: JSON-RPC по stdio без зависимостей, на реплику зовёт модель через прокси по `OMA_INFERENCE_*` и отвечает `VERIFY_ACP_ECHO_<n> model=… protocol=… base=… token=<8 знаков> keys=<имя>:<true\|false>,…` (true: значение переменной равно токену хода) |
| `scripts/fake-model.mjs` | запускает `launch.sh` (`node fake-model.mjs --port 8792 --log f.jsonl`) | Модель Anthropic Messages (SSE): bash с командой из промпта, затем `VERIFY_DONE_<nonce>` (в ходе агента `VERIFY_AGENT_RUN` перед bash ещё текст, а ответ состоит из блока кода с `VERIFY_DONE_<nonce>` и строки после него); для маркера `VERIFY_CLAUDE_CODE` ход Claude Code (Write, Read, Bash, текст; во втором ходе `ps` и окружение `claude-agent-acp` без значений); для `VERIFY_ACP_CARD` ответ без потока `VERIFY_MODEL_SAW_<n>`; отвечает на проверку ключа карточки OpenAI (`/chat/completions`); пишет в журнал `thinking` и `effort` каждого запроса |
| `scripts/cleanup.sh` | `$S/cleanup.sh --run "$RUN" [--keep-state]` | Остановка по своим PID и уборка временных данных одного прогона |

Переопределяемые переменные:

- `VERIFY_PORT`, `VERIFY_FAKE_PORT`;
- `VERIFY_STATE_ROOT`, `VERIFY_BOXLITE_HOME`, `VERIFY_EVIDENCE_ROOT`;
- `VERIFY_MODEL_MODE`, `VERIFY_AGENT_MODEL`, `VERIFY_SANDBOX_IMAGE`, `VERIFY_LITEBOX_DISK_SIZE_GB`, `VERIFY_LITEBOX_MEMORY_MIB`;
- `VERIFY_CONSOLE_DIR`, `VERIFY_RUN_DIR`, `VERIFY_RUN_ID`, `VERIFY_START_TIMEOUT_S`;
- память перед тяжёлой командой (`vac_wait_cool`): `VERIFY_MIN_FREE_MB` (3072), `VERIFY_MIN_HEADROOM_MB` (6144);
- сценарий: `VERIFY_KEEP_SESSION`, `VERIFY_HEADED`, `VERIFY_CHROMIUM`, `VERIFY_FIRST_TURN_TIMEOUT_MS`, `VERIFY_TURN_TIMEOUT_MS`;
- сценарий `claude-code`: `VERIFY_CC_MODE` (`fake` или `real`), `VERIFY_CC_SECRET_FILE`, `VERIFY_CC_SECRET_NAME`.

Значения `VERIFY_*` можно передавать в окружении `launch.sh` (`VERIFY_PORT=8795 $S/launch.sh`): до 2026-10-16 `start_server` снимал экспортированные переменные до чтения, и сервер падал с `VERIFY_PORT: unbound variable` (прогон `20261016-011416`).
