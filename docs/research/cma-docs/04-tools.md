# CMA, раздел 4: инструменты, права, MCP, навыки

Разбор пяти страниц документации Claude Managed Agents (CMA) и сверка с нашей копией Open Managed Agents в `platform/`. Пути в разделе 3 даны от `platform/`. Код Pi оставлен, области ACP, карточек harness и моста CLI не разбирались: их сейчас удаляют.

## 1. Коротко

- У агента CMA три вида инструментов. Встроенный набор `agent_toolset_20260401` (8 штук), наборы MCP-серверов `mcp_toolset` и свои инструменты `custom`, которые запускает приложение.
- Права задаёт `permission_policy`: `always_allow`, `always_ask` и `auto`. Встроенный набор по умолчанию разрешён, MCP по умолчанию спрашивает человека.
- У `web_search` и `web_fetch` есть белый или чёрный список доменов, потолок текста страницы и место для поиска.
- MCP-сервер объявляют в агенте без секретов. Ключ приходит из хранилища (vault) при создании сессии и подбирается по URL.
- Навыки цепляют массивом `skills` (готовые `xlsx`, `docx`, `pptx`, `pdf` и свои) или находят сами в `.claude/skills` подключённого репозитория.
- У нас API принимает почти все поля CMA. Подтверждение вызовов `always_ask` работает от рантайма до консоли. Навыки и их версии есть, готовые четыре навыка лежат в `platform/skills/builtin`.
- Главные расхождения. MCP у нас по умолчанию `always_allow`. Списки доменов сохраняются, но рантайм их не применяет. Агент без встроенного набора всё равно получает bash. Политики `auto` нет. Сбой MCP идёт как `session.warning`, а не `session.error`.

## 2. Страницы

Все пять страниц в статусе beta и требуют заголовок `anthropic-beta: managed-agents-2026-04-01`. Skills API (`/v1/skills`) вышел из беты, ему заголовок не нужен.

### 2.1 Инструменты (tools)

Страница перечисляет встроенные инструменты, объясняет, как их включать и выключать, и как описать свой инструмент.

| Имя | Что делает |
|---|---|
| `bash` | команда в оболочке песочницы |
| `read`, `write`, `edit` | чтение файла, запись, замена строки |
| `glob`, `grep` | поиск файлов по шаблону, поиск текста по regex |
| `web_fetch`, `web_search` | загрузка страницы и веб-поиск, идут на серверах Anthropic, не в песочнице |

Поля набора:

- `type: "agent_toolset_20260401"`. Набор версионный, при смене инструментов выйдет новая дата.
- `default_config` задаёт базу для всех: `enabled` и `permission_policy`.
- `configs` правит один инструмент по `name`. Поле `type` в запросе можно не слать, в ответе оно есть всегда.
- Чтобы включить только нужное, ставят `default_config.enabled: false` и включают инструменты по одному.

Свой инструмент: `type: "custom"`, `name`, `description`, `input_schema`. Claude его не запускает. Сессия шлёт `agent.custom_tool_use` и встаёт в `idle`, приложение отвечает `user.custom_tool_result`. Имя не может начинаться с `mcp__` или `ant__` и не может совпасть со встроенным, иначе 400.

Лимиты. Вывод больше 100 000 символов (около 25 000 токенов) уходит в файл в песочнице, модель видит начало и путь. По справочнику SDK у агента до 128 инструментов. Документация советует описывать инструмент в три или четыре предложения и сводить похожие действия в один инструмент с параметром `action`.

### 2.2 Ограничения веба (tools web restrictions)

Страница объясняет, как ограничить, куда ходят `web_search` и `web_fetch`. Настройки лежат в записях `configs` встроенного набора.

| Поле | Смысл | Для кого |
|---|---|---|
| `allowed_domains` | только эти хосты | оба |
| `blocked_domains` | эти хосты нельзя | оба |
| `max_content_tokens` | потолок текста страницы в контексте, целое больше нуля | `web_fetch` |
| `user_location` | `type: "approximate"`, `country`, `timezone` и др. для местной выдачи | `web_search` |

Правила списков:

- в одной записи только один из двух списков;
- от 1 до 64 доменов, каждый до 255 символов. Пустой список запрещён, без ограничения поле не шлют или шлют `null`;
- домен покрывает себя и все поддомены. `www.` тоже поддомен, поэтому `www.example.com` не покрывает `example.com`;
- нельзя схему, порт, `*`, IP, голый TLD, имя из одного слова, не-ASCII (нужен Punycode), `localhost`, `.local`, `.internal`;
- у `web_search` можно суффикс пути (`example.com/blog`), у `web_fetch` нельзя.

Ошибки и поведение:

- нарушение формата даёт 400 `invalid_request_error` с номером домена в списке;
- запрет во время работы: `web_fetch` вернёт `agent.tool_result` с `is_error: true` и кодом `url_not_allowed`, `web_search` просто уберёт такие результаты;
- в облачном окружении с сетью `limited` действует и `allowed_hosts` окружения. Домен из `allowed_domains` вне `allowed_hosts` даёт 400 при создании сессии;
- если настройка стала неверной к старту, сессия шлёт `session.error` и уходит в `idle` без повтора;
- в мультиагенте белые списки пересекаются, чёрные складываются. Подагент может только сузить доступ;
- списки можно сменить у сессии в `idle` через правку её инструментов.

Отличия от Messages API: потолок 64 домена, у `web_fetch` нет путей, только ASCII, нет `max_uses`, `citations`, `cache_control`.

### 2.3 Политики прав (permission policies)

Страница объясняет, когда серверный инструмент (встроенный или MCP) идёт сам, а когда ждёт решения. Свои инструменты `custom` политики не касаются.

| Политика | Поведение | По умолчанию у |
|---|---|---|
| `always_allow` | вызов идёт сразу | встроенного набора |
| `always_ask` | сессия ждёт решения клиента | наборов MCP |
| `auto` | сервер сам решает: пустить, отказать или спросить | ни у кого |

Политику ставят в `default_config.permission_policy` набора или в `configs[].permission_policy` инструмента. Запущенные сессии держат прежние настройки, правка агента действует на новые сессии. Убрать инструмент совсем можно только через `enabled: false`.

Поток подтверждения:

1. Приходит `agent.tool_use` или `agent.mcp_tool_use` с `evaluated_permission: "ask"`.
2. Сессия шлёт `session.status_idle` с `stop_reason.type: "requires_action"` и списком `stop_reason.event_ids`. Ждёт без срока.
3. Клиент шлёт `user.tool_confirmation`: `tool_use_id`, `result` (`allow` или `deny`), при отказе можно `deny_message`. Несколько ответов можно послать одним запросом.
4. Когда ответы есть на все вызовы, сессия снова `running`. Отказ доходит до модели как результат с текстом отказа.

Подтверждение для вызова не в состоянии `ask` даёт 400.

Режим `auto`. Сервер смотрит на инструмент, вход и ход сессии. Опасный вызов он отклоняет (`reason_code: "high_risk"`), клиент это не отменит. Если не уверен, спрашивает (`reason_code: "indeterminate"`). Намерение сервер берёт только из `user.message`, не из страниц и ответов инструментов. Документация прямо пишет, что `auto` не заменяет проверку человеком.

Аудит. У каждого `agent.tool_use` и `agent.mcp_tool_use` есть `evaluated_permission` (`allow`, `ask`, `deny`) и объект `evaluation` с типом сработавшей политики. Вызов выключенного инструмента получает `deny` без `evaluation`.

### 2.4 MCP-коннектор (mcp connector)

Страница объясняет, как дать агенту инструменты внешнего MCP-сервера. Настройка в два шага.

1. В агенте массив `mcp_servers`: `type: "url"`, `name` (от 1 до 255 символов), `url` (до 2048 символов). Секретов тут нет. Для каждого сервера нужна запись `tools` вида `{type: "mcp_toolset", mcp_server_name}`.
2. При создании сессии `vault_ids`. В хранилище лежат учётки `static_bearer` или `mcp_oauth` с полем `mcp_server_url`.

Правила:

- до 20 серверов, имена уникальны;
- сервер без `mcp_toolset` и `mcp_toolset` без сервера дают 400;
- в `configs` у MCP только `name`, `enabled`, `permission_policy`. Нет `type` и веб-полей;
- по умолчанию включены все инструменты сервера, и все спрашивают (`always_ask`). Новые инструменты сервера не пойдут без человека;
- транспорт Streamable HTTP;
- URL учётки и сервера сравнивают после нормализации: регистр схемы и хоста, порт по умолчанию и слэш в конце не мешают. Нет подходящей учётки, подключение идёт без ключа;
- `mcp_oauth` обновляется сам по `refresh_token`;
- в сети `limited` хост сервера должен быть в `allowed_hosts`, иначе 400 при создании сессии. Флаг `allow_mcp_servers: true` снимает проверку.

Сбои. Создание сессии не проверяет связь с MCP. Если сервер недоступен или отверг ключ, сессия живёт, а в поток идёт `session.error` с `mcp_server_name`, `retry_status` и типом `mcp_connection_failed_error` или `mcp_authentication_failed_error`. Повтор будет при следующем переходе из `idle` в `running`.

Эндпоинты рядом: `POST /v1/agents`, `POST /v1/sessions`, `/v1/vaults`, `/v1/vaults/{id}/credentials`, проверка OAuth `/v1/vaults/{id}/credentials/{cid}/mcp_oauth_validate`.

### 2.5 Навыки (skills)

