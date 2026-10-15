# Окружения: рабочее место агента

Черновик 1, 2026-10-16. Статус: проект, код не менялся, в VM ничего не запускалось.

Запрос владельца: «в окружении нет инструментов для работы агентов, например создание презентаций, и непонятно, что с этим делать, потому что агент вроде как не может устанавливать и расширять». Удаление лого OpenMA идёт отдельной задачей.

Наблюдения в пробной консоли (консоль 5174, сервер 8788). У окружения «Песочница по умолчанию» сеть «Без ограничений» и нет пакетов. Агент «Глубокий исследователь» на Qwen упал на `ModuleNotFoundError: No module named 'bs4'` и не стал ставить пакет. В VM есть только `python3`, VM работает от root в `/workspace`. web_search получает «DuckDuckGo rate limited», часть web_fetch падает на защите Cloudflare и «fetch failed».

Входы: разведка кода, документация Claude Managed Agents (environments, cloud-sandboxes-reference, skills, tools-web-restrictions на platform.claude.com), packages.debian.org и PyPI для размеров, планы [builder-agent.md](builder-agent.md), [console-parity.md](console-parity.md), [models-harness-analytics.md](models-harness-analytics.md), `docs/components/04-sandbox.md`.

Пути:

- `C/` это `platform/apps/console/src`;
- `N/` это `platform/apps/main-node/src`, `NT/` это `platform/apps/main-node/test`;
- `A/` это `platform/apps/agent/src`, `AT/` это `platform/apps/agent/test`;
- `P/` это `platform/packages`;
- `I/` это `platform/sandbox-images` (новая папка);
- `S/` это `.claude/skills/verify-agent-console`.

W4 это поток «Claude Code в песочнице». Его файлы `P/sandbox/src/environment-setup.ts`, `P/sandbox-adapter-litebox/src/litebox.ts`, `N/modules/node-managed.ts` и `acp-*` этот план правит только после коммита W4.

## 0. Коротко

1. Агент может ставить пакеты сам, потому что VM работает от root, а у «Песочницы по умолчанию» сеть открыта. Мешают три вещи. Образ `node:22-bookworm` (`P/sandbox-adapter-litebox/src/litebox.ts:75, 485`) не содержит pip, офисных библиотек и шрифтов. Агенту никто не говорит, где он работает и что ему можно. Правило «после трёх одинаковых сбоев отчитайся и закончи ход» (`A/harness/platform-guidance.ts:14-15`) модель читает как «остановись».
2. Решение из пяти частей:
   - образ «Рабочее место агента» с Python в venv, офисными библиотеками, библиотеками данных и шрифтами с кириллицей, плюс вариант с LibreOffice; окружение выбирает образ из каталога сервера;
   - четыре шаблона окружений при создании;
   - блок «Окружение» в системном промпте любого harness;
   - закрепление пакета, поставленного в сессии, в окружении по кнопке пользователя;
   - зависимости навыков, платформа ставит их при подготовке VM.
3. Веб-поиск выбирает провайдера по настройке сервера. Для закрытого контура это свой SearXNG.
4. В verify-agent-console 11 жёстких проверок.
5. Три волны, около 2,5 дней работы агентов. Образ и чистые функции делает Codex, сервер Opus, консоль Sonnet.

### 0.1 Что можно сделать сегодня без кода

- В «Песочнице по умолчанию» добавить apt-пакеты `python3-pip python3-bs4 python3-lxml python-is-python3`. apt ставится первым (`P/sandbox/src/environment-setup.ts:54`), поэтому после этого заработают и pip-пакеты окружения. Цена: `apt-get update` и установка при каждом старте VM, оценка 20-40 с.
- Серверу задать `LITEBOX_DISK_SIZE_GB=4`. Без него на диске VM свободно около 120 МБ (`litebox.ts:80-83`).
- Не добавлять pip-пакеты без `python3-pip` в apt. Скрипт выйдет с кодом 127, VM остановится, и ни одна сессия окружения не стартует (`environment-setup.ts:105-111, 127-129`, `litebox.ts:556-571`).
- Дописать в системный промпт агента строку: «You are root in Debian 12. If a Python module is missing, run apt-get install -y python3-<name> or pip install --break-system-packages <name>, then continue».

В VM это не проверялось. Проверка одним ходом bash: `python3 -m pip --version; ls /usr/lib/python3*/EXTERNALLY-MANAGED; df -h / | tail -1`.

## 1. Образ «Рабочее место агента»

### 1.1 Что сейчас

- Образ один на сервер, переменная `SANDBOX_IMAGE` (`litebox.ts:900`). У окружения поля образа нет (`P/managed-agents-domain/src/environments/environment.ts:19-25`).
- VM создаётся на сессию, пакеты окружения ставятся при каждом старте VM. Кэша пакетов между сессиями нет, у Claude он есть.
- Команды агента идут через `sh -c` (`litebox.ts:187`), в Debian это dash. Инструмент называется bash, и `[[ ]]`, `source`, `set -o pipefail` в нём ломаются.
- Диск VM по размеру образа, свободно около 120 МБ. Память по умолчанию 512 МиБ, 1 CPU.
- Образ Cloudflare-версии `openma/sandbox-base` (`platform/apps/agent/Dockerfile:1-66`) богаче, но в нём тоже нет bs4, python-pptx и LibreOffice. Он собран на `cloudflare/sandbox` со своим ENTRYPOINT, работу в BoxLite никто не проверял. Поэтому собираем свой.
- У Claude в облачной песочнице уже есть python-pptx, python-docx, openpyxl, pypdf, pandoc, LibreOffice, шрифты и навыки pptx, xlsx, docx, pdf. Презентации там работают без настройки.

### 1.2 Состав

