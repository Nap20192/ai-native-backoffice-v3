# Реестр MCP-серверов рабочего пространства

> **2026-10-17.** Остался только harness Pi, решение D41 в [decisions-2026-10-17.md](../decisions-2026-10-17.md). Пункты про ACP-агентов (шлюз MCP для ACP, токен Work на маршруте прокси, `acpMcpNote`, `harness-text.ts`) больше не действуют. Карточек harness нет, файла `N/lib/harness-cards/schema.ts` тоже. Образец таблицы, которую создаёт код, теперь `ensurePlatformMcpSchema` в `N/lib/platform-mcp/schema.ts`.

Черновик 1, 2026-10-16. Код не менялся, тесты не запускались. Факты сверены по коду и документации, источник указан у каждого.

Запрос владельца: «сделай возможность добавлять MCP-серверы, реестр какой-нибудь». Платформа OpenMA (`platform/`) работает в закрытом контуре банка за порталом БСБ, модели внутренние. Администратор добавляет внутренние серверы (портал, СЭД, кадровая система), проверяет подключение и видит инструменты. Агенты подключают серверы из реестра. По настройке сервер ищет и импортирует записи из официального каталога MCP.

Слова. «Реестр» это список MCP-серверов рабочего пространства на нашем сервере. «Каталог» это внешний список, из которого запись можно импортировать: официальный каталог MCP, его копия в контуре или встроенный список SaaS.

Пути:

- `N/` это `platform/apps/main-node/src`, `NT/` это `platform/apps/main-node/test`;
- `A/` это `platform/apps/agent/src`, `P/` это `platform/packages`, `C/` это `platform/apps/console/src`;
- `S/` это `.claude/skills/verify-agent-console`;
- `SDK` это `platform/node_modules/.pnpm/@modelcontextprotocol+client@2.0.0/node_modules/@modelcontextprotocol/client/dist/index.mjs`;
- `OMA/` это `~/tmp/repos/openma`, `QM/` это `~/tmp/repos/qm-upstream`, `V2/` это `/home/vnkjd/orca/projects/ai-native-backoffice-v2`.

## 0. Коротко

1. Реестр хранится на сервере: таблица `mcp_registry_servers` (её создаёт код, SQLite и Postgres) и API `/v1/oma/mcp_servers`. Читают все участники пространства, пишут владелец и администратор.
2. ID записи это имя сервера у агента (`zup`, `sed`). Запись хранит название, описание, транспорт, адрес или stdio-пакет, способ входа, ссылку на учётные данные хранилища, теги, автора, итог последней проверки и снимок инструментов.
3. Секретов в реестре нет. Токен лежит в хранилище секретов, запись ссылается на него. Прокси MCP берёт токен записи, если хранилища сессии ничего не дали.
4. «Проверить подключение» идёт с сервера тем же клиентом `connectHttpMcpClient` и тем же прокси `forwardWithRefresh`, что ход агента. Проверка читает `tools/list` с учётными данными записи и секретов не возвращает.
5. Проверка, каталог и ход агента обращаются наружу по одной сетевой политике: только http и https, без редиректов, внутренние адреса закрыты, пока их не откроют `MCP_ALLOW_HOSTS` или `MCP_BLOCK_PRIVATE_ADDRESSES=false`.
6. Каталог выключен по умолчанию. `MCP_PUBLIC_REGISTRY` задаёт адрес официального каталога или его копии в контуре. Встроенный список из 8 SaaS переезжает на сервер и становится разделом каталога под флагом `MCP_CATALOG_SAAS`.
7. Консоль получает страницу «MCP-серверы»: список, окно «Новый MCP-сервер» с вкладками «Вручную» и «Из каталога», карточку с инструментами и проверкой. Форма агента берёт серверы из реестра и включает инструменты по одному, по умолчанию «Спрашивать». Для «Спрашивать» странице сессии нужны кнопки «Разрешить» и «Отклонить», сейчас их нет.
8. Первая версия отдаёт агентам только Streamable HTTP. SSE и stdio реестр хранит, но агентам не отдаёт (раздел 2.2).
9. Десять единиц в три волны, около 50 часов работы агентов. Форму агента, `main.tsx` и `AppSidebar.tsx` трогаем только после коммита плана моделей и harness.

## 1. Что есть сейчас

| # | Факт | Источник |
|---|---|---|
| 1 | Реестр это массив `MCP_REGISTRY` из 8 внешних SaaS (Airtable, Amplitude, Asana, GitHub, Linear, Notion, Sentry, Slack) в бандле консоли. Запись: `id`, `name`, `url`. Его читают окно «Выбрать из списка» формы агента и поле «MCP-сервер» в окне учётных данных хранилища | `C/data/mcp-registry.ts:15-57`, `C/components/McpServerPickerModal.tsx:7`, `C/pages/VaultDetail.tsx:52, 1226` |
| 2 | Папку `C/data/` закрывает строка `data/` корневого `.gitignore`, в git она не попадала ни разу (`git log -- 'platform/apps/console/src/data/*'` пуст). Чистый клон консоль не собирает | `.gitignore:6`, `S/SKILL.md:15` |
| 3 | Агент хранит сервер по значению: `{name, type: "url", url}` или расширение `{type: "stdio", command, args, env}`. Схема strict, `url` проверяется только на непустую строку. Не больше 20 серверов, у каждого свой `mcp_toolset` | `P/managed-agents-api/src/contracts/agent-input-components.ts:131-149`, `P/managed-agents-application/src/agents/application.ts:352-383` |
| 4 | Прокси ищет токен только в хранилищах сессии (первые 100 записей каждого) строгим сравнением строк (`auth.mcpServerUrl !== server.url`). Нет записи, значит `null` и ответ 403. Слеш в конце адреса уже не совпадёт | `N/modules/node-managed.ts:141-211`, `N/lib/http-mcp-proxy.ts:48-55, 93-100` |
| 5 | Прокси всегда ставит `Authorization: Bearer`, других заголовков не умеет, редиректы не выполняет (`redirect: "manual"`). Сервер без входа сейчас не подключить | `P/vault-forward/src/index.ts:245-273`, `N/lib/http-mcp-proxy.ts:13-18` |
| 6 | Прокси шлёт каждый запрос на `target.upstreamUrl`, а не на адрес из запроса. Клиент SSE шлёт POST на второй адрес из события `endpoint`, поэтому SSE через прокси не заработает. `P/mcp` и не подключает `SSEClientTransport` | `N/lib/http-mcp-proxy.ts:67-68, 114-115`, `P/mcp/src/http-client.ts:1-6, 58-61` |
| 7 | Встроенный цикл бросает ошибку на stdio-сервер. ACP-агент в песочнице MCP на этом сервере не получает, консоль так и пишет | `A/harness/tools.ts:1139-1146`, `C/pages/agents/harness-text.ts:99-100` |
| 8 | На каждом ходе harness заново зовёт `connectHttpMcpClient` и `tools/list` через прокси (15 с), вызов ждёт до 60 с. Сбой убирает инструменты сервера на этот ход и пишет `session.warning` | `A/harness/tools.ts:56-62, 1152-1224` |
| 9 | Окружение `limited` без `allow_mcp_servers` молча выключает все MCP-серверы, флаг по умолчанию `false` | `A/harness/tools.ts:1135-1138`, `P/managed-agents-application/src/environments/application.ts:107` |
| 10 | Политика `mcp_toolset` без `default_config` у нас `always_allow`, у Claude `always_ask`. Форма агента пишет новому серверу `always_allow` | `P/managed-agents-application/src/agents/definition-resolution.ts:15-26`, `C/pages/agents/agentFormCodec.ts:615-621`, platform.claude.com/docs/en/managed-agents/permission-policies |
| 11 | Сервер принимает `user.tool_confirmation` и исполняет подтверждённый MCP-вызов через тот же прокси. Консоль это событие только читает, отправить не может | `N/lib/node-managed-session-runner.ts:441-485`, `N/modules/node-managed.ts:401-420`, `C/pages/SessionDetail.tsx:895, 957` |
| 12 | Маршрутов `/v1/oma/oauth/*` на Node нет, а консоль открывает `/v1/oma/oauth/authorize`. В upstream они есть только в Cloudflare-воркере | `C/pages/VaultDetail.tsx:918`, `OMA/apps/main/src/routes/oauth.ts:274, 519, 703` |
| 13 | Проверка учётных данных `mcp_oauth_validate` шлёт ручной `initialize` с версией 2025-06-18 и `tools/list` не читает. SDK 2.0.0 в режиме `auto` сначала шлёт `server/discover`, на ошибку JSON-RPC откатывается на `initialize`, 401 и 403 считает отказом | `P/managed-agents-adapters-runtime/src/credential-validation-probe.ts:10-22`, `SDK:2325-2380` |
| 14 | `listTools()` без курсора читает все страницы, кэш ответов свой у каждого `Client` | `SDK:4190-4205, 3027` |
| 15 | У skill-sources есть защита исходящих запросов: список закрытых сетей, `SKILL_SOURCES_ALLOW_HOSTS`, проверка адреса в момент соединения через `lookup`, без редиректов | `N/lib/skill-sources.ts:58-166`, `N/config.ts:281` |
| 16 | Роли `owner`, `admin`, `member` лежат в `membership.role`, проверяет их только `members.ts`. В режиме портала админ портала получает `admin`, строитель `member`, `owner` никто | `P/http-routes/src/tenants/members.ts:13-42, 105, 136`, `docs/plans/portal-sso.md`, раздел 2.2 |
| 17 | Образец таблицы, которую создаёт код: `harness_cards`, `ensureHarnessCardSchema`, ошибки `{error, field}` | `N/lib/harness-cards/schema.ts`, `routes.ts`, `docs/plans/models-harness.md`, раздел 3.7 |
| 18 | Фейк `platform/test/fakes/scripted-mcp-server.ts` перенесён из upstream как есть шагом 1 очистки ([cleanup.md](cleanup.md), 3.5): 221 строка, Apache-2.0. Из трёх тестов upstream с его импортом в копию попал только `NT/session-resume-mcp-live.test.ts`. Очистка 2026-10-19 удалила его вместе с мостом интеграций ([cleanup.md](cleanup.md), 5.1). Теперь фейк не импортирует ни один тест | `platform/test/fakes/scripted-mcp-server.ts`, `OMA/test/fakes/scripted-mcp-server.ts`, тест в коммите 5dc7d3e |
| 19 | План ассистента занимает имя `platform` и адрес `PLATFORM_MCP_URL`, добавляет в `NodeMcpProxyTarget` поле `fetcher` и свою ветку в `resolveNodeMcpProxyTarget` | `docs/plans/builder-agent.md:120-132` |

