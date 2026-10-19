# Python SDK, Go SDK и CLI для OpenMA: проект

Статус: отложено 2026-10-19 по решению владельца. Проект собран разведкой, код SDK не писался. Пути `S/...` вели во временную папку сессии и больше не существуют.

Проект собран из отчётов четырёх разведчиков и из чтения кода. Вызовов к нашему серверу не было, файлы репозитория не менялись. Метки проверки такие. «Проверено тестом» значит прогон на подставном транспорте в scratch (`S/go/run.log`, `S/py-sdk/run.log`). «По разбору кода» значит только чтение кода.

Сокращения путей:
- `S` = `/tmp/claude-1000/-home-vnkjd-orca-projects-ai-native-backoffice-v3/dfbffb05-b785-4431-99b2-b60f1164ad36/scratchpad/sdk-research`
- `P` = `platform/`
- `GO` = `~/go/pkg/mod/github.com/anthropics/anthropic-sdk-go@v1.82.0`
- `PY` = anthropic 1.15.0 в `S/py`

## 1. Подход и версии

Берём композицию, как в `@openma/sdk` (`P/packages/sdk/src/index.ts:101-127`). Официальный клиент лежит внутри нашего без изменений, и `client.beta` остаётся тем же объектом. Расширения живут в `client.oma`, а поле `_oma` разбирают в типы наши помощники.

Почему не генерируем свой SDK:
- Anthropic генерирует свои SDK в Stainless (`GO/CONTRIBUTING.md:20-27`). Это закрытый сервис, а открытые генераторы дают код другого вида.
- У сервера нет спецификации OpenAPI, она есть только в плане (`docs/design.md:277`). Маршруты `/v1/oma` написаны руками на Hono без zod (`P/packages/http-routes/src/model-cards/index.ts:250-428`).
- `/v1` уже поддерживает Anthropic. Композиция получает эту часть без затрат, руками типизируем только `/v1/oma` и `_oma`.
- Композицию в Go и Python собрали и прогнали на подставном транспорте (проверено тестом).

Минус композиции: в Go и Python нет слияния объявлений, как в TS (`P/packages/sdk/src/agents.ts:259-269`). Поэтому поля вне `_oma` (stdio в `mcp_servers`, `model.provider_options`) идут через `extra_body` в Python и через `WithJSONSet` или `SetExtraFields` в Go. Подход стоит пересмотреть, если `/v1/oma` вырастет до десятка ресурсов с телами. Тогда генерировать только `/v1/oma` из схем.

Версии официальных SDK:
- **Go: `anthropic-sdk-go v1.82.0`.** Другого выбора нет. CLI строится на `anthropic-cli/pkg/cmd`, а тот требует v1.82.0 (`anthropic-cli@v1.42.0/go.mod:6`), поэтому MVS поднимет до 1.82 любую версию ниже. В Go строка require задаёт нижнюю границу, пользователь может поднять её своим `go.mod`.
- **Python: `anthropic==1.15.*`.** Обёртка импортирует приватные `anthropic._resource`, `anthropic._base_client` и `make_request_options` (`PY/_resource.py:10-36`, `PY/_base_client.py:2516-2536`), поэтому закрепляем минорную версию. Пакет 1.15 зависит от `httpx2`, а не от `httpx` (`anthropic-1.15.0.dist-info/METADATA:26`), и требует Python 3.10 или новее.
- **TS** остаётся на 0.120.0 до среза S8.

Что стоит новая линия:
- С Py 1.2, Go 1.68 и TS 0.122 `beta.files` и `beta.skills` не шлют beta-заголовок по умолчанию, а список файлов перешёл на PageCursor. Сервер отвечает на это 400 (раздел 6, пункты 1 и 2). До правки сервера наши SDK ставят эти beta-заголовки сами.
- Py 1.13+ и Go 1.80+ описывают `multiagent_20261001` своими типами, имена полей совпадают с нашими.
- Поле `execution_identity` строгая схема сервера отклоняет (`P/packages/managed-agents-api/src/contracts/agents.ts:349-362`). Это попадёт в таблицу совместимости.

