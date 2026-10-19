# Правка, архив и удаление всех сущностей

> **2026-10-17.** Остался только harness Pi, решение D41 в [decisions-2026-10-17.md](../decisions-2026-10-17.md). Карточек harness больше нет, поэтому строки про них (зависимости, маршруты `/v1/oma/harness_cards`, вид `harness_card` у `archive_object` и `delete_object`, единица A14) больше не действуют. То же относится к ACP и `ai-sdk`.

Черновик 1, 2026-10-16. Статус: проект, код не менялся.

Запрос владельца: «каждая сущность должна иметь возможность обновляться, удаляться и т. д.: сессии, агенты, окружения, файлы и так далее». Помощник из коммита c4098d9 (`N/lib/platform-mcp`) должен делать это по подтверждению.

Входы: сверка `.audit/crud-gaps.md`, маршруты `P/managed-agents-api/src/routes`, хранилища `P/*-store`, план помощника [builder-agent.md](builder-agent.md) (классы 2.2, подтверждение 2.5), разбор консоли Claude `docs/cma-console/02-managed-agents.md` и `02-managed-agents-gap.md`.

Пути:

- `C/` это `platform/apps/console/src`;
- `N/` это `platform/apps/main-node/src`, `NT/` это `platform/apps/main-node/test`;
- `P/` это `platform/packages`;
- `MA/` это `P/managed-agents-api/src`, `APP/` это `P/managed-agents-application/src`;
- `K/` это `platform/assistant`.

## 0. Коротко

1. Восстановление из архива получает маршрут `POST /<сущность>/:id/unarchive`. В консоли Claude и в разборе `docs/cma-console` восстановления нет, есть только `Archive`. Имя повторяет наш `.../archive`.
2. Новый маршрут `DELETE /v1/agents/:id`.
3. Архив и удаление проверяют зависимости. Блокирующая зависимость даёт 409 `dependency_conflict_error` со списком. Маршрут `GET /v1/oma/dependencies/:kind/:id?operation=archive|delete` отдаёт тот же список заранее, его читают консоль и помощник.
4. Архив и удаление принимают `If-Match` с ревизией объекта, как правка.
5. У помощника новый класс «опасное» между «правкой» и «вне v1». Архив и удаление идут в нём, восстановление идёт как правка. Карточка опасной операции красная, в ней список зависимостей, у удаления текст «Это нельзя отменить». Отпечаток включает зависимости.
6. В консоли появляется страница деплойментов, восстановление из архива, окна подтверждения архива и окна удаления со списком зависимостей.
7. Работа идёт тремя полосами без общих файлов: API, помощник, консоль (раздел 6).

API-ключи, участников, хранилища секретов и учётные данные помощник не трогает. Удаление деплоймента, восстановление учётных данных и треды сессий в этот план не входят.

## 1. Общие правила сервера

### 1.1 Восстановление

`POST /<сущность>/:id/unarchive` без тела. Ответ 200 с объектом и `ETag`, как у архива. Маршрут:

- снимает `archived_at`, поднимает ревизию, новой версии агента не создаёт;
- на объекте не в архиве отвечает 200 и ничего не пишет;
- принимает `If-Match`; несовпадение даёт 412;
- деплоймент возвращает на паузу, даже если до архива он был активен. Если агент или окружение деплоймента в архиве или удалены, ответ 409 `agent_archived_error` или `environment_archived_error`, как у `unpause`.

### 1.2 Зависимости

Живая сессия это сессия не в архиве со статусом `idle`, `running` или `rescheduling`. Живой деплоймент это деплоймент не в архиве.

Зависимость бывает двух видов:

- блокирующая: пока она есть, маршрут отвечает 409 и ничего не пишет;
- затронутая: маршрут работает, а консоль и карточка помощника показывают, что изменится.

Строка зависимости:

```json
{"kind": "deployment", "id": "depl_…", "name": "Утренний отчёт", "status": "active", "note": "запуски упадут"}
```

Ответ `GET /v1/oma/dependencies/:kind/:id?operation=archive|delete`:

```json
{"blocking": [], "affected": [], "truncated": false}
```

Каждый список до 50 строк, порядок по `kind`, затем по `id`. При обрезке `truncated: true`. Тело ошибки 409 у архива и удаления:

```json
{"type": "error", "error": {"type": "dependency_conflict_error", "message": "…", "dependencies": {"blocking": [], "affected": [], "truncated": false}}}
```

