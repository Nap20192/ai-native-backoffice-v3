# Очистка копии: ловушки, мёртвый код, решения владельца

Черновик 1, 2026-10-19. Статус: код шага 1 правится в рабочей копии, коммита ещё нет. Шаг 1 идёт в этой волне. Шаг 2 идёт следующей волной. Шаг 3 ждёт решения владельца, до ответа его пункты не трогаем.

Вход: разбор лишнего от 2026-10-19. Пять срезов (консоль, `apps/agent`, корень и документы, базы, сервер и пакеты) дали 121 пункт, каждый пункт проверил отдельный скептик. Пути, размеры и доказательства ниже взяты из разбора и из вердиктов скептика. Где они расходятся, план берёт число скептика. Разбор только читал код и ничего не запускал. Исключений два. Ссылки шага 1 на файлы, которые шаг правит, перечитаны на коммите f6fce12. Итог набора main-node взят из прогона 2026-10-19 04:52.

Пути: `N/` это `platform/apps/main-node/src`, `NT/` это `platform/apps/main-node/test`, `A/` это `platform/apps/agent/src`, `AT/` это `platform/apps/agent/tests`, `P/` это `platform/packages`, `C/` это `platform/apps/console/src`, `S/` это `.claude/skills/verify-agent-console`. Остальные пути от `platform/`, кроме `docs/`, `.claude/`, `.audit/`, `.verify-evidence/` и `internal/`.

Метки как в [verification.md](../verification.md): «проверено тестом», «проверено вживую», «не проверено». Метка «по разбору кода» значит, что вывод сделан чтением кода и вживую не проверялся.

## 1. Зачем

Копия OpenMA несёт код, который наш сервер Node не запускает:

- воркер и Durable Object Cloudflare в `apps/agent` (около 10 тысяч строк) и 10 пакетов, нужных только им;
- адаптеры песочниц daytona, e2b, boxrun и sprites, у нас работает только LiteBox;
- второй набор маршрутов `/v1/oma/*` поверх старых таблиц рядом с `/v1`;
- корневые скрипты и конфиги, которые ссылаются на файлы, которых в копии нет.

Typecheck и тесты ходят по лишним пакетам. Агенты читают мёртвый код и строят на нём планы. Часть интерфейса ведёт туда, где ничего не работает. Вкладка «CLI» хранилища секретов пишет в таблицу, которую сессии не читают. Пункт «Документация» уводит на сайт OpenMA. Переключатель browser ничего не включает. Ещё три теста main-node красные на каждом прогоне, поэтому зелёного полного набора сейчас не бывает.

## 2. Правила волны

- Код уходит, таблицы остаются в базах. Миграций удаления нет. Так решение D41 оставило таблицу `harness_cards` ([decisions-2026-10-17.md](../decisions-2026-10-17.md)). Если владелец захочет DROP, он идёт в плановую миграцию 0028 ([cma-wave-1.md](cma-wave-1.md), раздел 3.4) вместе со ступенью MySQL.
- Шаги 1 и 2 не трогают пункты шага 3.
- Каждый срез начинается с красного теста. Тест меняем, только если он проверяет убранное поведение. Причина пишется в отчёте среза.
- Индекс git, ветки и stash трогает только координатор. Порты 8787, 8788, 5173, 5174 и контейнеры Docker не трогаем. Живые доказательства снимаются на экземпляре скилла verify-agent-console (порт 8791, фейковая модель 8792).
- Локальные папки вне git удаляет владелец сам, план даёт ему команды (раздел 4.9).

## 3. Шаг 1. Ловушки

Цель шага: в консоли и у помощника не остаётся пунктов, которые ведут в никуда, а полный набор main-node зелёный. Ссылки на строки этого шага перечитаны на f6fce12.

### 3.1 Вкладка «CLI» в хранилище секретов

**Что не так.** В окне добавления учётных данных хранилища есть вкладка «CLI». Она шлёт учётку `cap_cli` на `POST /v1/oma/vaults/:id/credentials` (`C/pages/VaultDetail.tsx:1025`). Маршрут ищет хранилище в старой таблице `vaults` (`P/http-routes/src/vaults/index.ts:260-265`), а консоль даёт id из `managed_vaults`, поэтому ответ 404 «Vault not found». Даже успешная запись легла бы в старую таблицу `credentials` (`P/credentials-store/src/adapters/sql-credential-repo.ts:10`), а сессии `/v1` читают `managed_credentials` (`P/credential-store-sql/src/index.ts:70`). Вход по OAuth на вкладке зовёт `/v1/oma/cap-cli/oauth/initiate` и `/v1/oma/cap-cli/oauth/poll` (`VaultDetail.tsx:1055`, `:1097`), таких маршрутов на сервере нет. Резолвер cap сервер создаёт и сразу выбрасывает (`N/modules/node-http.ts:997-1010`, `void _capResolver`). Метка: по разбору кода, вживую не проверено.

**Где и размер.**

- консоль: в `C/pages/VaultDetail.tsx` список `CAP_CLIS` (`:87-101`), состояние формы и входа по OAuth (`:856-876`), обработчики от `createCapCliCred` до `selectedCli` (`:1022-1139`), вкладка `:1196` и её содержимое `:1401-1500`, около 300 строк по оценке разбора;
- сервер: монтирование `N/modules/node-http.ts:472`, импорт `:50`, резолвер `:992-1010`;
- `P/http-routes/src/vaults` (423 строки) и его экспорт `P/http-routes/src/index.ts:19-20`;
- пакет `P/oma-cap-adapter` (src 216 строк) и зависимость `apps/main-node/package.json:80`;
- тест `NT/cap-resolver.test.ts` (91 строка).

**Доказательство.** `/v1/oma/vaults` зовёт только эта вкладка. grep `cap-cli|oauth/initiate|oauth/poll` по `N/`, `P/http-routes/src` и `P/managed-agents-api/src` ничего не находит. `oma-cap-adapter` импортируют только `node-http.ts` и `cap-resolver.test.ts`. Тестов main-node на `/v1/oma/vaults` нет. В пробной копии таблицы `credentials` и `vaults` пустые, в `managed_vaults` одна строка (база читалась с `immutable=1`).

**Что остаётся.**

- Пакет `P/cap` (src 2262 строки, тесты 2910). Его импортирует `A/runtime/session-do.ts:3702`, пакет уходит в шаге 2 вместе с оболочкой Cloudflare.
- Ветка подписи строк `cap_cli` в списке учёток (`VaultDetail.tsx:65-72`). Мост GitHub пишет такие строки через старый `credentialService` в таблицу `credentials` (`N/lib/node-install-bridge.ts:770`, `:811`, подключение `N/modules/node-http.ts:678`). Страница читает `/v1/vaults/:id/credentials`, то есть `managed_credentials`, и в контракте `/v1` вида `cap_cli` нет. Поэтому ветка мёртвая и уходит в шаге 2 (раздел 4.7). Судьба моста решается в шаге 3.
- Старый сервис `services.vaults`: его берёт мост интеграций (шаг 3).
- Пакет `P/vault-forward`. Уходит только его импорт в `P/http-routes/src/vaults/index.ts:18`, сам пакет работает на пути MCP-прокси `/v1` (раздел 6).

**Риск.** Окно добавления учётки правит и срез 7 [cma-wave-1.md](cma-wave-1.md) (вкладка «Переменная окружения», `VaultDetail.tsx:813` и ниже). Срезы двух волн идут по очереди. После среза в `AddCredentialModal` нет обёртки `Tabs`: форма MCP-сервера стоит без вкладок. Срез 7 cma-wave-1 возвращает вкладки сам, когда добавляет вторую. Пустой список учёток пишет «Подключите MCP-сервер или добавьте токен CLI.» (`VaultDetail.tsx:427`), этот текст правится в том же срезе.

**Тесты.** Красный в консоли: окно добавления учётки не показывает вкладку «CLI», Bearer сохраняется через клиент `/v1`. Красный на сервере: `GET /v1/oma/vaults` отвечает 404, сейчас маршрут смонтирован и отвечает списком. `NT/cap-resolver.test.ts` удаляется: он проверяет резолвер, который убирает этот пункт.

### 3.2 Пункт «Документация» в меню профиля

**Что не так.** Пункт ведёт на `https://docs.openma.dev`, это сайт OpenMA (`C/components/UserProfile.tsx:105-114`). Своей документации у консоли нет, а консоль работает во внутреннем контуре.

