# CMA: окружения, песочница, файлы

Разбор пяти страниц документации Claude Managed Agents и сверка с нашей копией Open Managed Agents в `platform/`. Дата сверки 17.10.2026. Код смотрели на ветке `feat/agent-console` с незакоммиченными правками. Области ACP, карточек харнесов и CLI-моста не смотрели, их сейчас удаляют.

## 1. Коротко

Окружение в CMA задаёт, где работают инструменты агента. Облачное окружение даёт каждой сессии свой Linux-контейнер. В нём есть правила сети, список пакетов и готовый набор языков и утилит. Self-hosted окружение отдаёт выполнение bash и файловых инструментов вашему воркеру.

К сессии можно подключить файлы из Files API и репозитории GitHub. Файлы ложатся в `/mnt/session/uploads/` только для чтения. Агент пишет результаты в `/mnt/session/outputs/`, и их потом скачивают через Files API с фильтром по сессии.

У нас есть всё основное. Работают CRUD окружений, сеть `limited` и `unrestricted`, пакеты, свой каталог образов, файлы, репозитории и выходные файлы. Слабые места такие. Агент может прочитать токен GitHub. Проверка пакетов и маршрут каталога образов написаны, но не подключены. Стандартный `GET /v1/files?scope_id=` не показывает выходные файлы обычной сессии.

## 2. Что говорит документация

Все страницы помечены как beta и требуют заголовок `anthropic-beta: managed-agents-2026-04-01`. Files API вышел из беты, загрузке и скачиванию заголовок не нужен. Фильтр `scope_id` в списке файлов требует тот же `managed-agents-2026-04-01`.

### 2.1 Выбор окружения

Страница объясняет два варианта, облако и свой сервер. Модель, промпт и инструменты задаются на агенте, окружение их не меняет.

| Вопрос | Облако, по умолчанию | Self-hosted |
|---|---|---|
| Где работают инструменты | Контейнер Anthropic | Ваш воркер |
| Что уходит в Anthropic | История, результаты инструментов, файлы песочницы, навыки, память | История, результаты инструментов, навыки, память. Файлы и процессы остаются у вас |
| Сеть | Правила окружения | Ваша политика |
| Файлы и репозитории | Монтирует Anthropic | Монтируете сами |
| Память | `/mnt/memory/` | Воркер скачивает в `/mnt/memory/` и синхронизирует |

При переходе на self-hosted пропадают ресурсы `file` и `github_repository`, навыки из репозитория, переменные окружения из сейфа и готовый набор пакетов. Нужны окружение `self_hosted`, ключ окружения из Claude Console и запущенный воркер. Web search и web fetch в обоих вариантах работают на стороне Anthropic.

### 2.2 Облачное окружение

Окружение создают один раз и передают его `environment_id` при создании сессии. Сессии одного окружения не делят файловую систему.

Поля объекта. `id` вида `env_...`, `name`, `description`, `metadata`, `config`, `archived_at`, `created_at`, `updated_at`. В `config` лежат `type` со значением `cloud` или `self_hosted`, `networking` и `packages`. У `self_hosted` других полей нет.

| Метод | Путь | Что делает |
|---|---|---|
| POST | `/v1/environments` | Создать |
| GET | `/v1/environments` | Список, постранично |
| GET | `/v1/environments/{id}` | Получить |
| POST | `/v1/environments/{id}` | Изменить. Действует только на новые контейнеры |
| POST | `/v1/environments/{id}/archive` | Архив. Только чтение, старые сессии работают, новые нельзя. Обратного шага нет |
| DELETE | `/v1/environments/{id}` | Удалить, если на окружение не ссылаются сессии |

Сеть задаёт поле `networking`.

- `unrestricted` открывает весь интернет, кроме общего чёрного списка. API ставит его, если `networking` не передали. Форма в Claude Console начинает с `limited`.
- `limited` закрывает всё, кроме `allowed_hosts`. Хост пишут без схемы, порта и пути. `example.com` не совпадает с `www.example.com`. `*.example.com` ловит поддомены, но не сам `example.com`.
- `allow_package_managers`, по умолчанию `false`, открывает реестры пакетов и хостинги кода. В списке Anthropic есть GitHub, GitLab, Bitbucket, npm, PyPI, crates, Go proxy, Maven, Gradle, RubyGems, Packagist, Ubuntu и Docker Hub с ghcr.io.
- `allow_mcp_servers`, по умолчанию `false`, открывает адреса MCP-серверов агента.