Проверка и запись идут в одном запросе к приложению. Гонка между проверкой и записью возможна, тест на неё не нужен. Внешних ключей в `managed_*` нет и в этом плане они не появляются.

### 1.3 Таблица зависимостей

| Сущность | Операция | Блокирует | Затрагивает |
|---|---|---|---|
| агент | архив | активные живые деплойменты с `agent_id` | деплойменты на паузе, живые сессии |
| агент | удаление | живые деплойменты, живые сессии | деплойменты в архиве, сессии в архиве или `terminated` |
| окружение | архив | активные живые деплойменты с `environment_id` | деплойменты на паузе, живые сессии |
| окружение | удаление | живые деплойменты, живые сессии, открытые задания `environment_work` | деплойменты в архиве, остальные сессии |
| сессия | архив, удаление | нет | ход остановится (статус `running` или `rescheduling`), прогоны деплойментов с этой сессией, выходные файлы |
| деплоймент | архив | нет | прогон в работе |
| файл | удаление | живые деплойменты и живые сессии с ресурсом `file` | остальные сессии с этим файлом |
| навык | удаление | агенты не в архиве, у текущей версии которых есть `skill_id` | агенты в архиве |
| версия навыка | удаление | агенты не в архиве, закреплённые на этой версии; последняя версия навыка (409 с текстом «Удалите навык целиком») | агенты на `latest`, если это последняя по номеру версия |
| хранилище памяти | архив | активные живые деплойменты с ресурсом `memory_store` | деплойменты на паузе, живые сессии |
| хранилище памяти | удаление | живые деплойменты, живые сессии | записи и их версии, сервер удаляет их вместе с хранилищем |
| запись памяти | удаление | нет | нет |
| ресурс сессии | удаление | нет | нет |
| карточка модели | архив, удаление | агенты не в архиве с `model`, равным `model_id` карточки | агенты в архиве; у последней карточки строка «Снова включится ключ ANTHROPIC_API_KEY» |
| карточка harness | архив | агенты не в архиве с `_oma.harness`, равным `harness_id` | нет |
| карточка harness | удаление | любая версия любого агента с этим `harness_id`, архивные тоже: ход старого агента читает карточку | нет |
| хранилище секретов (только консоль) | архив | активные живые деплойменты с `vault_ids` | живые сессии |
| хранилище секретов (только консоль) | удаление | живые деплойменты, живые сессии с `vault_ids` | учётные данные, сервер удаляет их вместе с хранилищем |

Архив агента, окружения, хранилища памяти и хранилища секретов теперь не ломает активный деплоймент: его сначала ставят на паузу или архивируют. Деплоймент на паузе после архива агента не снимается с паузы, `unpause` уже отвечает `agent_archived_error`.

### 1.4 If-Match на архиве и удалении

| Сущность | Что в `If-Match` |
|---|---|
| агент | текущая `version` (`"3"`) |
| окружение, сессия, деплоймент, хранилище памяти, навык | ревизия из `ETag` |
| версия навыка | ревизия навыка |
| карточка модели, карточка harness | `updated_at`, у карточки без правок `created_at` |
| запись памяти | уже есть `expected_content_sha256` в запросе |
| файл, ресурс сессии | ревизии нет; отпечаток помощника держит список зависимостей |

Заголовок необязательный. Без него маршрут работает как сейчас. Несовпадение даёт 412 и ничего не пишет. `GET` агента отдаёт `ETag` с версией, сейчас его нет.

## 2. Сущности и маршруты

«Есть» значит маршрут работает сейчас. «Доработать» значит маршрут есть, но нужны зависимости, `If-Match` или каскад.

### 2.1 Агенты и версии

| Операция | Маршрут | Сервер |
|---|---|---|
| правка | `POST /v1/agents/:id` с `version` | есть |
| восстановление версии | тот же маршрут с полями старой версии | есть; помощник: `restore_agent_version` |
| архив | `POST /v1/agents/:id/archive` | доработать: зависимости, `If-Match` |
| из архива | `POST /v1/agents/:id/unarchive` | добавить; `unarchiveCurrent` в `P/agent-store`, `-memory`, `-sql` |
| удаление | `DELETE /v1/agents/:id` | добавить; `deleteCurrent` удаляет текущую запись и все версии. Сессии хранят снимок агента: `GET` архивной сессии после удаления агента отвечает 200 |
| `ETag` | `GET /v1/agents/:id` | добавить, значение `version` |

