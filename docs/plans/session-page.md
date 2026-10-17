# Страница сессии как в консоли Claude

> **2026-10-17.** Остался только harness Pi, решение D41 в [decisions-2026-10-17.md](../decisions-2026-10-17.md). Файла `default-loop.ts` больше нет, события хода пишет только `pi-loop.ts`.

Владелец прислал экраны страницы сессии из консоли Claude и просит сделать так же. Образец описан в [03-sessions.md](../cma-console/03-sessions.md), разделы 4..14, скриншоты лежат в `.audit/cma-screens/03-sessions/`. Раскладку, плотность и поведение повторяем один в один. Цвета и шрифты берём только из токенов DDC (`platform/apps/console/src/styles/ddc-tokens.css`). Тексты пишем свои, по-русски, по правилам `.claude/skills/unslop/SKILL.md`.

План уточняет единицы K5, K5b, K5c из [console-parity.md](console-parity.md) и вкладку инструментов C2 из [models-harness-analytics.md](models-harness-analytics.md). Для страницы сессии действует разбиение на файлы из этого документа. Файлы `tool-stats.ts` и `ToolsPanel.tsx` из плана C2 не заводим, их работу делают `session-stats.ts` и `ToolsTab.tsx`.

Сокращения путей: `C/` это `platform/apps/console/src/`, `S/` это `C/components/session/`, `I/` это `S/inspector/`.

## Правка 2026-10-16: токены, стоимость и бюджет убраны

Владелец решил, что модели внутренние и следить за токенами не нужно. Со страницы сессии убрано всё про токены, стоимость и бюджет. Ниже в плане эти части остались как история, делать их не нужно.

- Шапка: чипы токенов и стоимости с подсказками, пункт «Изменить бюджет» в меню «Действия». Остались длительность и последняя активность (пункты 8, 9, 11, 13, 66 образца).
- Вкладка «Сессия»: раздел «Стоимость» с графиком, токены в таблице «Использование». Осталось активное время (пункты 45, 46).
- Вкладка «Потоки»: колонки «Контекст» и «Стоимость», график контекста, токены и стоимость в «Использовании». Осталось активное время (пункты 60, 61).
- Лента: токены «↑ N ↓ M» у карточки запроса (пункт 32). События: токены в кратком тексте `span.model_request_end`.
- Код: `S/useSessionCost.ts`, `C/lib/analytics-api.ts`, окно `EditBudgetDialog`, график `TimeChart`, форматы `formatUsdMicrosRu` и `formatCentsRu`, правило стоимости из раздела 2. `C/lib/session-stats.ts` считает только время, запросы, ошибки, события и инструменты.
- Сервер: пункты 1, 3 и 5 раздела 9 (маршруты аналитики, счётчик `session.usage`, применение бюджета) странице больше не нужны.

## 1. Что есть сейчас

- `C/pages/SessionDetail.tsx` (1721 строка) держит загрузку истории, живой поток, реплики до подтверждения сервером, очередь, шапку, вкладки «Разговор» и «Хронология», дерево потоков над лентой, плашки Linear и Slack, боковые панели агента, окружения и файлов, окно траектории.
- Лента идёт через библиотеку `@openma/common/chat-ui`. `AgentChatView` держит прокрутку, прилипание к низу, кнопку «вниз» и колонку поля ввода. `S/CanonicalSessionTurn.tsx` рисует ход через `AgentUITurnView`. Это раскладка Backchat. Процесс хода свёрнут в «Работал N с», ответ стоит отдельно, вызов инструмента это раскрывающийся блок `ai-elements/tool.tsx` с JSON параметров.
- Ходы строит `projectCanonicalChatTurns` из `@openma/common/session-events/managed`. Новый ход начинается с `user.message`. В `rawEvents` хода попадают все события потока по порядку прихода, включая `span.*` и события результата.
- Инспектора, мини-карты, поиска по разговору, счёта токенов и стоимости на странице нет.

## 2. Какие данные есть без правки сервера

Проверено по коду: контракт `platform/packages/managed-agents-api/src/contracts/session-events.ts`, преобразование ответа `.../mappers/session-events.ts` (`toSessionEventResponse`), источники событий `apps/agent/src/harness/pi-loop.ts`, `apps/agent/src/harness/default-loop.ts`, `apps/main-node/src/lib/node-managed-session-runner.ts`, `apps/main-node/src/lib/node-managed-harness-runtime.ts`.

