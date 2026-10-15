# 02. Управляемые агенты: списки и карточки (Claude Console, Managed Agents)

Обход выполнен 16.10.2026 во встроенном браузере, только чтение. Ничего не создано, не изменено, не удалено, не запущено: формы не отправлялись, в поля ничего не вводилось (кроме строки поиска в списке агентов), все диалоги закрыты через Escape или Cancel.

Правила записи: ключи, токены, почта, имена людей, номера счетов и суммы не приводятся. Участник = «участник», сумма = «сумма». Идентификаторы ресурсов записаны шаблоном (`agent_<22 символа>`). Все размеры в CSS-пикселях для окна 1586 x 1280 (если не сказано иное). Скриншоты лежат в `.audit/cma-screens/02-managed-agents/` (папка в .gitignore).

## Таблица «панель → путь → скриншот»

Базовый путь везде `/workspaces/default/...` (в тексте опущен как `…`). `<id>` вместо идентификатора ресурса.

| № | Панель | Путь | Скриншот |
|---|---|---|---|
| 1.1 | Quickstart: выбор шаблона | `…/agent-quickstart` | quickstart-step1.jpg |
| 1.2 | Quickstart: диалог шаблона (с «Outcome») | `…/agent-quickstart?template=deep-research` | quickstart-template-dialog.jpg |
| 1.3 | Quickstart: диалог шаблона (с MCP и расписанием) | `…/agent-quickstart?template=field-monitor` | quickstart-template-dialog-mcp.jpg |
| 1.4 | Quickstart: мастер, шаг 1 «Create agent» | `…/agent-quickstart/new` | quickstart-wizard.jpg |
| 1.5 | Quickstart: правая панель «Agent config» (YAML) | `…/agent-quickstart/new` | quickstart-wizard-config.jpg |
| 2.1 | Agents: список | `…/agents` | agents-list.jpg |
| 2.2 | Agents: меню строки «…» | `…/agents` | agents-row-menu.jpg |
| 2.3 | Agents: фильтр «Created» | `…/agents` | agents-filter-created.jpg |
| 2.4 | Agents: фильтр «Status» | `…/agents` | agents-filter-status.jpg |
| 2.5 | Agents: пустой результат поиска | `…/agents` | agents-list-no-match.jpg |
| 2.6 | Agents: выбор строк, нижняя панель массовых действий | `…/agents` | agents-list-bulk.jpg |
| 2.7 | Agents: быстрый просмотр (Rendered) | `…/agents?agent=<id>` | agents-quickview.jpg |
| 2.8 | Agents: быстрый просмотр (API) | `…/agents?agent=<id>` | agents-quickview-api.jpg |
| 3.1 | Создание агента: страница, вкладка «Describe your agent» | `…/agents/new` | agent-new.jpg |
| 3.2 | Создание агента: вкладка «Template» | `…/agents/new` | agent-new-template-tab.jpg |
| 3.3 | Создание агента: вид «Raw» (YAML) | `…/agents/new` | agent-new-raw.jpg |
| 3.4 | Создание агента: меню выбора модели | `…/agents/new` | agent-new-model-menu.jpg |
| 3.5 | Создание агента: подменю «Effort» | `…/agents/new` | agent-new-effort-menu.jpg |
| 3.6 | Создание агента: раздел «Tools» раскрыт | `…/agents/new` | agent-new-tools.jpg |
| 3.7 | Создание агента: меню политики разрешений (Auto) | `…/agents/new` | agent-new-permission-policy-menu.jpg |
| 3.8 | Создание агента: «Add MCP server» | `…/agents/new` | agent-new-add-mcp.jpg |
| 3.9 | Создание агента: «Add custom tool» (карточка new_tool) | `…/agents/new` | agent-new-custom-tool.jpg |
| 3.10 | Создание агента: «Skills» и «Multiagent» раскрыты | `…/agents/new` | agent-new-skills-multiagent.jpg |
| 3.11 | Создание агента: выбор навыка | `…/agents/new` | agent-new-add-skill.jpg |
| 3.12 | Создание агента: Multiagent, «Subagents» отмечен | `…/agents/new` | agent-new-multiagent-subagents.jpg |
| 3.13 | Создание агента: Multiagent, «Advisor» отмечен | `…/agents/new` | agent-new-multiagent-advisor.jpg |
| 4.1 | Карточка агента: вкладка Configuration | `…/agents/<id>` | agent-card-configuration.jpg |
| 4.2 | Карточка агента: выбор версии | `…/agents/<id>` | agent-card-version.jpg |
| 4.3 | Карточка агента: меню «…» шапки | `…/agents/<id>` | agent-card-menu.jpg |
| 4.4 | Карточка агента: вкладка Sessions | `…/agents/<id>?tab=sessions` | agent-card-sessions.jpg |
| 4.5 | Sessions: фильтр «Status» (мультивыбор) | то же | agent-card-sessions-filter-status.jpg |
| 4.6 | Sessions: фильтр «Deployment» | то же | agent-card-sessions-filter-deployment.jpg |
| 4.7 | Sessions: фильтр «Version» | то же | agent-card-sessions-filter-version.jpg |
| 4.8 | Карточка агента: вкладка Deployments (пусто) | `…/agents/<id>?tab=deployments` | agent-card-deployments-empty.jpg |
| 4.9 | Карточка агента: вкладка Observability | `…/agents/<id>?tab=observability` | agent-card-observability.jpg |
| 4.10 | Observability: «Group by» | то же | agent-card-observability-groupby.jpg |
| 4.11 | Observability: фильтр версии графика | то же | agent-card-observability-version-filter.jpg |
| 5.1 | Deployments: список (пусто) | `…/deployments` | deployments-list-empty.jpg |
| 5.2 | Создание деплоймента: страница, триггер Manual | `…/deployments/new` (из карточки агента: `?agent=<id>`) | deployment-new.jpg |
| 5.3 | Создание деплоймента: триггер Schedule | то же | deployment-new-schedule.jpg |
| 5.4 | Создание деплоймента: «Frequency» | то же | deployment-new-frequency.jpg |
| 5.5 | Создание деплоймента: выбор агента | то же | deployment-new-agent-select.jpg |
| 5.6 | Создание деплоймента: «Add resource» | то же | deployment-new-add-resource.jpg |
| 6.1 | Environments: список | `…/environments` | environments-list.jpg |
| 6.2 | Environments: быстрый просмотр | `…/environments?environment=<id>` | environments-quickview.jpg |
| 6.3 | Environment: карточка | `…/environments/<id>` | environment-card.jpg |
| 6.4 | Environment: раздел «Packages» раскрыт | `…/environments/<id>` | environment-card-packages.jpg |
| 6.5 | Создание окружения: Cloud | `…/environments/new` | environment-new.jpg |
| 6.6 | Создание окружения: Self-hosted | `…/environments/new` | environment-new-selfhosted.jpg |
| 7.1 | Credential vaults: список | `…/vaults` | vaults-list.jpg |
| 7.2 | Credential vaults: диалог «Create vault» | `…/vaults` | vaults-create-dialog.jpg |
| 7.3 | Credential vaults: быстрый просмотр | `…/vaults?vault=<id>` | vaults-quickview.jpg |
| 7.4 | Vault: карточка | `…/vaults/<id>` | vault-card.jpg |
| 7.5 | Vault: меню «…» шапки | `…/vaults/<id>` | vault-card-menu.jpg |
| 7.6 | Vault: диалог «Add credential», тип MCP OAuth | `…/vaults/<id>` | vault-add-credential-dialog.jpg |
| 7.7 | Vault: выпадающий список типов | `…/vaults/<id>` | vault-add-credential-types.jpg |
| 7.8 | Vault: диалог, тип Environment variable | `…/vaults/<id>` | vault-add-credential-envvar.jpg |
| 8.1 | Memory stores: список | `…/memory-stores` | memory-stores-list.jpg |
| 8.2 | Memory stores: диалог «Create memory store» | `…/memory-stores` | memory-stores-create-dialog.jpg |
| 8.3 | Memory stores: быстрый просмотр | `…/memory-stores?store=<id>` | memory-stores-quickview.jpg |
| 8.4 | Memory store: карточка (дерево файлов) | `…/memory-stores/<id>` | memory-store-card.jpg |
| 8.5 | Memory store: диалог «Add memory» | `…/memory-stores/<id>` | memory-store-add-dialog.jpg |
| 9.1 | Узкий экран 390: список агентов | `…/agents` | mobile-agents-list.jpg |
| 9.2 | Узкий экран 390: карточка агента | `…/agents/<id>` | mobile-agent-card.jpg |
| 9.3 | Узкий экран 390: создание агента | `…/agents/new` | mobile-agent-new.jpg |
| 9.4 | Узкий экран 390: Quickstart | `…/agent-quickstart` | mobile-quickstart.jpg |