| Слой | Что | Зачем |
|---|---|---|
| База | `node:22-bookworm`: Debian 12, Node 22, npm, git, curl, unzip, python3 3.11 | старые окружения и Claude Code (`claude-agent-acp` через npm) работают как раньше |
| Python | `python3-venv`; venv `/opt/venv` с `--system-site-packages`; uv из образа `ghcr.io/astral-sh/uv` с закреплённой версией; симлинки `python`, `python3`, `pip`, `pip3`, `uv` в `/usr/local/bin` | `pip install x` ставит в venv без флагов, PEP 668 не мешает, системный Python apt цел. Симлинки надёжнее `ENV PATH`: перенос ENV образа в exec BoxLite не проверен, а `/usr/local/bin` есть в PATH всегда |
| Офис | python-pptx, python-docx, openpyxl, XlsxWriter, pypdf, pdfplumber, reportlab, Pillow, lxml | презентации, Word, Excel, PDF |
| Данные | pandas, numpy (ветка для Python 3.11), matplotlib | таблицы и графики |
| Веб на Python | requests, httpx, beautifulsoup4 | разбор страниц, меньше 1 МБ сверх lxml |
| Утилиты | jq, ripgrep, poppler-utils, tesseract-ocr с `rus` и `eng`, fontconfig, file, procps | JSON, поиск, PDF в текст и картинки, сканы |
| Шрифты с кириллицей | fonts-dejavu-core, fonts-liberation2 (метрики Arial, Times, Courier), fonts-crosextra-carlito (Calibri), fonts-crosextra-caladea (Cambria), fonts-paratype (PT Sans, PT Serif) | без Liberation и Carlito рендер документов Office в PDF едет |
| Описание образа | `/etc/oma/image-manifest.json`: ОС, версии Python и Node, pip без зависимостей (`pip list --not-required`), ручные пакеты apt (`apt-mark showmanual`), глобальные npm, шрифты | копия лежит рядом с образом на хосте, её читают сервер и консоль |
| Зеркала (сборка для контура) | аргументы сборки: `/etc/pip.conf` и `/etc/uv/uv.toml` с внутренним PyPI, `sources.list` с внутренним apt, `/etc/npmrc` с внутренним npm | по умолчанию публичные реестры |

Не входит: PyMuPDF (AGPL-3.0), pandoc (168 МБ, python-docx его закрывает), Playwright с Chromium (450-600 МБ, позже отдельным образом), Java.

Вариант `workplace-office`: тот же образ плюс `libreoffice-core-nogui`, `libreoffice-writer-nogui`, `libreoffice-calc-nogui`, `libreoffice-impress-nogui` (LibreOffice 7.4.7 в bookworm) и `python3-uno`. Он нужен для конвертации docx и pptx в PDF и картинки, чтобы агент проверил результат глазами, и для пересчёта формул xlsx. Работу nogui-пакетов на docx и pptx никто не проверял, это первая проверка EX1.

### 1.3 Размер и ресурсы

| Образ | На диске | Ресурсы VM в каталоге |
|---|---|---|
| `node:22-bookworm`, сейчас | 1,3 ГБ, замер (`litebox.ts:81`) | 512 МиБ, 1 CPU, диск по образу |
| `workplace` | около 1,8 ГБ | 2048 МиБ, 2 CPU, диск 6 ГБ |
| `workplace-office` | около 2,2 ГБ | 3072 МиБ, 2 CPU, диск 8 ГБ |

Размеры новых образов это оценка по packages.debian.org и PyPI, точные числа печатает `I/build.sh`. VM из образа 1,3 ГБ при тёплом кэше стартует за 2-3 с (`S/features/environments.md:70`). Для 2,2 ГБ время не замерено.

### 1.4 Файлы и сборка

Файлы в `I/`:

- `Dockerfile` с двумя целями: `workplace` и `office` (`FROM workplace` в том же файле, чтобы buildx не искал базу в реестре);
- `requirements-workplace.txt` с закреплёнными версиями;
- `manifest.sh` пишет `/etc/oma/image-manifest.json` при сборке;
- `build.sh <цель> <версия>` собирает OCI-каталог и манифест;
- `smoke.sh <тег>` проверяет образ в `docker run`;
- `boxlite-smoke.mjs <каталог>` поднимает VM BoxLite из каталога;
- `catalog.json` и `README.md`.

Сборка на машине разработчика:

```sh
cd platform/sandbox-images
docker buildx create --name oma-images --driver docker-container --use   # один раз
./build.sh workplace 2026.10.1
./build.sh office 2026.10.1
```

`build.sh` внутри:

```sh
docker buildx build --platform linux/amd64 --target "$TARGET" \
  --output "type=oci,dest=$SANDBOX_IMAGE_DIR/$NAME-$VERSION,tar=false" .
docker buildx build --platform linux/amd64 --target "$TARGET" --load -t "oma/$NAME:$VERSION" .
docker run --rm "oma/$NAME:$VERSION" cat /etc/oma/image-manifest.json \
  > "$SANDBOX_IMAGE_DIR/$NAME-$VERSION.manifest.json"
du -sh "$SANDBOX_IMAGE_DIR/$NAME-$VERSION"
```

Драйвер `docker` пишет формат OCI только с containerd image store, поэтому отдельный builder с драйвером `docker-container`. На машине стоят Docker 29.8.2 и buildx 0.37.2, skopeo и podman нет.

Как образ попадает в BoxLite. BoxLite не читает образы локального docker, он качает их из реестра. У `SimpleBox` есть `rootfsPath`, каталог в формате OCI layout, он заменяет `image` (`simplebox.d.ts:74-75` в `@boxlite-ai/boxlite` 0.9.0). Адаптер сейчас передаёт только `image` (`litebox.ts:490-498`). Правка ES2 передаёт `rootfsPath`, диск, память и CPU из каталога.

Что BoxLite 0.9.0 поднимет VM из каталога buildx с `tar=false`, никто не проверял. Это первая приёмка EX1 через `boxlite-smoke.mjs`. Запасной путь: образ в реестре (GHCR для разработки) и поле `image` в каталоге, правка кода не нужна. Внутренний реестр с http или логином требует `imageRegistries` рантайма BoxLite (`native-contracts.d.ts:87-102`), это отдельная правка позже.

### 1.5 Каталог и выбор образа у окружения

`I/catalog.json`:

```json
{
  "default_image": "workplace",
  "images": {
    "workplace": { "label": "Рабочее место агента", "oci_dir": "workplace-2026.10.1", "disk_gb": 6, "memory_mib": 2048, "cpus": 2 },
    "workplace-office": { "label": "Рабочее место с LibreOffice", "oci_dir": "workplace-office-2026.10.1", "disk_gb": 8, "memory_mib": 3072, "cpus": 2 }
  },
  "templates": [
    { "id": "basic", "label": "Базовое", "image": "workplace", "networking": { "type": "limited", "allow_package_managers": true, "allow_mcp_servers": true, "allowed_hosts": [] }, "packages": {} },
    { "id": "documents", "label": "Документы и офис", "image": "workplace-office", "networking": { "type": "limited", "allow_package_managers": true, "allow_mcp_servers": true, "allowed_hosts": [] }, "packages": {} },
    { "id": "data", "label": "Данные", "image": "workplace", "networking": { "type": "limited", "allow_package_managers": true, "allow_mcp_servers": true, "allowed_hosts": [] }, "packages": { "pip": ["duckdb", "pyarrow", "scipy"] } },
    { "id": "web", "label": "Веб", "image": "workplace", "networking": { "type": "unrestricted" }, "packages": { "pip": ["markdownify", "feedparser"] } }
  ]
}
```