**Где и размер.** Около 10 строк в `UserProfile.tsx` и ключ `profile.documentation` в четырёх файлах: `C/i18n/types.ts:152`, `ru.ts:137`, `en.ts:136`, `zh-CN.ts:136`. Ключ уходит из всех четырёх одной правкой, иначе tsc падает.

**Доказательство.** grep `Документация|documentation|docs.openma` по тестам консоли ничего не находит, тесты пункт не держат. Скептик понизил пункт до решения владельца, потому что [console-parity.md](console-parity.md) держит документацию в меню пользователя (`:78`, `:537`). Пункт входит в утверждённый шаг 1, поэтому эти две строки console-parity правятся в том же срезе.

**Риск.** Нет.

**Тесты.** Красный: тест меню профиля, в меню нет пункта «Документация» и ссылки на `docs.openma.dev`.

### 3.3 Переключатель browser в форме агента

**Что не так.** Форма агента предлагает «browser (по запросу)» (`C/pages/agents/AgentFormDialog.tsx:93`). Инструменты browser строятся только при `env.browser` (`A/harness/tools.ts:660`), а сервер Node не передаёт его ни в одном вызове `buildTools` (`N/modules/node-managed.ts:416`, `:582`, `N/modules/node-foundation.ts:400`). Агента с browser нельзя и сохранить: схема `/v1/agents` знает только bash, edit, read, write, glob, grep, web_fetch и web_search (`P/managed-agents-api/src/contracts/agent-input-components.ts:43-72`), а кодек формы шлёт запись `{name: "browser", enabled: true}` (`C/pages/agents/agentFormCodec.ts:693-699`). Ответ сохранения должен быть 400, вживую не проверено.

**Что делаем.**

- Убираем пункт из `BUILTIN_TOOLS` формы.
- Кодек формы знает те же восемь имён, что и схема `/v1/agents` (`TOOLSET_TOOL_NAMES` в `C/pages/agents/agentFormCodec.ts`). Запись с другим именем, например browser старого агента, форма не читает и при сохранении убирает. Иначе такой агент получал бы 400 на любое сохранение, а выключить browser в форме было бы нечем.
- `buildTools` без `env.browser` не даёт инструментов `browser_*` и не пишет про них подсказку в описании `web_fetch` (`A/harness/tools.ts`). Модель на Node не увидит browser ни через `/v1`, ни через старый путь `/v1/oma/agents`.
- Предупреждения `session.warning` об отключённом browser нет. Ни один путь Node его бы не показал: агента `/v1` с browser не бывает, схема отклоняет имя, а старый путь не передаёт `broadcastEvent` (`N/modules/node-foundation.ts:400`). К тому же `buildTools` зовётся на каждом ходе и для каждого субагента (`N/lib/node-managed-session-runner.ts:626`, `:776`), и предупреждение шло бы на каждом ходе. Вопрос о его языке тоже снят.

**Что остаётся.** `OPT_IN_TOOLS` (`A/harness/tools.ts:48`), ветка `:660` и пакет `P/browser-harness`. Тест `apps/agent/test/builder-harness.test.ts:19` закрепляет, что `getEnabledBuiltinTools` возвращает browser. План окружений выносит браузер на Node за рамки ([environments.md](environments.md), `:754`). Вопрос о пакете в разделе 5.13.

**Риск.** Форма убирает запись browser старого агента при первом сохранении. Схема `/v1` её всё равно не примет, поэтому агент ничего не теряет.

**Тесты.** Красные в консоли: пункта browser в форме нет; запись browser старого агента уходит из тела сохранения, запись bash остаётся. Охранник `apps/agent/test/browser-tool.test.ts`: без `env.browser` нет ни `browser_*`, ни подсказки в `web_fetch`, событий сборка не шлёт. На f6fce12 подсказка стояла всегда, поэтому охранник красный.

### 3.4 Инструмент помощника get_trajectory

**Что не так.** `get_trajectory` читает `GET /v1/oma/sessions/:id/trajectory` (`N/lib/platform-mcp/tools/read.ts:488`, правило `N/lib/platform-mcp/route-rules.ts:95`). Маршрут ищет сессию в старой таблице `sessions` (`P/http-routes/src/sessions/index.ts:831-840`). Сессии консоли лежат в `managed_sessions`, поэтому на любую сессию `/v1` маршрут отвечает 404, а помощник пишет «Траектории нет». Метка: по разбору кода, вживую не проверено. Тест `NT/platform-mcp-tools.test.ts:92-94` зелёный, потому что фейк `NT/helpers/platform-mcp-fake.ts:171` отдаёт старый маршрут.

**Что делаем.** Инструмент читает трейс сессии `GET /v1/oma/sessions/:id/trace` (`N/lib/trace/routes.ts:282`, смонтирован в `N/modules/node-http.ts:448`). Тот же маршрут читает страница сессии (`C/lib/trace-api.ts:351`). В трейсе есть шаги хода с длительностью, это и обещает справка помощника (`assistant/docs/session-review.md:9`, `:22`). Ответ проходит ту же маску и обрезку `LIST_BUDGET`. Ходы получают половину бюджета, шаги остаток. Оба списка оставляют новые записи и режут старые: конец последнего хода несёт ошибку, ради которой смотрят сессию. Если что-то срезано, в ответе `truncated: true`. Маршрут отвечает 404 только на сессию, которой нет, тогда инструмент пишет «Сессия не найдена». Сессия без ходов получает 200 с пустыми списками, инструмент пишет «Ходов у сессии ещё нет». Вместе с инструментом правятся правило маршрута, фейк и строки `docs/plans/builder-agent.md:187` и `:779`. Старый обработчик `/:id/trajectory` в `P/http-routes/src/sessions` остаётся до решения по старым сессиям (раздел 5.6).

**Риск.** Меняется формат ответа: трейс отдаёт ходы и спаны, а не траекторию старого пути. Справку `assistant/docs/session-review.md` сверить с новым ответом в том же срезе.

**Тесты.** Красный: новый тест через настоящий сервер, без фейка. Сессия `/v1` (id вида `session_<nanoid>`) делает один ход на фейковой модели, тест ждёт закрытый трейс, `get_trajectory` отвечает `<data source="trajectory"` с шагами хода, а не «Траектории нет». В `NT/platform-mcp-tools.test.ts` два случая на бюджет: 20 ходов с ошибкой в 300 знаков дают целый JSON в закрытом `<data>`, а из двух ходов по 40 шагов остаются все шаги последнего. Правила маршрутов сверяют `NT/platform-mcp-table.test.ts` и `NT/platform-mcp-token.test.ts`, их прогнать.

### 3.5 Три красных теста main-node

**Что не так.** Полный набор main-node 2026-10-19 дал по файлам «3 failed | 145 passed | 4 skipped», по тестам «2 failed | 1143 passed». Все три файла падают на файлах, которых в копии нет:

- `NT/cf-main-migrations.test.ts` (72 строки) читает `apps/main/migrations` и `apps/main/migrations-integrations` (`:8`, `:44`), это миграции D1 Cloudflare. Папки `apps/main` нет, `readdirSync` падает с ENOENT.
- `NT/mcp-oauth-validate.e2e.test.ts` (53 строки) импортирует `../../../test/fixtures/oauth-mcp-local-server` и `oauth-mcp-validate-scenarios` (`:9-10`). В `platform/test` лежит только `test/model/`.
- `NT/session-resume-mcp-live.test.ts` (210 строк) импортирует `../../../test/fakes/scripted-mcp-server` (`:14`).

Метка: проверено тестом (прогон выше).

**Решение.** Удалить один файл, два вернуть в строй. Тест меняем, только если он проверяет убранное поведение (раздел 2). Поэтому удаляется только `cf-main-migrations`: он проверяет миграции D1 Cloudflare, которых в копии нет. Два других теста проверяют живой код, им не хватало только корневых файлов.