---

## 0. Общие шаблоны (повторяются на всех панелях раздела)

### 0.1 Оболочка
- Левое меню 256 px, на узком экране сворачивается в рейку 48 px (см. раздел 9). Группа «Managed Agents» содержит: Quickstart, Agents, Sessions, Deployments, Environments, Credential vaults, Memory stores. Sessions описана в разделе 03.
- Рабочая область: отступ слева и справа по 24 px, содержимое с x=280 до x=1562 (ширина 1282). Фон страницы тёплый светлый (`rgb(252,252,251)`), карточки и диалоги белые, радиус диалога 12 px.
- Шрифт без засечек, заголовок страницы 22 px, вес 500; основной текст 14 px; заголовки блоков формы 14 или 15 px.
- Липких элементов в списках и карточках нет. Липкий нижний бар (≈ 56 px с кнопками «Cancel» и главной) есть только на страницах создания.

### 0.2 Страница-список (Agents, Deployments, Environments, Credential vaults, Memory stores)
Зоны сверху вниз:
1. Шапка (y=24): заголовок `h1` 22/500 высотой 32; под ним подзаголовок серым (y=64, высота 20), одна фраза о назначении раздела. Справа в той же строке: главная чёрная кнопка с плюсом («+ Create …», высота 32, радиус 8) и рядом квадратная кнопка 32x32 с иконкой книги («View documentation», ведёт в документацию, открывается в новой вкладке).
2. Панель фильтров (y=100, высота 32): слева поле поиска 272x32 с лупой (плейсхолдер «поиск по имени или точному ID»), справа от него чипы-фильтры высотой 32, формата «подпись значение» (например `Created by Anyone`), промежуток 16 px. Когда фильтр отличается от значения по умолчанию или введён поиск, в конце строки справа появляется текстовая кнопка `Reset`.
3. Таблица (y=140): строка заголовков 32 px (не липкая), строки данных 46 px, шрифт 14 px. Первая колонка 40 px: флажок (в заголовке «Select all rows»). Последняя колонка «Actions» 56 px.
4. Низ: плавающая панель массовых действий появляется только при выбранных строках (см. 2.6). Пагинации и «Load more» при числе строк от 1 до 3 не видно (не проверено при большом числе строк).

Ячейки:
- ID: моноширинный текст (`agent_…`, `env_…`, `vlt_…`, `memstore_…`, `sesn_…`) и рядом иконка «Copy» 20x20.
- Имя: обычный текст-ссылка.
- «Created by»: круглый аватар с инициалом, подпись «User» мелким серым и имя участника.
- Время: относительное («14 hours ago», «15 hours ago»).
- Бейджи: серая плашка с иконкой (например «Cloud», «Organization», «Idle»).
- Вся строка работает как ссылка на карточку (ячейки обёрнуты в ссылки). При наведении строка подсвечивается серым и появляется кнопка «Quickview ⧉» (97x24) слева от кнопки «…» (28x28). Кнопка «…» видна всегда.

Меню строки «…» (поповер 128 px шириной, пункты высотой 32): набор зависит от сущности, опасные пункты («Archive», «Delete») красные (`rgb(142,38,38)`).

### 0.3 Быстрый просмотр (Quickview)
- Открывается кнопкой «Quickview» в строке. Правая плавающая панель 560 x 1264, отступ 8 px от краёв окна (x=1018, y=8), скругление, лёгкая тень. Затемнения нет: список остаётся видимым и доступным, текущая строка подсвечена. Появляется с лёгкой анимацией съезда справа.
- В адресе добавляется параметр (`?agent=<id>`, `?environment=<id>`, `?vault=<id>`, `?store=<id>`).
- Шапка панели: подпись типа («Agent», «Environment», «Credential vault», «Memory store»), ID моноширинно с копированием; справа три кнопки 24x24: «Previous», «Next» (соседняя строка списка), «Close details».
- Заголовок: иконка, имя, у агента значок версии «V1»; справа ссылка-кнопка `Open ↗` (переход на карточку) и «…» (то же меню, что у строки).
- Блок свойств в две колонки: ключ и значение.
- Секции с заголовками серым 12 или 13 px.
- Нижний правый угол, закреплён: сегментный переключатель «Rendered | API». Режим API показывает строку запроса (плашка `GET` и путь `/v1/…`, справа ссылка «Docs») и JSON ответа моноширинным шрифтом с подсветкой.

