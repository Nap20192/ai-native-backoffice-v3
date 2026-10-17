# CMA, раздел 8: расписания и вебхуки

Разбор двух страниц документации Claude Managed Agents (CMA) и сверка с нашей копией Open Managed Agents в `platform/`. Пути в разделе 3 даны от `platform/`. Области ACP, карточек harness и моста CLI не разбирались: их сейчас удаляют. Сверка сделана 2026-10-17.

## 1. Коротко

- В CMA агент может запускаться сам. Для этого есть деплоймент (deployment): агент, окружение, стартовые события и cron с часовым поясом. Каждое срабатывание создаёт новую сессию.
- Каждая попытка запуска пишет прогон (deployment run). В прогоне есть id сессии или ошибка, поэтому сбои видны отдельно от сессий.
- Вебхуки CMA идут от Anthropic к вам. Они сообщают, что изменилось состояние сессии, агента, деплоймента, прогона, окружения, хранилища секретов или memory store. В теле только тип и id, сам объект надо прочитать через API.
- Наш API деплойментов и прогонов повторяет CMA почти один в один и типизирован по SDK. В консоли есть список, карточка, форма и вкладка прогонов.
- Главный пробел. Расписание у нас не срабатывает. Сервер проверяет cron и считает ближайшие запуски, но тика, который создаёт прогон по времени, нет. Работает только ручной запуск, и только у активного деплоймента.
- Исходящих вебхуков в смысле CMA у нас нет. Есть один отправитель с подписью Standard Webhooks. Он шлёт одно событие `session.status_run_started` на один адрес из переменной окружения.

## 2. Страницы

### 2.1 Деплойменты по расписанию (scheduled-deployments)

Страница объясняет, как создать деплоймент, как читать cron и часовой пояс, как задать бюджет на прогон, где смотреть прогоны, как ставить на паузу и в архив, что происходит при сбоях и как запустить вручную.

| Объект | Поле | Что значит |
|---|---|---|
| deployment | `id` | префикс `depl_` |
| | `name`, `description`, `metadata` | имя и свои метки |
| | `agent` | id строкой или `{type: "agent", id, version}` |
| | `environment_id` | обязательно |
| | `initial_events` | минимум одно событие `user.message` или `user.define_outcome`. Справочник SDK добавляет `system.message`, которого нет у сессии |
| | `resources`, `vault_ids` | файлы, GitHub, memory store, хранилища секретов. Файлы и GitHub работают только в облачном окружении |
| | `schedule` | `type: "cron"`, `expression`, `timezone`. В ответе ещё `last_run_at` и `upcoming_runs_at` |
| | `budget` | `{type: "limit", max_list_cost: {amount, currency}}`, сумма в центах строкой |
| | `status`, `paused_reason` | `active` или `paused`. Причина паузы `manual` или ошибка с типом |
| deployment_run | `id` | префикс `drun_` |
| | `deployment_id`, `agent` | деплоймент и версия агента на момент запуска |
| | `trigger_context` | `{type: "schedule", scheduled_at}` или `{type: "manual"}` |
| | `session_id` или `error` | id созданной сессии, либо `{type, message}` |
| | `created_at` | время попытки |

| Метод и путь | Что делает |
|---|---|
| `POST /v1/deployments` | создать, в ответе ближайшие запуски |
| `GET /v1/deployments`, `GET /v1/deployments/{id}` | список и чтение, есть в SDK, страница их не описывает |
| `POST /v1/deployments/{id}` | правка, в том числе `budget: null` |
| `POST /v1/deployments/{id}/pause`, `/unpause`, `/archive` | смена состояния |
| `POST /v1/deployments/{id}/run` | ручной запуск сейчас |
| `GET /v1/deployment_runs?deployment_id=&has_error=` | прогоны, можно только с ошибками |
| `GET /v1/deployment_runs/{id}` | один прогон, его id приходит в вебхуке как `data.id` |

Правила и лимиты:

- Cron обычный POSIX из пяти полей, самый мелкий шаг одна минута. Часовой пояс задают по IANA, например `America/New_York`.
- Время сравнивается по местным часам. В ночь перевода вперёд несуществующий час пропускается. В ночь перевода назад повторный час срабатывает дважды. Документация советует не ставить запуск с часу до трёх ночи или брать UTC.
- `upcoming_runs_at` показывает точное расписание. Сам запуск сдвигается случайно на величину до 15% интервала, но не меньше 5 секунд и не больше 9 минут.
- На организацию до 1000 деплойментов с расписанием, больше по запросу в поддержку.
- Бюджет копируется в каждую сессию. Он ограничивает каждый прогон отдельно, а не сумму всех прогонов. Новый бюджет действует со следующего прогона. В отличие от сессии, бюджет деплоймента можно снять и вернуть.
- Пауза останавливает только запуски по расписанию. Идущие сессии работают дальше. Ручной запуск на паузе разрешён. После снятия паузы пропущенные запуски не догоняются.
- Архив окончательный. Расписание останавливается, деплоймент больше не меняется.
- Лимит на создание сессий даёт прогон с `session_rate_limited_error` без повтора, следующий запуск будет по расписанию.
- Агента отправили в архив, и деплоймент уходит в архив сразу. Агента удалили, и деплоймент уходит в архив на следующем срабатывании. В обоих случаях прогон не пишется.
- Сабагент, окружение или хранилище секретов в архиве. Тогда прогон пишет ошибку, а деплоймент сам встаёт на паузу. `paused_reason.error.type` совпадает с типом ошибки прогона.
- Ручной запуск пишет прогон с `trigger_context.type: "manual"`. Он нужен, чтобы проверить деплоймент до включения расписания.

Бета-заголовок `anthropic-beta: managed-agents-2026-04-01`, SDK ставит его сам. Справочник предупреждает, что деплойменты новее остального API, и советует проверить, что установленный SDK их знает.

### 2.2 Подписка на вебхуки (webhooks)

Страница объясняет, какие события бывают, как завести адрес, как проверить подпись, как разобрать событие и как ведёт себя доставка.

Адрес (endpoint) заводят только в консоли Anthropic, на странице Webhooks рабочего пространства. API для этого нет. У адреса три части:

- URL. Только HTTPS, порт 443, имя хоста должно резолвиться публично.
- Список типов событий. Адрес получает только типы, на которые подписан.
- Секрет подписи. 32 байта с префиксом `whsec_`, его показывают один раз при создании. Сменить секрет можно там же в консоли.

Конверт события одинаковый для всех типов: `type: "event"`, `id` с префиксом `whe_`, `created_at`, `data` с полями `type`, `id`, `organization_id`, `workspace_id`. Полного объекта в теле нет. Так повтор не принесёт устаревших данных, а тело остаётся маленьким.

| Группа | Типы `data.type` |
|---|---|
| Сессии | `session.status_run_started`, `session.status_idled`, `session.budget_reached`, `session.status_rescheduled`, `session.status_terminated`, `session.thread_created`, `session.thread_idled`, `session.thread_terminated`, `session.outcome_evaluation_ended`, `session.updated`, `session.deleted` |
| Хранилища секретов | `vault.created`, `vault.archived`, `vault.deleted`, `vault_credential.created`, `vault_credential.archived`, `vault_credential.deleted`, `vault_credential.refresh_failed` |
| Агенты | `agent.created`, `agent.updated` (только новая версия), `agent.archived`, `agent.deleted` |
| Деплойменты | `deployment.created`, `deployment.updated`, `deployment.paused`, `deployment.unpaused`, `deployment.archived`, `deployment.deleted` |
| Прогоны | `deployment_run.started`, `deployment_run.succeeded`, `deployment_run.failed`, только для запусков по расписанию |
| Окружения | `environment.created`, `environment.updated`, `environment.archived`, `environment.deleted` |
| Memory store | `memory_store.created`, `memory_store.archived`, `memory_store.deleted` |