- `cf-main-migrations` удалён. Он единственный проверял таблицы `tenant_shard`, `shard_pool` и `memory_store_tenant`. На Node они пустые, их схема уходит в шаге 2 (раздел 4.3).
- `mcp-oauth-validate` остаётся. Фикстуры `platform/test/fixtures/oauth-mcp-local-server.ts` и `oauth-mcp-validate-scenarios.ts` написаны у нас заново, это не копия upstream. Тест поднимает настоящий HTTP-сервер OAuth и MCP и зовёт маршрут `/v1` `mcp_oauth_validate` (`P/managed-agents-api/src/routes/credentials.ts:207`). Сценарии: `valid`, `refreshed` (обновление токена и повторная проверка уже без обновления, то есть новый токен сохранён), `revoked`, `unknown` (503). Ответ проверки не несёт ни одного токена. На тело без запроса `initialize` сервер отвечает 400. Сценарии считают вызовы `POST /token`, их ровно два. Метка: проверено тестом в прогоне рецензента 2026-10-19 до правки фикстуры (1 passed), после правки не запускалось.
- `session-resume-mcp-live` остаётся. Он проверяет публикацию MCP в старую сессию через `NodeInstallBridge`, а старые сессии и интеграции ждут шага 3. Фейк `platform/test/fakes/scripted-mcp-server.ts` взят из upstream как есть, коммит 1e44c89, 221 строка, Apache-2.0, запись в `platform/ORIGIN.md`. Метка: не проверено, тест в копии ещё ни разу не доходил до запуска.
- Тест `session-resume-mcp-live` служит образцом первого красного теста волны [mcp-registry.md](mcp-registry.md) (`:52`, `:597`). Эта волна берёт тот же фейк.

**Риск.** Для кода нет. После среза полный набор main-node становится точкой отсчёта для остальных срезов.

### 3.6 Срезы шага 1

| № | Срез | Красный тест | Доказательство |
|---|---|---|---|
| 1 | Три красных теста (3.5) | набор сейчас красный; срез удаляет `cf-main-migrations`, пишет фикстуры OAuth и переносит фейк MCP | полный набор main-node: 0 failed |
| 2 | Вкладка «CLI» (3.1) | консоль: вкладки нет, Bearer сохраняется через клиент `/v1`; сервер: `GET /v1/oma/vaults` 404 | curl на 8791: `GET /v1/oma/vaults` 404; снимки окна добавления учётки 1280 и 390 |
| 3 | «Документация» (3.2) | тест меню профиля | снимки меню профиля 1280 и 390 |
| 4 | browser (3.3) | тесты формы; охранник `buildTools` | снимок раздела инструментов формы; curl на 8791: `POST /v1/agents` с записью `{name: "browser", enabled: true}` в `agent_toolset_20260401` отвечает 400 |
| 5 | get_trajectory (3.4) | тест через настоящий сервер | ход помощника на 8791, фейковая модель зовёт `get_trajectory` по сессии `/v1`, ответ несёт трейс |

Срез 1 идёт первым, остальные в любом порядке. Срез 2 ждёт, если срез 7 cma-wave-1 в это время правит окно учётки.

### 3.7 Вопрос по шагу 1

Кнопка «Подключить» у MCP OAuth в том же окне (`VaultDetail.tsx:948`) открывает `/v1/oma/oauth/authorize`. grep `oauth/authorize` по `N/`, `P/http-routes/src` и `P/managed-agents-api/src` ничего не находит, маршрута нет. Это такая же ловушка, но в список шага 1 она не входила. Варианты: а) добавить срезом 6 шага 1, скрыть кнопку до маршрута; б) отложить до волны секретов. Совет: а), сейчас кнопка открывает окно с 404.

## 4. Шаг 2. Мёртвый код

Следующая волна. Пункты подтвердил скептик, порядок задан зависимостями. Номера строк взяты из разбора. Коммит f6fce12 правил `C/main.tsx`, `C/pages/Login.tsx`, словари `C/i18n/*` и `N/modules/node-http.ts`, номера там сверить перед срезом.

### 4.1 `SqliteHistory` и `InMemoryHistory` в history.ts

**Где и размер.** `A/runtime/history.ts`, около 88 строк из 861: строки 2-4 (тип `HistoryStore`, импорт `CfDoEventLog` из `event-log/cf-do`, `InMemoryEventLog`), 777-861 (`stampEvent`, `stampEventImmediate`, оба класса) и импорт `generateEventId` на `:18`, у которого после правки не останется вызовов.

**Доказательство.** grep `InMemoryHistory|SqliteHistory` по `apps` и `packages` находит только `A/runtime/session-do.ts` (импорт `:118` и девять мест `new SqliteHistory`). Node берёт из history.ts только `eventsToMessages` (`N/lib/node-harness-runtime.ts:18`, `N/lib/node-managed-harness-runtime.ts:6`), Pi берёт `eventsToMessagesAsync` (`A/harness/pi-loop.ts:23`). Сейчас Node грузит `event-log/cf-do` при загрузке модуля через `history.ts:3`.

**Риск.** Между этим срезом и 4.2 файл `session-do.ts` ссылается на удалённые классы. Ни typecheck, ни тесты его не видят: tsconfig main-node идёт только по импортам, `vitest.pi.config.ts` перечисляет 6 тестов `AT/`. Поэтому 4.1 и 4.2 идут подряд в одной волне. После 4.1 у `P/event-log/src/cf-do` остаётся один импортёр, `session-do.ts`.

**Тесты.** Набор Pi и полный набор main-node, typecheck main-node.

### 4.2 Оболочка Cloudflare в `apps/agent` и её пакеты

**Где и размер.**

- 18 файлов, 10 576 строк: `A/index.ts`, `A/runtime/session-do.ts` (6654), `A/oma-sandbox.ts` (823), `A/outbound.ts`, `A/runtime/sandbox.ts` (1118), `managed-runtime.ts`, `turn-runtime.ts`, `recovery.ts`, `setup-on-warmup.ts`, `resource-mounter.ts`, `workspace-backups.ts`, `sandbox-warmup-egress.ts`, `warmup-failure-event.ts` (все в `A/runtime/`), `A/harness/model-card-credentials.ts`, `A/harness/browser-tools.ts`, `AT/cloudflare-sandbox-duplex.test.ts`, `AT/model-card-credentials.test.ts`, `apps/agent/test/cloudflare-live-certification-worker.ts`.
- Супервизор outcome: `A/runtime/outcome-supervisor.ts`, `A/runtime/resolve-rubric.ts`, `AT/outcome-supervisor.test.ts`, 1002 строки. Скептик поднял пункт до удаления: на Node outcome считает `N/lib/node-managed-outcome-evaluator.ts`, а cma-wave-1 3.3 строится на нём (`cma-wave-1.md:151`).
- Обрезка `A/harness/skills.ts`: около 352 строк из 371. Остаются `SkillMountDescriptor` и `skillMountRoot` (`:10-21`) и комментарий-запрет лицензии `:367-371`, на него ссылается `document-skills.md:162`.
- Ветка `web_search_20250305` в `A/harness/tools.ts`: уходят импорт `:3` и ветка `:1227-1228`. Запись `:566` остаётся, тогда старый агент с этим типом получит DuckDuckGo, а `apps/agent/test/builder-harness.test.ts:24` останется зелёным.
- Конфиги Cloudflare: `apps/agent/wrangler.jsonc` (217), `wrangler.dev.jsonc` (62), `Dockerfile` (66), `Dockerfile.sandbox` (1), всего 346 строк. `wrangler.dev.jsonc:26` и `wrangler.jsonc:131`, `:134` несут идентификаторы KV и D1 апстрима.
- `apps/agent/package.json`: экспорты `.`, `main` и `./runtime/managed-runtime`; 9 зависимостей без импортёров сейчас и ещё 19 после удаления (17 нужны только файлам Cloudflare, плюс `fflate` и `@ai-sdk/anthropic`).
- 10 пакетов, src 8030 строк, тесты 9790: `P/managed-runtime-cloudflare`, `P/managed-runtime-host`, `P/outbound-snapshots-store`, `P/runtime-resource-fence-sql`, `P/services`, `P/session-secrets-store`, `P/session-wakeup`, `P/session-wakeup-cloudflare`, `P/tenant-db`, `P/tenant-dbs-store`.
- `P/event-log/src/cf-do` (627 строк) и `P/cap` (src 2262, тесты 2910), у них после удаления `session-do.ts` нет импортёров.

**Остаётся.** `A/harness/web-search-providers.ts` и `apps/agent/test/web-search-providers.test.ts`. Их добавил наш коммит b03c0d9 по плану [environments.md](environments.md) (7.2, EX3), подключение запланировано в ES3 и ES5.