Правила и ошибки:

- `packages` при `limited` без `allow_package_managers` дают ответ 400, даже если реестр есть в `allowed_hosts`.
- Если агент объявил MCP-сервер, хоста которого нет в `allowed_hosts`, а `allow_mcp_servers` выключен, создание сессии падает с 400. То же для агентов, которым он передаёт работу.
- Запрос из песочницы на 80 или 443 к закрытому хосту получает 403 с именем хоста.
- При `limited` список `allowed_hosts` действует и на `web_fetch`, `web_search`. Пустой список значит, что эти инструменты ничего не вернут. Справочник из скилла claude-api пишет обратное, там сеть окружения на них не влияет. Верим странице, она новее.
- Файлы, память и репозитории сессии доступны при любой сети.

Документация предупреждает, что доступ даётся на хост, а не на операцию. Через открытый хост агент может сделать `git push` или выложить пакет. Для недоверенного ввода советуют политику `always_ask` для `bash`. Про `unrestricted` сказано, что агент может менять данные на чужих сайтах, а всё из песочницы может уйти наружу.

Пакеты задаёт поле `packages` со списками `apt`, `cargo`, `gem`, `go`, `npm`, `pip`. Версию пишут в синтаксисе менеджера, например `sqlalchemy==2.0.30` или `express@4.18.0`. Менеджеры идут по алфавиту. Установленные пакеты кешируются для всех сессий окружения.

Справочник скилла claude-api добавляет ещё три правила. Имя окружения уникально, повтор даёт 409. На все операции с окружениями лимит 60 запросов в минуту и 5 одновременных. Окружения не версионируются, историю правок ведите сами.

### 2.3 Справочник облачной песочницы

| Свойство | Значение |
|---|---|
| ОС | Ubuntu 24.04 LTS, x86_64 |
| Память | до 8 ГБ |
| Диск | до 10 ГБ |
| Сеть | Из API по умолчанию `unrestricted`, из Claude Studio `limited` |

Языки. Python 3.10 до 3.13 с pip, uv и poetry. Node.js 20, 21 и 22 с npm, yarn, pnpm и bun. Go 1.24 и 1.25, Rust stable, OpenJDK 21, Ruby 3.1 до 3.3, PHP 8.3, GCC 13 и Clang. Для `python3` уже стоят NumPy, pandas, Matplotlib, openpyxl, python-docx, python-pptx и pypdf.

Базы. PostgreSQL 16 и Redis 7 установлены, но не запущены. SQLite доступен через привязки языков.

Утилиты. git, curl, wget, jq, yq, архиваторы, tmux, make, cmake, ripgrep, docker с ограничениями. Для документов есть ffmpeg, ImageMagick, pandoc, LibreOffice без интерфейса, poppler, qpdf, tesseract с английским и TeX Live. Playwright для Python и Node работает с Chromium из `/opt/pw-browsers`. Firefox и WebKit нет.

### 2.4 Доступ к GitHub

Репозиторий подключают ресурсом `github_repository` в `resources` при создании сессии.

| Поле | Обязательно | Смысл |
|---|---|---|
| `type` | да | `github_repository` |
| `url` | да | Только `https://github.com/<owner>/<repo>` без `.git`. SSH и другие формы дают `invalid_request_error` |
| `authorization_token` | да | Токен для клона. В ответах API его нет |
| `mount_path` | нет | Папка под `/workspace`, по умолчанию `/workspace/<repo>` |
| `checkout` | нет | Ветка `{type: branch, name}` или коммит `{type: commit, sha}`. По умолчанию ветка по умолчанию |

Можно подключить несколько репозиториев. Anthropic кеширует их, следующие сессии стартуют быстрее. Навыки из `.claude/skills` в корне репозитория загружаются один раз при старте сессии.

