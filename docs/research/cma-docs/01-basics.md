# CMA, раздел 1: основы и API

Разбор шести страниц документации Claude Managed Agents (CMA) и сверка с нашей копией Open Managed Agents в `platform/`. Пути в разделе 3 даны от `platform/`. Код Pi оставлен, области ACP, карточек harness и моста CLI не разбирались: их сейчас удаляют.

## 1. Коротко

- CMA даёт готовый цикл агента на серверах Anthropic. В нём четыре сущности: агент, окружение, сессия и события.
- Агента создают один раз. Каждая правка, которая что-то меняет, даёт новую версию. Сессия берёт последнюю версию или закреплённую.
- Все пути CMA требуют заголовок `anthropic-beta: managed-agents-2026-04-01`. У хранилищ памяти свой заголовок `agent-memory-2026-07-22`. Files и Skills вышли из беты.
- Наш API повторяет пути, тела и коды CMA почти один в один. Сверху есть свои расширения: блок `_oma`, разархивация, удаление агента, `If-Match` с кодом 412.
- Главные расхождения. Экспорт curl в мастере не шлёт бета-заголовок и получит 400. Правка без изменений всё равно поднимает версию. Правка `model` без `effort` теряет effort. Код 409 у нас другого типа, `request_id` нет. Лимитов частоты на `/v1` нет. Files и Skills требуют старые бета-заголовки.
- В консоли сессию создают без закреплённой версии, бюджета и переопределений, хотя API это умеет.

## 2. Страницы

### 2.1 Обзор (overview)

Страница сравнивает два пути. Messages API даёт прямой доступ к модели, свой цикл пишете сами. CMA даёт готовый цикл, песочницу и запуск инструментов, подходит для долгих фоновых задач.

| Сущность | Что это |
|---|---|
| Агент | модель, системный промпт, инструменты, MCP-серверы, навыки |
| Окружение | где идут сессии: облачная песочница Anthropic или своя (`self_hosted`) |
| Сессия | запущенный агент в окружении, делает одну задачу |
| События | сообщения между приложением и агентом: ходы пользователя, результаты инструментов, статусы |

Порядок работы: создать агента, создать окружение, начать сессию, слать события и читать ответ через SSE, при нужде поправить курс новым сообщением или прервать. История событий хранится на сервере, её можно забрать целиком.

Встроенные инструменты: bash, работа с файлами (read, write, edit, glob, grep), веб-поиск и загрузка страниц со списками разрешённых и запрещённых доменов, MCP-серверы.

Доступ включён всем аккаунтам по умолчанию, нужен ключ и бета-заголовок. SDK ставит заголовок сам. MCP-туннели и dreaming идут отдельным закрытым превью, доступ по заявке. CMA хранит историю и файлы, поэтому не входит в ZDR и HIPAA BAA. Сессии и файлы можно удалить через API.

### 2.2 Быстрый старт (quickstart)

Ставят CLI `ant` (пример с версией 1.42.0) и SDK, ключ кладут в `ANTHROPIC_API_KEY`. Каждый запрос несёт `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-beta: managed-agents-2026-04-01`, `content-type: application/json`.

| Шаг | Запрос | Главные поля тела | Что сохранить |
|---|---|---|---|
| 1. Агент | `POST /v1/agents` | `name`, `model`, `system`, `tools: [{type: "agent_toolset_20260401"}]` | `id`, `version` |
| 2. Окружение | `POST /v1/environments` | `name`, `config: {type: "cloud", networking: {type: "limited", allow_package_managers: true}}` | `id` |
| 3. Сессия | `POST /v1/sessions` | `agent`, `environment_id`, `title` | `id` |
| 4. Поток | `GET /v1/sessions/{id}/events/stream` | нет | события |
| 5. Сообщение | `POST /v1/sessions/{id}/events` | `events: [{type: "user.message", content: [{type: "text", text}]}]` | нет |

Поток открывают до отправки сообщения. Клиент печатает текст из `agent.message`, имя инструмента из `agent.tool_use` и выходит на `session.status_idle`. Сервер при первом сообщении готовит песочницу, крутит цикл, запускает инструменты, шлёт события и уходит в `idle`. При сети `limited` с пустым `allowed_hosts` веб-поиск и загрузка страниц ничего не вернут. Через CLI агента описывают файлом Markdown с YAML-шапкой, окружение файлом YAML, а `ant apply` пишет их ID в `claude-lock.json`.

### 2.3 Настройка агента (agent-setup)

