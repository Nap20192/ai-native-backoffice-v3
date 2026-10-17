# CMA, раздел 3: сессии и события

Разбор семи страниц документации Claude Managed Agents (CMA) про сессии, события, поток SSE, дельты, потоки подагентов, бюджеты и наблюдаемость. Сверка с нашей копией Open Managed Agents в `platform/`. Пути в разделе 3 даны от `platform/`. Код Pi оставлен, области ACP, карточек harness и моста CLI не разбирались: их сейчас удаляют.

## 1. Коротко

- Сессия в CMA это запуск агента в окружении. Её создают одним запросом и запускают первым `user.message`. Оба шага можно слить в один через `initial_events`.
- Статусов четыре: `idle`, `running`, `rescheduling`, `terminated`. Сессия, которая закончила работу, стоит в `idle`. `terminated` бывает после архива или неисправимой ошибки.
- Всё общение идёт событиями. Клиент шлёт `user.*` и `system.message`, сервер отдаёт `session.*`, `span.*` и `agent.*`. Поток SSE отдаёт только новые события, поэтому после обрыва клиент сам дочитывает историю.
- Дельты `event_start` и `event_delta` показывают текст ответа, пока модель пишет. Они не хранятся, итог всегда в `agent.message`.
- В мультиагентной сессии есть потоки: основной и до 25 дочерних. У каждого свой поток событий, своё прерывание и свой архив.
- Бюджет это жёсткий потолок трат в центах по публичным ценам. На потолке сессия встаёт в `idle` с причиной `budget_reached` и ждёт, пока бюджет поднимут или снимут.
- У нас API повторён почти целиком: пути, схемы, SSE, дельты, потоки, консоль с инспектором. Не работают бюджет и стоимость, статус `terminated`, прерывание одного потока и дочитывание истории после обрыва потока в консоли.

## 2. Страницы

Все семь страниц помечены как бета и требуют заголовок `anthropic-beta: managed-agents-2026-04-01`.

### 2.1 Запуск сессии (sessions)

Страница учит создать сессию и дать ей первую задачу.

| Что | Подробности |
|---|---|
| Запрос | `POST /v1/sessions`, обязательны `agent` и `environment_id` |
| Формы `agent` | строка ID берёт последнюю версию; `{type: "agent", id, version}` закрепляет версию; `{type: "agent_with_overrides", id, version?, ...}` меняет поля на одну сессию |
| Переопределения | `model`, `system`, `tools`, `mcp_servers`, `skills`. Значение заменяет поле целиком. `null` очищает поле, кроме `model` (ошибка `agent_model_required`). Агент и его версии не меняются |
| `initial_events` | до 50 событий `user.message` и `user.define_outcome`. Непустой список создаёт сессию сразу в `running`. Проверка идёт по принципу всё или ничего |
| `budget` | `{type: "limit", max_list_cost: {amount: "125", currency: "USD"}}`, задаётся только при создании |
| `vault_ids` | хранилища секретов для MCP с OAuth, токены обновляет Anthropic |

Создание отклоняется с 400, если в `initial_events` два `user.define_outcome`, outcome без `rubric` или больше 100 файловых документов. Тело больше 32 МБ даёт 413. Без `initial_events` сессия стоит в `idle`, а песочница уже готовится, чтобы первый вызов инструмента не ждал. Первая задача уходит через `POST /v1/sessions/{id}/events`.

### 2.2 Операции с сессией (session-operations)

| Операция | Запрос | Условия и детали |
|---|---|---|
| Получить | `GET /v1/sessions/{id}` | |
| Список | `GET /v1/sessions` | `limit`, курсоры `next_page` и `prev_page` в параметре `page`, `order` asc или desc (по умолчанию desc), фильтры `agent_id`, `created_at`. Курсор помнит `order`, его смена даёт 400 |
| Правка | `POST /v1/sessions/{id}` | `title`, `metadata`; `agent.tools` и `agent.mcp_servers` только в `idle`, массив заменяется целиком; `budget` изменить или снять |
| Архив | `POST /v1/sessions/{id}/archive` | `running` нельзя, сначала `user.interrupt`. История остаётся, новые события не принимаются |
| Удаление | `DELETE /v1/sessions/{id}` | `running` нельзя. Удаляет запись, события, песочницу и файлы, которые создала сессия. Агенты, окружения, хранилища не трогает |

