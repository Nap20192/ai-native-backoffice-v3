# 05. MCP Hub

Черновик 2, 2026-10-15. Основа: `docs/design.md`, разделы 1, 5, 6, 9, и [decisions.md](../decisions.md).

## 0. Согласовано

Этот раздел главнее текста ниже. Подробности и причины в [decisions.md](../decisions.md).

- **Токен сессии (D9).** Тело выпуска только `{session_id, turn_id, attempt}`. `tid`, `act` (= `effective_subject`), `cfg`, `test` Hub берёт из 01 `GET /internal/v1/sessions/{id}`, `turn_actors` и текущий `attempt` из 01 `GET .../turns/{turn_id}`. Несовпадение с claim → `409`. Claims: `aud: ["hub", "models"]`, `tid` (`ns_<ULID>`), `sid`, `turn`, `att`, `cfg`, `act`, `turn_actors`, `test`. TTL = `turn_timeout_s + 300 с`, не больше 35 мин, `ttl_s` от вызывающего не принимается. Выпуск с большим `att` отзывает токены того же `(sid, turn)`. 06 проверяет этот токен для шлюза моделей по JWKS Hub и списку отзывов. Egress-прокси его не принимает. Hub сверяет `namespace_id` конфига с `tid`.
- **Ключ идемпотентности (D7).** `key = sha256(sid, turn, exposed_name, args_hash, k)`, `k` = номер такого же вызова внутри текущей попытки (`att`). Новая попытка считает `k` заново и получает сохранённые результаты прошлой. Одобренный вызов: ключ `approval:<approval_id>`. Если тул объявил идемпотентность, ключ уходит upstream заголовком `Idempotency-Key`. Id вызова harness из `_meta` (если есть) только в трассу. Заголовок `Idempotency-Key` от harness не принимается.
- **Права (D11, D12, D14).** Права агента = toolsets его конфига (закреплённые ревизии). Hub передаёт их во вход 08 `tool-scope` вместе с `effective_subject` и `turn_actors`. `allowed() = агент ∩ effective_subject ∩ каждый turn_actor ∩ нет запрета ∩ потолок класса` (D30). `check-batch` и права `tool:<slug>:<kind>` убраны. Кеш по `(session_id, policy_version)`, срок из `ttl_s` ответа 08. Свои окна при недоступном IAM Hub не держит: правило в 08. Роли из 08: `admin` (права `hub.servers.manage`, `hub.toolsets.manage`, `hub.rules.manage`). `tool_owner` это `owner_id` сервера, не роль.
- **Ревизии toolset (D12).** Таблица `toolset_revisions (toolset_id, revision, items [{tool_id, definition_hash}])`, только вставка. `POST /internal/v1/toolsets:resolve {namespace_id, names[]}` → `[{name, revision}]`. `allowed()` берёт состав закреплённой ревизии.
- **Проверка конфига (D13).** `agent-configs/validate` единственный путь проверки прав автора. Hub разворачивает toolsets и зовёт 08 `tool-scope` с `subject = author`. Код в `problems`: `author_lacks_access`.
- **Подтверждения (D16).** `approvals` получает `tool_use_id` (= id вызова Hub `tc_...`), `approvers[]`, `config_id`, статус `executing` и `cancelled`. Согласующие: `effective_subject`, владелец агента, все с `tools.confirm` на тул (у сессии deployment вместо SA владелец deployment). Hub пишет `tool.confirmation_required {approval_id, tool_use_id, tool, kind, irreversible, arguments_preview, approvers, expires_at, test}` через 01 `events:append` (`writer: system`, ключ `hub:<approval_id>:required`). Signal от Runtime убран. `_meta` ответа: `hub/approval_id`, `hub/approvers`, `hub/expires_at`. `execute` заново считает `allowed()`, проверяет отзыв, `terminated`, OAuth; `approved → executing` атомарно; повтор при `executing` → `in_progress`; падение в `executing` → `unknown` без второго вызова upstream. Новые: `POST /internal/v1/approvals/{id}/cancel` (идемпотентно, `409` при `executing`/`executed`), `GET /internal/v1/approvals?session_id=&turn_id=`. В тестовой сессии `write` и `irreversible` не ниже `ask`.
- **Custom tools (D17).** Встроенный сервер `custom`: тулы `custom__<name>` из `custom_tools` конфига. На `tools/call` Hub сразу отвечает `{custom_pending: true, tool_use_id}` и пишет `agent.custom_tool_use {tool_use_id, name, input, responder, expires_at}` через 01 с ключом идемпотентности. Строка «Hub не исполняет custom tools» значит: Hub их не исполняет, но публикует и записывает вызов.
- **Восстановление (D8).** `GET /internal/v1/tool-calls?session_id=&turn_id=` → завершённые вызовы хода с результатами (для новой попытки воркера).
- **Встроенные серверы (D29).** Глобальные (`namespace_id = null`): `agents`, `channels`, `memory`, `skills`, `subagents`, `files`, `custom`. Тулы и toolsets по таблице D29. На каждый запрос к встроенному серверу Hub ставит `X-Hub-Call-Context`: JWS EdDSA, `aud` = slug сервера, TTL 60 с, claims `tid`, `sid`, `turn`, `att`, `cfg`, `act`, `turn_actors`, `call_id`, `idempotency_key`, `test`. Тулы памяти `memory__write/edit/delete` размечены `kind: write`, `confirmation: allow` (D32).
- **Сабагенты и файлы (D18, D34).** `subagents__spawn` → 01 `POST /internal/v1/sessions/{id}/subagents`. `files__publish` → 01 `POST /internal/v1/files`.
- **Egress (D26).** Hub ходит к upstream через egress-прокси с сервисным egress-bundle на `(namespace_id, server_id)` и `vph_` вместо `{{vault:ref}}`. `secret_ref` чужого namespace → `404` при регистрации. stdio-серверы запускает драйвер 04 в профиле `service` в namespace тенанта, `network_allowlist` проверяет 06.
- **Отзыв версии (D22).** По `agent.version_recalled` Hub отзывает токены с этим `cfg` и отменяет `pending` approvals.
- **Каталог (D14).** `GET /v1/hub/catalog` берёт пользователя из токена. `for_user` только для `admin`.
- **Тенант (D28, D40).** `tenant_id` → `namespace_id` (`ns_<ULID>`). `ENABLE` и `FORCE ROW LEVEL SECURITY` на схеме `hub`.