Есть альтернатива: линия точного совпадения с TS 0.120, то есть Python 0.125.0 и Go v1.66.0. Все три вышли 2026-08-19, наборы событий и ключи create у них совпадают (проверено сравнением пакетов). Код обёртки при этом не меняется: `WithJSONSet`, `WithoutEnvironmentDefaults` и `ssestream.NewDecoder` есть и в v1.66 (`option/requestoption.go:289`, `:506`, `packages/ssestream/ssestream.go:24`). Но CLI всё равно потянет Go 1.82, а Python 0.125 последний выпуск до 1.0. Решает владелец, см. вопрос 2.

## 2. Пакеты, место, выпуск

| | Python SDK | Go SDK | CLI |
|---|---|---|---|
| Папка | `platform/sdks/python` | `platform/sdks/go` | `platform/sdks/cli` |
| Имя | дистрибутив и импорт `openma` | модуль `github.com/Nap20192/ai-native-backoffice-v3/platform/sdks/go`, пакет `openma` | модуль `.../platform/sdks/cli`, имя бинарника по вопросу 1 |
| Зависимости | `anthropic==1.15.*` | только `anthropic-sdk-go v1.82.0` | наш Go SDK и `anthropic-cli v1.42.0` |
| Тег | `platform/sdks/python/v0.1.0` | `platform/sdks/go/v0.1.0` | `platform/sdks/cli/v0.1.0` |

- `platform/sdks` лежит вне pnpm, потому что workspace берёт только `packages/*` и три приложения (`P/pnpm-workspace.yaml`).
- Go разбит на два модуля, для разработки есть `platform/sdks/go.work`. CLI тянет AWS, GCloud, otel и bubbletea, его бинарник весит 62 МБ. Пользователь Go SDK этих зависимостей не получает.
- Офлайн-правки из `S/go/go.mod` (`replace` для logr, поднятые otel и x/sync) в настоящий `go.mod` не переносим.
- Лицензия Apache-2.0, как у `P/LICENSE` и `@openma/sdk`. CLI импортирует ant под MIT, текст лицензии ant кладём в `platform/sdks/cli/NOTICE`.
- Версии по SemVer с 0.1.0. В каждом пакете ведём `CHANGELOG.md`. Запись выпуска называет линию официального SDK и контракт сервера.
- v0.1 не публикуем в PyPI и в публичные реестры. Ставим из git: `pip install "git+ssh://git@github.com/Nap20192/ai-native-backoffice-v3.git@platform/sdks/python/v0.1.0#subdirectory=platform/sdks/python"`. Для Go нужен `GOPRIVATE=github.com/Nap20192`.
- Агент готовит файлы и отдаёт владельцу команды `git tag` и `git push`. Сам он ничего не публикует.

## 3. Публичный API

### Общие правила (Python, Go и правка TS)

- **Базового адреса по умолчанию нет.** Конструктор берёт `base_url` или `OPENMA_BASE_URL`, без них выдаёт ошибку. Причина: без адреса официальный клиент идёт на `api.anthropic.com`. Пробный запуск ant так и отправил туда фиктивный ключ (проверено запуском).
- **Ключ и токен.** `api_key` или `OPENMA_API_KEY` уходит заголовком `X-Api-Key`. `auth_token` или `OPENMA_AUTH_TOKEN` уходит как Bearer. Bearer нужен ключам `oma_env_` для Work API (`P/packages/auth/src/index.ts:142-160`).
- **SDK не читают `ANTHROPIC_*`.**
  - В Go ставим `option.WithoutEnvironmentDefaults()` (`GO/option/requestoption.go:496-521`) и передаём свой `http.Client`. Эта опция сбрасывает клиент SDK до `http.DefaultClient` (`GO/internal/requestconfig/requestconfig.go:178`).
  - В Python явные аргументы отключают чтение env (`PY/_client.py:225-236`). Без ключа передаём `api_key=""` и `X-Api-Key: Omit()` (`:416-439`).
  - `ANTHROPIC_CUSTOM_HEADERS` Python читает всегда (`:254-261`). Срез S2 отключает его и закрепляет это тестом.
  - Проверено тестом: голый `Anthropic()` отправил подставной `ANTHROPIC_API_KEY`, а обёртка не отправила ничего.