| Статус | Смысл |
|---|---|
| `idle` | ждёт ввода: сообщения, подтверждения инструмента или нового бюджета |
| `running` | агент работает |
| `rescheduling` | временная ошибка, сервер повторяет сам |
| `terminated` | конец: неисправимая ошибка или архив |

Ошибки приходят событием `session.error`, а не статусом. Модель, `system` и `skills` в середине сессии не меняются. Дописать системный контекст можно событием `system.message`.

### 2.3 Поток событий (events-and-streaming)

Три запроса: `GET /v1/sessions/{id}/events/stream` отдаёт SSE, `POST /v1/sessions/{id}/events` принимает `{events: [...]}`, `GET /v1/sessions/{id}/events` отдаёт историю с курсором и фильтром `types[]`.

| Откуда | Типы событий |
|---|---|
| Клиент | `user.message`, `user.interrupt`, `user.tool_confirmation` (`tool_use_id`, `result` allow или deny), `user.custom_tool_result` (`custom_tool_use_id`), `user.tool_result`, `user.define_outcome`, `system.message` |
| Сервер, статусы | `session.status_running`, `session.status_idle` (с `stop_reason`), `session.status_rescheduled`, `session.status_terminated`, `session.updated`, `session.usage`, `session.error` |
| Сервер, агент | `agent.message`, `agent.thinking` (без текста мыслей), `agent.tool_use`, `agent.tool_result`, `agent.mcp_tool_use`, `agent.mcp_tool_result`, `agent.custom_tool_use`, `agent.thread_context_compacted` |
| Сервер, спаны | `span.model_request_start`, `span.model_request_end` (с `model_usage`), `span.outcome_evaluation_start`, `_ongoing`, `_end` |
| Сервер, потоки | `session.thread_created`, `session.thread_status_running`, `_idle`, `_rescheduled`, `_terminated`, `agent.thread_message_sent`, `agent.thread_message_received` |

| `stop_reason.type` | Почему встала | Что делать |
|---|---|---|
| `end_turn` | агент закончил ход или его прервали | слать `user.message` |
| `requires_action` | ждёт ответа на вызовы из `stop_reason.event_ids` | ответить на каждый вызов |
| `budget_reached` | потрачен бюджет | поднять или снять бюджет |

Правила, которые важны клиенту:

- Поток отдаёт только события после открытия. Сначала открыть поток, потом слать. Для переподключения открыть новый поток, прочитать всю историю, пропускать уже виденные `id`.
- У каждого события есть `processed_at`. У событий клиента он `null`, пока событие стоит в очереди. `user.tool_result`, `user.custom_tool_result` и `user.define_outcome` сервер обрабатывает сразу.
- Прерывание: `user.interrupt`, затем `user.message` с новой задачей. Ответ модели обрывается сразу, работающие инструменты могут задержать остановку. Ход кончается `session.status_idle` с `end_turn`, своей причины для прерывания нет.
- Результат своего инструмента можно слать сразу после `agent.custom_tool_use`, не дожидаясь `idle`. Повторный ответ ничего не ломает.
- `system.message` несёт от 1 до 1000 текстов и дописывается к системному контексту. Работает только на части моделей, иначе ошибка `model_does_not_support_mid_conversation_system`. При `requires_action` его шлют только вместе с результатом инструмента.
- При каждом `idle` сервер сохраняет снимок песочницы. Снимок живёт 30 дней с создания песочницы.
- Вебхуки называют события иначе, например `session.status_idled`.

### 2.4 Дельты (event-deltas)

- Включаются на одно соединение параметром `event_deltas[]` со значениями `agent.message` и `agent.thinking`. Другое значение или больше 100 значений дают 400. Параметр принимают `/events/stream` и `/threads/{tid}/stream`.
- Сначала приходит `event_start` с `event: {type, id}`. Потом `event_delta` с `event_id` и `delta: {type: "content_delta", index, content: {type: "text", text}}`. Для `agent.thinking` приходит только `event_start`.
- Порядок в ходе: `session.status_running`, `span.model_request_start`, `event_start`, дельты, `agent.message`, `span.model_request_end`.
- Клиент копит текст по паре (`event_id`, `index`). Когда придёт `agent.message` с тем же `id`, черновик выбрасывают и рисуют итог. На `span.model_request_end` закрывают все незакрытые черновики.
- Ограничения: под нагрузкой сервер может бросить дельты, тогда остаётся начало текста. Повтора после переподключения нет. Видны только текст и только поток, который читает соединение. В истории дельт нет.
- Формат отличается от Messages API: тип `content_delta`, а не `content_block_delta`, нет событий начала и конца блока.