## 1. Назначение и границы

Hub: единственный путь агента к инструментам. Агент знает один адрес (`https://hub.<домен>/mcp`) и токен своей сессии. Всё остальное делает Hub.

**Что делает:**

- Ведёт реестр MCP-серверов: удалённые по HTTP, stdio-серверы в контейнере, серверы за туннелем.
- Читает каталог тулов и хранит разметку владельца: тип (`read`, `draft`, `write`), необратимость, класс данных, маски полей.
- Собирает тулы в toolsets (`crm.read`, `tickets.draft`).
- Выпускает и проверяет токен сессии. Отзывает его.
- На каждом вызове считает право: человек ∩ агент ∩ нет запрета компании ∩ потолок класса данных.
- Решает, нужно ли подтверждение: `allow`, `ask` (человек), `review` (отдельная модель), `deny`.
- Даёт tool search, чтобы не раздувать контекст.
- Маскирует поля в ответах.
- Пишет трассу каждого вызова и считает стоимость.
- Принимает исходящие туннели от MCP-серверов из чужих сетей.
- Отдаёт встроенные серверы платформы (D29): `agents` (07), `channels` (09), `memory` и `skills` (10), `subagents`, `files`, `custom` (01, 02). Логика у них в компонентах-владельцах, Hub ставит права, трассу и подписанный контекст вызова.

**Чего НЕ делает:**

- Не хранит секреты в открытом виде и не подставляет их сам. Это Vault и egress-прокси (06). Hub хранит только ссылки `secret_ref`.
- Не маршрутизирует вызовы моделей. Шлюз моделей (06) отдельный. Hub только сам вызывает его для auto-review и эмбеддингов.
- Не пишет журнал событий напрямую. События уходят через Runtime API (01).
- Не управляет Temporal. Ожидание человека ведёт `SessionWorkflow` (02).
- Не хранит права людей и роли. Их источник: IAM (08). Hub хранит только запреты на тулы и разметку.
- Не исполняет custom tools клиента. Это `agent.custom_tool_use` в Runtime.
- Не выполняет код агента. Песочница (04) отдельно.

## 2. Модель данных

Postgres, схема `hub`. Все таблицы имеют `namespace_id text` (`ns_<ULID>`; `null` только у встроенных серверов и toolsets `platform.*`) и `created_at`, `updated_at timestamptz`. RLS с `FORCE` (D40). Ниже эти поля не повторяю.

**`mcp_servers`**: зарегистрированный сервер.

| Поле | Тип | Смысл |
|---|---|---|
| `id` | uuid | |
| `slug` | text, `^[a-z][a-z0-9_]{1,23}$`, уникален в тенанте | Префикс имён тулов |
| `display_name`, `owner_id` | text | Владелец размечает тулы |
| `transport` | enum `http`, `stdio`, `tunnel`, `builtin` | |
| `url` | text | Для `http`: канонический URI (RFC 8707, без `/` в конце) |
| `stdio_spec` | jsonb | `{image, digest, command[], args[], env_refs{NAME: secret_ref}, resources{cpu, memory}, network_allowlist[]}` |
| `tunnel_id` | uuid null | Для `tunnel` |
| `auth` | jsonb | `{kind: none \| static_header \| oauth_user \| oauth_client, secret_ref?, header?, oauth_provider?, scopes[]}` |
| `protocol_versions` | text[] | Что сервер ответил при обнаружении |
| `status` | enum `pending`, `active`, `degraded`, `offline`, `disabled` | |
| `call_timeout_ms` | int, по умолчанию 60000, максимум 600000 | |
| `rate_limit_rps` | int, по умолчанию 20 | На сервер в тенанте |
| `catalog_synced_at`, `catalog_hash` | | |

**`tools`**: тул из каталога сервера.

| Поле | Тип | Смысл |
|---|---|---|
| `id` | uuid | |
| `server_id` | uuid | |
| `upstream_name` | text | Имя у сервера |
| `exposed_name` | text, `^[a-zA-Z0-9_-]{1,64}$` | `<slug>__<upstream_name>`, длинные имена укорачиваются с хешем |
| `definition` | jsonb | `title`, `description`, `inputSchema`, `outputSchema`, `annotations` как прислал сервер |
| `definition_hash` | text | sha256 канонического JSON |
| `approved_hash` | text null | Хеш, который одобрил владелец |
| `kind` | enum `read`, `draft`, `write` null | null = не размечен |
| `irreversible` | bool, по умолчанию false | Удаление, платёж, отправка наружу |
| `data_class` | enum `public`, `internal`, `confidential`, `pdn` | Максимальный класс в ответе |
| `masks` | jsonb | `[{path: "$.items[*].phone", class: "pdn", action: "redact" \| "hash" \| "partial"}]` |
| `confirmation` | enum `allow`, `ask`, `review`, `deny` null | Переопределение по умолчанию |
| `timeout_ms` | int null | |
| `status` | enum `unlabeled`, `active`, `needs_review`, `removed`, `invalid` | |
| `search_tsv` | tsvector | Для tool search |

**`toolsets`**: `id`, `name` (`^[a-z0-9_]+\.[a-z0-9_]+$`, уникален в тенанте), `description`, `owner_id`, `current_revision int`. **`toolset_items`**: `toolset_id`, `tool_id` (текущий состав). **`toolset_revisions`** (только вставка, D12): `toolset_id`, `revision`, `items jsonb [{tool_id, definition_hash}]`. Каждая правка состава создаёт ревизию. В toolset можно добавить только тул в статусе `active`.

