# Окружения

Окружение — именованная настройка песочницы для сессий агента: тип размещения, сеть, пакеты, метаданные.
Пользователь создаёт окружение в консоли, правит его на карточке, архивирует или удаляет.
Работает ли окружение, видно только в сессии. На main-node окружение — это запись в БД без статуса, а VM LiteBox поднимается при первом инструменте агента.

## Sub-features

- `env-create` — создание из списка «Окружения» через окно «Новое окружение» (тип всегда «Облако»).
- `env-detail` — карточка `/environments/:id`: название, описание, сеть, пакеты, метаданные, «Сохранить изменения».
- `env-probe` — доказательство, что песочница этого окружения поднимается и выполняет команду: сессия плюс одна команда bash.
- `env-packages` — пакеты на карточке («Добавить пакет», менеджер, «Пакеты и версии») и их установка в VM новой сессии.
- `env-networking` — «Тип доступа» («Без ограничений» или «Ограниченный»), переключатели MCP и менеджеров пакетов, «Разрешённые хосты» и их действие на сеть VM.
- `env-archive` — «В архив» из меню строки. Архивное окружение доступно только для чтения, сессию на нём не создать.
- `env-delete` — «Удалить» из меню строки с подтверждением.
- `env-filter` — фильтр статуса «Активные», «В архиве», «Все» и поиск «Поиск окружений…».

## How to get to it (user POV)

- Боковое меню, ссылка «Окружения» (горячие клавиши `g` `e`), маршрут `/environments`.
- Кнопка «Новое окружение» в панели списка или в пустом состоянии.
- Клик по строке открывает карточку окружения.
- Правый клик по строке открывает меню «В архив» и «Удалить».
- Из окна «Новая сессия» есть ссылка «Управление окружениями».

## Driving it with Playwright (verify-agent-console)

Preconditions:

- `scripts/doctor.sh` даёт «можно вести». Тестовая учётка вошла в консоль (`#auth-email`, `#auth-password`, «Войти»).
- Имя окружения уникально в прогоне: `verify-env-<nonce>`, не длиннее 50 символов.

- **Открыть список.** Нажать ссылку «Окружения»: `getByRole("navigation", { name: "Разделы консоли" }).getByRole("link", { name: "Окружения", exact: true })`. Результат: URL `/environments`, таблица с подписью «Окружения».
- **Создать.** Нажать `getByRole("button", { name: "Новое окружение" }).first()`. В `getByRole("dialog", { name: "Новое окружение" })` заполнить `getByLabel("Название", { exact: true })` и `getByLabel("Описание (необязательно)")`, затем нажать `getByRole("button", { name: "Создать", exact: true })`. Результат: окно закрылось, в `[data-testid="data-body-table"] tr[data-slot="table-row"]` появилась строка с именем. Переход на карточку при этом не делается.
- **Сверить запись.** Вызвать `GET /v1/environments?limit=100`, найти окружение по `name`, затем `GET /v1/environments/:id`. Результат: `config.type = "cloud"`, `config.networking.type = "unrestricted"`, `archived_at = null`.
- **Карточка.** Кликнуть строку. Результат: URL `/environments/<id>`, h1 с именем, `#env-name` содержит имя, чип «Облако». Кнопки проверки и статуса нет.
- **Правка и настройки (`env-detail`, `env-packages`, `env-networking`).** Это шаги «настройки окружения» и «проба настроек окружения» в `journey-env-to-agent.mjs`. На карточке:
  - заполнить `#env-description`;
  - `getByRole("combobox", { name: "Тип доступа" })` → `getByRole("option", { name: "Ограниченный" })`;
  - `getByRole("switch", { name: "Разрешить сетевой доступ менеджерам пакетов" })`, если `aria-checked` не `true`;
  - «Добавить пакет» → `getByRole("combobox", { name: "Менеджер пакетов" }).last()` → `option "apt"` → `getByRole("textbox", { name: "Пакеты и версии" }).last()` = `jq`;
  - «Сохранить изменения».

  Результат: тост «Окружение сохранено»; `GET /v1/environments/:id` возвращает описание, `config.networking = {type: "limited", allow_package_managers: true, allowed_hosts: []}` и `config.packages.apt = ["jq"]` (`env.settings_saved`).
  Затем новая сессия на этом окружении и три хода bash: `dpkg-query -W -f='${Status}' jq` (ожидается `install ok installed`), `curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com` (ожидается `000`) и `echo` (VM жива). Фактически 2026-10-15: `pkg_jq=missing` (`env.packages_applied` — провал), сетевой ход обрывает exec (`env.networking_limited_applied` — провал).