Старый `DELETE /v1/oma/agents/:id` работает со старой таблицей. Его не трогаем.

### 2.2 Сессии и ресурсы сессии

| Операция | Маршрут | Сервер |
|---|---|---|
| название, метаданные | `POST /v1/sessions/:id` с `title`, `metadata` | есть, `If-Match` есть |
| архив | `POST /v1/sessions/:id/archive` | доработать: `If-Match`; ход в работе сервер прерывает до записи |
| из архива | `POST /v1/sessions/:id/unarchive` | добавить; статус остаётся прежним |
| удаление | `DELETE /v1/sessions/:id` | доработать: `If-Match`, прерывание хода |
| ресурсы | `GET`, `POST /v1/sessions/:id/resources`, `POST`, `DELETE .../resources/:resource_id` | есть |

### 2.3 Окружения

| Операция | Маршрут | Сервер |
|---|---|---|
| правка | `POST /v1/environments/:id` | есть |
| архив | `POST /v1/environments/:id/archive` | доработать: зависимости, `If-Match` |
| из архива | `POST /v1/environments/:id/unarchive` | добавить |
| удаление | `DELETE /v1/environments/:id` | доработать: зависимости (старая проверка была в `P/http-routes/src/environments/index.ts:224`), `If-Match` |

### 2.4 Файлы

| Операция | Маршрут | Сервер |
|---|---|---|
| загрузка | `POST /v1/files` (multipart) | есть |
| удаление | `DELETE /v1/files/:id` | доработать: зависимости |

Правки и архива у файла нет, как в API Anthropic.

### 2.5 Навыки и версии

| Операция | Маршрут | Сервер |
|---|---|---|
| новая версия | `POST /v1/skills/:id/versions` | есть |
| удаление версии | `DELETE /v1/skills/:id/versions/:version` | доработать: зависимости, `If-Match` |
| удаление навыка | `DELETE /v1/skills/:id` | доработать: зависимости, `If-Match` |

### 2.6 Хранилища памяти и записи

| Операция | Маршрут | Сервер |
|---|---|---|
| правка хранилища | `POST /v1/memory_stores/:id` | есть |
| архив | `POST /v1/memory_stores/:id/archive` | доработать: зависимости, `If-Match` |
| из архива | `POST /v1/memory_stores/:id/unarchive` | добавить |
| удаление | `DELETE /v1/memory_stores/:id` | доработать: зависимости, `If-Match`, удаление записей и версий |
| запись: создание, правка | `POST /v1/memory_stores/:id/memories`, `.../memories/:memory_id` | есть |
| запись: удаление | `DELETE .../memories/:memory_id?expected_content_sha256=` | есть |

### 2.7 Деплойменты

| Операция | Маршрут | Сервер |
|---|---|---|
| создание | `POST /v1/deployments` | есть |
| правка | `POST /v1/deployments/:id` | есть, `If-Match` есть |
| пауза, снятие с паузы | `POST /v1/deployments/:id/pause`, `/unpause` | есть; проверить `If-Match` |
| запуск | `POST /v1/deployments/:id/run` | есть |
| архив | `POST /v1/deployments/:id/archive` | есть, ревизия есть |
| из архива | `POST /v1/deployments/:id/unarchive` | добавить, правила в 1.1 |
| прогоны | `GET /v1/deployment_runs?deployment_id=` | есть |

### 2.8 Карточки моделей и harness

| Операция | Маршрут | Сервер |
|---|---|---|
| правка модели | `POST /v1/oma/model_cards/:id` | есть; помощник меняет только безопасные поля (`model_card_safe`) |
| архив модели | `POST /v1/oma/model_cards/:id/archive` | добавить; столбец `archived_at` и миграции; каталог моделей не показывает карточку в архиве |
| модель из архива | `POST /v1/oma/model_cards/:id/unarchive` | добавить |
| удаление модели | `DELETE /v1/oma/model_cards/:id` | доработать: зависимости, `If-Match` |
| правка harness | `POST /v1/oma/harness_cards/:id` | есть (`harness_card_safe`) |
| архив harness | `POST /v1/oma/harness_cards/:id/archive` | добавить, логика нынешнего `DELETE` |
| harness из архива | `POST /v1/oma/harness_cards/:id/unarchive` | добавить |
| удаление harness | `DELETE /v1/oma/harness_cards/:id` | поменять: настоящее удаление с зависимостями. Консоль в той же волне переходит на `/archive` |