**`company_rules`**: запреты и потолки компании.

| Поле | Тип | Смысл |
|---|---|---|
| `id` | uuid | |
| `effect` | enum `deny`, `require_confirmation`, `max_data_class` | |
| `match` | jsonb | `{server_slug?, tool?, kind?, data_class?, agent_id?, channel_kind?}`, glob в `tool` |
| `value` | text null | Для `require_confirmation`: `ask`/`review`; для `max_data_class`: класс |
| `reason` | text | Показывается агенту и в трассе |

**`session_tokens`**: `jti` uuid, `session_id`, `turn_id`, `attempt`, `config_id`, `run_as` (`effective_subject`), `issued_at`, `expires_at`, `revoked_at` null. **`session_revocations`**: `session_id`, `revoked_before timestamptz` (все токены сессии, выпущенные раньше, недействительны).

**`approvals`**

| Поле | Тип | Смысл |
|---|---|---|
| `id` | text | `ap_<ULID>` (A3) |
| `session_id`, `turn_id`, `tool_id`, `config_id` | | |
| `tool_use_id` | text | Id вызова Hub `tc_...`, то же значение в журнале (D16) |
| `approvers` | text[] | Кто может решить (D16) |
| `arguments` | jsonb, зашифрован на уровне колонки | Замороженные аргументы |
| `arguments_hash` | text | |
| `mode` | enum `ask`, `review` | |
| `status` | enum `pending`, `reviewing`, `approved`, `denied`, `expired`, `cancelled`, `executing`, `executed`, `failed`, `unknown` | `approved → executing` атомарно (D16) |
| `reviewer` | jsonb | `{kind: human \| model, id, verdict, reason}` |
| `expires_at` | timestamptz, по умолчанию +72 часа | |
| `idempotency_key` | text | |

**`tool_calls`**: трасса и идемпотентность. `id` (`tc_<ULID>`, A3), `session_id`, `turn_id`, `attempt`, `harness_tool_use_id` (из `_meta`, если есть), `config_id`, `run_as`, `tool_id`, `exposed_name`, `idempotency_key` (уникален), `arguments_hash`, `decision` (`allowed`, `denied`, `pending_approval`, `approved_execute`), `deny_reason`, `status` (`ok`, `tool_error`, `protocol_error`, `timeout`, `upstream_unavailable`), `result` jsonb (после масок, хранится 24 часа для повторов, затем обнуляется), `masked_fields int`, `latency_ms`, `bytes_in`, `bytes_out`, `cost_micros bigint`, `trace_id`, `span_id`, `started_at`, `finished_at`. Секционирование по месяцу.

**`tunnels`**: `id`, `name`, `token_hash`, `status` (`online`, `offline`), `last_seen_at`, `agent_version` (версия программы туннеля), `remote_addr`.

**`stdio_instances`**: `server_id`, `runner` (`docker`, `kubernetes`), `ref` (id контейнера или имя Deployment), `replicas`, `status`, `last_health_at`.

## 3. Контракты

### 3.1. MCP endpoint для агентов: `POST /mcp`

Streamable HTTP. Hub работает как MCP-сервер для harness и как MCP-клиент для upstream-серверов.

- Версии протокола: `2026-07-28` (текущая, без сессий и без `initialize`) и `2025-11-25`, `2025-06-18` (с `initialize`). ACP-обёртки и SDK harness могут отставать, поэтому старую эпоху поддерживаем. Для старой эпохи Hub выдаёт `Mcp-Session-Id`, но состояние к нему не привязывает: это подписанная строка с `session_id` и `jti`.
- Для `2026-07-28` проверяются заголовки `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`. Расхождение с телом: `400` и JSON-RPC `-32020` (`HeaderMismatch`). Неподдерживаемая версия: `400` и `UnsupportedProtocolVersionError` (`-32022`). GET и DELETE в новой эпохе: `405`.
- `Origin` проверяется всегда. Чужой `Origin`: `403`.
- Нет токена, токен истёк, не тот `aud`, отозван: `401` с `WWW-Authenticate: Bearer resource_metadata="https://hub.<домен>/.well-known/oauth-protected-resource"`.
- Токен в query string не принимается.
- `tools/list` отдаёт тулы в детерминированном порядке. Набор зависит только от токена, не от соединения. `ttlMs: 60000`, `cacheScope: "private"`.
- `traceparent` из `_meta` продолжает трассу (конвенция OpenTelemetry из `2026-07-28`).

Пример вызова от harness:

```http
POST /mcp HTTP/1.1
Authorization: Bearer eyJhbGciOiJFZERTQSIsImtpZCI6Imh1Yi0yMDI2LTEwIn0...
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: crm__get_contact
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"crm__get_contact",
 "arguments":{"contact_id":"c_42"},
 "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
  "io.modelcontextprotocol/clientCapabilities":{},
  "traceparent":"00-4bf9...-00f0...-01"}}}
```

Успех (телефон замаскирован, класс `pdn` выше потолка агента):

```json
{"jsonrpc":"2.0","id":7,"result":{"resultType":"complete",
 "content":[{"type":"text","text":"{\"name\":\"Айгерим С.\",\"phone\":\"«masked:pdn»\"}"}],
 "structuredContent":{"name":"Айгерим С.","phone":"«masked:pdn»"},
 "isError":false,
 "_meta":{"hub/call_id":"tc_01J...","hub/masked_fields":1}}}
```

Отказ по политике. Это ошибка исполнения тула, а не HTTP 403: модель должна увидеть причину и выбрать другой путь.

```json
{"jsonrpc":"2.0","id":8,"result":{"resultType":"complete","isError":true,
 "content":[{"type":"text","text":"Отказано: у пользователя u_17 нет права crm.write. Не повторяй вызов."}],
 "_meta":{"hub/decision":"denied","hub/deny_code":"human_not_permitted"}}}
```