| Данные | Откуда | Без сервера |
|---|---|---|
| Типы событий | `GET /v1/sessions/:id/events?order=asc&limit=100` по страницам и поток `/events/stream`. Список типов в контракте: `user.*`, `agent.*`, `session.*`, `span.model_request_*`, `span.outcome_evaluation_*`, `session.usage`, `session.updated` | есть |
| `processed_at` | у каждого события истории, ISO с миллисекундами, строго растёт внутри хода. У реплики в очереди `null`. Консоль ставит своё поле `ts` событиям потока без времени | есть |
| `span.model_request_end` | `model_request_start_id`, `is_error`, `model_usage` с полями `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `speed`. Длительность запроса считаем как разницу `processed_at` у конца и у начала с этим id. Поля `model`, `finish_reason`, `error_message` харнесс пишет, но публичный ответ их отбрасывает | есть, без модели и причины ошибки |
| `agent.thinking` | только `id` и время. Текста мысли в ответе API нет | есть, для «Думал N с» хватает |
| `agent.tool_use`, `agent.mcp_tool_use`, `agent.custom_tool_use` | `id`, `name`, `input`, у MCP ещё `mcp_server_name`. Поле `evaluated_permission` приходит только как `"ask"` у инструментов без исполнения (`default-loop.ts:105`) | есть |
| `agent.tool_result`, `agent.mcp_tool_result`, `user.custom_tool_result` | `tool_use_id` (у MCP `mcp_tool_use_id`, у своего инструмента `custom_tool_use_id`), `content` блоками, `is_error` | есть |
| `user.tool_confirmation` | `tool_use_id`, `result` `allow` или `deny`. Из него берём «Отклонено» и «Ожидание вас» | есть |
| `session.error`, `session.warning` | `error.type`, `error.message`, `error.retry_status`; у предупреждения `source`, `message` | есть |
| `user.define_outcome` | `outcome_id`, `description`, `rubric` (`{type:"text", content}` или `{type:"file", file_id}`), `max_iterations` | есть |
| Оценки результата | `span.outcome_evaluation_start`, `_ongoing`, `_end`. У конца `iteration` с нуля, `result` (`satisfied`, `needs_revision`, `max_iterations_reached`, `failed`, `interrupted`), `explanation`, `usage`. Итог также в `GET /v1/sessions/:id`, поле `outcome_evaluations[]` с `completed_at` | есть |
| Токены сессии | сумма `model_usage` по всем `span.model_request_end`. Поле `usage` у сессии и события `session.usage` не годятся: счётчик обнуляется на каждом ходе | есть, считаем в браузере |
| Активное время | интервалы от `session.status_running` до ближайшего `session.status_idle`, `session.status_terminated` или `session.error`. Поля `stats.active_seconds` сервер не заполняет | есть, считаем в браузере |
| Конфигурация агента | снимок `session.agent` в `GET /v1/sessions/:id`: `name`, `version`, `description`, `model.id`, `model.effort`, `tools[]`. Набор `agent_toolset_20260401` даёт `configs[]` (`name`, `enabled`, `permission_policy` `always_allow` или `always_ask`) и `default_config`. Ещё `mcp_toolset` и свои инструменты `custom` | есть |
| Ресурсы сессии | `GET /v1/sessions/:id/resources`: файл (`file_id`, `mount_path`), репозиторий GitHub (`url`, `mount_path`), хранилище памяти (`name`, `mount_path`). Добавить после создания можно только файл: `POST /v1/sessions/:id/resources` с `{type:"file", file_id}` после `POST /v1/files` | есть |
| Выходные файлы | `GET /v1/sessions/:id/outputs` отдаёт `data[]` с `filename`, `size_bytes`, `uploaded_at`, `media_type` из `/mnt/session/outputs/`, без подпапок. Скачивание `GET /v1/sessions/:id/outputs/:filename` | есть |
| Потоки мультиагента | `GET /v1/sessions/:id/threads`: `id`, `agent` (имя, модель, версия), `status`, `parent_thread_id`. Поля `usage` и `stats` у потока сервер не заполняет. События субагентов идут в общем списке с `session_thread_id` | есть, итоги считаем по событиям потока |
| Бюджет | `session.budget.max_list_cost.amount` строкой в центах (`"500"` это $5,00), правка `POST /v1/sessions/:id` с `budget` или `budget: null` | есть, сервер его не применяет |
| Стоимость | маршрут `GET /v1/oma/analytics/sessions/:id` из [analytics.md](analytics.md) 5.8 написан в `apps/main-node/src/lib/analytics/analytics-routes.ts`, но не подключён в `node-http.ts`, сейчас ответ 404. Запасной путь: цена из карточки модели `GET /v1/oma/model_cards`, поле `pi_config.cost` в долларах за 1 млн токенов (`input`, `output`, `cacheRead`, `cacheWrite`), карточку ищем по `model_id` равному `session.agent.model.id`. Без карточки пишем «нет цены» | частично |

Правило стоимости для всех трёх единиц:

1. Если `GET /v1/oma/analytics/sessions/:id` ответил 200, итог берём из `totals.cost_usd_micros`, ряд для графика из `GET /v1/oma/analytics/model_calls?session_id=<id>&limit=200` (строка журнала имеет тот же `id`, что событие `span.model_request_end`).
2. Иначе, если нашлась карточка модели с ценой, стоимость шага равна `вход × input + выход × output + чтение кэша × cacheRead + запись кэша × cacheWrite`, результат в миллионных долях доллара без деления (пример из плана аналитики: 20 токенов по $3 и 10 по $15 дают 210, то есть $0,00021).
3. Иначе «нет цены», графика нет.

Запросы к аналитике и карточкам идут с `quiet: true` (`C/lib/api.ts`), иначе 404 даст лишний тост.

## 3. Элементы образца и что у нас

Статусы: «есть», «частично», «нет». В колонке «Единица» буква исполнителя из раздела 5.

### 3.1 Раскладка и шапка

| № | Элемент образца | У нас | Откуда данные | Единица |
|---|---|---|---|---|
| 1 | Шапка на всю ширину. Ниже слева колонка разговора: строка поиска, мини-карта, лента карточек 720 px по центру, поле ввода внизу. Справа инспектор 480 px от строки поиска до низа окна. Шапка, поиск и мини-карта стоят на месте, прокручивается только лента | нет. Шапка, вкладки «Разговор» и «Хронология», карточка с лентой, выдвижные панели | нет | A |
| 2 | Строка 1: ID моноширинным с кнопкой копирования, справа «Действия ▾» и «⋮» | частично. Крошку рисует оболочка (`ConsoleShell.tsx`, не трогаем), справа кнопки «Файлы» и «Траектория» | `session.id` | A |
| 3 | Заголовок 22 px. Наведение даёт рамку поля, клик превращает в поле, под ним кнопки ✓ и ✕, Esc отменяет. Пустое название показывает ID | частично. Заголовок 24 px, карандаш, кнопки «Сохранить» и «Отмена» | `POST /v1/sessions/:id` с `title` | A |
| 4 | Плашка статуса справа от заголовка, на 390 px отдельной строкой | частично. Статус стоит в ряду чипов | `session.status`, события `session.status_*` | A |
| 5 | Чип агента со ссылкой и карточкой при наведении: «Агент» и короткий id, «Открыть», имя с плашкой версии, описание в две строки, модель и усилие, дата создания | частично. Чип открывает боковую панель | снимок `session.agent`; дата из `GET /v1/agents/:id` | A |
| 6 | Чип окружения со ссылкой и карточкой: «Окружение» и короткий id, «Открыть», имя, Тип, Область, Создано | частично. Чип открывает боковую панель | `GET /v1/environments/:id`: `config.type`, `scope`, `created_at` | A |
| 7 | Длительность «14 ч 2 мин» с подсказкой: прошло с создания и активное время | частично. Время от первого до последнего события, подсказки нет | `created_at`, время последнего события; активное время из `computeSessionTotals` | A, C |
| 8 | Токены «411,1 тыс. / 20,1 тыс.» с подсказкой: чтение кэша, запись кэша, без кэша, выход | нет | `computeSessionTotals` | A, C |
| 9 | Стоимость «$0,89 / $5,00» с подсказкой про цены и бюджет | нет | правило стоимости из раздела 2, `budget.max_list_cost` | A |
| 10 | Последняя активность «22 мин назад», обновляется на странице, подсказка с точной датой | нет. Есть «создана N назад» | время последнего события, иначе `updated_at` | A |
| 11 | Меню «Действия»: «Прервать», «Задать результат…», «Изменить бюджет», разделитель, красное «Архивировать» | частично. Остановка есть только в поле ввода | `user.interrupt` и `user.define_outcome` через `POST …/events`, `POST /v1/sessions/:id` с `budget`, `POST /v1/sessions/:id/archive` | A |
| 12 | Меню «⋮»: «Копировать все события», «Скачать все события», «Горячие клавиши». Перевод и отзыв не делаем | нет | события в памяти страницы | A, функции копирования и скачивания C |
| 13 | Диалог «Изменить бюджет» около 375 px: поле с префиксом $, пояснение, «Сохранить». Очистка поля снимает бюджет | нет | `POST /v1/sessions/:id` | A |
| 14 | Диалог «Задать результат» около 500 px: «Описание» с автофокусом, «Критерии», «Максимум итераций» с подсказкой 3, «Задать результат» | нет | `POST …/events` с `user.define_outcome` | A |
| 15 | Диалог «Горячие клавиши» около 500 px по клавише ? | нет | нет | A |
| 16 | Кнопка и панель «Спросить» (Ctrl I) | нет | нужен сервер, раздел 9 | не делаем |

### 3.2 Поиск, масштаб, мини-карта

| № | Элемент образца | У нас | Откуда данные | Единица |
|---|---|---|---|---|
| 17 | Поле «Найти в разговоре» 172 x 28 px, фокус клавишей /. Счётчик «9/12», стрелки «Назад» и «Далее», крестик. Enter и Shift Enter листают. Совпадения подсвечены, текущее ярче, блок с текущим получает рамку, лента прокручивается к нему. Блоки без совпадений не прячутся | нет | тексты блоков разговора | B |
| 18 | Кнопки «Мельче» и «Крупнее» (лупы) справа от поля | нет | нет | B |
| 19 | Кнопка «Инспектор» с иконкой панели справа от лупы, пока инспектор закрыт | нет | нет | A даёт кнопку, B место `trailing` |
| 20 | Мини-карта: контейнер 48 px, дорожка 24 px, на всю ширину колонки. Сегменты запросов к модели шириной по длительности, короткие метки реплик пользователя и задания результата, простои сжаты в узкий зазор, светлая рамка показывает видимую часть ленты | нет | блоки разговора, время событий | B |
| 21 | Наведение на сегмент: линия-курсор и подпись «15 окт., 11:41:08», над сегментом карточка: имя агента, длительность «57,7 с», время старта, «Вызвал write» или начало ответа. Блок в ленте подсвечен | нет | блоки разговора | B |
| 22 | Клик по сегменту: лента прокручивается к блоку, блок выделен, в адресе `?event=<id>`, во вкладке «События» выделена строка | нет | выбор события, раздел 7 | B, A |
| 23 | Масштаб: «Крупнее» расширяет дорожку, она прокручивается по горизонтали | нет | нет | B |
| 24 | Метки совпадений поиска на мини-карте | нет | результаты поиска | B |

### 3.3 Лента разговора

| № | Элемент образца | У нас | Откуда данные | Единица |
|---|---|---|---|---|
| 25 | Карточки шириной до 720 px, белые, радиус карточки DDC, текст 14 px, зазор 12..16 px | частично. Колонка 768 px, пузыри Backchat | нет | B |
| 26 | Блок пользователя: плашка «Пользователь» и время «11:40:01», под ней карточка с простым текстом | частично. Пузырь справа | `user.message`: `content`, `processed_at` | B |
| 27 | Плашка агента с именем и временем перед серией карточек агента. Повторяется после каждого блока не агента | нет | `session.agent.name`, у потока `thread.agent.name` | B |
| 28 | Отдельная карточка на каждый запрос к модели | нет. Ход свёрнут в «Работал N с» | группы от `span.model_request_start`, `buildTranscriptBlocks` | C, B |
| 29 | Серая подпись «Думал 1,9 с» вверху карточки. Текст мысли не раскрывается, клик выделяет группу | частично. «Думал N с» с раскрытием текста мысли из потока | время `agent.thinking` минус время `span.model_request_start` | C, B |
| 30 | Текст агента Markdown: списки, жирный, код | есть | `agent.message` | B |
| 31 | Строка вызова около 25 px: иконка инструмента, имя моноширинным жирным, аргумент серым в одну строку с многоточием, справа красная плашка «Ошибка» и длительность «119 мс» | частично. Блок с заголовком и плашкой «Готово» | `agent.tool_use`, пара `agent.tool_result`, `toolInputPreview` | C, B |
| 32 | У наведённой или выбранной карточки справа вверху «↑ 6,5 тыс.» и «↓ 275» | нет | `model_usage` группы | B |
| 33 | Длинный текст ограничен по высоте с затуханием и кнопкой «Читать дальше», после раскрытия внизу «Свернуть» | нет | нет | B |
| 34 | Раскрытие вызова кликом или клавишей →. bash: блок `$ команда`, серый блок вывода с затуханием и копированием. write: путь с копированием, содержимое с подсветкой по расширению. edit: путь, старый и новый текст. Ошибка: ввод с копированием и красный блок с текстом ошибки. ← или Esc сворачивает | частично. Раскрытие с JSON параметров и выводом | `input`, `content` результата, `formatToolOutput` | B |
| 35 | Чип вложенного файла в тексте | нет. В тексте виден только путь | путь `/mnt/session/outputs/<файл>`, ссылка на скачивание | B, по желанию |
| 36 | Блок «Задан результат»: заголовок, описание, подпись «Критерии» и список | нет | `user.define_outcome` | C, B |
| 37 | Блок «Оценка»: «Итерация N», плашка итога, справа «Критерии» (прокрутка к блоку результата), «↑ Назад», «↓ Далее» (неактивны на краях), текст разбора с «Читать дальше» | нет | `span.outcome_evaluation_end`, номер итерации плюс один | C, B |
| 38 | Разрыв времени: серая плашка по центру «пт, 16 окт., 01:42 (13 ч 56 мин)» | нет | время событий | C, B |
| 39 | Ошибка сессии в ленте | есть, с подсказками про карточку модели и пакеты окружения | `session.error` | B |
| 40 | Поле «Сообщение агенту» 32 px, круглая кнопка отправки внутри справа, неактивна при пустом поле | частично. Карточка 48 px и строка кнопок | нет | B |
| 41 | Круглая кнопка «Вниз» 32 px по центру над полем, пока лента прокручена вверх | есть, кнопка квадратная | библиотека | B |

### 3.4 Инспектор

| № | Элемент образца | У нас | Откуда данные | Единица |
|---|---|---|---|---|
| 42 | Полоса вкладок 32 px: «Сессия», «События», «Инструменты», «Ресурсы», «Потоки», справа крестик. «Потоки» приглушена, если других потоков нет | нет | нет | A |
| 43 | Сессия: таблица «ярлык серым, значение»: ID с копированием, Статус, Создана, Обновлена («чт, 15 окт., 11:39:27»), Агент, Окружение, Хранилища, Деплоймент | частично. Часть в чипах шапки | `GET /v1/sessions/:id` | A |
| 44 | Сессия: раздел «Результат»: Итог (плашка), Итерация, Завершено, Описание, Пояснение | нет | `outcome_evaluations[]`, `collectOutcomes` | A, C |
| 45 | Сессия: «Стоимость», справа «$0,89 / $5,00» и карандаш бюджета. Ступенчатый график с заливкой, ось Y в долларах, ось X время, точка на конце. Наведение: линия, подсказка «время, Стоимость $X, $Y этот шаг», метка на мини-карте | нет | правило стоимости, `buildCostSeries` | A, C |
| 46 | Сессия: «Использование», колонка «Итого по сессии»: Входные токены, Выходные токены, Чтение кэша, Запись кэша, Активное время | нет | `computeSessionTotals` | A, C |
| 47 | Сессия: «Метаданные», ключ моноширинным | нет | `session.metadata` | A |
| 48 | События: слева фильтр «Все события». В меню поиск, пресет «События разговора», раздел «Типы событий» с флажками по типам из сессии | нет | `filterEvents`, `eventTypesPresent` | C |
| 49 | События: справа «Копировать» и «Скачать» | нет | `eventJson` | C |
| 50 | События: таблица «Событие, Кратко, Время», строки 24 px. Тип моноширинным, префикс цветом (`agent.`, `user.`, `span.`), строки `session.*` приглушены целиком. Превью запроса к модели «3,6 с 4 вх. 139 вых. 20,9 тыс. кэш» | частично. «Хронология» показывает ходы, но не события | `eventPreview` | C |
| 51 | События: события одного запроса к модели в скруглённой рамке. `session.status_*`, `session.thread_status_*`, `user.*` стоят вне рамок | нет | `groupEventsByRequest` | C |
| 52 | События: панель снизу на половину высоты: «Событие agent.tool_use», справа короткий id, дата, JSON с ключами по алфавиту и подсветкой | нет | `eventJson` | C |
| 53 | События: клик по строке выделяет её и прокручивает ленту к блоку. Клик по блоку в ленте выделяет строку и показывает её JSON | нет | раздел 7 | C, B, A |
| 54 | Инструменты: поле «Найти инструмент». Таблица: Название с иконкой, Разрешение («Авто» или «Спросить»), Вызовы, Ошибки «5 (100 %)» красным, p50. Инструменты без вызовов приглушены, у них прочерки | нет | `toolCatalogFromAgent`, `computeToolStats` | C |
| 55 | Инструменты: «Сводка», справа «8 инструментов, 5 использовано, 17 вызовов». Кольцо и легенда: Ошибки, Отклонено, Прервано (при нуле «нет»), Выполнено | нет | `computeToolStats` | C |
| 56 | Инструменты: «Время в инструментах», колонка «Длительность»: Всего, Выполнение, Ожидание вас | нет | `computeToolStats` | C |
| 57 | Инструменты: клик по строке открывает деталь: «Инструмент bash», плашка разрешения, крестик, кольцо по нему, таблица вызовов «Время, Ввод, Статус, Длительность». Клик по вызову выделяет блок в ленте без раскрытия | нет | `ToolStatsRow.callList` | C |
| 58 | Ресурсы: поле «Найти ресурс», справа «Добавить ресурс ▾». В меню «Файл»; «Репозиторий GitHub» и «Хранилище памяти» серые с подписью «Только при создании сессии» | нет | `POST /v1/files`, `POST /v1/sessions/:id/resources` | A |
| 59 | Ресурсы: таблица «Путь, Размер»: иконка файла, путь моноширинным, размер «17,6 КБ». Клик по выходному файлу скачивает его | частично. Панель «Файлы» со списком выходных файлов | `GET …/outputs`, `GET …/resources` | A |
| 60 | Потоки: таблица «Поток, Статус, Контекст, Стоимость», первая строка выбрана | частично. Вкладки потоков над лентой | `GET …/threads`, `computeThreadStats` | A, C |
| 61 | Потоки: деталь снизу: «Поток <имя>»; «Подробности»: Агент с плашкой версии, Модель и усилие; «Контекст» со значением и графиком; «Использование», колонка «Этот поток»: Стоимость, Входные, Выходные, Чтение кэша, Запись кэша, Активное время | нет | `thread.agent`, `computeThreadStats` | A, C |
| 62 | Ширина: ручка на левой кромке, от 360 до 720 px, по умолчанию 480. Лента не шире 720 px и центрируется | нет | нет | A |
| 63 | Сворачивание: крестик или клавиша D. Лента центрируется, мини-карта на всю ширину, в строке поиска кнопка «Инспектор». Повторное открытие возвращает прежнюю вкладку и ширину | нет | нет | A |
| 64 | Состояние в адресе: `?inspector=session|events|tools|resources|thread`, `?event=<id>` | нет | нет | A |
| 65 | Горячие клавиши: ↑ ↓ K J (предыдущее и следующее событие), ← → (свернуть и раскрыть вызов), / (поиск), Enter и Shift Enter (совпадения), D (инспектор), Esc (свернуть вызов и снять выбор), ? (список клавиш) | нет | нет | A: D и ?; B: лента и поиск; C: стрелки в списке событий |

### 3.5 Узкий экран 390 px

| № | Элемент образца | У нас | Единица |
|---|---|---|---|
| 66 | Шапка столбиком: строка с ID и кнопками, заголовок с многоточием, статус отдельной строкой, чипы в три строки (агент и окружение; длительность и токены; стоимость и активность) | частично | A |
| 67 | Поиск на всю ширину, под ним справа лупы и «Инспектор», мини-карта на всю ширину, карточки на всю ширину | нет | B, A |
| 68 | Инспектор нижним листом от 40 % высоты экрана до низа. Шапка, поиск и мини-карта остаются сверху. Вкладки прокручиваются по горизонтали, таблицы теснее, длинный ID сжат серединой | нет | A, C |
| 69 | Скелетон загрузки в шапке и первых карточках | частично. Есть скелетон ленты | A, B |

### 3.6 Что у нас есть сверх образца и куда оно уходит

| Сейчас | Решение |
|---|---|
| Вкладки «Разговор» и «Хронология» | убираем. Список событий даёт вкладка «События». Файлы `C/components/timeline/*` в этой работе не трогаем, удаление отдельной задачей |
| Дерево потоков над лентой | переезжает во вкладку «Потоки». Клик по потоку переключает ленту на этот поток |
| Кнопка «Файлы» и `FilesPanel` | переезжает во вкладку «Ресурсы» |
| Боковые панели агента, окружения, хранилищ (`ResourcePanel`) | заменяют ссылки и карточки при наведении |
| Кнопка «Траектория», чипы итога и оценки траектории | пункт «Траектория» в меню «⋮», окно `TrajectoryViewerModal` остаётся |
| Плашки Linear и Slack | строки «Источник» во вкладке «Сессия» |
| Живой поток текста, мыслей и ввода инструмента, очередь реплик, «Агент работает…» | остаются в слоте `afterTurns` ленты |
| Вложение картинок в поле ввода | остаётся, кнопка «+» внутри поля слева |
| Пробуждение по расписанию | остаётся подписью над блоком пользователя |

## 4. Решения по виду

### 4.1 Цвета из токенов DDC

| Где | Образец | Токен DDC |
|---|---|---|
| Плашка «Пользователь», метки реплик на мини-карте, префикс `user.` | розовый | `--ddc-tone-brand-bg`, `--ddc-tone-brand-fg`, метка `--color-brand-500` |
| Плашка агента, префикс `agent.` | голубой | `--ddc-tone-info-bg`, `--ddc-tone-info-fg` |
| Сегменты запросов на мини-карте | синий | `--color-sky-300`, наведённый и выбранный `--color-sky-500` |
| Сегменты оценки на мини-карте | нет в образце | `--ddc-dot-warning` |
| Префикс `span.` | серо-синий | `--color-ink-500` |
| Строка `session.*` | приглушена | `--ddc-text-muted` |
| Плашка «Ошибка», блок ошибки, ошибки в таблице инструментов, сегмент ошибки | красный | `--ddc-tone-danger-bg`, `--ddc-tone-danger-fg`, `--ddc-danger-text`, `--ddc-dot-danger` |
| «Нужна доработка» | жёлтый | `--ddc-tone-warning-*` |
| «Выполнено» | нет в образце | `--ddc-tone-success-*` |
| «Итерации исчерпаны», «Прервано», плашка статуса | серый | `--ddc-tone-neutral-*` |
| Рамка выбранного блока и строки | синяя | `--ddc-ring`, фон выбранной строки `--ddc-selected-bg` |
| Совпадение поиска, текущее | жёлтое, оранжевое | `--color-amber-200`, `--color-amber-400` |
| Кольцо инструментов: выполнено, ошибки, отклонено, прервано | зелёный, красный | `--ddc-dot-success`, `--ddc-dot-danger`, `--ddc-dot-warning`, `--ddc-dot-neutral` |
| Линия и заливка графиков стоимости и контекста | синий | `--ddc-dot-info`, `--ddc-tone-info-bg` |
| Фон страницы, карточек, вложенных блоков вывода | тёплый серый, белый, серый | `--ddc-bg`, `--ddc-surface`, `--ddc-surface-sunken` |
| Границы | тонкие серые | `--ddc-border`, `--ddc-divider` |

Шрифт `--font-sans`, моноширинный `font-mono` Tailwind, как в остальной консоли. Своих цветов в шестнадцатеричном виде в компонентах нет.

### 4.2 Тексты интерфейса

| Образец | У нас |
|---|---|
| Find in transcript | Найти в разговоре |
| Zoom out, Zoom in | Мельче, Крупнее |
| Inspector | Инспектор |
| Jump to bottom | Вниз |
| Send a message to the agent | Сообщение агенту (подпись поля для чтения с экрана остаётся «Сообщение») |
| User | Пользователь |
| Thought for 1.9s | Думал 1,9 с |
| Read more, Show less | Читать дальше, Свернуть |
| Error | Ошибка |
| Called write | Вызвал write |
| Outcome defined, Rubric | Задан результат, Критерии |
| Grading, Iteration 2 | Оценка, Итерация 2 |
| Needs revision, Satisfied, Max iterations reached, Failed, Interrupted | Нужна доработка, Выполнено, Итерации исчерпаны, Оценка не удалась, Прервано |
| Prev, Next | Назад, Далее |
| Actions: Send interrupt, Define outcome…, Edit budget, Archive session | Действия: Прервать, Задать результат…, Изменить бюджет, Архивировать |
| Copy all events, Download all events, Keyboard shortcuts | Копировать все события, Скачать все события, Горячие клавиши |
| Session, Events, Tools, Resources, Threads | Сессия, События, Инструменты, Ресурсы, Потоки |
| Created, Updated, Agent, Environment, Vaults, Deployment | Создана, Обновлена, Агент, Окружение, Хранилища, Деплоймент |
| Outcome: Result, Iteration, Completed, Description, Explanation | Результат: Итог, Итерация, Завершено, Описание, Пояснение |
| Cost, Usage, Session total, Metadata | Стоимость, Использование, Итого по сессии, Метаданные |
| Input tokens, Output tokens, Cache read, Cache write, Active time | Входные токены, Выходные токены, Чтение кэша, Запись кэша, Активное время |
| All events, Transcript events, Event types, Search | Все события, События разговора, Типы событий, Поиск |
| Copy, Download | Копировать, Скачать |
| Event, Preview, Time | Событие, Кратко, Время |
| Filter tools, Name, Permission, Calls, Failed, Auto | Найти инструмент, Название, Разрешение, Вызовы, Ошибки, Авто (и Спросить) |
| Overview, 8 tools, 5 used, 17 calls | Сводка, 8 инструментов, 5 использовано, 17 вызовов |
| Failed, Denied, Interrupted, Completed, none | Ошибки, Отклонено, Прервано, Выполнено, нет |
| Time in tools: Total, Executing, Waiting on you, Duration | Время в инструментах: Всего, Выполнение, Ожидание вас, Длительность |
| Tool bash; Time, Input, Status, Duration; completed | Инструмент bash; Время, Ввод, Статус, Длительность; выполнен (ошибка, отклонён, прерван, выполняется) |
| Filter resources, Add resource, File, GitHub repository, Memory store, Path, Size | Найти ресурс, Добавить ресурс, Файл, Репозиторий GitHub, Хранилище памяти, Путь, Размер |
| Thread, Status, Context, Cost; Details, Model, Context usage, This thread | Поток, Статус, Контекст, Стоимость; Подробности, Модель, Контекст, Этот поток |
| Low effort | Низкое усилие (по `model.effort`) |
| `$X.XX / $B.BB` без цены | нет цены |

Числа по-русски: «6,5 тыс.», «1,2 млн», «$0,89», «35 %», «119 мс», «1,1 с», «14 ч 2 мин». Даты в часовом поясе браузера, как в образце.

## 5. Единицы работы

Три единицы, файлы не пересекаются. Каждый файл меняет только его единица. Чужие файлы только импортируются.

### Порядок

1. B1: новые функции в `S/format-ru.ts` с тестами (около часа). Их импортируют A и C.
2. C1: `C/lib/session-stats.ts` с тестами. Его типы и функции импортируют A и B.
3. После C1 параллельно: A, B2 (всё остальное в B), C2 (вкладки «События» и «Инструменты»).

A может начать каркас инспектора, адрес и ширину сразу, без B1 и C1, и подключить итоги после C1.

Перед стартом каждая единица смотрит `git status --short` своих файлов. В `SessionDetail.tsx`, `CanonicalSessionTurn.tsx`, `format-ru.ts`, `CanonicalSessionTurn.test.tsx`, `format-ru.test.ts` уже есть незакоммиченные правки этой ветки. Единица работает поверх них и ничего не откатывает.

### A (Sonnet): страница, шапка, инспектор, вкладки «Сессия», «Ресурсы», «Потоки»

Файлы:

- `C/pages/SessionDetail.tsx`, `C/pages/SessionDetail.prompt.test.tsx`, новый `C/pages/SessionDetail.layout.test.tsx`;
- `C/pages/session-detail/Panels.tsx`, `Panels.test.tsx`, `Trajectory.tsx`, `Trajectory.test.tsx`;
- новые `S/SessionHeader.tsx`, `S/SessionHeader.test.tsx`;
- новые `S/SessionDialogs.tsx` (бюджет, результат, горячие клавиши), `S/SessionDialogs.test.tsx`;
- новые `S/useSessionCost.ts`, `S/useSessionCost.test.tsx`;
- новые `I/SessionInspector.tsx`, `I/SessionTab.tsx`, `I/ResourcesTab.tsx`, `I/ThreadsTab.tsx` и тесты к каждому (`*.test.tsx` рядом).

Что сделать:

- Разметка страницы из п. 1 раздела 3: шапка `SessionHeader`, под ней строка из колонки разговора (`ManagedSessionConversation` от B) и `SessionInspector`. На ширине меньше 768 px инспектор нижний лист.
- Логику загрузки истории, живого потока, реплик до подтверждения, очереди и прерывания из `SessionDetail.tsx` сохранить как есть. Тесты `SessionDetail.prompt.test.tsx` остаются зелёными, в моках добавляются `sessions.resources.list`, `sessions.archive`, `agents.retrieve` и обработчики `msw` (`server.use` из `C/mocks/server`) для `/v1/sessions/:id/outputs`, `/v1/oma/model_cards`, `/v1/oma/analytics/sessions/:id`.
- Выбор события и вкладка в адресе, раздел 7. Клавиши D и ?.
- Потоки: `activeThreadId` в состоянии страницы, ленту и вкладку «События» фильтруем по нему, выбор во вкладке «Потоки».
- `useSessionCost` по правилу стоимости из раздела 2.
- Убрать вкладки «Разговор» и «Хронология», дерево потоков, кнопки «Файлы» и «Траектория», боковые панели (раздел 3.6).

Приёмка: элементы 1..15, 19, 42..47, 58..64 (A-часть), 66, 68 раздела 3; `?inspector=events&event=<id>` при загрузке открывает вкладку и выделяет блок; D закрывает и открывает инспектор с прежней вкладкой и шириной; ширина держится в 360..720 px и переживает перезагрузку; стоимость показывает «нет цены» без карточки и сумму по карточке, когда аналитика отвечает 404.

### B (Sonnet): лента, поиск, масштаб, мини-карта, блоки результата

Файлы:

- `S/CanonicalSessionTurn.tsx`, `S/CanonicalSessionTurn.test.tsx`;
- `S/ManagedSessionConversation.tsx`, `S/ManagedSessionConversation.test.tsx`;
- `S/format-ru.ts`, `S/format-ru.test.ts` (шаг B1);
- `S/SessionComposer.tsx`, `S/SessionComposer.test.tsx`;
- новые `S/TranscriptToolbar.tsx`, `S/TranscriptMinimap.tsx`, `S/OutcomeBlock.tsx` и тесты к каждому;
- новый `S/transcript.css` (правила `::highlight(...)` для поиска, затухание «Читать дальше»), импорт из `ManagedSessionConversation.tsx`.

Что сделать:

- `AgentChatView` остаётся оболочкой ленты: прокрутка, прилипание к низу, кнопка «Вниз», колонка поля ввода. `renderTurn` рисует ход своим компонентом `CanonicalSessionTurn` по блокам `buildTranscriptBlocks(turn.rawEvents, { previousEventMs })` вместо `AgentUITurnView`. Ширина колонки 720 px через `wrapConversationContent`.
- Атрибуты, на которые опираются тесты A: у хода `article[data-turn-id]`, у текста реплики пользователя `[data-session-turn-prompt]`. У корня блока `data-block-id`, у строки вызова `data-event-id=<id agent.tool_use>`.
- Поиск подсвечивает совпадения через CSS Custom Highlight API (`CSS.highlights`), DOM не меняется, Markdown рендерится как раньше. Где API нет (jsdom), счётчик и переходы работают, подсветки нет. Совпадения считает чистая функция по текстам блоков.
- Поведение тестов `CanonicalSessionTurn.test.tsx` про вывод инструмента (текст из блоков, ANSI убран, ошибка показана один раз), про сообщения без обрезки и про подсказки к ошибкам переносится на новую разметку. Тест про `AgentUITurnView` удаляется вместе с ним.
- `SessionComposer` в одну строку 32 px: «+» слева внутри, кнопка отправки или остановки круглая справа внутри, подпись «Сообщение агенту».

Приёмка: элементы 17, 18, 20..41, 65 (B-часть), 67, 69 раздела 3; клик по сегменту мини-карты пишет `?event=` через `onSelectEvent`; выбор события снаружи прокручивает ленту к блоку (проверка вызовом `scrollIntoView`) и раскрывает вызов, кроме выбора из «Инструментов» и мини-карты; Esc снимает выбор.

### C (Codex): данные страницы и вкладки «События», «Инструменты»

Файлы:

- новые `C/lib/session-stats.ts`, `C/lib/session-stats.test.ts` (шаг C1);
- новые `I/EventsTab.tsx`, `I/EventsTab.test.tsx`, `I/ToolsTab.tsx`, `I/ToolsTab.test.tsx` (шаг C2).

Что сделать:

- Все функции раздела 6.1, чистые, без React и сети. Входные события в порядке прихода, функции их не сортируют, время берут через `eventTimeMs`.
- Вкладки по элементам 48..57 раздела 3. Кольцо рисуется своим SVG, без новых зависимостей. JSON события через `CodeBlock` из `C/components/ai-elements/code-block.tsx` с языком `json`.

Приёмка: тесты на наборе событий, повторяющем образец (6 вызовов bash без ошибок с p50 384 мс; 5 вызовов web_search, все с ошибкой, 100 %; edit 4; write 1; web_fetch 1 с ошибкой; read, glob, grep без вызовов) дают таблицу и сводку «8 инструментов, 5 использовано, 17 вызовов», «Ошибки 6 (35 %)», «Выполнено 11»; группы событий совпадают с рамками на `inspector-events.jpg`; токены сессии равны сумме `model_usage`; клик по строке события вызывает `onSelectEvent(id, "events")`.

## 6. Интерфейсы между единицами

### 6.1 `C/lib/session-stats.ts` (C)

```ts
import type { Event } from "./events";

/** Событие сессии в том виде, в каком его держит SessionDetail. */
export type SessionEvent = Event;
export const PRIMARY_THREAD_ID = "sthr_primary";