Имена в вебхуках отличаются от имён в потоке SSE. В потоке `session.status_idle`, в вебхуке `session.status_idled`. Отдельные записи памяти и работа self-hosted окружения событий не дают. После событий `.deleted` читать нечего, событие и есть итог.

Подпись. Каждая доставка несёт заголовки `webhook-id`, `webhook-timestamp`, `webhook-signature`. Это схема Standard Webhooks. Метод SDK `unwrap()` проверяет подпись, отвергает тело старше 5 минут и возвращает разобранное событие. Ключ он берёт из `ANTHROPIC_WEBHOOK_SIGNING_KEY`. Подпись считается по сырым байтам тела, поэтому парсер JSON до проверки ломает её.

Доставка:

- Любой ответ 2xx подтверждает приём. Ответ 3xx сразу отключает адрес, редиректы не выполняются.
- До трёх попыток на адрес и событие, пауза между ними растёт от 5 до 120 секунд со случайным сдвигом. После третьей неудачи событие пропадает молча. Вебхуки не журнал. Чтобы не пропустить переход, сверяйтесь со списками через API.
- Одно событие может прийти дважды. `id` события равен заголовку `webhook-id` и не меняется между попытками, по нему убирают повторы.
- Порядок не гарантирован. `.deleted` может прийти раньше `.archived`. Состояние надо брать из прочитанного объекта.
- Событие уходит только адресам, которые подписаны на его тип в момент события. Подписка позже не присылает старые события.
- `webhook-timestamp` ставится заново на каждой попытке. Когда случилось событие, показывает `created_at` в теле.
- Адрес отключается сам в трёх случаях: ответ 3xx, URL указывает на непубличный IP, доставки падают подряд долгое время. Последний случай считается по времени, один ответ 2xx сбрасывает счёт. Причина пишется в `disabled_reason`. Включить адрес обратно можно в консоли, пропущенные события не повторяются.

Бета-заголовок тот же, `managed-agents-2026-04-01`.

Справочник SDK и веб-страница расходятся в трёх местах. Справочник знает событие `session.status_scheduled`, страница нет. Справочник пишет типы ошибок прогона без суффикса (`environment_archived`), страница и SDK с суффиксом (`environment_archived_error`). Справочник говорит, что `session.status_terminated` приходит и при обычном завершении, страница называет только неисправимую ошибку и архив. Ниже мы сверяемся со страницей и типами SDK.

Справочник отдельно оговаривает, что входящие вебхуки сторонних сервисов, которые запускают сессию, к этой странице не относятся. Это обычный код на вашей стороне.

## 3. Как у нас