**Доказательство.** Обход импортов скептика от `N/index.ts` и экспортов пакетов доходит до 38 файлов `apps/agent` и не доходит ни до одного из 18. Сервер берёт из `apps/agent` только `harness/*`, `runtime/history` и `runtime/appendable-prompts`. `session-do.ts:1` импортирует `DurableObject` из `cloudflare:workers`, `A/runtime/sandbox.ts:14` берёт `@cloudflare/sandbox`. Загрузчик песочниц Node знает только sprites, litebox, boxlite, boxrun, daytona и e2b (`N/sandbox-provider.ts:1-8`). Граф пакетов от `N/`, `NT/` и `C/` не доходит ни до одного из 10 пакетов. [environments.md](environments.md) `:755` выносит путь Cloudflare за рамки плана.

**Риск.**

- `P/scheduler/package.json:19` объявляет `@open-managed-agents/services` без импорта. Строку убрать вместе с пакетом, иначе `pnpm install` падает.
- Меняется `pnpm-lock.yaml`. Dockerfile main-node ставит зависимости с `--frozen-lockfile` (`apps/main-node/Dockerfile:47`).
- Устаревают `apps/agent/AGENTS.md` (раздел «Связь с сервером», ссылка `:8` на wrangler.jsonc), `platform/ORIGIN.md`, `docs/plans/analytics.md:22`, `:187` (образец `runtime-resource-fence-sql`), комментарии `P/eval-core/src/verifier/builtins/llm_judge.ts:55`, `A/harness/tools.ts:592`, `:629`, `:1155`, `:1494`, `:1551`, `P/sandbox/src/ports.ts:8` и другие из списка разбора.
- Опция `watchBackgroundTask` (`A/harness/tools.ts:608`) остаётся без поставщика, её подаёт только `SessionDO`.

**Тесты.** Уходят `AT/cloudflare-sandbox-duplex.test.ts`, `AT/model-card-credentials.test.ts`, `AT/outcome-supervisor.test.ts` (их не запускает ни один конфиг) и тесты 10 пакетов. Должны остаться зелёными набор Pi, `apps/agent/vitest.config.ts` (`test/**`), полный набор и typecheck main-node.

### 4.3 Схема таблиц без кода

Таблицы остаются в базах, уходит только схема TS. Миграции, снимки `meta/*_snapshot.json` и ступени MySQL не меняются: MySQL строит таблицы из снимков, а не из TS (`P/db-schema/src/node-mysql/index.ts:1-5`).

| Таблицы | Где и размер | Доказательство | Риск и тесты |
|---|---|---|---|
| `runtimes`, `runtime_tokens`, `connect_runtime_codes` (мост oma bridge) | `P/db-schema/src/cf-auth/runtimes.ts`, `node-pg/cf-auth-runtimes.ts`, 119 строк, экспорт в `cf-auth/index.ts` и `node-pg/index.ts` | читателя и писателя нет ни сейчас, ни на 7026a04; DDL только в `0000_consolidated.sql` обеих папок | `platform/ORIGIN.md:62-64` поправить; тестов нет |
| `tenant_shard`, `shard_pool`, `memory_store_tenant` (шардинг D1) | `P/db-schema/src/cf-router` (11 и 66 строк), `node-pg/cf-router-sharding.ts` (55) | читатели только в `P/services` и `P/tenant-db*`, они уходят в 4.2; на Node роутера шардов нет (`P/http-routes/src/tenants/index.ts:6-9`) | реэкспорт `node-sqlite/index.ts:14`, `node-pg/index.ts:24`; тест `cf-main-migrations` уходит в шаге 1 |
| `session_threads`, `group_events`, `feishu_message_events`, `memory_confirmations` (триаж групп Feishu) | `P/db-schema/src/node-sqlite/feishu-ops.ts` (200), `node-pg/feishu-ops.ts` (160) | писателя не было никогда; `sessionThreads` в managed-коде это другая таблица, `managed_session_threads` | 17 триггеров SQLite висят на старой `sessions` и остаются вместе с таблицами; тесты `NT/feishu-tables.schema.test.ts`, `.pg.test.ts`, `NT/_helpers/feishu-tables-criteria.ts` (956 строк) уходят, триггеры теряют покрытие |
| `feishu_apps` | около 15 строк в `cf-integrations/feishu.ts` и `node-pg/cf-integrations-feishu.ts` | сама схема зовёт таблицу легаси (`cf-integrations/feishu.ts:27-30`), репозитория нет | тест `P/integrations-adapters-cf/test/feishu-adapters.test.ts` держит свой DDL |
| `usage_events` | `P/db-schema/src/cf-auth/usage.ts`, `node-pg/cf-auth-usage.ts`, 62 строки | пишет и читает только `P/services/src/usage.ts`, он уходит в 4.2 | ступень MySQL `usageAttributionMigration` и `NT/main-node.mysql.integration.ts:102` обращаются к таблице по имени, их не трогаем |

Строки `feishu-ops` и `feishu_apps` носят имя Feishu, но код интеграций их не читает и не пишет. Раннер Feishu не пишет `feishu_message_events`, у `feishu_apps` нет репозитория. Поэтому они стоят в шаге 2. Если владелец решит иначе, они переходят в 5.1.

Таблицы внутри Durable Object (`events`, `streams`, `pending_events`, `background_tasks`, `cf_agents_state`, `cf_agents_schedules`, `threads`, `runtime_resource_fences`, `runtime_resource_orphans`) создаёт код Cloudflare. В базах Node их нет, они уходят вместе с кодом в 4.2.

### 4.4 Адаптеры песочниц daytona, e2b, boxrun и sprites

**Где и размер.** `P/sandbox-adapter-daytona` (src 460, тесты 289), `P/sandbox-adapter-e2b` (897, 852), `P/sandbox-adapter-boxrun` (490, 281), `P/managed-runtime-sprites` (1037, 1130). После них `P/managed-runtime-sandbox` (src 2216, тесты 4188) остаётся без импортёров: его брали только sprites и Cloudflare. Правки: карта `N/sandbox-provider.ts:1-8`, `@fly/sprites` и 4 зависимости в `apps/main-node/package.json`, блок e2b и daytona в `.env.example:54-64`, `pnpm-lock.yaml`.

**Доказательство.** Сервер грузит один модуль по `SANDBOX_PROVIDER` (`N/components.ts:139-148`). `grep -c '^SANDBOX_PROVIDER=.' platform/.env` даёт 1, ключи `E2B_API_KEY`, `DAYTONA_API_KEY`, `BOXRUN_URL`, `SPRITES_TOKEN` дают 0. Скилл ставит `SANDBOX_PROVIDER=litebox` (`S/scripts/launch.sh:202`). [cma-wave-1.md](cma-wave-1.md) `:447` называет адаптеры долгом вне волны.

**Риск.** Корневые скрипты `test:coverage:sandbox-adapters` и `test:coverage:provider-drivers` (`package.json:89-90`) теряют цели. `cma-wave-1.md:106` приводит `e2b.ts:572` как пример ошибки, ссылку поправить. Адаптер `local-subprocess` не трогаем (раздел 6).

**Тесты.** `NT/sandbox-provider.test.ts:12-21`, `:64` ждут e2b и sprites в карте и в тексте ошибки, тест правится: он проверяет убранных провайдеров.

### 4.5 Пакеты quotas и rate-limit

**Где и размер.** `P/quotas` (89 строк), `P/rate-limit` (93 строки src), тестов нет. Зависимости `apps/main-node/package.json:82-83`, `P/http-routes/package.json:25`.

**Доказательство.** Единственный импорт это `import type` из rate-limit в `P/quotas/src/index.ts:13`. Граф пакетов от сервера и консоли до них не доходит. В планах квоты есть, но со своими таблицами.

**Риск.** Низкий, меняется `pnpm-lock.yaml`.

### 4.6 Повторные маршруты `/v1/oma/*` и режим serverless