/** Время события в мс: processed_at, затем processed_at_ms, затем ts
 *  (ISO, секунды до 1e11 или миллисекунды). Нет времени: null. */
export function eventTimeMs(event: SessionEvent): number | null;
/** session_thread_id или основной поток. */
export function eventThreadId(event: SessionEvent): string;
export function eventsOfThread(events: readonly SessionEvent[], threadId: string): SessionEvent[];

// ── Выбор события (общий тип для A, B, C) ────────────────────────────────
export type SelectionSource = "transcript" | "minimap" | "events" | "tools" | "url";
export interface EventSelection {
  eventId: string | null;
  source: SelectionSource;
  /** Растёт на каждый выбор: повторный клик по тому же событию снова прокручивает. */
  seq: number;
}

// ── Токены ───────────────────────────────────────────────────────────────
export interface ModelUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export const ZERO_USAGE: ModelUsage;
export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage;
/** input + cacheRead + cacheWrite: число у стрелки вверх. */
export function totalInput(usage: ModelUsage): number;

// ── Запросы к модели ────────────────────────────────────────────────────
export interface ModelRequest {
  /** id span.model_request_start, без него id span.model_request_end. */
  id: string;
  startEventId: string | null;
  endEventId: string | null;
  threadId: string;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  usage: ModelUsage | null;
  isError: boolean;
}
/** Пары начало и конец по model_request_start_id; конец без начала и начало без конца тоже попадают. */
export function collectModelRequests(events: readonly SessionEvent[]): ModelRequest[];

