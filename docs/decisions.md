# Решения по стыковке компонентов

Черновик 1, 2026-10-15. Основа: [design.md](design.md), спеки [components/](components/) и разбор сценариев [flows/](flows/).

Компоненты проектировались отдельно. Десять сквозных сценариев нашли около 150 нестыковок. Здесь они сведены в 40 решений. Каждое решение уже внесено в спеки: в начале каждой спеки есть раздел «0. Согласовано», он главнее остального текста спеки. Если текст спеки ниже расходится с разделом 0 или с этим файлом, верно то, что написано здесь.

Принцип выбора: простое и надёжное, без новых компонентов. Где два варианта одинаково просты, берём тот, что уже описан в спеке владельца данных.

## Сводка

| № | Решение | Компоненты |
|---|---|---|
| D1 | Вход в workflow: сначала журнал, потом Temporal | 01, 02, 09, 10 |
| D2 | Реестр ожиданий `session_waits` живёт в 01 | 01, 02, 03, 05 |
| D3 | Сообщение во время `waiting_tool` встаёт в очередь, а не получает 409 | 01, 02, 09 |
| D4 | Один контракт `RunTurn` | 02, 03 |
| D5 | Единые имена полей | все |
| D6 | Внутренний API журнала по контракту 01 | 01, 03, 04, 05, 06 |
| D7 | Ключ идемпотентности вызова тула считает Hub | 02, 03, 05, 09 |
| D8 | Восстановление хода после падения воркера | 03, 04, 05 |
| D9 | Токен сессии Hub: состав, срок, выпуск, отзыв | 03, 04, 05, 06 |
| D10 | `config_id` и поля конфига агента | 01, 02, 03, 05, 06, 07, 08 |
| D11 | Права агента берутся из toolsets его конфига | 05, 07, 08 |
| D12 | Ревизии toolset закрепляются в версии | 05, 07 |
| D13 | Права автора проверяются одним путём | 05, 07, 08 |
| D14 | Hub зовёт у IAM только `tool-scope`. Один список ролей | 05, 07, 08, 09 |
| D15 | Согласование публикации хранится в 08 | 07, 08 |
| D16 | Цикл подтверждения `write`-вызова | 01, 02, 03, 05, 08, 09 |
| D17 | Custom tools | 01, 02, 03, 05, 07, 08 |
| D18 | Сабагенты | 01, 02, 03, 05, 07, 10 |
| D19 | Создание сессии в 01 | 01, 04, 07, 08, 10 |
| D20 | Единые поля `metadata` | 01, 05, 09, 10 |
| D21 | Пустая версия значит `@live` | 01, 02, 07, 09, 10 |
| D22 | Отзыв плохой версии агента | 01, 02, 05, 07, 09 |
| D23 | Выкатка кода workflow | 02 |
| D24 | Песочница в workflow | 02, 03, 04 |
| D25 | Harness со встроенными тулами работает в песочнице | 03, 04, 07 |
| D26 | Один контракт egress и одна сеть песочницы | 04, 06 |
| D27 | Подмена секретов и уведомления `system.notice` | 01, 06 |
| D28 | Идентификатор тенанта | все |
| D29 | Подписанный контекст вызова встроенных серверов. Имена тулов платформы | 05, 07, 09, 10 |
| D30 | Права в общем треде: `turn_actors` | 02, 03, 05, 08, 09 |
| D31 | Каналы: склейка, владелец, идемпотентность, потоки, связки | 01, 02, 08, 09 |
| D32 | Память: привязки и тулы | 05, 09, 10 |
| D33 | Deployments | 01, 02, 08, 10 |
| D34 | Файлы-результаты и outcomes | 01, 02, 04, 06, 07, 10 |
| D35 | Бюджеты и лимиты сессии | 01, 02, 06, 07, 10 |
| D36 | Конструктор и тестовые сессии | 01, 05, 07, 08 |
| D37 | Кто чем владеет | 01, 04, 07, 10 |
| D38 | Каталог событий | 01, все писатели |
| D39 | Одна таблица лимитов | все |
| D40 | Шина событий, Temporal namespace, RLS | 02, 05, 07 |

## Решения

### D1. Вход в workflow: сначала журнал, потом Temporal

**Контекст.** Сценарии 02, 04, 05, 06. 01 пишет событие в журнал и шлёт Signal-With-Start `events_appended` через outbox. 02 ждал update `submit_input` до записи в журнал и старт через UpdateWithStart. В итоге сообщение из чата не начинало ход.

**Решение.**
1. 01 пишет входное событие в журнал и строку outbox в одной транзакции, отвечает `202`. Сразу после commit 01 сам пробует отправить сообщение в Temporal. Outbox остаётся страховкой.
2. `user.message`, `user.define_outcome`, `user.interrupt` идут signal `inputs_appended` через Signal-With-Start. Payload: `{inputs: [{event_id, seq, type, actor_id, priority}]}`. Workflow отбрасывает входы с `seq <= LastSeenSeq`, поэтому дубли безопасны.
3. `user.tool_result`, `user.tool_confirmation` и `terminate` идут update (`submit_tool_result`, `submit_tool_confirmation`, `terminate`) со стадией Accepted. Update ID равен `event_id`. Повтор с тем же Update ID присоединяется к тому же update.
4. Проверку «можно ли принять событие» делает 01 по проекции в Postgres (`sessions.status` и `session_waits`, D2). Валидатор update в 02 страхует гонку. Если валидатор отказал, 01 пишет `event.rejected {event_id, code}`.
5. Валидатор update только читает состояние workflow. Поэтому всё, что ему нужно (`actor_id`, `decision`, `approval_id`), 01 кладёт в payload. Правило «в Temporal только ссылки» уточнено: id, enum и короткие поля разрешены, тексты и результаты нет.
6. 10 передаёт стартовые `user.message` и `user.define_outcome` в `initial_events` одного `POST /v1/sessions`.

**Почему.** design.md уже говорит «журнал, потом signal». Signal-With-Start атомарен, Update-With-Start нет (документация Temporal, раздел Update-With-Start). Журнал остаётся единственным источником правды, и событие не теряется при недоступном Temporal.

**Изменено.** 01 разделы 0, 2.4, 3.5. 02 разделы 0, 3.1, 3.2, 3.3, 3.4, 9. 10 раздел 3.2.

### D2. Реестр ожиданий `session_waits` живёт в 01

**Контекст.** Сценарии 03, 04. Воркер пишет `agent.custom_tool_use`, а `pending_tool_use_id` ставит 02 только после конца хода. Быстрый ответ клиента получал `409 tool_use_mismatch`. 01 хранил одно ожидание, 02 список.

**Решение.**
1. Таблица `session_waits` переезжает в базу 01: `(session_id, wait_id)`, `kind` (`custom_tool`, `confirmation`), `tool_use_id`, `approval_id`, `turn_id`, `turn_actors`, `responder`, `approvers[]`, `expires_at`, `state` (`open`, `answered`, `timed_out`, `cancelled`), `answered_by`, `answered_at`.
2. Ожидание открывается в той же транзакции, что и событие, которое его создаёт: `agent.custom_tool_use` или `tool.confirmation_required`. Эти события пишет Hub (D16, D17).
3. 01 принимает `user.tool_result` и `user.tool_confirmation`, если есть открытое ожидание с этим id. Статус сессии не важен: может быть ещё `running`.
4. 02 держит буфер ранних ответов: update принят до того, как `RunTurn` вернул `waits`, значит ответ сохраняется и применяется сразу, как ожидание появится в состоянии.
5. Закрывает ожидание событие: `user.tool_result`, `user.tool_confirmation` или синтетический `tool.result` от 02 с `reason: timeout | cancelled`.
6. Поле `sessions.pending_tool_use_id` убрано. `409 tool_use_mismatch` несёт `details.reason`: `not_found`, `answered`, `timed_out`, `cancelled`.
7. 02 больше не пишет таблицу `session_waits`. Activity `RecordWait` убрана. Таблица `session_turns` остаётся у 02.

**Почему.** Ожидание создаётся там же, где пишется событие. Гонки нет по построению, отдельной синхронизации не нужно.

**Изменено.** 01 разделы 0, 2.1, 3.1, 3.2. 02 разделы 0, 2.4. 03 раздел 0.

### D3. Сообщение во время `waiting_tool` встаёт в очередь

**Контекст.** Сценарии 04, 05. `409 session_waiting_tool` отбивал даже владельца. Каналу 09 приходилось держать сообщение у себя и следить за статусом многих сессий. Прямой клиент API терял сообщение.

**Решение.** В `waiting_tool` `user.message` принимается: `202 {queued_behind_tool: true}`, событие в журнале, вход в `PendingInputs`. Ход начинается, когда ожидание закрыто ответом или по таймауту. Сообщение владельца с `priority: owner` или `user.interrupt` закрывают открытые ожидания синтетическим `tool.result {reason: cancelled}` и сразу начинают ход. `user.define_outcome` в `waiting_tool` тоже встаёт в очередь. Код `409 session_waiting_tool` удалён из API.

**Почему.** Сообщение не теряется ни у одного клиента. 09 не нужен свой буфер треда. Владелец не заблокирован. Это меняет одну строку design.md (раздел 3), см. «Вопросы владельцу», В1.

**Изменено.** design.md раздел 3. 01 разделы 0, 3.1, 3.2. 02 разделы 0, 3.2, 5.3. 09 разделы 0, 5.3.

### D4. Один контракт `RunTurn`

**Контекст.** Все сценарии. У 02 был `TurnInput{FromSeq, ToSeq, NewEventIDs}` и `StopReason custom_tool/confirmation`, у 03 `RunTurnInput{turn_id, trigger_seqs, mode}` и `waiting_tool/waiting_human`. Не было общего `turn_id`, разные таймауты.

**Решение.** Один IDL в пакете контрактов (Приложение A1). Владелец схемы 02 (вызывающий), реализует 03. Главное:
- `turn_id = "<session_id>:<turn_no>"`, его считает workflow детерминированно.
- `waits` массивом, каждое ожидание с `tool_use_id`, `approval_id`, `approvers`, `expires_at`.
- Общий список `stop_reason`, включая `waiting_subagents`.
- Таймаут хода из `config.limits.turn_timeout_s`, по умолчанию и максимум 1800 с. `StartToClose = turn_timeout_s + 60 с`.
- Поле `contract_version`. Поля только добавляются, незнакомые игнорируются. Ломающее изменение означает новый тип activity `RunTurnV2`.
- `session.status` пишет только 02. 03 возвращает причину в `TurnResult.limit_reason` или `error`.

**Почему.** Workflow и воркеры выкатываются отдельно. Без общего типа они расходятся при первой правке.

**Изменено.** 02 разделы 0, 4. 03 разделы 0, 2.3, 3.1.

### D5. Единые имена

**Контекст.** Все сценарии. Одна сущность называлась по-разному: `tool_call_id` и `tool_use_id`; `ConfirmationID`, `confirmation_id`, `approval_id`; `allow` и `approve`; `data.text` и `data.content[]`; `tenant_id`, `tid: hr`, `namespace`.