| Что | Где и размер | Доказательство | Риск и тесты |
|---|---|---|---|
| `/v1/oma/agents`, `/v1/oma/environments`, `/v1/oma/memory_stores` | `N/modules/node-http.ts:396-411`, `:642-645`, `:477`; `P/http-routes/src/agents` (539), `environments` (255), `memory` (467) | консоль, помощник и скилл их не зовут; в пробной копии `agents`, `environments`, `memory_stores` по 0 строк, `managed_agents` 16 | сервисы остаются, их берут evals, интеграции и cron `memory-retention`; после снятия старого агента не создать, а evals и мост интеграций ищут агентов только в старой таблице и уже сейчас отвечают 404 на агентов консоли; тесты `NT/control-plane.test.ts:76-96` переписать на `/v1/agents`, `NT/platform-mcp-table.test.ts:49` ждёт отказ на `DELETE /v1/oma/agents/agent_1` и получит 404, `P/auth/test/auth.test.ts:75`, текст `S/features/agents.md:48` |
| `/v1/oma/files` и `/v1/oma/sessions/:id/memory_stores` | `N/modules/node-http.ts:796-892`, `:895-928`, около 135 строк; `N/lib/fs-session-output-source.ts` (49) | консоль читает `/v1/files` и `/v1/sessions/:id/outputs`; `session_memory_stores` читает только старый `SessionRegistry` | `NT/unified-file-page.node.test.ts:6` импортирует `fs-session-output-source.ts`, тест уходит вместе с файлом; `NT/promote-sandbox-file.test.ts:173-180` читает `GET /v1/oma/files/:id`, проверку переписать на чтение строки через сервис, сам тест уйдёт со старыми сессиями |
| `/v1/oma/dreams` и `P/dreams-pipeline` | `N/modules/node-http.ts:484-491`; `P/http-routes/src/dreams` (327), `P/dreams-pipeline` (src 802) | консоль зовёт `/v1/dreams`; `cma-wave-1.md:448` и вопрос 58 записывают это удаление | `config.dreamCurator` остаётся, его читает `/v1/dreams`; зависимость в `P/http-routes/package.json`; тест `NT/dreams-route.test.ts` (213) уходит |
| GET-заглушки `/v1/oma/integrations/{github,linear,slack}/credentials` | `N/modules/node-http.ts:654-656`, 3 строки | отвечают `{data: []}`, консоль шлёт на эти пути только POST | тестов нет |
| Режим `OPENMA_PROCESS_MODE=serverless` | `N/process-mode.ts` (53) и около 22 веток в 6 файлах | режим нужен пресетам Vercel и Fly, их в копии нет; `grep -c '^OPENMA_PROCESS_MODE=.' platform/.env` даёт 0; реплики D42 идут в standalone | `ownsLongLivedProcesses` становится константой; тесты `NT/process-mode.test.ts`, `NT/config.test.ts:153-177`, `NT/_helpers/openai-node-process.ts:128` |

Ветки `web_search_20250305` и `web_search_tavily` сейчас достижимы только через `/v1/oma/agents`, который принимает `tools` без схемы (`P/http-routes/src/agents/index.ts:220`). После снятия маршрута их не достать.

### 4.7 Мёртвый код консоли

| Что | Где и размер | Доказательство | Риск и тесты |
|---|---|---|---|
| Компоненты без импортёров | `C/components/BrandLoader.tsx`, `ListPage.tsx`, `ai-elements/suggestion.tsx`, `ui/card.tsx`, `ui/pagination.tsx`, 650 строк; CSS `.brand-loader-dot` в `C/index.css:365-376` | граф импортов от `C/main.tsx`: 261 из 449 файлов достижимы, этих пяти нет; тесты их не импортируют | `mature-components.contract.test.ts` обходит каталог и не ломается |
| `ui/accordion`, `ui/scroll-area`, `ui/sidebar` | 836 строк | импортирует только `ui/interactive-focus.test.tsx:9`, `:14`, `:22` и мёртвый `suggestion.tsx` | случаи теста на `:53` и `:114` уходят, они проверяют убранные компоненты; `sheet`, `tooltip`, `skeleton`, `use-mobile` остаются живыми |
| `ai-elements/conversation.tsx` | 185 строк с тестом | импортирует только свой тест | пакет `ai` нужен другим файлам |
| `session-detail/Trajectory.tsx` | 283 строки с тестом и `outcomeToStatusTone` в `C/lib/trajectory.ts:78` | окно убрала волна трейса (`agent-trace.md:568`) | `lib/trajectory.ts` остаётся для оценок; поправить `console-parity.md:349`, `session-page.md:168`, `:258` |
| `C/mocks/browser.ts` | 7 строк | воркер msw никто не запускает, `public/mockServiceWorker.js` нет | тесты берут `mocks/server.ts` |
| `taste-saas.contract.json` | 428 строк | файл никто не читает | нет |
| Скрипт `dev:staging` и алиасы `@/registry/default/*` | `package.json:7`, `vite.config.ts:22-25`, `tsconfig.json:15-18` | скрипт шлёт запросы на стенд апстрима, алиасами никто не пользуется | нет |
| Мёртвые экспорты | `useApiMutation`, `getBranding`, `formatDuration`, `pickTickStep`, `formatDurationRu`, `kindTitle`, `toggleCollapse`, `isReadTool`, около 80 строк | рабочих вызовов нет | случаи в `format.test.ts`, `format-ru.test.ts`, `trace-tree.test.ts`, `assistant/api.test.ts`, `danger.test.ts:3`, `:32` уходят вместе с функциями; `formatRelative` остаётся до решения по интеграциям |
| 13 зависимостей без импорта | `@ai-sdk/react`, два `@fontsource-variable/*`, `@radix-ui/react-collapsible`, `-dialog`, `-popover`, `-select`, `-tabs`, `-toast`, `@open-managed-agents/integrations-core`, `@tanstack/react-query-devtools`, `autoprefixer`, `postcss`; 2 строки `declare module` в `vite-env.d.ts` | ни один файл их не импортирует, конфига PostCSS нет | `@radix-ui/react-use-controllable-state` живой; проверить `vite build` |
| 52 ключа i18n из 194 | `C/i18n/types.ts`, `ru.ts`, `en.ts`, `zh-CN.ts`, около 210 строк | полный перебор ключей по коду вне `src/i18n` и тестов | число посчитано до f6fce12, пересчитать перед срезом; ключ уходит из четырёх файлов одной правкой |
| Мёртвый CSS | `C/styles/console-pages.css:261-469` и медиазапросы, `.session-composer-footer`, `.assistant-spark`, `.console-data-head-skeleton`, около 225 строк | 22 класса не встречаются в разметке, тестах, скриптах и `@openma/common` | снимок Сводки до и после |
| 11 значков | `C/components/icons.tsx`, около 50 строк из 125 | импортов нет, `ChevronDownIcon` в других файлах берётся из lucide | нет |
| Turnstile | `C/components/Turnstile.tsx` (109), около 70 строк в `Login.tsx`, ключ `login.botChallengeTimeout` в четырёх словарях, комментарий в `index.html` | сервер всегда отдаёт `turnstile_site_key: null` (`N/modules/node-http.ts:223`) и токен не проверяет | подставки тестов с `null` не ломаются; поле ответа сервера убрать отдельным срезом |
| Аватары интеграций | `apps/console/public/integration-avatars`, 25 PNG, 744 КБ | файлы никто не запрашивает, помощники строят адрес на `openma.dev` | `P/integrations-core/src/avatars.ts` уходит вместе с интеграциями (шаг 3) |
| Ветка `cap_cli` в `credentialTypeView` | `C/pages/VaultDetail.tsx:65-72`, 8 строк | страница читает `managed_credentials` через `/v1`, вида `cap_cli` в контракте нет, мост GitHub пишет в старую таблицу `credentials` (раздел 3.1) | нет |
| `plugins/registry.ts` | 57 строк и разворот в `C/main.tsx`, `C/components/AppSidebar.tsx` | массив всегда пуст, подмену делал CI облачной версии, его у нас нет | файлы принадлежат K8 плана console-parity, согласовать |

### 4.8 Корень `platform/`