// ── Группы для вкладки «События» ────────────────────────────────────────
export type EventGroup =
  | { kind: "single"; event: SessionEvent }
  | { kind: "request"; id: string; events: SessionEvent[] };
/** Группа открывается на span.model_request_start и держит все события до
 *  следующего начала или до события верхнего уровня (user.*,
 *  session.status_*, session.thread_status_*, session.thread_created,
 *  session.updated, session.deleted). Остальные события без открытой группы
 *  идут отдельно. */
export function groupEventsByRequest(events: readonly SessionEvent[]): EventGroup[];

export type EventFamily = "agent" | "user" | "span" | "session" | "system" | "other";
export function eventFamily(type: string): EventFamily;
/** Пресет «События разговора»: user.message, user.define_outcome,
 *  user.interrupt, user.tool_confirmation, user.custom_tool_result,
 *  agent.message, agent.thinking, agent.tool_use, agent.tool_result,
 *  agent.mcp_tool_use, agent.mcp_tool_result, agent.custom_tool_use,
 *  agent.thread_message_sent, agent.thread_message_received,
 *  session.error, span.outcome_evaluation_end. */
export const TRANSCRIPT_EVENT_TYPES: ReadonlySet<string>;
export type EventFilter =
  | { mode: "all" }
  | { mode: "transcript" }
  | { mode: "types"; types: ReadonlySet<string> };