### 2.9 Хранилища секретов (только консоль)

`POST /v1/vaults/:id/unarchive` добавить. Архив и удаление получают зависимости и удаляют учётные данные вместе с хранилищем.

## 3. Помощник

### 3.1 Класс «опасное»

Порядок классов: чтение, черновик, создание, правка, опасное, вне v1. В коде `OpClass` получает значение `danger` между `update` и `out_of_v1`.

| Операция | Класс |
|---|---|
| архив любой сущности из 3.2 | опасное |
| удаление любой сущности из 3.2 | опасное |
| восстановление из архива | правка |
| название и метаданные сессии | правка |
| пауза, снятие с паузы, запуск деплоймента | правка |
| правка активного деплоймента | правка, с предупреждением «Следующий запуск возьмёт новую конфигурацию» |
| ресурс сессии: добавление | создание |
| ресурс сессии: правка | правка |
| объект самого помощника (его агент, окружение, его сессия) | вне v1, `REASON_OWN` |
| у операции есть блокирующие зависимости | вне v1, новая причина «Сначала уберите зависимости» со списком |

Опасная операция не входит в `apply_changes`. Одна карточка несёт одну опасную операцию.

### 3.2 Инструменты

| Инструмент | Аргументы | Маршрут |
|---|---|---|
| `get_dependencies` (чтение) | `kind`, `id`, `operation`, `version?` | `GET /v1/oma/dependencies/:kind/:id` |
| `archive_object` | `kind`: agent, environment, session, deployment, memory_store, model_card, harness_card; `id` | `POST …/archive` |
| `unarchive_object` | те же `kind`, `id` | `POST …/unarchive` |
| `delete_object` | `kind`: agent, environment, session, file, skill, skill_version, memory_store, memory, session_resource, model_card, harness_card; `id`; `parent_id?` (навык, хранилище, сессия); `version?` | `DELETE …` |
| `update_session` | `session_id`, `title?`, `metadata?` | `POST /v1/sessions/:id` |
| `pause_deployment`, `unpause_deployment` | `deployment_id` | `POST /v1/deployments/:id/pause`, `/unpause` |
| `run_deployment` | `deployment_id` | `POST /v1/deployments/:id/run` |
| `add_session_resource` | `session_id`, ресурс `file` или `memory_store` | `POST /v1/sessions/:id/resources` |
| `update_session_resource` | `session_id`, `resource_id`, поля | `POST /v1/sessions/:id/resources/:resource_id` |

`list` получает виды `session_resources` и `deployment_runs`, если их нет. Хранилища секретов, учётные данные, API-ключи и участники в `kind` не входят.

### 3.3 Правила маршрутов

`RouteRule.method` получает `DELETE`. Новые проверки тела:

- `session_update`: в теле только `title` и `metadata`, ключи `oma_*` менять нельзя. Так помощник не меняет `tools` сессии через этот маршрут;
- `if_match_required`: у архива и удаления объекта с ревизией (1.4) есть `If-Match`;
- `session_resource`: только ресурсы `file` и `memory_store`.

Маршрутов хранилищ секретов, учётных данных, ключей и участников в таблице нет, токен получает 403.

### 3.4 Отпечаток и карточка

Отпечаток опасной операции добавляет к полям из builder-agent.md 2.5 шаг 4 списки `blocking` и `affected` (вид, id, статус каждой строки) и флаг `truncated`. Новая зависимость после показа карточки даёт 409 `stale` в `confirm` и `refused_stale` при исполнении. Перед записью сервер читает зависимости снова.

Вид операции для консоли (`PreviewOpView`) получает поля:

- `dependencies`: `{blocking, affected, truncated}` или `null`;
- `irreversible`: `true` у удаления.

Карточка опасной операции красная. Заголовок «Удалить …» или «Архивировать …». Под ним списки «Мешает» и «Затронет». У удаления строка «Это нельзя отменить». У архива строка «Объект можно вернуть из архива». При блокирующих зависимостях кнопки подтверждения нет, есть текст причины.

### 3.5 Подсказки