- Настройки сервера: `SANDBOX_IMAGE_CATALOG` (путь к файлу) и `SANDBOX_IMAGE_DIR` (каталоги OCI и манифесты, по умолчанию `./data/sandbox-images`, папка `data/` уже в `.gitignore`). Без каталога сервер работает как сейчас: одна запись `default` из `SANDBOX_IMAGE`.
- Запись, у которой каталога на диске нет, сервер помечает `built: false`. Сессия на таком образе получает ошибку с именем образа, тихой подмены на старый образ нет.
- Окружение получает поле `config.image` с ключом каталога. Значение `null` значит `default_image`. Это наше расширение API, у Claude такого поля нет. Неизвестный ключ сервер отклоняет ответом 400. `config` хранится JSON (`P/environments-store/src/adapters/sql-environment-repo.ts:46`), миграция не нужна.
- Поле лежит в `config`, поэтому смена образа пересоздаёт VM живой сессии по уже существующему отпечатку (`N/lib/node-managed-session-runner.ts:232-236`).
- `GET /v1/oma/sandbox-catalog` отдаёт образы (ключ, подпись, `built`, размер, ресурсы, состав из манифеста) и шаблоны. Его читают консоль и блок промпта.
- Шаблоны живут в каталоге сервера, а не в коде консоли. Оператор контура убирает «Веб», если выход в интернет запрещён.
- «Песочница по умолчанию» и другие старые окружения имеют `config.image = null` и сразу получают `workplace`.

### 1.6 Правки адаптера и скрипта установки (после коммита W4)

- `exec` идёт через `bash -c`, если в образе есть `/bin/bash`. Адаптер проверяет это один раз в `initializeBox`, на голом образе остаётся `sh -c`. Скрипт установки остаётся POSIX.
- pip ставит в Python, который первым стоит в PATH: `uv pip install --python "$(command -v python3)"`, иначе `python3 -m pip`. В образе это venv. На образе без venv поведение прежнее (`environment-setup.ts:105-111`).
- apt пропускает `apt-get update`, если `dpkg -s` показывает все пакеты установленными. Пакет, который уже есть в образе, тогда стоит 0 с.
- Имена пакетов проверяются до скрипта. Имя не начинается с `-`, в нём нет URL, `git+`, пробелов и `/` в начале; для pip это имя и версия по PEP 508, для npm имя и версия, для apt имя. Сейчас строка `--index-url=https://…` в списке pip попала бы в pip опцией, кавычки (`environment-setup.ts:131-133`) от этого не защищают. Та же проверка стоит в API окружения и в загрузке навыка.

## 2. Шаблоны окружений в консоли

### 2.1 Шаблоны

| Шаблон | Образ | Сеть | Пакеты | Для чего |
|---|---|---|---|---|
| «Базовое» | `workplace` | «Ограниченный», менеджеры пакетов и MCP разрешены, хостов нет | нет | код, скрипты, разбор файлов. Недостающее агент ставит из реестров |
| «Документы и офис» | `workplace-office` | как у «Базового» | нет, всё в образе | презентации, Word, Excel, PDF, конвертация и проверка картинкой |
| «Данные» | `workplace` | как у «Базового» | pip `duckdb pyarrow scipy` | SQL по файлам, статистика, графики. Пакеты ставятся при каждом старте VM, оценка 15-30 с через uv |
| «Веб» | `workplace` | «Без ограничений» | pip `markdownify feedparser` | сбор страниц и лент из VM через curl и requests |

Шаблон пишет метку `metadata.oma_template` (`basic`, `documents`, `data`, `web`). Редактор метаданных метки `oma_*` не показывает, но сохраняет, так же S4 в console-parity поступает с `oma_created_by`. Карточка окружения показывает чип «Шаблон «Документы и офис»».

### 2.2 Как это выглядит

Создание `/environments/new`. Страницу делает K11a в console-parity (панели 6.5-6.6). Над формой ряд карточек: «Пустое» и четыре шаблона. На карточке название, одна строка назначения и чипы образа и сети, например «LibreOffice» и «Ограниченный». Выбор заполняет разделы формы, дальше пользователь правит их как обычно. Шаблон с несобранным образом неактивен, подпись «Образ не собран». Окно «Новое окружение» в списке ведёт на эту страницу.

Карточка `/environments/:id`. Разделы идут как у Claude: «Основное», затем новый «Образ», затем «Сеть», «Пакеты», «Метаданные».

- «Образ». Выпадающий список из каталога. Под ним свёрнутый список «Что есть в образе» из манифеста группами: Python и библиотеки, Node, утилиты, шрифты. Подпись: «Пакеты ниже ставятся поверх образа при каждом старте песочницы».
- «Пакеты». Пустой раздел пишет «Только то, что есть в образе», у Claude это «No packages beyond the standard image» (`docs/cma-console/02-managed-agents.md:316`). Под списком подпись: «Пакеты ставятся при каждом старте песочницы и удлиняют его. Постоянные инструменты лучше держать в образе».
- Если пакеты заданы, а сеть «Ограниченный» без менеджеров пакетов, раздел показывает предупреждение «Пакеты не поставятся: сеть закрыта для менеджеров пакетов».
- Над списком пакетов блок «Предложено из сессий» (раздел 4.1).
- `gem` остаётся скрытым. Комментарий про `sandbox-base` в `C/pages/EnvironmentDetail.tsx:31-34` исправить на `workplace`.
- У окружения «Свой сервер» разделов «Образ», «Сеть» и «Пакеты» нет, как у Claude (`02-managed-agents.md:321`).

## 3. Агент ставит сам: блок «Окружение»

### 3.1 Зачем

`platformGuidance` говорит про авторизацию, три сбоя и `/mnt/session/outputs/` (`A/harness/platform-guidance.ts:7-26`). Про ОС, root, сеть и установку пакетов там нет ни слова. Описание bash тоже молчит (`A/harness/tools.ts:447-454`). Шаблон «Глубокий исследователь» песочницу не упоминает (`C/data/templates.ts:92-106`).

### 3.2 Где собирается