export function filterEvents(events: readonly SessionEvent[], filter: EventFilter): SessionEvent[];
/** Типы, которые есть в сессии, по алфавиту. */
export function eventTypesPresent(events: readonly SessionEvent[]): string[];

export interface EventIndex {
  byId: ReadonlyMap<string, SessionEvent>;
  toolNameByUseId: ReadonlyMap<string, string>;
  requestByEndId: ReadonlyMap<string, ModelRequest>;
}
export function buildEventIndex(events: readonly SessionEvent[]): EventIndex;
/** Колонка «Кратко»: user.message и agent.message первая строка текста;
 *  agent.tool_use «bash cd /mnt/…»; agent.tool_result «edit File updated…»;
 *  span.model_request_end «3,6 с 4 вх. 139 вых. 20,9 тыс. кэш»;
 *  span.outcome_evaluation_* «Итерация 2», у конца «нужна доработка, итерация 2»;
 *  session.thread_status_* имя агента; session.error текст ошибки;
 *  user.define_outcome описание; остальное пустая строка. */
export function eventPreview(event: SessionEvent, index: EventIndex): string;
/** Аргумент в строке вызова: bash command; read, write, edit file_path или
 *  path; glob и grep pattern; web_fetch url; web_search query; иначе первое
 *  строковое значение ввода, иначе JSON ввода в одну строку. */
