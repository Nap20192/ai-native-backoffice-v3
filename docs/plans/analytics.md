# Аналитика: контракт сервера и консоли

> Отменено владельцем 2026-10-16: модели внутренние, токены и стоимость не отслеживаем. Код аналитики удалён из консоли и сервера. Документ оставлен как история решения.

Черновик 1, 2026-10-16. Только чтение кода и документов, код не менялся, тесты не запускались.

Входы:

- описание раздела в консоли Claude: [04-analytics.md](../cma-console/04-analytics.md), скриншоты в `.audit/cma-screens/04-analytics/`;
- сравнение с нашей консолью: [04-analytics-gap.md](../cma-console/04-analytics-gap.md);
- раздел 3 плана [models-harness-analytics.md](models-harness-analytics.md) (таблица фактов `model_calls`, цены, API `/v1/oma/analytics/*`).

Этот документ заменяет разделы 3.7, 3.9 и 3.11 плана и список файлов единицы S3 в части аналитики. Остальной план не меняется.

Обозначения путей: `P/` это `platform`, `N/` это `platform/apps/main-node`, `C/` это `platform/apps/console/src`. Пути от корня репозитория `/home/vnkjd/orca/projects/ai-native-backoffice-v3`.

## 0. Коротко

1. Раздел «Аналитика» в консоли получает пять страниц, как в Claude: «Использование», «Кэширование», «Лимиты», «Стоимость», «Журнал запросов». Маршруты `/analytics/usage`, `/analytics/caching`, `/analytics/limits`, `/analytics/cost`, `/analytics/logs`.
2. Источник всех цифр один: таблица фактов `model_calls`, одна строка на событие `span.model_request_end`. Сервер пишет строку, когда кадр события уже отдан в журнал сессии.
3. Факты пишет обёртка над `NodeManagedSessionRunner`. Она перехватывает `output(frame)` хода и не меняет harness, runtime и runner. Подключение одной строкой в `node-managed.ts` делаем после коммита чужих правок.
4. Таблицы создаёт код при первом обращении (`CREATE TABLE IF NOT EXISTS` и список шагов миграции), как в `runtime-resource-fence-sql`, `mcp-access-loss` и `event-log`. Drizzle-миграцию `0028` не делаем, причины в разделе 4.1.
5. Лимиты на карточку модели (запросы, токены входа и выхода в минуту) хранятся в отдельной таблице `model_card_limits` по `card_id`. Пакет `model-cards-store` не меняется, причины в разделе 4.3. Лимиты только для наблюдения: платформа не останавливает вызовы.
6. Цена берётся из `pi_config.cost` карточки, иначе из каталога Pi, иначе цены нет. Стоимость считается в момент записи и хранится в миллионных долях доллара, по частям (вход, выход, чтение кэша, запись кэша).
7. API: девять маршрутов под `/v1/oma/analytics`. Все даты по UTC. Выгрузка CSV у отчёта использования и у журнала.
8. Все новые файлы сервера лежат в `N/src/lib/analytics/` и `N/test/`. Консоль получает новые файлы в `C/pages/analytics/`, `C/components/analytics/`, `C/lib/analytics-api.ts` и правит три файла: `main.tsx`, `AppSidebar.tsx`, `AppSidebar.linear.test.tsx`. Пересечений нет.

## 1. Что меняется относительно плана

| Тема | В плане | В контракте | Почему |
|---|---|---|---|
| Страницы | три: использование, стоимость, журнал (раздел 3.1) | пять: плюс «Кэширование» и «Лимиты» | данные для кэша в фактах уже есть; лимиты задаёт владелец карточки, пик считается по фактам |
| Схема | drizzle-миграция `0028_model_calls` в двух каталогах | код `ensureAnalyticsSchema(sql)` с таблицей шагов `analytics_schema_migrations` | раздел 4.1 |
| Где пишется факт | правка `node-managed-harness-runtime.ts`, runner и подагентов | новая обёртка `withModelCallRecording` над runner | правки чужих файлов не нужны, подагенты идут через тот же `output` |
| Модель в строке | handle и `wire_model` | то же плюс `card_id`, `model_source`, `agent_name`, `environment_id`, `thread_id` | фильтр по карточке, группировка по окружению, подписи без лишних запросов |
| Стоимость | одно число | число и четыре части | группировка стоимости по типу токена |
| Корзины графика | только день | день и час (`bucket=hour` до 7 дней) | приближение графика по клику до суток, графики кэша по часам |
| Лимиты | не делаем | таблица `model_card_limits`, пик по минутам за 24 часа | запрос владельца |
| Журнал | курсор и фильтры | плюс `q` по ID, `latest_ended_at`, отдельная запись `GET /model_calls/:id` | подпись «Данные на …», карточка записи по ссылке |
| `session.usage` | чинится в S3 | не входит в этот контракт | правка `node-managed-harness-runtime.ts` вне списка новых файлов, см. раздел 9 |

## 2. Откуда берутся факты

### 2.1 Событие `span.model_request_end`

Тип описан в `P/packages/api-types/src/types.ts:669-705`. Поля, которые читает запись факта:

| Поле | Тип | Что значит для нас |
|---|---|---|
| `id` | строка | ID события. Pi его не задаёт, runtime ставит `sevt_…` (`N/src/lib/node-managed-harness-runtime.ts:304`). Это первичный ключ строки факта |
| `processed_at` | ISO-строка | штамп runtime (`node-managed-harness-runtime.ts:306`), строго растёт внутри хода. Отсюда `ended_at` |
| `model_request_start_id` | строка | ID парного `span.model_request_start`. Его `processed_at` даёт `started_at` |
| `model` | строка | у Pi это `wire_model` (`ctx.pi.model.id`), у ACP это handle агента (`acp-sandbox-loop.ts:138-140`). Для строки факта не используется, кроме запасного варианта в разделе 2.4 |
| `provider_response_id` | строка | ID ответа провайдера (`msg_…`) |
| `model_usage.input_tokens` | число | вход без кэша: у Pi `usage.input` не включает чтение и запись кэша (`@earendil-works/pi-ai/dist/models.js:658-674` складывает `input + cacheRead + cacheWrite`) |
| `model_usage.output_tokens` | число | выход |
| `model_usage.cache_read_input_tokens` | число | чтение кэша |
| `model_usage.cache_creation_input_tokens` | число | запись кэша, одна цифра без деления на 5 минут и 1 час |
| `finish_reason` | строка | `stop`, `length`, `tool-calls`, `error`, `aborted`, `other` |
| `is_error` | логическое | ошибка вызова |
| `error_message` | строка | до 500 знаков |
| `session_thread_id` | строка | есть только у кадров подагентов (`N/src/lib/node-managed-subagents.ts:124-125`) |

Кто шлёт событие:

- встроенный цикл Pi: `P/apps/agent/src/harness/pi-loop.ts:366` (вызов, после которого запускается восстановление контекста) и `pi-loop.ts:428` (обычный конец вызова). Начало: `pi-loop.ts:288`;
- ACP (Claude Code и другие): `P/apps/agent/src/harness/acp-translate.ts:301`, одна пара начала и конца на ход. Начало: `acp-translate.ts:128`. Если ACP-агент не прислал usage, поля `model_usage` нет, строка пишется с нулями и `usage_reported = 0`.

Не считаются (нет в плане и в этом контракте): `span.compaction_summarize_end` и `aux.model_call`. Они тоже тратят токены, см. раздел 10.

### 2.2 Где сервер видит событие

Цепочка вызова для хода основного потока:

1. `ApplicationBackedNodeManagedSessionRuntimeEngine.accept` передаёт runner функцию `output` сессии (`N/src/lib/node-managed-session-runtime.ts:177-183`).
2. `DefaultNodeManagedSessionRunner.accept` создаёт `ManagedNodeHarnessRuntime` с этой `output` (`N/src/lib/node-managed-session-runner.ts:428-436`).
3. `ManagedNodeHarnessRuntime.broadcast` ставит `id` и `processed_at` и ставит кадр в очередь `output` (`node-managed-harness-runtime.ts:295-315`).
4. Подагенты получают ту же `output` при первом создании (`node-managed-session-runner.ts:519`) и добавляют `session_thread_id` (`node-managed-subagents.ts:124-136`).

Значит, достаточно обернуть `output` во входе `accept`. Обёртка:

```ts
// N/src/lib/analytics/recording-runner.ts
export function withModelCallRecording(
  runner: NodeManagedSessionRunner,
  recorder: ModelCallRecorder,
): NodeManagedSessionRunner {
  return {
    start: (input) => runner.start(input),
    stop: (input) => runner.stop(input),
    archiveThread: (input) => runner.archiveThread(input),
    accept: (input) => {
      const tap = recorder.tap(input); // контекст хода: workspaceId, sessionId, session, environment
      return runner.accept({
        ...input,
        output: async (frame) => {
          await input.output(frame); // сначала журнал сессии
          tap(frame);                // потом факт, без ожидания
        },
      });
    },
  };
}
```

Правила обёртки:

- факт пишется только после того, как `input.output(frame)` завершился без ошибки. Кадр, который не попал в журнал сессии, факта не даёт;
- `tap(frame)` синхронный, запись в базу идёт в фоне, ошибка записи уходит в `logger.warn` с `op: "main-node.analytics.record_failed"` и не доходит до хода;
- `tap` хранит `processed_at` каждого `span.model_request_start` по его `id` и удаляет запись на парном конце. Больше 1000 открытых начал на ход не хранится (старые вытесняются), тогда `started_at` и `latency_ms` равны `null`;
- `tap` помнит `session.thread_created` (поле `agent_name` и `session_thread_id`), чтобы знать агента подагента (раздел 2.3);
- методы `cancel` и `connectedSandbox` обёртка не повторяет: `node-managed.ts` зовёт их у исходного `managedRuntimeRunner` (строки 690 и 1239), движку нужен только интерфейс `NodeManagedSessionRunner`.

### 2.3 Контекст строки

Всё берётся из входа `accept` (`AcceptedSessionEvents`: `workspaceId`, `sessionId`, `session`, `environment`) и из кадра.