Коды отказа `hub/deny_code`: `human_not_permitted`, `agent_not_permitted`, `company_rule`, `data_class_ceiling`, `tool_needs_review`, `tool_unlabeled`, `rate_limited`, `oauth_grant_missing`, `approval_denied`, `approval_expired`.

Ожидание подтверждения (см. поток 5.2):

```json
{"jsonrpc":"2.0","id":9,"result":{"resultType":"complete","isError":true,
 "content":[{"type":"text","text":"Вызов tickets__close ждёт подтверждения человека (approval ap_9f). Не повторяй вызов. Результат придёт отдельным событием."}],
 "_meta":{"hub/decision":"pending_approval","hub/approval_id":"ap_9f"}}}
```

Неизвестный тул: JSON-RPC `-32602`. Upstream не ответил за `timeout_ms`: `isError: true`, `hub/deny_code` нет, `status=timeout` в трассе.

### 3.2. Режимы показа тулов и tool search

Поле AgentVersion `tool_exposure`: `full` или `search`. По умолчанию `search`, если тулов больше 40, иначе `full`.

- `full`: `tools/list` отдаёт все разрешённые тулы плюс `hub__search_tools`.
- `search`: `tools/list` отдаёт только мета-тулы и закреплённые (`pinned`) тулы агента.

Мета-тулы Hub:

| Тул | Вход | Выход |
|---|---|---|
| `hub__search_tools` | `{query: string, limit?: 1..20 = 8, kind?: read\|draft\|write}` | `[{name, title, description, kind, data_class}]`, только разрешённые |
| `hub__describe_tool` | `{name}` | Полное определение с `inputSchema` |
| `hub__call_tool` | `{name, arguments}` | Результат тула, все проверки те же |

`hub__call_tool` нужен потому, что многие harness не перечитывают `tools/list` посреди хода. Поиск: Postgres full-text по `exposed_name`, `title`, `description`, тегам toolset. Позже pgvector с эмбеддингами через шлюз моделей (06).

### 3.3. Internal API (mTLS между сервисами, сервисный JWT от 08)

**Выпуск токена сессии.** Вызывает harness-воркер (03) в начале каждой activity `RunTurn`.

```http
POST /internal/v1/session-tokens
{"session_id":"ses_01J...","turn_id":"ses_01J...:7","attempt":1}
```

Остальное (`tid`, `act`, `cfg`, `test`, `turn_actors`) Hub берёт из 01. Поля `tenant_id`, `run_as`, `ttl_s` в теле игнорируются (тест на это есть).

```json
201 {"token":"eyJ...","expires_at":"2026-10-15T13:00:00Z","jti":"8c1e...",
     "mcp_url":"https://hub.example.kz/mcp"}
```

Ошибки: `404` сессия неизвестна, `409` сессия `terminated` или `turn_id`/`attempt` не совпадают с claim в 01, `403` у `effective_subject` нет доступа к тенанту.

Формат токена: JWS, алгоритм `EdDSA`, ключи в JWKS `https://hub.<домен>/.well-known/jwks.json`, ротация раз в 30 дней, старый ключ живёт ещё 2 TTL. Claims:

| Claim | Пример | Смысл |
|---|---|---|
| `iss` | `https://hub.example.kz` | |
| `aud` | `["hub", "models"]` | Hub и шлюз моделей (06), D9. Другие `aud` отвергаются |
| `sub` | `session:ses_01J...` | |
| `tid` | `ns_01J8A...` | Тенант (D28) |
| `sid`, `turn`, `att` | | Сессия, ход, попытка. Входят в ключ идемпотентности (D7) |
| `cfg` | `ver_01J...` или `tst_01J...` | Конфиг агента (D10) |
| `act` | `{"kind":"user","id":"usr_17"}` | `effective_subject` |
| `turn_actors` | `["usr_17", "usr_22"]` | Авторы входов хода (D30) |
| `test` | `false` | Тестовая сессия (D16) |
| `jti`, `iat`, `exp` | | TTL = ход + 300 с, не больше 35 мин, допуск часов 30 с |

**Отзыв.** `POST /internal/v1/session-tokens/revoke` с `{session_id}` или `{jti}` → `204`. Вызывают 02 при `terminated` (activity `RevokeSessionAccess`), 08 при блокировке человека. По `agent.version_recalled` Hub отзывает по `cfg` сам. Также `{cfg}`. Hub пишет `session_revocations` и шлёт `NOTIFY hub_revocations`. Все реплики Hub держат кеш отзывов в памяти. Срок распространения не больше 5 с; при потере `LISTEN` реплика перечитывает таблицу раз в 5 с.

**Подтверждения.**

- `POST /internal/v1/approvals/{id}/decide` `{decision: "approve"|"deny", actor:{kind:"human",id}, reason?}` → `200 {status}`. `409` если уже не `pending`. `403` если человек не в `approvers` и без `tools.confirm` (08). Вызывает activity `DecideApproval` workflow (02) после update `submit_tool_confirmation`.
- `POST /internal/v1/approvals/{id}/execute` → `200 {call_id, status, result | file_ref}`. Заново считает `allowed()`, проверяет отзыв, `terminated`, OAuth-грант; отказ → `failed` с `deny_code`. Переход `approved → executing` атомарный, ключ `approval:<id>`. Повтор при `executing` → `202 in_progress`, при `executed` тот же результат. Падение в `executing` → `unknown`, upstream второй раз не зовётся. `409` если статус не `approved`/`executing`/`executed`. Вызывает activity `ExecuteApprovedCall`.
- `POST /internal/v1/approvals/{id}/cancel` `{reason: timeout | interrupted | terminated}` → `204`, идемпотентно. `timeout` даёт статус `expired`, остальные `cancelled`. `409` при `executing` или `executed`. Вызывает activity `CancelApproval` (таймаут, прерывание, `terminated`).
- `GET /internal/v1/approvals?session_id=&turn_id=&status=` → список. `GET /internal/v1/tool-calls?session_id=&turn_id=` → завершённые вызовы хода с результатами (D8).