export function toolInputPreview(name: string, input: unknown): string;
/** JSON для панели события: ключи по алфавиту на всех уровнях, отступ 2,
 *  без поля ts, если у события есть processed_at. */
export function eventJson(event: SessionEvent): string;

// ── Инструменты ─────────────────────────────────────────────────────────
export type ToolKind = "builtin" | "mcp" | "custom";
export type ToolPermission = "auto" | "ask";
export interface ToolCatalogEntry {
  name: string;
  kind: ToolKind;
  permission: ToolPermission;
  mcpServerName?: string;
}
/** Из session.agent.tools. Для agent_toolset_20260401 восемь встроенных
 *  инструментов (bash, edit, read, write, glob, grep, web_fetch, web_search):
 *  enabled и permission_policy из configs[], иначе из default_config.
 *  Выключенные не попадают. mcp_toolset: инструменты из configs[].
 *  custom: по имени, разрешение auto. */
export function toolCatalogFromAgent(tools: readonly unknown[] | undefined): ToolCatalogEntry[];

export type ToolCallStatus = "completed" | "failed" | "denied" | "interrupted" | "running";
export interface ToolCall {
  useEventId: string;
  resultEventId: string | null;
  confirmationEventId: string | null;
  name: string;
  kind: ToolKind;
  mcpServerName?: string;
  input: unknown;
  /** content результата как пришёл; для показа formatToolOutput. */
  output: unknown;
  isError: boolean;
  /** denied: user.tool_confirmation с deny; interrupted: нет результата, но
   *  после вызова в том же потоке пришёл session.status_idle,
   *  session.status_terminated, session.error или user.interrupt;
   *  running: нет результата и закрывающего события. */
  status: ToolCallStatus;
  startMs: number | null;
  endMs: number | null;
  /** Время результата минус время вызова. */
  durationMs: number | null;
  /** От вызова до user.tool_confirmation, иначе 0. */
  waitingMs: number;
  threadId: string;
  /** ModelRequest.id запроса, в группе которого стоит вызов. */
  requestId: string | null;
}
export function collectToolCalls(events: readonly SessionEvent[]): ToolCall[];

export interface ToolStatusCounts {
  completed: number; failed: number; denied: number; interrupted: number; running: number;
}
export interface ToolStatsRow {
  name: string;
  kind: ToolKind;
  /** null: инструмента нет в конфигурации агента, он виден только в событиях. */
  permission: ToolPermission | null;
  calls: number;
  failed: number;
  failedRatio: number | null;
  /** Медиана durationMs по вызовам с результатом. */
  p50Ms: number | null;
  counts: ToolStatusCounts;
  callList: ToolCall[];
}
export interface ToolsSummary {
  toolCount: number;
  usedCount: number;
  callCount: number;
  counts: ToolStatusCounts;
  time: { totalMs: number; executingMs: number; waitingMs: number };
}
/** Строки: сначала по числу вызовов по убыванию, затем порядок каталога. */
export function computeToolStats(
  calls: readonly ToolCall[],
  catalog: readonly ToolCatalogEntry[],
): { rows: ToolStatsRow[]; summary: ToolsSummary };

// ── Итоги ───────────────────────────────────────────────────────────────
export interface SessionTotals {
  /** Сумма model_usage по span.model_request_end, как в журнале аналитики. */
  usage: ModelUsage;
  requestCount: number;
  erroredRequestCount: number;
  /** Сумма usage по span.outcome_evaluation_end, в usage не входит. */
  evaluationUsage: ModelUsage;
  /** Интервалы session.status_running до status_idle, status_terminated
   *  или session.error; открытый интервал идёт до nowMs. */
  activeMs: number;
  firstEventMs: number | null;
  lastEventMs: number | null;
}
export function computeSessionTotals(
  events: readonly SessionEvent[],
  options?: { threadId?: string; nowMs?: number },
): SessionTotals;

export interface ThreadStats extends SessionTotals {
  threadId: string;
  /** Последний запрос потока: input + cacheRead + cacheWrite + output. */
  contextTokens: number | null;
  contextSeries: Array<{ atMs: number; tokens: number }>;
}
/** Активное время потока по session.thread_status_running и _idle. */
export function computeThreadStats(
  events: readonly SessionEvent[],
  threadId: string,
  nowMs?: number,
): ThreadStats;

// ── Цена ────────────────────────────────────────────────────────────────
/** Доллары за 1 млн токенов, как pi_config.cost карточки. */
export interface UsdPerMillion { input: number; output: number; cacheRead: number; cacheWrite: number }
/** null, если cost нет или числа неверные; cacheRead и cacheWrite по умолчанию 0. */
export function priceFromModelCard(
  card: { pi_config?: Record<string, unknown> } | null | undefined,
): UsdPerMillion | null;
/** Миллионные доли доллара, округление до целого. */
export function usageCostMicros(usage: ModelUsage, price: UsdPerMillion): number;
export interface CostPoint {
  atMs: number;
  eventId: string;
  stepMicros: number;
  cumulativeMicros: number;
}
/** Ряд по запросам с endMs. costOf вернул null хоть раз: весь ряд null. */
export function buildCostSeries(
  requests: readonly ModelRequest[],
  costOf: (request: ModelRequest) => number | null,
): CostPoint[] | null;
/** budget.max_list_cost.amount в центах, иначе null. */
export function budgetCents(budget: unknown): number | null;

// ── Результат ───────────────────────────────────────────────────────────
export interface OutcomeEvaluation {
  /** Как в событии, с нуля. На экране iteration + 1. */
  iteration: number;
  result: string;
  explanation: string;
  startEventId: string | null;
  endEventId: string;
  atMs: number | null;
  usage: ModelUsage;
}
export interface OutcomeView {
  outcomeId: string;
  eventId: string;
  description: string;
  rubric: { type: "text"; content: string } | { type: "file"; fileId: string };
  maxIterations: number | null;
  definedAtMs: number | null;
  evaluations: OutcomeEvaluation[];
}
export function collectOutcomes(events: readonly SessionEvent[]): OutcomeView[];

// ── Блоки ленты ─────────────────────────────────────────────────────────
export type RequestItem =
  | { kind: "text"; eventId: string; text: string }
  | { kind: "tool"; call: ToolCall }
  | {
      kind: "thread_message";
      eventId: string;
      direction: "sent" | "received";
      agentName: string | null;
      text: string;
    };

interface BlockBase {
  /** Стабильный id блока: id первого события блока. */
  id: string;
  atMs: number | null;
  /** Все события блока; по ним лента и вкладки находят блок. */
  eventIds: string[];
}
export type TranscriptBlock =
  | (BlockBase & {
      kind: "user";
      eventId: string;
      text: string;
      status: "processed" | "pending" | "cancelled";
      wakeup: boolean;
    })
  | (BlockBase & {
      kind: "request";
      request: ModelRequest | null;
      endMs: number | null;
      thinking: boolean;
      /** Время agent.thinking минус время span.model_request_start; нет мысли или времени: null. */
      thoughtMs: number | null;
      items: RequestItem[];
    })
  | (BlockBase & { kind: "outcome_defined"; eventId: string; outcome: OutcomeView })
  | (BlockBase & {
      kind: "grading";
      eventId: string;
      outcomeId: string;
      evaluation: OutcomeEvaluation;
      /** Номер оценки этого результата и их число, для «Назад» и «Далее». */
      index: number;
      count: number;
    })
  | (BlockBase & { kind: "gap"; gapMs: number })
  | (BlockBase & {
      kind: "error";
      eventId: string;
      message: string;
      errorType: string | null;
      retrying: boolean;
    })
  | (BlockBase & { kind: "warning"; eventId: string; source: string; message: string });

/** Порог разрыва времени: 30 минут. */
export const TRANSCRIPT_GAP_MS: number;
/** Блоки одного хода по порядку. agent.* вне группы запроса собираются в
 *  блок request с request = null. Статусы и session.usage блоков не дают.
 *  Разрыв между соседними событиями не меньше gapMs даёт блок gap; разрыв
 *  от previousEventMs до первого события хода даёт gap в начале. */
export function buildTranscriptBlocks(
  events: readonly SessionEvent[],
  options?: { previousEventMs?: number | null; gapMs?: number },
): TranscriptBlock[];
/** id события в id блока для всех событий; событие без блока берёт
 *  ближайший блок после себя, иначе перед собой. */