| Что | Где и размер | Доказательство | Риск и тесты |
|---|---|---|---|
| Скрипты деплоя | `package.json:47-59`, 11 строк: `dev`, `dev:main`, `dev:agent`, `build:vercel`, `vercel-build`, `dev:docs`, `build:docs`, `deploy:docs`, `setup:cloudflare`, `setup:fly`, `deploy` | цели отсутствуют (`apps/main`, `apps/main-vercel`, `scripts/setup-*.sh`, пакет docs); запуск идёт через `.claude/launch.json` | `dev:console` и `build:console` остаются |
| Скрипты drizzle-kit | `package.json:96-107`, 12 строк, devDependency `drizzle-kit` | конфигов `drizzle.*.config.ts` нет и в истории не было; миграции пишутся руками (`platform/AGENTS.md`) | поправить комментарии `P/db-schema/src/*`, `N/database.ts:50-52`, `apps/main-node/migrations/README.md:39-40`; вернуть конфиги Node можно решением владельца (5.13) |
| Скрипты changesets | `package.json:108-110`, 2 devDependency `@changesets/*` | папки `.changeset` и скрипта публикации нет | нет |
| Скрипты тестов на отсутствующие файлы | строки `46`, `64-73`, `77-85`, `95`, `111` и `test:architecture` (`:66`); `NT/provider-chaos-cluster.test.mjs` (319) | цели отсутствуют, `scripts/` содержит только `ddc-shots.mjs`; тест `.mjs` импортирует отсутствующий скрипт, vitest main-node его не берёт | сборные `test` и `typecheck` не удалять: pnpm на пустом фильтре выходит с кодом 0, из них вырезать мёртвые фильтры; поправить `platform/AGENTS.md:7` |
| Корневой `vitest.config.ts` | 501 строка | пул workerd, нет `wrangler.test.jsonc`, globalSetup и заглушек; наследников нет | вместе убрать `@cloudflare/vitest-pool-workers/types` из `tsconfig.json:7` и `P/sandbox/tsconfig.json:9` и сам devDependency; `@cloudflare/workers-types` не трогать; без корневого конфига `pnpm vitest run` из `platform/` соберёт все тесты, можно оставить конфиг на 5 строк с понятной ошибкой |
| `vitest.harness-tools-wiring.config.ts`, `vitest.harness-web-http.config.ts`, `vitest.protocol.config.ts` | 92 строки и `package.json:74`, `:86` | все include ведут в отсутствующие `test/unit`, `test/fakes` | нет |
| `tsconfig.test.json` | 15 строк | единственная ссылка `tsc -p tsconfig.test.json` ведёт на файл `P/sdk` | нет |
| Мёртвые записи `tsconfig.json` | include `apps/main/worker-env.d.ts`, exclude пяти отсутствующих папок | путей нет, сам файл расширяют 124 tsconfig | typecheck main-node, agent и консоли по одному |
| Строки `.gitignore` | `reports/screenshots/*.tmp`, `/data/`, `.wrangler/` | первые две цели отсутствуют; `.wrangler/` нужен, пока есть devDependency `wrangler` | `/data/` перенацелить на `platform/data/`; `.wrangler/` и `wrangler` убрать после 4.2 |
| `internal/` | 2 файла по 3 строки | заглушки без кода и ссылок | нет |

### 4.9 Локальные папки

В git они не входят, удаляет владелец.

| Папка | Размер | Почему | Команда |
|---|---|---|---|
| `platform/coverage` | 16 файлов, 436 КБ | выход одного прогона покрытия | `rm -rf platform/coverage` |
| `platform/data` | пустые папки | их создают тесты main-node, запущенные из `platform/` (имена из `NT/crash-recovery.test.ts`) | `rm -rf platform/data` |
| `apps/main-node/data-shots` | 1,8 МБ | база снимков DDC от 15 октября, на неё ничто не ссылается | `rm -rf platform/apps/main-node/data-shots` |
| `.audit/*.js`, `.audit/ddc-console.tsv`, `.audit/rm-pnpm-install.log` | 21 файл, 352 КБ | скрипты закрытых волн, ссылок нет | `rm .audit/*.js .audit/ddc-console.tsv .audit/rm-pnpm-install.log` |
| 45 прогонов `.verify-evidence/2026*` без ссылок и `.verify-evidence/claude-code-harness` | около 89 МБ | ссылок нет в документах, скилле и коммитах; 23 прерваны, 13 провалены | список собрать заново: прогоны, чьих id нет в `docs/`, `.claude/` и сообщениях коммитов; `skill-eval-qwen` оставить |

Папку `apps/main-node/data` не трогаем, она держит вход пробной копии (раздел 6).

### 4.10 Срезы шага 2

Каждый срез начинается с красного теста или с теста, который правится вместе с удалением. Порядок такой:

1. 4.1, затем 4.2 подряд.
2. 4.3 после 4.2: схема `cf-router` нужна `P/tenant-dbs-store` до его удаления.
3. 4.4 и 4.5 в любом порядке.
4. 4.6, по строке таблицы на срез.
5. 4.7, по строке таблицы на срез. Turnstile и ключи i18n в один срез: ключ `login.botChallengeTimeout` есть в обоих.
6. 4.8 после 4.2, 4.4 и 4.5: корневые скрипты и конфиги ссылаются на эти пакеты.

## 5. Шаг 3. Решения владельца

Ждёт решения владельца. Ни один пункт не удаляется, пока владелец не ответит. Совет стоит после вариантов.

### 5.1 Интеграции Linear, Slack, GitHub, Feishu

**Что есть.** Около 30 000 строк. Пакеты `P/linear` (2587), `P/slack` (3129), `P/github` (3186), `P/feishu` (1695), `P/integrations-core` (2858), `P/integrations-adapters-cf` (5587), `P/integrations-adapters-node` (736), `P/mcp-access-loss` (882), `P/http-routes/src/integrations` (1691), 1829 строк в `N/lib` (`node-install-bridge.ts`, `ws-feishu-runner.ts`, `feishu-agent-tools.ts`, `feishu-egress-writer.ts`), консоль `C/integrations` (7036) и `C/pages/Integrations*` (136). Схема 24 таблиц, 1483 строки.

**Доказательство.** `grep -c '^PLATFORM_ROOT_SECRET=.' platform/.env` даёт 1, поэтому сервер монтирует `/v1/oma/integrations` и шлюз вебхуков на корне без входа, только с проверкой подписи (`N/modules/node-http.ts:747-787`, `:973-990`). Ключей провайдеров нет. Страницы консоли открывает флаг `VITE_ENABLE_INTEGRATIONS=1` (`C/main.tsx:79`), его никто не ставит. Мастера консоли берут агента из `/v1/agents`, а мост ищет его в старой таблице `agents` (`N/lib/node-install-bridge.ts:629`) и не находит. Очередь Linear никто не разбирает: задача `linear-dispatch` регистрируется только при `linearSweeper`, а сборка его не передаёт (`N/lib/node-scheduler-jobs.ts:125-132`). В пробной копии публикаций и установок 0. Каналы из спеки 09 идут отдельным сервисом на `/v1` (D31).

**До удаления перенести.** `WebCryptoAesGcm` из `P/integrations-adapters-node` держит шифры платформы (`N/secrets.ts:6`, `:26`). `P/mcp-access-loss` стоит на пути MCP-прокси `/v1` (`N/modules/node-managed.ts:314`, `N/modules/node-http.ts:467`) и берёт каталоги из github, linear и slack (`P/mcp-access-loss/src/catalog.ts:1-3`).

**Риск.** Тесты `install-bridge.test.ts`, `feishu-agent-tools.test.ts`, `ws-feishu-runner.test.ts`, `mcp-access-loss.*.integration.ts`, `IntegrationsLinearList.linear.test.tsx`. Правки планов `console-parity.md:531`, `portal-sso.md:284`. Строка `LINEAR_DISPATCH_CRON` в `.claude/launch.json` принадлежит владельцу. Задача `webhook-events-retention` у пары `oma-server-preview` раз в минуту чистит пустые таблицы.

Варианты: а) удалить код, таблицы оставить; б) оставить и снять шлюз с публичных путей, пока нет публикаций. Совет: а), удалить.

### 5.2 Маршрут `/openai`

**Что есть.** Около 11 000 строк: `P/openai-agents-api` (src 7474, тесты 483), `P/openai-agents-compat` (1699, 1418), 320 строк `N/openai-*.ts`, тесты `NT/openai-*` и `NT/openai-e2e`. Маршрут смонтирован всегда (`N/modules/node-http.ts:931-964`), вызывающих нет.

**До удаления перенести.** Ветку `/v1` из `nodeOpenAISubagentPolicy` (`N/openai-subagents.ts:7-12`) в код субагентов: она открывает делегирование и для `/v1` ([multiagent.md](multiagent.md) `:91`). Потом убрать `sandboxMode`, `afterExecution`, шифр `openai.agents.configuration` (`N/modules/node-foundation.ts:121-133`) и корневые скрипты `test:openai-agents`, `test:openai-agents:node` (`package.json:112-113`).

**Риск.** Планы говорят о `/openai` как о живом: `multiagent.md:337`, `cma-wave-1.md:351`. `crud-fixes.md:67` описывает файлы, которые пишет `openai-artifact-publication.ts`.

Варианты: а) удалить; б) оставить вторым внешним API. Совет: а), удалить.

### 5.3 MySQL

**Что есть.** `P/node-database-mysql` (src 47, тесты 20), `P/db-schema/src/node-mysql` (360), ветки диалекта в 16 файлах main-node и 15 файлах пакетов, тесты `main-node.mysql.integration.ts`, `persistence.mysql.integration.ts`, `execution-claim-deadlock.mysql.integration.ts`, `mcp-access-loss.mysql.integration.ts`, `node-mysql-schema-migration.test.ts`, `vitest.mysql.config.ts`.

