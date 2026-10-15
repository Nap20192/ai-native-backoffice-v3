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
  - `getByRole("textbox", { name: "Разрешённые хосты" })` = `example.org`;
  - «Добавить пакет» → `getByRole("combobox", { name: "Менеджер пакетов" }).last()` → `option "apt"` → `getByRole("textbox", { name: "Пакеты и версии" }).last()` = `jq`;
  - «Сохранить изменения».

  Результат: тост «Окружение сохранено»; `GET /v1/environments/:id` возвращает описание, `config.networking = {type: "limited", allow_package_managers: true, allowed_hosts: ["example.org"]}` и `config.packages.apt = ["jq"]` (`env.settings_saved`).
  Затем новая сессия на этом окружении и три хода bash: `dpkg-query -W -f='${Status}' jq` (ожидается `install ok installed`), `curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com` (ожидается `000`) и тот же `curl` для `https://example.org` (ожидается `200`) одним ходом, затем `echo` (VM жива). Прогон 2026-10-16 (`20261016-002808`): `pkg_jq=install ok installed` (`env.packages_applied`), `example.com` даёт 000, VM отвечает (`env.networking_limited_applied`); обе проверены. 2026-10-15 обе были провалом. Разрешённый пользователем хост проверяется с прогона `20261016-040020` (последний `20261016-041400`): `example.org` из VM отвечает 200 (`env.networking_allowed_host`).
- **Проба песочницы (`env-probe`).** Выполнить `scripts/journey.sh`, шаг «проба окружения» в `journey-env-to-agent.mjs`. По API создаются агент с одним bash и сессия `{agent, environment_id}`, затем отправляется `user.message` с командой `echo VERIFY_OK_<n> && echo kernel=$(uname -r) …`. Результат:
  - в журнале `GET /v1/sessions/:id/events` есть `agent.tool_result` с `VERIFY_OK_<n>`;
  - `kernel=` отличается от `uname -r` хоста;
  - в `<прогон>/data/sandboxes/<session>/.openma/` есть `litebox-scratch-*`;
  - в `BOXLITE_HOME/logs/*` после начала прогона есть «Box started successfully»;
  - процесс `libkrun VM` с pid из строки `boxlite-shim subprocess spawned box_id=… pid=N` лога BoxLite — потомок server-node прогона (проверка `env.probe.vm_process`).

  В логе сервера есть строки `litebox-sandbox`: `creating box (image=…, network=unrestricted | allow N host(s) | disabled)`, для «Ограниченного» `pinned N allowed host(s) in /etc/hosts`, затем `installing environment packages (…)` и `environment packages installed in N ms`. Логгер берётся в момент записи (`moduleLogger` в `litebox.ts`), поэтому строки попадают в корневой логгер main-node (`*.server_log_box`).

  После `POST /v1/sessions/:id/archive` появляется «Box stopped», а scratch удаляется.
- **Архив.** Правый клик по строке, пункт «В архив». Результат: строка пропадает из фильтра «Активные». `GET /v1/environments/:id` возвращает `archived_at` не `null`. `POST /v1/environments/:id` отвечает 409 «archived and read-only». Создание сессии на этом окружении даёт ошибку `dependency_not_found`.
- **Удаление.** Правый клик по строке, пункт «Удалить», в окне «Удалить окружение «<имя>»?» нажать «Удалить». Результат: `GET /v1/environments/:id` отвечает 404.
- **Сеть «Без ограничений» (база).** В сессии первой пробы, после основной команды: ход `curl … https://example.com` и ход `echo`. Ожидается код 2xx/3xx и живая VM (`env.probe.network`); база — код того же адреса с хоста (`fetch` в сценарии). Если с хоста адрес недоступен, строка «не проверено».
- **Доказательство.** Сохранить `screens/*environment*.png`, `aria/*environment-detail.yml`, `aria/*environment-saved.yml`, `api/10-environment.json`, `api/12-environment-configured.json`, `api/21-probe-session-events.json`, `api/21b-probe-network-events.json`, `api/22-settings-probe-events.json`, `api/22b-settings-network-events.json` и итоговые строки `env.*` в `summary.md`.

## Gotchas