**Решение.** Словарь в Приложении A3. Коротко: `tool_use_id`, `approval_id`, решение `approve | deny`, `namespace_id` (значение `ns_<ULID>`), `config_id`, `user.message.data.content[]` плюс `data.author` и `data.channel`, id сессии с префиксом `ses_`.

**Изменено.** Раздел 0 каждой спеки. 01: префикс `sess_` заменён на `ses_`.

### D6. Внутренний API журнала по контракту 01

**Контекст.** Сценарии 02, 03, 09. 03 звал `turn-lease`, `events:batch`, `X-Turn-Attempt`, `client_event_id`, ждал `409 stale_attempt`. 01 даёт `turns/claim`, `events:append`, `writer_epoch`, `dedupe_key`, `409 stale_writer`. Запоздавший claim первой попытки отбирал запись у второй.

**Решение.**
1. Берём контракт 01. Таблица `turn_leases` и путь `events:batch` убраны из 03.
2. `turns/claim {turn_id, attempt, trigger_seqs}`: 01 принимает claim, только если `(turn_no, attempt)` больше текущего. Иначе `409 stale_writer`. 01 сам сверяет `turn_actors` по событиям `trigger_seqs` и хранит их в claim (D30).
3. Ответ claim несёт `writer_epoch` и `writer_token`: короткий токен 01 на `(session_id, turn_id, writer_epoch)`. Отдельный workload token от 08 не нужен.
4. `dedupe_key` без номера попытки. Для событий хода: `<turn_id>:<harness_tool_use_id>:<kind>` или `<turn_id>:msg:<n>`.
5. Добавлены `PUT/GET /internal/v1/sessions/{id}/harness-binding`. Таблица `harness_bindings` в базе 01, с полем `harness_version`.
6. Дельты текста несут `writer_epoch`, `turn_id`, `message_id`, `offset` и фенсятся так же. При claim 01 шлёт эфемерный кадр `agent.message.reset {turn_id, attempt}`. Итог всегда `agent.message` с `seq`.
7. Системные писатели (02, 05, 06) пишут через тот же `events:append` с `writer: system`, без epoch, с обязательным `dedupe_key`.
8. Добавлен `GET /internal/v1/sessions/{id}/waits?turn_id=&state=open` (D2).

**Почему.** Один механизм фенсинга вместо двух. Монотонность попытки убирает гонку запоздавшего claim.

**Изменено.** 01 разделы 0, 3.4. 03 разделы 0, 2.1, 2.2, 3.3. 04, 05, 06 разделы 0.

### D7. Ключ идемпотентности вызова тула считает Hub

**Контекст.** Сценарии 02, 03, 05. Ключ был определён трижды: `tool_use_id` (02), заголовок `Idempotency-Key` (03), `(sid, turn, tool, args_hash, n)` (05). ACP задаёт заголовки MCP один раз в `session/new` (документация ACP, Session Setup), поэтому harness не может ставить ключ на каждый вызов.

**Решение.** Алгоритм один и живёт в 05:
- `key = sha256(session_id, turn_id, exposed_name, args_hash, k)`, где `k` это номер вызова с тем же `(exposed_name, args_hash)` внутри текущей попытки хода. Попытку Hub берёт из claim `attempt` токена.
- Новая попытка начинает счёт `k` заново. Поэтому первый такой же вызов во второй попытке получает тот же ключ, что в первой, и Hub отдаёт сохранённый результат без вызова upstream.
- Вызов, одобренный человеком, исполняется с ключом `approval:<approval_id>`.
- Если тул объявил поддержку идемпотентности, Hub передаёт ключ upstream в заголовке `Idempotency-Key`.
- Если harness передаёт свой id вызова в `_meta` запроса `tools/call` (MCP разрешает `_meta` в параметрах запроса), Hub пишет его в трассу. На ключ это не влияет. Передаёт ли его `claude-agent-acp`, не проверено.
- 02 и 03 ссылаются на этот алгоритм. Заголовок `Idempotency-Key` от 03 убран.

**Почему.** Ключ можно посчитать только там, где видны все вызовы. Повтор `read` во второй попытке не уходит во внешнюю систему. Тест: счётчик вызовов upstream равен 1 после убийства воркера.

**Изменено.** 05 разделы 0, 6. 03 разделы 0, 5.3. 02 раздел 0. 09 раздел 0.

### D8. Восстановление хода после падения воркера

**Контекст.** Сценарии 02, 03, 04, 09. Новый воркер закрывал открытые вызовы `tool.result unknown`, хотя Hub уже выполнил `read` или клиент уже работал над custom tool. Процесс harness после падения то убивался, то переподключался.

**Решение.**
1. Новая попытка всегда убивает старый процесс harness: `Attach {replace: true}` в `sandboxd`.
2. Открытые вызовы новая попытка сверяет с Hub: `GET /internal/v1/tool-calls?session_id=&turn_id=`. Завершённые получают `tool.result` с настоящим результатом. `unknown` только если Hub вызова не видел.
3. Custom tool и подтверждение не закрываются. Их ведут ожидания в 01 (D2).
4. Для упавшей попытки по умолчанию rehydration из журнала. `session/load` только если `state_seq >= last_seq`, у harness есть `agentCapabilities.loadSession` и `harness_version` совпадает с образом.
5. Prompt продолжения перечисляет уже доставленные `send_user` из журнала, чтобы модель не отправила ответ второй раз.
6. Токены Hub старой попытки отзываются (D9).

**Почему.** Журнал и Hub уже знают, что сделано. Модель не повторяет выполненное, а процесс-зомби не пишет дальше.

**Изменено.** 03 разделы 0, 5.3. 04 раздел 0. 05 раздел 0.

### D9. Токен сессии Hub

**Контекст.** Сценарии 02, 05, 07, 10. TTL был 15 мин, 1 ч и 2 ч. Тело запроса токена несло `tenant_id` и `run_as` от воркера. Шлюз моделей и прокси ждали JWT от 08, которого никто не выпускал. Токен первой попытки жил после повтора.

**Решение.**
- Тело `POST /internal/v1/session-tokens`: только `{session_id, turn_id, attempt}`. `tid`, `act`, `cfg`, `test`, `turn_actors` Hub берёт из `GET /internal/v1/sessions/{id}` и claim хода в 01. Если `turn_id` и `attempt` не совпадают с текущим claim, `409`.
- Claims: `iss`, `aud: ["hub", "models"]`, `sub`, `tid` (`ns_<ULID>`), `sid`, `turn`, `att`, `cfg`, `act`, `turn_actors`, `test`, `jti`, `iat`, `exp`.
- TTL задаёт Hub: `turn_timeout_s + 300 с`, не больше 35 мин. Поле `ttl_s` от вызывающего убрано. ACP не умеет менять заголовки у живой сессии, поэтому токен живёт весь ход, а следующий ход получает новый.
- Выпуск токена с большим `att` отзывает токены того же `(sid, turn)` с меньшим.
- Один токен на ход годится и для MCP Hub, и для шлюза моделей (06). 06 проверяет его по JWKS Hub и списку отзывов Hub.
- Egress-прокси этот токен не принимает. У него свой egress-токен (D26).
- В режиме `colocated` токен лежит в файле `/run/sbx/token` (emptyDir в памяти). В env процесса его нет.
- Отзыв: при `terminated` (01), при блокировке человека (08), при отзыве версии (07, D22).

**Почему.** Один выпускающий, один срок, ничего от воркера не берётся на веру.

**Изменено.** 05 разделы 0, 3.3. 03, 04, 06, 08 разделы 0.

### D10. `config_id` и поля конфига агента

**Контекст.** Сценарии 01, 06, 07, 08. Тестовая сессия на черновике не доходила до рантайма: поле называлось `test_snapshot_id` и `draft_snapshot_id`, 02 и Hub знали только номер версии. Hub ждал полей, которых нет в `AgentConfig`. У 02 номер версии `int`, у 03 и 05 строковый id.

**Решение.**
1. Общий `config_id`: `ver_...` для версии или `tst_...` для тестового снимка. 07 отдаёт оба через `GET /internal/v1/agent-configs/{config_id}`. Ответ неизменяем.
2. `sessions` в 01 хранит `agent_id`, `agent_version` (`null` у теста) и `config_id`. `TurnInput`, claim `cfg` токена Hub, `session_principals` в 08 и `SessionInput` в 02 используют `config_id`.
3. В схему `agent/v1` добавлены поля: `tool_exposure`, `pinned_tools`, `confirmations` (по типу и по тулу, только ужесточают), `max_data_class`, `credentials`, `custom_tools`, `subagents[].mode`, `subagents[].await_default`, `outcomes.grader_model`, `limits.turn_timeout_s`, `limits.max_cost_usd_per_session`, `limits.max_cost_usd_per_tree`, `version_upgrade`.
4. Префикс `hub:` у toolsets есть только в YAML. Внутри `toolsets: [{name, revision}]`.
5. 02 держит в состоянии `config_id` и `config_schema`. Если новый код требует поле, которого нет в состоянии старой сессии, он под `GetVersion` вызывает `LoadSessionConfig` ещё раз. Конфиг неизменяем, повтор безопасен.

**Почему.** Один id закрывает и версию, и тест. Рантайму не нужно знать, откуда конфиг.

**Изменено.** 07 разделы 0, 2, 3.6. 01, 02, 03, 05, 06, 08 разделы 0.

### D11. Права агента берутся из toolsets его конфига

**Контекст.** Сценарии 01, 08. 08 хранил гранты `agent:agt_` на личность агента и переписывал их при публикации. В тестовой сессии грантов не было, и каждый тул получал отказ. При живых сессиях двух версий набор грантов был один.

**Решение.** Права агента это toolsets (закреплённые ревизии, D12) его конфига: версии или тестового снимка. Hub передаёт их на вход `tool-scope`. Гранты `tool_grants` с субъектом `agent:*` убраны. Личность агента (`agt_` в `principals`) остаётся для аудита и `actor`. Её создаёт 07 через `POST /internal/iam/agent-principals`, идемпотентно по `agent_id`, при создании агента.

**Почему.** Неизменяемая версия уже несёт права. Вторая копия в другой базе без outbox расходится при откате и тестах.

**Изменено.** 08 разделы 0, 2.2, 2.4, 3.2. 05, 07 разделы 0.

### D12. Ревизии toolset закрепляются в версии

**Контекст.** Сценарий 01. Владелец toolset мог добавить `write`-тул после согласования, и опубликованный агент получал его молча.

**Решение.** В Hub таблица `toolset_revisions` (только вставка): `toolset_id`, `revision`, список `tool_id` с `definition_hash`. `POST /internal/v1/toolsets:resolve {namespace_id, names[]}` возвращает текущие ревизии. 07 вызывает его при публикации и при создании тестового снимка. `allowed()` берёт состав закреплённой ревизии. Изменение описания тула по-прежнему переводит тул в `needs_review`.