- **Заголовка тенанта нет.** Сервер читает `x-active-tenant` только при входе по cookie (`P/packages/auth/src/index.ts:294-305`). С ключом API тенант задаёт сам ключ, поэтому `activeTenantId` в TS при входе по ключу ничего не делает. Если сервер когда-нибудь введёт выбор тенанта заголовком, удобное имя `anthropic-workspace-id`: новые SDK уже его шлют.
- **Официальное дерево.** `client.beta` в Python и `client.Beta` в Go остаются официальными без изменений и сами ставят `anthropic-beta`.
- **Заголовки на наших маршрутах.** `/v1/oma/*` beta-заголовок не нужен. Наши добавки на `/v1` идут через `client.get` и `client.post` и ставят `anthropic-beta: managed-agents-2026-04-01` сами.

Ресурсы `client.oma` в v0.1. Имена в Python пишутся через `snake_case`, в Go через `CamelCase`.

| Ресурс | Методы | Маршрут |
|---|---|---|
| `model_cards` | create; list (include_archived, provider, q, created_after, created_before, limit, page); retrieve; update(if_match); archive; unarchive; delete. Без `/:id/key`, он отдаёт ключ провайдера открытым текстом | `http-routes/src/model-cards/index.ts:236-474` |
| `models` | list(provider) | `oma-api/src/index.ts:25-46` |
| `model_options` | list() | `main-node/src/lib/catalog-routes.ts:27-31` |
| `trace` | retrieve(session_id, after, turn_id, page, turns_before); search(session_id, q, limit, after); export_otlp(session_id) | `main-node/src/lib/trace/routes.ts:282,378,398` |
| `dependencies` | check(kind, id, operation, version), в том числе kind `model_card` | `managed-agents-api/src/routes/dependencies.ts:21` |
| `sandbox_catalog` | retrieve() | `main-node/src/lib/sandbox-catalog-routes.ts:12-41` |
| `agents` | delete(id, if_match), unarchive(id) | `routes/agents.ts:192,215` |
| `sessions` | unarchive(id); outputs.list(id); outputs.retrieve(id, filename); events.stream(id) | `routes/sessions.ts:200`, `session-outputs.ts:73,89`, `session-events.ts:100` |
| `environments`, `vaults`, `memory_stores`, `deployments` | unarchive(id) | `environments.ts:264`, `vaults.ts:179`, `memory-stores.ts:229`, `deployments.ts:214` |
| `request` | произвольный запрос, только под `/v1/oma/*`, как `P/packages/sdk/src/oma.ts:196-202` | |

В v0.1 не входят:
- `stats`;
- маршруты для людей: me, tenants, api_keys, platform-mcp, integrations;
- внутренние маршруты: mcp-proxy, runtime-events;
- всё, что убирает волна очистки (раздел 6, пункт 9).

Типы `_oma`:
- `OmaAgentExtension`: aux_model (с max_tokens), appendable_prompts, context_management, model_settings, enable_general_subagent. Поле harness помечено как устаревшее. Поля один к одному повторяют схему (`contracts/agents.ts:68-87,260-269`).
- `OmaSessionExtension` с `limits`. В ответе к ним добавляются `used_tokens` и `used_child_turns` (`contracts/sessions.ts:26-31,132-143,249-259`).
- `OmaDeploymentCreateExtension` с полем `paused` (`contracts/deployments.ts:16-25`).

Поля вне `_oma`:
- `model.max_tokens` и `model.provider_options`;
- `StdioMcpServer`;
- `config.image` и `networking.allow_web_search` окружения;
- `session_thread_id` на событиях `user.tool_confirmation` и `user.custom_tool_result` (`contracts/session-event-inputs.ts:11-31`).

Блок `multiagent_20261001` берём готовым типом из официальных SDK 1.15 и 1.82.

**Ошибки.**
- На обеих лентах SDK выдаёт `DependencyConflictError` (409, поле `dependencies`) и `PreconditionFailedError` (412).
- На `/v1/oma` разбор принимает четыре формы ошибки: строку, конверт Anthropic, `{error:{type,code,message}}` и `{error:{type,message}}` с нестандартным типом.
- Все три официальных SDK повторяют 409 дважды (`PY/_base_client.py:947`, `GO/internal/requestconfig/requestconfig.go:265-272`). Проверено тестом: без `x-should-retry: false` уходит 3 запроса, с ним 1. Пока сервер не исправлен, наши SDK не повторяют 409.

