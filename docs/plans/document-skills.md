# Навыки для документов: docx, pdf, pptx, xlsx

> **2026-10-17.** Остался только harness Pi, решение D41 в [decisions-2026-10-17.md](../decisions-2026-10-17.md). Harness `acp-sandbox` удалён, поэтому stdio-сервер MCP сейчас не запускает никто.

Черновик 1, 2026-10-16. Статус: перенос идёт, итоги в разделе 8.

Запрос: агенты платформы должны создавать, читать и править Word, PDF, PowerPoint и Excel. В форме агента уже есть переключатели xlsx, pdf, pptx, docx с типом `anthropic`, но на Node они ничего не подключают. Навыки Anthropic из github.com/anthropics/skills брать нельзя, у них лицензия source-available с запретом копий и производных работ.

Пути:

- `P/` это `platform/packages`;
- `N/` это `platform/apps/main-node/src`, `NT/` это `platform/apps/main-node/test`;
- `C/` это `platform/apps/console/src`;
- `B/` это `platform/skills/builtin`, новая папка встроенных навыков.

## 1. Коротко

1. Берём четыре навыка NousResearch/hermes-agent под MIT: `docx`, `pdf`, `powerpoint` (у нас `pptx`) и `xlsx`. Это Python-скрипты с JSON на выходе и SKILL.md по 10-12 КБ. Node не нужен.
2. Навыки лежат в репозитории в `B/<имя>/` вместе с LICENSE источника и ATTRIBUTION.md. Сервер читает папку при старте и показывает навыки в каждом рабочем пространстве с источником «Платформа». Удалить или заменить их через API нельзя.
3. Подготовка VM принимает навыки с типом `anthropic`. Переключатели xlsx, pdf, pptx, docx в форме агента начинают работать без правки формы.
4. Пакеты Python ставит окружение. В окне «Новое окружение» есть шаблон «Документы» с нужными apt и pip. Если пакетов нет, SKILL.md велит агенту поставить их самому.
5. MCP-серверы не выбраны. Раздел 6 описывает, как подключить такой сервер позже.

## 2. Кандидаты

Проверка шла в два шага. Сначала лицензия: только MIT, Apache-2.0, BSD, ISC, MPL-2.0 и только при файле LICENSE в репозитории или пакете. Потом проверка на копию навыков Anthropic: общие цепочки слов и имена файлов `ooxml/`, `html2pptx`, `redlining`, `inventory.py`, `thumbnail.py`, `recalc.py`, `unpack.py`.

| Кандидат | Вид | Форматы | Лицензия | Итог |
|---|---|---|---|---|
| NousResearch/hermes-agent, `skills/productivity` | навыки | docx, pdf, pptx, xlsx | MIT, LICENSE в каждой папке | берём все четыре |
| ginlix-ai/LangAlpha, `langalpha_deliverables` | навыки | docx, pdf, pptx, xlsx | Apache-2.0 | запасной вариант для pdf |
| mcp-docgen (Touka) | MCP stdio, PyPI | docx, pdf, pptx, xlsx | MIT в пакете | нет исходного репозитория, нужен `mcp<2`, PDF без кириллицы |
| haris-musa/excel-mcp-server | MCP stdio и HTTP | xlsx | MIT | второй шаг для xlsx, раздел 6 |
| microsoft/markitdown, `markitdown-mcp` | MCP | чтение pdf, docx, pptx, xlsx | MIT | только чтение, альфа |
| SylphxAI/anymd | MCP через npx | чтение | MIT | только чтение, нативный бинарь |
| iOfficeAI/OfficeCLI | бинарь, MCP, навыки | docx, pptx, xlsx | Apache-2.0 | описание навыка pptx повторяет Anthropic, бинарь не проверяли |
| GongRzhe/Office-Word-MCP-Server | MCP | docx | MIT | архив, 54 инструмента, мусор в stdout |
| GongRzhe/Office-PowerPoint-MCP-Server | MCP | pptx | MIT | архив, нужен `mcp<2` |
| ForLegalAI/mcp-ms-office-documents | MCP HTTP | создание docx, pptx, xlsx | MIT | только создание |
| openai/skills: pdf, doc, spreadsheet, slides | навыки | pdf, docx, xlsx, pptx | Apache-2.0 | три навыка удалены из ветки, pdf без скриптов |
| jztan/pdf-mcp | MCP | чтение pdf | MIT | только чтение, 250 МБ моделей |
| vivekVells/mcp-pandoc | MCP | конвертация | MIT | нужен pandoc и TeX в образе |
| docling-project/docling-mcp | MCP | чтение | MIT | torch и модели, гигабайты |
| dosev-ai/mcp-office | MCP | docx, pptx, xlsx | MIT | часть инструментов требует Windows и Office |
| negokaz/excel-mcp-server | MCP через npx | xlsx | MIT | больше года без изменений |