### 0.4 Страница-карточка
- Верх: хлебная крошка (ссылка на список слева, текущее имя справа, y=16, высота 28). Под ней заголовок 22/500 (y=60) с иконкой слева; справа кнопки.
- Под заголовком серая строка метаданных: ID моноширинно с копированием, «Last updated …» или «Created …», аватар и имя создателя.
- Дальше либо вкладки (агент), либо сразу содержимое.

### 0.5 Страница создания (Agent, Deployment, Environment)
- Содержимое центрируется колонкой 768 px (x=537…1305). Заголовок `h1` (y=60), под ним фраза-описание.
- Форма разбита на блоки: слева колонка заголовка блока 224 px (название и серое пояснение, при необходимости ссылка `Learn more ↗`), справа колонка полей 516 px (x=789). Между блоками тонкая горизонтальная линия.
- Поля: подпись над полем (мелкая, 12 или 13 px, например `Name`), поле высотой 32, текстовая область минимум 56, «(optional)» серым после подписи.
- Нижний липкий бар: слева текстовая ссылка «Cancel», справа чёрная кнопка («Create agent», «Create deployment», «Create environment»). На странице карточки (редактирование) бар не показан до появления правок (не проверено).
- Сворачиваемые разделы формы: заголовок со стрелкой и словом «(optional)», справа от заголовка в свёрнутом виде краткая сводка («None», «Built-in tools», «Configured», «Limited»).

### 0.6 Диалоги
- Центрированное окно шириной 520 px, радиус 12, заголовок слева, крестик «Close» 32x32 справа. Кнопка подтверждения справа внизу, до заполнения серая (disabled). Фон затемняется. Закрывается через Escape и крестик.

---

## 1. Quickstart

### 1.1 Выбор шаблона, `…/agent-quickstart`
Назначение: быстрый старт, описать агента словами или взять шаблон.
- Раскладка: по центру колонка, заголовок `h1` «What do you want to build?» (22 px, y=64), подзаголовок «Describe your agent, or pick a template to start from.». Дальше поле ввода-описание и сетка шаблонов, внизу ссылка.
- Поле описания: текстовая область 616x76 (x=593, y=156), плейсхолдер «A support agent that answers questions from our docs and escalates to Slack when it's stuck…», справа внизу круглая оранжевая кнопка со стрелкой 32x32 («Create agent», запускает генерацию, не нажималась).
- Сетка шаблонов: 3 колонки по 288 px, промежуток 16, карточки высотой ~128 (высота зависит от текста), всего 12 карточек: Deep researcher, Structured extractor, Field monitor, Support agent, Incident commander, Contract tracker, Sprint retro facilitator, Support-to-eng escalator, Data analyst, Bug hunter, Stock watchlist scanner, Video explainer maker. Карточка: название жирнее, описание в 2 или 3 строки серым, внизу строка меток: логотипы интеграций (notion, slack, linear, sentry, github, box, asana, intercom, atlassian, amplitude) и/или чип со значком: «Outcome-optimizing», «Recurring» (регулярный запуск), «Dynamic workflow», либо метка формата «docx».
- Ссылка внизу по центру: «Or start from a blank agent.» (кнопка-ссылка, ведёт на мастер 1.4).
- Клик по карточке открывает диалог шаблона (1.2), в адресе появляется `?template=<slug>`; «Cancel» возвращает адрес без параметра.
- Состояние загрузки: серые скелетоны карточек и пустой каркас меню.
- 390 px: шаблоны становятся одной колонкой (карточки 294 px шириной, высота от 112 до 128), поле описания на всю ширину колонки (238x76 + кнопка).

### 1.2 и 1.3 Диалог шаблона, `…/agent-quickstart?template=<slug>`
- Диалог 1024 x 753 по центру (x=281, y=264), радиус 12, белый, фон страницы затемнён полупрозрачной подложкой.
- Верх: название шаблона и описание; справа крестик 32x32.
- Для шаблонов с критерием результата: строка «Outcome» с чипом «Outcome-optimizing» и текст ожидаемого результата, ниже сворачиваемый блок «How the result is judged» (список критериев, свёрнут по умолчанию).
- Для шаблонов с интеграциями и расписанием: блок «MCP servers» (логотип и имя) и блок «Suggested schedule» (например «Mon at 9:00 AM <часовой пояс>»).
- Блок «Agent config»: заголовок слева, справа выпадающий выбор формата (24 px высотой, значения `YAML` по умолчанию, `TypeScript`, `Python`, `cURL`, радио-меню) и иконка «Copy». Ниже редактор кода 13 px моноширинно с цветной подсветкой YAML (поля `name`, `description`, `model{id, effort}`, `system`, `mcp_servers`, `tools`, `metadata{template}`), с внутренним скроллом.
- Низ: «Cancel» (вторичная) и «Use this template» (чёрная, 141x32, не нажималась).

### 1.4 Мастер, шаг 1, `…/agent-quickstart/new`
- Верхняя полоса: ссылка-кнопка «← Templates» (28 px высотой, x=268, y=8).
- Центр: заглушка «Describe your agent» и пояснение «Say what it should do. The config takes shape on the right, and you create it from here.» (иконка над ними), внизу прикреплённое поле чата 640x54 (x=416, y=1194) с плейсхолдером «Describe your agent…» и круглой кнопкой «Send message» 32x32 (серая, disabled, пока поле пустое).
- Правая колонка 272 px (x=1290…1562), три карточки:
  1. «Progress»: четыре шага с номерными кружками 24 px: `1 Create agent`, `2 Configure environment`, `3 Start session`, `4 Integrate`. Шаг 1 активен.
  2. «Agent»: кнопка-карточка 256x32 с иконкой агента, названием «Untitled agent», плашкой «Draft» и стрелкой; клик открывает панель конфигурации (1.5).
  3. «Resources»: пусто, текст «Track the environment, vault, and deployment as they're created.», иконка. Внизу кнопка «Export as code» (272x28; не нажималась).
- Шаги 2, 3 и 4 не открывались: для перехода нужно отправить описание или создать агента (см. «Не открыто»).
- Для справки (из документации): те же шаги в API: создать агента, создать окружение, запустить сессию, отправить сообщение и читать поток событий.

