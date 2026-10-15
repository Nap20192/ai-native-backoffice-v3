# Сессии и ход агента

Сессия связывает агента с окружением. Пользователь создаёт сессию, пишет сообщение, и агент работает:
вызывает модель, выполняет инструменты в песочнице LiteBox (микро-VM) и отвечает.
Ход виден в разговоре и на вкладке «Хронология». Файлы, которые агент сохранил в `/mnt/session/outputs`, видны в панели «Файлы сессии».

## Sub-features

- `session-create` — окно «Новая сессия»: агент, окружение, название, хранилища. Ресурсы окна описаны отдельно в `session-resources.md`.
- `session-turn` — сообщение, ход агента с `bash` в VM, итоговый ответ.
- `session-tool-card` — карточка инструмента в разговоре: команда и вывод.
- `session-timeline` — вкладка «Хронология» со строками инструментов и вызовов модели.
- `session-files` — панель «Файлы сессии» (`GET /v1/sessions/:id/outputs`).
- `session-archive` — архив сессии. Песочница уничтожается, VM останавливается.

## How to get to it (user POV)

- Боковое меню, ссылка «Сессии» (`g` `s`), маршрут `/sessions`, кнопка «Новая сессия». После «Создать» консоль переходит на `/sessions/:id`.
- Клик по строке списка сессий открывает `/sessions/:id`.
- На странице сессии: поле «Сообщение» и кнопка отправки (Enter отправляет, Shift+Enter переносит строку); вкладки «Разговор» и «Хронология»; кнопка «Файлы сессии». Подпись кнопки зависит от статуса: «Отправить сообщение» при idle, «Поставить сообщение в очередь» при running (`components/session/SessionComposer.tsx:163-166`).

## Driving it with Playwright (verify-agent-console)

Preconditions:

- Агент `verify-agent-<nonce>` и окружение `verify-env-<nonce>` созданы (см. `agents.md`, `environments.md`).
- Режим fake: фейковая модель отвечает на `127.0.0.1:8792` (`scripts/doctor.sh`). Промпт содержит строки `Команда: <cmd>` и `VERIFY_AGENT_RUN nonce=<n>`.
- Весь путь выполняет `scripts/journey.sh`, шаги «сессия» и «ход агента».

- **Новая сессия.** Нажать ссылку «Сессии», затем `getByRole("button", { name: "Новая сессия" }).first()`. Результат: `getByRole("dialog", { name: "Новая сессия" })`. Агент и окружение подставлены по умолчанию первыми в списке.
- **Выбрать агента и окружение.** Нажать `dialog.getByRole("combobox").nth(0)`, выбрать `[data-slot="command-item"]` с id агента. Затем то же для `nth(1)` с id окружения. Результат: в тексте каждого combobox видно `<имя> (<id>)`.
- **Название и создание.** Заполнить `#session-title` значением `verify-session-<nonce>` и нажать `getByRole("button", { name: "Создать", exact: true })`. Ожидаемый результат: URL `/sessions/<id>`, h1 с названием, бейджи `[title="Агент: …"]` и `[title="Окружение: …"]`. `GET /v1/sessions/:id` возвращает `agent.id`, `environment_id` и `title`. Фактически на 2026-10-15: `title = null`, h1 «Сессия без названия» (дефект консоли, проверка `session.title_saved` — провал), статус `running` и «Выполняется» до первого сообщения (`session.initial_status` — внимание). Папки `<прогон>/data/sandboxes/<id>` ещё нет: песочница ленивая.
- **Сообщение.** До отправки открыть параллельно с консолью поток `GET /v1/sessions/:id/events/stream` (cookie браузера, `captureStream` в сценарии). Заполнить `getByRole("textbox", { name: "Сообщение" })` и нажать `getByRole("button", { name: /^(Отправить сообщение|Поставить сообщение в очередь)$/ })`. В новой сессии подпись «Поставить сообщение в очередь» (`run.ui_send_label` — внимание). Перед снимком дождаться, что поле ввода очистилось.
  Ожидаемый результат: в `article[data-turn-id]` реплика `[data-session-turn-prompt]` с `nonce=<n>`.
  Фактически 2026-10-15: сразу после нажатия виден локальный пузырь «В очереди…» с текстом промпта вне хода (`screens/*-turn-sent.png`), но в ходе реплики нет ни через 15 с после отправки (`run.ui_prompt_on_send` — провал), ни после конца хода (`run.ui_prompt_visible` — провал; в `aria/*-turn-done.yml` в `article` только кнопка «Работал N с» и ответ). Через 15 с после отправки текста промпта на странице нет совсем: локальный пузырь уже убран. После `page.reload()` реплика появляется (`run.ui_prompt_after_reload` — проверено). Причину см. в Gotchas.