| Возможность | В CMA | У нас | Где |
|---|---|---|---|
| CRUD деплойментов: создать, список, чтение, правка | бета | есть и работает. Правка и смена состояния понимают `If-Match` | `packages/managed-agents-api/src/routes/deployments.ts:61`, `:86`, `:114`, `:132`; `apps/main-node/src/modules/node-http.ts:474` |
| Поля тела по типам SDK: `initial_events` до 50, `resources`, `vault_ids`, `budget`, `metadata` | бета | есть и работает | `packages/managed-agents-api/src/contracts/deployments.ts:161` |
| Проверка cron и часового пояса | бета | есть и работает, через croner | `packages/managed-agents-adapters-runtime/src/deployment-schedule-planner.ts:29` |
| `upcoming_runs_at`, `last_run_at` | бета | частично. Пять запусков считаются только при создании и правке и дальше устаревают. `last_run_at` всегда `null` | `deployment-schedule-planner.ts:34`, `:48`; `packages/managed-agents-application/src/deployments/application.ts:320` |
| Запуск по расписанию | бета | нет. В планировщике main-node нет задачи для деплойментов. Хранилище прогонов умеет только `beginManual` | `apps/main-node/src/lib/node-scheduler-jobs.ts:57`; `packages/deployment-run-store/src/index.ts:58` |
| Прогон с `trigger_context.type: "schedule"` | бета | в коде, не подключено. Тип и маппер есть, пишет такие прогоны никто | `packages/managed-agents-domain/src/deployments/deployment-run.ts:21`; `packages/managed-agents-api/src/mappers/deployment-runs.ts:51` |
| Пауза, снятие паузы, архив | бета | есть и работает. Архив у нас обратим через `unarchive`, в CMA он окончательный | `routes/deployments.ts:213`; `application.ts:748` |
| Ручной запуск | бета, работает и на паузе | частично. На паузе сервер отвечает 409. Консоль создаёт деплоймент на паузе, поэтому до включения его не проверить | `application.ts:810`; `apps/console/src/pages/deployments/DeploymentForm.tsx:162`; `DeploymentDetail.tsx:102` |
| Прогоны: список, один прогон, `has_error`, `trigger_type` | бета | есть и работает | `routes/deployment-runs.ts:32`, `:62`; `contracts/deployment-runs.ts:9` |
| Типы ошибок прогона и причины паузы | бета | есть и работает, имена с суффиксом `_error` как в SDK | `contracts/deployment-runs.ts:26`; `contracts/deployments.ts:134` |
| Бюджет на каждый прогон | бета | частично. API принимает, запуск копирует бюджет в сессию. В форме консоли поля нет | `packages/managed-agents-application/src/sessions/application.ts:426`; `DeploymentForm.tsx:155` |
| Outcome как стартовое событие | бета | частично. API принимает `user.define_outcome`, форма шлёт только `user.message` | `contracts/deployments.ts:49`; `DeploymentForm.tsx:134` |
| Хранилища секретов в деплойменте | бета | частично. API и запуск передают `vault_ids`, в форме поля нет | `sessions/application.ts:432`; `DeploymentForm.tsx:155` |
| Автопауза при неисправимой ошибке | бета | в коде, не подключено. Тип причины `error` есть, никто его не ставит | `packages/managed-agents-domain/src/deployments/deployment.ts:64` |
| Архив деплоймента вслед за агентом | бета | нет. Сервис агентов не трогает деплойменты | `packages/managed-agents-application/src/agents/application.ts` |
| Удаление деплоймента | бета, есть событие `deployment.deleted` | нет, маршрута удаления нет | `routes/deployments.ts:61` |
| Случайный сдвиг запуска, лимит 1000 | бета | нет | нет кода |
| Консоль: список, карточка, форма, вкладка прогонов, ближайшие запуски | есть в консоли Anthropic | есть и работает | `apps/console/src/main.tsx:150`; `DeploymentDetail.tsx:52`, `:159`; `DeploymentsList.tsx:56` |
| Сессии деплоймента: фильтр `deployment_id` | бета | есть и работает | `routes/sessions.ts:89` |
| Адреса вебхуков с выбором типов и секретом | бета, только консоль | нет. Один адрес и ключ из переменных `OMA_MANAGED_AGENTS_WEBHOOK_*`, их нет в `.env.example` | `apps/main-node/src/config.ts:328`; `apps/main-node/src/modules/node-managed.ts:879` |
| Конверт, подпись Standard Webhooks, три попытки 5..120 секунд, без редиректов | бета | есть и работает для одного события | `packages/managed-agents-adapters-runtime/src/environment-work-webhook-wakeup.ts:21`, `:58`, `:76` |
| События сессий | бета | частично. Только `session.status_run_started` и только когда работа встаёт в очередь self-hosted окружения | `node-managed.ts:1167`; `packages/managed-agents-application/src/environment-work/enqueuer-application.ts:87` |
| События агентов, деплойментов, прогонов, окружений, хранилищ | бета | нет | нет кода |
| Автоотключение адреса и `disabled_reason` | бета | нет. При 3xx отправитель только прекращает повторы | `environment-work-webhook-wakeup.ts:21` |