Образцы:

| Где | Что берём |
|---|---|
| QM: `QM/src/mcp/mcp-server-store.ts:1-37`, `QM/src/api/routes/admin/mcp-servers.ts:51-201` | реестр пишет только админ (в комментарии причина: SSRF и утечка данных), id по шаблону, адрес без логина, строки запроса и фрагмента, `tools/list` при сохранении, секреты в ответе заменены флагами |
| Dust: `~/tmp/repos/dust-docs/pages/docs_user_documentation_admins_tools_management_*.md` | админ добавляет сервер по адресу, учётные данные общие или личные |
| Claude: platform.claude.com/docs/en/managed-agents/mcp-connector, `.../vaults` | сервер в агенте без секретов, токен в хранилище по адресу, нормализация адреса, у MCP по умолчанию `always_ask` |
| GitHub Copilot: docs.github.com/en/copilot/concepts/mcp-management | режим «только реестр», сверка по адресу надёжнее сверки по имени |
| старая спека `docs/components/05-mcp-hub.md`, раздел 2 | `definition_hash` и `approved_hash`, статус «требует проверки» при смене описания |

## 2. Запись реестра

### 2.1 Поля

| Поле | Правило | Смысл |
|---|---|---|
| `id` | `^[a-z][a-z0-9-]{1,31}$`, уникален в пространстве, не меняется. Заняты `platform`, `catalog`, `settings`, `import` | имя сервера у агента, инструменты `mcp__<id>__<tool>` |
| `title` | 1-100 знаков | название |
| `description` | до 1000 знаков | для людей, модели не уходит |
| `transport` | `streamable_http`, `sse`, `stdio` | раздел 2.2 |
| `url` | `http:` или `https:`, до 2048 знаков, без логина, строки запроса и фрагмента, не меняется | адрес для `streamable_http` и `sse` |
| `url_key` | нормализованный `url` | уникален в пространстве, по нему прокси и форма находят запись |
| `stdio` | `command` (абсолютный путь), `args`, `env` без секретов, `package` (`registry_type` npm, pypi или oci, `identifier`, `version`) | для песочницы |
| `auth.mode` | `none`, `bearer`, `oauth` | способ входа |
| `auth.scope` | `shared` или `session` | чей токен: записи или сессии |
| `auth.credential` | `{vault_id, credential_id}` или `null` | ссылка на учётные данные хранилища при `shared` |
| `tags` | до 10 строк по 1-32 знака | фильтр |
| `enabled` | да или нет | доступна ли запись агентам |
| `trust_annotations` | да или нет | брать ли в расчёт `readOnlyHint` и `destructiveHint` сервера |
| `source` | `manual`, `catalog` (каталог, имя, версия), `builtin` | откуда запись |
| `check` | `status` (`never`, `ok`, `failed`), `error_code`, `error`, `checked_at`, `checked_by`, `credential`, `duration_ms` | итог последней проверки |
| `tools` | снимок последней удачной проверки: `name`, `title`, `description`, `input_schema`, `annotations`, `hash`, `review` | что увидит агент |
| `review_required` | да или нет | одобренное описание инструмента изменилось |
| `created_by`, `updated_by`, `created_at`, `updated_at` | | кто и когда |

`normalizeMcpUrl` переводит схему и хост в нижний регистр, убирает порт по умолчанию (80, 443) и слеш в конце пути. Тем же правилом сравниваются `url` агента, `mcp_server_url` учётных данных и `PLATFORM_MCP_URL`. Так делает Claude (platform.claude.com/docs/en/managed-agents/vaults).

### 2.2 Транспорт

| Транспорт | Проверка из реестра | Агент получает | Почему |
|---|---|---|---|
| `streamable_http` | да | да, встроенный цикл | клиент и прокси его умеют |
| `sse` | нет | нет, `enable` отвечает 409 | прокси шлёт все запросы на один адрес (раздел 1, пункт 6) |
| `stdio` | нет | нет, форма его не предлагает | встроенный цикл stdio не запускает, ACP-агент MCP не получает (пункт 7) |

SSE и stdio можно записать, чтобы реестр был полным списком систем банка. Агентам они станут доступны, когда прокси научится пересылать путь в пределах адреса записи, а ACP получит шлюз MCP.

### 2.3 Вход и учётные данные

| `auth.mode` | `auth.scope` | Где токен | Что делает прокси |
|---|---|---|---|
| `none` | нет | нигде | шлёт запрос без `Authorization` и удаляет входящий `Authorization` |
| `bearer` | `shared` | `static_bearer` в хранилище, на него ссылается запись | подставляет токен записи всем сессиям пространства |
| `bearer` | `session` | хранилище, которое пользователь подключил к сессии | ищет в хранилищах сессии, как сейчас |
| `oauth` | `shared` | `mcp_oauth` с `refresh` в хранилище записи | подставляет, при 401 обновляет и пишет новый токен в хранилище |
| `oauth` | `session` | `mcp_oauth` в хранилище сессии | как сейчас |

- Учётные данные записи лежат в хранилище того же пространства, их тип совпадает со способом входа (`static_bearer` для `bearer`, `mcp_oauth` для `oauth`), нормализованный `mcp_server_url` равен `url_key`. Иначе 400 с полем `auth.credential`.
- Токен OAuth пока вводится в хранилище вручную (access и refresh). Вход сотрудника через OAuth это отдельный шаг (раздел 9).

### 2.4 Хранение

Таблицы создаёт `ensureMcpRegistrySchema(sql)` при первом обращении, по образцу `ensureHarnessCardSchema`, шаги пишутся в `mcp_registry_schema_migrations`. Почему не миграция drizzle, сказано в `docs/plans/analytics.md`, раздел 4.1. Правила SQL для двух баз берём из раздела 4.7 того же плана: плейсхолдеры `?`, `Number()` при чтении `BIGINT`, JSON текстом, курсор без `OFFSET`.

```sql
-- шаг 0001_mcp_registry
CREATE TABLE IF NOT EXISTS mcp_registry_servers (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  transport TEXT NOT NULL,
  url TEXT,
  url_key TEXT,
  stdio_json TEXT,
  auth_mode TEXT NOT NULL,
  auth_scope TEXT NOT NULL,
  credential_vault_id TEXT,
  credential_id TEXT,
  tags_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  trust_annotations INTEGER NOT NULL,
  source_json TEXT NOT NULL,
  check_status TEXT NOT NULL,
  check_error_code TEXT,
  check_error TEXT,
  check_credential_json TEXT,
  check_duration_ms INTEGER,
  checked_at BIGINT,
  checked_by TEXT,
  tools_json TEXT NOT NULL,
  tools_checked_at BIGINT,
  approved_tools_json TEXT NOT NULL,
  review_required INTEGER NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_registry_servers_url_uq
  ON mcp_registry_servers (workspace_id, url_key) WHERE url_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS mcp_registry_events (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  at BIGINT NOT NULL,
  detail_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS mcp_registry_events_server_idx
  ON mcp_registry_events (workspace_id, server_id, at);
```

- Частичный уникальный индекс понимают и SQLite, и Postgres.
- Удаление стирает строку. В `mcp_registry_events` остаётся событие `delete` с адресом и автором. Другие действия журнала: `create`, `update`, `enable`, `disable`, `check`, `approve_tools`, `import`.
- Пределы: 200 записей на пространство, снимок до 256 инструментов и до 1 МБ JSON.