| Колонка | Откуда |
|---|---|
| `workspace_id`, `session_id` | вход `accept` |
| `thread_id` | `frame.session_thread_id`, иначе `sthr_primary` |
| `agent_id`, `agent_version`, `agent_name` | основной поток: `session.agent.id`, `.version`, `.name`. Подагент: по `agent_name` из `session.thread_created` ищется агент в `session.agent.multiagent.agents` (тип `agent`). Не нашёлся (общий подагент, имя переопределено, поток создан до перезапуска сервера): берутся данные основного агента, а `agent_name` из `thread_created`, если он известен |
| `environment_id` | `session.environmentId` |
| `harness` | `openma.harness` найденного агента: пусто, `default` или `pi` дают `pi`; `ai-sdk` даёт `ai-sdk`; `acp-sandbox` и `acp-proxy` дают `openma.acp.agent.id`, иначе `acp`; другое значение пишется как есть |
| `model` | `model.id` найденного агента (handle карточки или встроенной модели) |
| `effort` | `model.effort` агента или `null` |
| `speed` | `model.speed` агента, иначе `standard` |
| `card_id`, `provider`, `wire_model`, `model_source` | раздел 2.4 |
| `started_at`, `ended_at`, `day`, `latency_ms` | `Date.parse` штампов начала и конца; `day` это `YYYY-MM-DD` от `ended_at` по UTC; `latency_ms = ended_at - started_at` или `null` |
| токены, `usage_reported` | `model_usage`; нет поля, тогда нули и `usage_reported = 0` |
| `is_error`, `finish_reason`, `error_message` | из кадра, текст ошибки обрезается до 500 знаков |
| стоимость, `price_source` | раздел 3 |
| `recorded_at` | часы сервера в момент записи |

### 2.4 Модель и карточка

`createAnalyticsModelResolver({ modelCards, serverKeyAvailable, ttlMs })` повторяет правило `resolveNodeModelCreds` (`N/src/modules/node-foundation.ts:309-343`), но без ключа:

1. Карточка с `model_id = handle`, не в архиве: `model_source = card`, `card_id = card.id`, `provider = card.provider`, `wire_model = card.model`.
2. Карточки нет, ключ сервера задан (`config.model.apiKey`): `model_source = builtin`, `card_id = null`, `provider = anthropic`, `wire_model = handle`.
3. Иначе или при ошибке чтения карточки: `model_source = unknown`, `card_id = null`, `provider = null`, `wire_model = frame.model ?? null`.

Ответ хранится в памяти 60 секунд на пару «рабочее пространство, handle», чтобы не читать карточку на каждый вызов модели.

### 2.5 Повторы и потери

- Первичный ключ `(workspace_id, id)`, вставка `INSERT ... ON CONFLICT (workspace_id, id) DO NOTHING`. Повторная доставка того же кадра строку не добавляет.
- Повтор хода после потери аренды создаёт новые события с новыми `id`, такой вызов модели честно считается ещё раз.
- Строка пишется вне транзакции события. Если процесс упал между записью события и записью факта, строки не будет.
- На MySQL обёртка не подключается, маршруты отвечают 501.

## 3. Цены

Порядок поиска цены для строки:

1. `card.pi_config.cost` карточки, если это объект с конечными числами `input` и `output` не меньше нуля. Нет `cacheRead` или `cacheWrite`, тогда эта часть стоит 0. `price_source = card`.
2. Каталог Pi: `findPiCatalogModel(wire_model)` из `@open-managed-agents/managed-agents-application/agents/pi-model-catalog`, затем модель провайдера из `builtinProviders()` с `id = wire_model` (как `resolvePiModel` в `P/packages/managed-agents-adapters-runtime/src/model-card-catalog.ts:100-104`). Провайдеры `ant` и `oai` приводятся к `anthropic` и `openai`. `price_source = catalog`.
3. Иначе цены нет: все стоимости `null`, `price_source = none`.

Цены в каталоге Pi и в `pi_config.cost` заданы в долларах за 1 млн токенов (проверено: `claude-sonnet-4-6` в `pi-ai/dist/providers/data/anthropic.json` стоит `{input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75}`). Поэтому стоимость в миллионных долях доллара равна произведению без деления:

```text
cost_input_usd_micros       = round(input_tokens       * price.input)
cost_output_usd_micros      = round(output_tokens      * price.output)
cost_cache_read_usd_micros  = round(cache_read_tokens  * price.cacheRead)
cost_cache_write_usd_micros = round(cache_write_tokens * price.cacheWrite)
cost_usd_micros             = сумма четырёх частей
```

Пример: 20 токенов входа по $3 и 10 токенов выхода по $15 дают 60 + 150 = 210, это $0,00021.

Правила:

- цена фиксируется в момент записи, смена цены в карточке старые строки не меняет;
- ступени цены по объёму входа (`cost.tiers` в каталоге Pi) и двойная цена записи кэша на 1 час не учитываются;
- валюта одна, доллар.

Код: `N/src/lib/analytics/price.ts`, функции `resolveCallPrice(card | null, provider, wireModel)` и `costParts(tokens, price)`. Модуль S1 `model-pricing.ts` из плана сюда не импортируется: если S1 появится, он может взять `price.ts` за основу.

## 4. Схема и миграции

### 4.1 Почему не drizzle-миграция

- Новая миграция требует правки `N/migrations/meta/_journal.json`, `N/migrations-sqlite/meta/_journal.json` и новых снимков. Это правка существующих файлов, а в этом шаге сервер получает только новые.
- MySQL строит схему по последнему снимку SQLite и падает на незнакомом снимке: «cannot be silently promoted» (`P/packages/db-schema/src/node-mysql/index.ts:72` и `:121`). Новый снимок сломал бы запуск на MySQL без отдельного перехода в этом файле.
- Конфигов `drizzle.*.config.ts` в `platform/` нет, `pnpm db:generate` не запустится.
- В платформе уже есть пакеты, которые создают свои таблицы кодом: `ensureRuntimeResourceFenceSchema` (`P/packages/runtime-resource-fence-sql/src/index.ts:26`), `ensureAccessLossSchema` (`P/packages/mcp-access-loss/src/sql.ts:55`), `ensureSchema` журнала событий (`P/packages/event-log/src/sql/index.ts:302`). Делаем так же.

### 4.2 Как работают миграции

`ensureAnalyticsSchema(sql)` в `N/src/lib/analytics/schema.ts`:

1. создаёт таблицу шагов `analytics_schema_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`;
2. читает применённые `id`;
3. для каждого шага из `ANALYTICS_MIGRATIONS` по порядку, которого нет в таблице, выполняет его операторы через `sql.exec` и пишет `id` с `ON CONFLICT (id) DO NOTHING`;
4. результат запоминается на `SqlClient` (`WeakMap`, как в `mcp-access-loss`), при ошибке запись удаляется и следующий вызов пробует снова.

Каждый оператор шага безопасно повторяется (`IF NOT EXISTS`), поэтому два процесса, стартовавшие одновременно, ничего не ломают. Будущий шаг, который добавляет колонку, сначала проверяет её наличие (`pragma_table_info` на SQLite, `information_schema.columns` на Postgres), как `ensureSchema` журнала событий.

Один и тот же текст DDL работает в SQLite и Postgres: типы `TEXT`, `INTEGER`, `BIGINT`, составной первичный ключ, `CREATE INDEX IF NOT EXISTS`. В SQLite `BIGINT` получает целочисленное сродство. Хранилища вызывают `ensureAnalyticsSchema` перед первым запросом. На MySQL хранилища и маршруты не создаются.

### 4.3 Почему лимиты не в `model_cards`

- Новая колонка в `model_cards` требует правки `P/packages/db-schema/src/cf-auth/model-cards.ts`, `node-pg/cf-auth-model-cards.ts`, drizzle-миграции и перехода MySQL (раздел 4.1).
- Ключ в `pi_config` не подходит: `pi_config` целиком раскладывается в модель Pi (`P/apps/agent/src/harness/pi-provider.ts:145`), а форма карточки из единицы C1 переписывает `pi_config` по своим полям и потеряла бы лимиты.
- Отдельная таблица по `card_id` живёт со схемой аналитики. Карточку читаем через `ModelCardService.list` и `get` (`P/packages/model-cards-store/src/service.ts:164-175`). Строка лимитов удалённой карточки остаётся в таблице, но нигде не показывается.

Файлы пакета `model-cards-store` в этом шаге не меняются.

### 4.4 Таблица `model_calls`

| Колонка | Тип | Пусто | Что это |
|---|---|---|---|
| `workspace_id` | TEXT | нет | рабочее пространство |
| `id` | TEXT | нет | ID события `span.model_request_end` |
| `session_id` | TEXT | нет | сессия |
| `thread_id` | TEXT | нет | поток сессии, `sthr_primary` у основного |
| `agent_id` | TEXT | нет | агент |
| `agent_version` | INTEGER | да | версия агента из снимка сессии |
| `agent_name` | TEXT | нет | имя агента на момент вызова |
| `environment_id` | TEXT | да | окружение сессии |
| `harness` | TEXT | нет | `pi`, `ai-sdk`, `claude-acp`, … |
| `model` | TEXT | нет | handle модели агента |
| `card_id` | TEXT | да | карточка модели |
| `provider` | TEXT | да | провайдер карточки или `anthropic` |
| `wire_model` | TEXT | да | модель у провайдера |
| `model_source` | TEXT | нет | `card`, `builtin`, `unknown` |
| `effort` | TEXT | да | усилие агента |
| `speed` | TEXT | нет | `standard` или `fast` |
| `provider_response_id` | TEXT | да | ID ответа провайдера |
| `started_at` | BIGINT | да | мс от эпохи, начало вызова |
| `ended_at` | BIGINT | нет | мс от эпохи, конец вызова |
| `day` | TEXT | нет | `YYYY-MM-DD` по UTC от `ended_at` |
| `latency_ms` | BIGINT | да | задержка |
| `input_tokens` | BIGINT | нет | вход без кэша |
| `output_tokens` | BIGINT | нет | выход |
| `cache_read_tokens` | BIGINT | нет | чтение кэша |
| `cache_write_tokens` | BIGINT | нет | запись кэша |
| `usage_reported` | INTEGER | нет | 1, если в событии был `model_usage` |
| `is_error` | INTEGER | нет | 1 при ошибке |
| `finish_reason` | TEXT | да | причина остановки |
| `error_message` | TEXT | да | текст ошибки до 500 знаков |
| `cost_usd_micros` | BIGINT | да | стоимость, `null` без цены |
| `cost_input_usd_micros` | BIGINT | да | часть за вход |
| `cost_output_usd_micros` | BIGINT | да | часть за выход |
| `cost_cache_read_usd_micros` | BIGINT | да | часть за чтение кэша |
| `cost_cache_write_usd_micros` | BIGINT | да | часть за запись кэша |
| `price_source` | TEXT | нет | `card`, `catalog`, `none` |
| `recorded_at` | BIGINT | нет | мс, когда сервер записал строку |

