# CMA, раздел 9: свои песочницы (self-hosted)

Разбор семи страниц документации Claude Managed Agents про свои песочницы и сверка с нашей копией Open Managed Agents в `platform/`. Дата сверки 17.10.2026, ветка `feat/agent-console` с незакоммиченными правками. Области ACP, карточек харнесов и CLI-моста не смотрели, их сейчас удаляют. Пути в таблицах даны от `platform/`.

## 1. Коротко

В CMA окружение типа `self_hosted` работает как очередь. Сессия попадает в очередь работ, ваш воркер на своём сервере забирает работу и выполняет инструменты агента у себя. Модель Claude при этом работает у Anthropic. Воркер ходит к API сам, только исходящим HTTPS, входящие порты не нужны. Воркер входит по ключу окружения, а для памяти получает отдельный секрет на каждую сессию.

Готовые воркеры есть в `ant` CLI и в SDK для Python, TypeScript и Go. Свои инструменты и обёртку над MCP-сервером умеет только SDK-воркер. Из ресурсов сессии разрешены только хранилища памяти, файлы и репозитории воркер раскладывает сам.

У нас серверная часть очереди сделана полностью. Маршруты work совпадают с типами SDK, ключ окружения и секрет работы ограничены так же строго, как в CMA. Главное отличие в схеме. У нас воркер своего окружения ведёт весь цикл агента, вместе с вызовами модели, а сервер ходы таким сессиям не раздаёт. Поэтому официальный `ant` или SDK-воркер возьмёт работу, но вызовов инструментов не дождётся. Наш собственный воркер подключён только в сборке для Cloudflare. В консоли нельзя создать такое окружение, выпустить ключ окружения и посмотреть очередь.

## 2. Страницы

Все семь страниц помечены как beta. Каждый запрос несёт заголовок `anthropic-beta: managed-agents-2026-04-01`. Маршруты очереди описаны в справочнике API, раздел Environments Work.

### 2.1 Обзор и быстрый старт (self-hosted-sandboxes)

Страница объясняет схему из трёх шагов. Вы создаёте сессию на окружении, Anthropic ставит её в очередь. Воркер забирает работу, скачивает навыки агента и хранилища памяти сессии. Claude просит вызвать инструмент, воркер выполняет его у себя и отправляет результат обратно. Входы и выходы инструментов всё равно видит Anthropic, иначе модель не продолжит работу.

| Что | Как |
|---|---|
| Окружение | `POST /v1/environments` с `config: {"type": "self_hosted"}`. Других полей у такого config нет |
| Ключ окружения | Кнопка «Generate environment key» на странице окружения в Claude Console. Через API его не выпустить. Вид `sk-ant-oat01-...` |
| Переменные воркера | `ANTHROPIC_ENVIRONMENT_KEY`, `ANTHROPIC_ENVIRONMENT_ID` |
| Хост | Linux, `/bin/bash` ровно по этому пути, только исходящий HTTPS |
| API-ключ организации | Держать вне хоста воркера, иначе его прочитает любая команда агента |
| Запуск | `ant beta:worker poll --workdir /workspace`, в примере `ant` версии 1.42.0 |
| Проверка | `GET /v1/environments/{id}/work/stats`, поле `workers_polling` не меньше 1 |
| Без воркера | Сессия ждёт в очереди и не падает |

Ресурсы сессии. Разрешён только `memory_store`. Сессия с `file` или `github_repository` получает ответ 400 с текстом про self-hosted окружение. То же правило действует для деплойментов.

MCP-туннели и свои песочницы не связаны. Туннель решает, как Anthropic достучится до MCP-сервера в вашей сети. Своя песочница решает, где выполняется код агента. Можно взять одно, другое или оба.

На Claude Platform on AWS воркер входит через IAM с подписью SigV4 или по ключу из AWS Console, ему нужна политика `AnthropicSelfHostedEnvironmentAccess`. Ключи окружения из Claude Console там не работают. Готовые инструкции есть у Cloudflare, Daytona, E2B, Modal, Vercel, Fly.io, GKE и ещё нескольких площадок.

### 2.2 Развёртывание воркеров (self-hosted-sandboxes-workers)