**Доказательство.** MySQL включает только `DATABASE_URL` с `mysql://` (`N/config.ts:216-217`), обе пары `launch.json` его снимают. D42 ведёт на Postgres. Каждая новая миграция требует ступени MySQL, иначе сервер на MySQL не стартует (`P/db-schema/src/node-mysql/index.ts:119-124`).

**Риск.** Тип `"sqlite" | "postgres" | "mysql"` стоит в `sql-client` и `realtime-fanout.ts:1`, правка широкая. При удалении поправить `cma-wave-1.md:188`, `:197`, `:208`, `:224-225`, `:238`, `:245` и `mcp-registry.md:173`.

Варианты: а) удалить; б) оставить третьей базой. Совет: а), удалить. Волна 1 тогда пишет миграции на две базы.

### 5.4 Словари en и zh-CN и переключатель языка

**Что есть.** `C/i18n/en.ts` и `zh-CN.ts`, 500 строк, переключатель около 20 строк (`C/components/UserProfile.tsx:120-137`, `C/i18n/context.tsx:15-19`, `:93-97`). Через словари идёт около 140 ключей в 26 файлах, остальной текст страниц написан по-русски, поэтому английский и китайский дают смешанный интерфейс.

**Риск.** `C/pages/WorkspaceMembers.tsx:26`, `:186`, `:528` держит свой `copy[locale]` на три языка, его тоже сужать. Планы `console-parity.md:78`, `:279` правят три словаря. Тесты язык не переключают.

Варианты: а) удалить, `Locale` сузить до `ru`; б) оставить. Совет: а), удалить.

### 5.5 Вход через Google, GitHub и код из письма

**Что есть.** `C/pages/Login.tsx` (814 строк), ветки OAuth и OTP по оценке 250-350 строк. Google и GitHub выключены конфигом (`GOOGLE_CLIENT_ID` и `GITHUB_CLIENT_ID` дают 0). Ссылки «Забыли пароль?» и «Войти по коду из письма» рисуются без проверки providers (`Login.tsx:536-549`, `:642-655`), а без `SMTP_HOST` письма не уходят (`N/config.ts:270`). Регистрация нужна приглашениям: `/join` ведёт на `/login?next=`. OIDC нужен единому входу ([portal-sso.md](portal-sso.md) `:218`, `:320`).

**Риск.** Тесты раскладки `Login.oauth-layout.test.tsx`, `Login.oidc.test.tsx`, `Login.mature-components.test.tsx`.

Варианты: а) оставить до portal-sso; б) удалить OAuth и OTP сейчас. Совет: а), оставить до перехода на вход через портал. Отдельно стоит скрыть две ссылки, пока `config.email` пуст: сейчас они ведут в форму, которая не работает.

### 5.6 Старые сессии и таблицы `/v1/oma`

**Что есть.** `N/registry.ts` (327), `N/lib/node-session-router.ts` (467), `N/lib/legacy-session-mcp-proxy.ts` (49), `N/lib/node-harness-runtime.ts` (229), `N/lib/node-workspace-backup.ts` (209), около 95 строк в `N/modules/node-foundation.ts`, `P/http-routes/src/sessions` (1338), всего около 2700 строк. Старые сервисы: 11 пакетов, 14 732 строки (`agents-store`, `sessions-store`, `environments-store`, `vaults-store`, `credentials-store`, `files-store`, `memory-store`, `evals-store`, `dreams-store`, `dreams-pipeline`, `evals-runner`). Схема 14 файлов, 751 строка. Журнал `session_events` и `session_streams` создаёт код на каждом старте (`N/database.ts:62`).

**Кто стоит на пути.** Evals: `tick.ts:151` создаёт сессию старым сервисом, `P/http-routes/src/evals/index.ts:70-76` ищет агента в старой таблице. Мост интеграций будит сессию через `NodeSessionRouter` (`N/modules/node-http.ts:692-697`). Инструмент `get_trajectory` уходит отсюда в шаге 1. Маршруты трейса на том же префиксе (`N/modules/node-http.ts:448`) остаются.

**Риск.** Наблюдатель памяти (`N/lib/node-memory-queue.ts`, `N/lib/memory-blob-watcher.ts`) пишет старую таблицу `memories`, возможно зеркалит туда память `/v1`. Не проверено. Тесты `control-plane`, `node-session-router`, `promote-sandbox-file`, `install-bridge`, `managed-node-harness-runtime`, `managed-session-*`, `trace-pi-frames` проверять по одному.

Варианты: а) удалить сейчас; б) позже, после перевода evals на `/v1` (пункт 19 в [cma-videos-and-gaps.md](../research/cma-videos-and-gaps.md), K16 console-parity) и решения 5.1. Совет: б), позже.

### 5.7 `/v1/oma/skills`

**Что есть.** `N/lib/node-skills-routes.ts` (403), монтирование `N/modules/node-http.ts:554`, запасной путь в `C/pages/SkillsList.tsx:79`, `:232-242`. Маршрут хранит навыки в KV, консоль зовёт его только запасным путём с id навыка `/v1`, такого ключа в KV нет. В пробной копии `kv_entries` с `skills/%` 0 строк.

**Что мешает.** Два плана целятся в этот файл: ES4 [environments.md](environments.md) (`:484-485`, `:653`, `:701`) и S9 [console-parity.md](console-parity.md) (`:225`). `document-skills.md:114` оставил запасной путь намеренно.

**Риск.** `NT/platform-mcp-token.test.ts:224` ждёт 403 на `POST /v1/oma/skills/install` и получит 404. Проверить `SkillsList.delete.test.tsx`.

Варианты: а) перевести ES4 и S9 на `/v1/skills`, затем удалить; б) оставить. Совет: а).

### 5.8 Своё окружение (self_hosted)

**Что есть.** `/v1/environments/:id/work`, `POST /v1/oma/sessions/:id/runtime-events` (`N/modules/node-http.ts:315-351`, `:255-279`, `:482`), `P/environment-work-store*` (1271 строка), около 8466 строк с тестами. Воркера в репозитории нет, в пробной копии `managed_environment_work` 0 строк.

**Почему не мёртвый код.** Скептик опроверг удаление: K11a console-parity ставит в создание окружения выбор «Облако | Свой сервер» (`console-parity.md:169`), `environments.md:234` описывает карточку, `crud.md:78` проверяет открытые задания при удалении окружения.

Варианты: а) оставить код и не открывать создание self_hosted в K11a, пока нет воркера; б) открыть создание сейчас; в) удалить. Совет: а).

### 5.9 Туннели `/v1/tunnels`

**Что есть.** Маршрут `N/modules/node-http.ts:492-493`, `LocalTunnelProvisioner` (`N/modules/node-managed.ts:991-1009`), `P/tunnel-store*` (479), около 2050 строк с тестами. Приёма трафика туннеля нет, страницы в консоли нет, в пробной копии `managed_tunnels` 0 строк. Помощник прячет `tunnel_token` как секрет (`N/lib/platform-mcp/known-secrets.ts:26`, `secret-fields.ts:163-164`). Туннели есть в общем дизайне (`design.md:158`).

Варианты: а) оставить API без ретранслятора; б) удалить, `/v1` станет уже SDK. Совет: а), ретранслятор ждёт решения в [cma-videos-and-gaps.md](../research/cma-videos-and-gaps.md) `:237`.

### 5.10 Профили пользователей `/v1/user_profiles`

**Что есть.** Маршрут `N/modules/node-http.ts:471`, `P/user-profile-store*` (367), около 1275 строк с тестами. Выдача enrollment на self-host всегда отвечает отказом (`N/modules/node-managed.ts:1182-1187`). Страницы консоли API не зовут. Портал ведёт пользователей своей таблицей `portal_user`.

Варианты: а) оставить; б) удалить. Совет: а). Код мал, на self-host маршрут сразу отвечает отказом, а удаление сужает `/v1` против SDK 0.120.

### 5.11 Инструменты самопробуждения агента

**Что есть.** `schedule`, `cancel_schedule`, `list_schedules` в `DEFAULT_TOOLS` (`A/harness/tools.ts:39`), блок `:1152-1219` и типы опций `:627-647`. Node не передаёт `scheduleWakeup`, `cancelWakeup`, `listWakeups`, инструменты не строятся. Карточка помощника всё равно их перечисляет (`N/lib/platform-mcp/tools/sessions.ts:49`). Консоль рисует ходы пробуждения (`CanonicalSessionTurn.tsx:252`), план страницы сессии держит флаг `wakeup` (`session-page.md:585`).