Индексы и для чего они:

| Индекс | Колонки | Запросы |
|---|---|---|
| первичный ключ | `workspace_id, id` | вставка без повтора, карточка записи |
| `model_calls_ws_day_idx` | `workspace_id, day` | отчёты по дням |
| `model_calls_ws_ended_idx` | `workspace_id, ended_at, id` | журнал с курсором, корзины по часам и минутам, `latest_ended_at` |
| `model_calls_ws_session_idx` | `workspace_id, session_id, ended_at` | итоги сессии, журнал сессии |
| `model_calls_ws_card_ended_idx` | `workspace_id, card_id, ended_at` | пик лимитов карточки |

### 4.5 Таблица `model_card_limits`

| Колонка | Тип | Пусто | Что это |
|---|---|---|---|
| `workspace_id` | TEXT | нет | рабочее пространство |
| `card_id` | TEXT | нет | карточка модели |
| `requests_per_minute` | BIGINT | да | лимит запросов в минуту, `null` не задан |
| `input_tokens_per_minute` | BIGINT | да | лимит токенов входа в минуту без чтения кэша |
| `output_tokens_per_minute` | BIGINT | да | лимит токенов выхода в минуту |
| `updated_at` | BIGINT | нет | мс последней правки |
| `updated_by` | TEXT | да | `c.get("user_id")` из контекста запроса (`P/packages/auth/src/index.ts:165`), `null` для ключа API без пользователя |

Первичный ключ `(workspace_id, card_id)`.

### 4.6 DDL

```sql
-- шаг 0001_model_calls
CREATE TABLE IF NOT EXISTS model_calls (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_version INTEGER,
  agent_name TEXT NOT NULL,
  environment_id TEXT,
  harness TEXT NOT NULL,
  model TEXT NOT NULL,
  card_id TEXT,
  provider TEXT,
  wire_model TEXT,
  model_source TEXT NOT NULL,
  effort TEXT,
  speed TEXT NOT NULL,
  provider_response_id TEXT,
  started_at BIGINT,
  ended_at BIGINT NOT NULL,
  day TEXT NOT NULL,
  latency_ms BIGINT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  usage_reported INTEGER NOT NULL,
  is_error INTEGER NOT NULL,
  finish_reason TEXT,
  error_message TEXT,
  cost_usd_micros BIGINT,
  cost_input_usd_micros BIGINT,
  cost_output_usd_micros BIGINT,
  cost_cache_read_usd_micros BIGINT,
  cost_cache_write_usd_micros BIGINT,
  price_source TEXT NOT NULL,
  recorded_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS model_calls_ws_day_idx ON model_calls (workspace_id, day);
CREATE INDEX IF NOT EXISTS model_calls_ws_ended_idx ON model_calls (workspace_id, ended_at, id);
CREATE INDEX IF NOT EXISTS model_calls_ws_session_idx ON model_calls (workspace_id, session_id, ended_at);
CREATE INDEX IF NOT EXISTS model_calls_ws_card_ended_idx ON model_calls (workspace_id, card_id, ended_at);

-- шаг 0002_model_card_limits
CREATE TABLE IF NOT EXISTS model_card_limits (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  requests_per_minute BIGINT,
  input_tokens_per_minute BIGINT,
  output_tokens_per_minute BIGINT,
  updated_at BIGINT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (workspace_id, card_id)
);
```

### 4.7 Правила SQL для двух баз

- Плейсхолдеры `?`, адаптер Postgres сам переводит их в `$1, $2` (`P/packages/sql-client/src/adapters/postgres.ts:58-96`).
- Postgres отдаёт `BIGINT` числом (`postgres.ts:232`), а `SUM` по `BIGINT` даёт `numeric` строкой. Каждую сумму оборачивать в `CAST(SUM(x) AS BIGINT)` и всё равно приводить `Number()` при чтении.
- Без функций дат и без JSON. День хранится строкой, час и минута считаются целочисленным делением: `ended_at / 3600000`, `ended_at / 60000`. В `GROUP BY` повторять выражение, а не псевдоним.
- Не писать `? IS NULL OR col = ?`: Postgres отвергает такой плейсхолдер (ошибка 42P18, см. шапку `N/test/managed-session-execution.postgres.test.ts`). Условия фильтров собираются из непустых значений, списки как `col IN (?, ?, ?)`, не больше 50 значений на фильтр.
- Журнал листается курсором без `OFFSET`: `(ended_at < ? OR (ended_at = ? AND id < ?)) ORDER BY ended_at DESC, id DESC LIMIT n + 1`.
- Пример отчёта по дням:

```sql
SELECT day AS bucket, model AS group_key,
       COUNT(*) AS requests,
       CAST(SUM(is_error) AS BIGINT) AS errors,
       CAST(SUM(input_tokens) AS BIGINT) AS input_tokens,
       CAST(SUM(output_tokens) AS BIGINT) AS output_tokens,
       CAST(SUM(cache_read_tokens) AS BIGINT) AS cache_read_tokens,
       CAST(SUM(cache_write_tokens) AS BIGINT) AS cache_write_tokens,
       CAST(SUM(cost_usd_micros) AS BIGINT) AS cost_usd_micros,
       CAST(SUM(cost_input_usd_micros) AS BIGINT) AS cost_input_usd_micros,
       CAST(SUM(cost_output_usd_micros) AS BIGINT) AS cost_output_usd_micros,
       CAST(SUM(cost_cache_read_usd_micros) AS BIGINT) AS cost_cache_read_usd_micros,
       CAST(SUM(cost_cache_write_usd_micros) AS BIGINT) AS cost_cache_write_usd_micros,
       CAST(SUM(CASE WHEN cost_usd_micros IS NULL THEN 1 ELSE 0 END) AS BIGINT) AS unpriced_requests,
       CAST(SUM(CASE WHEN usage_reported = 0 THEN 1 ELSE 0 END) AS BIGINT) AS usage_missing_requests
  FROM model_calls
 WHERE workspace_id = ? AND day >= ? AND day <= ? AND agent_id IN (?, ?)
 GROUP BY day, model
```

- Пример загрузки по минутам для лимитов:

```sql
SELECT card_id, model, ended_at / 60000 AS minute,
       COUNT(*) AS requests,
       CAST(SUM(input_tokens + cache_write_tokens) AS BIGINT) AS input_tokens,
       CAST(SUM(output_tokens) AS BIGINT) AS output_tokens
  FROM model_calls
 WHERE workspace_id = ? AND ended_at > ?
 GROUP BY card_id, model, ended_at / 60000
```

Наибольшее значение по минутам выбирается в коде. Если пик одинаков в нескольких минутах, берётся самая поздняя.

## 5. API

### 5.0 Общие правила

- Все маршруты под `/v1/oma/analytics`, проверка входа как у остальных `/v1/oma/*` (middleware `authMw` в `node-http.ts:295`), рабочее пространство из `c.get("tenant_id")`. Тип Hono: `Hono<{ Variables: { tenant_id: string; user_id?: string } }>`, по образцу `P/packages/http-routes/src/model-cards/index.ts:17-19`.
- Даты `from` и `to` включительно, формат `YYYY-MM-DD`, сутки по UTC. Без них берутся последние 30 дней до сегодня по UTC. `from` позже `to` даёт 400. `to` позже сегодняшнего дня сдвигается на сегодня.
- `bucket=day` до 92 дней, `bucket=hour` до 7 дней. Дольше даёт 400.
- Списочные фильтры через запятую: `agent_id`, `model`, `harness`, `card_id`. До 50 значений, каждое до 200 знаков. `card_id=none` выбирает строки без карточки.
- Время в ответах: ISO 8601 с `Z`. Деньги: целые миллионные доли доллара (`*_usd_micros`). Доли: число от 0 до 1 с четырьмя знаками после запятой или `null`.
- Ошибки в форме managed API, текст по-русски, консоль показывает его как есть (`C/lib/api.ts:158-172`):

```json
{ "type": "error", "error": { "type": "invalid_request_error", "message": "Период не больше 92 дней." } }
```

| Статус | `error.type` | Когда |
|---|---|---|
| 400 | `invalid_request_error` | неверная дата, период, `bucket`, `group_by`, `metric`, `by`, `status`, `limit`, курсор, тело `PUT` |
| 404 | `not_found_error` | нет записи журнала, нет карточки или она в архиве |
| 501 | `api_error` | база MySQL: «На MySQL аналитика не ведётся.» |

### 5.1 `GET /usage`

Кормит страницы «Использование» и «Стоимость».

Параметры: `from`, `to`, `bucket` (`day` по умолчанию, `hour`), `group_by` (`model` по умолчанию, `agent`, `harness`, `card`, `environment`, `speed`, `none`), `agent_id`, `model`, `harness`, `card_id`, `format` (`json` по умолчанию, `csv`).

Группировка «Тип токена» на сервере не нужна: консоль берёт `group_by=none` и раскладывает ряд по четырём полям токенов или четырём частям стоимости.

Ключ и подпись группы:

| `group_by` | `key` | `label` |
|---|---|---|
| `model` | handle | handle |
| `agent` | `agent_id` | последнее `agent_name` агента за период |
| `harness` | ключ harness | ключ harness |
| `card` | `card_id` или `none` | handle карточки или «Без карточки» |
| `environment` | `environment_id` или `none` | `environment_id` или «Без окружения» |
| `speed` | `standard` или `fast` | то же |
| `none` | `all` | «Всё» |

Ответ (период из двух дней):