Нужно сделать два выбора. Первый про то, как воркер берёт работу. Постоянный воркер опрашивает очередь всё время. Воркер по вебхуку просыпается на событие `session.status_run_started` и выбирает очередь до дна. Второй выбор про то, где идёт сессия. Либо в процессе воркера в одной общей рабочей папке, либо в новой песочнице на каждую сессию.

| Возможность | `ant` CLI | SDK: Python, TypeScript, Go |
|---|---|---|
| Постоянный опрос | да | да |
| Запуск по вебхуку | нет | да |
| Песочница на сессию | да | да |
| Хранилища памяти | да, настройки синхронизации по умолчанию | да, настройки меняются |
| Свои инструменты | нет | да |

Воркер по вебхуку проверяет подпись ключом `ANTHROPIC_WEBHOOK_SIGNING_KEY` вида `whsec_...`. Дальше он запускает опросчик с параметрами `block_ms: null`, `reclaim_older_than_ms: 2000`, `drain: true`, `auto_stop: false` и отдаёт каждую работу в `handle_item()`. Сессия живёт дольше доставки вебхука, поэтому работу отвязывают от контекста HTTP-запроса.

Песочница на сессию. Образ ставит `ant` и запускает `ant beta:worker run`. На хосте работает `ant beta:worker poll --on-work ./spawn.sh`. Скрипт получает работу в JSON на stdin и переменные `ANTHROPIC_*`, кроме секрета. Секрет скрипт берёт из поля `secret` и передаёт в песочницу как `ANTHROPIC_WORK_SECRET`. Секрет нельзя писать в лог и класть в образ.

Файлы для сессии. Anthropic не монтирует файлы и репозитории в свою песочницу. Ссылку на файл кладут в `metadata` сессии, скрипт читает сессию через `GET /v1/sessions/{id}` и раскладывает файлы в рабочую папку до первого инструмента. Сама работа несёт только ID сессии, без metadata.

### 2.3 Свои инструменты и MCP (self-hosted-sandboxes-custom-tools)

Свой инструмент работает так. Агент шлёт событие `agent.custom_tool_use` и ждёт `user.custom_tool_result`. Отвечать может воркер, ключ окружения даёт право отправить результат. Инструмент объявляют на агенте с типом `custom` и регистрируют в воркере через фабрику `tools`. Если инструмент никто не обслуживает, сессия встаёт с причиной `requires_action` и ждёт.

MCP-сервер, доступный только из вашей сети, можно обернуть. Воркер сам становится MCP-клиентом, а инструменты сервера объявляются на агенте как `custom`. Anthropic видит объявления, входы и результаты, но к серверу не ходит. Список инструментов воркер читает один раз при старте. Новые инструменты требуют новое объявление на агенте и перезапуск воркера.

| Поле | Правило |
|---|---|
| `name` | Уникален у агента, буквы, цифры, `_` и `-`, от 1 до 128 знаков. Нельзя имя встроенного инструмента вроде `bash` и префиксы `mcp__`, `ant__` |
| `description` | Обязателен и не пустой |
| `input_schema` | Нельзя `$ref` и верхнеуровневые `oneOf`, `anyOf`, `allOf`. Имена свойств от 1 до 64 знаков, можно точку |
| `tools` агента | Не больше 256 записей, набор встроенных инструментов считается одной |

Ошибка MCP-сервера приходит модели как результат с ошибкой. Аудио и ссылки на ресурсы тоже дают ошибку. Таймаут на MCP-клиенте лучше ставить самому. Правила permission policies к таким инструментам не применяются, воркер выполняет каждый вызов. Обёртку стоит делать только для своих серверов, их ответы попадают в контекст модели.

### 2.4 Память (self-hosted-sandboxes-memory)

Сессия подключает до 8 хранилищ так же, как в облаке. Разница в том, кто кладёт их на диск. Здесь это делает воркер.