`help` получает тему `danger`: что опасно, зачем `get_dependencies` до карточки, почему одна опасная операция на карточку. Темы `session`, `deployment`, `limits` меняют текст: прерывание и второе сообщение остаются вне v1, архив, удаление и запуск деплоймента теперь есть. Промпт `K/prompt.md` и `K/docs/platform-builder.md`, `K/docs/platform-reference.md` получают те же правила.

## 4. Консоль

### 4.1 Деплойменты

Новый пункт меню «Деплойменты» в группе агентов, маршрут `/deployments`.

- Список: Название, ID, Агент, Триггер, Статус, Создан; чипы «Агент», «Статус» (Активные, На паузе, В архиве); меню строки «Запустить», «Пауза», «Продолжить», «Архивировать», «Вернуть из архива».
- Карточка `/deployments/:id`: свойства, «Ближайшие запуски», вкладка «Прогоны» (`GET /v1/deployment_runs?deployment_id=`) со ссылкой на сессию прогона, кнопки состояния.
- Создание `/deployments/new?agent=<id>` и правка: Название, Агент, Окружение, Начальное сообщение, Триггер (вручную или cron с часовым поясом), Ресурсы. Новый деплоймент создаётся на паузе. Редактор ресурсов выносится из `SessionsList.tsx` в общий компонент.
- Карточка агента получает пункт «Создать деплоймент».

### 4.2 Архив и удаление

- Общий компонент окна удаления: запрос `GET /v1/oma/dependencies/...` при открытии, списки «Мешает» и «Затронет», текст «Это нельзя отменить», кнопка выключена при блокирующих зависимостях. Ответ 409 `dependency_conflict_error` показывает тот же список.
- Окно подтверждения архива с тем же списком и строкой «Можно вернуть из архива». Сейчас его нет у окружения (`EnvironmentsList.tsx:243`), хранилища памяти (`MemoryStoresList.tsx:245`), сессии (`SessionsList.tsx:725`).
- Пункт «Вернуть из архива» в списках и карточках агентов, сессий, окружений, деплойментов, хранилищ памяти, хранилищ секретов, карточек моделей и harness. Сейчас он всегда выключен (`AgentsList.tsx:173`, `SessionsList.tsx:720`).
- Удаление агента в списке и карточке.
- Удаление ресурса сессии в панели ресурсов.
- Запросы архива и удаления шлют `If-Match` из последнего `ETag`. Ответ 412 показывает «Объект изменили, обновите страницу».

### 4.3 Остальное

- «Файлы»: кнопка «Загрузить» и перетаскивание (`POST /v1/files`).
- «Навыки»: удаление версии в списке версий.
- Карточка агента: в списке версий кнопка «Восстановить эту версию», она шлёт `POST /v1/agents/:id` с полями версии и текущей `version`.
- Карточка помощника: класс `danger` с подписью «Опасное», красная карточка из 3.4, сброс кэша после новых инструментов.

## 5. Порядок

1. Полоса API. Её маршруты нужны двум другим.
2. Полосы помощника и консоли идут параллельно после коммита API. До него консоль может писать тесты на заглушках клиента, помощник на заглушках `innerFetch`.
3. Смена смысла `DELETE /v1/oma/harness_cards/:id` идёт в одном коммите с переходом консоли на `/archive` или консоль переходит раньше.

## 6. Полосы

Файлы полос не пересекаются. Общие файлы чужой волны окружений (`N/modules/node-managed.ts`, `C/pages/EnvironmentDetail.tsx`, `C/pages/EnvironmentsList.tsx`) правятся только точечными добавками, координатор коммитит их отдельно.

### 6.1 Полоса API