- Чистая функция `buildEnvironmentPrompt({manifest, networking, packages, skillRequirements, mirrors, webSearch})` в новом `A/harness/environment-prompt.ts` возвращает текст блока.
- main-node кладёт его первой записью `platformReminders` с `source: "environment"` в `buildHarnessContext` (`N/modules/node-managed.ts:634-649`). `composeSystemPrompt` дописывает его к промпту (`platform-guidance.ts:47-58`). Разбор навыков пропускает записи без префикса `skill:` (`A/harness/assembly/skills/resolve-context.ts:17`).
- Так блок получает любой harness. Встроенный цикл и Pi читают `ctx.systemPrompt`. `acp-sandbox` пишет его в `/workspace/AGENTS.md` (`A/harness/acp-sandbox-loop.ts:58-62`). `acp-proxy` передаёт его в доставку (`A/harness/acp-proxy-loop.ts:209`). Старый путь `N/modules/node-foundation.ts:449-465` получает тот же блок.
- Блок не меняется за сессию. Он зависит только от конфигурации, а при её смене VM всё равно пересоздаётся. Кэш промпта поэтому не страдает. Размер 900-1500 знаков, около 300 токенов.
- Блок на английском, как остальной `platformGuidance`. Списки библиотек обрезаются до 20 имён.

### 3.3 Текст

Пример для «Документов и офиса»:

```text
<environment>
This session runs in its own Linux VM: Debian 12 (bookworm), x86_64. You are root. Shell: bash. Working directory: /workspace.
Save files the user should keep in /mnt/session/outputs/. Everything else, including packages you install, disappears when the session's VM stops.
Preinstalled: Python 3.11 (python, pip and uv use the venv /opt/venv), Node 22 with npm, git, curl, jq, rg, pdftotext, pdftoppm, tesseract (rus, eng), LibreOffice 7.4 (soffice --headless).
Python libraries: python-pptx, python-docx, openpyxl, XlsxWriter, pypdf, pdfplumber, reportlab, Pillow, lxml, pandas, numpy, matplotlib, requests, httpx, beautifulsoup4.
Fonts with Cyrillic: DejaVu, Liberation, Carlito, Caladea, PT Sans, PT Serif.
Network: limited. Reachable: package registries (PyPI, npm, Debian). Other hosts fail.
If a library or tool is missing, install it and continue: pip install <name>, apt-get install -y <name>, npm install -g <name>. A missing package is not a reason to stop, and the three-failures rule does not apply to installing it. Tell the user which packages you installed, so they can add them to the environment.
</environment>
```

Строки, которые меняются с конфигурацией:

| Условие | Строка |
|---|---|
| «Без ограничений» | `Network: unrestricted.` |
| «Ограниченный» с менеджерами пакетов | `Network: limited. Reachable: package registries (PyPI, npm, Debian) and <хосты>. Other hosts fail.` |
| «Ограниченный» без менеджеров пакетов | `Network: limited to <хосты>.` (или `Network: none.`), строка про установку заменяется на `Package registries are blocked. Do not try to install packages. If something is missing, say what you need and finish with what you have.` |
| заданы зеркала контура | `Packages come from the internal mirror <хост>. Public registries are blocked.` |
| пакеты окружения | `Environment packages installed at start: pip duckdb pyarrow scipy.` |
| пакеты навыков (раздел 5) | `Installed for skills: pip python-pptx (office-pptx).` |
| поиск выключен (раздел 6) | `Web search is not available.` |

### 3.4 Сеть «Ограниченный»

- С `allow_package_managers` VM видит реестры из `PACKAGE_MANAGER_HOSTS` (`environment-setup.ts:39-52`). Агент ставит пакеты так же, как без ограничений.
- Без него публичные реестры закрыты. Блок говорит агенту не пробовать. Пакеты окружения при этом не поставятся, сейчас адаптер дописывает подсказку к ошибке (`litebox.ts:562-564`), а консоль из раздела 2.2 предупреждает заранее.
- В контуре оператор задаёт `SANDBOX_PACKAGE_MIRRORS` (хосты и адреса индексов pip, apt, npm). Тогда `allow_package_managers` открывает хосты зеркал вместо публичных реестров, а скрипт установки и агент берут адреса из образа (`pip.conf`, `uv.toml`, `sources.list`, `npmrc`).

## 4. Закрепление пакета в окружении

### 4.1 Что видит пользователь

- После хода, в котором агент что-то поставил, страница сессии показывает над полем ввода строку: «Агент поставил в этой сессии: pip beautifulsoup4, apt python3-bs4. Они пропадут вместе с песочницей». Рядом кнопка «Добавить в окружение».
- Окно «Добавить пакеты в окружение «Песочница по умолчанию»». Флажок на каждый пакет, все включены. Предупреждение: «Пакеты будут ставиться при старте каждой новой сессии этого окружения. Текущая сессия не перезапускается». Кнопки «Отмена» и «Добавить».
- На карточке окружения блок «Предложено из сессий»: пакеты, которые агенты ставили в сессиях этого окружения за 30 дней, с числом сессий и кнопкой «Добавить».
- Без кнопки пользователя окружение не меняется. Агент сам окружение не правит.

### 4.2 Как сервер узнаёт

- Новый `GET /v1/oma/sessions/:id/installed-packages`. Если VM сессии жива (`connectedSandbox`, `N/lib/node-managed-session-runner.ts:220-222`), сервер одним вызовом выполняет в ней скрипт: pip без зависимостей в venv (`pip list --not-required --format=json`), `apt-mark showmanual`, `npm ls -g --depth=0 --json`. Из результата вычитаются манифест образа, пакеты окружения и пакеты навыков.
- Ответ сохраняется в KV по сессии, поэтому он доступен и после остановки VM. Без живой VM маршрут отдаёт последний сохранённый.
- Консоль зовёт маршрут, когда сессия встала в `idle` после хода с вызовом bash. Вызов идёт только по запросу, оценка 0,3-1 с.
- pip и npm идут с версией (`beautifulsoup4==4.12.3`, `pkg@1.2.3`), apt без версии, потому что в Debian она меняется с обновлениями безопасности.
- `GET /v1/oma/environments/:id/package-suggestions` собирает сохранённые ответы сессий окружения для блока «Предложено из сессий».

### 4.3 Запись и VM текущей сессии

- «Добавить» делает `POST /v1/environments/:id` с объединённым списком. Права те же, что у правки окружения. Если builder BP1 уже добавил `If-Match`, консоль передаёт ревизию.
- Сейчас отпечаток VM включает весь `environment.config` (`node-managed-session-runner.ts:232-236`). Закрепление пересоздало бы VM текущей сессии и стёрло `/workspace`. Новый отпечаток: `resources`, `skills`, `config.image`, `config.networking`. Пакеты применяются к новым VM. Смена образа или сети пересоздаёт VM, как раньше.

### 4.4 Позже: агент-помощник

В плане builder-agent у ассистента есть `update_environment` с карточкой разницы (`builder-agent.md:182`, раздел 2.5). Добавить инструмент класса «чтение» `session_installed_packages(session_id)` поверх маршрута 4.2. Тогда ассистент сам предлагает: «Агенты трёх сессий ставили beautifulsoup4, добавить в окружение?», а пользователь подтверждает карточкой. Это строка для BS1 и BC1 после обеих волн 2, в единицы этого плана не входит.