```json
{
  "from": "2026-10-15",
  "to": "2026-10-16",
  "bucket": "day",
  "group_by": "model",
  "currency": "USD",
  "filters": { "agent_id": [], "model": [], "harness": [], "card_id": [] },
  "buckets": ["2026-10-15T00:00:00.000Z", "2026-10-16T00:00:00.000Z"],
  "totals": {
    "requests": 12,
    "errors": 1,
    "input_tokens": 1200,
    "output_tokens": 300,
    "cache_read_tokens": 5400,
    "cache_write_tokens": 800,
    "cost_usd_micros": 12720,
    "cost_parts_usd_micros": { "input": 3600, "output": 4500, "cache_read": 1620, "cache_write": 3000 },
    "unpriced_requests": 0,
    "usage_missing_requests": 0
  },
  "groups": [
    {
      "key": "verify-fake",
      "label": "verify-fake",
      "requests": 12,
      "errors": 1,
      "input_tokens": 1200,
      "output_tokens": 300,
      "cache_read_tokens": 5400,
      "cache_write_tokens": 800,
      "cost_usd_micros": 12720,
      "cost_parts_usd_micros": { "input": 3600, "output": 4500, "cache_read": 1620, "cache_write": 3000 },
      "unpriced_requests": 0
    }
  ],
  "series": [
    {
      "bucket_start": "2026-10-16T00:00:00.000Z",
      "key": "verify-fake",
      "requests": 12,
      "errors": 1,
      "input_tokens": 1200,
      "output_tokens": 300,
      "cache_read_tokens": 5400,
      "cache_write_tokens": 800,
      "cost_usd_micros": 12720,
      "cost_parts_usd_micros": { "input": 3600, "output": 4500, "cache_read": 1620, "cache_write": 3000 },
      "unpriced_requests": 0
    }
  ],
  "latest_ended_at": "2026-10-16T09:12:03.120Z",
  "generated_at": "2026-10-16T09:15:00.000Z"
}
```

- `buckets` перечисляет все корзины периода по порядку. `series` содержит только непустые пары «корзина, группа», консоль дополняет нули сама.
- `groups` идут по убыванию суммы всех токенов, при равенстве по `key`.
- `cost_usd_micros` у группы и ряда это сумма строк с ценой. Строки без цены видны в `unpriced_requests`.
- `latest_ended_at` это наибольший `ended_at` рабочего пространства без фильтров, `null` без строк.

### 5.2 `GET /cache`

Кормит страницу «Кэширование». Период фиксирован, как в Claude: последние 7 суток по часам, считая текущий час.

Параметры: `group_by` (`model` по умолчанию, `agent`), `model`, `agent_id`.

Определения:

- `total_input_tokens = uncached_input_tokens + cache_read_tokens + cache_write_tokens`, где `uncached_input_tokens` это колонка `input_tokens`;
- `read_ratio = cache_read_tokens / total_input_tokens`, `null` при нуле;
- `write_amortization = cache_read_tokens / cache_write_tokens`, `null` при нуле записи.

Ответ:

```json
{
  "from_hour": "2026-10-09T10:00:00.000Z",
  "to_hour": "2026-10-16T09:00:00.000Z",
  "series_from_hour": "2026-10-02T10:00:00.000Z",
  "group_by": "model",
  "filters": { "model": [], "agent_id": [] },
  "totals": {
    "requests": 40,
    "uncached_input_tokens": 8100,
    "cache_read_tokens": 1400000,
    "cache_write_tokens": 203000,
    "total_input_tokens": 1611100,
    "read_ratio": 0.869,
    "write_amortization": 6.8966
  },
  "rows": [
    {
      "key": "verify-fake",
      "label": "verify-fake",
      "requests": 40,
      "uncached_input_tokens": 8100,
      "cache_read_tokens": 1400000,
      "cache_write_tokens": 203000,
      "total_input_tokens": 1611100,
      "read_ratio": 0.869,
      "write_amortization": 6.8966
    }
  ],
  "series": [
    {
      "hour_start": "2026-10-16T09:00:00.000Z",
      "key": "verify-fake",
      "requests": 2,
      "uncached_input_tokens": 120,
      "cache_read_tokens": 5000,
      "cache_write_tokens": 0
    }
  ],
  "low_cache_agents": [
    { "agent_id": "agent_01", "agent_name": "verify-agent", "model": "verify-fake", "total_input_tokens": 52000, "read_ratio": 0.12 }
  ],
  "latest_ended_at": "2026-10-16T09:12:03.120Z",
  "generated_at": "2026-10-16T09:15:00.000Z"
}
```

- `totals` и `rows` считаются за 168 часов от `from_hour` до `to_hour` включительно.
- `series` отдаёт 336 часов, от `series_from_hour`: первые 168 часов нужны консоли, чтобы окно «7 дней» у окупаемости записи было полным с первой точки графика. Ряды только непустые.
- `low_cache_agents`: агенты с `total_input_tokens` не меньше 10 000 за 7 суток и `read_ratio` меньше 0,5, не больше 10, по убыванию входа. Это замена карточки диагностики кэша (раздел 4 сравнения).

### 5.3 `GET /limits`

Кормит таблицу страницы «Лимиты». Окно пика: последние 24 часа до момента запроса.

Метрики квот:

| `metric` | Единица | Что считается за минуту |
|---|---|---|
| `itpm` | `tokens_per_minute` | `input_tokens + cache_write_tokens`, то есть вход без чтения кэша |
| `otpm` | `tokens_per_minute` | `output_tokens` |
| `rpm` | `requests_per_minute` | число строк |

Минута определяется по `ended_at` строки. Это приближение: провайдер считает вход в момент начала запроса.

Параметры: нет. Поиск `q` консоль делает у себя.

Ответ:

```json
{
  "window_from": "2026-10-15T09:15:00.000Z",
  "window_to": "2026-10-16T09:15:00.000Z",
  "cards": [
    {
      "card_id": "mc_01",
      "model": "verify-fake",
      "label": "Claude Sonnet 4.6",
      "provider": "anthropic",
      "wire_model": "claude-sonnet-4-6",
      "is_default": true,
      "limits_updated_at": "2026-10-16T08:00:00.000Z",
      "quotas": [
        { "metric": "itpm", "unit": "tokens_per_minute", "limit": 30000, "peak": 1200, "peak_at": "2026-10-16T08:41:00.000Z", "utilization": 0.04 },
        { "metric": "otpm", "unit": "tokens_per_minute", "limit": 8000, "peak": 300, "peak_at": "2026-10-16T08:41:00.000Z", "utilization": 0.0375 },
        { "metric": "rpm", "unit": "requests_per_minute", "limit": null, "peak": 3, "peak_at": "2026-10-16T08:41:00.000Z", "utilization": null }
      ]
    }
  ],
  "uncarded": [
    {
      "model": "claude-sonnet-4-6",
      "model_source": "builtin",
      "label": "Claude Sonnet 4.6",
      "quotas": [
        { "metric": "itpm", "unit": "tokens_per_minute", "limit": null, "peak": 500, "peak_at": "2026-10-16T07:02:00.000Z", "utilization": null },
        { "metric": "otpm", "unit": "tokens_per_minute", "limit": null, "peak": 90, "peak_at": "2026-10-16T07:02:00.000Z", "utilization": null },
        { "metric": "rpm", "unit": "requests_per_minute", "limit": null, "peak": 1, "peak_at": "2026-10-16T07:02:00.000Z", "utilization": null }
      ]
    }
  ],
  "generated_at": "2026-10-16T09:15:00.000Z"
}
```

- `cards`: все карточки рабочего пространства не в архиве, даже без вызовов. Сначала карточка по умолчанию, дальше по `label`. Порядок квот всегда `itpm`, `otpm`, `rpm`.
- `label`: название модели из каталога Pi по `wire_model`, иначе handle.
- `uncarded`: модели из строк за 24 часа без `card_id`, по `model`. Лимит им задать нельзя.
- `peak = 0` и `peak_at = null`, если вызовов не было. `utilization = peak / limit`, `null` без лимита.

### 5.4 `GET /limits/:card_id`

Кормит правую панель квоты.

Параметры: `metric` (`itpm` по умолчанию, `otpm`, `rpm`), `by` (`agent` по умолчанию, `session`).

```json
{
  "card_id": "mc_01",
  "model": "verify-fake",
  "label": "Claude Sonnet 4.6",
  "metric": "itpm",
  "unit": "tokens_per_minute",
  "limit": 30000,
  "peak_24h": { "value": 1200, "at": "2026-10-16T08:41:00.000Z", "utilization": 0.04 },
  "breakdown": {
    "by": "agent",
    "rows": [
      { "key": "agent_01", "label": "verify-agent", "value": 900, "share": 0.75, "utilization": 0.03 },
      { "key": "agent_02", "label": "reviewer", "value": 300, "share": 0.25, "utilization": 0.01 }
    ],
    "total": 1200
  },
  "series": [
    { "hour_start": "2026-10-09T10:00:00.000Z", "peak": 0 },
    { "hour_start": "2026-10-16T08:00:00.000Z", "peak": 1200 }
  ],
  "generated_at": "2026-10-16T09:15:00.000Z"
}
```

- `breakdown` разбирает минуту пика (`peak_24h.at`) по агентам или по сессиям. При `by=session` у строки `key` и `label` равны `session_id`. Без вызовов `rows` пустой, `total = 0`.
- `series` всегда содержит 168 точек по часам UTC за 7 суток, считая текущий час (в примере показаны две). `peak` в точке это наибольшая загрузка одной минуты внутри часа.
- Карточки нет или она в архиве: 404 «Карточка модели не найдена».

### 5.5 `PUT /limits/:card_id`

Задаёт лимиты карточки. Тело целиком заменяет три значения:

```json
{ "requests_per_minute": 50, "input_tokens_per_minute": 30000, "output_tokens_per_minute": null }
```

- каждое поле обязательно, `null` снимает лимит, иначе целое от 1 до 1 000 000 000;
- лишние поля, дробь, строка, ноль, отрицательное число дают 400 с текстом вида «Лимит запросов в минуту: целое число от 1 до 1 000 000 000 или пусто.»;
- карточки нет или она в архиве: 404.

Ответ 200:

```json
{
  "card_id": "mc_01",
  "requests_per_minute": 50,
  "input_tokens_per_minute": 30000,
  "output_tokens_per_minute": null,
  "updated_at": "2026-10-16T09:20:00.000Z"
}
```