**Ревизии.** Помощник `revision(resp)` читает `ETag`, наши методы записи принимают `if_match`. Для официальных вызовов то же делают штатно:
- в Python `with_raw_response` и `extra_headers={"If-Match": rev}`;
- в Go `option.WithResponseInto` и `option.WithHeader("If-Match", rev)`.

**Поток событий.** Официальные декодеры пропускают только события из своего списка и молча отбрасывают `session.usage` и `session.warning` (`PY/_streaming.py:93-160`, `GO/packages/ssestream/ssestream.go:236-283`, по разбору кода). Поэтому `oma.sessions.events.stream(id)` читает сырой SSE. Известное событие он отдаёт официальным типом, неизвестное отдаёт как `OmaRawEvent{type, data}`.

### Python

Классы `OpenMA` и `AsyncOpenMA` устроены так:
- Внутри лежит приватный подкласс `Anthropic`. Он переопределяет только `_make_status_error` и `_should_retry` (`PY/_client.py:448,565`), поэтому типизированные ошибки и запрет повтора 409 работают и на `client.beta`.
- Подкласс отключает цепочку профилей и федерации (`_client.py:281,299`). Нам она не нужна.
- `__init__` подкласс не меняет, поэтому `copy()` и `with_options` работают (`_client.py:524-536`).
- Наши ресурсы наследуют `SyncAPIResource` и `AsyncAPIResource`. Списки отдаются через `SyncPageCursor` и `AsyncPageCursor` (`PY/pagination.py:152-189`).

```python
from openma import OpenMA, OmaAgentExtension, DependencyConflictError, agent_extension

client = OpenMA(base_url="http://127.0.0.1:8791", api_key=os.environ["OPENMA_API_KEY"])
agent = client.beta.agents.create(
    name="reviewer", model="qwen3.6-35b",
    extra_body={"_oma": OmaAgentExtension(appendable_prompts=["prompt_review"]).to_body()},
)
ext = agent_extension(agent)  # читает agent.model_extra["_oma"], None если поля нет
for card in client.oma.model_cards.list(include_archived=True):
    print(card.id)
try:
    client.beta.agents.archive(agent.id)
except DependencyConflictError as err:
    print(err.dependencies)
```

Асинхронный клиент устроен так же: `await client.oma.model_cards.retrieve(id)`, `async for event in client.oma.sessions.events.stream(sid)`.

### Go

- `openma.NewClient(opts ...option.RequestOption) (*Client, error)` возвращает ошибку, если базового адреса нет.
- `Client` встраивает `anthropic.Client`, поэтому `client.Beta` официальный.
- Методы `Oma` принимают `ctx context.Context` первым аргументом и `...option.RequestOption` последним, как официальные.
- Списки `/v1/oma` листает наш цикл с `option.WithQuery("page", next)`. Официальный `PageCursor.GetNextPage` обращается к внутреннему конфигу SDK (`GO/packages/pagination/pagination.go:288-316`), поэтому взять его нельзя. Автолистание отдаёт `iter.Seq2[T, error]`, директива `go 1.24` такая же, как у SDK.
- `_oma` читаем через `agent.JSON.ExtraFields["_oma"].Raw()`. У неизвестного ключа `Valid()` всегда возвращает false (`GO/internal/apijson/decoder.go:488-522`). На этом первая версия набросков упала с nil pointer.
- Повтор 409 отключает middleware: оно ставит `x-should-retry: false` на ответ 409 (по разбору кода, проверить в срезе S5).

```go
client, err := openma.NewClient(option.WithBaseURL("http://127.0.0.1:8791"), option.WithAPIKey(key))
agent, err := client.Beta.Agents.New(ctx, anthropic.BetaAgentNewParams{Name: "reviewer" /* Model ... */},
	openma.WithAgentExtension(openma.AgentExtension{AppendablePrompts: []string{"prompt_review"}}))
ext, err := openma.AgentExtensionOf(agent) // nil, nil если поля нет
for card, err := range client.Oma.ModelCards.ListAutoPaging(ctx, openma.ModelCardListParams{IncludeArchived: anthropic.Bool(true)}) {
	_ = card; _ = err
}
_, err = client.Beta.Agents.Archive(ctx, agent.ID, anthropic.BetaAgentArchiveParams{})
if c, ok := openma.AsDependencyConflict(err); ok { fmt.Println(c.Dependencies) }
```