## 5. Зависимости навыков

### 5.1 Формат

Спецификация agentskills.io знает поля `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`. Поля зависимостей в ней нет, референсный валидатор отклоняет любое другое поле верхнего уровня. Поэтому зависимости лежат в `metadata` с префиксом `oma.requires.`:

```yaml
---
name: office-pptx
description: Создаёт и правит презентации .pptx на python-pptx и проверяет их рендером в PNG. Брать, когда нужен файл PowerPoint.
compatibility: Нужны python-pptx и LibreOffice (soffice). Без LibreOffice навык не проверит рендер.
metadata:
  oma.requires.pip: "python-pptx>=1.0"
  oma.requires.apt: "libreoffice-impress-nogui"
---
```

Значения это имена через пробел, проверка как в 1.6. Claude Code и Codex такие ключи пропускают, навык остаётся переносимым. `compatibility` пишется для людей и других клиентов.

### 5.2 Загрузка

- Сейчас frontmatter читается построчно регулярным выражением (`N/lib/node-skills-routes.ts:63-74`, `N/lib/skill-sources.ts:353-362`), вложенный `metadata` и ключи с точкой оно не разбирает.
- Загрузка zip и установка по адресу разбирают frontmatter через js-yaml (новый `N/lib/skill-requirements.ts`), проверяют имена и пишут `requirements: {apt, pip, npm}` в запись версии рядом с `files` (`node-skills-routes.ts:291, 377`). Плохое имя даёт 400 с названием ключа.
- API навыка и версии отдаёт `requirements`. Консоль показывает чипы «pip python-pptx» в строке навыка на странице «Навыки».
- Версии, загруженные до правки, сервер разбирает при первом чтении и дописывает.

### 5.3 Подготовка сессии

- `buildSandbox` (`N/modules/node-managed.ts:430-436`) находит версии custom-навыков агента так же, как `resolveNodeManagedSkillMounts` (`N/lib/node-managed-session-inputs.ts:116-158`), и добавляет их `requirements` к пакетам окружения до создания VM. LiteBox читает окружение один раз при первом exec, позже уже поздно.
- Пакеты из манифеста образа из списка выпадают. Навык, чьи зависимости уже в образе, стоит 0 с.
- Если сеть «Ограниченный» без менеджеров пакетов, а пакета в образе нет, старт сессии останавливается до VM с ошибкой `skill_dependency_unmet`: «Навык office-pptx требует pip python-pptx. Его нет в образе, а сеть окружения закрыта для менеджеров пакетов». Хвоста вывода apt пользователь не видит.
- Пакеты навыков попадают в блок «Окружение» строкой `Installed for skills`.
- Навыки типа `anthropic` на Node по-прежнему пропускаются (`node-managed-session-inputs.ts:88`). Блок «Навыки Anthropic» в форме агента скрыть, как предлагает пункт 3.11 (`docs/cma-console/02-managed-agents-gap.md:163`).

### 5.4 Навыки для документов

Файла `docs/plans/document-skills.md` на 2026-10-16 нет. Этот проект задаёт для такого плана четыре условия:

- навыки docx, pdf, pptx и xlsx из anthropics/skills не копируем. Они source-available, а лицензия запрещает хранить копии вне сервисов Anthropic (`builder-agent.md:422`). Пишем свои или берём из источников под Apache-2.0 или MIT;
- каждый навык документов объявляет `oma.requires.*`. В `workplace-office` всё уже есть, установка пустая. На другом образе платформа доставит пакеты сама;
- навык проверяет результат рендером: `soffice --headless --convert-to pdf`, затем `pdftoppm -png`, и смотрит картинки. Для этого нужен `workplace-office`, его ставит шаблон «Документы и офис»;
- reportlab рисует кириллицу только со шрифтом TTF. Навык регистрирует `DejaVuSans` из `/usr/share/fonts/truetype/dejavu/`.

## 6. Веб-поиск

### 6.1 Сейчас

- web_search скрейпит DuckDuckGo через неофициальный интерфейс (`A/harness/tools.ts:990-1052`). При блокировке агент получает «DuckDuckGo rate limited».
- Запрос идёт из процесса main-node обычным fetch (`A/harness/tool-http-fetch.ts:31-41`), а не из VM. Сеть окружения поиск не ограничивает.
- Tavily в коде есть (`tools.ts:1055-1090`), но на Node тип `web_search_tavily` недоступен, ключ не передаётся (`N/modules/node-managed.ts:571-583`). Ключ уходит в теле запроса (`tools.ts:1071`), а документация Tavily описывает заголовок `Authorization: Bearer`.
- web_fetch шлёт User-Agent `OMA-Agent/1.0 (+web_fetch)` (`tools.ts:770`), и защита Cloudflare отдаёт на него страницу проверки. Текст «fetch failed» без причины, потому что `httpFetchErrorMessage` берёт только `err.message` (`tool-http-fetch.ts:43-51`).

### 6.2 Провайдер по настройке

- Настройка `WEB_SEARCH_PROVIDER` принимает `searxng`, `brave`, `tavily`, `duckduckgo` или `off`. Без настройки остаётся `duckduckgo`, только для разработки.
- Ключи и адреса: `SEARXNG_URL`, `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`. Brave берёт ключ в заголовке `X-Subscription-Token`, Tavily в `Authorization: Bearer`.
- Провайдеры живут в новом `A/harness/web-search-providers.ts`, ответ каждого приводится к `{title, url, description}`. `tools.ts` выбирает провайдера по настройке, которую main-node передаёт в `buildTools`.
- `off` убирает инструмент, блок «Окружение» пишет `Web search is not available.`
- В сети «Ограниченный» результаты фильтруются по `allowed_hosts` тем же сравнением, что у web_fetch (`A/harness/web-fetch-http.ts:28-34`), так делает и Claude. Сравнение учится понимать маску `*.example.com`, сейчас она не совпадает никогда.
- web_fetch шлёт User-Agent с контактом из настройки `WEB_FETCH_USER_AGENT` и пишет в текст ошибки код причины из `cause.code` (`ENOTFOUND`, `ECONNRESET`, ошибка сертификата). Защиту Cloudflare не обходим.
- В консоли подпись «Веб-поиск через DuckDuckGo» (`C/pages/agents/AgentFormDialog.tsx:73`) становится «Веб-поиск».

### 6.3 Закрытый контур