**Проверка конфига агента.** Вызывает 07 при сохранении черновика и при публикации.

```http
POST /internal/v1/agent-configs/validate
{"namespace_id":"ns_01J8A...","author_id":"usr_5","toolsets":[{"name":"crm.read","revision":7},{"name":"tickets.draft","revision":3}],
 "pinned_tools":[],"confirmations":{"tickets__close":"review"},"custom_tools":[]}
```

```json
200 {"ok":true,"needs_admin_approval":false,"max_kind":"draft","max_data_class":"pdn",
     "problems":[{"code":"author_lacks_access","tool":"crm__delete_contact"}]}
```

`needs_admin_approval=true`, если есть `write` или `pdn` (правило из design.md, раздел 6). Понижать `confirmation` для `irreversible` тулов ниже `ask` нельзя: `problems` с кодом `irreversible_requires_ask`.

### 3.4. Admin REST (консоль 07, роли из 08)

| Метод | Что делает | Коды |
|---|---|---|
| `POST /v1/hub/servers` | Зарегистрировать сервер. Hub сразу делает обнаружение и синхронизацию каталога | `201`, `409` slug занят, `422` URL не прошёл проверку |
| `GET /v1/hub/servers`, `GET /v1/hub/servers/{id}` | Список, детали, здоровье | `200` |
| `PATCH /v1/hub/servers/{id}` | Изменить. `If-Match: <etag>` | `200`, `412` |
| `POST /v1/hub/servers/{id}/sync` | Перечитать каталог | `202` |
| `DELETE /v1/hub/servers/{id}` | Выключить. Тулы уходят в `removed` | `204` |
| `PATCH /v1/hub/tools/{id}` | Разметка: `kind`, `irreversible`, `data_class`, `masks`, `confirmation`, `approve_hash` | `200`, `422` неполная разметка |
| `POST /v1/hub/toolsets`, `PUT /v1/hub/toolsets/{id}/items` | Наборы | `201`, `200`, `422` тул не `active` |
| `GET /v1/hub/catalog` | Каталог с отметкой, доступен ли вызывающему (из токена). `?for_user=` только для `admin` (D14). Для формы агента и `agents__list_toolsets` | `200` |
| `POST /v1/hub/rules`, `DELETE /v1/hub/rules/{id}` | Запреты компании. Право `hub.rules.manage` (роль `admin`) | `201`, `204` |
| `GET /v1/hub/calls?session_id=&tool=&from=&to=` | Трассы | `200` |
| `GET /v1/hub/approvals?status=pending&assignee=me` | Очередь подтверждений | `200` |
| `POST /v1/hub/tunnels` | Создать туннель. Токен показывается один раз | `201` |

Регистрация HTTP-сервера:

```json
POST /v1/hub/servers
{"slug":"crm","display_name":"CRM","transport":"http","url":"https://crm.internal.kz/mcp",
 "auth":{"kind":"static_header","header":"Authorization","secret_ref":"crm-api-key"},
 "call_timeout_ms":30000}
```

stdio-сервер:

```json
{"slug":"pgread","transport":"stdio",
 "stdio_spec":{"image":"registry.local/mcp/postgres","digest":"sha256:ab12...",
  "command":["mcp-postgres"],"args":["--read-only"],
  "env_refs":{"DATABASE_URL":"pg-readonly"},
  "resources":{"cpu":"250m","memory":"256Mi"},"network_allowlist":["pg.internal:5432"]}}
```

Образ принимается только с `digest`. Консоль показывает команду целиком перед сохранением, сохранить может только право `hub.servers.manage`. `secret_ref` ищется только в своём namespace, чужой даёт `404` (D26).

### 3.5. События, которые Hub отдаёт

Через `POST /internal/v1/sessions/{id}/events:append` Runtime API (01), `writer: system`, с ключом идемпотентности (D6):

- `tool.confirmation_required` `{approval_id, tool_use_id, tool, kind, irreversible, arguments_preview, mode, approvers, expires_at, test}`, ключ `hub:<approval_id>:required`. 01 открывает ожидание в той же транзакции. Signal в workflow не шлётся: воркер вернёт `waits` в конце хода (D16).
- `agent.custom_tool_use` `{tool_use_id, name, input, responder, expires_at}`, ключ = ключ идемпотентности вызова (D17).
- `span.usage` `{source:"hub", call_id, latency_ms, cost_micros}`.

Решение по подтверждению в журнал пишет не Hub: это `user.tool_confirmation` (01) и `tool.result` с ключом `approval:<id>:result` (02).

Шина для консоли и аудита (Postgres outbox, позже NATS или Kafka): `hub.server.status_changed`, `hub.tool.needs_review`, `hub.catalog.changed`, `hub.call.completed`.

### 3.6. Туннели

Программа `hub-tunnel` в чужой сети открывает `wss://hub.<домен>/tunnel/v1/connect` с `Authorization: Bearer <tunnel_token>`. Кадры JSON: `{stream, kind: "req"|"res_head"|"res_chunk"|"end"|"ping", data}`. Hub шлёт по туннелю обычные HTTP-запросы MCP к `local_url`. Пинг каждые 15 с, `offline` после 45 с тишины. Туннель не принимает входящих соединений из сети Hub, кроме MCP-запросов к одному `local_url`.

## 4. От чего зависит