## 4. CLI

Делаем обёртку над `github.com/anthropics/anthropic-cli/pkg/cmd` v1.42.0, без форка. Пробная обёртка `S/ant-wrap/cmd/probe/main.go` собралась офлайн и сократила дерево команд с 90 групп до 31 (проверено запуском).

Какие команды остаются:
- Группы `/v1`, которые обслуживает сервер: beta:agents, beta:sessions (с events, threads, resources и `connect`), environments (с work), vaults, memory-stores, skills, files, deployments, deployment-runs, dreams, models. К ним `apply` и `beta:worker`.
- tunnels и user-profiles ждут решений 5.9 и 5.10 в `docs/plans/cleanup.md`.
- Убираем messages, completions, organization:* и `auth` (OAuth на platform.claude.com).

Новые команды `oma:*`: `oma:model-cards`, `oma:models`, `oma:model-options`, `oma:trace`, `oma:dependencies`, `oma:sandbox-catalog`, `oma:agents delete|unarchive`, `oma:sessions unarchive|outputs|stream`, `oma:<ресурс> unarchive`. Они зовут наш Go SDK.

Что ограничивает обёртку:
- Из `pkg/cmd` экспортированы только `Command`, `ShowJSON*`, `OutputFormats`, `ValidateBaseURL` и `Version`.
- `internal/requestflag` чужому модулю недоступен (проверено сборкой).
- Поэтому `oma:*` берут тело запроса из `--body @file.yaml` или из stdin через обычные флаги urfave и печатают ответ через `ShowJSON`.
- Форматы вывода те же, что у ant: auto, explore, json, jsonl, pretty, raw, yaml и `--transform`.

Учётные данные и настройки:
- До `Run` обёртка внутри процесса переносит `OPENMA_API_KEY` и `OPENMA_BASE_URL` в `ANTHROPIC_*`.
- Унаследованные `ANTHROPIC_*` она стирает, а `ANTHROPIC_CONFIG_DIR` направляет в `~/.config/openma`. Так профиль Anthropic владельца не уйдёт Bearer-токеном на наш сервер (`anthropic-cli/pkg/cmd/cmdutil.go:171-172`, по разбору кода).
- Без базового адреса CLI не запускается.
- Свой профиль (адрес и ключ, файл с правами 0600) обёртка читает сама. Профиль SDK ключ API хранить не умеет (`config/config.go:73-83`).

Известные ограничения v0.1:
- До правки 1 из раздела 6 `apply` со `skills/` и команды files и skills получают 400. Флага `--beta` у `apply` нет (`apply.go:95`).
- Ссылки в TUI `connect` ведут на platform.claude.com (`sessionconnect.go:83,120-124`).

Форк ant (лицензия MIT) понадобится, если `oma:*` вырастут до десятка ресурсов с телами и нужны будут сгенерированные флаги по полям. Цена форка: около 400 файлов и ручное слияние после каждой регенерации upstream.

## 5. Тесты и документы

Модульные тесты:
- **Python.** pytest с транспортом `httpx2.MockTransport` через `http_client`. respx не подходит: он работает с `httpx`, а не с `httpx2`. Асинхронные тесты идут через anyio. pyright в строгом режиме проверяет пакет и отдельные файлы проверки типов, как `expectTypeOf` в TS. mypy есть только в venv, глобально его нет.
- **Go.** `httptest.Server`, `go test ./...`, `go vet` и `staticcheck` (стоит в `~/go/bin`).
- **Набор случаев** повторяет `P/packages/sdk/test/composition.test.ts`:
  - `client.beta` остаётся тем же объектом;
  - в запросе правильные заголовки;
  - `_oma` доходит до сервера и читается из ответа;
  - при подставных env в запросе нет ни одного `ANTHROPIC_*`;
  - без адреса конструктор выдаёт ошибку;
  - список проходит две страницы;
  - разбираются все четыре формы ошибки;
  - на 409 уходит один запрос;
  - 412 приходит своим типом;
  - поток отдаёт `session.usage` и `session.warning`.