**Изменено.** 05 разделы 0, 2. 07 раздел 0.

### D13. Права автора проверяются одним путём

**Контекст.** Сценарий 01. 07 звал `access:check` у Hub (его нет), у 05 был `agent-configs/validate` с `author_lacks_tool`, у 08 `grants:check-subset` с `author_effect_limit_read`, пользователь видел `author_lacks_access`.

**Решение.** 07 вызывает только `POST /internal/v1/agent-configs/validate` в 05. Hub разворачивает toolsets в тулы и зовёт 08 `tool-scope` с `subject = author`. Код для пользователя один: `author_lacks_access`. Метод `grants:check-subset` в 08 удалён. Словарь кодов ошибок в Приложении A4.

**Изменено.** 05, 07, 08 разделы 0.

### D14. Hub зовёт у IAM только `tool-scope`. Один список ролей

**Контекст.** Сценарии 01, 10. Hub звал несуществующий `check-batch` с правами `tool:<slug>:<kind>`. Роли назывались `ns_admin`, `platform_admin`, `hub_admin`, `tool_owner`, `channel_admin`, а в 08 есть только `owner`, `admin`, `agent_builder`, `viewer`, `platform_operator`. Окна работы при недоступном IAM расходились.

**Решение.**
- Hub зовёт `tool-scope` при выпуске токена и при промахе кеша. Кеш по `(session_id, policy_version)`, срок из `ttl_s` ответа. Свои числа Hub не держит. Правило при недоступном IAM одно, в 08: до `ttl_s` работаем по кешу, потом ещё до 120 с только `read`.
- Список ролей и прав ведёт только 08. Новые права: `hub.servers.manage`, `hub.toolsets.manage`, `hub.rules.manage`, `tools.confirm`, `session.tool_result`, `channels.manage`, `memory.proposals.decide`, `memory.read_personal`, `deployments.run_as`.
- Замена имён: `ns_admin` → `admin`, `platform_admin` → `platform_operator`, `hub_admin` → `admin` (права `hub.*.manage`), `channel_admin` → право `channels.manage`. `tool_owner` это не роль, а `owner_id` сервера в Hub.
- `GET /v1/hub/catalog` берёт пользователя из токена. Параметр `for_user` только для `admin`.

**Изменено.** 05, 07, 08, 09, 10 разделы 0.

### D15. Согласование публикации хранится в 08

**Контекст.** Сценарий 01. В 07 были `publish_requests` (`202`, утверждение сразу создаёт версию, роль `ns_admin`), в 08 `approvals` (`422 approval_required`, автор публикует повторно, роль `admin`). Коды `self_approval` 409 и 403. Событие о заявке никто не слушал. Step-up не было в 08.

**Решение.**
1. Решение хранит 08: `approvals` с `kind = agent_publish`. Снимок конфига хранит 07 в `publish_snapshots` (бывшие `publish_requests`, без статуса решения).
2. `POST /v1/agents/{id}/publish` при риске отвечает `202 {approval_id}`. 07 вызывает `POST /internal/iam/approvals` с `config_hash`.
3. По событию `approval.decided` (approved) 07 сам создаёт версию из замороженного `resolved_config`. Перед этим он сверяет `config_hash` и заново проверяет права автора. Если права пропали, версия не создаётся, автор получает `agent.publish_failed`.
4. Новая заявка того же агента переводит старую `pending` в `superseded` (делает 08). Самому утвердить нельзя: `403 self_approval` везде.
5. Утверждение требует свежего входа: `GET /auth/login?max_age=600`, в principal token есть `auth_time`. Проверяет 08 в `:approve`.
6. Админ видит очередь заявок в консоли (`GET /v1/namespaces/{ns}/approvals`). 08 шлёт событие `approval.requested`. Уведомление в чат через 09 позже, по желанию.
7. Подтверждения вызовов тулов остаются в Hub (D16). Общего сервиса согласований в v1 нет: у вызова тула свой жизненный цикл с исполнением.

**Изменено.** 07 разделы 0, 2, 3.2, 5. 08 разделы 0, 3.1, 3.5, 3.6.

### D16. Цикл подтверждения `write`-вызова

**Контекст.** Сценарии 01, 03, 05, 08. Три способа исполнить одобренный вызов. Путь «ожидание дошло до workflow» не описан. Нет права одобрять вызов. Нет отмены. Разные таймауты. Нет статуса `executing`. Одобренный через 5 часов вызов шёл по старым правам.

**Решение.**
1. Hub решает `confirmation = ask`. Он создаёт `approval` (`ap_...`) с замороженными аргументами, `tool_use_id` (это id вызова Hub `tc_...`), `approvers[]`, `expires_at` (72 ч по умолчанию).
2. Согласующие считаются при создании. По умолчанию: `effective_subject` сессии, владелец агента и все, у кого есть `tools.confirm` на этот тул в 08. У сессии deployment вместо SA: владелец deployment.
3. Hub пишет в журнал через `events:append` (`writer: system`) событие `tool.confirmation_required {approval_id, tool_use_id, tool, kind, irreversible, arguments_preview, approvers, expires_at, test}` с ключом `hub:<approval_id>:required`. 01 открывает ожидание в той же транзакции (D2). Signal от Runtime убран.
4. Harness получает ответ «ждёт подтверждения, не повторяй». Модель может доделать другое и закончить ход. В конце хода воркер берёт открытые ожидания хода у 01 и возвращает `stop_reason = waiting_human` и `waits[]`.
5. Человек шлёт `user.tool_confirmation {approval_id, tool_use_id, decision: approve | deny, reason?}`. 01 проверяет открытое ожидание и что автор в `approvers` или имеет `tools.confirm`. Затем update `submit_tool_confirmation {event_id, approval_id, decision, actor_id}`.
6. Workflow вызывает activity `DecideApproval` (Hub `decide`). При `approve` вызывает activity `ExecuteApprovedCall(approval_id)` на очереди `session-io`: `StartToClose = call_timeout_ms + 30 с`, ретраи, `409` и `failed` не ретраятся.
7. Hub в `execute` заново считает `allowed()`, проверяет отзыв сессии, `terminated`, OAuth-грант. Переход `approved → executing` атомарный. Повтор при `executing` ждёт или отвечает `in_progress`. Падение в `executing` даёт `unknown`: upstream второй раз не зовётся. Отказ при перепроверке: `failed` с `deny_code`.
8. Workflow пишет `tool.result {tool_use_id, approval_id, status, content | file_ref}` с ключом `approval:<id>:result` и добавляет его в `trigger_seqs` нового хода (`mode: resume_after_wait`). 03 подаёт его модели текстом по шаблону `[tool_result tool_use_id=...]`. Harness вызов не повторяет.
9. Отмена: `POST /internal/v1/approvals/{id}/cancel`, идемпотентно, `409` при `executing` или `executed`. Срок ставит Hub, таймер workflow берётся из `expires_at`. Канал сам статус согласования не меняет: по `tool.result {reason: timeout}` он только правит карточку.
10. В тестовой сессии (`test` в токене) `write` и `irreversible` не ниже `ask`. Карточка пишет, что запись реальная.
11. Builtin-тулы harness (`session/request_permission`) идут тем же событием с `approval_id = bp_...`. Исполнять их нечего: после одобрения harness в новом ходе спросит снова, и воркер ответит сам по отпечатку (как в 03).

**Почему.** Замороженные аргументы и исполнение ровно один раз есть только в Hub. Activity исполнения в workflow делает ожидание длиной в часы дешёвым и надёжным.

**Изменено.** 05 разделы 0, 2, 3.3, 3.5, 5.2. 02 разделы 0, 3.2, 3.7. 03 разделы 0, 5.2. 01, 08, 09 разделы 0.

### D17. Custom tools

**Контекст.** Сценарий 04. Custom tool не был определён: 03 говорил, что Hub отдаёт его из сервера `custom`, 05 говорил, что Hub их не трогает, в `AgentConfig` поля не было. Любой с `session.write` мог ответить за приложение.

**Решение.**
1. `AgentConfig.custom_tools[]`: `{name, description, input_schema, timeout_s, responder, data_class}`. `responder`: `client` (кто создал сессию) или principal.
2. Hub отдаёт их встроенным сервером `custom` (`custom__<name>`). На `tools/call` Hub сразу отвечает `{custom_pending: true, tool_use_id}` и пишет в журнал `agent.custom_tool_use {tool_use_id, name, input, responder, expires_at}` с ключом идемпотентности Hub. 01 открывает ожидание. Повтор попытки хода не создаёт второго события: Hub вернёт сохранённый ответ.
3. В конце хода воркер возвращает `waiting_tool` и `waits`.
4. Ответить может только `responder` или тот, у кого есть право `session.tool_result` (08). 01 проверяет это и кладёт `actor_id` в update `submit_tool_result`.
5. Результат подаётся модели как данные (`untrusted`), его `data_class` поднимает класс данных сессии (06).
6. Таймаут по `timeout_s`, по умолчанию 24 ч. Поздний ответ получает `409 tool_use_mismatch` с `reason: timed_out`.

**Изменено.** 07, 05, 03, 01, 02, 08 разделы 0.

### D18. Сабагенты

**Контекст.** Сценарии 04, 06. Пути `spawn_subagent` не было: 03 звал тул Hub, которого нет, 02 ждал update неизвестно от кого. Сессия ребёнка не существовала в 01, 08, 10. Итог ребёнка лежал в чужом журнале. Лимит 8 детей давал отказ девятому.

**Решение.**
1. Встроенный сервер Hub `subagents`: `subagents__spawn {agent, task, await}`, `subagents__cancel {child_session_id}`, `subagents__message {child_session_id, text}`.
2. Hub вызывает `POST /internal/v1/sessions/{id}/subagents {tool_use_id, agent, task, await}` в 01. 01 создаёт сессию ребёнка как обычную (D19) с `parent_session_id`, `root_session_id`, `depth`, `on_behalf_of` родителя. Привязки памяти ребёнка не шире родителя (D32). 01 пишет задачу в журнал ребёнка как `user.message` от `actor {kind: agent}` и шлёт update `spawn_subagent` родителю. Ответ тула `{child_session_id, status: started | queued}`.
3. Workflow родителя запускает child workflow с этим id или ставит в очередь `PendingChildren`, если слотов нет. Лимиты: активных 8, ждущих (`waiting_*`) 32 отдельно, в очереди 50, всего на корень 100.
4. Итог ребёнка 02 ребёнка пишет в журнал родителя: `subagent.finished {child_session_id, status, summary (до 16 KiB), file_refs[]}`. Когда ребёнок в `waiting_tool`, в журнал родителя идёт `subagent.waiting {child_session_id, tool_use_id, name}`.
5. `subagent.started` для `mode: child` пишет только 01. Воркер пишет `subagent.*` только для `mode: inline`.
6. `AgentConfig.subagents[]: {name, ref, description, mode: child | inline, await_default}`. Валидатор 07 запрещает `await: true`, если у ребёнка есть `custom_tools`.
7. `await: true`: ход родителя кончается `waiting_subagents`, статус `running`, таймаут ожидания 2 ч.
8. `subagents__cancel` и `subagents__message` через 01 дают `user.interrupt` и `user.message` в сессию ребёнка.