| От кого | Контракт | Зачем |
|---|---|---|
| 01-runtime-api | `POST /internal/v1/sessions/{id}/events:append` (`writer: system`) | Писать `tool.confirmation_required`, `agent.custom_tool_use`, `span.usage` |
| 01-runtime-api | `GET /internal/v1/sessions/{id}` → `{namespace_id, config_id, effective_subject, status, metadata.channel, metadata.test}`; `GET .../turns/{turn_id}` → `{attempt, turn_actors}` | Выпуск токена (D9) |
| 01-runtime-api | `POST .../subagents`, `POST /internal/v1/files` | Встроенные `subagents`, `files` |
| 02-session-workflow | Activities `DecideApproval`, `ExecuteApprovedCall`, `CancelApproval`, `RevokeSessionAccess` | Workflow вызывает `decide`, `execute`, `cancel`, `revoke` |
| 03-harness-workers | Передача токена в harness: ACP `session/new` `mcpServers: [{type:"http", name:"hub", url, headers:[{name:"Authorization", value:"Bearer ..."}]}]` | Агент знает только Hub |
| 04-sandbox | Профиль изоляции образов (non-root, read-only rootfs, gVisor) | stdio-серверы запускаются по тем же правилам |
| 06-vault-egress-models | `Secret.put` через Vault API; сервисный egress-bundle на `(namespace_id, server_id)` с `vph_` (D26); `GET /internal/v1/vault/grants?user=&provider=`; JWKS Hub читает шлюз моделей | Креды upstream не попадают в Hub и в песочницу |
| 06-vault-egress-models | Шлюз моделей `POST /v1/chat/completions`, `POST /v1/embeddings` | Auto-review и поиск тулов |
| 06-vault-egress-models | `POST /internal/v1/sessions/{id}/data-class {level, raised_by}` | Поднять класс данных сессии, когда тул вернул данные выше текущего |
| 07-agent-control-plane | `GET /internal/v1/agent-configs/{config_id}` → `{namespace_id, toolsets [{name, revision}], pinned_tools, tool_exposure, confirmations, max_data_class, custom_tools, owner_id}` | Права агента на каждом вызове (кеш навсегда: конфиг неизменяем). Встроенный сервер `agents` |
| 08-iam-tenancy | `POST /internal/iam/tool-scope` с toolsets конфига, `effective_subject`, `turn_actors`; права `hub.*.manage`, `tools.confirm`; сервисные JWT | Права человека, агента и админа (D11, D14) |
| 09-channels-bots | Встроенный сервер `channels` | `channels__send_user`, `channels__read_thread`, `channels__search_threads` |
| 10-deployments-memory-skills | Встроенные серверы `memory`, `skills` | Память и скиллы. От чьего имени deployment решает 08 (D33) |

Расчёт права на вызов (чистая функция, тестируется отдельно):

```
allowed(call) =
     tool.status == active and tool.approved_hash == tool.definition_hash
 and tool ∈ revisions(config.toolsets) ∪ pinned          // закреплённые ревизии (D12)
 and tool_scope(08, effective_subject, turn_actors, config.toolsets) allows tool  // D11, D14, D30
 and not any(company_rules.deny matching call)
 and effective_class(call) <= ceiling
ceiling = min(config.max_data_class, rules.max_data_class, channel ceiling)
confirmation = max(default(kind, irreversible), tool.confirmation,
                   config.confirmations (только вверх), company require_confirmation,
                   test ? ask для write и irreversible : allow)
default: read → allow, draft → allow, write → ask, irreversible → ask
порядок строгости: allow < review < ask < deny
```

Если `data_class` тула выше потолка, но у тула есть маски на все поля этого класса, вызов разрешён с маскированием. Иначе отказ `data_class_ceiling`. Кеши: ответ `tool-scope` по `(session_id, policy_version)` на `ttl_s` из ответа 08, правила компании 30 с (сбрасываются `NOTIFY`), конфиг агента без срока.

## 5. Ключевые потоки

### 5.1. Обычный вызов `read`

```mermaid
sequenceDiagram
    participant H as Harness (03)
    participant HUB as MCP Hub
    participant IAM as IAM (08)
    participant EG as Egress-прокси (06)
    participant UP as Upstream MCP
    H->>HUB: POST /mcp tools/call crm__get_contact + Bearer
    HUB->>HUB: JWT: подпись, aud, exp, отзыв
    HUB->>HUB: идемпотентность (sid, turn, tool, args_hash, k), D7
    HUB->>IAM: tool-scope (кеш по policy_version)
    IAM-->>HUB: allow
    HUB->>HUB: правила компании, потолок класса, confirmation=allow
    HUB->>EG: POST https://crm.internal.kz/mcp, Authorization: Bearer vph_... (сервисный bundle)
    EG->>UP: тот же запрос с настоящим ключом
    UP-->>EG: result
    EG-->>HUB: result
    HUB->>HUB: валидация outputSchema, маски, лимит 1 МиБ
    HUB->>HUB: tool_calls (трасса, стоимость)
    HUB-->>H: result (resultType complete)
```

### 5.2. Вызов `write` с подтверждением человека

```mermaid
sequenceDiagram
    participant H as Harness (03)
    participant HUB as MCP Hub
    participant RA as Runtime API (01)
    participant WF as SessionWorkflow (02)
    participant U as Человек (канал или консоль)
    H->>HUB: tools/call tickets__close {id: 81}
    HUB->>HUB: policy: allowed, confirmation=ask
    HUB->>HUB: approvals: pending, аргументы заморожены
    HUB->>RA: events:append tool.confirmation_required (01 открывает ожидание)
    HUB-->>H: isError, pending_approval, ap_9f
    H-->>WF: ход закончен, waits из 01: [ap_9f]
    WF->>WF: статус waiting_human, таймер до expires_at
    U->>RA: user.tool_confirmation {approval_id: ap_9f, decision: approve}
    RA->>WF: update submit_tool_confirmation (01 проверил approvers)
    WF->>HUB: activity DecideApproval
    WF->>HUB: activity ExecuteApprovedCall
    HUB->>HUB: allowed() заново, approved→executing, вызов upstream по ключу approval:ap_9f
    HUB-->>WF: result
    WF->>RA: tool.result {approval_id, ключ approval:ap_9f:result}
    WF->>WF: новый ход RunTurn (resume_after_wait)
```