### 2.5 Изоляция по пространству

- Каждый запрос к таблицам несёт `workspace_id = ?` из `c.get("tenant_id")`. Чужой `id` даёт 404, а не 403, чтобы не выдать запись.
- Ссылку на учётные данные сервер читает через `managedCredentialStore.find({workspaceId, vaultId, credentialId})` с тем же пространством. Ссылку на хранилище другого пространства сохранить нельзя.
- Прокси ищет запись в пространстве сессии: `x-oma-tenant` ставит harness, HTTP-маршрут берёт `tenant_id` из входа.
- Общий только кэш поиска по каталогу, в нём публичные данные. Импорт пишет в пространство того, кто импортирует.

## 3. Сервер

### 3.1 Маршруты `/v1/oma/mcp_servers`

| Метод и путь | Кто | Что |
|---|---|---|
| `GET /` | участник | список: `q` (по `id`, `title`, `url`), `tag`, `enabled`, `limit` 1-100, `cursor`, порядок по `id` |
| `GET /settings` | участник | `registry_only`, источники каталога, `can_manage` |
| `POST /` | владелец, админ | создать запись |
| `GET /:id` | участник | запись со снимком инструментов и названием учётных данных |
| `POST /:id` | владелец, админ | правка `title`, `description`, `tags`, `auth`, `trust_annotations`, `stdio`. `id` и `url` не меняются |
| `POST /:id/enable`, `POST /:id/disable` | владелец, админ | включение требует `check.status = ok` (иначе 409) и одобряет текущий снимок |
| `POST /:id/check` | владелец, админ | проверка подключения, тело `{vault_id?}` для `scope: session` |
| `POST /:id/approve_tools` | владелец, админ | одобрить снимок и снять `review_required` |
| `GET /:id/events` | владелец, админ | последние 50 событий журнала |
| `DELETE /:id` | владелец, админ | удалить, ответ `{type: "mcp_server_deleted", id}` |
| `GET /catalog/search` | владелец, админ | поиск по каталогу, 3.4 |
| `POST /catalog/import` | владелец, админ | импорт записи каталога, 3.4 |

- Ошибки как у карточек harness: `{error: "<текст>", field: "<поле>" | null}`, коды 400, 403, 404, 409, 501.
- Роль читается из `membership` по `tenant_id` и `user_id`. Без пользователя (ключ API без `user_id`) писать нельзя. Токены `environment_work_session` и `sandbox_inference` получают 403 на все маршруты реестра. При `AUTH_DISABLED` писать можно всем.
- Тело с полями `token`, `access_token`, `refresh_token`, `client_secret` на любой глубине получает 400 «Секреты задаются в хранилище секретов».

Запись в ответе:

```json
{
  "type": "mcp_server",
  "id": "zup",
  "title": "ЗУП: кадры и зарплата",
  "description": "Отпуска, приказы, табель",
  "transport": "streamable_http",
  "url": "https://zup-mcp.example.local/mcp",
  "stdio": null,
  "auth": {
    "mode": "bearer",
    "scope": "shared",
    "credential": { "vault_id": "vlt_...", "credential_id": "vcrd_...", "display_name": "ЗУП, сервисная учётка", "found": true }
  },
  "tags": ["кадры"],
  "enabled": true,
  "trust_annotations": false,
  "source": { "type": "manual" },
  "check": {
    "status": "ok", "error_code": null, "error": null,
    "checked_at": "2026-10-16T09:12:03Z",
    "checked_by": { "user_id": "pu_17", "name": "Иванов И." },
    "credential": { "mode": "shared", "vault_id": "vlt_...", "credential_id": "vcrd_..." },
    "duration_ms": 412
  },
  "tools": [
    { "name": "get_vacation_balance", "title": null, "description": "...", "input_schema": {},
      "annotations": { "readOnlyHint": true }, "hash": "sha256:...", "review": "approved", "warnings": [] }
  ],
  "tools_checked_at": "2026-10-16T09:12:03Z",
  "tools_truncated": false,
  "review_required": false,
  "created_by": { "user_id": "pu_17", "name": "Иванов И." },
  "created_at": "...", "updated_at": "..."
}
```

`review` у инструмента: `approved`, `new`, `changed`. `warnings`: `long_description`, `invisible_chars`, `bad_name`, `name_too_long` (раздел 5.4).

### 3.2 Проверка подключения

1. Маршрут берёт запись своего пространства и собирает цель прокси `NodeMcpProxyTarget`: адрес записи и токен из ссылки (`shared`), из хранилища, которое выбрал пользователь (`session`), или без токена (`none`).
2. `createNodeMcpProxyBinding({resolveTarget: () => target, fetcher: guardedFetch})` даёт fetch прокси. Внутри тот же `forwardWithRefresh`: подстановка токена, обновление OAuth на 401 с записью в хранилище, вычистка заголовков, `redirect: "manual"`. Fetch пробы ставит заголовки `x-oma-tenant`, `x-oma-session` (значение `registry-check`) и `x-oma-mcp-server`, без них привязка отвечает 403. Прокси вычищает их перед апстримом (`P/vault-forward/src/index.ts:238-242`).
3. `connectHttpMcpClient({url, fetch, versionNegotiation: "auto", timeoutMs: 15000})` из `@open-managed-agents/agent/harness/tools` (main-node уже зависит от пакета, `platform/apps/main-node/package.json:32`), затем `listTools()` и `close()`.
4. Снимок. Для каждого инструмента `hash = sha256` канонического JSON из `name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`. Сравнение с одобренным снимком даёт новые, изменённые и удалённые. Изменение одобренного инструмента ставит `review_required`.
5. Запись получает `check.*`, при удаче снимок, и событие `check` в журнал.

| `error_code` | Когда | Текст в карточке |
|---|---|---|
| `blocked` | адрес закрыт сетевой политикой | «Адрес закрыт настройкой сервера» и причина |
| `unreachable` | DNS, отказ соединения, TLS | «Сервер недоступен» и причина |
| `timeout` | нет ответа за 15 с | «Сервер не ответил за 15 с» |
| `auth_failed` | 401 после попытки обновить токен | «Сервер отклонил учётные данные» |
| `forbidden` | 403 | «Сервер запретил доступ» |
| `redirect` | ответ 3xx | «Сервер отвечает перенаправлением, прокси по нему не идёт» |
| `protocol_error` | ответ не по MCP | «Ответ не по протоколу MCP» |
| `no_credentials` | ссылка битая или в хранилище нет записи для адреса | «Нет учётных данных для этого адреса» |

- Если инструментов больше 256 или снимок больше 1 МБ, снимок обрезается и получает `tools_truncated: true`.
- Текст ошибки режется до 500 знаков, известное значение токена в нём заменяется на `***`. Заголовки и тела запросов в лог не идут.
- На запись одна проверка за раз, на пространство не больше 10 проверок в минуту.

### 3.3 Прокси хода агента

`resolveNodeMcpProxyTarget` (`N/modules/node-managed.ts:141`) для управляемой сессии:

1. Если план ассистента уже сделан и `url` равен `PLATFORM_MCP_URL`, работает его ветка.
2. Сервер агента ищется по имени, только `type: url`, как сейчас.
3. Запись реестра ищется по `normalizeMcpUrl(server.url)`. Если запись выключена или ждёт одобрения, прокси отказывает. Если записи нет, а `MCP_REGISTRY_ONLY=true`, прокси тоже отказывает.
4. Затем хранилища сессии: первая запись `static_bearer` или `mcp_oauth` с тем же нормализованным адресом. Личный токен пользователя идёт раньше общего.
5. Затем запись `shared` со ссылкой: учётные данные из хранилища записи, с обновлением OAuth, как в ветке хранилища сессии. Общий код лежит в `credential-target.ts`.
6. Запись `none` даёт цель без токена.
7. Иначе `null` и 403, как сейчас.

- Отказ пишется в лог сервера строкой `mcp-proxy.refused` с причиной, сессией и именем сервера, без токена.
- Ветку старых сессий интеграций (`agent_snapshot`, `node-managed.ts:213-285`) не трогаем.
- Оба пути, in-process `mcpBinding` и HTTP-маршрут `/v1/oma/mcp-proxy` для ACP, зовут эту функцию и получают `guardedFetch` (`node-managed.ts:322`, `node-http.ts:444`).
- Новый guard `N/lib/mcp-registry/agent-guard.ts` стоит перед `/v1/agents` отдельно от `agent-config-guard.ts` плана моделей. При `MCP_REGISTRY_ONLY=true` он отклоняет агента с url-сервером не из включённых записей и с любым stdio-сервером: 400 «MCP-сервер <адрес> не найден в реестре пространства».

### 3.4 Каталог