export function blockIdByEventId(
  blocks: readonly TranscriptBlock[],
  events: readonly SessionEvent[],
): Map<string, string>;
```

### 6.2 `S/format-ru.ts`, новые функции (B, шаг B1)

Существующие функции не меняются, ими пользуются другие страницы. Часовой пояс параметром, чтобы тесты шли в `"UTC"`.

```ts
/** «<1 мс», «119 мс», «1,1 с», «57,7 с», «3 мин 5 с», «14 ч 2 мин»; null даёт EMPTY_VALUE. */
export function formatShortDurationRu(ms: number | null): string;
/** «275», «6,5 тыс.», «411,1 тыс.», «1,2 млн», как formatCompact аналитики. */
export function formatTokensRu(n: number): string;
/** null «нет цены», 0 «$0», меньше 100 «<$0,0001», меньше 10 000 четыре знака
 *  «$0,0081», дальше два знака «$0,89», «$12,50». */
export function formatUsdMicrosRu(micros: number | null): string;
/** 500 даёт «$5,00». */
export function formatCentsRu(cents: number): string;
/** 0.35 даёт «35 %», 1 даёт «100 %». */
export function formatPercentRu(ratio: number): string;
/** «11:40:01». */
export function formatClockRu(ms: number, timeZone?: string): string;
/** «чт, 15 окт., 11:39:27». */
export function formatEventDateTimeRu(ms: number, timeZone?: string): string;
/** «15 окт., 11:41:08». */
export function formatMinimapTimeRu(ms: number, timeZone?: string): string;
/** «пт, 16 окт., 01:42 (13 ч 56 мин)». */
export function formatGapRu(atMs: number, gapMs: number, timeZone?: string): string;
```

### 6.3 Компоненты B

```ts
// S/ManagedSessionConversation.tsx
export interface ManagedSessionConversationProps {
  afterTurns?: ReactNode;
  composer: ReactNode;
  empty?: ReactNode;
  sessionId?: string;
  /** Ходы выбранного потока: projectCanonicalChatTurns(events, { threadId }). */
  turns: readonly CanonicalChatTurn[];
  agentName: string;
  running: boolean;
  selection: EventSelection;
  onSelectEvent(eventId: string | null, source: "transcript" | "minimap"): void;
  /** Кнопка «Инспектор» от A справа в строке поиска. */
  toolbarTrailing?: ReactNode;
  /** Метка времени на мини-карте при наведении на график стоимости. */
  externalCursorMs?: number | null;
}

// S/CanonicalSessionTurn.tsx
export interface CanonicalSessionTurnProps {
  turn: CanonicalChatTurn;
  blocks: readonly TranscriptBlock[];
  agentName: string;
  sessionId?: string;
  selectedEventId: string | null;
  selectedBlockId: string | null;
  /** Раскрыть вызов при выборе; false для выбора из «Инструментов» и мини-карты. */
  expandSelected: boolean;
  hoveredBlockId: string | null;
  onSelectEvent(eventId: string | null): void;
  onJumpToBlock(blockId: string): void;
}
export function sessionErrorMessages(events: readonly WireSessionEvent[]): string[]; // остаётся

// S/TranscriptToolbar.tsx
export type MinimapZoom = 1 | 2 | 4 | 8;
export interface TranscriptToolbarProps {
  query: string;
  onQueryChange(query: string): void;
  matchCount: number;
  /** 0..matchCount-1; -1, если совпадений нет. */
  currentMatch: number;
  onNextMatch(): void;
  onPrevMatch(): void;
  zoom: MinimapZoom;
  onZoomChange(zoom: MinimapZoom): void;
  inputRef?: Ref<HTMLInputElement>;
  trailing?: ReactNode;
}

// S/TranscriptMinimap.tsx
export interface MinimapSegment {
  blockId: string;
  eventId: string;
  kind: "request" | "user" | "outcome" | "grading" | "error";
  startMs: number;
  endMs: number;
  /** «Вызвал write» или первые слова ответа или реплики. */
  label: string;
}
export function minimapSegments(blocks: readonly TranscriptBlock[]): MinimapSegment[];
export interface TimeScale {
  width: number;
  toX(ms: number): number;
  toMs(x: number): number;
}
/** Простой длиннее idleGapMs (60 с) сжимается до idleWidthPx (6 px). */
export function compressedScale(
  segments: readonly MinimapSegment[],
  options: { widthPx: number; zoom: MinimapZoom; idleGapMs?: number; idleWidthPx?: number; nowMs?: number | null },
): TimeScale;
export interface TranscriptMinimapProps {
  blocks: readonly TranscriptBlock[];
  agentName: string;
  nowMs: number | null;
  zoom: MinimapZoom;
  visibleBlockIds: ReadonlySet<string>;
  hoveredBlockId: string | null;
  selectedBlockId: string | null;
  matchBlockIds: ReadonlySet<string>;
  externalCursorMs?: number | null;
  onHoverBlock(blockId: string | null): void;
  onSelectBlock(blockId: string, eventId: string): void;
}

// S/OutcomeBlock.tsx
type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;
export function OutcomeDefinedBlock(props: {
  block: Block<"outcome_defined">;
  selected: boolean;
  onSelect(): void;
}): JSX.Element;
export function GradingBlock(props: {
  block: Block<"grading">;
  selected: boolean;
  onSelect(): void;
  onJumpToRubric(): void;
  onPrev?(): void;
  onNext?(): void;
}): JSX.Element;
```

### 6.4 Компоненты C

```ts
// I/EventsTab.tsx
export interface EventsTabProps {
  sessionId: string;
  /** События выбранного потока в порядке прихода. */
  events: readonly SessionEvent[];
  selection: EventSelection;
  onSelectEvent(eventId: string | null, source: "events"): void;
}
export function copyEventsToClipboard(events: readonly SessionEvent[]): Promise<void>;
/** Файл events-<sessionId>.json из eventJson каждого события. */
export function downloadEventsFile(sessionId: string, events: readonly SessionEvent[]): void;

// I/ToolsTab.tsx
export interface ToolsTabProps {
  events: readonly SessionEvent[];
  /** session.agent.tools или tools агента потока. */
  agentTools: readonly unknown[] | undefined;
  selection: EventSelection;
  onSelectEvent(eventId: string, source: "tools"): void;
}
```

### 6.5 Компоненты A

```ts
// I/SessionInspector.tsx
export type InspectorTab = "session" | "events" | "tools" | "resources" | "thread";
export const INSPECTOR_TABS: readonly InspectorTab[];
/** Неизвестное или пустое значение даёт "session". */
export function parseInspectorTab(value: string | null): InspectorTab;
export const INSPECTOR_MIN_WIDTH = 360;
export const INSPECTOR_DEFAULT_WIDTH = 480;
export const INSPECTOR_MAX_WIDTH = 720;
export function clampInspectorWidth(width: number): number;
export interface SessionInspectorProps {
  layout: "side" | "sheet";
  tab: InspectorTab;
  onTabChange(tab: InspectorTab): void;
  onClose(): void;
  width: number;
  onWidthChange(width: number): void;
  threadsMuted: boolean;
  /** Содержимое активной вкладки; неактивные вкладки не монтируются. */
  children: ReactNode;
}

// S/useSessionCost.ts
export type CostSource = "analytics" | "card" | "none";
export interface SessionCost {
  source: CostSource;
  /** null: «нет цены». */
  totalMicros: number | null;
  budgetCents: number | null;
  series: CostPoint[] | null;
  /** Цена карточки по handle модели, для потоков с другой моделью. */
  priceForModel(modelId: string | null): UsdPerMillion | null;
}
export function useSessionCost(input: {
  sessionId: string;
  modelId: string | null;
  budget: unknown;
  requests: readonly ModelRequest[];
  /** Перезапрос аналитики при переходе в idle. */
  status: string;
}): SessionCost;

// S/SessionHeader.tsx
export interface SessionHeaderProps {
  session: BetaManagedAgentsSession | null;
  environment: BetaEnvironment | null;
  status: string;
  totals: SessionTotals;
  cost: SessionCost;
  lastActivityMs: number | null;
  onRename(title: string): Promise<void>;
  onInterrupt(): void;
  onDefineOutcome(): void;
  onEditBudget(): void;
  onArchive(): void;
  onCopyEvents(): void;
  onDownloadEvents(): void;
  onShowTrajectory(): void;
  onShowShortcuts(): void;
}

// I/SessionTab.tsx
export interface SessionTabProps {
  session: BetaManagedAgentsSession;
  environment: BetaEnvironment | null;
  vaults: ReadonlyArray<{ id: string; name?: string }>;
  status: string;
  totals: SessionTotals;
  outcomes: readonly OutcomeView[];
  cost: SessionCost;
  /** Строки «Источник» из metadata linear и slack. */
  sources?: ReactNode;
  onEditBudget(): void;
  onHoverTime?(ms: number | null): void;
}