**Почему.** У ребёнка есть всё, что есть у обычной сессии: журнал, права, привязки, поток. Клиент видит ребёнка через родителя.

**Изменено.** 01, 02, 03, 05, 07, 10 разделы 0.

### D19. Создание сессии в 01

**Контекст.** Сценарии 01, 05, 06, 10. 08 и 10 ждали вызовов, которых не было в 01. `on_behalf_of` был строкой в 01 и объектом в 08. 07 не мог создать тестовую сессию от имени человека.

**Решение.** Порядок в `POST /v1/sessions`:
1. Разрешить агента: `agent` ссылкой (`hr-helper@live`, `agt_...@3`, `platform/agent-builder@live`) через 07 `agent-refs:resolve`, или `config_id` (только для 07, тестовые снимки).
2. Версия среды: из конфига, через 04 `GetEnvironment`. Задать `environment_id` в обход конфига нельзя.
3. 08 `session-principals` → `effective_subject`.
4. 10 `ResolveSessionContext` → привязки памяти и скиллов.
5. Одна транзакция: `sessions`, `initial_events`, outbox `start`.

Отказы: `403 permission_denied`, `409 deployment_owner_disabled`, `422 session_context_failed`.

`on_behalf_of` это объект `{kind: user | channel | deployment | service_account, id, external_user_id?}`. Задать его может сервисный токен с `act_as` (09, 10). 07 создаёт тестовую сессию principal-токеном самого человека (D36). Новые поля `sessions`: `config_id`, `environment_version`, `owner_actor_id`, `effective_subject`, `parent_session_id`, `root_session_id`, `depth`, `resources`, `limits`.

Для `on_behalf_of.kind = deployment` входы пишутся с `actor {kind: system, id: deployment:<id>}`, `data.author` не нужен.

**Изменено.** 01 разделы 0, 2.1, 3.2, 4. 08, 10 разделы 0.

### D20. Единые поля `metadata`

**Решение.** `metadata.channel = {binding_id, thread_id, thread_key}`. `metadata.deployment = {deployment_id, run_id, output}`. `metadata.test = true`. Родитель хранится в столбце `parent_session_id`, не в metadata. 10 привязывает store канала по `metadata.channel.binding_id`.

**Изменено.** 01, 05, 09, 10 разделы 0.

### D21. Пустая версия значит `@live`

**Контекст.** Сценарий 08. В 07 `null` значит `live_version`, в 01, 09, 10 «последняя опубликованная». После отката новые сессии каналов шли на плохую версию.

**Решение.** Везде `null` = `@live`. 01 зовёт только `agent-refs:resolve`. `ResolveLatestVersion` и `GetAgentVersion(agent_id, version)` убраны из 01 и 02. 09 и 10 хранят ссылку строкой: `agent@live` или `agent@N`.

**Изменено.** 01, 02, 09, 10 разделы 0.

### D22. Отзыв плохой версии агента

**Контекст.** Сценарий 08. Сессии на плохой версии жили вечно, её подтверждения можно было одобрить.

**Решение.**
1. 07: `POST /v1/agents/{id}/versions/{n}:recall {mode: terminate}` и событие `agent.version_recalled {agent_id, version, config_id}`. Обычно вместе с `POST /live` на хорошую версию.
2. 01 переводит в `terminated` все живые сессии с этим `config_id`.
3. 05 отзывает токены по `cfg` и отменяет `pending` approvals этой версии.
4. 02 при `terminate` закрывает ожидания синтетическим `tool.result {reason: cancelled}`.
5. 09 на `409 session_terminated` открывает новый `generation` треда с тем же сообщением.
6. Политика `version_upgrade` агента: `never` (по умолчанию для API и deployments) или `next_session` (по умолчанию для каналов). При `next_session` 09 по `agent.live_changed` начинает новый `generation` треда на следующем сообщении. Перевод живой сессии между ходами (`next_turn`) отложен.
7. Карточка подтверждения показывает версию агента.
8. Для экрана версий: в 01 индекс `(namespace_id, agent_id, agent_version) where status <> 'terminated'` и фильтр `GET /v1/sessions?agent_version=`. В 02 search attribute `ConfigId`.

**Изменено.** 07, 01, 02, 05, 09 разделы 0. См. В2.

### D23. Выкатка кода workflow

**Контекст.** Сценарий 08. «Откатить BuildID» ломает `AutoUpgrade` workflow, которые уже записали команды новой ветки. По документации Temporal такие workflow переходят на Current Version и должны быть replay-safe через патчи.

**Решение.**
1. Выкатка в два шага. Сборка N+1 содержит `GetVersion` и обе ветки, новая выключена флагом конфигурации. Откат значит выключить флаг. Current Version откатывается только на сборку, которая знает все change-id.
2. CI гоняет replay историй N+1 на коде N и выборку историй прода.
3. Выкатка: `temporal worker deployment set-ramping-version --percentage`, затем `set-current-version`.
4. Таймер обслуживания: сессия в `idle` без ожиданий раз в 7 дней делает continue-as-new. Так старые патчи можно удалять.
5. Search attribute `WfCodeVersion` для поиска старых run.

**Изменено.** 02 разделы 0, 5.5.

### D24. Песочница в workflow

**Контекст.** Сценарии 03, 06, 07, 09. 04 будил песочницу через update `ensure_sandbox`, которого не было в 02. Сигнатуры и очереди `Hibernate`, `Destroy` расходились. Состояние в 02 было беднее машины 04. Сообщение во время `Hibernate` не имело правила.

**Решение.**
1. В 02 update `ensure_sandbox {turn_id}` → `SandboxHandle`. Валидатор: сессия не `terminated`. Одновременно идёт один `Provision` или `Wake`, остальные ждут результата. Update отменяет таймеры сна и удаления.
2. В режиме `colocated` (D25) 02 сам вызывает `ensure_sandbox` перед `RunTurn` и кладёт handle в `TurnInput.sandbox`. В `remote_tools` воркер зовёт update лениво.
3. Activities с сигнатурами 04 на одной очереди `sandbox-ops`: `Provision`, `Wake`, `Hibernate {sandbox_id, generation}`, `Destroy {sandbox_id, keep_snapshot}`. Идемпотентность по `(sandbox_id, generation)`.
4. `SandboxState` в 02: `SandboxID`, `Generation`, `SnapshotRef`, `HibernateAt`, `DestroyAt`. Правду о состоянии 02 берёт из результата activity. `Hibernate` на `failed` возвращает `already_lost` без ошибки.
5. `Hibernate` отменяемый. Pod удаляется только после подтверждённого снапшота. Новый вход просит отмену, а `Wake` ждёт состояния `hibernated` или `ready`.
6. При `busy_execs > 0` `Hibernate` возвращает `busy`, 02 переносит таймер. Жёсткий потолок 2 ч.
7. Оба срока (`idle_hibernate_s`, `hibernated_ttl_s`) 02 читает в `LoadSessionConfig` из версии Environment.
8. `ensure_sandbox` после `Destroy`: пока жив `keep_snapshot`, `Provision` из него. Иначе пустая папка и `sandbox.state {data_loss: true}`.
9. Событие `sandbox.state` пишет 02 по результату activity, с детерминированным id.
10. Среда: `HOME=/workspace/.home`, `PYTHONUSERBASE`, `npm_config_prefix` и кеши внутри `/workspace` (кеши не в снапшоте). Системные пакеты только через `Environment.packages`, агент об этом знает из инструкций среды.

**Изменено.** 02 разделы 0, 3.2, 3.7, 4, 5.3. 04 разделы 0, 3.1. 03 раздел 0.

### D25. Harness со встроенными тулами работает в песочнице

**Контекст.** Сценарии 02, 09, 10. 03 выбрал harness в песочнице (`fs/terminal = false`), 04 по умолчанию `remote_tools` (harness в воркере). Не проверено, что `claude-agent-acp` отдаёт все встроенные тулы через ACP `fs/*` и `terminal/*`. Если нет, Bash исполнится в общем многотенантном воркере рядом с доступом к журналам всех тенантов.

**Решение.** `acp:claude` и `acp:codex` всегда `colocated`, пока приёмочный тест 04 (раздел 8, п. 6) не докажет `remote_tools`. В воркере работают только `simple` и адаптеры без shell. `environment: none` у такого harness значит платформенную среду `platform/min` без доменов в allowlist. Валидатор 07 (уровень 4) это проверяет. Тёплый пул смягчает задержку старта. Транскрипт harness в `colocated` лежит в `/workspace/.harness` и попадает в снапшот.

**Почему.** Ошибка в выборе стоит утечки между тенантами. Задержка старта лечится пулом.

**Изменено.** design.md разделы 3, 4. 03, 04, 07 разделы 0. См. В3.

### D26. Один контракт egress и одна сеть песочницы

**Контекст.** Сценарии 07, 09, 10. Было два контракта регистрации (04 `PUT /internal/egress/policies/{sandbox_id}`, 06 `POST .../egress-bundle`). Чем песочница входит в прокси, не договорились. Placeholder и CA не доходили до процессов. После `Wake` новый IP. Четыре разных правила сети. DNS наружу открыт.

**Решение.**
1. Один вызов: 06 `POST /internal/v1/sessions/{id}/egress-bundle {sandbox_id, generation, source_ip}`. `credential_refs` 06 берёт из конфига (D10, поле `credentials`). Вызывает 04 в `Provision` и в каждом `Wake`. `DELETE` того же ресурса при `Destroy` и при `terminated` (D27).
2. Egress-токен непрозрачный, его выпускает 06 на `(session_id, sandbox_id, generation)`. Прокси проверяет токен и source IP. `Wake` выпускает новый токен и отзывает старый. При `Hibernate` токен не отзывается.
3. `Bind` в `sandboxd` получает `session_env` и `ca_bundle_pem`. `sandboxd` пишет CA в `/run/sbx/ca.pem` (emptyDir в памяти) и подмешивает `session_env` во все `Exec` и `Attach`. Токены держит `sandboxd`, в вывод `Exec` они не попадают: `sandboxd` маскирует известные значения до отдачи.
4. Адреса: `egress-proxy.platform-system.svc:3128`, `model-gateway.platform-system.svc:443`, `hub.platform-system.svc:443`. Платформенные сервисы живут в namespace Kubernetes `platform-system`.
5. NetworkPolicy песочницы одна (владелец 04): выход на прокси `:3128`, Hub `:443`, шлюз моделей `:443`. DNS из Pod закрыт. Имена резолвит прокси. NetworkPolicy работает только на уровне IP и портов (документация Kubernetes), поэтому домены проверяет прокси. Клиенты с `HTTPS_PROXY` передают имя в `CONNECT` и сами его не резолвят (для каждого рантайма проверяет сквозной тест 06 №10).
6. `internal_hosts` не может указывать на адреса платформы.
7. Платформенные сервисы (Hub к upstream, 09 к мессенджерам) берут сервисный egress-bundle на `(namespace_id, server_id)` с `vph_`. Схема `{{vault:ref}}` в Hub заменена на `vph_`. `POST /v1/hub/servers` отвергает `secret_ref` чужого namespace (`404`).
8. stdio-серверы Hub запускает драйвер 04 в профиле `service` в namespace тенанта. `network_allowlist` проверяется в 06 как `internal_hosts` этого namespace.