### 2.5 Потоки сессии (session-threads)

Основной поток это поток сессии `/events/stream`. В нём видны начало и конец работы подагентов и их блокирующие запросы. Детали работы подагента лежат в его собственном потоке. Статус сессии сводный: если хоть один поток `running`, сессия тоже `running`.

| Запрос | Что делает |
|---|---|
| `GET /v1/sessions/{id}/threads` | список с основным потоком, фильтр `statuses[]` |
| `GET /v1/sessions/{id}/threads/{tid}` | поток с `agent`, `status`, `parent_thread_id`, `stats`, `usage` |
| `POST /v1/sessions/{id}/threads/{tid}/archive` | только для `idle`, поток в `requires_action` тоже считается `idle` |
| `GET /v1/sessions/{id}/threads/{tid}/events` | история потока |
| `GET /v1/sessions/{id}/threads/{tid}/stream` | SSE потока, принимает `event_deltas[]` |

- У основного потока `parent_thread_id` равен `null`. Одновременно живут не больше 25 дочерних, архив освобождает место. Потоки советника (advisor) и workflow run в лимит не входят.
- `user.interrupt` с `session_thread_id` останавливает один поток. Без поля встают все неархивные потоки. Поток в `requires_action` закрывает ожидающие вызовы ошибкой и сразу уходит в `idle` с `end_turn`. На `idle` потоке прерывание ничего не делает, на `terminated` даёт 400.
- Запросы подтверждения и вызовы своих инструментов подагента сервер копирует в основной поток с `session_thread_id`. Ответ сервер сам отправит в нужный поток. Копии сравнивают по `tool_use_id`, у них разные `id`.
- События основного потока: `session.thread_created` (`session_thread_id`, `agent_name`), `session.thread_status_*`, `agent.thread_message_received` (`from_session_thread_id`, `from_agent_name`, `content`), `agent.thread_message_sent` (`to_session_thread_id`, `to_agent_name`, `content`).

### 2.6 Бюджеты (budgets)

- Поле `budget`: `type` всегда `limit`, `max_list_cost.amount` это целые центы строкой без ведущих нулей и больше нуля, `currency` только `USD`.
- В расход идут токены по прайсу модели, веб-поиск по 10 USD за 1000 запросов и время работы по 0,08 USD в час. Это публичный прайс, не договорная цена.
- Сервер проверяет расход перед каждым запросом к модели. Запрос, который перешёл потолок, доходит до конца, поэтому итог бывает чуть выше потолка.
- На потолке идут события по порядку: `session.thread_status_idle` с `budget_reached` для каждого потока, `session.usage`, `session.status_idle` с `budget_reached`.
- На потолке сессия принимает только закрывающие события: `user.tool_confirmation`, `user.tool_result`, `user.custom_tool_result`, `user.interrupt`. На `user.message` будет 400.
- Чтобы продолжить, шлют `POST /v1/sessions/{id}` с новым бюджетом выше потраченного или с `budget: null`. Работа продолжается сама. Снять бюджет можно один раз, вернуть нельзя. Добавить бюджет сессии, созданной без него, тоже нельзя.
- В мультиагенте один бюджет на все потоки. Если один поток ждёт `requires_action`, а другой встал на бюджете, сессия показывает `requires_action`.
- Деплоймент копирует свой бюджет в каждую сессию. Агент с моделью без публичной цены и бюджетом не создаётся, ответ 400.

| Ошибка 400 | Когда |
|---|---|
| событие новой работы на потолке | например `user.message` |
| бюджет не выше потраченного | при правке |
| бюджет у сессии без бюджета | при правке, в том числе после снятия |
| неверная сумма или валюта | `"25.00"`, ноль, минус, не `USD` |
| модель без прайса | при создании с бюджетом |

### 2.7 Наблюдаемость (session-observability)

В Console Anthropic есть страница сессий: статус, агент, токены, стоимость, время создания. Просмотр сессии состоит из трёх частей. Мини-карта показывает время работы, по дорожке на поток. Лента группирует события по запросам к модели, события можно фильтровать и скачать в JSON. Инспектор имеет вкладки Session, Events, Tools, Resources и Threads. Параметр `?event={id}` открывает сессию на нужном событии.