- Свой SearXNG единственная точка поиска, платформа ходит только в него.
- Без интернета SearXNG работает на офлайн-движках по внутренним базам: Elasticsearch, Meilisearch, Solr, SQL. Публичного веба в этом режиме нет.
- С выходом через DMZ SearXNG ходит наружу через `outgoing.proxies` на корпоративный прокси, набор движков ограничен.
- Если main-node ходит наружу через прокси, ему нужны `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY` и `NO_PROXY`. Без них fetch Node прокси не видит, и web_search с web_fetch падают.
- Brave и Tavily отправляют текст запроса за периметр. Нужны договор и разрешение юристов. SearXNG под AGPL-3.0 ставится отдельным сервисом без правок, вопрос к юристам тоже.

## 7. Проверка в verify-agent-console

Новый сценарий `S/scripts/journey.sh --run <RUN_ID> --scenario environment-tools`, файл `S/scripts/journey-environment-tools.mjs`. `launch.sh` задаёт `SANDBOX_IMAGE_CATALOG`, `SANDBOX_IMAGE_DIR=~/.cache/verify-agent-console/sandbox-images` и `WEB_SEARCH_PROVIDER=off`. Образы собирает `I/build.sh` до прогона, `doctor.sh` проверяет, что они собраны. Все проверки жёсткие: провал валит прогон, строк «внимание» по новым функциям нет. Главный сценарий `env-to-agent` переходит на образ `workplace` и остаётся зелёным.

| Проверка | Действие | Ожидается |
|---|---|---|
| `env.catalog` | `GET /v1/oma/sandbox-catalog` | два образа с `built: true`, четыре шаблона |
| `env.template_documents` | «Новое окружение», карточка «Документы и офис», «Создать» | `config.image = "workplace-office"`, сеть «Ограниченный» с менеджерами пакетов, `metadata.oma_template = "documents"`; на карточке раздел «Образ» со списком «Что есть в образе» |
| `env.documents_imports` | сессия на этом окружении, bash `python3 -c "import pptx, docx, openpyxl; print('IMPORT_OK')"; soffice --version` | `IMPORT_OK` и `LibreOffice 7.4`; в логе сервера `creating box` с `workplace-office` |
| `env.fonts_cyrillic` | bash: `fc-list :lang=ru family`; python-pptx пишет слайд «Проверка шрифтов», `soffice --headless --convert-to pdf`, `pdftotext`, `pdffonts` | не меньше трёх семейств, среди них DejaVu и Liberation; в тексте PDF строка «Проверка шрифтов»; `pdffonts` показывает DejaVu, Liberation или Carlito |
| `env.pip_only_package` | окружение на `workplace` только с pip `tomli-w`, сессия, импорт | VM стартует, импорт проходит, ловушки с кодом 127 нет |
| `env.agent_self_install` | окружение «Без ограничений»; фейковая модель по шагам: `python3 -c "import cowsay"`, `pip install cowsay`, снова импорт | первый вызов `ModuleNotFoundError`, третий `IMPORT_OK`; pip без флагов, пакет в `/opt/venv` |
| `env.installed_notice` | после хода `GET /v1/oma/sessions/:id/installed-packages`; в консоли строка «Агент поставил…», «Добавить в окружение», «Добавить» | ответ содержит `cowsay==<версия>`; `GET /v1/environments/:id` содержит пакет; следующий ход видит файл-метку `/workspace/.verify-<n>` прошлого хода, значит VM не пересоздана |
| `prompt.environment_block` | журнал фейковой модели | `system` запроса содержит `<environment>`, `Debian 12`, `You are root`, `/workspace`, `/mnt/session/outputs/`; для «Ограниченного» `Network: limited` и `example.org`, для «Без ограничений» `Network: unrestricted` |
| `cc.environment_block` | сценарий `claude-code`, второй ход | `/workspace/AGENTS.md` в VM содержит `<environment>` |
| `skill.dependency_installed` | навык с `oma.requires.pip: "pyjokes"` и `oma.requires.apt: "figlet"`, подключить к агенту, сессия на «Базовом» | `requirements` в API версии; лог `installing environment packages (apt: figlet; pip: pyjokes)` до первого инструмента; `python3 -c "import pyjokes"` и `command -v figlet` успешны; в блоке строка `Installed for skills` |
| `skill.dependency_unmet` | тот же агент на окружении «Ограниченный» без менеджеров пакетов | сессия получает `skill_dependency_unmet` с `pyjokes` в тексте; `Box started` после начала шага в логе BoxLite нет |

`fake-model.mjs` пишет в журнал, есть ли в `system` блок `<environment>` и его строку `Network:`, и получает новый маркер `VERIFY_SELF_INSTALL nonce=<n>` для шагов установки.

Отдельно, только с согласия владельца, EQ1: «Глубокий исследователь» на Qwen, окружение «Базовое», вопрос, для которого нужна библиотека вне образа (например `tabulate`). Ожидается, что агент поставит её сам и закончит ответ.

## 8. Единицы работы

Правила как в console-parity и builder-agent. У файла в волне один владелец. Перед стартом единица делает `git status --short <свои файлы>`, чужие незакоммиченные правки значат ждать. Тексты по unslop, `node scripts/unslop-check.mjs --diff` перед сдачей. Скриншоты консольных единиц на 1280 и 390 px.

### 8.1 Сводная таблица

Размер: S до полудня, M день, L больше дня работы агента.

| id | Исполнитель | Волна | Что | Зависит от | Размер |
|---|---|---|---|---|---|
| EX1 | Codex | 1 | Dockerfile с целями `workplace` и `office`, сборка в OCI-каталог, манифест, smoke в docker и в BoxLite, `catalog.json` | нет | M |
| EX2 | Codex | 1 | Чистые функции: текст блока, проверка имён пакетов, требования навыка, скрипт и разница установленного, провайдеры поиска | нет | M |
| ES1 | server, Opus | 1 | Каталог образов и шаблонов, `config.image` в контракте, домене и приложении, модуль маршрута `/v1/oma/sandbox-catalog` | нет | M |
| ES2 | server, Opus | 2 | Адаптер и скрипт установки: `rootfsPath` и ресурсы, bash, pip в Python из PATH, пропуск `apt-get update`, проверка имён | коммит W4, EX1 (`catalog.json`), EX2 | M |
| ES4 | server, Opus | 2 | `requirements` при загрузке навыка; модули маршрутов `installed-packages` и `package-suggestions` с KV | EX2, ES1 | M |
| ES5 | server, Opus | 2 | Веб: провайдеры в `tools.ts`, фильтр по `allowed_hosts`, маски, причина ошибки и User-Agent | EX2; `tools.ts` после коммита BX1 | S |
| ES3 | server, Opus | 2 | Подключение в main-node: каталог в `buildSandbox`, требования навыков и `skill_dependency_unmet`, блок «Окружение», настройки поиска в `buildTools`, отпечаток раннера, маршруты, настройки | коммит W4; ES1, ES2, ES4, ES5 | M |
| EK1 | console, Sonnet | 2 | Шаблоны на «Новом окружении», раздел «Образ», подписи и предупреждение «Пакетов», скрытые `oma_*`, комментарий про gem | контракт ES1; коммит K11a | M |
| EK2 | console, Sonnet | 2 | Строка «Агент поставил…» и окно «Добавить в окружение», блок «Предложено из сессий», чипы `requirements` на «Навыках», подпись поиска | контракт ES4; коммит EK1; `SessionDetail.tsx` после BK4, `SkillsList.tsx` после K15, `AgentFormDialog.tsx` после K9 | M |
| EV1 | skill, Opus | 3 | Сценарий `environment-tools` и проверки раздела 7 | ES3, EK1, EK2; файлы скилла по очереди 8.4 | L |
| EQ1 | server, Opus | 3 | Живая проверка на Qwen | EV1, согласие владельца | S |