| Задача | Файлы |
|---|---|
| A1. Фильтры поиска зависимостей: сессии по `environmentId`, `fileId`, `vaultId`; деплойменты по `environmentId`, `fileId`, `memoryStoreId`, `vaultId`; агенты по `skillId`, `skillVersion`, `model`, `harness` (с флагом «все версии») | `P/session-store/src/index.ts`, `P/session-store-memory`, `P/session-store-sql`, `P/deployment-store/src/index.ts`, `P/deployment-store-memory`, `P/deployment-store-sql`, `P/agent-store/src/index.ts`, `P/agent-store-memory`, `P/agent-store-sql` |
| A2. Модуль зависимостей: `DependencyService.check(kind, id, operation)` по таблице 1.3 | `APP/dependencies/` (новый), `APP/index.ts`, `P/managed-agents-app/src/modules/dependencies.ts` (новый) |
| A3. Ошибка `dependency_conflict_error` и схема ответа | `MA/errors.ts`, `MA/contracts/dependencies.ts` (новый) |
| A4. `GET /v1/oma/dependencies/:kind/:id` | `MA/routes/dependencies.ts` (новый), `MA/index.ts`, подключение в `N/modules/node-http.ts` |
| A5. Агент: `unarchive`, `DELETE`, `ETag`, `If-Match` на архиве, зависимости | `APP/agents/application.ts`, `APP/agents/port.ts`, `MA/routes/agents.ts`, `MA/ports/agents.ts`, `MA/contracts/agents.ts` |
| A6. Сессия: `unarchive`, `If-Match` на архиве и удалении, прерывание хода перед архивом и удалением | `APP/sessions/application.ts`, `MA/routes/sessions.ts`, `MA/ports/sessions.ts`, `P/session-store*` |
| A7. Окружение: `unarchive`, зависимости, `If-Match` | `APP/environments/application.ts`, `MA/routes/environments.ts`, `MA/ports/environments.ts`, `P/environment-store*` |
| A8. Деплоймент: `unarchive` на паузу, проверка `If-Match` у `pause` и `unpause` | `APP/deployments/application.ts`, `MA/routes/deployments.ts`, `MA/ports/deployments.ts` |
| A9. Файл: зависимости на удалении | `APP/files/application.ts`, `MA/routes/files.ts` |
| A10. Навык и версия: зависимости, `If-Match`, отказ на последней версии | `APP/skills/application.ts`, `APP/skills/versions-application.ts`, `MA/routes/skills.ts`, `MA/routes/skill-versions.ts` |
| A11. Хранилище памяти: `unarchive`, зависимости, `If-Match`, удаление записей и версий | `APP/memory-stores/application.ts`, `MA/routes/memory-stores.ts`, `P/memory-store-store*`, `P/memory-document-store*` |
| A12. Хранилище секретов: `unarchive`, зависимости, удаление учётных данных | `APP/vaults/application.ts`, `MA/routes/vaults.ts`, `P/vault-store*`, `P/credential-store*` |
| A13. Карточка модели: `archived_at`, `archive`, `unarchive`, зависимости и `If-Match` на удалении, каталог без архивных | `P/db-schema/src/cf-auth/model-cards.ts`, `P/db-schema/src/node-pg/cf-auth-model-cards.ts`, `platform/apps/main-node/migrations`, `platform/apps/main-node/migrations-sqlite`, `P/model-cards-store`, `P/http-routes/src/model-cards/index.ts`, `N/lib/model-options.ts` |
| A14. Карточка harness: `archive`, `unarchive`, настоящий `DELETE` с зависимостями | `N/lib/harness-cards/routes.ts`, `N/lib/harness-cards/store.ts`, `N/lib/harness-catalog.ts` |
| A15. Подключение `DependencyService` к приложениям | точечная добавка в `N/modules/node-managed.ts` (файл волны окружений, перечислить координатору) |

Тесты: по одному тесту маршрута на каждую строку таблицы 1.3 (409 со списком, 200 без зависимостей), 412 на устаревший `If-Match`, `unarchive` на объекте не в архиве, `GET` архивной сессии после удаления агента, удаление хранилища памяти без записей-сирот. Пакеты гоняются своим `vitest`, `main-node` через `NT/`.

### 6.2 Полоса помощника

| Задача | Файлы |
|---|---|
| B1. Класс `danger` в порядке классов, причина блокировки | `N/lib/platform-mcp/ports.ts`, `N/lib/platform-mcp/classify.ts` |
| B2. Методы `DELETE` и проверки `session_update`, `if_match_required`, `session_resource`; новые маршруты | `N/lib/platform-mcp/route-rules.ts`, `N/lib/platform-mcp/tool-table.ts` |
| B3. Инструменты `archive_object`, `unarchive_object`, `delete_object` | `N/lib/platform-mcp/tools/danger.ts` (новый), `N/lib/platform-mcp/tool-table.ts` |
| B4. `update_session`, `add_session_resource`, `update_session_resource` | `N/lib/platform-mcp/tools/sessions.ts` |
| B5. `pause_deployment`, `unpause_deployment`, `run_deployment`; правка активного деплоймента как правка с предупреждением | `N/lib/platform-mcp/tools/update.ts`, `N/lib/platform-mcp/classify.ts` |
| B6. `get_dependencies`, виды `session_resources` и `deployment_runs` в `list` | `N/lib/platform-mcp/tools/read.ts` |
| B7. Зависимости в виде операции и в отпечатке, запрет опасной операции в пачке, повторное чтение зависимостей в шлюзе | `N/lib/platform-mcp/preview.ts`, `N/lib/platform-mcp/gate.ts`, `N/lib/platform-mcp/tools/batch.ts`, `N/lib/platform-mcp/tools/common.ts` |
| B8. Шаблон: новые инструменты записи, `get_dependencies` в `always_allow`, новая версия шаблона | `N/lib/platform-mcp/builder-template.ts`, `N/lib/platform-mcp/builder-bundle.ts` |
| B9. `help`, промпт и знания помощника | `N/lib/platform-mcp/help.ts`, `K/prompt.md`, `K/docs/platform-builder.md`, `K/docs/platform-reference.md` |