Режим `review`: Hub ставит `reviewing` и вызывает шлюз моделей с политикой тенанта, описанием тула и аргументами. Ответ модели строго JSON `{verdict: approve|deny|escalate, reason}`. Ждём ответ до 20 с прямо внутри `tools/call` (SSE с `notifications/progress`). `approve`: вызов идёт сразу. `deny`: отказ `approval_denied`. `escalate`, таймаут или невалидный ответ: переход в `ask`, дальше как в 5.2. Модель-ревьюер не видит инструкций агента и переписки, только вызов. Так prompt injection из данных не доходит до ревьюера.

## 6. Отказы и как переживаем

| Что упало | Что видит пользователь | Как восстанавливаемся |
|---|---|---|
| Реплика Hub посреди вызова | Harness получает обрыв потока | Harness повторяет запрос. Hub по ключу идемпотентности вернёт сохранённый результат или дождётся идущего вызова (lock в Postgres, `SELECT ... FOR UPDATE SKIP LOCKED` на строке `tool_calls`) |
| Воркер harness упал, Temporal повторил ход | Ничего | Тот же `turn`, счёт `k` в новой попытке заново, ключ совпадает (D7). `write` не повторяется, результат из `tool_calls` (хранится 24 часа). Новый воркер забирает результаты через `GET /internal/v1/tool-calls` |
| Upstream не отвечает | Агент получает `isError` с текстом «сервис недоступен» | Circuit breaker на сервер: 5 ошибок за 30 с → `degraded`, 60 с без вызовов, затем пробный. `read` можно повторить один раз с паузой 500 мс, `write` никогда |
| Ответ upstream после таймаута Hub | Агент уже получил `timeout` | Для `write` статус вызова `unknown`. В трассе флаг, владельцу сервера уведомление. Повтор только через человека |
| stdio-контейнер упал | `upstream_unavailable` | Runner перезапускает (k8s restartPolicy, docker `--restart=on-failure`). Health-проверка `server/discover` или `tools/list` раз в 30 с |
| Туннель офлайн | Тулы сервера отказывают `upstream_unavailable` | Программа туннеля переподключается с backoff 1→30 с. Статус виден в консоли |
| Upstream поменял описание или схему тула | Тул отказывает `tool_needs_review` | Защита от подмены: при синхронизации новый хеш ≠ `approved_hash` → `needs_review`, событие владельцу. Владелец смотрит diff и одобряет |
| IAM (08) недоступен | Отказ `human_not_permitted` с пометкой «временно» | Fail closed. Правило 08: кеш до `ttl_s`, затем ещё до 120 с только `read` (D14) |
| Шлюз моделей недоступен | `review` превращается в `ask` | Человек решает сам |
| Postgres недоступен | `503` на `/mcp` | Без трассы и проверки отзыва вызовы не идут. Readiness Hub падает, Kubernetes убирает реплику |
| Approval не решён 72 часа | Агент в следующем ходе видит `approval_expired` | Таймер в workflow: по `expires_at` 02 вызывает `CancelApproval` с `reason: timeout`, Hub ставит `expired`, а не `cancelled`. Синтетический `tool.result {reason: timeout}` пишет 02 |
| Токен истёк посреди хода | Не бывает: токен живёт ход + 5 мин, ход не длиннее 30 мин (D9) | Если всё же `401`, попытка падает и Temporal повторяет её с новым токеном |

## 7. Безопасность

- **Нет token passthrough.** Токен сессии предназначен только Hub (`aud`). Hub не пересылает его upstream и вырезает входящий `Authorization` перед любым исходящим запросом. Upstream получает свой кред: статический ключ через подстановку egress или OAuth-токен, выпущенный upstream-сервером авторизации для `resource=<канонический URI upstream>` (RFC 8707). Это требование спецификации MCP (Authorization, Security Best Practices).
- **Секреты не в Hub.** В запросе к upstream стоит подставное значение `vph_...` из сервисного egress-bundle (D26), настоящее вставляет egress-прокси только для домена из `allowed_hosts` секрета. В логах и трассе только `secret_ref`.
- **OAuth от имени человека.** Hub выступает OAuth-клиентом upstream. PKCE, `state` одноразовый на 10 мин, проверка `iss` в ответе авторизации (RFC 9207), точное совпадение `redirect_uri`. Перед первым подключением человек видит страницу согласия Hub с именем сервера и scopes. Гранты хранит Vault (06), по ключу `(tenant, user, provider, issuer)`.
- **SSRF.** URL сервера и все OAuth-адреса проверяются: только `https` (кроме dev), блок частных диапазонов, link-local (`169.254.0.0/16`), loopback, IPv6 ULA. Все исходящие запросы Hub идут через egress-прокси, поэтому проверка повторяется на сети. Редиректы не следуем автоматически.
- **stdio.** Только образ по digest. Запуск без root, read-only rootfs, отдельный ServiceAccount без прав, NetworkPolicy только к egress-прокси и `network_allowlist`, RuntimeClass gVisor для сторонних образов. Секреты в env только через `env_refs`, выдаёт Secret-драйвер (06). Команда показывается целиком перед сохранением.
- **Разметка не доверяет upstream.** `annotations` (`readOnlyHint`, `destructiveHint` и т. п.): только подсказка для первичной разметки. Спецификация требует считать их недоверенными. Решает владелец тула.
- **Подтверждение решает Hub, а не промпт.** Агент не может понизить режим. Аргументы замораживаются по хешу. Выполняется ровно то, что одобрил человек.
- **Маскирование** работает до трассы и до ответа: в `tool_calls.result` маскированные значения не хранятся. Аргументы `pdn` в трассе хранятся как хеш.
- **Изоляция тенантов.** `tid` в токене сверяется с `namespace_id` каждого объекта и конфига агента. RLS с `FORCE` на схеме `hub`. Тул чужого тенанта не виден даже в поиске.
- **Ограничения.** 10 вызовов в секунду на сессию, 1 МиБ на ответ (больше: обрезка и ссылка на файл в S3), 256 КиБ на аргументы. Превышение частоты: `isError` с `rate_limited`, при флуде `429`.
- **Проверка `Origin`** и `403` на чужой. Токены только в заголовке.
- **Аудит.** Все изменения реестра, разметки, правил и решения по approvals пишутся в `audit_log` с `actor`.