### 8.2 Файлы и приёмка

**EX1. Образ.** Новые `I/Dockerfile`, `requirements-workplace.txt`, `manifest.sh`, `build.sh`, `smoke.sh`, `boxlite-smoke.mjs`, `catalog.json`, `README.md`. Сборка через `nice -n 15`, по одной цели. Приёмка: обе цели собираются; `smoke.sh` проходит импорт офисных библиотек, `soffice --convert-to pdf` с кириллицей, `fc-list :lang=ru`, `pip install tomli-w` без флагов в venv, `python --version`, наличие bash; `boxlite-smoke.mjs` поднимает VM из каталога через `rootfsPath` и выполняет `python3 -c "import pptx"`, иначе в README записан запасной путь через реестр; в README настоящие размеры, время сборки и лицензии пакетов (MIT, BSD, Apache-2.0, PSF, без AGPL).

**EX2. Чистые функции.** Новые `A/harness/environment-prompt.ts` и `AT/environment-prompt.test.ts`; `P/sandbox/src/package-names.ts`, `P/sandbox/src/installed-packages.ts` и тесты в `P/sandbox/test`; `N/lib/skill-requirements.ts` и `NT/skill-requirements.test.ts`; `A/harness/web-search-providers.ts` и тест; `js-yaml` 4.1.1 (та же версия, что в консоли) в `platform/apps/main-node/package.json` и `platform/pnpm-lock.yaml` отдельным первым коммитом. Приёмка: блок для пяти вариантов сети из 3.3 совпадает с образцами и короче 1500 знаков; имена `--index-url=x`, `git+https://x`, `a b`, `/x` отклоняются, `numpy==2.0`, `@scope/pkg@1.2`, `python3-bs4` проходят; frontmatter с вложенным `metadata`, кавычками и без `metadata`; разница вычитает манифест, пакеты окружения и навыков; провайдеры разбирают записанные ответы SearXNG, Brave и Tavily.

**ES1. Каталог и поле образа.** Новые `N/lib/sandbox-catalog.ts` (загрузка каталога и манифестов, ключ в образ, шаблоны), `N/lib/sandbox-catalog-routes.ts`, `NT/sandbox-catalog.test.ts`; правка `P/managed-agents-api/src/contracts/environments.ts` и `mappers/environments.ts` (`image` во входе и ответе облачного `config`), `P/managed-agents-domain/src/environments/environment.ts`, `P/managed-agents-application/src/environments/application.ts` и `ports/environments.ts` (проверка ключа через порт каталога, 400), `P/api-types/src/types.ts`. Приёмка: тесты; без `SANDBOX_IMAGE_CATALOG` поведение как сейчас; typecheck.

**ES2. Песочница.** Правка `P/sandbox/src/environment-setup.ts`, `P/sandbox/src/index.ts`, `P/sandbox/src/ports.ts` (образ и ресурсы в спецификации окружения), `P/sandbox-adapter-litebox/src/litebox.ts` и их тесты. Приёмка: 1.6 целиком; на `node:22-bookworm` прежние тесты зелёные.

**ES4. Навыки и установленное.** Правка `N/lib/node-skills-routes.ts`, `N/lib/skill-sources.ts`; новые `N/lib/session-installed-packages-routes.ts`, `NT/session-installed-packages.test.ts`, `NT/skill-requirements-upload.test.ts`. Приёмка: 4.2 и 5.2 на подставной песочнице.

**ES5. Веб.** Правка `A/harness/tools.ts` (ветка `web_search` и User-Agent web_fetch), `A/harness/tool-http-fetch.ts`, `A/harness/web-fetch-http.ts` (маски); тесты в `AT/`. Приёмка: 6.2 на подставном fetch; прежние тесты harness зелёные.

**ES3. Подключение.** Правка `N/modules/node-managed.ts` (`buildSandbox`, `buildHarnessContext`, оба вызова `buildTools`), `N/modules/node-foundation.ts` (каталог, старый путь промпта), `N/modules/node-http.ts` (маршруты ES1 и ES4), `N/config.ts` (`SANDBOX_IMAGE_CATALOG`, `SANDBOX_IMAGE_DIR`, `SANDBOX_PACKAGE_MIRRORS`, `WEB_SEARCH_*`, `WEB_FETCH_USER_AGENT`), `N/lib/node-managed-session-runner.ts` (одна строка отпечатка), `platform/.env.example`, `docs/runbook-local.md`; новый `NT/environment-tools-e2e.test.ts`. Приёмка: сквозной тест на подставной песочнице и фейковой модели проверяет блок в `systemPrompt`, слияние пакетов навыков, `skill_dependency_unmet` и сохранение VM при смене пакетов.

**EK1. Окружение в консоли.** Правка файлов K11a (`C/pages/environments/EnvironmentNewPage.tsx`, `PackagesEditor.tsx`, `C/pages/EnvironmentDetail.tsx`, `C/pages/EnvironmentsList.tsx`); новые `C/pages/environments/TemplatePicker.tsx`, `ImageSection.tsx`, `C/lib/sandbox-catalog.ts` и тесты. Приёмка: раздел 2.2; тесты; скриншоты.

**EK2. Закрепление и навыки.** Новые `C/components/session/InstalledPackagesNotice.tsx`, `C/components/environments/AddPackagesDialog.tsx`, `C/pages/environments/PackageSuggestions.tsx` и тесты; одна вставка в `C/pages/SessionDetail.tsx`; чипы в `C/pages/SkillsList.tsx`; подпись в `C/pages/agents/AgentFormDialog.tsx`. Приёмка: 4.1, чипы из 5.2, подпись из 6.2; тесты; скриншоты.