Подробные заметки по каждому кандидату лежат вне репозитория, в рабочей папке шага поиска.

## 3. Выбор по форматам

| Формат | Что берём | Папка | Зависимости в VM | Правки при переносе |
|---|---|---|---|---|
| docx | hermes-agent `skills/productivity/docx` | `B/docx/` | pip `python-docx` (с ним `lxml`); LibreOffice только для PDF | пути, выходы, имена инструментов, токены шаблона на кириллице |
| pdf | hermes-agent `skills/productivity/pdf` | `B/pdf/` | pip `pypdf reportlab pdfplumber`, apt `fonts-dejavu-core`; `pypdfium2` или poppler только для картинок страниц | пути, выходы, имена инструментов, шрифт DejaVu, без OCR-скриптов |
| pptx | hermes-agent `skills/productivity/powerpoint` | `B/pptx/` | pip `python-pptx`; LibreOffice и poppler только для картинок слайдов | пути, выходы, имена инструментов, имя `pptx`, `ensure_ascii=False` |
| xlsx | hermes-agent `skills/productivity/xlsx` | `B/xlsx/` | pip `openpyxl`; LibreOffice только для пересчёта формул | пути, выходы, имена инструментов |

Почему hermes-agent. Один источник, одна лицензия и один стиль на все четыре формата. Каждый навык это набор CLI-скриптов с `--help` и JSON на выходе, небольшой модели так проще. У источника свои тесты: docx 29, xlsx 12, pptx 21, pdf 21, все прошли при проверке. Общих цепочек из восьми слов с навыками Anthropic 0,1-0,2 процента, это адреса пространств имён XML и строки `import`. Файл `xlsx_recalc.py` назван и написан по-своему.

Почему папка `pptx`, а не `powerpoint`. Форма агента шлёт навык с id `pptx` (`C/pages/agents/AgentFormDialog.tsx:54-59`). Сервер берёт id встроенного навыка из имени папки, а компилятор требует, чтобы `name` в SKILL.md совпадал с папкой. Поэтому `name: powerpoint` стал `name: pptx`.

Что не берём из папки pdf. `scripts/extract_pymupdf.py` и `scripts/extract_marker.py` тянут pymupdf (AGPL) и marker (GPL). Их справочник `references/ocr-extraction.md` уходит вместе с ними. `references/nano-pdf-editing.md` описывает внешний CLI, которому нужен ключ чужой LLM. Сканы без текстового слоя агент разбирает глазами: `pdf_page_image.py` и инструмент `read` для PNG.

Запасной вариант для pdf. Навык pdf из LangAlpha (Apache-2.0) печатает кириллицу без правок, но его SKILL.md весит 34 КБ и ему нужны qpdf и poppler. В LangAlpha есть файл `xlsx/scripts/recalc.py` с именем из навыка Anthropic. Код у него другой, но по правилу отбора навык xlsx из LangAlpha не берём.

## 4. Отвергнутые