Агент хранит модель, промпт, инструменты, MCP-серверы и навыки. Пределы взяты из справочника скилла claude-api.

| Поле | Обязательно | Тип и пределы |
|---|---|---|
| `name` | да | строка, 1..256 символов |
| `model` | да | строка ID или объект `{id, speed, effort, inference_geo}`, модели Claude 4.5 и новее |
| `system` | нет | строка до 100 000 символов |
| `tools` | нет | до 128: `agent_toolset_20260401`, `mcp_toolset`, `custom` |
| `mcp_servers` | нет | до 20, имена уникальны |
| `skills` | нет | до 20, `anthropic` или `custom` с `version` |
| `multiagent` | нет | тип `multiagent_20261001`: подагенты, динамические workflow, советник |
| `description` | нет | строка до 2048 символов |
| `metadata` | нет | до 16 пар, ключ до 64, значение до 512 символов |

Ответ повторяет конфиг и добавляет `id`, `type: "agent"`, `version` (с 1), `created_at`, `updated_at`, `archived_at`. Пропущенные поля модели сервер заполняет: `effort: {type: "medium"}`, `speed: "standard"`. У набора инструментов виден `default_config.permission_policy: always_allow`.

Поля модели. `effort` принимает `low`, `medium`, `high`, `xhigh`, `max` или объект `{type}`. `speed: "fast"` работает на Opus 5.5, Opus 5 и Opus 4.8. `inference_geo` принимает `us` или `global`. Сервер сверяет его с `allowed_inference_geos` рабочей области при сохранении агента, при создании сессии и на каждом ходе. Модель без такой поддержки даёт 400. В multiagent у всех агентов значение одно или у всех пусто.

Для одной сессии можно заменить `model`, `system`, `tools`, `mcp_servers`, `skills` формой `agent_with_overrides`. Замена `model` меняет объект целиком, effort агента не переносится.

Правка идёт через `POST /v1/agents/{id}`. Поле `version` необязательно, при передаче оно не меньше 1. Несовпадение даёт 409 даже при одинаковых полях. Без `version` побеждает последняя запись. Правку архивного агента сервер отклоняет. Правила слияния:

- пропущенные поля остаются как были;
- `name`, `model`, `system`, `description` заменяются; `system` и `description` чистятся через `null`, `name` и `model` очистить нельзя;
- внутри `model` при том же `id` пропущенный `effort` сохраняется, при новом `id` сбрасывается к умолчанию; `model` без `inference_geo` снимает привязку к региону;
- массивы `tools`, `mcp_servers`, `skills` заменяются целиком, `null` или `[]` их чистит;
- `multiagent` с тем же типом сливается по уровням, список `predefined_agents` заменяется; `null` чистит весь блок;
- `metadata` сливается по ключам, `null` у ключа его удаляет;
- правка без изменений не создаёт версию и возвращает текущую;
- агенты, которые ссылаются на этого в `predefined_agents`, остаются на старой версии.

Жизненный цикл. `GET /v1/agents/{id}/versions` отдаёт всю историю постранично. `POST /v1/agents/{id}/archive` делает агента только для чтения навсегда: идущие сессии работают, новые на него сослаться не могут. Удаления у агента нет.

### 2.4 Сборка в консоли (onboarding)

Консоль Anthropic ведёт по полям агента: модель и промпт в широком редакторе, MCP-серверы по URL с входом, набор инструментов и MCP-инструменты, навыки Anthropic и своей организации. Рядом консоль показывает такой же запрос API, его можно скопировать. Тестовую сессию запускают тут же: шлют сообщения и смотрят поток событий. Потом копируют ID агента и окружения в код и создают сессии через `POST /v1/sessions`.

Справочник скилла добавляет две вещи. Трасса сессии открывается по адресу `https://platform.claude.com/workspaces/{workspace}/sessions/{id}`. Команда Claude Code `/claude-api managed-agents-onboard` проводит опрос в четыре шага: описать задачу, агент, окружение, сессия.

### 2.5 Миграция (migration)

С цикла на Messages API уходит почти весь код:

| Было | Стало |
|---|---|
| массив истории передаётся каждый ход | история лежит в сессии |
| свой разбор `tool_use` и ответ `tool_result` | готовые инструменты идут в песочнице, свои инструменты через `agent.custom_tool_use` и `user.custom_tool_result` |
| своя песочница | песочница сессии |
| свой признак конца | событие `session.status_idle` |