| Поле `usage` | Что значит |
|---|---|
| `input_tokens`, `output_tokens` | входные без кэша и выходные токены за всю сессию |
| `cache_read_input_tokens` | токены из кэша |
| `cache_creation` | запись в кэш: `ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens` |
| `list_cost` | расход по прайсу, `{amount, currency}`, целые центы |
| `active_seconds` | время, когда работал хотя бы один поток, пересечения считаются один раз |
| `server_tool_use` | `web_search_requests`, `web_fetch_requests` (всегда 0) |

`stats.active_seconds` складывает время всех потоков, поэтому он больше `usage.active_seconds`. Событие `session.usage` несёт тот же снимок и приходит перед каждым `idle`. У потока свой `usage` с `list_cost` и `active_seconds`, сумма по потокам не равна сумме сессии. `span.model_request_end` несёт `model_usage` одного запроса.

## 3. Как у нас

| Возможность | В CMA | У нас | Где |
|---|---|---|---|
| Создание: три формы `agent`, `initial_events`, `vault_ids` | есть | есть и работает, предел 50 событий не проверяется | `packages/managed-agents-api/src/routes/sessions.ts:271`; `contracts/sessions.ts:117`; `packages/managed-agents-application/src/sessions/application.ts:199`, `:339` |
| Список: курсоры, `order`, `statuses[]`, `agent_id`, архив | есть | есть и работает | `routes/sessions.ts:67`; `apps/console/src/pages/SessionsList.tsx:57`, `:147` |
| Статус `rescheduling` | есть | есть и работает | `apps/main-node/src/lib/node-managed-session-runner.ts:594` |
| Статус `terminated` | после архива и ошибки | частично: есть в схеме и фильтре, но Node не шлёт `session.status_terminated`, архив пишет только `archived_at` | `packages/managed-agents-application/src/session-execution/application.ts:25`; `packages/session-store-sql/src/index.ts:237` |
| Правка `tools` и `mcp_servers` только в `idle` | есть | есть и работает | `sessions/application.ts:469` |
| Архив | только из `idle`, ставит `terminated` | частично: сам останавливает ход, статус не меняет, есть своя разархивация | `sessions/application.ts:541`; `routes/sessions.ts:172`, `:200` |
| Удаление | только из `idle` | есть и работает, ход останавливается сам | `routes/sessions.ts:139`; `sessions/application.ts:617` |
| Отправка событий `user.*` и `system.message` | есть | есть и работает, плюс `Idempotency-Key` и `If-Match` | `routes/session-events.ts:178`; `contracts/session-event-inputs.ts:110` |
| SSE `/events/stream` | есть | есть и работает, `ping` раз в 10 с | `routes/session-events.ts:34`, `:100`; `apps/main-node/src/modules/node-http.ts:412` |
| История с `types[]` | есть | есть и работает | `routes/session-events.ts:42` |
| Переподключение без потерь | поток плюс история | частично: консоль открывает поток заново, историю не перечитывает | `apps/console/src/pages/SessionDetail.tsx:818`, `:849` |
| Дельты `event_start`, `event_delta` | есть | есть и работает | `apps/agent/src/harness/pi-loop.ts:305`; `apps/main-node/src/lib/node-managed-session-runtime.ts:785`; `SessionDetail.tsx:857` |
| Прерывание всей сессии | есть | есть и работает | `node-managed-session-runner.ts:375`; `apps/console/src/components/session/SessionHeader.tsx:327` |
| Прерывание одного потока | `session_thread_id` | частично: поле принимается, встаёт вся сессия | `contracts/session-event-inputs.ts:110`; `node-managed-session-runner.ts:375` |
| Причины `end_turn`, `requires_action` | есть | есть и работает, плюс своя `retries_exhausted` | `apps/main-node/src/lib/node-managed-stop-reason.ts:33` |
| Причина `budget_reached` | есть | в коде, не подключено: тип есть, никто не ставит | `packages/managed-agents-domain/src/sessions/event.ts:160`; `contracts/session-events.ts:300` |
| Бюджет сессии | потолок, пауза, возобновление | в коде, не подключено: поле хранится, правка пускает бюджет сессии без бюджета | `contracts/sessions.ts:110`; `sessions/application.ts:332`, `:486` |
| Потоки: список, чтение, архив, история, SSE | есть | частично: нет `statuses[]`, предел 8 подагентов вместо 25 | `routes/session-threads.ts:46`, `:115`, `:191`; `contracts/session-threads.ts:11`; `apps/main-node/src/lib/node-managed-subagents.ts:115` |
| События потоков | есть | есть и работает | `node-managed-subagents.ts:170`, `:248`, `:295` |
| `usage`: токены и кэш | есть | есть и работает | `apps/main-node/src/lib/node-harness-usage.ts:52`; `apps/main-node/src/lib/node-managed-harness-runtime.ts:257` |
| `usage`: `list_cost`, `active_seconds`, `server_tool_use` | есть | нет: схема есть, сервер не заполняет | `contracts/sessions.ts:192`; `node-harness-usage.ts:58` |
| `stats.active_seconds` | есть | частично: сервер пишет пустой объект, консоль считает по событиям | `sessions/application.ts:338`; `apps/console/src/components/session/inspector/ThreadsTab.tsx:17` |
| `span.model_request_*` с `model_usage` | есть | есть и работает | `pi-loop.ts:291`, `:370` |
| Сжатие контекста | есть | есть и работает | `pi-loop.ts:267` |
| Просмотр: лента, мини-карта, инспектор, `?event=` | есть | есть и работает, без токенов и стоимости | `apps/console/src/components/session/inspector/SessionInspector.tsx:25`; `SessionDetail.tsx:307`; `inspector/SessionTab.tsx:21` |
| Трасса и экспорт OTLP | нет | есть и работает (наше расширение) | `node-http.ts:442`; `apps/console/src/lib/trace-api.ts:351` |
| Workflow runs, `workflow_run.*` | есть | нет | нет |