**EV1. Проверка.** Правка `S/scripts/fake-model.mjs`, `journey.sh`, `launch.sh`, `doctor.sh`, `journey-env-to-agent.mjs` (образ `workplace`), `journey-claude-code.mjs` (`cc.environment_block`), `S/SKILL.md`, `S/features/README.md`, `environments.md`, `skills.md`; новые `S/scripts/journey-environment-tools.mjs`, `S/features/environment-tools.md`. Приёмка: все строки раздела 7 «проверено»; сценарии `env-to-agent` и `claude-code` зелёные.

**EQ1. Qwen.** Правки только в промпте блока и описаниях, если модель не ставит пакет. Приёмка: прогон из раздела 7, отчёт с событиями сессии.

### 8.3 Волны и время

| Волна | Единицы | Старт | Время |
|---|---|---|---|
| 1. Образ и библиотеки | EX1, EX2, ES1 | сейчас, только новые файлы и файлы без других владельцев | 5-6 ч |
| 2. Подключение | ES2, ES4, ES5 параллельно, затем ES3; EK1, затем EK2 | коммит волны 1; ES2 и ES3 после коммита W4; EK1 после коммита K11a | 8-10 ч |
| 3. Проверка | EV1, затем EQ1 | коммит волны 2; для EQ1 согласие владельца | 7-9 ч |

Итого около 2,5 дней работы агентов. По календарю волна 2 ждёт W4, K11a (волна 3 console-parity) и BX1. Самый длинный путь: EX1, ES2, ES3, EV1. Сборка образов на этом ноутбуке идёт с паузами на нагрев, первая сборка каждой цели займёт 15-30 мин.

### 8.4 Общие файлы: порядок владельцев

| Файл | Другие владельцы | Наша единица берёт после |
|---|---|---|
| `P/sandbox/src/environment-setup.ts`, `P/sandbox-adapter-litebox/src/litebox.ts` | W4 | коммита W4 (ES2) |
| `N/modules/node-managed.ts` | W4, затем очередь `builder-agent.md` 7.4 (RS, SW, SX, BS3) | коммита W4 и текущего владельца в очереди (ES3) |
| `N/modules/node-http.ts`, `N/config.ts`, `N/modules/node-foundation.ts` | очередь `builder-agent.md` 7.4, portal-sso | коммита текущего владельца (ES3). Правки ES3 это короткие вставки: если BS3 идёт позже, BS3 их вливает |
| `N/lib/node-managed-session-runner.ts` | BS3, models-harness-analytics (S3) | коммита W4 (ES3, одна строка); с BS3 второй вливает |
| `A/harness/tools.ts` | BX1 | коммита BX1 (ES5) |
| `C/pages/EnvironmentsList.tsx`, `EnvironmentDetail.tsx`, `C/pages/environments/*` | K11a | коммита K11a (EK1), затем EK2 |
| `C/pages/SessionDetail.tsx` | RS, K5, BK4 | коммита BK4 (EK2, одна вставка) |
| `C/pages/SkillsList.tsx` | K15 | коммита K15 (EK2) |
| `C/pages/agents/AgentFormDialog.tsx` | RS, C1, K9 | коммита K9 (EK2, одна строка) |
| `S/scripts/fake-model.mjs`, `journey.sh`, `launch.sh`, `doctor.sh`, `S/SKILL.md`, `S/features/README.md` | CC, VP2, V1 + VP3, VP4, BV1, BV2, models-harness-analytics, agent-trace | коммита последнего владельца в очереди на момент старта (EV1) |
| `S/scripts/journey-claude-code.mjs` | models-harness-analytics, agent-trace | так же (EV1) |
| `platform/apps/main-node/package.json`, `platform/pnpm-lock.yaml` | любой, кто добавляет зависимость | свежего `main` (EX2, отдельный коммит) |

## 9. Решения, вопросы, что не входит

Решения:

1. Образ собираем сами `FROM node:22-bookworm`. `openma/sandbox-base` собран на `cloudflare/sandbox`, с BoxLite не проверен, и в нём всё равно нет bs4, python-pptx и LibreOffice.
2. Окружение выбирает образ ключом каталога в `config.image`, а не любой ссылкой на образ. В контуре набор образов утверждает оператор. Поле лежит в `config`, потому что метаданные не входят в отпечаток VM и правятся как свободный текст.
3. LibreOffice живёт в варианте `workplace-office`, база без него легче на 300-400 МБ.
4. Python в venv `/opt/venv` с симлинками в `/usr/local/bin`. Системный pip с `--break-system-packages` не используем.
5. Блок «Окружение» собирается из манифеста и конфигурации, лежит в `platformReminders` с `source: "environment"`, написан на английском.
6. Смена пакетов окружения не пересоздаёт VM живой сессии, смена образа и сети пересоздаёт.
7. Пакет попадает в окружение только по кнопке пользователя.
8. Зависимости навыка лежат в `metadata` с префиксом `oma.requires.`, своих полей верхнего уровня нет.
9. Провайдер поиска задаёт настройка сервера. DuckDuckGo остаётся только для разработки, для контура SearXNG.
10. Playwright и Chromium в базу не входят.
11. Шаблоны живут в каталоге сервера.

Вопросы владельцу:

- Сеть пустого окружения. Сейчас окно создания шлёт `config` без `networking` (`C/pages/EnvironmentsList.tsx:83-87`), и сервер ставит «Без ограничений». У Claude форма стартует с «Ограниченного». Шаблоны ставят «Ограниченный» с реестрами. Пустое окружение оставить как есть?
- Что есть у банка: реестр образов (например Harbor), зеркала PyPI, apt и npm, выход через прокси.
- Разрешён ли поиск через SaaS (Brave, Tavily) или только SearXNG.

Не входит:

- удаление лого OpenMA, отдельная задача;
- кэш пакетов между сессиями, как у Claude. В BoxLite 0.9 есть `snapshot`, `cloneBox` и `export` (`native-contracts.d.ts:182-200`), адаптер их не использует. Можно поставить пакеты окружения один раз и клонировать VM на сессию. Скорость и размер клона не проверены;
- образ с Playwright и подключение `browser` на Node;
- путь Cloudflare (`A/runtime/session-do.ts`).

Не проверено: отсутствие pip в `node:22-bookworm`, перенос ENV образа в exec BoxLite, запуск BoxLite из каталога buildx, работа `libreoffice-*-nogui` на docx и pptx, размеры образов и время старта VM из 2,2 ГБ, приём ключа Tavily в теле запроса, причина «fetch failed» в пробной консоли.