| Что | Значение |
|---|---|
| Требования | `ant` от 1.33.0 или `EnvironmentWorker` из SDK; POSIX, Windows нельзя; папка `/mnt/memory` с правом записи; секрет работы |
| Путь | `/mnt/memory/<имя-хранилища>/`, папку создаёт и удаляет воркер. Если путь занят, работа не стартует |
| Метка | Файл `.anthropic-memory-store` в каждой папке. Без него папка не синхронизируется |
| Синхронизация | После вызовов инструментов, не чаще раза в 15 с. Минимум 5 с. `None` выключает память совсем |
| Конец сессии | Последняя синхронизация, догрузка до 30 с, удаление папок |
| Удаления | `memory_sync_deletions`: `enabled` по умолчанию, `log_only` только пишет в лог, `disabled` не удаляет |

Хранилище `read_only` защищено от выгрузки, а не от правки на диске. Инструменты `write` и `edit` откажут, но `bash` и свои инструменты файл поменяют. Такая правка не уйдёт в хранилище и пропадёт при следующем изменении на сервере. При конфликте побеждает версия хранилища, воркер пишет предупреждение в лог, агент ошибку не видит. Две сессии с одним хранилищем на одном хосте не уживутся, путь у них общий. На AWS память к своим песочницам не подключается.

Расхождение со справочником скилла claude-api. Там опция названа `memory_sync_deletes` и сказано, что `ant` память не монтирует. Живая страница говорит `memory_sync_deletions` и `ant` от 1.33.0. Верим живой странице.

### 2.5 Наблюдение и неполадки (self-hosted-sandboxes-operations)

Эти вызовы делают из своих средств наблюдения с API-ключом организации, не с хоста воркера.

| Поле `work/stats` | Смысл |
|---|---|
| `depth` | Сколько работ ждёт захвата |
| `pending` | Захвачены, но не подтверждены. Долгое ненулевое значение значит, что воркер завис |
| `oldest_queued_at` | Время самой старой работы в очереди или `null` |
| `workers_polling` | Сколько воркеров опрашивали очередь за 30 с |

Остановка сессии. `POST /v1/environments/{id}/work/{work_id}/stop` переводит работу в `stopping`. Воркер видит это на следующем heartbeat, отменяет текущий инструмент и подтверждает, работа становится `stopped`. С `force: true` она сразу `stopped`.

Остановка воркера. SIGTERM и SIGINT должны отменять воркер. `ant` делает это сам, SDK-воркер сигналы не ловит. До жёсткого убийства нужно ждать не меньше 30 с. Docker по умолчанию убивает через 10 с, это меняет `--stop-timeout`. Убитый воркер теряет несинхронизированную память и оставляет папки в `/mnt/memory`.

Неполадки по страницам:

- `workers_polling` остаётся 0. Проверьте ключ и ID окружения на хосте воркера.
- Сессия висит в очереди. Нет воркера, смотрите `depth` и `workers_polling`.
- Память не подключилась. Воркер пишет в лог одно из трёх сообщений: нет секрета, путь уже занят, нет прав на `/mnt/memory`. Сессия молча стоит в `idle` с `requires_action`. После починки хоста шлют `user.interrupt`, работа снова встаёт в очередь.
- Свой инструмент не отвечает. Его никто не обслуживает.
- Обёрнутый MCP-вызов завис. Без своего таймаута он упадёт примерно через 2,5 мин в Python, через минуту в TypeScript, через 120 с в Go.

### 2.6 Модель безопасности (self-hosted-sandboxes-security)

Anthropic отвечает за очередь, изоляцию клиентов и минимум данных в контексте агента. Остальное на владельце песочницы:

- образ и его защита: не root, лишние права Linux убрать, корневая ФС только для чтения;
- исходящая сеть: без ограничений взломанный инструмент дойдёт до любого хоста;
- ключ окружения: хранить в менеджере секретов, при утечке отозвать и выпустить новый;
- отдельное окружение на каждую границу доверия, ключ видит очередь только своего окружения;
- секрет работы: только в песочницу этой сессии, не в образ, не в общий том, не в лог. API памяти принимает только его, ключ окружения туда не пускают;
- права процесса воркера и смонтированные папки;
- логи и содержимое сессий, они остаются у вас;
- копии памяти в `/mnt/memory` и изоляция сессий на одном диске.