На живой сессии `GET /v1/sessions/{id}/resources` отдаёт ресурсы с id вида `sesrsc_...`. `POST /v1/sessions/{id}/resources/{resource_id}` с новым `authorization_token` меняет токен. Поменять набор репозиториев нельзя, нужна новая сессия.

Права токена. Для клона приватного репозитория и PR нужен `repo`. Для чтения и создания issues в публичном репозитории хватает `public_repo`. Советуют fine-grained токен с минимумом прав.

Pull request агент делает через GitHub MCP-сервер `https://api.githubcopilot.com/mcp/`. Сервер объявляют на агенте без токена, токен для MCP лежит в сейфе сессии. Справочник скилла уточняет, что токен репозитория не попадает в контейнер. Git-прокси Anthropic подставляет его уже снаружи песочницы.

### 2.5 Файлы

Файл сначала грузят через Files API, `POST /v1/files`. Потом подключают ресурсом `{type: file, file_id, mount_path}`.

- Путь кладётся под `/mnt/session/uploads/`. `mount_path` `/data.csv` даёт `/mnt/session/uploads/data.csv`.
- Без `mount_path` файл лежит в `/mnt/session/uploads/<file_id>`.
- Родительские папки создаются сами. Путь должен начинаться с `/`.
- Файлы только для чтения. Изменённую версию агент пишет по новому пути.
- Сессия получает свою копию с новым `file_id`. Копии не считаются в лимит хранилища.
- На сессию до 500 файлов. Справочник скилла называет 999, верим странице.

На живой сессии файл добавляют `POST /v1/sessions/{id}/resources`, убирают `DELETE /v1/sessions/{id}/resources/{resource_id}`.

Агент пишет результаты в `/mnt/session/outputs/`. Их список даёт `GET /v1/files?scope_id=sesn_...` с заголовком `managed-agents-2026-04-01`. Файл появляется через несколько секунд после того, как сессия ушла в idle. Если файла нет, список запрашивают ещё раз. Скачивание идёт через `GET /v1/files/{id}/content`. Тип файла любой, архивы агент распаковывает сам.

## 3. Как у нас

Пути ниже даны от `platform/`. Метка «есть и работает» значит, что код подключён к маршрутам Node. Работу в живой VM мы в этом разборе не проверяли.

