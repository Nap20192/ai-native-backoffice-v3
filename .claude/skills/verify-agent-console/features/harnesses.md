<!-- scenario: claude-code -->
# Свой harness

Harness это программа, которая ведёт ход агента. Встроенные варианты есть всегда: встроенный цикл, Claude Code в песочнице и непроверенные ACP-агенты из каталога.
Свой harness пользователь описывает карточкой на странице «Harness»: название, ID, команда, аргументы, рабочая папка, пакеты, протоколы модели и разрешённые имена переменных. Агент с такой карточкой запускает команду в VM окружения сессии и говорит с ней по ACP через stdin и stdout. Модель агент получает через прокси сервера: переменные `OMA_INFERENCE_*` с адресом прокси своей сессии и коротким токеном хода, ключ остаётся на сервере. Статус карточки всегда «Не проверено».
Подфункции этого файла считает сценарий `claude-code` (`scripts/journey-claude-code.mjs`), главный сценарий их не считает.

## Sub-features

- `harness-card-page`: страница «Harness» из меню: блок «Встроенные» со статусами, окно «Новый harness», карточка в таблице «Свои» (API `/v1/oma/harness_cards` и каталог `GET /v1/oma/harnesses`).
- `harness-card-form`: своя карточка видна в списке Harness формы агента, группа «Свои», чип «Не проверено».
- `harness-card-turn`: агент на своей карточке отвечает в сессии: тестовый ACP-агент в VM получает адрес прокси и токен хода, зовёт модель через прокси с ключом карточки модели, ответ виден в консоли; архив останавливает VM.

## How to get to it (user POV)

- Меню «Разделы консоли», группа «Конфигурация», ссылка «Harness» сразу после «Карточек моделей», маршрут `/harnesses`.
- Кнопка «Новый harness» в шапке или в пустом блоке «Свои». Клик по строке открывает правку, в меню строки «Изменить» и «Удалить».
- В форме агента поле «Harness» раздела «Основное»: группа «Свои», внизу списка ссылка «Добавить свой harness».

## Driving it with Playwright (verify-agent-console)

Preconditions:

- Экземпляр сценария `claude-code` (`VERIFY_PORT=8795 VERIFY_FAKE_PORT=8796 VERIFY_LITEBOX_DISK_SIZE_GB=4 scripts/launch.sh`), `doctor.sh` и `seed-user.sh` с `--run "$RUN"`.
- `launch.sh` задаёт серверу `SANDBOX_GATEWAY_BASE_URL=http://host.boxlite.internal:<VERIFY_PORT>` и `PLATFORM_ROOT_SECRET`: без них ACP-записи каталога «Недоступно».
- Карточка модели `verify-cc-<n>` (провайдер Anthropic, адрес фейка) уже создана шагом `cc-model-card`, окружение `verify-cc-env-<n>` тоже.