### 1.5 Панель «Agent config», там же
- Кнопка «Untitled agent / Draft» заменяет правую колонку на редактор конфигурации 617 px шириной (x=945…1562) на всю высоту: заголовок «Agent config», справа формат (`YAML` и др.), «Copy code», «Close panel» (24x24).
- Редактор CodeMirror: колонка номеров строк 60 px, строка 21 px, шрифт 13 px моноширинно, строки с 1 по 14 (пустой агент: `name`, `description`, `model.id`, `model.effort`, `system`, `mcp_servers: []`, `tools`, `skills: []`). Подсказка доступности: «Tab inserts indentation. Press Escape then Tab to move focus out of the editor.»
- По умолчанию модель `claude-opus-5-5`, усилие `low`, политика инструментов `auto`.

---

## 2. Agents, список

### 2.1 Список, `…/agents`
Назначение: список автономных агентов рабочего пространства.
- Шапка: заголовок «Agents», подзаголовок «Create and manage autonomous agents.»; справа чёрная ссылка «+ Create agent» (173 px, ведёт на страницу `…/agents/new`) и кнопка-книга (документация по настройке агента).
- Фильтры: поиск «Search by name or exact ID»; чипы `Created by Anyone` (162 px), `Created All time` (142), `Status Active` (123). По умолчанию показываются только активные (не архивные).
- Колонки по порядку (ширины): флажок 40; `ID` 286 (моноширинный, копирование); `Name` 234; `Model` 160 (id модели моноширинно, серый); `Created by` 234 (аватар + User + имя); `Created` 148; `Last updated` 148; `Actions` 56.
- Строки 46 px. Клик по строке открывает карточку агента (4.1) на новой странице. «Quickview» открывает панель (2.7). Сортировки колонок нет (заголовки не кнопки).
- Три агента в списке на момент обхода.
- Меню строки (2.2): `Start session`, `Archive agent` (красный).
- Состояния: загрузка (серые скелетоны строк, статус «Loading»); результат после поиска без совпадений (2.5); ошибки и «нет доступа» не встретились.

### 2.3 и 2.4 Фильтры
- `Created by`: поповер 320 px, одна опция: текущий участник (аватар, имя, метка «You»); выбранное значение по умолчанию «Anyone».
- `Created`: меню `All time` (галочка), `Last 7 days`, `Last 30 days`, `Custom range`.
- `Status`: меню `Active` (галочка), `All`.
- Поиск работает на клиенте без изменения адреса; в поле появляется крестик очистки.

### 2.5 Пустой результат
Таблица остаётся с заголовками, в центре иконка (схема связей), заголовок «No matching agents», подпись «No agents match the current filters.», вторичная кнопка «Reset filters»; в панели фильтров справа появляется ссылка-кнопка «Reset».

### 2.6 Выбор строк
Флажок в заголовке (`Select all rows`) и в строках (`Select <имя>`). Выбранные строки подсвечены. Снизу по центру окна появляется тёмная плавающая плашка (≈ 44 px высотой, y≈1214): «<N> selected», кнопка-крестик «Clear selection» (28x28) и кнопка «Archive» (91x28). Нажималась только «Clear selection».

### 2.7 и 2.8 Быстрый просмотр агента, `…/agents?agent=<id>`
Шапка и общий каркас по 0.3. Содержимое:
- Заголовок: имя агента, значок версии `V1`, `Open ↗`, «…» (`Start session`, `Archive agent`).
- Свойства: `Created by` (аватар, User, имя), `Created`, `Updated`, `Model` (id и «Low effort»).
- Секции: `Description`; `System prompt` (полный текст, 14 px); `Tools` (карточка «Built-in tools» с ID набора `agent_toolset_20260401` и сворачиваемой строкой «Tool permissions 8» и значением политики «Auto» справа), `Skills` («No skills configured. `Learn more ↗`»), `Multiagent` («No subagents configured. `Learn more ↗`»).
- Нижний переключатель `Rendered | API`. Вид API: `GET /v1/agents/<id>?version=1` и JSON с полями `archived_at`, `created_at`, `created_by{type,user_id}`, `description`, `execution_identity{type: service_account}`, `id`, `mcp_servers`, `metadata`, `model{effort{type}, id, speed}`, `multiagent`, `name`, `skills`, `system`, `tools[…]`, `type`, `updated_at`, `version`.

---

## 3. Создание агента, `…/agents/new` (отдельная страница)

Хлебная крошка `Agents / New agent`. Заголовок «Create agent», подзаголовок «Start from a template or describe what you need.» Колонка 768 px по центру.

### 3.1 Starting point
Сворачиваемый блок (по умолчанию раскрыт; справа от заголовка показан выбранный вариант «Blank agent»). Сегментный переключатель на всю ширину (768 x 30): `Describe your agent` (по умолчанию) / `Template`.
- «Describe your agent»: текстовая область 768x56, плейсхолдер «Summarizes new GitHub PRs and posts a digest to Slack.»; под ней кнопка «Generate» справа (86x32, до ввода серая). Отправка вызывает модель, не нажималась.
- «Template» (3.2): сетка 3 колонки по 248 px, промежуток 12, карточки ~121 px, шесть карточек: Blank agent («Start from scratch with just the core toolset and a generic prompt.»), Deep researcher (чип «Outcome-optimizing»), Structured extractor, Field monitor, Support agent, Incident commander. На карточках логотипы интеграций.

### 3.3 Блок «Agent config» с переключателем `Rendered | Raw`
Переключатель справа (89 + 52 px). `Rendered` по умолчанию открывает форму, `Raw` открывает редактор YAML/JSON: поле 768x341 с шапкой, в шапке слева выпадающий формат (`YAML` 69x24) и справа «Copy» (24x24); строки 21 px, шрифт 13 px, 14 строк для пустого агента.