Anthropic не узнает об утечке ключа сам. Отзыв проверяется на каждом запросе и действует со следующего вызова воркера. Anthropic не проверяет ваш образ, не изолирует инструменты внутри песочницы и не управляет хранением данных после воркера.

### 2.7 Справочник воркера (self-hosted-sandboxes-reference) и Work API

| Команда или флаг `ant` | Смысл |
|---|---|
| `beta:worker poll` | Берёт работы и ведёт сессии в процессе, с `--on-work` зовёт ваш скрипт |
| `beta:worker run` | Ведёт одну захваченную сессию и выходит, точка входа песочницы |
| `--environment-id`, `--environment-key` | Или переменные `ANTHROPIC_ENVIRONMENT_ID`, `ANTHROPIC_ENVIRONMENT_KEY` |
| `--workdir` | Рабочая папка и папка навыков, по умолчанию текущая |
| `--max-idle` | Сколько ждать после `end_turn` до выхода, по умолчанию `60s` |
| `--log-format` | `text` или `json` |

Переменные: `ANTHROPIC_SESSION_ID` и `ANTHROPIC_WORK_ID` ставит опросчик, `ANTHROPIC_WORK_SECRET` ставите вы, ещё есть `ANTHROPIC_BASE_URL` и `ANTHROPIC_WEBHOOK_SIGNING_KEY`. Пути: `/workspace` по умолчанию, навыки в `<workdir>/skills/<name>/`, память в `/mnt/memory/<store>/`. Инструкции про `/mnt/session/outputs` в системном промпте нет, результаты лежат там, куда их записал агент. SDK на TypeScript требует `unzip`, `tar` и Node.js 22+.