- **Страница.** `nav("Harness")`, h1 «Harness». Результат: `getByRole("region", { name: "Встроенные" })`, строка «Claude Code в песочнице» с `claude-acp` и «Готово»; в блоке «Свои» пустое состояние «Своих harness нет» (`harness.page_builtin`).
- **Новая карточка.** `getByRole("button", { name: "Новый harness" }).first()`, окно `dialog "Новый harness"`: `#harness-card-name` «Эхо ACP <n>», `#harness-card-id` `verify-echo-<n>`, `#harness-card-command` `node`, `#harness-card-args` две строки: `-e` и тестовый агент одной строкой, `checkbox "Anthropic Messages"`, «Создать». Результат: тост «Harness создан», строка в таблице «Свои»; `GET /v1/oma/harness_cards` и `GET /v1/oma/harnesses` отдают карточку со статусом `unverified`, `runtime_harness: acp-sandbox` и блоком `acp.agent` с командой `node` (`harness.card_created`).
- **Тестовый агент.** `scripts/acp-echo-agent.cjs`: JSON-RPC по stdio без зависимостей (`initialize`, `session/new`, `session/prompt`). Сценарий склеивает файл в одну строку (строки `//` выбрасываются), строка должна быть не длиннее 2000 знаков (правило аргумента карточки). Пакетов агенту не нужно, `node` есть в образе `node:22-bookworm`.
- **Карточка в форме.** «Новый агент» → «Пустой агент» → `combobox "Harness"`. Результат: пункт `[data-slot="command-item"][data-value^="verify-echo-<n> "]` в группе `[cmdk-group]` с заголовком «Свои», текст с названием и «Не проверено», `aria-disabled` не `true` (`harness.card_in_form`).
- **Агент на карточке.** Выбрать пункт карточки в «Harness» и `verify-cc-<n>` в «Модель». Под полем «Harness» текст «Свой ACP-агент из карточки. Запускается в VM окружения командой node. Не проверено.». «Создать агента». Результат: `GET /v1/agents/:id` → `_oma.harness: acp-sandbox`, `_oma.acp.agent` с `id`, `command: node`, `args: ["-e", <агент>]`; в «Свойства агента» название карточки и «Не проверено» (`harness.card_agent`).
- **Ход.** «Новая сессия» с этим агентом и окружением, сообщение с `VERIFY_ACP_CARD nonce=<m>`. Агент в VM зовёт `${OMA_INFERENCE_BASE_URL}/v1/messages` с `Bearer ${OMA_INFERENCE_TOKEN}` и `model = OMA_MODEL`, фейк отвечает `VERIFY_MODEL_SAW_<m>`. Результат:
  - `agent.message` `VERIFY_ACP_ECHO_<m> model=200:VERIFY_MODEL_SAW_<m> protocol=anthropic-messages base=<шлюз>/v1/oma/inference-proxy/<сессия>/anthropic token=oma_sbx_ keys=ANTHROPIC_AUTH_TOKEN:true,OMA_INFERENCE_TOKEN:true`, `session.status_idle{end_turn}`, без `session.error` (`harness.card_turn`, `harness.card_proxy`). В `keys` агент перечисляет все переменные с KEY, TOKEN, SECRET или PASSWORD в имени и пишет `true`, если значение равно токену хода: `harness.card_proxy` требует `true` у всех, поэтому ключ модели или другой секрет в окружении VM дал бы провал;
  - в журнале фейка запрос `card_reply` с `x-api-key` ключа карточки модели, без Bearer, `model` = `wire_model` (`harness.card_fake_model`);
  - новая строка `[acp-runtime] … command=node` в логе сервера, новый старт VM, на хосте процесса агента нет (`harness.card_in_vm`);
  - в консоли ход завершён и ответ виден (`harness.card_ui_answer`); после архива VM остановлена (`harness.card_vm_stopped`).
- **Доказательство.** `screens/*-cc-harness-*.png`, `screens/*-cc-card-*.png`, `api/cc-26-harness-cards.json`, `api/cc-27-harnesses.json`, `api/cc-60-card-agent.json`, `api/cc-61-card-session-events.json`, `api/cc-62-card-fake-requests.json`.

## Gotchas

- **Аргументы по одному в строке.** Поле «Аргументы» делит текст по строкам (`linesOf` в `pages/harnesses/harness-card-form.ts`), поэтому скрипт агента идёт одной строкой. Многострочный код без точек с запятой после склейки ломается.
- **Адрес прокси из VM.** Карточке нужен адрес сервера, видимый из VM: `SANDBOX_GATEWAY_BASE_URL`. Без него сервер берёт `PUBLIC_BASE_URL` (`http://127.0.0.1:<порт>`), а `127.0.0.1` из VM ведёт в саму VM: агент получил бы адрес, по которому прокси нет.
- **Сеть «Ограниченный».** Фильтр BoxLite 0.9.0 пропускает по имени только порты 80 и 443, шлюз на порту 8795 из такой сети недоступен. Поэтому ход своего агента идёт на окружении «Без ограничений» (окружение сценария Claude Code).
- **Токен в конфигурации хода.** Переменные карточки (`OMA_INFERENCE_TOKEN` и другие) сервер кладёт в `_oma.acp.agent.env` хода (`acpTurnAgent` в `apps/main-node/src/lib/models-harness-wiring.ts`), а токен новый на каждом ходе. Возобновление ACP-сессии своего агента на втором ходе не проверялось (`harness.card_multi_turn` «не проверено»).
- **Ход своего агента долгий.** Агент карточки идёт на окружении сценария Claude Code, и при старте VM ставится его npm-пакет `@agentclientprotocol/claude-agent-acp` (около 25 с), хотя тестовому агенту он не нужен. В прогонах `20261016-081527` и `20261016-082329` ход занял 28 и 35 с.
- **Пакеты карточки не ставятся.** Поля «Пакеты npm» и «Пакеты pip» только подсказывают, что поставить в окружение. Тестовому агенту пакеты не нужны.