Официальный каталог. Адрес `https://registry.modelcontextprotocol.io`, API `v0.1` заморожен с 2025-10-24, чтение без входа. `GET /v0.1/servers` принимает `search` (подстрока имени, описание не ищется), `limit` 1-100 (по умолчанию 30), `cursor`, `version=latest`, `updated_since`, `include_deleted`. Ответ `{servers: [{server, _meta}], metadata: {count, nextCursor}}`, статус в `_meta["io.modelcontextprotocol.registry/official"].status`: `active`, `deprecated` или `deleted`. Точная версия: `GET /v0.1/servers/{name}/versions/{version}`, имя кодируется. Форму ответа я проверил живым запросом 2026-10-16. Источники: github.com/modelcontextprotocol/registry, файлы `docs/reference/api/official-registry-api.md` и `docs/reference/api/openapi.yaml`.

Что внутри на 2026-10-16 (полная выгрузка шага разведки): 44 419 записей, remotes `streamable-http` 28 160, `sse` 1 108, записей только с пакетами 15 338. Почти всё это публичные сервисы третьих лиц, из контура они недоступны. За частными серверами каталог сам отсылает к реестру организации (`docs/modelcontextprotocol-io/about.mdx`). Данные отданы по CC0.

Поиск и импорт:

- Пустой `MCP_PUBLIC_REGISTRY` выключает каталог, вкладка «Из каталога» показывает причину.
- С `MCP_PUBLIC_REGISTRY=<адрес>` сервер ходит только на этот хост. https обязателен, http допустим только для хоста из `MCP_ALLOW_HOSTS`. Таймаут 15 с, без редиректов, ответ до 2 МБ, `limit` до 30, `version=latest` сервер ставит сам. Кэш ответов 5 минут, до 200 ключей.
- Своя копия для контура. Банк поднимает зеркало с тем же API v0.1 и пишет его адрес в `MCP_PUBLIC_REGISTRY`. Подходят образ официального реестра `ghcr.io/modelcontextprotocol/registry` с начальной загрузкой из файла (`MCP_REGISTRY_SEED_FROM`) и ToolHive Registry Server (github.com/stacklok/toolhive-registry-server, Apache-2.0, синхронизация с официальным каталогом плюс свои записи). Своего кода для этого не нужно. Ходить наружу через прокси банка main-node не умеет: `HTTPS_PROXY`, `ProxyAgent` и `setGlobalDispatcher` в `N/` не встречаются.
- Встроенный список из 8 SaaS переезжает из `C/data/mcp-registry.ts` в `N/lib/mcp-registry/catalog/builtin-saas.ts` и показывается разделом «Известные SaaS» при `MCP_CATALOG_SAAS=true`. По умолчанию раздел выключен. Этим серверам нужен OAuth, поэтому до входа через OAuth (раздел 9) проверка на них даст `auth_failed`.

Разбор `server.json` (`catalog/server-json.ts`):

| Что в записи каталога | Итог |
|---|---|
| `remotes[].type = streamable-http` без заголовков | импорт можно, `auth.mode = none`. Сервер может потребовать OAuth, это покажет проверка |
| то же с одним заголовком `Authorization` | импорт можно, `auth.mode = bearer`, токен вводит админ |
| другой заголовок (`X-API-Key` и т. п.) | нельзя: прокси ставит только `Authorization` |
| `{переменные}` в адресе | нельзя в первой версии |
| `type = sse` | нельзя, раздел 2.2 |
| только `packages` | показываем с пометкой «пакет stdio для песочницы», импорт позже |
| `status = deleted` | не показываем. `deprecated` показываем с пометкой |

- Разбор терпит неизвестные поля и любой `$schema`, проверяет имя шаблоном `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`, режет описание до 300 знаков. Иконки и ссылки наружу сервер не загружает.
- `POST /catalog/import {source, name, version, remote_url, id, title?}`. Сервер заново читает точную версию из каталога, ищет в ней `remote_url` (адресу из тела не верит) и создаёт запись `source: {type: "catalog", registry, name, version}` с `enabled: false`.

### 3.5 Настройки сервера

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `MCP_ALLOW_HOSTS` | пусто | что открыть во внутренней сети: `host`, `*.domain`, `host:port`, подсеть `10.20.0.0/16`. Разрешённый хост может быть по http |
| `MCP_BLOCK_PRIVATE_ADDRESSES` | `true` | закрыть частные сети `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7`. Loopback, link-local (с `169.254.169.254`), `0.0.0.0/8` и multicast закрыты всегда, открыть их может только явная строка в `MCP_ALLOW_HOSTS` |
| `MCP_REGISTRY_ONLY` | `false` | агенты ходят только на включённые записи реестра |
| `MCP_PUBLIC_REGISTRY` | пусто | адрес каталога или его копии, пусто значит выключено |
| `MCP_CATALOG_SAAS` | `false` | раздел «Известные SaaS» в каталоге |

Для банка: `MCP_ALLOW_HOSTS` со своими доменами или подсетями (пример `*.example.local`), `MCP_REGISTRY_ONLY=true`, `MCP_PUBLIC_REGISTRY` пуст или с адресом своего зеркала.

## 4. Консоль

### 4.1 Страница «MCP-серверы»

- Пункт меню «MCP-серверы» в группе «Инфраструктура» после «Хранилищ секретов», маршрут `/mcp-servers`, значок `ServerIcon` из lucide. Модуль `C/pages/mcp-servers/mcp-nav.ts` по образцу `C/pages/harnesses/harness-nav.ts`. Тот же пункт в командной палитре.
- Шапка: h1 «MCP-серверы», подзаголовок «Серверы, которые агенты пространства могут подключать», кнопка «Добавить сервер». У участника без роли кнопка выключена, подсказка «Добавлять серверы может администратор пространства».
- Таблица `DataTable`: «ID» моноширинным, «Название», «Транспорт» (Streamable HTTP, SSE, stdio), «Адрес» моноширинным с обрезкой (у stdio команда), «Вход» (Без входа, Токен, OAuth, с пометкой «общий» или «из сессии»), «Инструменты» (число или прочерк до первой проверки, чип «Требует проверки»), «Статус» (Работает, Ошибка, Не проверен, Выключен), «Обновлено».
- Поиск по ID, названию и адресу, чипы тегов. Пустое состояние «Серверов пока нет» с кнопкой «Добавить сервер».
- На 390 px строки идут карточками, горизонтальной прокрутки нет.

### 4.2 Окно «Новый MCP-сервер»

Вкладки «Вручную» и «Из каталога». Если каталог выключен, вторая вкладка выключена с причиной из `GET /settings`.

«Вручную»:

- `#mcp-server-id` «ID» с подсказкой шаблона, `#mcp-server-title` «Название», `#mcp-server-description` «Описание»;
- «Транспорт»: Streamable HTTP; stdio с пометкой «для песочницы, агентам пока не отдаётся»; SSE выключен с причиной;
- `#mcp-server-url` «Адрес»;
- «Вход»: «Без входа», «Токен», «OAuth». Для токена поля «Хранилище» (выбор или кнопка «Новое хранилище» с названием по умолчанию «MCP-серверы») и `#mcp-server-token` «Токен», переключатель «Общий для всех агентов» или «Из хранилищ сессии»;
- «Теги».

Кнопка «Добавить и проверить»:

1. Если введён токен, консоль создаёт учётные данные через `POST /v1/vaults/:id/credentials`: `static_bearer`, `mcp_server_url` равен адресу, `metadata.oma_mcp_server` равен ID. Если в хранилище уже есть запись для того же нормализованного адреса, окно предлагает взять её или заменить.
2. `POST /v1/oma/mcp_servers` со ссылкой на эти учётные данные.
3. `POST /v1/oma/mcp_servers/:id/check` и переход в карточку.

Ошибка сервера с `field` показывается под полем. Если упал шаг 2, окно сообщает, что учётные данные остались в хранилище, и даёт ссылку на них.

«Из каталога»: выбор источника (официальный каталог или его копия, «Известные SaaS»), поиск с подсказкой «Каталог ищет по имени, например github», строка результата: имя моноширинным, название, описание, версия, транспорт, «можно импортировать» или причина отказа. «Импортировать» открывает форму «Вручную» с заполненными полями. ID по умолчанию берётся из последней части имени.

### 4.3 Карточка `/mcp-servers/:id`

- Шапка: название, ID моноширинным с копированием, чипы транспорта, входа и статуса, кнопки «Проверить подключение» и «Включить для агентов» (или «Выключить»), меню «⋮» с пунктами «Изменить» и «Удалить».
- «Подключение»: адрес или команда, транспорт, источник (вручную или каталог с именем и версией).
- «Доступ»: способ входа, «общий» или «из сессии», ссылка на учётные данные (`/vaults/:id`), «Заменить токен» (новая запись в хранилище, старая архивируется). Для «из сессии» проверка спрашивает, какое хранилище взять.
- «Последняя проверка»: итог, время, кто проверял, под какими учётными данными, длительность, текст ошибки.
- «Инструменты»: имя моноширинным, название, описание целиком обычным текстом (без Markdown), чипы «только чтение» и «меняет данные» из аннотаций с пометкой «подсказка сервера», состояние «новый» или «изменён» с разницей описаний, предупреждения из 5.4, кнопка «Одобрить изменения».
- «Где используется»: агенты пространства с этим адресом. Консоль листает `GET /v1/agents` и сравнивает нормализованные адреса.
- «История»: `GET /:id/events`.
- У stdio и SSE кнопка «Проверить подключение» выключена с причиной.