| Функция | В CMA | У нас | Где |
|---|---|---|---|
| CRUD окружений | есть | есть и работает | `packages/managed-agents-api/src/routes/environments.ts:45,82,118,140,195,231`, монтирование `apps/main-node/src/modules/node-http.ts:646` |
| Разархивация | нет, архив окончательный | есть, наше расширение | `routes/environments.ts:264`, `packages/managed-agents-application/src/environments/application.ts:379` |
| Уникальное имя, 409 | есть | нет | `environments/application.ts:179` не проверяет имя |
| `unrestricted` по умолчанию в API | есть | есть и работает | `environments/application.ts:107` |
| `limited` и `allowed_hosts` | есть, 403 с именем хоста | частично. BoxLite режет TCP по списку, 403 нет. Шаблоны `*.` работают ненадёжно. Если разрешённых хостов нет совсем, сеть VM выключена целиком | `packages/sandbox-adapter-litebox/src/litebox.ts:1004,1044` |
| Хосты `allow_package_managers` | реестры, GitHub, Docker, Maven | частично. Только реестры шести менеджеров и зеркала Debian, Ubuntu, Alpine | `packages/sandbox/src/environment-setup.ts:128` |
| 400 за пакеты без `allow_package_managers` | есть | нет. Принимаем, VM падает при установке с подсказкой | `litebox.ts:691` |
| Проверка MCP-хостов при создании сессии | 400 | частично. MCP-инструменты молча выключаются | `apps/agent/src/harness/tools.ts:1204`, `node-managed.ts:407` |
| Сеть окружения для `web_fetch` и `web_search` | есть | частично. `web_fetch` получает сеть окружения. Флаг `allow_web_search` хранится, но рантайм его не читает | `tools.ts:831`, `packages/managed-agents-api/src/contracts/environments.ts:17` |
| Пакеты шести менеджеров | есть, с кешем | частично. Ставим при каждом старте VM, без кеша, таймаут 600 с, порядок свой | `litebox.ts:74,677`, `environment-setup.ts:143` |
| Проверка имён пакетов и политика оператора | нет | в коде, не подключено. `createEnvironmentConfigPolicy` вызывают только тесты | `apps/main-node/src/lib/environment-config-policy.ts:164`, `packages/managed-agents-app/src/modules/environments.ts:41` |
| Образ песочницы | один образ Ubuntu 24.04 | частично. Свой каталог `config.image`. Образ `workplace` на Debian bookworm с Node 22, Python 3.11, uv, OCR и шрифтами, `workplace-office` добавляет LibreOffice. Go, Rust, Java, Ruby, PHP, Postgres, Redis и Playwright нет | `sandbox-images/catalog.json`, `sandbox-images/Dockerfile:3`, `node-managed.ts:443` |
| Каталог образов в консоли | нет | в коде, не подключено. `GET /v1/oma/sandbox-catalog` не смонтирован, консоль прячет раздел «Образ» | `apps/main-node/src/lib/sandbox-catalog-routes.ts:79`, `apps/console/src/lib/sandbox-catalog.ts:219` |
| Память, диск, CPU | 8 ГБ, 10 ГБ | есть и работает. Задаёт каталог, от 512 МиБ и 4 ГБ до 2 ГиБ и 8 ГБ | `sandbox-images/catalog.json`, `litebox.ts:570` |
| Self-hosted окружение и воркер | есть | есть. Маршруты work, poll, ack, heartbeat, stop, stats | `routes/environment-work.ts:38`, `node-http.ts:476` |
| Запрет file и github для self-hosted | есть | нет | `packages/managed-agents-application/src/sessions/resource-resolver-service.ts:100` |
| `github_repository` при создании сессии | есть | есть и работает | `contracts/sessions.ts:84`, `apps/main-node/src/lib/node-managed-session-inputs.ts:296,430` |
| Проверка URL репозитория | только `https://github.com/o/r` | частично. Любой адрес http или https, `.git` срезаем | `resource-resolver-service.ts:22` |
| Токен не попадает в песочницу | git-прокси | нет. Токен уходит в `GIT_CONFIG_*` каждой команде, что начинается с `git`. Агент может прочитать его через `git config` | `node-managed-session-inputs.ts:306`, `litebox.ts:763` |
| Клон при `limited` | репозиторий доступен всегда | частично. Клон идёт из VM, нужен `github.com` в `allowed_hosts` | `node-managed-session-inputs.ts:430`, `litebox.ts:567` |
| Кеш репозиториев | есть | нет. Есть только повторное использование сохранённого workspace | `node-managed-session-inputs.ts:396` |
| Смена токена на живой сессии | есть | частично. API есть, кнопки в консоли нет | `routes/session-resources.ts:152`, `apps/console/src/components/session/inspector/ResourcesTab.tsx:30` |
| Навыки из `.claude/skills` репозитория | есть | нет | поиск по коду ничего не нашёл |
| Репозиторий в форме сессии | есть | есть и работает | `apps/console/src/components/ResourceListEditor.tsx:111`, `apps/console/src/pages/SessionsList.tsx:767` |
| Files API | есть, без беты | частично. Все пять операций есть, но маршрут требует `files-api-2025-04-14`. Запрос из примера CMA только с `managed-agents-2026-04-01` получит 400 | `routes/files.ts:28`, `packages/managed-agents-api/src/beta.ts:5`, `node-http.ts:651` |
| Путь файла по умолчанию | `/mnt/session/uploads/<file_id>` | есть и работает | `resource-resolver-service.ts:111` |
| `mount_path` под `/mnt/session/uploads` | есть | нет. Пишем ровно по указанному пути | `node-managed-session-inputs.ts:336` |
| Файлы только для чтения | есть | нет | `node-managed-session-inputs.ts:336` |
| Не больше 500 файлов | есть | нет | `resource-resolver-service.ts:51` |
| Добавить и убрать файл на живой сессии | есть | есть и работает, только `file` | `routes/session-resources.ts:74,204`, `contracts/session-resources.ts:17`, `ResourcesTab.tsx:134,150` |
| Выходные файлы | `/v1/files?scope_id=` | частично. Собираем `/mnt/session/outputs` в `outputsRoot`, отдаём через `/v1/sessions/{id}/outputs` и `/v1/oma/files`. Стандартный список видит только файлы с источником `session_output`, а их пишет путь OpenAI-совместимости | `apps/main-node/src/lib/node-managed-session-outputs.ts:17`, `routes/session-outputs.ts:73`, `node-http.ts:801`, `managed-agents-application/src/files/application.ts:115` |
| Страница «Файлы» в консоли | нет | есть и работает. Загрузка, скачивание, фильтр по сессии | `apps/console/src/pages/FilesList.tsx:43,94,111` |
| Страница окружения в консоли | форма начинает с `limited` | частично. Есть сеть, пакеты, архив и удаление. Пустой шаблон создаёт окружение без ограничений сети, переключателя веб-поиска нет | `apps/console/src/pages/EnvironmentDetail.tsx:324,403,520`, `apps/console/src/lib/environment-templates.ts:129` |