// I/ResourcesTab.tsx
export interface ResourcesTabProps {
  sessionId: string;
}

// I/ThreadsTab.tsx
export interface ThreadsTabProps {
  session: BetaManagedAgentsSession;
  /** Все потоки из GET /threads, включая основной. */
  threads: readonly BetaManagedAgentsSessionThread[];
  /** События всех потоков. */
  events: readonly SessionEvent[];
  activeThreadId: string;
  onSelectThread(threadId: string): void;
  priceForModel(modelId: string | null): UsdPerMillion | null;
}
```

Типы `BetaManagedAgentsSession`, `BetaManagedAgentsSessionThread`, `BetaEnvironment` берутся из `@anthropic-ai/sdk/resources/beta/...`, как в `C/lib/managed-api.ts`. `CanonicalChatTurn` и `WireSessionEvent` из `@openma/common/session-events/managed`.

## 7. Выбор события: путь между лентой и инспектором

Один источник правды, параметр `event` в адресе. Выбор хранит `SessionDetail` (A).

1. При загрузке A читает `?event=<id>` и `?inspector=<tab>` через `useSearchParams` и ставит `selection = { eventId, source: "url", seq: 0 }`.
2. Любой компонент сообщает выбор вызовом `onSelectEvent(eventId, source)`. A увеличивает `seq`, пишет `event` в адрес с `replace: true` (история браузера не растёт) или убирает параметр при `null`.
3. A передаёт `selection` в `ManagedSessionConversation`, `EventsTab`, `ToolsTab`.
4. Лента (B) находит блок через `blockIdByEventId`. Блок получает рамку `--ddc-ring`. Если `source` не `"transcript"`, лента прокручивает блок к центру (`scrollIntoView({ block: "center", behavior: "smooth" })`), а строку вызова с `data-event-id` к центру, если она есть. Вызов раскрыт, если выбран его `agent.tool_use` или результат и `source` не `"tools"` и не `"minimap"`.
5. Клик по карточке, подписи «Думал», строке вызова, блоку результата или оценки вызывает `onSelectEvent(id, "transcript")`. Для карточки это id первого события группы, для строки вызова id `agent.tool_use`. Повторный клик по раскрытому вызову и Esc вызывают `onSelectEvent(null, "transcript")`.
6. Мини-карта вызывает `onSelectEvent(segment.eventId, "minimap")`. Наведение на сегмент подсвечивает блок внутри B и наружу не идёт.
7. «События» (C) выделяют строку с `eventId` и показывают её JSON. Если `source` не `"events"`, строка прокручивается в видимую часть списка. Если события нет в списке выбранного потока или его скрыл фильтр, панель JSON всё равно показывает его, а над таблицей стоит подпись «Событие скрыто фильтром».
8. «Инструменты» (C) вызывают `onSelectEvent(call.useEventId, "tools")`: лента прокручивается и выделяет вызов без раскрытия.
9. Наведение на график стоимости (A) передаёт время через `onHoverTime`. A кладёт его в `externalCursorMs` ленты, мини-карта рисует метку.
10. Вкладка: `onTabChange` пишет `inspector=<tab>`. Открыт инспектор или закрыт и его ширина хранятся в `localStorage` под ключом `oma.session.inspector` (`{ open, width }`), чтение и запись в `try/catch`. Без записи инспектор открыт на десктопе и закрыт на 390 px.

Клавиши. A ловит D и ? на уровне страницы. B ловит /, J, K, ↑, ↓, ←, →, Esc в ленте, Enter и Shift Enter в поле поиска. C ловит ↑ и ↓ в списке событий, когда фокус в нём. Обработчики не срабатывают, пока фокус в поле ввода.

## 8. Тесты и проверка

Строгий TDD: каждый шаг начинается с падающего теста. Команды из `platform/apps/console`, тяжёлые процессы по одному:

```sh
cd platform/apps/console
test-slot ./node_modules/.bin/vitest run --maxWorkers=2 <файлы теста>
test-slot ./node_modules/.bin/tsc --noEmit
node ../../../scripts/unslop-check.mjs <изменённые файлы>
```

Первые красные тесты по единицам:

- B1, `format-ru.test.ts`: каждая строка из раздела 6.2 с `timeZone: "UTC"`.
- C1, `session-stats.test.ts`: группы событий по `inspector-events.jpg`; длительность запроса по `model_request_start_id`; пара вызова и результата для `tool_use`, `mcp_tool_use`, `custom_tool_use`; статусы denied, interrupted, running; таблица и сводка инструментов на наборе образца; итоги токенов и активного времени; `buildTranscriptBlocks` даёт блоки пользователя, запросов с `thoughtMs`, результата, оценки с `index` и `count`, разрыва и ошибки, и каждое событие хода попадает в `blockIdByEventId`; `usageCostMicros` даёт 210 на примере из раздела 2; `eventPreview` по каждому типу.
- C2: `EventsTab.test.tsx` (фильтр, пресет, рамки групп, JSON выбранного события, клик вызывает `onSelectEvent`), `ToolsTab.test.tsx` (таблица, сводка, деталь, клик по вызову).
- B2: `CanonicalSessionTurn.test.tsx` (плашки, «Думал 1,9 с», строка вызова, раскрытие при выборе, «Читать дальше», перенесённые проверки вывода и подсказок), `OutcomeBlock.test.tsx`, `TranscriptToolbar.test.tsx`, `TranscriptMinimap.test.tsx` (сжатие простоя 14 ч, карточка при наведении, клик), `ManagedSessionConversation.test.tsx` (поиск, выбор снаружи прокручивает, Esc снимает выбор), `SessionComposer.test.tsx`.
- A: `SessionInspector.test.tsx` (вкладка из адреса, ширина в пределах, закрытие и возврат), `SessionHeader.test.tsx`, `SessionDialogs.test.tsx` (бюджет `{type:"limit", max_list_cost:{amount:"500", currency:"USD"}}`, пустое поле `budget: null`, результат `user.define_outcome` с `rubric:{type:"text"}`), `useSessionCost.test.tsx` (200 аналитики, 404 и карточка, нет карточки), `SessionTab.test.tsx`, `ResourcesTab.test.tsx`, `ThreadsTab.test.tsx`, `SessionDetail.layout.test.tsx` (`?inspector=events&event=<id>`, клавиша D), старые `SessionDetail.prompt.test.tsx` зелёные.

Сверка с образцом после всех единиц: скриншоты 1586 x 1280 и 390 x 844 рядом с кадрами `session-page.jpg`, `inspector-events.jpg`, `inspector-tools.jpg`, `session-minimap-hover.jpg`, `session-tool-call-expanded.jpg`, `session-outcome-block.jpg`, `session-page-mobile-390.jpg`, `session-inspector-mobile-390.jpg` через скилл `verify-agent-console`.

## 9. Что нужно от сервера

Без этих правок страница работает, но с оговорками. Сервер правят другие работы, здесь только список.

1. Подключить маршруты аналитики `buildAnalyticsRoutes` под `/v1/oma/analytics` в `apps/main-node/src/modules/node-http.ts`. Пока их нет, стоимость считается только по карточке модели. Встроенные модели без карточки показывают «нет цены», потому что цена каталога Pi есть только на сервере.
2. Отдавать в `span.model_request_end` поля `model`, `finish_reason`, `error_message` (сейчас их отбрасывает `toSessionEventResponse` в `packages/managed-agents-api/src/mappers/session-events.ts`, контракт `.strict()`). Без них в JSON события нет модели, а у упавшего запроса нет причины.
3. Исправить счётчик `session.usage`: он заводится заново на каждом ходе (`node-managed-harness-runtime.ts`), поэтому `usage` у сессии в `GET /v1/sessions/:id` и список сессий показывают только последний ход. Заполнять `stats.active_seconds`, `stats.duration_seconds`, `usage.list_cost`.
4. Заполнять `usage` и `stats` у потоков в `GET /v1/sessions/:id/threads`. Сейчас страница считает их по событиям потока.
5. Применять бюджет: останавливать ход при достижении `max_list_cost` и писать `stop_reason: budget_reached`. Сейчас «Изменить бюджет» только сохраняет число.
6. `evaluated_permission` приходит только как `"ask"` у инструментов без исполнения. Колонка «Разрешение» берётся из конфигурации агента, а не из события.
7. Текст мысли `agent.thinking` не попадает в публичный ответ. Образцу он не нужен, но после перезагрузки мысли видны только длительностью.
8. «Спросить» (Ask Claude) и «Предложить результат» требуют прямого вызова модели `POST /v1/oma/messages` (S8 из [console-parity.md](console-parity.md)). До него кнопок нет.
9. Выходные файлы отдаются плоским списком без подпапок `/mnt/session/outputs/` и без страниц (`has_more: false`).