## 4. Что добавить

1. Сначала. В консоли после обрыва SSE перечитывать историю и пропускать виденные `id`. Сейчас после сбоя сети пропадают ответы и запросы подтверждения до перезагрузки страницы. Оператор может не увидеть вызов, который ждёт его решения.
2. Сначала. Ставить `terminated` при архиве и после `retries_exhausted`, отклонять события в архивную сессию. Сейчас фильтр «Остановлено» в списке всегда пуст, а в `sendSessionEvents` нет проверки архива (`packages/managed-agents-application/src/session-events/application.ts:166`).
3. Сначала. Показать токены в списке сессий и в инспекторе. Данные уже лежат в `usage`. Бэк-офису нужно видеть расход каждой сессии, даже если модели свои.
4. Потом. Включить бюджет: считать `list_cost` по ценам из карточек моделей, ставить `budget_reached`, на потолке пускать только закрывающие события, после правки бюджета продолжать ход. Это защита от агента, который зациклился и тратит токены всю ночь.
5. Потом. Прерывать один поток по `session_thread_id`. Так можно остановить зависшего подагента и не трогать основной поток.
6. Потом. Считать `active_seconds` и `stats` на сервере. Время работы нужно для отчётов и для цены по часам в бюджете.
7. Позже. Фильтр `statuses[]` у списка потоков, кнопка архива потока в консоли (клиент уже есть в `apps/console/src/lib/managed-api.ts:917`), предел подагентов в настройках.
8. Позже. Проверка предела 50 для `initial_events`. Без неё огромный список доходит до запуска.
9. Не нужно. Отказ архива и удаления в `running`: наша остановка хода перед записью удобнее оператору, её стоит описать как отличие. Workflow runs, советник и `inference_geo` пока не нужны: их нет в наших сценариях.

## 5. Источники

- https://platform.claude.com/docs/en/managed-agents/sessions
- https://platform.claude.com/docs/en/managed-agents/session-operations
- https://platform.claude.com/docs/en/managed-agents/events-and-streaming
- https://platform.claude.com/docs/en/managed-agents/event-deltas
- https://platform.claude.com/docs/en/managed-agents/session-threads
- https://platform.claude.com/docs/en/managed-agents/budgets
- https://platform.claude.com/docs/en/managed-agents/session-observability
- Справочники скилла claude-api: `managed-agents-core.md`, `managed-agents-events.md`, `managed-agents-api-reference.md` (поля объекта сессии, полный список событий, `model_usage`, эндпоинты потоков).