Форма (`Rendered`), блок «General» («What this agent is and how it's prompted.»):
- `Name`: поле 516x32, плейсхолдер «Descriptive name for this agent», значение по умолчанию «Untitled agent».
- `Model`: кнопка-выбор 320x32 со значением «claude-opus-5-5 · Low effort»; поповер 3.4.
- `Description (optional)`: область 516x56, плейсхолдер «What this agent does, for humans and other agents», по умолчанию «A blank starting point with the core toolset.».
- `System prompt (optional)`: область 516x76 (на странице карточки 516x384), по умолчанию общий промпт «general-purpose agent». Растягивается за правый нижний угол.

### 3.4 и 3.5 Выбор модели
Поповер 320 x 552 под кнопкой. Список (по одной строке от 28 до 32 px, текущий с галочкой): claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5 (выбран), claude-fable-5-1, claude-opus-5, claude-sonnet-5, claude-fable-5, claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6, claude-opus-4-6, claude-opus-4-5-20251101, claude-haiku-4-5-20251001. Затем разделитель и строка «Effort» со значением «Low ›» и боковым подменю 320 x 242 (подсказка «How thoroughly Claude responds; lower effort saves tokens.», пункты `Default`, `Low` ✓, `Medium`, `High`, `Extra high`, `Max`); затем раздел «Speed» со строкой «Fast», пояснением «Quicker output at a higher price.» и переключателем (выключен). Escape закрывает подменю и поповер без изменений.

### 3.6, 3.7, 3.8 и 3.9 Раздел «Tools (optional)»
Свёрнут: справа «Built-in tools». Раскрыт: слева пояснение «Everything this agent can call: built-in tools, MCP servers, and your own tool definitions.» и «Learn more ↗»; справа:
- Карточка «Built-in tools» (`agent_toolset_20260401`, моноширинно) с иконкой-кнопкой «Disable built-in tools» 24x24 (корзина).
- Сворачиваемая строка «Tool permissions 8» и справа выпадающий выбор политики по умолчанию (88x28): `Auto` (по умолчанию, ✓), `Always allow`, `Always ask`, `Always deny` (у каждого пункта цветная иконка, пояснений нет).
- Список из 8 инструментов (строки 37 px): `bash` (Execute bash commands), `read` (Read files), `write` (Write files), `edit` (String replacement in files), `glob` (File pattern matching), `grep` (Text search with regex), `web_fetch` (Fetch URL content), `web_search` (Search the web). У каждой строки справа четыре иконки-кнопки 26x26, это сегментный выбор политики инструмента: Auto (по умолчанию), Always allow, Always ask, Always deny. У `web_fetch` и `web_search` слева стрелка раскрытия (не раскрывалась).
- Под списком две кнопки-ссылки: «+ Add MCP server» и «+ Add custom tool».
  - «Add MCP server» открывает поповер 320 x 320: поле поиска «Search MCP servers or enter a URL» и список каталога (иконка, имя, адрес сервера двумя строками; в каталоге несколько сотен пунктов (около 780 опций в разметке): Google Drive, Gmail, Google Calendar, Canva, Microsoft 365, Notion, Figma, Slack, HubSpot, Asana, Linear, monday.com, Intercom, Box и другие); прокрутка внутри.
  - «Add custom tool» добавляет в форму карточку «new_tool» с меткой «custom», кнопкой «Remove new_tool» и сворачиваемым блоком «Definition»: поля `Name` (по умолчанию «new_tool»), `Description` (плейсхолдер «What the tool does, and when to call it»), `Input schema` (редактор JSON с `{"type": "object", "properties": {}}`). Добавленная пустая карточка удалена кнопкой «Remove» (форма не сохранялась).

### 3.10 и 3.11 Раздел «Skills (optional)»
Свёрнут: «None». Раскрыт: пояснение «Packaged instructions and scripts this agent loads when it needs them.» и «Learn more ↗»; справа кнопка «+ Add skill» (88x28). Поповер выбора: поле «Search skills», пункты `xlsx`, `pptx`, `pdf`, `docx` с чипом «Anthropic», внизу ссылка «Create skill ↗». Навыки пользователя в списке отсутствуют.

### 3.10, 3.12 и 3.13 Раздел «Multiagent (optional)»
Свёрнут: «None» (после включения опций «Configured»). Раскрыт: пояснение «Subagents this agent can spawn and delegate work to.» и «Learn more ↗»; справа три флажка с подписью и подсказкой:
- `Workflows`: «Plans the work itself, then runs it as a workflow of agents working in parallel.» (без доп. настроек).
- `Subagents`: «Hands tasks to other agents, each in a thread of its own.» При включении появляются вложенный флажок «Can define its own agents» (включён; «Agents it writes for one task. They aren't saved.»), подпись «Saved agents it can use» и кнопка «+ Add agent».
- `Advisor`: «A stronger model this agent consults mid-turn.» При включении появляется выбор модели (по умолчанию claude-haiku-5-5).
Включённые на странице флажки не сохранялись; страница закрыта без отправки.

Низ страницы: липкий бар, слева «Cancel», справа «Create agent» (111x32).

---

## 4. Карточка агента, `…/agents/<id>`

### 4.1 Шапка и вкладка Configuration
- Крошка `Agents / <имя>`; заголовок 22/500 с иконкой; справа кнопка «Start session» (130x32, с иконкой play; не нажималась) и «…» (28x28).
- Под заголовком: описание (серым), затем строка: ID моноширинно (копирование), «Last updated 14 hours ago», аватар и имя создателя.
- Вкладки (подчёркнутые ссылки, y=155, высота 32): `Configuration` (116 px), `Sessions` (83), `Deployments` (113), `Observability` (115). Адрес вкладки `?tab=sessions|deployments|observability`, у Configuration параметра нет.
- Панель инструментов: слева выбор версии `Version: 1 [Latest]` (157x32), справа переключатель `Rendered | Raw` (x=906…1047).
- Форма та же, что при создании (раздел 3), колонка 768 px прижата влево (x=280…1048), поля x=532…1048; заголовок блока «General» слева; системный промпт 516x384. Разделы «Tools», «Skills», «Multiagent» свёрнуты (65 px на строку, сводки «Built-in tools», «None», «None»), раскрываются так же, как при создании.
- Панель сохранения при правках не наблюдалась (правок не вносилось).

### 4.2 Выбор версии
Поповер 256 x 57: одна строка «v1 [Latest] ✓» и ниже «Created <дата>». Список версий растёт при каждом сохранении (в данных одна версия).

### 4.3 Меню «…» шапки
`Start session`, `Guided edit`, `Create deployment`, `Archive` (красный). Не выбирались.

### 4.4, 4.5, 4.6 и 4.7 Вкладка Sessions, `…?tab=sessions`
- Фильтры: `Created by Anyone`, `Created All time`, `Version All` (поповер 1 пункт «v1 · 14 hours ago»), `Deployment All` (поповер 320 px: поиск «Search by name or exact ID», пусто: «No deployments for this agent yet.»), `Status All` (мультивыбор с флажками: `Running`, `Idle`, `Rescheduling`, `Terminated`, все отмечены).
- Колонки: флажок; `ID` (`sesn_…`, копирование; 279 px); `Name` (146; `–` если пусто); `Status` (124; серая плашка «Idle» и др.); `Version` (96; «v1»); `Cost` (136; формат «сумма / лимит»); `Tokens in / out` (136; формат «411.1K / 20.1K», подсказка при наведении «Tokens: cache read …, cache creation …, uncached …, output …»); `Created by` (146; аватар, User, имя); `Created` (148; заголовок-кнопка сортировки, значение «14 hours ago»); `Actions`.
- Строка ведёт на страницу сессии (раздел 03); «Quickview» и «…» как в 0.2 (содержимое меню сессии не открывалось).

### 4.8 Вкладка Deployments, пусто
По центру иконка-таблица, заголовок «No deployments», подпись «Deploy this agent to run it on a schedule or manually.», вторичная ссылка «+ Create deployment» (172x32, ведёт на `…/deployments/new?agent=<id>`).

### 4.9, 4.10 и 4.11 Вкладка Observability, `…?tab=observability`
Данные обновляются примерно раз в 3 часа (надпись справа в панели инструментов «Updated approximately every 3 hours»).
- Панель инструментов: `Range` (160x32): `Last day`, `Last 7 days`, `Last 30 days` (по умолчанию); `Group by` (149x32): `Version` (по умолчанию), `Outcome`, `Errored`.
- Ряд из 4 плиток (сетка 4 колонки, ширина ≈ 308, промежуток 16, высота ≈ 130): `Sessions` (число), `Error rate` (процент и кольцевой индикатор, кнопка-иконка «More info about Error rate» 24x24 с подсказкой), `Total input tokens` (например «1.4M»), `Total output tokens` («20K»).
- Карточка «Session activity» на всю ширину (≈ 254 px высотой): столбчатый график по времени (ось X: даты и часы, ось Y: число сессий от 0 до 2, серые горизонтальные линии, подписи осей мелким серым), справа вверху фильтр версии графика «Version: All» (поповер `All` ✓, `1`), внизу слева легенда с цветным квадратом «1» (версия). При наведении на столбец появляется чёрная всплывающая подсказка с датой и часом.
- Ряд из 4 плиток-перцентилей: `Turns`, `Active time`, `Input tokens`, `Output tokens`; у каждой переключатель-чипы `p50 / p90 / p95` (39x22) вверху справа, крупное значение (например «8», «5m 25s», «1.4M», «20K») и подпись «per session».
- Две карточки по полширины (≈ 633, высота ≈ 260). `Tool usage`: горизонтальная столбчатая диаграмма (синие полосы, колонки «Tool» и «Calls», значения справа: bash, web_search, edit, submit_outcome_grade, read, web_fetch, write). `Stop reasons`: кольцевая диаграмма (синяя, с отверстием) и легенда с одной записью: «End turn», 1, 100%.
- Состояние загрузки: серые скелетоны всех блоков; затем данные.

---

## 5. Deployments

### 5.1 Список, `…/deployments`
- Шапка: заголовок «Deployments», подзаголовок «A deployment binds an agent to credentials, an environment, and a schedule so it can run on its own.»; справа «+ Create deployment» (ссылка на страницу, 173 px) и кнопка-книга (документация по расписанию).
- Фильтры: поиск; `Created by Anyone`, `Agent All`, `Status Active`.
- Колонки: флажок 40; `ID` 279; `Name` 216; `Agent` 184; `Trigger` 168; `Created by` 216; `Created` 148; `Actions` 56.
- Пустое состояние (данных нет): иконка-таблица, «No deployments», «A deployment binds an agent to an environment, credentials, and a schedule so it can run on its own.», вторичная кнопка «+ Create deployment». Карточка деплоймента не открывалась (нет данных).

### 5.2, 5.3, 5.4, 5.5 и 5.6 Создание, `…/deployments/new` (отдельная страница)
Крошка `Deployments / New deployment`, заголовок «Create deployment», подзаголовок «Deploy an agent with a trigger, environment, and credentials.» Колонка 768 px.
- Блок «General» («What this deployment runs, and where.»): `Name` (плейсхолдер «Nightly inbox triage»); `Agent` (выбор 508x32 «Select an agent», справа ссылка `Manage agents ↗`; поповер со строкой поиска «Search agents by name or exact ID» и списком «имя + возраст»); `Environment` («Select an environment», ссылка `Manage environments ↗`); `Initial message` (область 516x56, плейсхолдер про сводку тикетов; подсказка «Sent to the agent at the start of every run.»); `Budget (optional)`: поле с префиксом «$» (подсказка про остановку сессии при достижении стоимости по публичным тарифам, «Leave empty for no limit.», «Agents may occasionally exceed the budget by at most one turn.»).
- Блок «Trigger» («When a run starts: on demand, or automatically on a schedule.»): сегментный переключатель `Manual` (по умолчанию, пояснение: запуск кнопкой «Run now» в консоли или по API `POST /v1/deployments/:id/run`) / `Schedule`.
  - `Schedule` показывает: `Frequency` (выбор: `Every minute`, `Every hour`, `Daily`, `Weekdays` (по умолчанию), `Weekly`, `Custom cron`), `Timezone` (часовой пояс браузера), `At` (время и переключатель AM/PM, по умолчанию 9:00 AM), строку cron моноширинно (`0 9 * * 1-5`) со ссылкой «Edit cron», список «Next 5 runs» (пять ближайших запусков с датой и временем).
- Блок «Resources» («Credentials each run can use, and what is mounted into its session.»): `Credential vaults (optional)`: кнопка «Add vault» (выбор, ссылка `Manage credential vaults ↗`); `Session resources (optional)`: «Files, GitHub repositories, or memory stores mounted into each run's session.» и кнопка «Add resource ▾» с меню `GitHub repository`, `File`, `Memory store` (меню раскрывается вверх).
- Низ: «Cancel», «Create deployment» (153x32).

---

## 6. Environments

### 6.1 Список, `…/environments`
- Шапка: «Environments», подзаголовок «Configuration template for containers, such as sessions or code execution.»; справа «+ Create environment» (178 px, страница `…/environments/new`) и кнопка-книга.
- Фильтры: поиск; `Status Active`.
- Колонки: флажок 40; `ID` 271 (`env_…`); `Name` 393; `Type` 120 (бейдж «Cloud»); `Scope` 130 (бейдж с иконкой «Organization»); `Updated at` 148; `Archived at` 148 (пусто у активных); `Actions` 56.
- Меню строки: `Archive`, `Delete` (красный). Не выбирались.

### 6.2 Быстрый просмотр, `…/environments?environment=<id>`
Каркас по 0.3, у заголовка иконка облака. Свойства: `Created`, `Updated`, `Type` (Cloud), `Scope` (бейдж «Organization»). Секции: `Description` («None»), `Networking` (подтаблица: `Type` «Limited», `MCP access` «Disabled», `Packages` «Disabled»), `Packages` («None»), `Metadata` («None»). Нижний переключатель `Rendered | API`.

### 6.3 и 6.4 Карточка, `…/environments/<id>` (без вкладок, одна форма)
- Крошка `Environments / <имя>`; заголовок с бейджами «Cloud» и «Organization» справа от имени; под ним ID, «Last updated …». Справа только «…» (28x28) с единственным пунктом `Archive` (красный). Главной кнопки нет.
- Форма (колонка 768 px, слева колонка заголовка 224, справа поля 516 при x=532):
  - «General» («What this environment is, and where it runs.», ссылка «Learn more»): `Hosting`: неизменяемый чип «Cloud» с подписью «Can't be changed after creation»; `Name` (плейсхолдер «E.g. data-analysis»); `Description (optional)` («What sessions in this environment are for»).
  - «Networking (optional)», раскрыт по умолчанию, сводка «Limited»: сегментный переключатель `Unrestricted` / `Limited` (выбран `Limited`; подсказка «Outbound traffic is blocked except for what's allowed below.»), два флажка `Allow package managers` («Reach PyPI, npm, and the other package registries.») и `Allow MCP servers` («Reach the MCP servers configured on the agent.»), поле `Allowed hosts` (область 516x56, плейсхолдер из двух примеров хоста, счётчик «0/16», подсказка «Hostnames or IPv4 addresses, one per line. *.example.com covers subdomains.»).
  - «Packages (optional)», свёрнут «None»; раскрыт: «No packages beyond the standard image» (ссылка на справку) и шесть кнопок-чипов 24 px: `+ Python pip`, `+ Node.js npm`, `+ System apt`, `+ Rust cargo`, `+ Ruby gem`, `+ Go go`.
  - «Metadata (optional)», свёрнут «None»; раскрыт: «Key-value pairs for your own bookkeeping, not shown to the agent.» и кнопка «Add metadata».
- Панель сохранения при правках не наблюдалась.

### 6.5 и 6.6 Создание, `…/environments/new` (страница)
Крошка `Environments / New environment`, заголовок «Create environment», подзаголовок «A reusable container template for sessions.» Поля как в карточке; отличие: у `Hosting` переключатель `Cloud` (по умолчанию) / `Self-hosted` (подпись «Can't be changed after creation»). При выборе `Self-hosted` блоки «Networking» и «Packages» исчезают, остаются «General» и «Metadata». Низ: «Cancel», «Create environment» (158x32).

---

## 7. Credential vaults

### 7.1 Список, `…/vaults`
- Шапка: «Credential vaults», подзаголовок «Manage credential vaults that provide your agents with access to MCP servers and other tools.»; справа кнопка (не ссылка) «+ Create vault» (126x32, открывает диалог) и кнопка-книга.
- Фильтры: поиск; `Created by Anyone`, `Status Active`.
- Колонки: флажок 40; `ID` 271 (`vlt_…`); `Name` 396; `Created by` 396; `Created` 148; `Actions` 56.

### 7.2 Диалог «Create vault»
520 x 312. Янтарное предупреждение «Vaults are shared across this workspace. Credentials added to this vault will be usable by anyone with API key access.» со ссылкой «Learn more about vaults». Поле `Name` (плейсхолдер «Production vault», подсказка «255 characters or fewer.»). Кнопка «Continue» (86x32).

### 7.3 Быстрый просмотр, `…/vaults?vault=<id>`
Каркас по 0.3. Свойства: `Created`, `Updated`. Секция `Credentials`: карточки учётных данных (имя, `URL`, `Expires` «in 9 hours», `ID` `vcrd_…`).

### 7.4 и 7.5 Карточка, `…/vaults/<id>`
- Крошка `Credential vaults / <имя>`; заголовок с иконкой ключа; справа чёрная кнопка «+ Add credential» (142x32) и «…» (меню `Rename`, `Archive`, `Delete` красный); строка метаданных: ID, «Created …», «Updated …».
- Фильтры: поиск «Find credential by ID» (272x32), `Status Active` (123x32).
- Таблица: флажок; `ID` (`vcrd_…`); `Name`; `Auth` (плашка «MCP OAuth» и адрес сервера под ней); `Last used` (`—` если не использовалась); `Updated`; `Actions`. Меню строки: `Edit`, `Archive`, `Delete` (красный). Строки 46 px, содержимое двухстрочное для колонки Auth.

### 7.6, 7.7 и 7.8 Диалог «Add credential»
Заголовок «Add credential», подзаголовок «Add a credential to this vault for agents to use.» Поле `Name (optional)` (плейсхолдер «Example credential»), `Type` (выбор 464x32). Три типа с пояснениями в выпадающем списке:
- `MCP OAuth`: «For MCP servers that support OAuth.» (по умолчанию). Поле `MCP server` (выбор/адрес «https://mcp.example.com»), кнопка «Connect» (серая, пока не выбран сервер). Диалог 520 x 350.
- `Bearer token`: «For MCP servers that accept a long-lived API key or personal access token.» Поле `MCP server`, кнопка «Add credential». Поле токена появляется после выбора сервера (не открывалось).
- `Environment variable`: «For CLIs, SDKs, or direct API calls. The agent never sees the value.» Диалог вытягивается до 520 x 866: `Variable name` (плейсхолдер «MY_API_KEY») и `Value` (скрытое поле) в одну строку, `Networking` (сегмент `Limited` / `Unrestricted`), `Allowed hosts` (область, «Separate hosts with commas or newlines.»), `Injection location` (флажки `Request headers` и `Request body`, первый включён; подсказка «Limiting to request headers is recommended unless the service reads the secret from the request body.»), янтарное предупреждение об общем доступе к секрету по ключу API, флажок согласия («I acknowledge this credential is shared and that I am responsible for its storage and use.»), кнопка «Add credential» (122x32, неактивна до согласия).
Ни один диалог не отправлялся.

---

## 8. Memory stores

### 8.1 Список, `…/memory-stores`
- Шапка: «Memory stores», подзаголовок «Browse and manage persistent memory for your agents.»; справа кнопка «+ Create memory store» (186x32, диалог) и кнопка-книга.
- Фильтры: поиск; `Created All time` (142), `Status Active` (123).
- Колонки: флажок 40; `ID` 310 (`memstore_…`); `Name` 752; `Created` 148; `Actions` 56. Меню строки: `Archive store`, `Delete store` (красный).

### 8.2 Диалог «Create memory store»
520 x 344. Поле `Name` (плейсхолдер «My memory store»), `Description (optional)` (область 472x76, плейсхолдер «What this store contains and how agents should use it»), подсказка «Name and description are rendered in the agent system prompt when this store is attached.», кнопка «Create memory store» (166x32, серая).

### 8.3 Быстрый просмотр, `…/memory-stores?store=<id>`
Каркас по 0.3. Свойства `Created`, `Updated`; секции `Description` («None»), `Contents` (счётчик и «Empty»), `Metadata` («None»); переключатель `Rendered | API`.

### 8.4 и 8.5 Карточка, `…/memory-stores/<id>`
- Крошка `Memory stores / <имя>`; заголовок-кнопка редактирования имени на месте (подсказка «Rename»); под ним строка-описание, редактируемая на месте (плейсхолдер «Add a description»); справа кнопка «+ Add memory» (129x32). Строка метаданных: ID, «Created …».
- Рабочая зона занята двухпанельным просмотром файлов в рамке на всю высоту окна (1266x1077, x=288): слева дерево «Contents» 288 px (строка заголовка 32 px, пусто: «Empty»), справа область просмотра (≈ 978 px) с иконкой документа и текстом «Select a memory» с пояснением «Choose a file from the tree to view its contents.»
- Диалог «Add memory» (520 x 506): `Path` (предзаполнено «/», плейсхолдер «/notes/ideas.md», подсказка «Folders are derived from the slashes in your path.»), `Content` (область 472x256), кнопка «Add memory» (109x32, серая). Не отправлялся.

---

## 9. Узкий экран 390 x 844

- Левое меню схлопывается в рейку 48 px: иконки (рабочее пространство-кружок «D», поиск, Dashboard, API keys, Build, Managed Agents, Analytics, Claude Code, Manage, внизу уведомления, документация, кредиты и профиль-кружок). При первой загрузке страницы примерно от 2 до 4 секунд виден развёрнутый вариант меню поверх страницы (234 px), затем он сворачивается.
- Содержимое занимает x=72…366 (294 px). Горизонтальной прокрутки страницы нет.
- 9.1 Список агентов: заголовок и подзаголовок переносятся в 2 или 3 строки; кнопка «+ Create agent» и книга переходят на новую строку под заголовком; поиск на всю ширину; чипы-фильтры уезжают за правый край (x=400+, не видны, отдельной прокрутки нет); таблица (ширина 1080) лежит в контейнере с горизонтальной прокруткой 334 px, в видимой части ID (сокращённый, середина заменена многоточием) и начало «Name».
- 9.2 Карточка агента: кнопки «Start session» в шапке не видно (остаётся «…»); описание и метаданные в 2 или 3 строки; вкладки в одну строку с горизонтальной прокруткой (Observability за краем); версия и `Rendered | Raw` в одной строке; форма в одну колонку (заголовок блока над полями вместо левой колонки), поля 294 px.
- 9.3 Создание агента: колонка 294 px; «Starting point» остаётся, переключатель Describe/Template на всю ширину; форма в одну колонку; нижний липкий бар «Cancel / Create agent» остаётся.
- 9.4 Quickstart: шаблоны в одну колонку, карточки 294 px.
- Диалоги (центрированные 520 px) и быстрый просмотр (560 px) на 390 px не проверялись.

---

## 10. Общее поведение

- Клавиши: Escape закрывает поповер или меню, повторный Escape закрывает диалог; Ctrl+K в левом меню открывает глобальный поиск консоли (не открывался); в редакторах кода Tab вставляет отступ (выход: Escape, затем Tab).
- Наведение: подсветка строки, кнопка «Quickview» на строке, иконки копирования ID.
- Переходы: клик по строке и «Open» открывают карточку на новой странице; «Quickview» открывает боковую панель без смены страницы (меняется только параметр адреса); создание агента, деплоймента и окружения идёт на отдельных страницах; создание vault, memory store, учётных данных и памяти идёт в диалогах.
- Состояния: загрузка: серые скелетоны (Observability, таблицы, шаблоны); пусто: иконка, заголовок, пояснение, вторичная кнопка (деплойменты, пустой результат фильтра) или короткие тексты «Empty», «None», «No … configured»; ошибка и «нет доступа» не встретились.
- Документация: у каждого списка есть кнопка-книга; в формах есть ссылки `Learn more ↗`.

---

## 11. Не открыто и почему

| Что | Почему |
|---|---|
| Quickstart: шаги 2, 3 и 4 мастера (Configure environment, Start session, Integrate), сгенерированный агент, «Use this template», стрелка «Create agent», кнопка «Export as code» | Переход создаёт агента или вызывает модель (запрещено: создавать, запускать, экспортировать). Шаги описаны только по панели «Progress» и документации |
| «Start session» (шапка агента, меню строки, меню шапки) | Запрет на запуск сессий; неизвестно, не стартует ли сессия сразу |
| «Guided edit» в меню агента | Вероятно запускает диалог с моделью; не нажималось |
| «Create deployment» из меню агента | Страница создания открыта прямым адресом (5.2); сам пункт меню не нажимался |
| «Archive», «Delete», «Archive agent», «Archive store», «Delete store», «Rename», «Edit» (учётные данные), массовое «Archive» | Запрет на изменение и удаление; меню только раскрывались |
| «Generate» (создание агента по описанию), «Create agent», «Create deployment», «Create environment», «Continue» (vault), «Connect», «Add credential», «Create memory store», «Add memory» | Отправка форм запрещена; поля не заполнялись |
| Карточка деплоймента, действия «Run now» и пр. | В рабочем пространстве нет деплойментов |
| Просмотр содержимого памяти и редактирование файла | Хранилище пусто |
| Раскрытие строк `web_fetch` и `web_search` в списке разрешений инструментов | Не раскрывались, назначение стрелки неизвестно |
| Поле токена в типе «Bearer token» и шаги OAuth-подключения MCP | Появляются после выбора сервера и ведут к подключению учётной записи |
| Панель сохранения и состояние «есть несохранённые правки» в карточках агента и окружения | Требует ввода в поля (запрещено) |
| Содержимое меню «…» быстрого просмотра окружения, vault и memory store; меню строки сессий; кнопки «Previous» и «Next» | Однотипны меню агента; не нажимались, чтобы не создавать лишних действий |
| Сортировка колонок (клик по «Created» на вкладке Sessions) | Не нажималась; заголовок работает как кнопка |
| Пагинация и «Load more» | При числе строк от 1 до 3 не отображаются, поведение при большом объёме данных не проверено |
| Состояния ошибки и «нет доступа» | Не воспроизводились |
| Быстрый просмотр и диалоги на 390 px | Проверены только основные страницы на узком экране |
| Страница сессии (переход из строки Sessions) | Относится к разделу 03-sessions |