Настройки веб-поиска и загрузки страниц (`allowed_domains`, `blocked_domains`, `max_content_tokens`, `user_location`) задают один раз в `configs` набора инструментов. Полей `max_uses`, `citations`, `cache_control` нет.

С Claude Agent SDK конфиг переезжает на сервер:

| Agent SDK | CMA |
|---|---|
| `ClaudeAgentOptions` на каждый запуск | `agents.create` один раз, версии на сервере |
| `ClaudeSDKClient` или `query` | `sessions.create` и события |
| функции `@tool` | `{type: "custom"}` на агенте, ответ клиента событием |
| встроенные инструменты в вашем процессе | `agent_toolset_20260401` в `/workspace` песочницы |
| `cwd`, `add_dirs` | файлы через Files API как `resources` |
| `system_prompt` и `CLAUDE.md` | одна строка `system`, сессию можно закрепить на версии |
| `mcp_servers` с ключами | серверы на агенте, ключи в хранилище секретов сессии |
| `permission_mode`, `can_use_tool` | `permission_policy`: `always_allow`, `always_ask`, `auto`, ответ `user.tool_confirmation` |

На клиента переходят режим плана (две сессии), стили вывода и слеш-команды, хуки (через `agent.custom_tool_use` или `always_ask`), подсчёт ходов вместо `max_turns`. Порядок переезда: окружение, агент, сессия с потоком, файлы как ресурсы, свои инструменты в цикл событий, тестовая сессия. Смена модели правит одно поле `model`. Поля `max_tokens` и `thinking` CMA ставит сам, префилла нет, JSON аргументов разбирает сервер.

### 2.6 Справочник (reference) и полный API

Имена событий идут по схеме `{домен}.{действие}`. Имена в вебхуках местами другие, например `session.status_idled`.

| Группа | Типы |
|---|---|
| user | `message`, `interrupt`, `custom_tool_result`, `tool_confirmation`, `define_outcome`, `tool_result` (только `self_hosted`) |
| agent | `message`, `thinking` (без текста мыслей), `tool_use`, `tool_result`, `mcp_tool_use`, `mcp_tool_result`, `custom_tool_use`, `thread_context_compacted`, `thread_message_received`, `thread_message_sent` |
| session | `status_running`, `status_idle` (с `stop_reason`), `status_rescheduled`, `status_terminated`, `deleted`, `updated`, `error` (с `retry_status`), `usage`, `thread_created`, `thread_status_*` (4 типа) |
| workflow_run | `created`, `status_running`, `status_idle`, `status_ended`, `error`, `phase_started`, `phase_ended` |
| span | `model_request_start`, `model_request_end` (с `model_usage`), `outcome_evaluation_start`, `_ongoing`, `_end` |
| system | `message`, только на части моделей |
| дельты | `event_start`, `event_delta`, только в потоке по `event_deltas[]`, в историю не пишутся |

В ответах агента может прийти блок `{"type": "redacted"}`, в событии пользователя он даёт 400. MCP-серверы подключают по streamable HTTP, старый SSE работает через запасной путь, закрытые серверы идут через MCP-туннели.

Лимиты частоты на организацию: создание 300 запросов в минуту, чтение 1200. Справочник скилла даёт старые числа: прочие операции 600, окружения 60 в минуту и 5 одновременно. При превышении 429 и заголовок `retry-after`. Бренд: можно «Claude Agent», «Claude» внутри меню «Agents», «{Имя} Powered by Claude»; нельзя «Claude Code», «Claude Cowork» и похожий на Claude Code вид.

Ошибки (из справочника скилла). Тело `{type: "error", error: {type, message}, request_id}`. Коды: 400 `invalid_request_error`, 401 `authentication_error`, 403 `permission_error`, 404 `not_found_error`, 409 тоже `invalid_request_error`, 413 `request_too_large`, 429 `rate_limit_error`, 500 `api_error`, 529 `overloaded_error`. Пагинация: `limit`, `page`, `order` в запросе, `next_page` в ответе, `prev_page` есть только у `GET /v1/sessions`.

Сессия при создании принимает `agent` (строка, `{type: "agent", id, version}` или `agent_with_overrides`), `environment_id`, `title`, `resources`, `initial_events` (до 50, только `user.message` и `user.define_outcome`), `vault_ids` (только при создании), `budget` (`{type: "limit", max_list_cost: {amount, currency: "USD"}}`, сумма в центах строкой), `metadata`. В объекте сессии есть `status` (`idle`, `running`, `rescheduling`, `terminated`), `usage`, `stats`, `budget`, `metadata` до 8 ключей.