- **Конец хода.** Опрашивать `GET /v1/sessions/:id/events?order=asc&limit=100` (с `page=next_page`), пока после `user.message` не появится `session.status_idle`. Результат:
  - события идут в порядке `agent.tool_use{name:"bash"}` → `agent.tool_result{tool_use_id, content содержит VERIFY_OK_<n>}` → `agent.message{VERIFY_DONE_<n>}` → `session.status_idle{stop_reason.type:"end_turn"}`;
  - `GET /v1/sessions/:id` возвращает `status = idle`;
  - в интерфейсе `article` получил `data-session-turn-status="completed"`, а `[data-session-turn-answer]` содержит `VERIFY_DONE_<n>`.
- **Карточка инструмента.** Нажать `[data-chat-reasoning-trigger]` («Работал N с»), при группе — кнопку «Использовано N инструментов», затем `[data-slot="collapsible-trigger"]` с текстом `bash`. Результат: `[data-slot="collapsible-content"]` содержит `VERIFY_OK_<n>` (`run.ui_tool_card`).
  Вывод должен читаться как текст: `kernel=` на своей строке, без `"type": "text"`, литералов `\n` и `\u001b` (`run.ui_tool_output_text`, текст карточки в `api/45-tool-card-text.txt`). Фактически 2026-10-15 — провал: карточка показывает JSON-массив content-блоков `[{"type": "text", "text": "VERIFY_OK_…\nkernel=…\n\u001b[2m…"}]`.
- **Хронология.** Нажать `getByRole("tab", { name: "Хронология" })`. Результат: есть строка `[title^="bash · "]`, рядом «Вызов модели» и «Ответ агента».
- **Файлы сессии.** Нажать `getByRole("button", { name: "Файлы сессии" })`. Результат: в `getByRole("complementary", { name: "Файлы сессии" })` есть ссылка `verify-<n>.txt`. Те же файлы видны через `GET /v1/sessions/:id/outputs`. На хосте лежит `<прогон>/data/session-outputs/<tenant>/<session>/verify-<n>.txt` с содержимым `VERIFY_OK_<n>`, записанным внутри VM.
- **Это VM, а не хост.** Значение `kernel=` в выводе bash не равно `uname -r` хоста. По runbook ядро в VM 6.12.76, на хосте 6.18.55. Дополнительно есть `<прогон>/data/sandboxes/<id>/.openma/litebox-scratch-*`, «Box started successfully» в `BOXLITE_HOME/logs` и процесс `libkrun VM` (pid из строки `boxlite-shim subprocess spawned`) — прямой потомок server-node. Строки «creating box» в логе сервера нет (логгер litebox-sandbox не подключён, см. `environments.md`).
- **Архив.** Вызвать `POST /v1/sessions/:id/archive` (это делает сценарий и `scripts/cleanup.sh`). Результат: `archived_at` задан, в логе BoxLite новая строка «Box stopped», scratch удалён. Папка `sandboxes/<id>` остаётся: её стирает только удаление сессии.
- **Доказательство.** `screens/*session*.png`, `screens/*turn*.png`, `screens/*timeline.png`, `screens/*session-files.png`, `aria/*turn-done.yml`, `api/40…45-*`, `api/41-session-stream.json` (поток событий), `api/fake-model-requests.jsonl`, строки `run.*` в `summary.md`.

## Gotchas