### 4.4 Форма агента, вкладка «MCP-серверы»

- «Добавить из реестра» открывает `McpRegistryPicker`: поиск, строки ID, название, адрес. Недоступные строки выключены с причиной: «Выключен», «Не проверен», «Требует проверки», «stdio: только песочница», «Уже добавлен».
- Строка сервера из реестра: ID (он же имя, не правится), название, адрес только для чтения и редактор `McpToolsetEditor` по снимку: у каждого инструмента флажок «Включить» и сегмент «Спрашивать» или «Разрешать», кнопки «Включить все» и «Выключить все». Подпись: «Новые инструменты сервера выключены, пока вы их не включите».
- Кодек пишет `mcp_servers: [{type: "url", name: <id>, url}]` и `mcp_toolset` с `default_config: {enabled: false, permission_policy: {type: "always_ask"}}` и `configs` по включённым инструментам. Прежний `mcp_toolset` с политиками сохраняется, как сейчас (`agentFormCodec.ts:597-610`).
- «Разрешать» по умолчанию стоит только у инструмента с `readOnlyHint: true` на записи с `trust_annotations`. У остальных «Спрашивать».
- «Свой адрес» остаётся, пока `registry_only` выключен. Новый свой сервер тоже получает «Спрашивать», у строки чип «Нет в реестре». Неверная подсказка `https://mcp.github.com/sse` (`AgentFormDialog.tsx:1405`) уходит.
- Серверная политика по умолчанию у `mcp_toolset` теперь `always_ask`, как в CMA (раздел 1, пункт 10). Так решил владелец, решение 9 в `docs/plans/cma-wave-1.md`: иначе API и SDK остаются без защиты. У старых агентов политика записана явно и не меняется. Форма по-прежнему пишет политику явно.
- При ACP вкладка по-прежнему показывает пояснение `acpMcpNote` (`docs/plans/models-harness.md`, 6.5).

### 4.5 Хранилища и сессии

- Поле «MCP-сервер» в окне учётных данных хранилища подсказывает адреса из реестра вместо `MCP_REGISTRY` (`VaultDetail.tsx:1209-1244`). У учётных данных с `metadata.oma_mcp_server` ссылка на карточку сервера.
- Окно «Новая сессия» сравнивает хосты (`SessionsList.tsx:358-371`), а прокси сравнивает полный адрес. Предупреждение переходит на нормализованный адрес и молчит о серверах реестра с `none` и `shared`.
- То же окно предупреждает, если окружение `limited` без «Разрешить сетевой доступ MCP-серверам», а у агента есть MCP-серверы (раздел 1, пункт 9).
- `C/components/McpServerPickerModal.tsx` и импорты `C/data/mcp-registry.ts` удаляются. `C/data/templates.ts` остаётся в закрытой папке, правка `.gitignore` это отдельная задача (раздел 1, пункт 2).

### 4.6 Подтверждение вызова

Без кнопок политика «Спрашивать» останавливает ход, пока подтверждение не придёт через API. Сервер ждёт `user.tool_confirmation`, а консоль его не шлёт (раздел 1, пункт 11). Новый компонент `ToolConfirmationBar` показывается, когда последний `session.status_idle` несёт `stop_reason: {type: "requires_action", event_ids}`: над полем ввода «Агент просит разрешения: <инструмент> (<сервер>)», аргументы JSON, кнопки «Разрешить» и «Отклонить» с необязательной причиной. Клик шлёт `POST /v1/sessions/:id/events` с `{type: "user.tool_confirmation", tool_use_id, result: "allow" | "deny", deny_message?}` (`P/managed-agents-api/src/contracts/session-events.ts:131-139, 291-297`).

## 5. Безопасность

### 5.1 SSRF

- Добавить сервер может только владелец или администратор, как в QM (`QM/src/mcp/mcp-server-store.ts:1-6`). Запись направляет агентов на исходящий адрес, поэтому это право управления.
- Адрес: только `http:` и `https:`, без логина, строки запроса и фрагмента, до 2048 знаков. Запрещены адрес самой платформы (`PUBLIC_BASE_URL` и порт сервера) и `PLATFORM_MCP_URL`.
- Новый `N/lib/mcp-registry/outbound.ts` даёт `guardedFetch` на `node:http` и `node:https`, без новой зависимости. Адрес проверяется в момент соединения через `lookup`, как в `createSourceFetcher` (`N/lib/skill-sources.ts:122-166`). Ответ DNS, который сменился между проверкой и соединением, во внутреннюю сеть не пустит. Тело ответа идёт потоком (`Readable.toWeb`), `AbortSignal` соблюдается. Два уровня закрытых сетей из 3.5 требуют своих `BlockList`, поэтому список skill-sources берём как образец, а файл не меняем.
- Редиректы не выполняются ни при проверке, ни в ходе агента, ни при запросе к каталогу.
- Политика одна на три пути. Ход агента сейчас идёт по любому адресу из агента через глобальный `fetch`. После правки закрытый адрес получит отказ и в ходе, это видно в `session.warning` (раздел 9).
- Каталог: только хост из `MCP_PUBLIC_REGISTRY`. Адреса из записей каталога при поиске и импорте сервер не открывает. Первый запрос к ним идёт при проверке и под той же политикой.
- Вход через OAuth (раздел 9) будет брать метаданные только с хоста записи. Страница безопасности MCP описывает подмену `resource_metadata` и `token_endpoint` на внутренние адреса (modelcontextprotocol.io/docs/tutorials/security/security_best_practices).

### 5.2 Секреты

- В реестре нет секретов. Маршруты отклоняют секретные поля, ответы и журнал несут только ссылку `{vault_id, credential_id}` и название учётных данных.
- Токен вводится один раз в окне и уходит в API хранилища. Хранилище секрет не возвращает (`P/managed-agents-api/src/contracts/credentials.ts:161-184`).
- При `none` прокси удаляет входящий `Authorization`. На HTTP-маршруте прокси для ACP в нём лежит токен Work сессии (`P/acp-runtime/src/sandbox-agent.ts:258-274`). Сейчас его перезаписывает токен хранилища, а без перезаписи он ушёл бы на чужой сервер.
- Токен не попадает в агента, в песочницу и в события: его подставляет main-node, как сейчас.
- Общий токен записи получает каждый агент пространства с этим адресом. Для системы с личными правами (кадры) нужен режим «из хранилищ сессии» или вход сотрудника (раздел 9).

### 5.3 Проверка от имени пользователя

- Проверку запускает владелец или администратор в своём пространстве. Запись и учётные данные берутся только из этого пространства.
- Учётные данные задаёт запись: без входа, ссылка записи или хранилище, которое пользователь выбрал в окне (для «из сессии»). Своих ключей сервер не добавляет. Cookie, ключ API и `x-oma-*` пользователя наружу не уходят (`P/vault-forward/src/index.ts:225-243`).
- Набор инструментов может зависеть от учётных данных (спецификация MCP, раздел `server/tools`). Поэтому карточка пишет, кто проверял и под какими учётными данными снят список.
- Каждая проверка пишет событие `check` с автором.

### 5.4 Промпт-инъекция через описания инструментов

Описание и схема инструмента уходят в контекст модели как есть. Сервер может вписать туда указания для модели или сменить описание после одобрения. Атаку описали Invariant Labs 2025-04-01 (invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks), смену одобренной записи в Cursor закрыл CVE-2025-54136 (research.checkpoint.com/2025/cursor-vulnerability-mcpoison).

Меры первой версии:

- серверы добавляет только администратор и видит каждое описание целиком до включения;
- карточка показывает описание обычным текстом и помечает: длиннее 1024 знаков; невидимые знаки и знаки направления текста (U+200B..U+200F, U+202A..U+202E, U+2066..U+2069); имя не по шаблону `^[a-zA-Z0-9_-]{1,128}$`; полное имя `mcp__<id>__<tool>` длиннее 64 знаков;
- инструменты включаются по одному, новые выключены (`default_config.enabled: false`), политика по умолчанию «Спрашивать»;
- спецификация MCP велит не доверять аннотациям недоверенного сервера. Форма берёт `readOnlyHint` в расчёт только при `trust_annotations`;
- у каждого инструмента хеш. Смена одобренного описания ставит `review_required`, и прокси отказывает записи, пока администратор не одобрит изменения.

Что не закрыто. Harness читает `tools/list` на каждом ходе заново, и описание, изменённое между проверками, дойдёт до модели до следующей проверки. Закрыть это можно сверкой хеша на ходе: прокси читает ответ `tools/list` или harness получает список одобренных хешей. Это второй шаг (раздел 9). Результаты вызовов тоже недоверенный текст, реестр их не фильтрует.