| Ресурс | Эндпоинты |
|---|---|
| Агенты | `GET`, `POST /v1/agents`; `GET`, `POST /v1/agents/{id}`; `POST .../archive`; `GET .../versions` |
| Сессии | `GET`, `POST /v1/sessions`; `GET`, `POST`, `DELETE /v1/sessions/{id}`; `POST .../archive` |
| События | `GET`, `POST /v1/sessions/{id}/events`; `GET .../events/stream` |
| Потоки сессии | `GET .../threads`; `GET .../threads/{tid}`; `POST .../archive`; `GET .../events`; `GET .../stream` |
| Ресурсы сессии | `GET`, `POST .../resources`; `GET`, `POST`, `DELETE .../resources/{rid}` |
| Окружения | `POST`, `GET /v1/environments`; `GET`, `POST`, `DELETE /{id}`; `POST /{id}/archive`; `GET /{id}/work/stats`; `POST /{id}/work/{wid}/stop` |
| Деплойменты | `POST /v1/deployments`; `POST /{id}`; `POST /{id}/pause`, `/unpause`, `/archive`, `/run` |
| Запуски деплойментов | `GET /v1/deployment_runs?deployment_id=`; `GET /{id}` |
| Хранилища секретов | `POST`, `GET /v1/vaults`; `GET`, `POST`, `DELETE /{id}`; `POST /{id}/archive`; credentials так же плюс `mcp_oauth_validate` |
| Память | `memory_stores` CRUD и `archive`; `memories` CRUD (правка через `PATCH`); `memory_versions` список, чтение, `redact` |
| Files | `POST`, `GET /v1/files`; `GET /{id}`; `GET /{id}/content`; `DELETE /{id}` |
| Skills | `POST`, `GET /v1/skills`; `GET`, `DELETE /{id}`; `POST`, `GET /{id}/versions`; `GET`, `DELETE /{id}/versions/{v}` |

## 3. Как у нас

| Возможность | В CMA | У нас | Где |
|---|---|---|---|
| Бета-заголовок на всех путях | обязателен | есть и работает | `packages/managed-agents-api/src/beta.ts:4`, `:12`; `routes/agents.ts:66` |
| Files и Skills без беты | вышли из беты | частично: без `files-api-2025-04-14` и `skills-2025-10-02` сервер даёт 400 | `routes/files.ts:28`, `routes/skills.ts:47` |
| Список, чтение, создание, правка агента | есть | есть и работает | `routes/agents.ts:67`, `:99`, `:243`, `:284`; `apps/main-node/src/modules/node-http.ts:383` |
| Версия по `?version=N` и список версий | есть | есть и работает | `routes/agents.ts:100`, `:131` |
| `version` при правке, 409 | есть | есть и работает | `packages/managed-agents-application/src/agents/application.ts:577` |
| Отказ в правке архивного агента | есть | есть и работает | `application.ts:572` |
| Правка без изменений не даёт версию | есть | нет: версия растёт всегда | `application.ts:661` |
| `effort` сохраняется при том же `model.id` | есть | нет: `model` заменяется целиком | `application.ts:114` |
| `effort` и `speed` в модели | есть | есть и работает, `inference_geo` только хранится | `contracts/agents.ts:117`; `apps/agent/src/harness/pi-provider.ts:189` |
| Слияние `metadata`, пределы 16, 64, 512 | есть | есть и работает | `application.ts:323`, `:336` |
| Пределы name, system, description, tools, skills | есть | частично: проверены только 20 MCP-серверов и уникальность имён | `contracts/agents.ts:187`; `application.ts:356` |
| Архив агента | есть, навсегда | есть и работает, плюс своя разархивация | `routes/agents.ts:164`, `:192` |
| Удаление агента | нет | есть и работает (наше расширение, с отчётом о зависимостях) | `routes/agents.ts:215` |
| `multiagent` | `multiagent_20261001` | частично: только старая форма `coordinator` | `contracts/agent-input-components.ts:168` |
| `permission_policy` | `always_allow`, `always_ask`, `auto` | частично: нет `auto` | `contracts/agent-input-components.ts:14` |
| Настройки веб-инструментов в `configs` | есть | есть и работает | `contracts/agent-input-components.ts:53` |
| Сессия: три формы `agent`, `budget`, `initial_events` | есть | есть и работает, предел 50 событий не проверяется | `contracts/sessions.ts:117`; `sessions/application.ts:339` |
| `vault_ids` только при создании | правку отклоняет | частично: правка проходит | `contracts/sessions.ts:156`; `sessions/application.ts:491` |
| Правка `tools` сессии только в `idle` | есть | есть и работает | `sessions/application.ts:466` |
| Пагинация, `prev_page` у сессий | есть | есть и работает | `routes/sessions.ts:53`; `routes/agents.ts:55` |
| Тело ошибки и тип 409 | `invalid_request_error`, `request_id` | частично: 409 как `conflict_error`, нет `request_id` | `packages/managed-agents-api/src/errors.ts:75` |
| Лимиты частоты 300 и 1200, `retry-after` | есть | нет: на `/v1` только метрики, трассировка, вход | `node-http.ts:167`, `:307` |
| Типы событий | около 45 | частично: нет `workflow_run.*`, есть свой `session.warning` | `contracts/session-events.ts:419` |
| Консоль: форма агента и вид кода | показывает запрос API | есть и работает: форма, YAML, JSON | `apps/console/src/pages/agents/AgentFormDialog.tsx:360` |
| Консоль: версии и откат | есть в API | есть и работает | `apps/console/src/pages/AgentDetail.tsx:65`, `:139`; `pages/agents/restore-version.ts:25` |
| Консоль: тестовая сессия рядом с агентом | есть | частично: мастер создаёт сессию, в карточке агента кнопки нет | `pages/quickstart/QuickstartWizard.tsx:176`; `pages/AgentDetail.tsx:190` |
| Консоль: экспорт в код | копировать ID | частично: curl без `anthropic-beta`, сервер вернёт 400 | `apps/console/src/lib/quickstart.ts:83` |
| Консоль: создание сессии | версия, бюджет, переопределения через API | частично: только агент строкой, окружение, title, хранилища, ресурсы | `apps/console/src/pages/SessionsList.tsx:329` |
| Файлы агента и `ant apply` | есть | нет | нет |