| Источник | Лицензия | Причина |
|---|---|---|
| anthropics/skills: docx, pdf, pptx, xlsx | source-available | лицензия запрещает копии и производные работы |
| tfriedel/claude-office-skills | без LICENSE в репозитории | копия навыков Anthropic, в `public/docx/SKILL.md` тот же текст |
| appautomaton/document-SKILLs | объявлена MIT | копия: папка `docx/ooxml/schemas` как у Anthropic |
| ComposioHQ/awesome-claude-skills, `document-skills` | объявлена MIT | копия: `document-skills/docx/ooxml` |
| EveryInc/hands-on-deck | без LICENSE в клоне | скрипты `inventory.py`, `rearrange.py`, `replace.py`, `thumbnail.py` из навыка pptx Anthropic |
| agentscope-ai/QwenPaw, навыки docx | Apache-2.0 | `scripts/office/unpack.py`, `validate.py` из навыка docx Anthropic |
| MiniMax-AI/skills | MIT | SKILL.md и справочники `minimax-xlsx` ссылаются на `recalc.py` и `unpack.py` |
| описания навыков OfficeCLI для docx, pptx, xlsx | Apache-2.0 | описание `officecli-pptx` повторяет описание Anthropic |
| `extract_pymupdf.py`, `extract_marker.py` из hermes pdf | MIT, но зависимости AGPL и GPL | раздел 3 |

## 5. Как подключаем

### 5.1 Папка навыков

- Один навык это одна папка `B/<имя>/`. Имя папки совпадает с `name` в SKILL.md: строчные латинские буквы, цифры и дефис, до 64 знаков.
- В корне папки лежат SKILL.md, LICENSE источника и ATTRIBUTION.md: адрес, коммит, лицензия и список правок.
- Пределы компилятора навыков: до 500 файлов, 32 МБ на файл, 100 МБ на навык, ровно один SKILL.md (`P/managed-agents-adapters-runtime/src/skill-package-compiler.ts:8-10, 105-115`). Парсер frontmatter читает только однострочные пары `key: value`.
- `.claude/skills` и `.agents/skills` не подходят, там навыки для разработчиков.
- Docker. `N/../Dockerfile` копирует папку строкой `COPY skills skills`.
- В VM навык лежит в `/workspace/.openma/skills/<имя>/latest/<имя>/SKILL.md`, скрипты рядом в `scripts/`. У агента с закреплённой версией вместо `latest` стоит хеш версии.

### 5.2 Каталог встроенных навыков на сервере

- Декоратор `BuiltinSkillOverlayStore` (`P/skill-store/src/builtin-overlay.ts`) держит неизменный каталог в памяти и отвечает на чтение встроенного id без учёта рабочего пространства. Остальные запросы уходят во внутреннее хранилище SQL.
- `listSkills` сливает каталог и SQL в порядке `created_at DESC, id DESC` с тем же курсором и фильтром `source`, страницы не дают дублей.
- `deleteSkill`, `appendVersion` и `deleteVersion` для встроенного id отвечают `not_found`. API отдаёт 404, навык остаётся.
- Загрузчик `N/lib/builtin-skills.ts` читает папку, собирает zip тем же `ZipSkillPackageCompiler`, что и загрузка через API. Id навыка равен имени папки, `source` равен `anthropic`, версия это первые 12 знаков SHA-256 по файлам (функция `computeFilesDigest` из `N/lib/skill-sources.ts`). Версия не меняется между перезапусками и меняется при правке файлов. Сломанный навык останавливает старт сервера с понятной ошибкой.
- Папку задаёт `OMA_BUILTIN_SKILLS_DIR`, по умолчанию `platform/skills/builtin` рядом с исходниками. Значение `off` выключает встроенные навыки.
- Подключение идёт через `nodeDefaults` в `N/components.ts`: он кладёт декоратор в `stores.skills`, а `N/modules/node-managed.ts` уже ставит `components.stores` поверх SQL. Сам `node-managed.ts` не меняется.