Контрактные тесты:
- Скрипт `platform/sdks/scripts/contract-server.mjs` поднимает main-node так же, как `apps/main-node/test/managed-agents-route.test.ts:1061-1083`: `PORT=0` и временная папка данных. Отличие одно: задан `API_KEY` и нет `AUTH_DISABLED`, чтобы тест прошёл путь входа по ключу. Скрипт пишет адрес во временный файл и останавливает сервер по своему PID.
- Наборы Python и Go читают `OPENMA_CONTRACT_BASE_URL`. Без этой переменной они пропускаются.
- Что проверяют контрактные наборы:
  - агент с `_oma` создаётся и читается обратно;
  - сессия создаётся с `_oma.limits`;
  - карточка модели с `If-Match` получает 412;
  - архив с зависимостью получает 409 со списком;
  - работает `oma.dependencies`;
  - загрузка и список файлов работают после правок 1 и 2;
  - кадры SSE на сессии без хода.
- Полный ход агента проверяет скилл `verify-agent-console` на изолированном экземпляре 8791.
- Порты 8787 и 8788 тесты не трогают. Тяжёлые команды идут через `nice -n 15` и по одной, `go test -p 2`, pytest без параллели.
- Steady на `GO/scripts/mock-spec.json.gz` ставим по желанию: ему нужна сеть для npm.

Примеры лежат в `examples/` каждого SDK: агент, сессия и поток; карточки моделей; проверка зависимостей. Один скрипт гоняет их против контрактного сервера.

Документы:
- `docs/sdk.md` с таблицей совместимости: контракт сервера, линии официальных SDK, наши версии, переменные окружения, состав v0.1.
- README каждого пакета по правилам unslop.
- `CHANGELOG.md` в каждом пакете.
- План `docs/plans/sdk.md`.
- Ссылку в `docs/README.md` добавляет координатор: в этом файле лежат незакоммиченные правки другой волны.

## 6. Пробелы на сервере и порядок правок

1. **Files и skills требуют beta-заголовок.** Его ждут `/v1/files`, `/v1/skills` и версии скиллов (`managed-agents-api/src/routes/files.ts:28`, `skills.ts:47`, `skill-versions.ts:49`). Py 1.2+, Go 1.68+, TS 0.122+, GA `client.files` и ant получают 400. Чинить первым: принимать запросы без заголовка.
2. **Список файлов читает только `after_id` и `before_id`** (`files.ts:31-57`). Новые SDK шлют `page` и `ids[]`. Поэтому фильтр по `ids` не работает, а автолистание останавливается после первой страницы.
3. **Нет `x-should-retry: false` на 409 бизнес-конфликтов.** Конфликт зависимостей стоит трёх запросов с паузами между ними. Заголовок нужно ставить на 409 и 412.
4. **На `/v1/oma` четыре формы ошибки**, а `platform/AGENTS.md:29` обещает одну. Совет: везде конверт Anthropic, потому что официальный разбор берёт `error.message`. Вместе с этим поправить ту строку `AGENTS.md`.
5. **TS SDK отстаёт.**
   - Без `apiKey` он отдаёт `ANTHROPIC_API_KEY` нашему серверу (`P/packages/sdk/src/index.ts:116-124`).
   - Адрес по умолчанию `https://openma.dev` (`:118`).
   - `homepage` и `repository` в `package.json:42-47` ведут на upstream.
   - Не хватает `max_tokens`, `multiagent_20261001`, `_oma.limits`, `session_thread_id`, `image`, `allow_web_search` и `_oma.paused`.
   - Нет unarchive, delete, outputs, ревизий, типизированных ошибок и архива карточек моделей.

   Чинить его нужно в одной волне с Python и Go, иначе три SDK разойдутся.