## 4. Что добавить

1. Сначала. Добавить `anthropic-beta: managed-agents-2026-04-01` в `exportSnippet`. Сейчас скопированная команда падает с 400, первый шаг из консоли в код ломается.
2. Сначала. Не поднимать версию, если правка ничего не меняет. Иначе каждое «Сохранить» без правок плодит версии, история и откат в бэк-офисе становятся шумными.
3. Сначала. Сохранять `effort` при том же `model.id`. Сейчас правка модели из формы молча сбрасывает уровень рассуждений, агент начинает отвечать иначе.
4. Сначала. Принимать Files и Skills без старых бета-заголовков. Свежий SDK и внешние скрипты их не шлют и получают 400.
5. Потом. Проверять пределы CMA: name 256, system 100 000, description 2048, tools 128, skills 20, `initial_events` 50, метаданные сессии 8 ключей. Без них сломанный конфиг доходит до запуска.
6. Потом. Отклонять `vault_ids` в правке сессии. Так ведёт себя CMA, клиенты на SDK ждут этой ошибки.
7. Потом. В форме создания сессии дать закрепить версию агента, бюджет и метаданные. Бэк-офису нужен откат на проверенную версию и потолок трат на сессию.
8. Потом. Кнопка «Начать тестовую сессию» в карточке агента, как в консоли Anthropic.
9. Позже. Лимиты частоты на `/v1` с 429 и `retry-after`. Важно при внешних ключах API, в одной команде можно отложить.
10. Позже. Тип 409 как `invalid_request_error` и `request_id` в ошибках. Нужно для разбора жалоб и для клиентов, которые проверяют тип.
11. Позже. Политика `auto` и форма `multiagent_20261001`. Это свои большие куски, их разбирают разделы про инструменты и мультиагентность.
12. Не нужно. `ant apply` и `claude-lock.json`: у нас конфиг правят в консоли и через ассистента. `inference_geo`: модели идут через наши карточки, регион Anthropic не важен.

## 5. Источники

- https://platform.claude.com/docs/en/managed-agents/overview
- https://platform.claude.com/docs/en/managed-agents/quickstart
- https://platform.claude.com/docs/en/managed-agents/agent-setup
- https://platform.claude.com/docs/en/managed-agents/onboarding
- https://platform.claude.com/docs/en/managed-agents/migration
- https://platform.claude.com/docs/en/managed-agents/reference
- Справочники скилла claude-api: `managed-agents-overview.md`, `managed-agents-core.md`, `managed-agents-api-reference.md`, `managed-agents-onboarding.md` (пределы полей, ошибки, пагинация, полный список эндпоинтов).