Почему `source: anthropic`. Так тело агента совпадает с форматом Anthropic API: встроенный навык подключается как `{"type": "anthropic", "skill_id": "docx"}`. Консоль показывает такой источник как «Платформа». Клиент API прочтёт `anthropic` как навык от платформы. Навыки при этом от NousResearch, это видно в ATTRIBUTION.md.

### 5.3 Подготовка VM

- `N/lib/node-managed-session-inputs.ts` принимает тип `anthropic` наравне с `custom`: копирует файлы в VM, строит описание для промпта и напоминание для остальных harness.
- В режиме progressive строка `Read` указывала на `<mountRoot>/SKILL.md`, а файл лежит в `<mountRoot>/<directory>/SKILL.md`. Теперь `mountRoot` включает папку архива. Папка идёт без кодирования, как её пишет подготовка VM, поэтому свой навык с папкой `Мой навык` тоже находится.
- Встроенный навык подключается с версией `latest`. Закреплять хеш не стоит: после правки файлов старой версии не будет, и подготовка VM упадёт.
- Команды в SKILL.md идут через `latest`. Для закреплённой версии Platform notes называет папку `/workspace/.openma/skills/<имя>/<версия>/<имя>/` и просит подставить её в команды.

### 5.4 Консоль, раздел «Навыки»

- Колонки как в консоли Claude: ID, «Имя», «Источник», «Последняя версия», «Обновлено». ID виден сразу, в других списках он спрятан в меню «Столбцы».
- У встроенного навыка чип «Платформа», версия показана хешем как есть. Фильтр «Источник» предлагает «Все», «Платформа», «Пользовательские».
- У строки встроенного навыка нет меню действий. В карточке кнопка «Удалить» выключена, кнопки «Новая версия» нет, выноска объясняет почему. Пример подключения пишет `"type": "anthropic"`.
- Карточка показывает файлы версии из zip `/v1/skills/:id/versions/:version/content` (`C/lib/skill-archive.ts`). Старый предпросмотр `/v1/oma/skills` остался запасным путём.

### 5.5 Пакеты в песочнице

Образ по умолчанию `node:22-bookworm` несёт python3 без pip и без офисных библиотек. Платформа ставит пакеты окружения при каждом старте VM (`P/sandbox/src/environment-setup.ts:78-121`).

- Шаблон «Документы» в окне «Новое окружение» заполняет пакеты: apt `python3-pip fonts-dejavu-core`, pip `python-docx openpyxl python-pptx pypdf reportlab pdfplumber`. Окружение получает метку `metadata.oma_template = "documents"`, как предлагает [environments.md](environments.md). Сеть остаётся «Без ограничений», это значение сервера по умолчанию.
- apt ставится раньше pip (`P/sandbox/src/environment-setup.ts:54`), поэтому pip-пакеты находят `python3-pip`.
- Если пакетов нет, раздел «Platform notes» в SKILL.md велит агенту поставить их командой `python3 -m pip install --break-system-packages` и подсказывает apt-пакет `python3-pip`.
- LibreOffice шаблон не ставит, он весит сотни мегабайт. Без него не работают только PDF из docx и pptx, картинки слайдов и пересчёт формул, скрипты сообщают об этом в JSON.
- Свободного места на диске VM около 120 МБ (`P/sandbox-adapter-litebox/src/litebox.ts:80-83`). pip-пакеты шаблона занимают 77 МБ (замер в venv Python 3.11), `python3-pip` из apt добавляет ещё. Серверу нужен `LITEBOX_DISK_SIZE_GB=4`.
- План [environments.md](environments.md) заменит шаблон образом `workplace-office`, где всё уже установлено.

## 6. MCP

MCP-серверы для документов в этот шаг не вошли. Кандидат для xlsx это haris-musa/excel-mcp-server (MIT): он считает формулы без LibreOffice. Подключение по контракту:

- в теле агента `mcp_servers: [{"name": "excel", "type": "stdio", "command": "/usr/local/bin/excel-mcp-server", "args": ["stdio"]}]`, версию закрепить пакетом окружения `pip excel-mcp-server==2.0.0`;
- stdio-сервер запускает только harness `acp-sandbox`, процесс стартует в VM;
- по коду `buildTools` падает на любом stdio-сервере раньше ACP (`platform/apps/agent/src/harness/tools.ts:1138-1146`). До правки этого места stdio MCP на Node не работает.

## 7. Как включить

1. Сервер. Ничего настраивать не нужно: встроенные навыки берутся из `platform/skills/builtin`. Для своего пути задайте `OMA_BUILTIN_SKILLS_DIR`, для выключения `OMA_BUILTIN_SKILLS_DIR=off`. Для пакетов шаблона задайте `LITEBOX_DISK_SIZE_GB=4`.
2. Окружение. «Окружения», «Новое окружение», шаблон «Документы», «Создать». Для старого окружения добавьте те же пакеты в разделе «Пакеты».
3. Агент. «Агенты», форма агента, вкладка «Навыки», включить Word, PDF, PowerPoint или Excel. Через API: `"skills": [{"type": "anthropic", "skill_id": "docx", "version": "latest"}]`.
4. Сессия на этом окружении. Готовые файлы агент кладёт прямо в `/mnt/session/outputs/`, без подпапок. Они появятся в панели «Результаты сессии».

## 8. Итоги переноса

### 8.1 Что сделано

| Что | Где |
|---|---|
| Четыре навыка, LICENSE и ATTRIBUTION.md | `B/docx`, `B/pdf`, `B/pptx`, `B/xlsx` |
| Шрифт DejaVu для кириллицы в PDF | `B/pdf/scripts/_fonts.py`, правки в `pdf_create.py`, `pdf_stamp.py`, `pdf_make_form.py` |
| Токены `{{имя}}` в шаблоне docx | `B/docx/scripts/docx_template.py` |
| Замена текста docx не зацикливается, когда новый текст содержит старый | `B/docx/scripts/docx_common.py:50-94` |
| Комментарий python-docx 1.2 больше не ломает проверку | `B/docx/scripts/docx_validate.py` |
| Русский текст в выводе pptx без escape-кодов | `B/pptx/scripts/pptx_read.py:115, 126` |
| Декоратор хранилища навыков | `P/skill-store/src/builtin-overlay.ts:79`, экспорт `P/skill-store/package.json`, `P/platform-node/src/index.ts:88-92` |
| Загрузчик папки навыков | `N/lib/builtin-skills.ts:52` |
| Настройка `OMA_BUILTIN_SKILLS_DIR` | `N/config.ts:91, 151-157, 316` |
| Подключение к серверу | `N/components.ts:101, 119-131` |
| Тип `anthropic` в подготовке VM и путь к SKILL.md | `N/lib/node-managed-session-inputs.ts:43, 100-103, 139-150, 330, 356` |
| Docker | `platform/apps/main-node/Dockerfile:58` |
| Консоль «Навыки» | `C/pages/SkillsList.tsx:59, 68, 228-252, 355-437, 516, 529, 685, 758-790`, `C/lib/skill-archive.ts` |
| Шаблон «Документы» | `C/lib/environment-templates.ts`, `C/pages/EnvironmentsList.tsx:97, 304-334` |
| Комментарий, который вёл к anthropics/skills | `platform/apps/agent/src/harness/skills.ts:15-19` |

### 8.2 Проверка

Тесты писались до кода, каждый сначала падал.