**Изменено.** 04 разделы 0, 3.6, 4. 06 разделы 0, 3.2. 05 раздел 0. design.md раздел 9.

### D27. Подмена секретов и уведомления `system.notice`

**Контекст.** Сценарии 07, 10. В `AgentConfig` не было поля для секретов. Подмена искала `vph_` во всех заголовках. Блоки `leak_blocked` не доходили до владельца. Данные внешнего API через Bash шли модели без подъёма класса данных. Отзыв был размазан.

**Решение.**
1. `AgentConfig.credentials: [имя]`. 07 проверяет существование (уровень 2) и наличие у автора (уровень 3), закрепляет в версии.
2. Подмена только в `inject.header.name` в формате `inject.header.format` и в Basic auth. `vph_` в любом другом месте запроса к `inspect`-хосту даёт `403 leak_blocked`. `allow_in: path` разрешён только для секретов с флагом администратора (токен Telegram в `/bot<token>/`).
3. `allowed_hosts` проверяется по хосту `CONNECT`. Расхождение `Host` или `:authority` даёт `403 host_mismatch`. Выключенный секрет или версия `revoked`: `403 credential_disabled`.
4. Placeholder без гранта: `428 grant_required`, и в журнал `system.notice {code: vault.grant_missing, oauth_start}`.
5. При первом `Resolve` секрета в сессии прокси поднимает класс данных сессии до `credential.data_class`.
6. Новый тип события `system.notice {code, ...}`: `egress.blocked`, `vault.grant_missing`, `budget.warning`, `sandbox.unavailable` (пишет 02, добавлено ревью). 06 пишет через `events:append` с ключом по id `egress_log`. `leak_blocked` и попытки к частным IP идут ещё в аудит 08.
7. При `terminated` 02 вызывает activity `RevokeSessionAccess`: `DELETE egress-bundle` и отзыв токенов Hub. Ретраи без предела до `Destroy`.
8. 08 `deny_rules.match` получает `egress_host`. 06 берёт оттуда запреты доменов.
9. Сервис 09 читает signing secret входящих вебхуков через Secret-драйвер с классом `channel_ingress`. Это единственное исключение из правила «resolve только для egress-прокси».

**Изменено.** 06 разделы 0, 3.3, 3.7. 07, 01, 02, 08, 09 разделы 0.

### D28. Идентификатор тенанта

**Контекст.** Сценарий 10. Встречались `ns_<ULID>`, `hr`, `ns_hr`, `tn-acme`, `agp-<slug>`, поля `tenant_id` и `namespace_id`. Повторно занятый slug делал старые объекты «своими».

**Решение.** Везде `namespace_id` со значением `ns_<ULID>`: в `tid`, в путях S3, в столбцах таблиц. Slug только для показа. Namespace Kubernetes: `agp-<slug>`, его выдаёт 08. Столбцы `tenant_id` в схемах переименовываются в `namespace_id`. Hub включает `FORCE ROW LEVEL SECURITY` на схеме `hub` и при выпуске токена сверяет `namespace_id` конфига с `tid`.

**Изменено.** design.md раздел 11. Разделы 0 спек 02, 04, 05, 06, 09.

### D29. Подписанный контекст вызова. Имена тулов платформы

**Контекст.** Сценарии 01, 05, 10. Hub вырезает `Authorization` и не говорил встроенному серверу, от чьего имени вызов. 07 не мог проверить права автора, 10 не знал namespace для RLS. Сервер назывался `platform`, `platform.channels`, `platform-agents`, тул `platform__send_user`, `send_user`, `memory__*`, `memory_view`.

**Решение.**
1. Hub ставит на каждый запрос к встроенному серверу заголовок `X-Hub-Call-Context`: JWS EdDSA, ключи из JWKS Hub, `aud` = slug сервера, TTL 60 с. Claims: `tid`, `sid`, `turn`, `att`, `cfg`, `act`, `turn_actors`, `call_id`, `idempotency_key`, `test`.
2. Получатель проверяет подпись, `aud`, срок. `SET LOCAL app.namespace_id` ставит из `tid` и сверяет с данными сессии.
3. Если нужно действовать от имени человека (07 конструктор), сервер получает principal token у 08: `POST /internal/iam/principal-tokens {sub: act.id, ns: tid}`. Метод доступен только сервисам 07, 09, 10.
4. Встроенные серверы глобальны (`namespace_id = null` в реестре Hub) и имена у них такие:

| Сервер | Тулы | Toolset | Владелец логики |
|---|---|---|---|
| `agents` | `agents__list_toolsets`, `agents__describe_toolset`, `agents__list_skills`, `agents__list_models`, `agents__list_environments`, `agents__list_presets`, `agents__get_agent_draft`, `agents__create_agent`, `agents__save_agent_draft`, `agents__validate_agent_draft`, `agents__start_test_session` | `platform.builder` | 07 |
| `channels` | `channels__send_user`, `channels__read_thread`, `channels__search_threads` | `platform.channels` | 09 |
| `memory` | `memory__view`, `memory__search`, `memory__write`, `memory__edit`, `memory__delete` | `platform.memory` | 10 |
| `skills` | `skills__list`, `skills__read` | `platform.skills` | 10 |
| `subagents` | `subagents__spawn`, `subagents__cancel`, `subagents__message` | `platform.subagents` | 01, 02 |
| `files` | `files__publish` | `platform.files` | 01 |
| `custom` | `custom__<name>` из конфига | нет, из `custom_tools` | 01, 02 |

**Изменено.** 05 разделы 0, 1, 4. 07, 09, 10 разделы 0.

### D30. Права в общем треде: `turn_actors`

**Контекст.** Сценарий 05. Токен Hub нёс одного `act` (первого автора треда). В склеенном ходе было три автора. Боб получал ответ с правами Анны.

**Решение.** `turn_actors` это авторы всех человеческих входов хода. 01 считает их по событиям `trigger_seqs` при claim (D6). Hub берёт их из claim и кладёт в токен. `allowed() = агент ∩ effective_subject ∩ каждый turn_actor ∩ нет запрета`. 02 склеивает входы разных авторов свободно: пересечение только сужает права. Ход после ожидания наследует `turn_actors` хода, который создал ожидание (хранится в `session_waits`).

**Почему.** Сужение прав безопасно и не требует делить ходы по авторам.

**Изменено.** 02, 03, 05, 08, 09 разделы 0. См. В4.

### D31. Каналы: склейка, владелец, идемпотентность, потоки, связки

**Контекст.** Сценарии 02, 05. Склейка шла в роутере и в workflow с разными окнами. `OwnerActorID` ниоткуда не брался. Не было ключа идемпотентности событий канала. SSE web-чата не умел догонять. Две таблицы связок аккаунтов. Дубли `send_user`.

**Решение.**
1. Склейку делает только 02 (durable timers). Роутер отправляет каждое сообщение сразу, склеивает только правки одного сообщения. Окна канала идут в `POST /v1/sessions` как `limits.merge_window_ms` и `limits.merge_max_wait_ms`.
2. `POST /v1/sessions` принимает `owner_actor_id` (09 берёт `binding.owner_principal_id`). `priority: owner` 01 принимает только от сервисного токена с `act_as` или от самого владельца. Владелец прерывает ход и в общем треде.
3. Ключ событий канала: `Idempotency-Key: {binding_id}:{sha256(sorted dedup_keys)}`. Роутер ещё дедуплицирует по `(thread_key, external_msg_id)`.
4. Ключ outbox `send_user` = `idempotency_key` из контекста вызова Hub (D29).
5. 01 даёт внутренний поток `GET /internal/v1/event-stream?namespace_id=&binding_id=&types=` (SSE с фильтром по `metadata.channel.binding_id`). 09 читает из него `tool.confirmation_required`, `session.status`, `event.rejected`, `system.notice`. Дельты для web-чата 09 берёт из SSE сессии 01 с `include=deltas` на время активного хода.
6. SSE web-чата: `id` = `channel_messages.seq`, догон по `Last-Event-ID`.
7. Связки аккаунтов: источник правды 08 `channel_identities`. 09 только кеширует. Один способ привязки: одноразовая ссылка 15 мин, её выдаёт 08.
8. Если `effective_subject` треда отключён (`principal.disabled`), 09 открывает новый `generation` с subject следующего автора.
9. Новый тул `channels__search_threads {query, limit}` по `channel_messages` своего binding, тип `read`, обёртка `untrusted_message`.

**Изменено.** 09 разделы 0, 2, 5.3. 01, 02, 08 разделы 0.

### D32. Память: привязки и тулы

**Контекст.** Сценарии 05, 06, 10. Store `person` привязывался по первому автору общего треда. Hub не передавал namespace. `memory_write` типа `write` по умолчанию требовал подтверждения. Память сабагентов не определена.

**Решение.**
1. Сессиям общего треда канала шаблон `person` не привязывается. В личном чате привязывается store автора, равного `effective_subject`.
2. Привязки ребёнка = его `memory` из конфига ∩ привязки родителя. Запись в общие store только через `propose`.
3. `MemoryService` берёт namespace и сессию из `X-Hub-Call-Context` (D29), ставит `SET LOCAL` и сверяет `session_bindings.namespace_id`. `BYPASSRLS` не нужен.
4. Тулы `memory__write`, `memory__edit`, `memory__delete` в каталоге Hub размечены `kind: write`, `confirmation: allow`. Защита `company` store это `agent_write: propose`.
5. Решает по proposals право `memory.proposals.decide` (по умолчанию `admin` и владелец store).

**Изменено.** 10 разделы 0, 3.6, 3.7. 05, 09 разделы 0.

### D33. Deployments

**Контекст.** Сценарий 06. Тело создания сессии расходилось. `overlap: skip` в Schedule не оставлял следа. Таймаут слал `user.interrupt`, который сразу начинал новый ход. Промежуточный `idle` закрывал запуск как `failed`. `on_behalf_of: sa_...` обходил проверку прав владельца.