Входящие вебхуки Linear, GitHub и Slack (`node-http.ts:985`) идут в обратную сторону и к CMA не относятся. Наш проект `docs/components/10-deployments-memory-skills.md` описывает и запуск деплоймента по входящему вебхуку. В CMA такого триггера нет.

## 4. Что добавить

1. **Тик расписания.** Сначала. Бэк-офис живёт на регулярных задачах: утренний отчёт, сверка остатков, разбор смены. Сейчас деплоймент с cron просто лежит в базе. Нужна задача в `node-scheduler-jobs.ts` раз в минуту. Она берёт активные деплойменты с наступившим временем, пишет прогон с `trigger_context.type: "schedule"` и запускает сессию тем же `launch`. Хранилищу прогонов нужен метод вроде `beginScheduled` с уникальным ключом `(deployment_id, scheduled_at)`. Тогда две реплики не запустят один прогон дважды, это пункт 4 в `docs/decisions-2026-10-17.md`. Тот же тик пересчитывает `upcoming_runs_at` и ставит `last_run_at`.
2. **Ручной запуск на паузе.** Сначала. Правка маленькая: убрать проверку статуса в `runDeployment` и `not_runnable` в хранилище, убрать подсказку `RUN_NEEDS_ACTIVE` в консоли. Сейчас новый деплоймент из консоли стоит на паузе, и проверить его до включения нельзя. CMA прямо советует проверять так.
3. **Автопауза при неисправимой ошибке.** Потом, вместе с тиком. Архив окружения или хранилища секретов должен ставить паузу с причиной `error`, а лимит на создание сессий паузу не ставит. Иначе сломанный отчёт будет падать каждый день без сигнала.
4. **Поля бюджета, хранилищ секретов и outcome в форме.** Потом. Отчёт по расписанию даёт результат, который можно проверить, и для него CMA советует outcome. Бюджет на прогон защищает от ночного перерасхода. API это уже умеет, не хватает консоли.
5. **Фильтр «только ошибки» на вкладке прогонов.** Потом. API уже принимает `has_error`. Оператору бэк-офиса важнее всего упавшие прогоны.
6. **Исходящие вебхуки по образцу CMA.** Потом. Таблица адресов: URL, типы, секрет `whsec_` (показать один раз), статус, `disabled_reason`. Страница в консоли. Первые события: `session.status_idled`, `session.status_terminated`, `deployment_run.failed`, `deployment.paused`. Так учётная система или бот в мессенджере узнают, что отчёт готов или прогон упал, без потока SSE. Отправитель с подписью и повторами уже есть, его надо обобщить.
7. **Автоотключение адреса.** Позже, вместе с пунктом 6. Правило про непубличный IP у нас не подходит как есть. В своей сети адрес вроде n8n на внутреннем IP нормален, поэтому лучше список разрешённых сетей.
8. **Удаление деплоймента и событие `deployment.deleted`.** Позже. Архива хватает для работы, удаление нужно для чистки.
9. **Случайный сдвиг и лимит 1000.** Не нужно. Один сервер и десятки деплойментов не создают пиков нагрузки.
10. **Окончательный архив и архив вслед за агентом.** Не нужно. Наш `unarchive` сделан намеренно (`docs/plans/crud.md`, 1.1). При архивном агенте хватит автопаузы из пункта 3.

## 5. Источники

- https://platform.claude.com/docs/en/managed-agents/scheduled-deployments
- https://platform.claude.com/docs/en/managed-agents/webhooks
- Справочник SDK: `managed-agents-scheduled-deployments.md`, `managed-agents-webhooks.md`, `managed-agents-api-reference.md`, `managed-agents-onboarding.md` из скилла claude-api.
- Код: `platform/packages/managed-agents-api/src/routes/deployments.ts`, `deployment-runs.ts`, `platform/packages/managed-agents-application/src/deployments/application.ts`, `platform/packages/managed-agents-adapters-runtime/src/environment-work-webhook-wakeup.ts`, `platform/apps/main-node/src/lib/node-scheduler-jobs.ts`, `platform/apps/console/src/pages/deployments/`.