- Действия «проверить окружение» нет ни в консоли, ни в managed API. Песочница ленивая (`NodeSessionRouter.init`, `apps/main-node/src/lib/node-session-router.ts`). Работу окружения доказывает только сессия с вызовом инструмента. Отсутствие ошибок при создании ничего не доказывает.
- **Как настройки окружения доходят до VM.** main-node передаёт `{packages, networking}` облачного окружения в фабрику песочницы (`buildSandbox` в `apps/main-node/src/modules/node-managed.ts` и в `node-foundation.ts`). Адаптер LiteBox ставит пакеты один раз после загрузки VM скриптом `buildEnvironmentSetupScript` (`packages/sandbox/src/environment-setup.ts`), таймаут 600 с; сбой установки останавливает VM, и ход получает ошибку с хвостом вывода. «Ограниченный» превращается в `allowNet` BoxLite (`liteBoxNetwork` в `litebox.ts`): разрешённые хосты, реестры пакетов (если разрешены) и хост vault-прокси; если не разрешено ничего, сеть выключается. `allow_mcp_servers` сеть VM не открывает: MCP ходит с хоста.
- **DNS allowlist BoxLite 0.9.0 случайно отвечает 0.0.0.0.** Зоны DNS для `allowNet` строятся из Go map (`gvproxy-bridge/dns_filter.go` в boxlite-ai/boxlite v0.9.0), порядок меняется от ящика к ящику, а совпадение первое по суффиксу. Зона хоста-апекса (`pypi.org`, `rubygems.org` → `org.`) может встать раньше зоны `debian.org.` и ответить 0.0.0.0 для `deb.debian.org`. Прогон `20261016-001648`: в пробе настроек `jq` встал, а в главной сессии на том же окружении apt упал с `Could not connect to debian.map.fastlydns.net:80 (0.0.0.0)`. В отдельных VM `deb.debian.org` давал 0.0.0.0 в 4 ящиках из 8, и в каждом ящике какой-то из реестров уходил в 0.0.0.0. Обход в адаптере: точные разрешённые имена резолвятся на хосте и дописываются в `/etc/hosts` VM (`pinAllowedHosts` в `litebox.ts`); TCP BoxLite всё равно фильтрует по SNI и заголовку Host на портах 80 и 443. Маски `*.example.com` так не закрепить, они по-прежнему зависят от порядка зон. Что обход не закрывает, адаптер с 2026-10-16 пишет в лог предупреждением при создании ящика (`allowlistWarnings` в `litebox.ts`): маски и хост vault-прокси не закреплены; при заданном `OMA_VAULT_PROXY_URL` клиент с `HTTPS_PROXY` ходит через прокси на любой хост, и `allowNet` его не ограничивает; «Ограниченный» без разрешённых хостов отключает сеть целиком, vault-прокси тоже. Адреса закрепляются один раз при старте VM: у CDN-хостов (`deb.debian.org` раздаёт Fastly) они могут устареть в долгой VM. Полное решение: BoxLite ≥0.10 с переделанным `allow_net`, не проверялось. Хост, который разрешил пользователь, проверяет `env.networking_allowed_host`: `example.org` из VM отвечает 200 (прогоны `20261016-040020` и `20261016-041400`). Установка через pip, cargo, go и gem в VM не проверялась. С `/etc/hosts` в VM: npm, pypi, deb.debian.org отвечают 200, `example.com` 000, VM жива (2 ящика подряд).
- **Сетевой запрос из VM ронял песочницу (до 2026-10-16).** `curl https://example.com` и `getent hosts example.com` давали `Attach stream error … h2 protocol error` и `[exit -1]`, следующая команда получала `Connection refused (os error 111)`. Причина: boxlite-shim собран статически с glibc и отвечает на DNS гостя через cgo-резолвер Go, статический `getaddrinfo` грузит NSS-модули хоста (`hosts: mymachines resolve …`), и shim падает с SIGSEGV. Обход: `withShimDnsWorkaround` (`litebox.ts`) ставит `GODEBUG=netdns=go` в окружение main-node только на время загрузки ящика (первый exec, в нём BoxLite запускает shim), shim его наследует, потом прежнее значение возвращается. Дочерние процессы сервера, запущенные в это окно (секунды), тоже его получат. Если `GODEBUG` с `netdns` задан в окружении запуска сервера, адаптер его не трогает. Это обход сборки boxlite-shim (gvproxy без тега `netgo`), а не исправление; задача на сборку в BoxLite не заведена. Если VM умрёт по другой причине, адаптер её не пересоздаёт.
- С `allowNet` имена неразрешённых хостов не резолвятся (0.0.0.0), но имена разрешённых хостов, ушедших в 0.0.0.0 по ошибке зон, без `/etc/hosts` тоже дали бы 000. Различайте по строке `pinned N allowed host(s)` в логе сервера.
- Удаление окружения не проверяет активные сессии (`packages/managed-agents-application/src/environments/application.ts:250-260`). Если удалить окружение раньше сессии, архивировать или удалить эту сессию не получится («Environment … was not found while stopping Session»), и VM не остановится. Порядок уборки: сначала сессии, потом окружение.
- Первый старт VM в новом `BOXLITE_HOME` скачивает образ `node:22-bookworm` и собирает диск образа: в прогоне 2026-10-15 первый ход занял около 1 минуты, кэш `~/.cache/verify-agent-console/boxlite` вырос до 3 ГБ. Следующие пробы идут за 2–3 с. Таймаут первого хода 900 с.
- Рантайм VM пишет в начало stderr каждой команды `libcontainer::process::init::process: seccomp not available, unable to set seccomp privileges!` с ANSI-цветами. Адаптер срезает только такие ведущие строки (`stripRuntimeNoise`, `litebox.ts`), собственный stderr команды не трогает (`*.tool_output_clean`). Маркер `VERIFY_OK_<n>` всё равно ищите подстрокой.
- Окно создания закрывается без перехода на карточку. Ждите строку в таблице, а не смену URL.
- Если тип размещения не выбран, всегда создаётся `cloud`. Для `self_hosted` сессии уходят в очередь Environment Work, где LiteBox не участвует.