**Решение.**
1. Расписание тоже идёт через `DeploymentDispatcherWorkflow`. Schedule с `ALLOW_ALL` запускает короткий `DeploymentTickWorkflow`, тот делает Signal-With-Start в dispatcher. Перекрытие решает один код. Пропуск пишется строкой `skipped` и событием `deployment.run.skipped`.
2. Создание сессии: заголовок `Idempotency-Key: <run_id>`, `agent: "<name>@live"` или `@N`, `initial_events`, `resources`, `limits`, `on_behalf_of {kind: deployment, id: dep_...}`.
3. 08 выдаёт `effective_subject = sa_...` и проверяет владельца на каждом запуске. Hub берёт `run_as` из 01.
4. 02 держит `running`, пока outcome `active` или есть ждущие дети с `await`. `session.status idle` несёт `reason`: `settled`, `outcome_passed`, `outcome_exhausted`, `grade_failed`, `turn_failed`, `interrupted`. 10 ждёт `idle` с этими причинами.
5. В 02 `user.interrupt` без других входов не начинает ход и ставит outcome в `interrupted`.
6. При таймауте и отмене запуска 10 вызывает `POST /v1/sessions/{id}/terminate`. Пресет «отчёт по расписанию»: `run_timeout_s = 14400` и предупреждение, если меньше `max_iterations × turn_timeout_s`.
7. Запуск, который кончился, пока сессия ждёт человека, получает статус `waiting_human`. В счётчик сбоев он не идёт.

**Изменено.** 10 разделы 0, 3.2, 3.3. 01, 02, 08 разделы 0.

### D34. Файлы-результаты и outcomes

**Контекст.** Сценарий 06. Проверяющий читал журнал, а отчёт лежал файлом в `/workspace`. Исполнитель `Grade` не определён. Контракта «результат это файл» нет. Владельца Storage нет.

**Решение.**
1. Storage API (S3) ведёт 01: `file_ref` вида `fil_...`, срок хранения как у журнала.
2. Тул `files__publish {path}`: Hub → 01 → 04 `ReadFile` → Storage → событие `session.artifact {file_ref, path, sha256, size, media_type}`.
3. Outcome получает `deliverables: [{path}]`. Перед `Grade` 02 вызывает activity `CollectDeliverables`, она делает то же, что `files__publish`.
4. `Grade` исполняет только `grader-worker` 02 через шлюз 06. Модель в `AgentConfig.outcomes.grader_model`. Адаптер `simple` для `Grade` не используется.
5. `deployment_runs.artifacts` и `artifacts` в `deployment.run.finished`. `send_user` принимает `file_ref`. Дети передают `file_refs` в `subagent.finished`.

**Изменено.** 01, 02, 04, 07, 10 разделы 0.

### D35. Бюджеты и лимиты сессии

**Контекст.** Сценарии 01, 06. Тестовый бюджет и TTL некуда было передать. Каждый сабагент имел свой бюджет, дерево сессий не ограничено.

**Решение.**
1. `POST /v1/sessions` принимает `limits {budget_usd, ttl_s, merge_window_ms, merge_max_wait_ms}`. 01 хранит, 06 читает `budget_usd` из 01, 02 ставит таймер `ttl_s` и по нему делает `terminate`.
2. В 06 новый уровень бюджета `tree` по `root_session_id`. Лимит из `limits.max_cost_usd_per_tree` конфига. У deployment `max_cost_usd_per_run` передаётся как `limits.budget_usd` корня и действует на всё дерево.
3. Стоимость запуска: 01 `GET /internal/v1/sessions/{id}/usage?tree=true` суммирует `span.usage` по `root_session_id`.

**Изменено.** 01, 02, 06, 07, 10 разделы 0.

### D36. Конструктор и тестовые сессии

**Контекст.** Сценарий 01. Не было сказано, где живёт `platform/agent-builder`. 01 и Hub работали только внутри namespace. Тестовая сессия не могла идти от имени человека.

**Решение.**
1. `platform/agent-builder` и toolset `platform.builder` глобальные (`namespace_id = null`). Сессии конструктора живут в namespace пользователя. Консоль вызывает `POST /v1/sessions {agent: "platform/agent-builder@live"}`. Ссылки `platform/*` разрешены в 01 и в `agent-refs:resolve`.
2. Тест из консоли: 07 создаёт снимок `tst_...` и вызывает 01 `POST /v1/sessions {config_id, metadata.test: true, limits}` principal-токеном нажавшего человека. Тест из конструктора: 07 получает `act` из контекста вызова (D29) и principal token у 08.
3. `agents__create_agent` идемпотентен по `(session_id, name)`. `agents__save_agent_draft` при `412` возвращает `isError` с текущим черновиком и `rev`. `agents__start_test_session` принимает `draft_rev`.

**Изменено.** 07, 01, 05 разделы 0.

### D37. Кто чем владеет

**Решение.**
- Environment и его версии: 04. Таблица `environment_versions` только на вставку. 07 показывает среды и проверяет ссылки, своей таблицы не держит.
- Storage (S3, `file_ref`): 01.
- Скиллы и память: 10. Hub только публикует тулы и ставит права.
- `harness_bindings`: база 01, пишет 03 через API 01.
- `session_waits`: 01. `session_turns`: 02.
- Для валидации уровня 4: 03 `GET /internal/v1/harness-adapters`, 04 `GET /internal/v1/sandbox-drivers`, 06 `GET /internal/v1/model-routes`.
- Объекты Kubernetes тенанта создаёт драйвер 04 по событию `namespace.created` от 08.

**Изменено.** 07 раздел 0 (таблицы environments убраны), 04, 03, 06 разделы 0.

### D38. Каталог событий

**Решение.** В каталог design.md добавлены: `session.created`, `event.rejected`, `tool.confirmation_required`, `system.notice`, `session.artifact`, `subagent.waiting`, `sandbox.state`. `agent.thinking.kind`: `thought`, `plan`, `summary`, `notice`. Отдельного `agent.plan` нет. В публичную оболочку добавлено необязательное поле `turn_id`. Дельты текста эфемерны, в журнал идёт целое `agent.message`. `user.tool_confirmation.data = {approval_id, tool_use_id, decision, reason?}`. `user.tool_result.data = {tool_use_id, content[], is_error?}`.

Уточнено ревью (одна форма для всех писателей):
- `agent.message.data = {message_id, content[], final}`. Текст всегда в `content[]`, как у `user.message`.
- `tool.result.data = {tool_use_id, status, content[] | file_ref, approval_id?, reason?}`. `status`: `completed`, `failed`, `cancelled`, `unknown`, `timed_out`, `denied`. `reason` есть только у синтетического результата от 02: `timeout`, `cancelled`, `denied`. Поле `output` не используется.

**Изменено.** design.md раздел 2. 01 раздел 0.

### D39. Одна таблица лимитов

**Решение.** Все сроки и пределы в Приложении A2. Спеки ссылаются на неё и своих чисел не держат.

### D40. Шина событий, Temporal namespace, RLS

**Решение.**
- Шина в v1: outbox в каждой базе плюс `LISTEN/NOTIFY` и опрос. NATS не вводим, пока нагрузочный тест 01 не покажет предел.
- Temporal namespace один, `agents`. Платформенный клиент отклоняет visibility-запрос без фильтра `TenantId`. Есть тест на это.
- Все схемы с данными тенанта: `ENABLE` и `FORCE ROW LEVEL SECURITY` по `namespace_id`, включая `hub`.

**Изменено.** 02, 05, 07 разделы 0.

## Приложение A. Общие контракты

### A1. `RunTurn`

```ts
type TurnInput = {
  contract_version: 1;
  session_id: string;              // ses_...
  namespace_id: string;            // ns_<ULID>
  turn_no: number;
  turn_id: string;                 // "<session_id>:<turn_no>"
  config_id: string;               // ver_... | tst_...
  harness_kind: string;            // acp:claude | acp:codex | simple | adk | langgraph
  trigger_seqs: number[];          // события, которые начали ход
  history_until_seq: number;       // всё до этого seq уже было в прошлых ходах
  turn_actors: string[];           // D30
  mode: "normal" | "resume_after_wait" | "grade_feedback" | "subagent";
  outcome_id?: string;
  sandbox?: SandboxHandle;         // есть в режиме colocated (D24)
};

type TurnResult = {
  stop_reason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal"
             | "interrupted" | "waiting_tool" | "waiting_human"
             | "waiting_subagents" | "limit" | "error";
  last_seq: number;
  waits: { kind: "custom_tool" | "confirmation"; tool_use_id: string;
           approval_id?: string; approvers: string[]; expires_at: string }[];
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  sandbox_used: boolean;
  limit_reason?: "tool_call_limit" | "model_request_limit" | "turn_timeout" | "output_tokens";
  error?: { code: string; message: string; retryable: boolean };
};
```

Опции activity: очередь `harness-<kind>`, `StartToClose = turn_timeout_s + 60 с`, `HeartbeatTimeout = 30 с` (heartbeat каждые 5 с), `ScheduleToStart = 2 мин`. Ретраи: 1 с, ×2, до 30 с, 5 попыток. Неретраимые: `InvalidAgentConfig`, `HarnessAuthFailed`, `BudgetExceeded`, `PolicyDenied`, `StaleWriter`. Номер попытки = номер попытки activity в Temporal. Статус после хода: есть открытое ожидание `custom_tool` → `waiting_tool`, иначе есть `confirmation` → `waiting_human`.

### A2. Лимиты

| Что | Значение | Где задаётся |
|---|---|---|
| Ход | по умолчанию и максимум 1800 с | `config.limits.turn_timeout_s` |
| Токен сессии Hub | ход + 300 с, не больше 35 мин | Hub |
| Контекст вызова встроенного сервера | 60 с | Hub |
| Principal token 08 | 5 мин | 08 |
| JWT `sandboxd` | 15 мин | 04 |
| Ожидание custom tool | 24 ч по умолчанию, до 7 д | `custom_tools[].timeout_s` |
| Ожидание подтверждения | 72 ч | Hub, `expires_at` |
| Ожидание детей при `await` | 2 ч | 02 |
| Склейка входов | окно 1500 мс, максимум 10 с | `limits` сессии |
| Сон песочницы | 600 с простоя | версия Environment |
| Хранение спящей папки | 7 д | версия Environment |
| Потолок отсрочки сна при `busy` | 2 ч | 02 |
| Сабагенты | глубина 2, активных 8, ждущих 32, в очереди 50, всего на корень 100 | 02 |
| Тестовая сессия | 2 USD, 24 ч | `namespace_agent_settings` в 07 |
| Кеш `tool-scope` | `ttl_s` из ответа 08 (30 с), только `read` ещё 120 с | 08 |
| Egress-токен | живёт до `Wake`, `Destroy` или `terminated` | 06 |
| Входы на запрос | 20 событий, `data` до 256 KiB | 01 |
| Итог сабагента | `summary` до 16 KiB, больше через `file_ref` | 02 |

### A3. Словарь имён