### 5.5 Права

| Действие | Владелец, админ | Участник |
|---|---|---|
| смотреть реестр, инструменты, итог проверки | да | да |
| добавить, править, удалить, включить, проверить, одобрить, импортировать | да | нет, 403 |
| подключить сервер к агенту | да | да; при `MCP_REGISTRY_ONLY` только включённую запись |

## 6. Проверка в скилле verify-agent-console

### 6.1 Тестовый сервер

Новый `S/scripts/fake-mcp.mjs` по образцу `fake-model.mjs` и моков v2 (`V2/mocks/src/mcp.ts:29-109`): Streamable HTTP без сессии, ответы JSON, только POST.

- `POST /mcp` требует `Authorization: Bearer <непустой>`, иначе 401. `POST /open/mcp` без входа. GET и DELETE получают 405.
- `server/discover` и другие неизвестные методы получают ошибку JSON-RPC `-32601`, по ней SDK откатывается на `initialize` (`SDK:2344-2370`). Дальше `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
- Инструменты: `echo {text}` с `readOnlyHint: true` отвечает `VERIFY_MCP_OK_<n>`, `create_note {title}` отвечает `VERIFY_NOTE_OK_<n>`.
- `POST /control/tools-version {"version": 2}` меняет описание `echo`.
- Журнал JSONL: время, путь, метод, имя инструмента, первые 12 знаков sha256 токена (сам токен не пишется), заголовок `MCP-Protocol-Version`.
- `launch.sh` поднимает его на `VERIFY_FAKE_MCP_PORT` (8793), пишет PID с ролью `fake-mcp` и задаёт серверу `MCP_ALLOW_HOSTS=127.0.0.1:8793`. `cleanup.sh`, `doctor.sh` и `lib.sh` знают роль и порт.
- `fake-model.mjs` получает маркер `VERIFY_MCP_CALL nonce=<n>`: `tool_use` по инструменту из списка запроса, имя которого кончается на `__echo`, с `{text: "VERIFY_MCP_<n>"}`, после результата с `VERIFY_MCP_OK_<n>` текст `VERIFY_MCP_DONE_<n>`. Маркер `VERIFY_MCP_ASK nonce=<n>` делает то же с `create_note`.

### 6.2 Сценарий

`journey.sh --run <RUN> --scenario mcp-registry`, файл `S/scripts/journey-mcp-registry.mjs`, рецепт `S/features/mcp-registry.md` с разделом `Sub-features`, подфункции помечены `<!-- scenario: mcp-registry -->`, как у `claude-code`. Сценарий заводит своё окружение «Без ограничений»: главный сценарий ставит общему окружению сеть «Ограниченный» без MCP (раздел 1, пункт 9). Учётку B сценарий создаёт тем же `POST /auth/sign-up/email`, что `seed-user.sh`, хук Better Auth даёт ей своё пространство.

### 6.3 Жёсткие проверки

| id | Действие | Доказательство |
|---|---|---|
| `mcp.ui_add` | «MCP-серверы», «Добавить сервер», «Вручную»: ID `verify-<n>`, адрес `http://127.0.0.1:8793/mcp`, «Токен», новое хранилище, токен `verify-mcp-<n>`, «Общий для всех агентов», «Добавить и проверить» | строка таблицы: ID моноширинным, транспорт, адрес, «Токен», статус; `GET /v1/oma/mcp_servers/verify-<n>`; учётные данные в хранилище с этим `mcp_server_url`; строки токена нет ни в одном ответе API, ни в тексте страниц, ни в логе сервера |
| `mcp.ui_check_tools` | карточка, «Проверить подключение» | статус «Работает», в «Инструментах» `echo` и `create_note` с описаниями; `check.status = ok`; в журнале `fake-mcp` запрос `tools/list` на `/mcp` с sha256 токена, равным sha256 `verify-mcp-<n>` |
| `mcp.agent_from_registry` | новый агент, вкладка «MCP-серверы», «Добавить из реестра», `verify-<n>`, у `echo` «Разрешать», у `create_note` «Спрашивать», сохранить | `GET /v1/agents/:id`: сервер `{type: url, name: verify-<n>, url}`, `mcp_toolset` с `default_config.enabled = false` и двумя `configs` с этими политиками |
| `mcp.session_call` | сессия без хранилища, сообщение с `VERIFY_MCP_CALL nonce=<n>` | в журнале событий `agent.mcp_tool_use` (`mcp_server_name = verify-<n>`, `name = mcp__verify-<n>__echo`) и `agent.mcp_tool_result` с `VERIFY_MCP_OK_<n>`, ответ `VERIFY_MCP_DONE_<n>`; карточка вызова на странице сессии и строка во вкладке «Инструменты» инспектора; `vault_ids` сессии пуст, а sha256 токена в журнале `fake-mcp` совпал: токен пришёл из реестра |
| `mcp.blocked_address` | окно добавления с адресом `http://127.0.0.1:8792/mcp` (фейковая модель); по API `http://169.254.169.254/latest/meta-data/`, `http://127.0.0.1:8791/v1/agents`, `file:///etc/passwd` | ошибка под полем «Адрес»; ответы 400 с `field = url`; записей не прибавилось; в журнале фейковой модели нет новых строк за время шага |
| `mcp.workspace_isolation` | учётка B: страница «MCP-серверы», API, агент B с тем же адресом и его сессия | у B пустое состояние; `GET /v1/oma/mcp_servers` без `verify-<n>`; `GET`, `POST /check`, `DELETE` на `verify-<n>` дают 404; ход агента B пишет `session.warning`, а в журнале `fake-mcp` за время хода нет запросов |
| `mcp.none_no_auth` | вторая запись `verify-open-<n>` на `/open/mcp` со входом «Без входа», проверка и вызов из сессии | у запросов на `/open/mcp` в журнале `fake-mcp` нет заголовка `Authorization` |

Дополнительные проверки (после единицы CF-W и вместе с ней):

| id | Действие | Доказательство |
|---|---|---|
| `mcp.ask_confirm` | маркер `VERIFY_MCP_ASK`, ход останавливается, «Разрешить» | `session.status_idle` с `requires_action`; `tools/call create_note` в журнале `fake-mcp` позже клика; `agent.mcp_tool_result` с `VERIFY_NOTE_OK_<n>` |
| `mcp.review_on_change` | `fake-mcp` меняет описание `echo`, «Проверить подключение» | чип «Требует проверки», `review_required = true`, ход агента получает `session.warning`; после «Одобрить изменения» вызов проходит |
| `mcp.member_forbidden` | участник с ролью `member` по приглашению | кнопка «Добавить сервер» выключена, `POST` даёт 403 |

Ловушка. Harness pi прячет MCP-инструменты за `tool_search`, если их описания занимают заметную долю окна модели (`A/harness/assembly/strategies/exposure.ts:33-79`). С двумя инструментами этого не бывает, но сценарий сверяет, что в запросе к фейковой модели есть `mcp__verify-<n>__echo`.

## 7. Единицы работы

Правила:

- у файла один владелец, новые файлы названы явно;
- строгий TDD: сначала падающий тест. Тесты и сборка через `test-slot` и бинарники из `node_modules`, тяжёлые процессы по одному;
- коммиты делает координатор. Единицы не зовут `git commit`, `git add`, `git reset`, `git stash`, `git checkout`;
- тексты по правилам unslop, проверка `node scripts/unslop-check.mjs <файлы>`;
- значения `platform/.env` не читать;
- `node-http.ts`, `node-managed.ts`, `config.ts`, `.env.example`, `main.tsx`, `AppSidebar.tsx`, `AgentFormDialog.tsx`, `agentFormCodec.ts` правят только SW и CW после коммита плана моделей и harness (его C1 и WIRE, `docs/plans/models-harness.md`, раздел 8). Перед правкой файл перечитывается, правка точечная. Порядок с другими планами сверяется с таблицей передач `docs/plans/console-parity.md`, раздел 5.3;
- консоль пишет по контракту разделов 2-4 на подставных ответах `msw`. Изменение контракта сначала вносится в этот файл.

| id | Исполнитель | Волна | Что | Зависит от | Оценка |
|---|---|---|---|---|---|
| R1 | Opus | 1 | таблицы, хранилище, проверка полей, маршруты, роли, guard агентов | контракт | 6 ч |
| R2 | Opus | 1 | сетевая политика, проба, прокси без токена, возврат `scripted-mcp-server` | `types.ts` (первый шаг R1) | 5 ч |
| R3 | Codex | 1 | клиент каталога, разбор `server.json`, список SaaS, маршруты каталога | `types.ts` (первый шаг R1) | 5 ч |
| CR | Sonnet | 1 | страница, окно, карточка, клиент API | контракт | 8 ч |
| CT | Sonnet | 1 | выбор из реестра, редактор инструментов, функции `mcp_toolset` | контракт | 4 ч |
| CF | Sonnet | 1 | компонент подтверждения вызова | нет | 3 ч |
| SW | Opus | 2 | подключение на сервере, сквозные тесты, runbook | R1, R2, R3, коммит плана моделей | 5 ч |
| CW | Sonnet | 2 | форма агента, меню, палитра, хранилище, окно сессии | CR, CT, коммит C1 и WIRE плана моделей | 5 ч |
| CF-W | Sonnet | 2 | кнопки на странице сессии | CF; `SessionDetail.tsx` свободен от работы по трейсу | 2 ч |
| V | Opus | 3 | сценарий `mcp-registry` в скилле | SW, CW (CF-W для `mcp.ask_confirm`), свободные файлы `S/` | 7 ч |