## 4. Что добавить

Сначала. Это закрывает утечки и делает песочницу предсказуемой для бэк-офиса.

1. Убрать токен GitHub из песочницы. Сейчас любой `bash`, что начинается с `git`, получает токен в переменных. Нужен прокси на хосте, как git-прокси в CMA, или хотя бы credential helper вне VM.
2. Подключить `createEnvironmentConfigPolicy` в модуль окружений. Код и тесты готовы. Сразу добавить 400 для `packages` при `limited` без `allow_package_managers`. Оператор получит белый список пакетов, ошибка придёт при сохранении, а не при старте VM.
3. Смонтировать `/v1/oma/sandbox-catalog`. Консоль уже умеет показывать образы и шаблоны, ей не хватает только маршрута.
4. Отдавать выходные файлы сессии через `GET /v1/files?scope_id=` и принимать Files API без беты. Бухгалтер или менеджер скачивает отчёт агента, а клиентский код на SDK CMA сейчас его не видит.
5. Пустое окружение в консоли создавать с `limited`, как в Claude Console. Бэк-офис работает с данными клиентов, открытый интернет по умолчанию опасен.

Потом.

1. Класть `mount_path` под `/mnt/session/uploads` и делать файлы только для чтения. Иначе агент может испортить исходный документ, а пути не совпадают с CMA.
2. Отвечать 400 при создании сессии, если MCP-хост закрыт сетью. Сейчас инструменты молча пропадают, и оператор не понимает, почему агент их не видит.
3. Решить судьбу `allow_web_search`. Либо читать его в рантайме, либо применять `allowed_hosts` к `web_search`, как в CMA.
4. Открывать хост репозитория, когда к сессии подключён `github_repository`, или клонировать на хосте. Тогда репозиторий работает при закрытой сети.
5. Кешировать пакеты окружения, например собирать производный образ. Каждый старт VM сейчас ставит пакеты заново.
6. Кнопка смены токена репозитория во вкладке ресурсов сессии.
7. Лимит 500 файлов на сессию.

Позже.

1. Навыки из `.claude/skills` подключённого репозитория.
2. Строгая проверка URL репозитория и уникальные имена окружений с ответом 409.
3. Шире список хостов `allow_package_managers`, если появятся задачи с Docker или Maven.

Не нужно.

1. Повторять полный образ CMA с Go, Rust, Java, Ruby, PHP и TeX. Бэк-офису хватает Python, Node, OCR и LibreOffice из наших образов. Лишние языки только увеличат образ.
2. Убирать разархивацию окружений. Она удобна оператору и не мешает клиентам CMA.

## 5. Источники

- https://platform.claude.com/docs/en/managed-agents/choosing-an-environment
- https://platform.claude.com/docs/en/managed-agents/environments
- https://platform.claude.com/docs/en/managed-agents/cloud-sandboxes-reference
- https://platform.claude.com/docs/en/managed-agents/github
- https://platform.claude.com/docs/en/managed-agents/files
- Справочник скилла claude-api, файлы `shared/managed-agents-environments.md`, `shared/managed-agents-api-reference.md`, `shared/managed-agents-self-hosted-sandboxes.md`