| Имя | Смысл |
|---|---|
| `namespace_id` | Тенант, всегда `ns_<ULID>`. Поле `tenant_id` не используется |
| `config_id` | `ver_...` (версия) или `tst_...` (тестовый снимок) |
| `turn_id` | `<session_id>:<turn_no>` |
| `tool_use_id` | Id вызова. Для событий harness это id вызова harness. Для ожиданий через Hub (custom tool, подтверждение) это id вызова Hub `tc_...` |
| `approval_id` | Id подтверждения вызова: `ap_...` (Hub) или `bp_...` (builtin-тул). Публикация агента: `apr_...` в 08 |
| `decision` | `approve` или `deny` |
| `effective_subject` | Чьи права пересекаются с агентом (08) |
| `turn_actors` | Авторы человеческих входов хода |
| `owner_actor_id` | Владелец сессии. Его сообщение прерывает ход |
| `on_behalf_of` | `{kind: user | channel | deployment | service_account, id, external_user_id?}` |
| `user.message.data` | `{content: [...], author?, channel?, context?}` |
| Префиксы id | `ns_`, `usr_`, `sa_`, `agt_`, `ver_`, `tst_`, `ses_`, `evt_`, `tc_`, `ap_`, `bp_`, `apr_`, `env_`, `sbx_`, `cred_`, `chn_`, `thr_`, `dep_`, `run_`, `mem_`, `skl_`, `fil_` |

### A4. Коды ошибок, общие для нескольких компонентов

| Код | HTTP | Кто отдаёт | Когда |
|---|---|---|---|
| `session_terminated` | 409 | 01, 05, 06 | Любое действие в закрытой сессии |
| `tool_use_mismatch` | 409 | 01 | Ответ без открытого ожидания. `details.reason`: `not_found`, `answered`, `timed_out`, `cancelled` |
| `not_approver` | 403 | 01 | Подтверждает не согласующий |
| `stale_writer` | 409 | 01 | Старая попытка хода пишет в журнал |
| `author_lacks_access` | 422 | 07 (по ответу 05) | У автора нет тула, секрета или сабагента |
| `approval_required` | 202 | 07 | Публикация ждёт согласования, в теле `approval_id` |
| `self_approval` | 403 | 08 | Автор утверждает свою заявку |
| `approval_stale` | 409 | 07 | `config_hash` заявки не совпал |
| `session_context_failed` | 422 | 01 | 08 или 10 отказали при создании сессии |
| `deployment_owner_disabled` | 409 | 01 (по ответу 08) | Владелец deployment отключён |
| `subagent_limit` | 422 | 02 | Превышены глубина или общий лимит детей |
| `budget_exceeded` | 402 | 06 | Нет денег в бюджете сессии, дерева, агента или namespace |
| `leak_blocked`, `host_mismatch`, `credential_disabled`, `grant_required` | 403, 403, 403, 428 | 06 | Egress-прокси |
| `hub/deny_code` | в теле результата тула | 05 | `human_not_permitted`, `agent_not_permitted`, `company_rule`, `data_class_ceiling`, `tool_needs_review`, `tool_unlabeled`, `rate_limited`, `oauth_grant_missing`, `approval_denied`, `approval_expired` |

## Вопросы владельцу

Здесь только продуктовые выборы. По каждому в спеки уже внесён рекомендуемый вариант. Если ответ другой, правится одно решение.

**В1. Сообщение, пока сессия ждёт ответ custom tool.** design.md по образцу CMA говорит `409`. Мы приняли очередь (D3): сообщение не теряется, владелец и `user.interrupt` могут снять ожидание. Рекомендация: очередь.

**В2. Переход долгих сессий бота на новую версию.** Варианты: никогда, новая сессия треда после смены live (`next_session`), перевод живой сессии между ходами (`next_turn`). Мы приняли `next_session` для каналов и `never` для API и deployments (D22). Непрерывность держит память канала. Рекомендация: так и оставить, `next_turn` сделать позже, если попросят.

**В3. Песочница на каждую сессию Claude и Codex.** Пока не доказано, что `claude-agent-acp` отдаёт встроенные тулы через ACP, harness работает внутри песочницы (D25). Цена: Pod на каждую активную сессию и тёплый пул. Рекомендация: принять, приоритетно сделать прототип из теста 04 №6.

**В4. Права в общем треде.** Мы пересекаем права со всеми авторами хода (D30). Ответ всем строится по самым узким правам. Альтернатива: только первый автор треда, это проще, но Боб может получить данные Анны. Рекомендация: пересечение.

**В5. Запись в боевые системы из тестового чата.** Сейчас тестовый `write` всегда ждёт подтверждения и пишет по-настоящему, карточка об этом предупреждает (D16). Альтернатива: запретить `write` в тесте, пока у тула нет `dry_run`. Рекомендация: разрешить с предупреждением, `dry_run` добавить позже.

**В6. Кто подтверждает вызов по умолчанию.** Мы приняли: человек, от чьего имени сессия, владелец агента и все с правом `tools.confirm` (D16). Альтернатива: только человек сессии. Рекомендация: наш вариант, иначе расписания и боты без автора застревают.

**В7. Версия у deployment.** `null` значит `@live` (D21): новая live-версия сразу меняет поведение расписания, откат тоже сразу. Альтернатива: закреплять номер при создании. Рекомендация: `@live` по умолчанию, в консоли показывать, на какой версии был каждый запуск.

## Открытые вопросы компонентов: куда ушли

| Компонент, вопрос | Ответ |
|---|---|
| 01 №1 signal сразу или outbox | D1: сразу, outbox страховка |
| 01 №2 `turn_id` в оболочке | D38: да, необязательное |
| 01 №3 где проверка 409 | D1, D2: в Postgres 01, валидатор страхует |
| 01 №4, №5 предел LISTEN/NOTIFY, дельты | D40: остаются, порог мерит нагрузочный тест |
| 01 №6 длинные сессии | Остаётся. Лимит 100 000 событий как в 01 |
| 01 №7 Environment, Storage | D37 |
| 01 №8 сабагенты | D18: отдельная сессия |
| 02 №1 update или signal | D1 |
| 02 №2 steer | Остаётся: сообщения ждут следующего хода |
| 02 №3, №4 статусы | D33: `idle` с `reason`, отдельного статуса нет |
| 02 №5 spawn | D18 |
| 02 №6 namespace Temporal | D40 |
| 02 №8 держать ход при быстром подтверждении | Нет. Ход кончается (D16) |
| 03 №1 где harness | D25 |
| 03 №2 дельты | D38 |
| 03 №3 продление токена | D9 |
| 03 №4 `session/load` | D8: проверять `agentCapabilities.loadSession`, по умолчанию rehydration |
| 03 №8 `agent.plan` | D38 |
| 04 №1, №8 `remote_tools` | D25 |
| 04 №3 `sandbox.state` | D24, D38 |
| 04 №4, №5 идентификация на egress, DNS | D26 |
| 04 №6 владелец environments | D37 |
| 05 №1, №2 события и путь подтверждения | D16, D38 |
| 05 №3 ключ идемпотентности | D7 |
| 05 №4 обновление токена | D9 |
| 05 №7 от чьего имени deployment | D33 |
| 05 №10 запуск stdio | D26 |
| 06 №2 `system.notice` | D27 |
| 06 №3 Environment | D37 |
| 06 №4 harness вне песочницы | D25 |
| 07 №1 ревизии toolset | D12 |
| 07 №3 перевод сессии | D22, В2 |
| 07 №4 шина | D40 |
| 07 №5 скиллы | D37 |
| 07 №6 `confirmations` только ужесточают | Да (D10) |
| 07 №8 где конструктор | D36 |
| 07 №10 общий сервис согласований | D15: нет в v1 |
| 08 №2 права в треде | D30, В4 |
| 08 №5 права SA deployment | D33: на каждый запуск |
| 08 №8 квоты | Остаётся: `max_sessions_running` проверяет 01, бюджет 06 |
| 09 №1 поток тенанта | D31 |
| 09 №2 событие подтверждения | D16: `tool.confirmation_required` |
| 09 №3 автор хода | D30 |
| 09 №4 signing secret | D27 |
| 09 №5 токен в пути | D27 |
| 09 №7 чей владелец | D31: владелец binding |
| 09 №8 `send_user` | Встроенный MCP-тул, как выбрано |
| 10 №1 память в Hub или отдельно | D37 |
| 10 №3 запуск в `waiting_human` | D33 |
| 10 №4 версия deployment | D21, В7 |
| 10 №8 память сабагентов | D32 |
| 10 №9 кто решает proposals | D32 |
| 10 №10 две реализации overlap | D33: одна |

Остальные открытые вопросы спек (непроверенные детали внешних библиотек, лимиты памяти, pgvector, OIDC на namespace, токенизация ПДн) не мешают стыковке и остаются в спеках.

## Замечания ревью

Ревью 2026-10-15. Мелкие расхождения уже исправлены прямо в спеках (список в конце раздела). Здесь только то, что требует решения. Порядок: сначала то, что ломает работу, потом пробелы.

### Р1. Песочница с закрытым DNS не найдёт прокси, Hub и шлюз моделей

D26 закрывает DNS из Pod. Но `HTTPS_PROXY`, адрес Hub и `ANTHROPIC_BASE_URL` заданы именами `*.platform-system.svc`. Без DNS клиент не узнает их адрес, и сеть песочницы не работает совсем.

Предложение: драйвер 04 пишет адреса трёх сервисов в `spec.hostAliases` Pod (это `/etc/hosts`, ClusterIP сервисов стабилен). Второй вариант: `sandboxd` подставляет IP прямо в URL, но тогда TLS к Hub и шлюзу проверяется по IP SAN. Ещё два места проверить на k3d:
- NetworkPolicy сверяет адрес и порт уже после трансляции Service в адрес Pod у большинства CNI. Значит, правило должно выбирать Pod сервисов (`namespaceSelector` + `podSelector`) и их `targetPort`, а не порт Service `:443` (не проверено по документации Kubernetes, страница NetworkPolicy об этом молчит).
- `ca_bundle_pem` должен содержать и CA прокси, и внутренний CA платформы. Иначе TLS к Hub и шлюзу не пройдёт.

Владелец: 04, 06. Блокирует этап 7 плана (Kubernetes).

### Р2. Повтор `RunTurn` получает старый `SandboxHandle`

Temporal повторяет activity с тем же входом. В `colocated` handle лежит в `TurnInput.sandbox` (D24). После `SandboxLost` или долгой паузы в повторе будет старая `generation`, а JWT `sandboxd` живёт 15 мин при ходе до 30 мин. 03 раздел 6 говорит «следующая попытка получает новый handle», но механизма нет.

Предложение: `TurnInput.sandbox` считать подсказкой. Воркер в начале каждой попытки и при `FAILED_PRECONDITION` или `UNAUTHENTICATED` от `sandboxd` сам зовёт update `ensure_sandbox {turn_id}`, как в `remote_tools`. Update и так идемпотентен. Тот же update продлевает JWT. Владелец: 02, 03, 04.

### Р3. Шина событий между сервисами не определена