### 5.6 `GET /model_calls`

Журнал запросов, новые сверху.

Параметры: `from`, `to` (по умолчанию 30 дней), `agent_id`, `model`, `harness`, `card_id`, `session_id`, `status` (`ok` или `error`), `q` (ID вызова целиком или его начало от 4 знаков), `limit` (1..200, по умолчанию 50), `cursor`, `format`.

```json
{
  "data": [
    {
      "id": "sevt_01",
      "session_id": "sesn_01",
      "thread_id": "sthr_primary",
      "agent": { "id": "agent_01", "version": 3, "name": "verify-agent" },
      "environment_id": "env_01",
      "harness": "pi",
      "model": "verify-fake",
      "card_id": "mc_01",
      "provider": "anthropic",
      "wire_model": "claude-sonnet-4-6",
      "model_source": "card",
      "effort": "high",
      "speed": "standard",
      "provider_response_id": "msg_01",
      "started_at": "2026-10-16T09:12:00.100Z",
      "ended_at": "2026-10-16T09:12:03.120Z",
      "latency_ms": 3020,
      "usage_reported": true,
      "input_tokens": 20,
      "output_tokens": 10,
      "cache_read_tokens": 0,
      "cache_write_tokens": 0,
      "is_error": false,
      "finish_reason": "stop",
      "error_message": null,
      "cost_usd_micros": 210,
      "cost_parts_usd_micros": { "input": 60, "output": 150, "cache_read": 0, "cache_write": 0 },
      "price_source": "card"
    }
  ],
  "next_cursor": "eyJlIjoxNzkwNTA4NzIzMTIwLCJpIjoic2V2dF8wMSJ9",
  "latest_ended_at": "2026-10-16T09:12:03.120Z"
}
```

- Курсор непрозрачный: base64url от `{"e": ended_at, "i": id}`. Испорченный курсор даёт 400.
- `next_cursor = null` на последней странице.
- Без цены: `cost_usd_micros` и все части `null`, `price_source = none`.

### 5.7 `GET /model_calls/:id`

Одна строка журнала в той же форме, что элемент `data`. Нужна, когда карточку записи открывают по ссылке `?request=` и строки нет на текущей странице. Нет строки: 404 «Запись журнала не найдена».

### 5.8 `GET /sessions/:id`

Итоги одной сессии для шапки сессии (единица C2 плана).

```json
{
  "session_id": "sesn_01",
  "totals": {
    "requests": 4,
    "errors": 0,
    "input_tokens": 80,
    "output_tokens": 40,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0,
    "cost_usd_micros": 840,
    "cost_parts_usd_micros": { "input": 240, "output": 600, "cache_read": 0, "cache_write": 0 },
    "unpriced_requests": 0,
    "usage_missing_requests": 0
  },
  "models": ["verify-fake"],
  "harnesses": ["pi"],
  "first_started_at": "2026-10-16T09:10:00.000Z",
  "last_ended_at": "2026-10-16T09:12:03.120Z"
}
```

Сессии без строк получают нули и `null` во времени. Существование сессии маршрут не проверяет. Бюджет сессии консоль берёт из `GET /v1/sessions/:id`, здесь его нет.

### 5.9 `GET /facets`

Значения для фильтров за период. Параметры: `from`, `to`.

```json
{
  "from": "2026-09-17",
  "to": "2026-10-16",
  "agents": [{ "id": "agent_01", "name": "verify-agent" }],
  "models": [{ "key": "verify-fake" }, { "key": "claude-sonnet-4-6" }],
  "harnesses": [{ "key": "pi" }, { "key": "claude-acp" }],
  "cards": [{ "id": "mc_01", "model": "verify-fake" }]
}
```

Списки отсортированы по подписи, у агента берётся последнее имя за период.

### 5.10 CSV

`format=csv` у `GET /usage` и `GET /model_calls`. Ответ `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="..."`, разделитель запятая, строки через CRLF, поле в кавычках, если в нём есть запятая, кавычка или перевод строки. Заголовок по-английски, числа без форматирования, `cost_usd` с шестью знаками после точки, пусто без цены.

| Маршрут | Имя файла | Колонки |
|---|---|---|
| `/usage` | `analytics-usage-<from>_<to>.csv` | `bucket_start,group_key,group_label,requests,errors,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd_micros,cost_usd,unpriced_requests` |
| `/model_calls` | `analytics-model-calls-<from>_<to>.csv` | `id,ended_at,started_at,latency_ms,status,session_id,thread_id,agent_id,agent_name,harness,model,card_id,provider,wire_model,speed,effort,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd_micros,cost_usd,price_source,finish_reason,error_message` |

У журнала CSV не больше 10 000 строк по текущим фильтрам, без курсора. Если строк больше, ответ несёт заголовок `X-Analytics-Truncated: 10000`, консоль показывает тост «В файл попали первые 10 000 строк. Сузьте период или фильтры.»

## 6. Консоль

Раскладка и поведение берутся из [04-analytics.md](../cma-console/04-analytics.md). Цвета и шрифты только из токенов DDC (`C/styles/ddc-tokens.css`) и готовых классов DDC (`.card`, `.kpi`, `.segmented`, `.chip`, `.menu`, `.callout`). Новых CSS-файлов и правок `ddc-tokens.css` нет: цвета рядов задаются классами Tailwind на шкалах DDC (`fill-brand-600`, `bg-sky-500` и так далее), поэтому переменные гарантированно попадают в сборку.

### 6.1 Меню и маршруты

- Группа «Аналитика» в `AppSidebar.tsx` после «Управляемые агенты», перед «Инфраструктура». Пункты по порядку: «Использование» (`ChartColumnIcon`), «Кэширование» (`DatabaseZapIcon`), «Лимиты» (`GaugeIcon` занят сводкой, берём `TimerIcon`), «Стоимость» (`CircleDollarSignIcon`), «Журнал запросов» (`ScrollTextIcon`).
- Подписи берутся из `C/components/analytics/analytics-nav.ts` по `locale` из `useI18n()`: ru «Аналитика, Использование, Кэширование, Лимиты, Стоимость, Журнал запросов», en «Analytics, Usage, Caching, Rate limits, Cost, Logs», zh-CN «分析, 用量, 缓存, 速率限制, 成本, 日志». Файлы `i18n/*` не меняются.
- `main.tsx`: родительский маршрут `analytics` с `handle.crumb = "Аналитика"`, индекс ведёт на `usage` (`<Navigate to="usage" replace />`), дети `usage`, `caching`, `limits`, `cost`, `logs` с подписями из списка выше. Страницы грузятся через `lazy:`, как `SessionDetail`.
- В `AppSidebar.linear.test.tsx` ожидаемые группы становятся `["Управляемые агенты", "Аналитика", "Инфраструктура", "Конфигурация"]`, а пять новых ссылок встают после «Запуски оценки».

### 6.2 Общее для страниц

Шапка. Компонент `AnalyticsHeader` на `PageHeader`: заголовок, подзаголовок со словами «Даты в UTC», справа подпись «Данные на 16 окт., 09:12 UTC» из `latest_ended_at` и кнопка-иконка «Обновить» (`RefreshCwIcon`), которая перезапрашивает данные страницы. Кнопки документации нет.

Строка фильтров. Компонент `FilterBar`: ряды кнопок-фильтров по 32 px, перенос рядов на узком экране, у «Кэширования» и «Лимитов» липкая (`sticky top-0` и фон страницы). Кнопка «Сбросить» (`RotateCcwIcon`) встаёт после последнего фильтра, когда хоть один отличается от значения по умолчанию, и очищает адрес. Справа кнопка-иконка «Скачать CSV» (`DownloadIcon`) там, где есть выгрузка. Во время загрузки на её месте индикатор.

Фильтры:

| Фильтр | Где | Значения | По умолчанию |
|---|---|---|---|
| Период (`RangeFilter`) | использование, стоимость, журнал | «С начала месяца», «7 дней», «30 дней», «Прошлый месяц», «Свой период» (два поля даты «С» и «По») | «30 дней» |
| Агент, Модель, Harness, Карточка (`MultiSelectFilter`) | использование, стоимость, журнал; на кэшировании только Модель и Агент | значения из `GET /facets` за период, поиск, флажки, «Выбрать всё» и «Очистить» внизу | все |
| Статус | журнал | «Успешно», «Ошибка» | все |
| Группировать по (`SingleSelectFilter`, без крестика) | использование и стоимость | «Модель», «Тип токена», «Агент», «Harness», «Карточка», «Окружение», «Скорость» | «Модель» |
| Группировать по | кэширование | «Модель», «Агент» | «Модель» |
| Период (выключен, «7 дней») | кэширование | нет | нет |

Периоды по UTC от сегодняшнего дня `d`: «С начала месяца» от первого числа месяца `d` до `d`; «7 дней» от `d-6` до `d`; «30 дней» от `d-29` до `d`; «Прошлый месяц» от первого до последнего числа прошлого месяца. Свой период проверяется в браузере так же, как на сервере (не больше 92 дней, начало не позже конца), ошибка видна под полями.

Адрес хранит состояние. Хук `useAnalyticsParams` читает и пишет `useSearchParams` с `replace: true`:

| Параметр | Значение |
|---|---|
| `range` | `mtd`, `7d`, `30d`, `last_month`; для своего периода не пишется |
| `from`, `to` | `YYYY-MM-DD`, только для своего периода и приближения по клику |
| `agent_id`, `model`, `harness`, `card_id` | списки через запятую |
| `group_by` | ключ группировки, `token_type` только в консоли |
| `status`, `session_id`, `q` | журнал |
| `request` | ID открытой записи журнала |
| `focus` | `<card_id>:<metric>` открытой квоты на «Лимитах» |

Значения по умолчанию в адрес не пишутся. Режим «График» или «Таблица» в адрес не пишется, он живёт в состоянии карточки.

Форматы (`analytics-format.ts`, все с `timeZone: "UTC"` и `ru-RU`):