### R1. Реестр на сервере (Opus)

Файлы, все новые: `N/lib/mcp-registry/types.ts`, `url.ts`, `validation.ts`, `schema.ts`, `store.ts`, `roles.ts`, `routes.ts`, `agent-guard.ts`, `index.ts`; `NT/mcp-registry-url.test.ts`, `mcp-registry-validation.test.ts`, `mcp-registry-store.test.ts`, `mcp-registry-routes.test.ts`, `mcp-registry-agent-guard.test.ts`, `mcp-registry.postgres.test.ts` (`it.skipIf(!process.env.OMA_TEST_POSTGRES_URL)`).

Что сделать: разделы 2, 3.1, 3.2 без самой пробы и guard агентов из 3.3. Первым шагом R1 пишет `types.ts`: типы записи, интерфейсы `McpRegistryStore` и `McpProbePort`, ошибку `McpRegistryError` с `status` и `field`. После этого шага начинают R2 и R3. Маршрут проверки зовёт `McpProbePort`, его реализует R2. Зависимости маршрутов приходят параметрами: `store`, `probe`, `credentials.find`, `roleOf`, `userName`, `settings`. Маршруты каталога R3 получают проверку роли из `roles.ts` тоже параметром.

Первый падающий тест: `normalizeMcpUrl("HTTPS://Zup.Example.local:443/mcp/")` возвращает `https://zup.example.local/mcp`.

Приёмка:

- схема создаётся дважды без ошибки, шаг пишется один раз; тот же набор на Postgres;
- проверка полей отклоняет `id` с `__`, `Platform` и `catalog`, адрес `ftp:`, с логином, с `?x=1`, с `#a`, секретное поле на любой глубине, ссылку на учётные данные чужого пространства и неверного типа;
- 409 на повтор `id` и нормализованного адреса, на `enable` без удачной проверки и на SSE;
- участник получает 403 на запись, чужое пространство получает 404 на всё;
- guard при `MCP_REGISTRY_ONLY` отклоняет агента с адресом не из реестра, пропускает адрес записи, тело доходит до маршрута;
- тесты и `tsc --noEmit` в main-node зелёные.

### R2. Сеть, проба и прокси (Opus)

Файлы:

- новые `N/lib/mcp-registry/outbound.ts`, `probe.ts`, `credential-target.ts`, `NT/mcp-registry-outbound.test.ts`, `NT/mcp-registry-probe.test.ts`;
- `platform/test/fakes/scripted-mcp-server.ts` уже в копии (cleanup.md, 3.5), R2 берёт его без правок;
- правка `P/vault-forward/src/index.ts` и `P/vault-forward/test/vault-forward.test.ts`: `accessToken: string | null`, без токена `Authorization` удаляется;
- правка `N/lib/http-mcp-proxy.ts` и `NT/http-mcp-proxy.test.ts`: `accessToken?: string` в `NodeMcpProxyTarget`.

Что сделать: `createMcpOutboundPolicy(config)` и `guardedFetch` по 3.5 и 5.1; `probeMcpServer({target, url, fetch, timeoutMs})` по 3.2 с кодами ошибок; `targetFromCredential(record, store)` с обновлением OAuth, общий для прокси и пробы.

Первый падающий тест: `forwardWithRefresh` с `accessToken: null` и входящим `authorization: Bearer work` шлёт апстриму запрос без `Authorization`.

Приёмка:

- политика закрывает `127.0.0.1`, `::1`, `169.254.169.254`, `10.1.2.3` (при `true`), имя, которое резолвится в закрытый адрес; открывает `127.0.0.1:8793` из списка и закрывает `127.0.0.1:8792`; понимает `*.example.local` и подсеть; редирект не выполняет;
- проба против `scripted-mcp-server`: `ok` со снимком и хешами; 401 даёт `auth_failed` после одной попытки обновления; 403 `forbidden`; 3xx `redirect`; зависание `timeout`; 300 инструментов дают 256 и `tools_truncated`; токен в тексте ошибки заменён;
- фейк `scripted-mcp-server` берёт тест пробы выше: других тестов с его импортом в копии нет, очистка 2026-10-19 удалила `NT/session-resume-mcp-live.test.ts`;
- тесты `P/vault-forward` и main-node, `tsc --noEmit` зелёные.

### R3. Каталог (Codex)

Файлы, все новые: `N/lib/mcp-registry/catalog/types.ts`, `server-json.ts`, `client.ts`, `builtin-saas.ts`, `routes.ts`, `index.ts`; `NT/mcp-catalog-server-json.test.ts`, `NT/mcp-catalog-client.test.ts`, `NT/mcp-catalog-routes.test.ts`; выборки `NT/_fixtures/mcp-catalog/*.json`, собранные вручную по `openapi.yaml`: remote без заголовков, с `Authorization`, с `X-API-Key`, с переменной, `sse`, только пакеты, `deleted`, `deprecated`, неизвестные поля и чужой `$schema`.

Что сделать: 3.4. `parseCatalogServer(raw)` отдаёт нормализованную запись и у каждого remote `importable` с причиной. `createCatalogClient({baseUrl, fetch, cacheTtlMs})` с методами `search({q, cursor})` и `version({name, version})`. Маршруты `GET /search` и `POST /import`, запись создаётся через `McpRegistryStore` из `types.ts` R1. SW монтирует их на `/v1/oma/mcp_servers/catalog` раньше маршрутов R1.

Первый падающий тест: `parseCatalogServer(fixture("sse-only"))` даёт remote с `importable: false` и причиной «SSE не поддерживается».

Приёмка:

- все выборки разбираются, неизвестные поля не роняют разбор;
- клиент ходит только на хост из настройки, сам ставит `version=latest`, `limit` не больше 30, курсор передаёт как есть; редирект, ответ больше 2 МБ и таймаут дают ошибку с текстом; повтор в пределах 5 минут идёт из кэша;
- импорт читает точную версию из каталога, отклоняет `remote_url`, которого нет в версии, и создаёт запись выключенной;
- при пустом `MCP_PUBLIC_REGISTRY` и выключенном SaaS маршруты отвечают 404 «Каталог выключен»;
- тесты и `tsc --noEmit` зелёные.

### CR. Консоль реестра (Sonnet)

Файлы, все новые: `C/lib/mcp-servers-api.ts`, `C/lib/mcp-servers-api.test.ts`; `C/pages/mcp-servers/McpServersPage.tsx`, `McpServerDetail.tsx`, `AddMcpServerDialog.tsx`, `McpCatalogTab.tsx`, `McpToolsTable.tsx`, `McpAccessSection.tsx`, `mcp-server-form.ts`, `mcp-nav.ts`, тесты `McpServersPage.test.tsx`, `McpServerDetail.test.tsx`, `AddMcpServerDialog.test.tsx`, `mcp-server-form.test.ts`.

Что сделать: 4.1-4.3 и 5.4 (пометки описаний). `mcp-nav.ts` экспортирует путь, подпись, значок и `load` списка и карточки для CW.

Первый падающий тест: список на подставном ответе показывает `zup` моноширинным, «Токен» и «Работает».

Приёмка: окно делает три запроса в порядке 4.2 и показывает ошибку поля; у участника кнопки управления выключены; карточка показывает «изменён» с разницей и пометки 5.4; скриншоты на 1280 и 390 px без горизонтальной прокрутки; тесты и `tsc --noEmit` консоли зелёные.

### CT. Компоненты формы агента (Sonnet)

Файлы, все новые: `C/components/mcp/McpRegistryPicker.tsx`, `McpToolsetEditor.tsx` и их тесты; `C/pages/agents/mcp-toolset.ts`, `mcp-toolset.test.ts`.

Что сделать: 4.4. Компоненты получают записи пропсами. Тип записи структурный и объявлен в `mcp-toolset.ts`, импорта из CR нет. Функции `buildMcpToolset(entry, choices, prior?)` и `readMcpToolset(toolset)`. План console-parity (K9) может взять `McpRegistryPicker` вместо своего `McpServerPopover`.

Первый падающий тест: `buildMcpToolset({id: "zup"}, {echo: "always_allow"})` даёт `{type: "mcp_toolset", mcp_server_name: "zup", default_config: {enabled: false, permission_policy: {type: "always_ask"}}, configs: [{name: "echo", enabled: true, permission_policy: {type: "always_allow"}}]}`.