- **Проба песочницы (`env-probe`).** Выполнить `scripts/journey.sh`, шаг «проба окружения» в `journey-env-to-agent.mjs`. По API создаются агент с одним bash и сессия `{agent, environment_id}`, затем отправляется `user.message` с командой `echo VERIFY_OK_<n> && echo kernel=$(uname -r) …`. Результат:
  - в журнале `GET /v1/sessions/:id/events` есть `agent.tool_result` с `VERIFY_OK_<n>`;
  - `kernel=` отличается от `uname -r` хоста;
  - в `<прогон>/data/sandboxes/<session>/.openma/` есть `litebox-scratch-*`;
  - в `BOXLITE_HOME/logs/*` после начала прогона есть «Box started successfully»;
  - процесс `libkrun VM` с pid из строки `boxlite-shim subprocess spawned box_id=… pid=N` лога BoxLite — потомок server-node прогона (проверка `env.probe.vm_process`).

  Строки «creating box (image=…)» в логе сервера нет: логгер litebox-sandbox на main-node — заглушка (`litebox.ts:34`, адаптер грузится в `components.ts:90` раньше `setRootLogger` в `modules/node-foundation.ts:98`). В `summary.md` это «внимание», не провал.

  После `POST /v1/sessions/:id/archive` появляется «Box stopped», а scratch удаляется.
- **Архив.** Правый клик по строке, пункт «В архив». Результат: строка пропадает из фильтра «Активные». `GET /v1/environments/:id` возвращает `archived_at` не `null`. `POST /v1/environments/:id` отвечает 409 «archived and read-only». Создание сессии на этом окружении даёт ошибку `dependency_not_found`.
- **Удаление.** Правый клик по строке, пункт «Удалить», в окне «Удалить окружение «<имя>»?» нажать «Удалить». Результат: `GET /v1/environments/:id` отвечает 404.
- **Сеть «Без ограничений» (база).** В сессии первой пробы, после основной команды: ход `curl … https://example.com` и ход `echo`. Ожидается код 2xx/3xx и живая VM (`env.probe.network`); база — код того же адреса с хоста (`fetch` в сценарии). Если с хоста адрес недоступен, строка «не проверено».
- **Доказательство.** Сохранить `screens/*environment*.png`, `aria/*environment-detail.yml`, `aria/*environment-saved.yml`, `api/10-environment.json`, `api/12-environment-configured.json`, `api/21-probe-session-events.json`, `api/21b-probe-network-events.json`, `api/22-settings-probe-events.json`, `api/22b-settings-network-events.json` и итоговые строки `env.*` в `summary.md`.

## Gotchas

- Действия «проверить окружение» нет ни в консоли, ни в managed API. Песочница ленивая (`apps/main-node/src/lib/node-session-router.ts:41`). Работу окружения доказывает только сессия с вызовом инструмента. Отсутствие ошибок при создании ничего не доказывает.
- Пакеты окружения (apt, npm, pip …) на main-node не ставятся: установка (`ensureSetupApplied`) вызывается только в Cloudflare SessionDO (`apps/agent/src/runtime/session-do.ts:3608`), в `apps/main-node` ссылок на неё нет. Прогон 2026-10-15 это подтвердил: после сохранения `apt jq` новая VM даёт `pkg_jq=missing`. Подпись на карточке «ставятся при сборке песочниц» этому не соответствует.
- Сеть «Ограниченный» в коде не доходит до VM: LiteBox всегда создаётся с `network: { mode: "enabled" }` (`packages/sandbox-adapter-litebox/src/litebox.ts:325`). Ограничение действует только на `web_fetch` и MCP.
- **Любой сетевой запрос из VM на этом стенде ломает песочницу.** И `curl https://example.com`, и `getent hosts example.com` дают в `tool_result` строку `Attach stream error: status: Unknown, message: "h2 protocol error: error reading a body from connection"` и `[exit -1]`; вывод команды до обрыва теряется. Следующая команда в той же VM получает `[error: gRPC/tonic error: status: Unavailable, message: "Connection refused (os error 111)"]`. Это видно при обеих настройках сети, поэтому блокировку «Ограниченный» на этом стенде не увидеть. `tool_result.is_error` при этом `false`. Почему рвётся поток BoxLite (сеть хоста, NAT, gvproxy), не выяснялось. Сетевые команды держите в отдельном ходе в конце сессии, чтобы не сломать остальные проверки.
- Удаление окружения не проверяет активные сессии (`packages/managed-agents-application/src/environments/application.ts:250-260`). Если удалить окружение раньше сессии, архивировать или удалить эту сессию не получится («Environment … was not found while stopping Session»), и VM не остановится. Порядок уборки: сначала сессии, потом окружение.
- Первый старт VM в новом `BOXLITE_HOME` скачивает образ `node:22-bookworm` и собирает диск образа: в прогоне 2026-10-15 первый ход занял около 1 минуты, кэш `~/.cache/verify-agent-console/boxlite` вырос до 3 ГБ. Следующие пробы идут за 2–3 с. Таймаут первого хода 900 с.
- В каждом выводе bash есть строка stderr рантайма VM `libcontainer::process::init::process: seccomp not available, unable to set seccomp privileges!` с ANSI-цветами. Её видят модель и пользователь в карточке инструмента. Ищите маркер `VERIFY_OK_<n>` подстрокой, а не сравнением всего вывода.
- Окно создания закрывается без перехода на карточку. Ждите строку в таблице, а не смену URL.
- Если тип размещения не выбран, всегда создаётся `cloud`. Для `self_hosted` сессии уходят в очередь Environment Work, где LiteBox не участвует.