| Что | Пример |
|---|---|
| день на оси | «16 окт.» |
| день в подсказке и таблице | «16 окт. 2026 (UTC)» |
| час | «16 окт., 09:00 UTC» |
| относительное время в журнале | «20 минут назад», точное время в `title` |
| токены в плитке | «1 611 100» |
| токены компактно (оси, таблица кэша) | «20,6 тыс.», «1,6 млн» |
| деньги из микродолларов | до $1 четыре знака: «$0,0081»; от $1 два: «$12,40» |
| доля | «86,9 %» через `Intl.NumberFormat` со `style: "percent"`, меньше 0,5 % пишется «<1 %» |
| окупаемость | «6,9×» |
| задержка | в таблице «3,02 с», в карточке записи «3,020 с» |

Цвета рядов (`series-colors.ts`). Восемь наборов классов на шкалах DDC: brand-600, sky-500, amber-500, rose-500, ink-500, brand-300, sky-300, amber-300 (в тёмной теме на ступень светлее через `dark:`). Цвет ключа выбирается по хешу FNV-1a от ключа, при совпадении внутри одного графика берётся следующий свободный. Так одна модель одного цвета на всех страницах. Типы токенов закреплены: «Чтение кэша» sky-500, «Запись кэша» amber-500, «Выход» brand-600, «Вход без кэша» ink-400. Ряды сверх семи складываются в «Остальные» (ink-300).

Графики свои, на SVG, без новых зависимостей:

- `StackedBarChart`: столбцы стопкой по корзинам, ось Y с ровными делениями (`axis.ts`: 0 и пять шагов 1, 2, 2,5, 5 × 10ⁿ), подписи X не чаще пяти-шести на ширину, сетка тонкими линиями `--ddc-divider`. Подсказка: белая карточка `.card` с тенью, заголовок «16 окт. 2026 (UTC)», строки «квадрат, жирное значение, подпись», черта и «Итого». Клик по столбцу дневного графика задаёт `from = to = день` (график по часам) и показывает «Сбросить». Стрелки двигают выбранную корзину, Enter работает как клик, у графика скрытая подсказка для скринридера.
- `LineChart`: линии по группам, ось линейная или логарифмическая (0,5×, 1×, 2×, 5×, 10×), горизонтальная линия лимита пунктиром, одна точка вместо линии, если значение одно.
- `SeriesTable`: двойник графика. Колонки «Дата (UTC)» или «Время (UTC)», по колонке на ряд, «Итого». Числа справа, нули показаны, контейнер 300 px с прокруткой и затуханием у нижнего края, сортировки нет.
- `ChartCard`: заголовок, описание, справа управление и переключатель `ViewToggle` (две иконки `ChartColumnIcon` и `TableIcon`, класс `.segmented`, `aria-label` «График» и «Таблица»), под графиком `Legend`.
- `CompositionBar`: полоса 8 px со скруглением из сегментов «Чтение кэша», «Запись кэша», «Вход без кэша», подсказка «название, объём, доля».
- `UsageMeter`: `role="meter"`, `aria-valuemin=0`, `aria-valuemax=100`, `aria-valuenow`, подпись для скринридера «<модель> <квота>, пиковая загрузка». Цвет заливки: до 80 % brand-600, от 80 % amber-500, от 100 % rose-500, дорожка ink-100.

Плитки (`StatTiles`): сетка на 3 или 4 колонки, на телефоне одна. Плитка без кнопки, заголовок, значение 30 px, строка пояснения, значок `InfoHint` с подсказкой (задержка 700 мс, доступное имя), подпись «Нет данных» в углу при пустом периоде, скелетон при загрузке.

Правая панель (`RowInspector`): `role="dialog"`, `aria-modal="false"`, фиксированная карточка с отступом 8 px сверху и справа, ширина 560 px (журнал) или 680 px (лимиты), на экране уже 768 px на всю ширину. Верхняя полоса: крошка, кнопки «Предыдущая», «Следующая», «Закрыть» (`ChevronUpIcon`, `ChevronDownIcon`, `XIcon`, 24 × 24). Открывается параметром адреса, Escape закрывает и возвращает фокус на строку списка. Выбранная строка подсвечена `--ddc-selected-bg` и имеет `aria-selected`.

Копирование ID (`CopyableId`): моноширинный ID, значок `CopyIcon` при наведении (на телефоне всегда), после копирования тост «Скопировано».

Состояния каждой страницы:

- загрузка: скелетоны в плитках, серая плита вместо графика, 20 строк скелетона в журнале;
- пусто: `EmptyState` с текстом «За период нет вызовов модели. Запустите сессию агента.»;
- ошибка: `LoadError` с кнопкой «Повторить»;
- 501: выноска `.callout-warning` «На этой базе данных аналитика не ведётся.» вместо содержимого.

Узкий экран 390 px: фильтры рядами, плитки в один столбец, таблицы внутри карточек с горизонтальной прокруткой, у таблицы разбивки кэша и таблицы лимитов первая колонка закреплена, правая панель на всю ширину. Горизонтальной прокрутки страницы нет. Скриншоты каждой страницы на 1280 и 390 px.

### 6.3 Использование (`/analytics/usage`)

1. Шапка: «Использование», «Токены вызовов модели по агентам, моделям и harness. Даты в UTC.»
2. Фильтры, ряд 1: Период, «Сбросить», справа CSV. Ряд 2: Агент, Модель, Harness, Карточка, разделитель, Группировать по.
3. Плитки (3): «Токены на входе» (`input + cache_read + cache_write`, пояснение «из них из кэша: N»), «Токены на выходе», «Запросы к модели» (пояснение «из них с ошибкой: N»). Плитки веб-поиска нет: у нас нет таких данных.
4. Карточка «Расход токенов», описание «Вход и выход по дням, сложено по группе». Высота столбца равна входу (с кэшем) плюс выход. При группировке «Тип токена» четыре ряда: «Чтение кэша», «Запись кэша», «Выход», «Вход без кэша». Подсказка и таблица по разделу 6.2.
5. CSV: `GET /usage?format=csv` с текущими фильтрами, файл скачивается через `apiRaw` и ссылку на `Blob`.

### 6.4 Кэширование (`/analytics/caching`)

1. Шапка: «Кэширование», «Как часто вызовы модели берут вход из кэша промпта. Последние 7 дней, даты в UTC.»
2. Липкая строка фильтров: Модель, Агент, Период «7 дней» (выключен), разделитель, Группировать по. Справа подпись «Данные на 16 окт., 09:12 UTC».
3. Плитки (3): «Вход без кэша», «Чтение из кэша», «Доля чтения из кэша», у каждой `InfoHint`.
4. Карточка «Агенты с низкой долей кэша»: таблица «Агент, Модель, Вход, Доля чтения» из `low_cache_agents`. Пусто: «Все агенты с заметным входом читают из кэша больше половины.» Если чтения и записи кэша за 7 дней нет совсем, вместо карточки «Кэш не используется: токены чтения и записи равны нулю.»
5. Карточка «Разбивка кэша»: колонки «Модель» (или «Агент»), «Вход» с сортировкой по клику (стрелка, строка «Итого» всегда сверху, жирная), «Состав входа» (`CompositionBar`), «Доля чтения», «Окупаемость записи» с `InfoHint`. Легенда под таблицей.
6. Три карточки графиков:

| Карточка | Описание | Управление | График |
|---|---|---|---|
| «Состав входа» | «Доля чтения, записи и входа без кэша. Чем меньше входа без кэша, тем дешевле.» | Модель (одна или все) | столбцы стопкой по часам за 7 суток |
| «Доля чтения из кэша» | «Чтение из кэша, делённое на весь вход, по группам.» | Окно: 1 ч, 3 ч, 6 ч (по умолчанию), 24 ч | линии по группам |
| «Окупаемость записи» | «Сколько токенов прочитано на один записанный.» | Окно: 1 ч, 6 ч, 24 ч (по умолчанию), 7 дн | линии, логарифмическая ось |

Окно считается в браузере по часовым рядам: точка часа `h` берёт суммы за часы `(h - W, h]`. Точки без входа (или без записи для окупаемости) пропускаются, линия рвётся.

### 6.5 Лимиты (`/analytics/limits`)

1. Шапка: «Лимиты», «Лимиты запросов и токенов в минуту из карточек моделей и пиковая загрузка за 24 часа. Платформа не останавливает вызовы при превышении.»
2. Липкая панель: поиск «Найти квоту» (`?q=`, фильтрует сразу по названию модели, handle, `wire_model` и названию квоты), «Сбросить».
3. Таблица без рамки, колонки «Квота», «Пиковая загрузка» с `InfoHint` («Наибольшая загрузка одной минуты за 24 часа, делённая на лимит карточки.»), «Использовано / лимит».
4. Группа на карточку: строка с названием модели и handle моноширинным шрифтом, под ней три строки «Токены на входе в минуту (без чтения кэша)», «Токены на выходе в минуту», «Запросы в минуту». Ячейка загрузки: `UsageMeter` и процент. Ячейка справа: «1,2 тыс. / 30 тыс.». Без лимита: индикатора нет, «1,2 тыс. / не задан».
5. Группа «Без карточки» для `uncarded`: те же строки без индикатора, строки не кликаются, подсказка «Лимит задаётся в карточке модели, у встроенной модели карточки нет.»
6. Строки карточек кликаются и открывают правую панель (`?focus=mc_01:itpm`).
7. Пустой поиск: «Квоты по запросу не найдены.» Нет карточек и вызовов: «Карточек моделей нет. Добавьте карточку, чтобы задать лимиты.» со ссылкой на `/model-cards`.

Правая панель квоты (`LimitDrawer`, 680 px):

- крошка «Лимит» и «Рабочее пространство», кнопки перехода к соседней квоте списка и «Закрыть»;
- заголовок: название модели и квоты;
- блок «Лимит карточки»: значение с единицей («30 000 токенов в минуту») или «не задан», кнопка «Изменить». Форма в том же блоке: три поля «Запросов в минуту», «Токенов на входе в минуту», «Токенов на выходе в минуту» (пусто значит без лимита), кнопки «Сохранить» и «Отмена». Сохранение через `PUT`, тост «Лимиты сохранены», перезапрос `GET /limits` и панели;
- блок «Пик за 24 часа» с переключателем «По агентам | По сессиям»: строка «пик / лимит единица» и процент жирным, под ней `UsageMeter` во всю ширину;
- блок «Последние 7 дней» с «График | Таблица»: линия пиков по часам и пунктир лимита; таблица «Время (UTC), Пик, Лимит»;
- блок «Разбивка на момент пика»: таблица «Агент» (или «Сессия», ссылка на сессию), «Пик», «% лимита», «Доля», последняя строка «Итого».