- Навыки, uv во временной папке, Python 3.11 как в Debian 12: docx 33, pdf 24, pptx 22, xlsx 12, все 91 прошли. Новые проверки кириллицы в конце каждого файла тестов.
- `P/skill-store-memory/test/builtin-overlay.test.ts`: 7 тестов декоратора.
- `NT/builtin-skills.test.ts`: загрузчик, четыре навыка в репозитории, Dockerfile, настройка, Skills API (список, архив, 404 на удаление и новую версию).
- `NT/node-managed-session-inputs.test.ts`: тип `anthropic` в VM, напоминание, путь `mountRoot` с папкой архива, закреплённая версия каждого встроенного навыка, папка архива с пробелом и кириллицей. Старый тест «built-in skills are skipped» заменён, он закреплял ошибку.
- `NT/config.test.ts` и `NT/skill-sources.test.ts`: новое поле `paths.builtinSkills`; тесты источников навыков выключают встроенные, потому что считают строки списка.
- `NT/managed-agents-route.test.ts` запускает настоящий процесс main-node. `/v1/oma/stats` теперь считает и навыки платформы, ожидание стало `1 + число папок в B/`.
- Весь main-node: 520 тестов прошли, 3 упали. Упавшие и 9 файлов, которые не загрузились, ссылаются на папки, которых нет в рабочей копии (`apps/main/migrations`, `test/fakes`, `harness-cards`), к навыкам они не относятся.
- Консоль: `SkillsList.platform.test.tsx` (5), `lib/skill-archive.test.ts` (2), `EnvironmentsList.templates.test.tsx` (2), прежний `SkillsList.sources.test.tsx` прошёл без правок. Весь набор: 892 теста прошли, 23 упали в `agentFormCodec.test.ts`, его сейчас правит другой поток.
- typecheck: main-node, skill-store, skill-store-memory, platform-node без ошибок. В консоли ошибки только в чужом `agentFormCodec.test.ts`.

Не проверено: ход агента в настоящей VM LiteBox с навыком и шаблоном «Документы». Нужен прогон verify-agent-console с моделью.

### 8.3 Перекрёстное ревью Codex

Codex нашёл две ошибки, обе подтверждены запуском и исправлены с тестом.

- `docx_edit.py replace` зависал при замене `Acme` на `Acme Ltd`: цикл находил старый текст внутри новой замены. Ошибка из источника, правка в `B/docx/scripts/docx_common.py`, тесты `TestPlatformPort` в `B/docx/tests/test_docx_skill.py`.
- Команды SKILL.md шли через `latest/`, а закреплённая версия монтируется в папку с хешем. В Platform notes каждого навыка добавлена строка про эту папку, тест в `NT/node-managed-session-inputs.test.ts` сверяет её с настоящим `mountRoot`.

При проверке нашлась третья ошибка: `mountRoot` кодировал имя папки архива, а файлы писались без кодирования. Исправлено там же, `N/lib/node-managed-session-inputs.ts:147-150`.

## 9. Риски

- Версия встроенного навыка это хеш файлов. После правки файла старой версии нет, агент с закреплённой версией получит ошибку при подготовке VM. Подключать с `latest`.
- Удаление папки из `B/` ломает сессии агентов, которые ссылаются на навык (`N/lib/node-managed-session-inputs.ts`, ошибка `Managed Skill <id> has no version`).
- Заголовок «Навыки Anthropic» в форме агента (`C/pages/agents/AgentFormDialog.tsx:1013`) теперь неверен, нужен «Встроенные навыки». Файл правит другой поток.
- Клиент API видит `source: anthropic` у навыков NousResearch. Это формат Anthropic API, авторство описано в ATTRIBUTION.md.
- Пакеты шаблона ставятся заново при каждом старте VM, это удлиняет старт. Без `LITEBOX_DISK_SIZE_GB` на диске VM может не хватить места.
- Нижний колонтитул docx `Page X of Y` пишется по-английски (`docx_edit.py page-numbers`), для русского документа агент пишет свой текст колонтитула.
- Каждый файл навыка копируется в VM отдельным `copyIn`: docx 13 файлов, pdf 19, pptx 9, xlsx 12.
- stdio MCP на Node не работает, раздел 6.
- Карточка «Навыки» на главной (`/v1/oma/stats`) считает навыки платформы, в пустом пространстве там 4. Если нужно считать только свои, правка в `N/modules/node-http.ts`, этот файл правит другой поток.