6. **`execution_identity` получает 400** от строгой схемы. Пока это описывает таблица совместимости.
7. **Сервер не отдаёт заголовки организации и workspace.** Поэтому `ant apply` сверяет `origin` только по хосту (`anthropic-cli/internal/declarative/claude/origin.go:21-50`).
8. **OpenAPI нет.** Для v0.1 она не нужна. Позже стоит выгрузить JSON Schema `_oma` из zod и сверять с ней типы Python и Go в тестах. `toJSONSchema` уже есть в коде (`apps/agent/src/harness/pi-loop-tools.ts:53`).
9. **Маршруты, которые убирает волна очистки, SDK не оборачивает.** Номера разделов по `docs/plans/cleanup.md`:
   - `/v1/oma/vaults` (3.1);
   - `/v1/oma/agents`, `environments`, `memory_stores`, `files`, `sessions/:id/memory_stores`, `dreams` (4.6);
   - старые `/v1/oma/sessions/*` (5.6);
   - `/v1/oma/skills` (5.7);
   - интеграции (5.1).

   `stats` живёт до K18 (`cleanup.md:412`), а evals на Node не работают (`:399`).

## 7. Срезы

Каждый срез ведёт один агент, тяжёлые срезы идут по одному. Каждое утверждение в отчёте среза несёт метку проверки.

| Срез | Что | Проверка |
|---|---|---|
| S0 | Правки 1, 2 и 3 из раздела 6 | Первым красный тест main-node, затем `pnpm --filter @open-managed-agents/main-node test -- test/<файл>.test.ts` и typecheck; curl на изолированном 8791 |
| S1 | Правка 4: формы ошибок `/v1/oma` | То же |
| S2 | Ядро Python: клиенты, env, ошибки, повторы, ревизии, `oma.request` | pytest на MockTransport, pyright strict |
| S3 | Ресурсы Python v0.1 и типы `_oma` | pytest, pyright strict |
| S4 | Поток событий Python, `contract-server.mjs`, контрактный набор Python | pytest; контракт на своём main-node, лог прогона |
| S5 | Ядро Go | `go test`, `go vet`, `staticcheck` |
| S6 | Ресурсы Go, `_oma`, поток, контрактный набор Go | То же плюс контракт |
| S7 | CLI | `go test` (перенос env, урезанное дерево, снимок `--help`), `go vet`; живой прогон `oma:model-cards list` и `beta:agents create` на 8791 |
| S8 | TS SDK по тем же правилам: адрес, env, типы, ошибки | `pnpm --filter @openma/sdk test` и `typecheck` через `test-slot --maxWorkers=2` |
| S9 | Примеры, `docs/sdk.md`, README, CHANGELOG | Примеры на контрактном сервере, `node scripts/unslop-check.mjs` |

S0 идёт первым: без него контрактные тесты файлов красные. S2 и S5 друг от друга не зависят. S4 ждёт S3, S6 ждёт S5, S7 ждёт S6.

## 8. Вопросы владельцу

1. **Как назвать пакеты, переменные окружения и CLI?** Совет такой:
   - пакеты Python и Go назвать `openma`, как `@openma/sdk` и поле `_oma`;
   - переменные `OPENMA_API_KEY`, `OPENMA_BASE_URL` и `OPENMA_AUTH_TOKEN` сделать общими для трёх SDK и CLI;
   - CLI назвать `boa`. Имя `oma` не подходит: так звалась удалённая команда upstream (`P/ORIGIN.md:50-58`). Имя `ant` занято бинарником Anthropic в `~/go/bin`. Другие кандидаты `bo` и `boctl`.

   README TS сейчас пишет `OMA_API_KEY` (`P/packages/sdk/README.md:15`), его поправит S8.
2. **Какую линию официальных SDK взять?** Совет: новую (Python 1.15, Go 1.82) вместе с правками сервера 1 и 2. CLI поднимет Go до 1.82 в любом случае, Python 0.125 последний выпуск до 1.0, а в новой линии `multiagent_20261001` описан готовым типом. Вариант для точного совпадения с TS 0.120: Python 0.125.0 и Go v1.66.0.
3. **Принимать `/v1/files` и `/v1/skills` без beta-заголовка?** Совет: да. Правило «без beta 400» (`platform/AGENTS.md:27`) остаётся для остальных ресурсов. Официальные SDK перестали ставить этот заголовок для файлов и скиллов 2026-08-27.
4. **Обёртка над ant или форк?** Совет: сейчас обёртка. Форк делать, когда `oma:*` вырастут до десятка ресурсов с телами.