### 6.6 Стоимость (`/analytics/cost`)

1. Шапка: «Стоимость», «Расчётная стоимость вызовов модели по ценам карточек и каталога Pi. Даты в UTC.»
2. Одна строка фильтров: Агент, Модель, Harness, Карточка, Период, разделитель, Группировать по; справа CSV.
3. Плитки (4): «Общая стоимость» (`InfoHint`: «Сумма по вызовам с известной ценой.»), «Вход и выход», «Кэш» (чтение и запись), «Запросы без цены» (`InfoHint`: «Задайте цену в карточке модели.»).
4. Карточка «Стоимость по дням», ось Y в долларах. Группировка «Тип токена» берёт четыре части стоимости. В подсказке после «Итого» строка «Без цены: N запросов», если их больше нуля. Таблица «Дата (UTC), ряды в долларах, Итого».

### 6.7 Журнал запросов (`/analytics/logs`)

1. Шапка: «Журнал запросов», «Отдельные вызовы модели за выбранный период, новые сверху. Строка появляется, когда вызов завершён.»
2. Фильтры: Период, Агент, Модель, Harness, Карточка, Статус, «Сбросить», справа CSV. Фильтр `session_id` приходит из ссылки сессии и виден чипом «Сессия: sesn_…» с крестиком.
3. Таблица (`LogTable`), 20 строк на странице. Колонки:

| Колонка | Выравнивание | Значение |
|---|---|---|
| ID | слева | `CopyableId` |
| Статус | слева | точка `--ddc-dot-success` и «Успешно» или `--ddc-dot-danger` и «Ошибка» |
| Время | слева | относительное, точное в `title` |
| Агент | слева | имя |
| Модель | слева | handle |
| Вход | справа | `input + cache_read + cache_write` |
| Выход | справа | `output_tokens` |
| Задержка | справа | «3,02 с», без времени начала «нет» |
| Стоимость | справа | деньги или «нет цены» |
| Скорость | слева | «Обычная» или «Быстрая» |

4. Низ: слева «Предыдущая страница» и «Следующая страница» (курсоры страниц хранятся стеком в состоянии), справа «На момент 09:15 UTC» и «Обновить».
5. Клик по строке открывает карточку записи (`?request=sevt_…`).

Карточка записи (`RequestCard`, 560 px):

- полоса: «Запрос» и ID серым моноширинным, «Предыдущая», «Следующая» (по строкам текущей страницы), «Закрыть»;
- заголовок: handle модели;
- пары «подпись, значение»: «Время», «Модель» (handle и ниже `wire_model`), «Карточка» (handle или «Ключ сервера»), «Harness», «Агент» (ссылка на `/agents/:id`), «Сессия» (ссылка «Открыть сессию»), «Окружение», «Скорость», «Усилие» («По умолчанию», если нет), «Задержка» («3,020 с», `InfoHint`: «Время от начала вызова модели до конца ответа по часам сервера.»), «Причина остановки», «ID ответа провайдера»;
- секция «Токены»: «Вход без кэша» (`InfoHint`: «Входные токены, которые не прочитаны из кэша и не записаны в него.»), «Чтение кэша», «Запись кэша», «Выход»; при `usage_reported = false` выноска «Harness не прислал токены этого вызова.»;
- секция «Стоимость»: итог, четыре части, «Цена из карточки», «Цена из каталога Pi» или «Цена не задана»;
- при ошибке выноска `.callout-danger` с `error_message`.

Если строки нет на текущей странице, карточка грузит `GET /model_calls/:id`.

Подписи harness для таблиц: `pi` «Встроенный цикл», `claude-acp` «Claude Code в песочнице», `ai-sdk` «AI SDK (устарел)», остальные как есть. Они лежат в `pages/analytics/analytics-text.ts`, без зависимости от файлов единицы C1.

### 6.8 Клиент API

`C/lib/analytics-api.ts`: типы ответов раздела 5 один в один и хуки на `useApiQuery` и `useApiMutation`:

| Функция | Маршрут |
|---|---|
| `useUsageReport(params)` | `GET /v1/oma/analytics/usage` |
| `useCacheReport(params)` | `GET /v1/oma/analytics/cache` |
| `useLimitsReport()` | `GET /v1/oma/analytics/limits` |
| `useLimitDetail(cardId, metric, by)` | `GET /v1/oma/analytics/limits/:card_id` |
| `useUpdateCardLimits()` | `PUT /v1/oma/analytics/limits/:card_id`, после успеха сбрасывает кэш запросов лимитов |
| `useModelCalls(params, cursor)` | `GET /v1/oma/analytics/model_calls` |
| `useModelCall(id)` | `GET /v1/oma/analytics/model_calls/:id` |
| `useAnalyticsFacets(from, to)` | `GET /v1/oma/analytics/facets` |
| `downloadAnalyticsCsv(apiRaw, path, params, fallbackName)` | `format=csv`, имя файла из `Content-Disposition` |

Тесты консоли подставляют ответы через `server.use(http.get(...))` из `msw` (`C/test/setup.ts`), общий `C/mocks/handlers.ts` не меняется.

## 7. Файлы

### 7.1 SERVER_FILES

Только новые файлы. Пути от корня репозитория.

Код:

- `platform/apps/main-node/src/lib/analytics/schema.ts`: `ANALYTICS_MIGRATIONS`, `ensureAnalyticsSchema(sql)`.
- `platform/apps/main-node/src/lib/analytics/price.ts`: `resolveCallPrice`, `costParts`.
- `platform/apps/main-node/src/lib/analytics/model-resolver.ts`: `createAnalyticsModelResolver`.
- `platform/apps/main-node/src/lib/analytics/call-context.ts`: агент, harness, поток и время из входа `accept` и кадров.
- `platform/apps/main-node/src/lib/analytics/model-call-recorder.ts`: `createModelCallRecorder`, метод `tap(input)`.
- `platform/apps/main-node/src/lib/analytics/recording-runner.ts`: `withModelCallRecording`.
- `platform/apps/main-node/src/lib/analytics/model-call-store.ts`: `createModelCallStore(sql)`: вставка, отчёты, журнал, минуты, итоги сессии, фасеты.
- `platform/apps/main-node/src/lib/analytics/limits-store.ts`: `createModelCardLimitsStore(sql)`.
- `platform/apps/main-node/src/lib/analytics/query-params.ts`: разбор и проверка параметров, курсор.
- `platform/apps/main-node/src/lib/analytics/csv.ts`: запись CSV.
- `platform/apps/main-node/src/lib/analytics/analytics-routes.ts`: `buildAnalyticsRoutes({ sql, dialect, modelCards, now })`.
- `platform/apps/main-node/src/lib/analytics/index.ts`: экспорт для подключения.

Тесты:

- `platform/apps/main-node/test/_helpers/analytics-seed.ts`: набор фактов (3 дня, 2 агента, 2 модели, одна строка без цены, одна без usage, одна ошибка, подагент).
- `platform/apps/main-node/test/analytics-schema.test.ts`
- `platform/apps/main-node/test/analytics-price.test.ts`
- `platform/apps/main-node/test/analytics-model-resolver.test.ts`
- `platform/apps/main-node/test/analytics-call-context.test.ts`
- `platform/apps/main-node/test/analytics-model-call-recorder.test.ts`
- `platform/apps/main-node/test/analytics-recording-runner.test.ts`
- `platform/apps/main-node/test/analytics-model-call-store.test.ts`
- `platform/apps/main-node/test/analytics-limits-store.test.ts`
- `platform/apps/main-node/test/analytics-query-params.test.ts`
- `platform/apps/main-node/test/analytics-csv.test.ts`
- `platform/apps/main-node/test/analytics-routes.test.ts`
- `platform/apps/main-node/test/analytics-model-calls.postgres.test.ts`: пропускается без `OMA_TEST_POSTGRES_URL`, как `managed-session-execution.postgres.test.ts`.

Файлы пакета `model-cards-store` разрешены к правке для полей лимитов, но не нужны (раздел 4.3).

### 7.2 CONSOLE_FILES

Новые, общие компоненты в `platform/apps/console/src/components/analytics/`:

- `analytics-nav.ts`, `analytics-format.ts`, `analytics-format.test.ts`, `analytics-params.ts`, `analytics-params.test.ts`, `use-analytics-params.ts`, `series-colors.ts`, `series-colors.test.ts`, `axis.ts`, `axis.test.ts`;
- `AnalyticsHeader.tsx`, `FilterBar.tsx`, `FilterBar.test.tsx`, `RangeFilter.tsx`, `RangeFilter.test.tsx`, `MultiSelectFilter.tsx`, `MultiSelectFilter.test.tsx`, `SingleSelectFilter.tsx`;
- `StatTiles.tsx`, `StatTiles.test.tsx`, `InfoHint.tsx`, `ChartCard.tsx`, `ViewToggle.tsx`, `Legend.tsx`;
- `StackedBarChart.tsx`, `StackedBarChart.test.tsx`, `LineChart.tsx`, `LineChart.test.tsx`, `SeriesTable.tsx`, `CompositionBar.tsx`, `CompositionBar.test.tsx`, `UsageMeter.tsx`, `UsageMeter.test.tsx`;
- `RowInspector.tsx`, `RowInspector.test.tsx`, `CopyableId.tsx`.

Новые страницы в `platform/apps/console/src/pages/analytics/`:

- `analytics-text.ts`, `analytics-fixtures.ts` (ответы API по разделу 5 для тестов);
- `UsageCostLayout.tsx` (общее тело «Использования» и «Стоимости»);
- `UsagePage.tsx`, `UsagePage.test.tsx`, `CostPage.tsx`, `CostPage.test.tsx`;
- `CachingPage.tsx`, `CachingPage.test.tsx`;
- `LimitsPage.tsx`, `LimitsPage.test.tsx`, `LimitDrawer.tsx`;
- `LogsPage.tsx`, `LogsPage.test.tsx`, `LogTable.tsx`, `RequestCard.tsx`.