Приёмка: прежние `configs` с инструментами, которых нет в снимке, сохраняются; недоступные строки выбора выключены с причиной; «Разрешать» по умолчанию только при `trust_annotations` и `readOnlyHint`.

### CF. Компонент подтверждения (Sonnet)

Файлы, все новые: `C/components/tool-confirmation/ToolConfirmationBar.tsx`, `ToolConfirmationBar.test.tsx`, `pending-confirmation.ts`, `pending-confirmation.test.ts`. Папку `C/components/session/` не трогаем, её держит страница сессии.

Что сделать: 4.6. `pendingConfirmations(events)` берёт `event_ids` из последнего `session.status_idle` с `requires_action` и отдаёт вызовы `agent.tool_use` и `agent.mcp_tool_use`, на которые ещё нет `user.tool_confirmation`.

Первый падающий тест: журнал с `agent.mcp_tool_use` и `session.status_idle` (`requires_action`, его id) даёт один ожидающий вызов, после `user.tool_confirmation` ни одного.

Приёмка: «Разрешить» и «Отклонить» шлют тело по контракту; кнопки выключены, пока запрос идёт; тесты консоли зелёные.

### SW. Подключение на сервере (Opus)

Файлы:

- правка `N/modules/node-managed.ts`: хранилище реестра, `guardedFetch` в `createNodeMcpProxyBinding`, ветка реестра в `resolveNodeMcpProxyTarget` по 3.3 через `credential-target.ts`, нормализованная сверка адреса хранилищ сессии;
- правка `N/modules/node-http.ts`: маршруты `/oma/mcp_servers/catalog` и `/oma/mcp_servers`, `guardedFetch` для `/oma/mcp-proxy`, `v1.use("/agents/*", mcpRegistryAgentGuard(...))`, `roleOf` и `userName`;
- правка `N/config.ts` и `NT/config.test.ts`: переменные 3.5; `platform/.env.example`: закомментированные строки с пояснением;
- новые `NT/mcp-registry-http.test.ts`, `NT/mcp-registry-session-proxy.test.ts`, `docs/runbook-mcp-registry.md` (настройки для банка, как добавить внутренний сервер, своя копия каталога).

Первый падающий тест по образцу удалённого `NT/session-resume-mcp-live.test.ts` (`git show 5dc7d3e:platform/apps/main-node/test/session-resume-mcp-live.test.ts`): агент с сервером записи `shared`, сессия без хранилищ, harness вызывает инструмент, и `scripted-mcp-server` получает `Authorization: Bearer <токен записи>`.

Приёмка:

- HTTP: CRUD, роли, 404 из чужого пространства, проверка против тестового сервера, каталог на подставном каталоге;
- ход агента: `shared` без хранилищ; `none` без `Authorization`, в том числе на маршруте ACP с токеном Work; выключенная запись и `review_required` дают отказ и `session.warning`; `MCP_REGISTRY_ONLY` даёт 400 на агента и отказ в прокси; учётные данные со слешем в конце адреса находятся;
- закрытый адрес в агенте при `MCP_BLOCK_PRIVATE_ADDRESSES=true` даёт `session.warning`, запроса наружу нет;
- весь `vitest run` в main-node зелёный, старые тесты не ослаблены, `tsc --noEmit` зелёный, `unslop-check` для runbook без нарушений.

### CW. Подключение в консоли (Sonnet)

Файлы: правка `C/pages/agents/AgentFormDialog.tsx` и теста, `C/pages/agents/agentFormCodec.ts` и теста, `C/main.tsx`, `C/components/AppSidebar.tsx`, `C/components/AppSidebar.linear.test.tsx`, `C/components/CommandPalette.tsx`, `C/pages/VaultDetail.tsx`, `C/pages/VaultDetail.linear.test.tsx`, `C/pages/SessionsList.tsx`, `C/pages/SessionsList.test.tsx`; удаление `C/components/McpServerPickerModal.tsx` и его теста.

Что сделать: 4.4 и 4.5, маршрут и пункт меню из `mcp-nav.ts`.

Первый падающий тест: в форме агента выбор `zup` из реестра даёт в YAML сервер `zup` и `mcp_toolset` с `default_config.enabled: false`.

Приёмка: пункт меню стоит после «Хранилищ секретов», тест порядка обновлён; форма не импортирует `C/data/mcp-registry.ts`; предупреждение окна «Новая сессия» молчит про сервер `shared` и говорит про `limited` без MCP; тесты и `tsc --noEmit` консоли зелёные.

### CF-W. Кнопки на странице сессии (Sonnet)

Файлы: правка `C/pages/SessionDetail.tsx` и `C/pages/SessionDetail.prompt.test.tsx`. Страница сессии закоммичена в `be18a3d`. Перед правкой сверить, не держит ли файл работа по трейсу (`docs/plans/agent-trace.md`): её папка `C/components/session/trace/` ещё не в git.

Приёмка: при `requires_action` над полем ввода видна плашка, «Разрешить» шлёт `user.tool_confirmation`, ход продолжается в том же потоке.

### V. Скилл (Opus)

Файлы: новые `S/scripts/fake-mcp.mjs`, `S/scripts/journey-mcp-registry.mjs`, `S/features/mcp-registry.md`; правка `S/scripts/fake-model.mjs`, `launch.sh`, `journey.sh`, `cleanup.sh`, `doctor.sh`, `lib.sh`, `S/SKILL.md`, `S/features/README.md`, `S/features/vaults-and-mcp.md`. Файлы `S/` V берёт после текущего владельца по цепочке `docs/plans/console-parity.md`, раздел 5.3.

Что сделать: раздел 6. Проверки пишутся до того, как готовы SW и CW, и сначала красные.

Приёмка: цепочка `launch, doctor, seed-user, journey --scenario mcp-registry, cleanup` даёт «ПРОЙДЕН» с семью жёсткими проверками; главный сценарий и `claude-code` не ослаблены; в `summary.md` нет токена.

## 8. Волны и оценка

| Волна | Параллельно | Условие старта | Время |
|---|---|---|---|
| 1 | R1, CR, CT сразу; R2 и R3 после `types.ts` из R1; CF вторым заходом | сейчас, только новые файлы плюс `P/vault-forward` и `http-mcp-proxy.ts` | 8 ч |
| 2 | SW, CW, CF-W | коммит волны 1; для SW и CW коммит C1 и WIRE плана моделей; для CF-W свободный `SessionDetail.tsx` | 5 ч |
| 3 | V, затем прогон владельцем стенда | коммит волны 2 и свободные файлы `S/` | 7 ч |

Сумма около 50 часов работы агентов, по времени около 20 часов без ожидания чужих коммитов. Каждая волна кончается коммитом координатора и `graphify update .`.

## 9. Риски и что позже

Риски:

- Обновление закроет внутренние адреса в ходе агента. Установка, где агенты уже ходят на внутренний MCP, после SW получит отказ, пока не задан `MCP_ALLOW_HOSTS`. Строка идёт в runbook и в заметку к выпуску.
- Общий токен записи открывает права сервисной учётки всем агентам пространства (5.2).
- Описание инструмента может смениться между проверками (5.4).
- Без CF-W политика «Спрашивать» останавливает ход в консоли. Форма с CW ставит её по умолчанию, поэтому CW и CF-W лучше выпускать вместе.
- Тестовый MCP-сервер в скилле работает в старой эпохе протокола через откат SDK. Сервер только новой эпохи (`server/discover` без `initialize`) мы не проверяем, SDK его поддерживает.
- План ассистента и этот план правят `http-mcp-proxy.ts` и `resolveNodeMcpProxyTarget`. Поле `fetcher` ассистента и необязательный токен совместимы, порядок веток задан в 3.3.
- Связку с моками v2 (`V2/mocks`, порт 8800) вживую не проверяли. Мок отвечает 421 на Host не из `MOCK_ALLOWED_HOSTS` и 415 без `content-type: application/json` (`V2/mocks/src/server.ts:18, 50-55`).

Позже, отдельными шагами:

1. Вход через OAuth на Node: перенос `OMA/apps/main/src/routes/oauth.ts` (discovery по `.well-known/oauth-protected-resource`, PKCE S256, проба `tools/list` после входа), состояние в БД, а не в KV.
2. Личный вход сотрудника (`scope: session` с OAuth от имени человека) через вход портала.
3. Сверка хеша инструментов на ходе и фоновая перепроверка записей.
4. SSE: прокси пересылает путь в пределах адреса записи, `P/mcp` откатывается на `SSEClientTransport`.
5. stdio из реестра для ACP-агентов, когда у ACP появится шлюз MCP.
6. Заголовки кроме `Authorization` (`X-API-Key`) и `client_credentials`.
7. Локальная копия каталога с поиском по описанию (синхронизация по `updated_since`).
8. Классы данных и запись, черновик или чтение по инструменту, как в реестре v2 (`V2/services/capability/registry/servers/zup.yaml:1-40`).