D40 говорит «outbox в каждой базе плюс `LISTEN/NOTIFY` и опрос». Но `LISTEN/NOTIFY` работает только внутри одной базы Postgres, а 07 «чужие таблицы не читает». В итоге три разных способа: 07 раздаёт через `LISTEN/NOTIFY`, 08 шлёт HTTP-вебхуки с повтором, 10 пишет в «общую шину». Не описано, как 01, 05, 09 получают `agent.version_recalled`, `agent.live_changed`, `principal.disabled`, `approval.decided`, `namespace.created`.

Предложение: один контракт доставки для всех: outbox владельца плюс доставщик, который шлёт `POST /internal/v1/events` подписчику с повтором (как уже описано в 08). Конверт из 08 раздел 3.6, дедуп по `event_id` у получателя. Таблица подписок в одном месте (Helm values). NATS не нужен. Владелец: 07, 08, 10, все подписчики.

### Р4. Миграции схемы базы нигде не описаны

Ни одна спека не говорит, как меняется схема Postgres при выкатке. При этом воркеры и API выкатываются по частям, а сессии живут месяцами.

Предложение: инструмент миграций один на платформу (на выбор команды), схема на компонент, правило expand-contract: сначала добавить, выкатить код, потом удалить. Миграция идёт отдельной Job до выкатки. Для `session_events` с сотнями миллионов строк индексы только `CREATE INDEX CONCURRENTLY`. Для JSON Schema событий правило уже есть (только добавляем, 01 раздел 3.1).

### Р5. Бэкапы и восстановление не описаны, а Postgres и Temporal могут разойтись

Нет ни слова о резервных копиях Postgres (журнал, конфиги агентов, vault), Temporal и S3. Опасный случай: Postgres восстановлен на момент раньше, чем Temporal. Тогда у workflow `LastSeenSeq` больше `sessions.last_seq`, новые входы получат тот же `seq` и будут молча отброшены (D1).

Предложение: CNPG с бэкапом в S3 и восстановлением на момент времени (PITR); бэкап базы Temporal; версионирование бакетов S3. Runbook восстановления: после restore Postgres сессии с расхождением находит сверка `sessions.last_seq` с query `state` workflow и чинит их (`seq` продолжается с максимума, workflow получает `reset`-signal). Цели RPO и RTO задаёт владелец.

### Р6. Удаление данных не сквозное

Есть куски: `erase` памяти (10), срок журнала 400 дней (01), удаление namespace через 7 дней (08), `egress_log` 30 дней (06). Нет:
- каскада при удалении namespace: журналы, S3 (файлы, снапшоты, скиллы), Temporal workflows и Schedules, `tool_calls` Hub, vault, объекты Kubernetes;
- способа стереть ПДн человека из журнала, который неизменяем (`revoke update, delete`);
- срока хранения истории Temporal (retention namespace `agents`).

Предложение: `NamespaceDeletionWorkflow` в 08 вызывает `DeleteTenantData` у каждого компонента и ждёт подтверждения. Для ПДн в журнале выбрать: шифрование `data` ключом на namespace или на человека с уничтожением ключа (crypto-shredding), или отдельная роль `redaction`, которая заменяет `data` на маркер с аудитом. Решение юридическое, нужен ответ владельца.

### Р7. Наблюдаемость разбросана

Метрики есть только местами (06: `egress_*`; 01: `pg_notification_queue_usage`). Нет общего раздела: какие метрики у каждого компонента, как идёт трасса через 01 → Temporal → 03 → Hub → 06 → upstream, какие логи без ПДн, какие SLO.

Предложение: короткий общий документ. OpenTelemetry везде. `traceparent` идёт от 01 в заголовок Temporal (у SDK есть интерцепторы трасс, детали не проверены), из 03 в `_meta` MCP (спецификация MCP `2026-07-28` закрепляет ключи `traceparent`, `tracestate`, `baggage` в `_meta`). Минимум SLO: время от `user.message` до первой дельты, доля `turn_failed`, задержка outbox, холодный старт песочницы, p99 добавки egress-прокси. Метрики с `namespace_id` только в меру: высокая кардинальность.

### Р8. Квоты и rate limit на уровне тенанта

`max_sessions_running` из 08 никто не проверяет (в 01 его нет, хотя таблица «куда ушли» говорит, что проверяет 01). Нет лимита на создание сессий и на `/v1` в целом на namespace. Лимиты провайдеров моделей общие на всех тенантов, честного деления в 06 нет: один тенант может выбрать весь лимит провайдера.

Предложение: 01 проверяет `max_sessions_running` при `POST /v1/sessions` (`429 quota_exceeded`) и при старте хода; 06 держит лимит RPM и TPM на namespace перед LiteLLM.

### Р9. Стоимость инфраструктуры не посчитана

Бюджеты есть только на модели. D25 требует Pod на каждую активную сессию Claude и Codex плюс тёплый пул. Каждая сессия держит открытый workflow годами (02 вопрос 7). Режим `review` тратит модель неизвестно чью (05 вопрос 13). Нужна грубая модель: N активных сессий × ресурсы Pod × время до сна, размер тёплого пула, объём журнала в день. Без неё нельзя выбрать `idle_hibernate_s` и `warm_pool_size`.

### Р10. Локальная разработка не описана

design.md говорит «сначала драйвер `docker`», но нет описания стенда разработчика: какие процессы поднимать (Postgres, `temporal server start-dev`, MinIO, LiteLLM с фейковой моделью, фейковый OIDC, Hub, egress-прокси с CA), какие фейки 01...10 есть, как запустить сквозной тест приёмки одной командой. NetworkPolicy в docker не проверить: для тестов сети нужен k3d. Предложение: `docs/dev.md` и compose-файл до этапа 2 плана.

### Р11. MCP `2026-07-28`: отмена закрытием потока

Ревью сверило с официальной спецификацией: версия `2026-07-28` текущая, заголовки `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, коды `-32020` и `-32022`, `resultType`, `ttlMs`, `cacheScope`, `405` на GET и DELETE описаны верно. Два следствия не учтены:
- закрытие SSE-ответа клиентом значит отмену запроса. Hub не должен отменять уже начатый вызов upstream для `write`: он доводит вызов, сохраняет результат по ключу (D7) и отдаёт его при повторе;
- upstream-сервер новой версии может вернуть `resultType: input_required` (elicitation, sampling). Hub должен решить: отказать, превратить в подтверждение человека или передать harness. Сейчас не описано.

### Р12. Мелкие дыры в контрактах

- `ResolveSessionContext` описан как `rpc`, а все остальные вызовы REST. Нужен путь, например `POST /internal/v1/session-context:resolve`.
- Воркер читает `session_bindings.skills` (10, раздел 3.9), но внутреннего API для этого нет. Нужен `GET /internal/v1/session-bindings/{session_id}` в 10 или поле в ответе 01.
- 07 экран списка зовёт 01 `GET /v1/sessions?group_by=agent`, такого параметра в 01 нет.
- Лимит входящих signals на один workflow не найден в документации self-hosted (там есть только лимит 2000 на свои незавершённые операции и 2000 updates), вопрос 01 №9 остаётся (не проверено).
- `codex app-server` «официально экспериментальный» и переменные окружения Codex (`OPENAI_BASE_URL`, `model_providers`) в официальной документации не проверены.

### Что ревью проверило по документации

| Утверждение | Итог |
|---|---|
| Signal-With-Start атомарен, Update-With-Start нет | Верно (docs.temporal.io, Sending messages) |
| Лимиты self-hosted: blob 2 MB, история 50 MB и 51 200 событий, предупреждение 10 240, updates 10 в полёте и 2000 всего, gRPC 4 MB | Верно (docs.temporal.io, Self-hosted defaults) |
| Дети и continue-as-new родителя | Дети не переносятся, к ним применяется Parent Close Policy. `ABANDON` в 02 обязателен (вопрос 02 №10 закрыт) |
| `temporal worker deployment set-ramping-version --percentage`, `set-current-version` | Верно (docs.temporal.io, Worker Versioning) |
| `temporalio.contrib.google_adk_agents`, `GoogleAdkPlugin` | Есть (python.temporal.io) |
| Детали heartbeat в TS | `activityInfo().heartbeatDetails`, исправлено в 03 |
| MCP `2026-07-28`: заголовки, коды ошибок, `resultType`, кеш `tools/list`, `traceparent` в `_meta`, аннотации тулов недоверенные | Верно (modelcontextprotocol.io) |
| ACP: `usage_update`, `compaction_update`, `compaction_summary_chunk`, `notice`, `config_option_update`; `session/resume`, `session/list`, `session/close` | Есть в схеме (agentclientprotocol.com) |
| Пакет `@agentclientprotocol/claude-agent-acp` | Есть |
| Claude Code: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (Bearer), `ANTHROPIC_API_KEY` (`X-Api-Key`) | Верно, исправлено в 03 и 06 |
| Codex ищет скиллы в `.agents/skills` | Верно, плюс `$HOME/.agents/skills` и `/etc/codex/skills`, дописано в 10 |
| NetworkPolicy работает на уровне IP и портов, домены не умеет | Верно (kubernetes.io, Network Policies) |

### Что исправлено в спеках

- D16, D33, D38, D27: `tool.result {reason: timeout}`; причина `idle` `grade_failed` (была в 02 раздел 6, не было в списке); единая форма `agent.message.data` и `tool.result.data`; код `sandbox.unavailable`.
- 01: пример `turn_id` и `dedupe_key` по A3; `signal_inputs` вместо `signal_events`; `event.rejected {event_id, code}`; Storage принадлежит 01; в таблицу кодов добавлены `session_context_failed`, `deployment_owner_disabled`, `session_too_large`; `seq` в payload updates.
- 02: закрыт блок SQL; коды отказа валидатора сведены к `tool_use_mismatch`; восстановление по D7 и D8; неретраимые ошибки по A1; `trigger_seqs` вместо `NewEventIDs`; вопрос №10 закрыт.
- 03: `content[]` вместо `text` и `output`; API деталей heartbeat в TS; переменная `ANTHROPIC_AUTH_TOKEN`.
- 04: `namespace_id` вместо `namespace`; `ensure_sandbox {turn_id}`; при отказе `Provision` пишется `system.notice`, а не `agent.message`.
- 05: id `ap_` и `tc_` вместо uuid; `aud` и `sub` по D9; срок подтверждения даёт `expired`; причина в `cancel`; зависимость от `data-class` в 06.
- 06: `X-Model-*` вместо старых заголовков; право `vault.manage` вместо `secret_admin`; egress-токен в диаграмме; переменные Claude.
- 07: формат ошибок как в 01; фильтр `agent_version`; путь трасс Hub; соответствие `harness.kind` и `harness_kind`.
- 08: `external_user_id` в `on_behalf_of`; NetworkPolicy по D26; отключение человека по D9 и D31.
- 09: пример `user.message` с `content[]` и `usr_`.
- 10: диаграмма запуска через dispatcher (D33); `grade_failed`; имена `skills__*`; скиллы в песочницу через `WriteFile`, а не `Provision`; пути скиллов Codex.
- flows: в каждый сценарий добавлена пометка, что разбор сделан до решений.