Помощники SDK. `EnvironmentWorker` с методами `run()` и `handle_item()` и опциями `tools`, `memory_sync_interval`, `memory_sync_deletions`. Опросчик `work.poller()` с опциями `drain`, `block_ms` от 1 до 999 мс, по умолчанию 999,, `reclaim_older_than_ms`, `auto_stop`. `tool_runner()` ведёт инструменты одной сессии. `AgentToolContext` задаёт `allowed_roots` и `read_only_roots`, это ограничение только для файловых инструментов, `bash` оно не держит.

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/v1/environments/{id}/work` | Список, `limit` от 1 до 1000, по умолчанию 20, курсор `page` |
| GET | `.../work/poll` | Длинный опрос. `block_ms` от 1 до 999, `reclaim_older_than_ms` по умолчанию 5000. Заголовок `Anthropic-Worker-ID` |
| GET | `.../work/{work_id}` | Одна работа |
| POST | `.../work/{work_id}` | Слить `metadata`, `null` удаляет ключ |
| POST | `.../work/{work_id}/ack` | Подтвердить, `queued` становится `starting` |
| POST | `.../work/{work_id}/heartbeat` | Продлить аренду. `desired_ttl_seconds`, `expected_last_heartbeat` со значением `NO_HEARTBEAT` для первого раза, при несовпадении 412 |
| POST | `.../work/{work_id}/stop` | Остановить, `force` |
| GET | `.../work/stats` | Состояние очереди |

Поля работы: `id` вида `work_...`, `type: "work"`, `data` с `type: "session"` и ID сессии, `environment_id`, `state`, `secret`, `metadata`, отметки `created_at`, `acknowledged_at`, `started_at`, `latest_heartbeat_at`, `stop_requested_at`, `stopped_at`. Поле `secret` заполнено только в ответе на опрос. Состояния: `queued`, `starting`, `active`, `stopping`, `stopped`.

## 3. Как у нас

| Возможность | В CMA | У нас | Где |
|---|---|---|---|
| Окружение `self_hosted` в API | бета | есть и работает | `packages/managed-agents-api/src/contracts/environments.ts:91`; `packages/managed-agents-application/src/environments/application.ts:95` |
| Создание такого окружения в консоли | есть, выбор Hosting | нет. Селект «Тип размещения» выключен и знает только «Облако» | `apps/console/src/pages/EnvironmentsList.tsx:298` |
| Карточка окружения «Свой сервер» | ключ, статус воркеров | частично. Есть чип и скрытые разделы образа и сети. Ключа и очереди нет | `apps/console/src/pages/EnvironmentDetail.tsx:172`, `:249` |
| Ключ окружения | только в Claude Console | частично. `POST /v1/oma/api_keys` с `environment_id` выдаёт ключ `oma_env_...`. Сервер не проверяет, что окружение есть и оно `self_hosted`. Консоль `environment_id` не передаёт | `packages/http-routes/src/api-keys/index.ts:92`; `apps/console/src/pages/ApiKeysList.tsx:58` |
| Ключ окружения ходит только в свою очередь | есть | есть и работает. Только Bearer и только `/v1/environments/{id}/work`. Ключ рабочего пространства Bearer-ом в очередь не пустят | `packages/auth/src/index.ts:172`, `:188` |
| Отзыв ключа на каждом запросе | есть | есть и работает | `apps/main-node/src/modules/node-runtime.ts:206`, `:234` |
| Work API: list, poll, get, update, ack, heartbeat, stop, stats | бета | есть и работает. Ответы по типам SDK, `reclaim` по умолчанию 5000 мс, воркеры за 30 с, `NO_HEARTBEAT` и 412, `force` | `packages/managed-agents-api/src/routes/environment-work.ts:38`, `:76`, `:115`, `:206`, `:228`, `:270`; `packages/managed-agents-application/src/environment-work/application.ts:32`, `:432`, `:453`; `apps/main-node/src/modules/node-http.ts:476` |
| Работа ставится при старте сессии | есть | есть и работает, аренда 90 с | `packages/managed-agents-adapters-runtime/src/session-lifecycle-router.ts:62`; `packages/managed-agents-application/src/environment-work/enqueuer-application.ts:82` |
| Секрет работы на сессию | есть | есть и работает. Токен живёт 24 ч и открывает только свою работу, свою сессию, навыки, файлы и память агента. Для `read_only` запись закрыта. Повторный захват гасит старый токен | `packages/managed-agents-adapters-runtime/src/environment-work-session-token.ts:8`, `:242`, `:330`; `apps/main-node/src/modules/node-http.ts:250` |
| Кто вызывает модель | Anthropic, воркер ведёт только инструменты | нет, схема другая. Воркер ведёт весь цикл агента, сервер ходы таким сессиям не раздаёт. Вывод по коду, вживую не проверяли | `session-lifecycle-router.ts:47`, `:134`; `apps/main-node/src/modules/node-managed.ts:779` |
| Официальный `EnvironmentWorker` из SDK | есть | частично. Контрактный тест проводит SDK-воркер через poll, ack, heartbeat, события и stop. Событие `agent.tool_use` в тесте задано руками | `packages/managed-agents-api/test/official-environment-worker.contract.test.ts:27` |
| Свой воркер | `ant` CLI и SDK | в коде, не подключено к Node. Есть вебхук, опрос, heartbeat и передача `ANTHROPIC_*` в песочницу. Вызывает его только сборка для Cloudflare, `main-node` пакет не подключает | `packages/managed-runtime-host/src/environment-worker.ts:151`, `:254`, `:721`; `packages/managed-runtime-cloudflare/src/cloudflare.ts:410` |
| Песочница на сессию | `--on-work` | в коде, не подключено. Порт передачи работы провайдеру | `packages/managed-runtime-host/src/dispatched-environment-worker.ts:19`, `:128` |
| Вебхук `session.status_run_started` | есть | есть и работает. Подпись Standard Webhooks, один адрес на сервер из `OMA_MANAGED_AGENTS_WEBHOOK_URL` | `apps/main-node/src/modules/node-managed.ts:882`; `apps/main-node/src/config.ts:329`; `enqueuer-application.ts:87` |
| Запрет `file` и `github_repository` | 400 | нет. Код `self_hosted_resources_unsupported_error` объявлен, но его никто не ставит | `packages/managed-agents-application/src/sessions/resource-resolver-service.ts:100`; `packages/managed-agents-api/src/contracts/deployments.ts:147` |
| Память на своём сервере | воркер синхронизирует `/mnt/memory` | частично. Токен открывает API памяти с учётом `read_only`, наш воркер отдаёт клиент памяти рантайму. В Node воркера нет, настроек интервала и удалений нет | `environment-work-session-token.ts:330`; `environment-worker.ts:430` |
| Свои инструменты с ответом через события | есть | частично. Тип `custom` и причина `requires_action` есть, токен работы может слать события. Нет правил имени, запрета `mcp__` и `ant__`, запрета `$ref` и лимита 256 | `packages/managed-agents-api/src/contracts/agent-input-components.ts:116`; `packages/managed-agents-api/src/contracts/session-events.ts:295` |
| MCP из песочницы | обёртка в `custom` или туннель | частично. Цикл агента в песочнице ходит в наш MCP-шлюз `/v1/oma/mcp-proxy/{session}` с токеном работы, секреты MCP в песочницу не попадают | `environment-work-session-token.ts:299` |
| Очередь в консоли: глубина, воркеры, стоп | есть в Claude Console | нет. Клиент API консоли умеет методы work, страниц нет | `apps/console/src/lib/managed-api.ts:514` |
| Вход воркера через IAM AWS | есть | нет | |

## 4. Что добавить

1. **Решить, где работает модель для своего сервера.** Сначала. Для бэк-офиса это главный случай: инструменты должны работать рядом с учётной системой в локальной сети точки, например с iiko или 1С, без открытых входящих портов. Сейчас такой путь в Node не замкнут. Есть два варианта. Первый как в CMA: сервер ведёт цикл агента и для `self_hosted`, а воркеру отдаёт только вызовы инструментов. Тогда подходят готовые `ant` и SDK-воркеры, их документация и инструкции площадок. Второй вариант оставляет наш цикл в воркере, тогда нужен свой воркер для Node в виде CLI. Первый вариант дешевле в поддержке, наш Work API уже совпадает с SDK.
2. **Запрет `file` и `github_repository` на своём сервере.** Сначала, правка маленькая. Без него сессия молча стартует без файлов, а агент ищет их по пути, которого нет. Ответ 400 с кодом `self_hosted_resources_unsupported_error`, то же для деплойментов.
3. **Проверка окружения при выпуске ключа.** Сначала, вместе с пунктом 2. Ключ `oma_env_` на чужое, облачное или несуществующее окружение сейчас выдаётся без ошибки.
4. **Консоль для своего сервера.** Потом, после пункта 1. Выбор «Свой сервер» при создании, кнопка «Выпустить ключ окружения» на карточке с показом ключа один раз, готовая команда запуска воркера.
5. **Панель очереди на карточке окружения.** Потом. Четыре числа из `work/stats`, список работ с состояниями и кнопка «Остановить». Оператору точки так видно, что компьютер с воркером выключен и сессии копятся.
6. **Правила для своих инструментов.** Потом. Имя до 128 знаков, запрет `mcp__` и `ant__`, запрет `$ref` и верхних `oneOf`, лимит 256. Это нужно всем агентам, не только своему серверу.
7. **Настройки синхронизации памяти.** Позже, зависит от пункта 1. Интервал и режим `log_only` для удалений.
8. **Вход через IAM AWS и инструкции площадок.** Не нужно. Мы не работаем на Claude Platform on AWS, а площадки вроде Modal или E2B бэк-офису на своём сервере не нужны.

## 5. Источники

- https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
- https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers
- https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-custom-tools
- https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-memory
- https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-operations
- https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-security
- https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-reference
- https://platform.claude.com/docs/en/api/beta/environments/work
- Справочник скилла claude-api: `shared/managed-agents-self-hosted-sandboxes.md`, `shared/managed-agents-api-reference.md`.
- Код: `platform/packages/managed-agents-api/src/routes/environment-work.ts`, `platform/packages/managed-agents-application/src/environment-work/`, `platform/packages/managed-agents-adapters-runtime/src/session-lifecycle-router.ts`, `environment-work-session-token.ts`, `platform/packages/managed-runtime-host/src/environment-worker.ts`, `platform/packages/auth/src/index.ts`, `platform/apps/main-node/src/modules/node-managed.ts`, `node-http.ts`, `platform/apps/console/src/pages/EnvironmentsList.tsx`, `EnvironmentDetail.tsx`, `ApiKeysList.tsx`.