- `combobox` «Агент» и «Окружение» не связаны с подписями (`pages/SessionsList.tsx:820,852`). Берите их по порядку в окне, а выбор подтверждайте по id в тексте.
- В фейковом режиме ответ модели определён заранее. В режиме real проверяйте события `tool_use` и `tool_result` и маркер `VERIFY_OK_<n>` в выводе, а не точный текст ответа.
- После завершения хода блок процесса скрыт (`hidden`, `inert`). Без клика по `[data-chat-reasoning-trigger]` карточки инструмента не видно. Повторяющиеся вызовы в разговоре схлопываются, полный список есть на вкладке «Хронология».
- Поток `/events/stream` может не отдавать историю, поэтому для проверки используйте опрос `/events`. Если session.status_idle пришёл раньше, чем вы начали ждать, ищите его в журнале после своего `user.message`.
- **Реплика пользователя не видна, пока страницу не перезагрузить.** Консоль строит ход из событий (`projectCanonicalChatTurns` в `@openma/common/session-events/managed`): ход без события `user.message` не имеет `userText`, и `[data-session-turn-prompt]` не рисуется. После отправки консоль ставит локальный пузырь и убирает его, как только `POST /events` ответил (`pages/SessionDetail.tsx:757-765`), рассчитывая, что дальше придёт `system.user_message_pending`, а сам `user.message` — из потока «at drain time» (`SessionDetail.tsx:405-438`). На main-node ни то ни другое не приходит: `system.user_message_pending` нигде не отправляется (в `apps/main-node/src` и `packages/*/src` есть только тип в `packages/api-types/src/types.ts:824`), а поток `/events/stream` после отправки отдаёт `session.status_running`, `span.*`, `agent.tool_use`, `agent.tool_result`, `agent.message`, `session.status_idle` и другие события, но не `user.message` (`api/41-session-stream.json`, строка `run.sse_user_message`). После перезагрузки история из `GET /events` содержит `user.message`, и реплика видна. Правка: слать `user.message` (или `system.user_message_pending`) в поток на main-node либо не убирать локальный пузырь до прихода хода.
- **Вывод bash в карточке — JSON.** `components/session/CanonicalSessionTurn.tsx:140-147` (`formatToolOutput`) делает `JSON.stringify(rawOutput)` для массива content-блоков из `agent.tool_result`, а `components/ai-elements/tool.tsx:187-209` показывает строку, которая начинается с «[», как JSON в `CodeBlock`. Тот же приём есть в `pages/SessionDetail.tsx:1605-1612`, но там он только в `EventRender` для пузырей очереди. Правка: склеивать текст блоков `type: "text"` перед показом.
- Сбой песочницы выглядит так: `session.error{retry_status: retrying | exhausted}`, затем `session.status_idle{stop_reason.type:"retries_exhausted"}`. Это провал, а не «ход закончился».
- Сетевые команды в bash (`curl`, даже `getent hosts`) на этом стенде обрывают exec BoxLite, и VM перестаёт отвечать (см. `environments.md`). В главной сессии сеть не используйте.
- `ANTHROPIC_BASE_URL` задаётся без `/v1`. Pi передаёт его в SDK как есть, и запрос уходит на `<base>/v1/messages?beta=true`.
- Пустая строка `ANTHROPIC_API_KEY=` ломает старт сервера. `launch.sh` задаёт ключ явно и ставит `DREAM_CURATOR_MODE=dedup`.
- Инструмент `read` для картинок и PDF ждёт префикс `exit=N`, которого LiteBox не выдаёт. Скорее всего, картинка вернётся как сырой base64. Это не проверялось.
- Если удалить окружение раньше сессии, архивировать сессию не получится, и VM не остановится (`packages/managed-agents-adapters-runtime/src/session-lifecycle-router.ts:75-84`).
- Название из окна «Новая сессия» теряется: `pages/SessionsList.tsx:865-867` ставит `name="oma-session-title"` поверх `{...register("title")}`, а `onChange` react-hook-form ищет поле по `event.target.name`. Не обходите это переименованием через карандаш в шапке: провал `session.title_saved` должен оставаться, пока консоль не исправят.
- Новая сессия создаётся со `status: "running"` (`packages/managed-agents-application/src/sessions/application.ts:322`) и остаётся в нём до первого сообщения. Не ждите «Ожидает» перед отправкой.