Страница объясняет, как дать агенту готовые знания: папку с `SKILL.md`, скриптами и файлами.

Два пути:

1. Массив `skills` у агента. Запись: `type` (`anthropic` или `custom`), `skill_id` (короткое имя вроде `xlsx` или id `skill_*`), `version` (номер или `latest`, по умолчанию `latest`).
2. Репозиторий через ресурс `github_repository`. На старте сессии сканируется `.claude/skills/<имя>/SKILL.md` ровно на один уровень. Скан один раз, нужен включённый `read`, только облачная песочница.

Готовые навыки Anthropic: `pptx`, `xlsx`, `docx`, `pdf`. Свой навык грузят zip-архивом или файлами, можно задать `display_name` до 255 символов.

| Метод | Путь |
|---|---|
| POST, GET | `/v1/skills` |
| GET, DELETE | `/v1/skills/{id}` |
| POST, GET | `/v1/skills/{id}/versions` |
| GET, DELETE | `/v1/skills/{id}/versions/{version}` |

Лимиты. До 500 навыков на сессию без повторов по всем агентам. Справочник SDK пишет до 20 навыков на агента. Каждый навык немного ест контекст и замедляет старт песочницы.

Риск. Навыки из репозитория это инструкции агенту. Кто может коммитить, тот может их поменять, а с `bash` и `web_fetch` у них есть реальная сила. Документация советует подключать только доверенные репозитории.

## 3. Как у нас

| Функция | CMA | У нас | Где |
|---|---|---|---|
| Набор `agent_toolset_20260401`, `default_config`, `configs` | beta | частично | `packages/managed-agents-api/src/contracts/agent-input-components.ts:81`, `apps/agent/src/harness/tools.ts:379`. Берётся первый набор в списке, агент без встроенного набора всё равно получает встроенные инструменты |
| Свои инструменты `custom` | beta | частично | `apps/agent/src/harness/tool-events.ts:112`. Нет проверки имён `mcp__`, `ant__` в `agent-input-components.ts:116` |
| Вывод больше 100 000 символов в файл | beta | частично | `apps/agent/src/harness/tools.ts:53`, `:197`. Режем на 50 000 символов, файла нет |
| `allowed_domains`, `blocked_domains` | beta | в коде, не подключено | приём `agent-input-components.ts:50`, хранение `packages/managed-agents-application/src/agents/definition-resolution.ts:39`, передача `packages/managed-agents-adapters-runtime/src/index.ts:650`. Рантайм не читает, `tools.ts:814` |
| `max_content_tokens`, `user_location` | beta | в коде, не подключено | `web_fetch` режет по своему `max_length` (`tools.ts:847`), поиск идёт в DuckDuckGo (`tools.ts:1069`) |
| `allowed_hosts` окружения для `web_fetch` | beta | есть и работает | `apps/agent/src/harness/web-fetch-http.ts:55` |
| `always_allow`, `always_ask`, поток подтверждения | beta | есть и работает | `tools.ts:1369`, `tool-events.ts:99`, `apps/main-node/src/lib/node-managed-stop-reason.ts:29`, `apps/main-node/src/lib/node-managed-session-runner.ts:446`, консоль `apps/console/src/pages/SessionDetail.tsx:982` |
| 400 на подтверждение вызова не в `ask` | beta | нет | проверки не нашёл, `packages/managed-agents-application/src/session-events/application.ts:111` |
| Политика `auto` | beta | нет | схема знает только две политики, `agent-input-components.ts:14` |
| `evaluation`, `evaluated_permission: deny` | beta | частично | шлём только `ask`, `tool-events.ts:99`; схема знает `deny`, `packages/managed-agents-api/src/contracts/session-events.ts:343` |
| MCP по умолчанию `always_ask` | beta | нет | `definition-resolution.ts:15`, `:108`; `tools.ts:348`; консоль `apps/console/src/pages/agents/agentFormCodec.ts:553`. Только MCP строителя ставит `always_ask` явно, `apps/main-node/src/lib/platform-mcp/builder-template.ts:102` |
| `mcp_servers`, связь с `mcp_toolset`, лимит 20 | beta | есть и работает | `packages/managed-agents-application/src/agents/application.ts:352`. Своё расширение `stdio` в `agent-input-components.ts:140`, рантайм Pi его отклоняет, `tools.ts:1208` |
| Выбор MCP-инструментов `enabled` | beta | есть и работает | `tools.ts:363`, `:1251`. В консоли нет настройки по отдельному MCP-инструменту |
| Ключ из vault через прокси, обновление OAuth | beta | частично | `apps/main-node/src/modules/node-managed.ts:160`, `apps/main-node/src/lib/http-mcp-proxy.ts:42`. URL сравниваем строго, без нормализации, `node-managed.ts:190` |
| Сбой MCP как `session.error` с типом | beta | частично | шлём `session.warning` с `source: "mcp_setup"`, `tools.ts:1295` |
| MCP в сети `limited` | beta | частично | вместо 400 молча снимаем MCP-инструменты, `tools.ts:1204` |
| Навыки в `skills`, готовые `xlsx`, `docx`, `pptx`, `pdf` | beta | есть и работает | `platform/skills/builtin`, `apps/main-node/src/lib/builtin-skills.ts:20`, установка в песочницу `apps/main-node/src/lib/node-managed-session-inputs.ts:355` |
| Skills API и версии | GA | есть и работает | `packages/managed-agents-api/src/routes/skills.ts:49`, `packages/managed-agents-api/src/routes/skill-versions.ts:51`, `apps/main-node/src/modules/node-http.ts:472`, консоль `apps/console/src/pages/SkillsList.tsx` |
| Навыки из `.claude/skills` репозитория | beta | нет | репозиторий ставится (`node-managed-session-inputs.ts:351`), скана навыков нет |
| Лимиты навыков (20 на агента, 500 на сессию) | beta | нет | в `packages/managed-agents-api/src/contracts/agents.ts:195` только тип записи |
| Установка навыков из внешних индексов | нет в CMA | есть и работает | `apps/main-node/src/lib/skill-sources.ts:1`, консоль `SkillsList.tsx:137` |