Новый клиент API:

- `platform/apps/console/src/lib/analytics-api.ts`, `platform/apps/console/src/lib/analytics-api.test.ts`.

Правки:

- `platform/apps/console/src/main.tsx`: маршруты `/analytics/*`;
- `platform/apps/console/src/components/AppSidebar.tsx`: группа «Аналитика»;
- `platform/apps/console/src/components/AppSidebar.linear.test.tsx`: новый порядок групп и ссылок.

### 7.3 Не трогаем

`N/src/modules/node-http.ts`, `node-managed.ts`, `node-foundation.ts`, `N/src/lib/node-managed-session-runtime.ts` (только импорт типов), песочница, `C/components/session/*`, `C/pages/SessionDetail.tsx`, `C/pages/agents/AgentFormDialog.tsx`, файлы скилла `verify-agent-console`, `C/styles/*`, `C/i18n/*`, `C/components/ConsoleSurface.tsx`, `C/components/DataTable.tsx`, `C/components/CommandPalette.tsx`, `C/pages/ModelCardsList.tsx`, `P/packages/model-cards-store/*`, `P/packages/db-schema/*`, каталоги миграций.

## 8. Порядок работ и первые тесты

Строгий TDD: сначала падающий тест, потом код. Команды по одной, без watch и dev-серверов:

```sh
cd /home/vnkjd/orca/projects/ai-native-backoffice-v3/platform/apps/main-node
test-slot pnpm exec vitest run --maxWorkers=2 test/analytics-schema.test.ts
test-slot pnpm typecheck

cd /home/vnkjd/orca/projects/ai-native-backoffice-v3/platform/apps/console
test-slot pnpm exec vitest run --maxWorkers=2 src/components/analytics/analytics-params.test.ts
test-slot pnpm typecheck

cd /home/vnkjd/orca/projects/ai-native-backoffice-v3
node scripts/unslop-check.mjs <файлы с текстом для людей>
```

Сервер, по порядку (каждая строка: файл теста и первый красный тест):

1. `analytics-schema.test.ts`: «на пустой SQLite создаются `model_calls`, `model_card_limits`, четыре индекса и две записи шагов; второй вызов ничего не меняет».
2. `analytics-price.test.ts`: «20 токенов входа по $3 и 10 выхода по $15 дают части 60 и 150 и итог 210»; затем «цена карточки побеждает каталог», «`claude-sonnet-4-6` без карточки берёт цену каталога», «неизвестная модель даёт `none`».
3. `analytics-model-resolver.test.ts`: «карточка по handle даёт `card`, без карточки с ключом сервера `builtin`, без ключа `unknown`; второй вызов за 60 секунд не читает карточку».
4. `analytics-call-context.test.ts`: «`acp-sandbox` с `acp.agent.id = claude-acp` даёт harness `claude-acp`; пустой harness даёт `pi`; подагент из ростера по `agent_name` получает свой `agent_id` и модель».
5. `analytics-model-call-recorder.test.ts`: «кадры начала и конца дают одну строку с `latency_ms = 3020`, `day` по UTC и токенами из `model_usage`»; затем «конец без начала даёт `started_at = null`», «кадр без `model_usage` даёт нули и `usage_reported = 0`», «ошибка вставки уходит в `logger.warn`, исключения наружу нет».
6. `analytics-recording-runner.test.ts`: «факт пишется после того, как исходный `output` завершился; при ошибке `output` факта нет; `start`, `stop`, `archiveThread` доходят до исходного runner».
7. `analytics-model-call-store.test.ts`: «повтор того же `id` не добавляет строку»; затем итоги, группы по модели, агенту, harness, карточке и окружению, корзины по дням и часам, курсор без потерь и повторов при одинаковом `ended_at`, пик по минутам, итоги сессии, фасеты на наборе `analytics-seed.ts`.
8. `analytics-limits-store.test.ts`: «upsert заменяет три значения, `null` снимает лимит».
9. `analytics-query-params.test.ts`: «по умолчанию 30 дней до сегодня по UTC; 93 дня дают 400; `bucket=hour` на 8 дней даёт 400; испорченный курсор даёт 400».
10. `analytics-csv.test.ts`: «запятая, кавычка и перевод строки в поле дают поле в кавычках; строки через CRLF».
11. `analytics-routes.test.ts`: каждый маршрут раздела 5 на SQLite в памяти (`createBetterSqlite3SqlClient(":memory:")`) отдаёт JSON в форме примеров; `PUT` проверяет тело; 404 и 501 с текстом по-русски.
12. `analytics-model-calls.postgres.test.ts`: тот же набор отчётов на Postgres, суммы приходят числами.

Консоль, по порядку:

1. `analytics-params.test.ts`: «для 2026-10-16 по UTC: `30d` даёт 2026-09-17..2026-10-16, `mtd` 2026-10-01..2026-10-16, `last_month` 2026-09-01..2026-09-30; значения по умолчанию в адрес не пишутся».
2. `analytics-format.test.ts`: «12720 микродолларов дают `$0,0127`, 12 400 000 дают `$12,40`; 1 611 100 компактно `1,6 млн`; час `16 окт., 09:00 UTC`».
3. `series-colors.test.ts`, `axis.test.ts`: «один ключ всегда одного цвета; деления оси для 1 450 000 равны 0, 500 тыс., 1 млн, 1,5 млн».
4. `analytics-api.test.ts`: «хуки собирают адрес с параметрами и списками через запятую; CSV берёт имя файла из `Content-Disposition`».
5. Компоненты: `MultiSelectFilter`, `RangeFilter`, `FilterBar` («Сбросить» видна только при отличии от умолчаний), `StatTiles`, `StackedBarChart` (подсказка и клик по столбцу), `LineChart`, `CompositionBar`, `UsageMeter` (`role="meter"` и цвет по порогу), `RowInspector` (Escape закрывает и возвращает фокус).
6. Страницы: `UsagePage`, `CostPage`, `CachingPage`, `LimitsPage` (панель и `PUT`), `LogsPage` (страницы курсора и карточка записи) на ответах из `analytics-fixtures.ts`.
7. `AppSidebar.linear.test.tsx`, затем правка `AppSidebar.tsx` и `main.tsx`.
8. Скриншоты 1280 и 390 px каждой страницы на подставных ответах.

Тяжёлые процессы по одному: один `vitest` или один `typecheck` за раз.

## 9. notDone

Делаем следующим шагом, после коммита чужих правок в этих файлах.

`platform/apps/main-node/src/modules/node-http.ts`, импорт рядом с остальными:

```ts
import { buildAnalyticsRoutes } from "../lib/analytics/index.js";
```

и строка после `v1.route("/oma/model_cards", ...)` (сейчас строка 608):

```ts
v1.route("/oma/analytics", buildAnalyticsRoutes({ sql, dialect, modelCards: modelCardsService }));
```

`platform/apps/main-node/src/modules/node-managed.ts`, импорт:

```ts
import {
  createAnalyticsModelResolver,
  createModelCallRecorder,
  createModelCallStore,
  withModelCallRecording,
} from "../lib/analytics/index.js";
```

перед `new ApplicationBackedNodeManagedSessionRuntimeEngine(...)` (сейчас строка 664):

```ts
const modelCallRecorder = foundation.dialect === "mysql"
  ? null
  : createModelCallRecorder({
      store: createModelCallStore(sql),
      resolveModel: createAnalyticsModelResolver({
        modelCards: modelCardsService,
        serverKeyAvailable: Boolean(config.model.apiKey),
      }),
      logger,
    });
```

и в том же вызове вместо `runner: managedRuntimeRunner,` (сейчас строка 670):

```ts
runner: modelCallRecorder === null
  ? managedRuntimeRunner
  : withModelCallRecording(managedRuntimeRunner, modelCallRecorder),
```

Сквозной тест подключения (новый файл того шага): `platform/apps/main-node/test/managed-analytics-wiring.test.ts`. Агент с карточкой фейковой модели делает ход, `GET /v1/oma/analytics/usage` и `/model_calls` отдают токены и стоимость этого хода, повторный запрос журнала сессии не дублирует строки.

Остальное, что в этот шаг не входит:

- пункты «Аналитика» в `C/components/CommandPalette.tsx` (файл не в списке консоли);
- ссылка «Аналитика агента» на `/analytics/usage?agent_id=` в карточке агента и «Все запросы сессии» на `/analytics/logs?session_id=` в шапке сессии (единицы C1 и C2 плана);
- поля цены в форме карточки модели (единица C1);
- `session.usage` за всю сессию (правка `node-managed-harness-runtime.ts`, единица S3 плана);
- учёт `span.compaction_summarize_end` и `aux.model_call`;
- срок хранения строк `model_calls` и очистка;
- проверки в скилле `verify-agent-console` (единица V1 плана);
- агент-конструктор, который создаёт агентов, файлы, оценки, окружения и навыки, из запроса владельца: отдельный план.

## 10. Риски и непроверенное

- Смысл `input_tokens` у ACP-агентов не проверен. Если `claude-agent-acp` отдаёт вход вместе с кэшем, доля чтения и стоимость у Claude Code будут завышены. Признак строки `harness` позволяет найти такие строки.
- У `claude-agent-acp` может не быть usage: тогда строки хода с нулями и `usage_reported = 0`, карточка записи это показывает.
- ACP считается по ходам: одна строка на ход, задержка равна длительности хода, пик в минуту грубее.
- Агент подагента определяется по имени из `session.thread_created`. Переопределённое имя или поток, созданный до перезапуска сервера, дают данные основного агента.
- Минута пика считается по концу вызова, а не по началу, как у провайдера.
- Цены: каталог Pi может отставать, ступени цены и запись кэша на 1 час не учитываются, быстрая скорость у Anthropic дороже, а каталог этого не знает.
- Сжатие контекста и вспомогательная модель не попадают в учёт, итог меньше счёта провайдера.
- Факт пишется вне транзакции события и может потеряться при падении процесса.
- Рост таблицы без срока хранения.
- Тест на Postgres требует `OMA_TEST_POSTGRES_URL` и контейнер Docker, на ноутбуке запускать по согласию владельца.
- Тёмная тема: контраст восьми цветов рядов на `--ddc-surface` не измерен, проверить скриншотами.