## 8. Как тестировать

Строгий TDD. Порядок первых тестов:

1. **Политика как чистая функция.** Табличный тест `allowed(call)` и `confirmation(call)`: человек без права, агент без toolset, запрет компании, потолок класса, маски на все pdn-поля, понижение `irreversible` запрещено. Первый красный тест: `write` тул у агента с правом, у человека без права → `human_not_permitted`.
2. **Токен.** Неверная подпись, чужой `aud`, `exp` в прошлом, допуск 30 с, отзыв по `jti`, отзыв по `revoked_before`. Каждый случай → `401` с `WWW-Authenticate`.
3. **Имена.** `<slug>__<tool>`, укорачивание до 64 символов с хешем, отсутствие коллизий.
4. **Маски.** JSONPath по `structuredContent` и по JSON в `text`; `redact`, `hash`, `partial`.
5. **Идемпотентность.** Два одинаковых `tools/call` с одним `turn` → upstream вызван один раз. Параллельные вызовы → один ждёт другого.
6. **Контрактные тесты MCP.** Фейковый upstream на двух эпохах протокола (`2026-07-28` и `2025-06-18`). Hub как сервер: проверка `HeaderMismatch`, `UnsupportedProtocolVersion`, `405` на GET, `initialize` для старой эпохи. Взять официальный набор conformance, если он есть (не проверено).
7. **Approval state machine.** `pending → approved → executed`, повторный `execute` возвращает тот же результат, `decide` после `expired` → `409`.
8. **Интеграция с фейками 01, 02, 06, 07, 08.** Каждый компонент даёт фейк по своему контракту (design.md, раздел 8).
9. **stdio-мост.** Контейнер с эталонным stdio-сервером, вызов через Hub, убийство контейнера, перезапуск.
10. **Подмена тула.** Upstream меняет описание → тул `needs_review`, вызов отказывает.
11. **Сквозной сценарий** из плана (design.md, раздел 10, шаг 4): агент на `simple` harness зовёт `read`, затем `write` с `ask`, человек одобряет через API, результат в журнале, воркер убит посреди хода, `write` не повторился.
12. **Безопасность.** SSRF-набор адресов (`169.254.169.254`, `0x7f.1`, `[::ffff:127.0.0.1]`), отсутствие исходного `Authorization` в запросе к upstream, отсутствие секретов и pdn в логах (сканер по фикстурам).

## 9. Открытые вопросы

1. ~~**Новые типы событий.**~~ Решено в D38. В design.md нет события «нужно подтверждение». Предлагаю добавить `tool.confirmation_required` и `tool.approval_decided` в JSON Schema событий (01).
2. ~~**Ожидание подтверждения.**~~ Решено в D16. Выбран путь «Hub возвращает pending, ход заканчивается, workflow ждёт человека и сам исполняет вызов». Альтернатива через ACP `session/request_permission` даёт ожидание внутри хода, но держит activity часами. Нужно согласие с 02 и 03.
3. ~~**Ключ идемпотентности.**~~ Решено в D7. Harness не передаёт id своего tool_use в `_meta`. Ключ строится из `(sid, turn, tool, args_hash, порядковый номер)`. При повторе хода модель может сделать другие вызовы, тогда ключи не совпадут и `write` может выполниться дважды. Нужно решить с 03, можно ли передавать `tool_use_id` в `_meta` через адаптер.
4. ~~**Обновление токена посреди хода.**~~ Решено в D9. ACP задаёт `headers` один раз в `session/new` (как обновить без перезапуска, не проверено). Пока TTL 1 час на ход. Ходы длиннее требуют перезапуска с журнала.
5. **Харнессы и версия MCP.** Какую версию MCP говорят `claude-agent-acp` и `codex-acp` (не проверено). Поэтому держим обе эпохи.
6. **Имена тулов.** Ограничение `^[a-zA-Z0-9_-]{1,64}$` взято с запасом под API моделей (точный лимит у каждого провайдера не проверен). Спецификация MCP `2026-07-28` советует от 1 до 128 символов и разрешает ещё `.`; наш набор строже, это допустимо.
7. ~~**От чьего имени Deployment.**~~ Решено в D33: `effective_subject` SA deployment от 08. design.md не говорит. Предлагаю `run_as` = владелец Deployment, с проверкой прав при каждом запуске.
8. **Где хранить запреты компании.** Здесь они в Hub. Если 08 строит общий движок политик (например, OPA или Cedar), правила лучше перенести туда, а Hub оставить вычислителем.
9. **stdio-серверы на пользователя.** Сейчас один экземпляр на тенант с кредами тенанта. Креды человека для stdio не поддерживаем. Нужен ли экземпляр на человека.
10. ~~**Запуск stdio-серверов.**~~ Решено в D26: драйвер 04, профиль `service`. Свой runner Hub или общий Sandbox-драйвер (04) в режиме долгоживущего сервиса. Предлагаю общий интерфейс драйвера с профилем `service`.
11. **Токенизация pdn.** Вместо `«masked:pdn»` отдавать `{{pii:<id>}}`, который Hub сам раскрывает в аргументах тулов с допуском. Тогда агент может отправить письмо клиенту, не видя адреса. Отложено на вторую итерацию.
12. **Hub для внешних клиентов.** Опубликовать `/.well-known/oauth-protected-resource` с сервером авторизации 08, чтобы сотрудник подключал Hub к своему локальному клиенту. Это отдельный тип токена, не токен сессии.
13. **Режим `review` и стоимость.** Чей бюджет тратит модель-ревьюер: агента или тенанта.