Консоль. Вкладка «Инструменты» в `apps/console/src/pages/agents/AgentFormDialog.tsx:76` даёт включить инструменты и выбрать «Всегда разрешать» или «Всегда спрашивать» для набора и для каждого инструмента. Полей доменов, `max_content_tokens` и `user_location` нет. Вкладка «MCP-серверы» (`AgentFormDialog.tsx:1219`) задаёт имя и URL, а новый сервер получает `always_allow`. Вкладка «Навыки» (`AgentFormDialog.tsx:298`) включает готовые и свои навыки с версией.

## 4. Что добавить

1. Сначала. MCP по умолчанию `always_ask` в `definition-resolution.ts` и в кодеке консоли. В бэк-офисе MCP ходит в учётные системы. Новый инструмент сервера, который пишет данные, не должен пойти без человека.
2. Сначала. Чинить выбор встроенных инструментов в `tools.ts:379`. Сейчас агент только с MCP получает `bash`, `write` и веб, а порядок записей в `tools` меняет итог. Это лишняя сила у агента, которому её не давали.
3. Сначала. Применять `allowed_domains` и `blocked_domains` в `web_fetch` и `web_search` и отдавать `url_not_allowed`. Сейчас владелец ставит запрет, а агент его не видит. Ложное чувство защиты хуже, чем его нет.
4. Потом. Проверка списков доменов при создании агента: один список, от 1 до 64 доменов, формат. Иначе ошибка всплывёт только в работе.
5. Потом. Сбой MCP как `session.error` с `mcp_connection_failed_error` и `mcp_authentication_failed_error`. Клиент и консоль смогут отличить «сервер лёг» от «ключ протух» и попросить новый ключ.
6. Потом. Нормализация URL при подборе учётки в `node-managed.ts:190`. Слэш в конце сейчас ломает подбор, и запрос уходит без ключа.
7. Потом. Запрет имён `mcp__` и `ant__` у своих инструментов. Наш рантайм сам называет MCP-инструменты `mcp__<сервер>__<имя>`, свой инструмент с таким именем их подменит.
8. Потом. 400 на подтверждение вызова, который не ждёт решения. Защита от повторного запуска действия по старому `tool_use_id`.
9. Потом. В консоли настройка прав по отдельному MCP-инструменту и поля доменов у веб-инструментов. Без них оператор правит JSON руками.
10. Позже. Объект `evaluation` в событиях для аудита: кто и по какой политике пустил вызов.
11. Позже. Вывод больше 100 000 символов в файл песочницы вместо обрезки на 50 000. Нужно для больших выгрузок отчётов.
12. Позже. Лимиты навыков и скан `.claude/skills` в репозитории. Пригодится, когда навыки бэк-офиса будут жить в git.
13. Не нужно. Политика `auto`. Ей нужен свой классификатор риска. Для бэк-офиса важнее явный человек на `always_ask`, а он уже работает.

## 5. Источники

- https://platform.claude.com/docs/en/managed-agents/tools
- https://platform.claude.com/docs/en/managed-agents/tools-web-restrictions
- https://platform.claude.com/docs/en/managed-agents/permission-policies
- https://platform.claude.com/docs/en/managed-agents/mcp-connector
- https://platform.claude.com/docs/en/managed-agents/skills
- Справочник скилла claude-api: `shared/managed-agents-tools.md`, `shared/managed-agents-api-reference.md` (лимиты 128 инструментов и 20 навыков на агента, пути Skills API и vaults).