Тесты: класс каждого нового инструмента по состоянию объекта, 403 на маршрут хранилища секретов, отказ `session_update` с полем `tools`, 409 `stale` после появления новой зависимости, `refused_stale` при исполнении, отказ пачки с опасной операцией, вне v1 у архива своего агента. Тесты лежат рядом с нынешними тестами `platform-mcp` в `NT/`.

### 6.3 Полоса консоли

| Задача | Файлы |
|---|---|
| C1. Клиент: `unarchive`, `delete` агента, зависимости, `If-Match` на архиве и удалении, ошибка 409 со списком | `C/lib/managed-api.ts`, `C/lib/harness-cards-api.ts`, `C/lib/model-cards-api.ts` (новый, сейчас запросы лежат прямо в `ModelCardsList.tsx`) |
| C2. Окна архива и удаления со списком зависимостей | `C/components/DangerDialog.tsx` (новый), `C/components/DependencyList.tsx` (новый) |
| C3. Страница деплойментов: список, карточка, создание, правка, состояние, прогоны | `C/pages/deployments/` (новая папка), `C/main.tsx`, `C/components/AppSidebar.tsx`, `C/components/nav-icons.ts`, `C/components/CommandPalette.tsx`, `C/components/EmptyState.tsx`, `C/i18n/ru.ts`, `C/i18n/types.ts` |
| C4. Общий редактор ресурсов | `C/components/ResourceListEditor.tsx` (новый), `C/pages/SessionsList.tsx` |
| C5. Агенты: удаление, из архива, восстановление версии, «Создать деплоймент» | `C/pages/AgentsList.tsx`, `C/pages/AgentDetail.tsx` |
| C6. Сессии: окно архива, из архива, удаление ресурса | `C/pages/SessionsList.tsx`, `C/pages/SessionDetail.tsx`, `C/pages/session-detail/Panels.tsx` |
| C7. Окружения: окно архива, из архива, удаление с зависимостями | точечные добавки в `C/pages/EnvironmentsList.tsx` и `C/pages/EnvironmentDetail.tsx` (файлы волны окружений, перечислить координатору) |
| C8. Хранилища памяти и секретов: окно архива, из архива, удаление с зависимостями | `C/pages/MemoryStoresList.tsx`, `C/pages/MemoryStoreDetail.tsx`, `C/pages/VaultsList.tsx`, `C/pages/VaultDetail.tsx` |
| C9. Файлы: загрузка, удаление с зависимостями | `C/pages/FilesList.tsx` |
| C10. Навыки: удаление версии, удаление навыка с зависимостями | `C/pages/SkillsList.tsx` |
| C11. Карточки моделей и harness: архив, из архива, удаление с зависимостями | `C/pages/ModelCardsList.tsx`, `C/pages/harnesses/HarnessCardsPage.tsx` |
| C12. Карточка помощника: класс `danger`, красная карточка, сброс кэша | `C/lib/assistant/api.ts`, `C/lib/assistant/confirm.ts`, `C/lib/assistant/invalidate.ts`, `C/components/assistant/ProposalCard.tsx`, `C/components/assistant/BatchProposalCard.tsx` |

Тесты: окно удаления с блокирующей зависимостью без кнопки, ответ 409 со списком, `If-Match` в запросе архива, пункт «Вернуть из архива» у архивной строки, красная карточка с «Это нельзя отменить», страница деплойментов на заглушке клиента. Тесты лежат рядом со страницами (`*.test.tsx`).