**Риск.** Тест `builder-harness.test.ts:14` сравнивает с константой и остаётся зелёным.

Варианты: а) убрать имена и блок; б) сделать планировщик пробуждений на Node. Совет: а). Отложенный запуск уже дают деплойменты с cron.

### 5.12 Ветка Tavily

**Что есть.** `A/harness/tools.ts:1287-1324` (38 строк) и `postTavilySearch` (`A/harness/tool-http-fetch.ts:68`). Ветке нужен тип `web_search_tavily`, его даёт только `/v1/oma/agents` (уходит в 4.6), и ключ `TAVILY_API_KEY`, его Node не передаёт. План 7.2 [environments.md](environments.md) оставляет Tavily, но через `WEB_SEARCH_PROVIDER` и `web-search-providers.ts` с заголовком `Authorization: Bearer` (`:522-526`). Тип закрепляет `builder-harness.test.ts:24`.

Варианты: а) удалить ветку в срезах ES3 и ES5; б) удалить сейчас. Совет: а).

### 5.13 Мелкие вопросы

1. Пакет `P/browser-harness` и ветка browser в `tools.ts`. Совет: оставить до решения по браузеру в плане окружений, переключатель скрыт в шаге 1.
2. `tw-animate-css` объявлен, но не подключён, классы в `reasoning.tsx:220` и `tool.tsx:129` ничего не делают. Совет: убрать пакет и классы.
3. Пакет `shadcn` в dependencies и `components.json`. Совет: перенести в devDependencies, console-parity заводит новые `ui/slider.tsx` и `ui/switch.tsx`.
4. `public/og.svg`, `favicon.png`, `logo.png` держит тест `branding-assets.test.ts:88-131`, их недавно перекрасили. Совет: оставить.
5. Обрезка `ai-elements/prompt-input.tsx` (1473) и `message.tsx` (362). Совет: не обрезать, так проще сверять с апстримом.
6. `docker-compose.yml` и `docker-compose.postgres.yml` не соберутся без `apps/oma-vault`, а portal-sso ждёт контейнер агентов из нашего compose. Совет: переписать один compose под портал, второй удалить.
7. `vitest.storage.config.ts` (8 контрактов Postgres и S3) не хватает `test/storage-global-setup.ts` и `test/storage-integration.ts`. Совет: написать два помощника на testcontainers, контракт S3 нужен шагу 5 D42.
8. Конфиги drizzle для Node. Совет: не возвращать, миграции писать руками, как сейчас.
9. `scripts/ddc-shots.mjs` и 77 снимков `docs/reports/screenshots/ddc-console` (5 МБ). Совет: удалить вместе, поправить `S/features/skills.md:25`.
10. Файлы `.audit`, на которые ссылаются документы в git (`cma-screens`, `crud-gaps.md`, `environments-critic.md`, `builder-v1-critic.md`, `trace-critic.md`, `owner-menu-scope.png`, `mcp-registry-critic.md`). Совет: перенести в `docs/research` и закоммитить.
11. Именные папки `.verify-evidence` (9 папок, 7,8 МБ). Совет: решает владелец, это его архив.
12. `.env.example` по шаблону апстрима. Совет: переписать под Qwen и LiteLLM после решений 5.1 и 4.4.
13. `docs/cma-console/04-analytics.md` и `04-analytics-gap.md`. Совет: удалить после правки ссылки `console-parity.md:7`, аналитика отменена.

## 6. Что выглядит мёртвым, но остаётся

| Что | Почему остаётся |
|---|---|
| Оценки: `/v1/oma/evals`, `P/evals-runner`, задача `eval-tick` | на них строится K16 «Пакеты». Сейчас запуск на Node не работает: `getSandboxBinding` всегда null (`N/lib/node-scheduler-jobs.ts:72`), агента ищут в старой таблице. Это надо записать в K16 |
| Адаптер Postgres `P/node-database-postgres`, `N/lib/pg-event-stream-hub.ts` | шаг 1 D42 |
| `P/vault-forward` | MCP-прокси `/v1` (`N/lib/http-mcp-proxy.ts:11`), форвардер секретов cma-wave-1 |
| `P/email` | включается `SMTP_HOST`, режим better-auth остаётся в portal-sso |
| `platform/sandbox-images` | каталог образов, тест VM, план environment-programs |
| `platform/skills/builtin` | путь по умолчанию `N/config.ts:165`, тест копирования в образ |
| `ai-elements/code-block.tsx` целиком | селектор языка, копирование и нумерация строк нужны K14 |
| `docs/plans/models-harness-analytics.md` | console-parity берёт из него контракты SW, C2 и V1 |
| Песочница `local-subprocess` | на ней стоят тесты сервера (32 файла), вне `NODE_ENV=test` сервер её не берёт |
| `apps/main-node/data` | держит `data/auth.db` с учётками пробной копии и папки песочниц. AGENTS.md называет базой пробной копии `data-preview`, но вход живёт здесь |
| `A/harness/web-search-providers.ts` и тест | план environments 7.2, ES3, ES5 |
| `C/pages/agents/legacy-harness.ts`, старые имена harness в `A/harness/registry.ts` | правка и восстановление старых агентов, D41 |
| Тесты `AT/assembly-*.test.ts` (9 файлов) | покрывают живой код Pi, но ни один конфиг их не запускает. Их стоит добавить в `vitest.pi.config.ts`. `AT/pi-provider.test.ts` ждёт отсутствующий mock-сервер |
| `/v1/oma/stats` | Сводка зовёт его до K18 |
| Таблицы за флагами (`managed_session_workspace_checkpoints`, снимки выводов, `queue_messages`) | шаг 5 D42 и очередь памяти |
| Папки схемы `P/db-schema/src/cf-auth` и `cf-integrations` | это основная схема SQLite нашего сервера, устарели только комментарии |
| Таблица `harness_cards` и тесты отказа | D41, тесты ловят возврат маршрутов |

## 7. Проверки по шагам

Команды из `platform/AGENTS.md`, по одной, через `test-slot nice -n 15` с `--maxWorkers=2`.

| Проверка | Команда | Шаг 1 | Шаг 2 |
|---|---|---|---|
| Typecheck сервера | `pnpm --filter @open-managed-agents/main-node typecheck` | каждый срез | каждый срез |
| Typecheck консоли | `pnpm --filter managed-agents-console typecheck` | срезы 2-4 | срезы консоли и 4.8 |
| Полный набор сервера | `pnpm --filter @open-managed-agents/main-node test -- --maxWorkers=2` | после каждого среза, 0 failed с среза 1 | после каждого среза |
| Полный набор консоли | `pnpm --filter managed-agents-console exec vitest run --maxWorkers=2` | после срезов 2-4 | после срезов консоли |
| Pi | `pnpm vitest run --config vitest.pi.config.ts --maxWorkers=2`; в `apps/agent` ещё `../../node_modules/.bin/vitest run --maxWorkers=2` | срез 4 | 4.1, 4.2, 4.6 |
| Пакеты со своим `test` | `pnpm --filter <пакет> test` | нет | пакеты, чьи зависимости правились |
| Зависимости | `pnpm install`, затем `pnpm install --frozen-lockfile` | срез 2 | 4.2, 4.4, 4.5, 4.7, 4.8 |
| Текст | `node scripts/unslop-check.mjs --diff` | каждый срез | каждый срез |
| Живое доказательство | экземпляр скилла verify-agent-console на 8791 | таблица 3.6 | прогон скилла «окружение, агент, сессия, ход» после 4.2, 4.4 и 4.6; снимки 1280 и 390 после срезов консоли |

## 8. Что не входит

- Перевод evals на `/v1` и сквозной прогон «Пакетов». Это K16 console-parity.
- Правка документов, которые разбор нашёл устаревшими: корневой `README.md` обещает Temporal и любой harness, `docs/README.md` не перечисляет планы и исследования, `docs/runbook-local.md` расходится с `.claude/launch.json`, строки статуса в `crud.md`, `crud-fixes.md`, `environments.md`, `builder-agent.md`, `document-skills.md`, `console-parity.md`, отметки D41 и D42 в `docs/components` и `docs/flows`.
- DROP таблиц. Он идёт только решением владельца в миграции 0028.
