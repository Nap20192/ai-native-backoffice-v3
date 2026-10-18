# Программы в песочнице агента

Черновик 1, 2026-10-18. Статус: план, код не менялся. Разведка шла по коду, `.env` (только `grep -c`), каталогу образов на диске, журналам прогонов и ответам пробной копии без входа.

Запрос владельца: окружение должно давать агенту нужные программы (ставить пакеты, подгружать программы). Повод: оценка навыков на Qwen (`.verify-evidence/skill-eval-qwen/report.md`) нашла, что в песочнице LiteBox нет `soffice` и `pdftoppm`, поэтому проверки рендера в навыках документов не работают. Ещё владелец выбрал: урезать части создания у встроенных docx, xlsx и pptx и добавить две строки в системный промпт.

Пути: `N/` это `platform/apps/main-node/src`, `NT/` это `platform/apps/main-node/test`, `A/` это `platform/apps/agent/src`, `C/` это `platform/apps/console/src`, `P/` это `platform/packages`, `I/` это `platform/sandbox-images`, `B/` это `platform/skills/builtin`, `S/` это `.claude/skills/verify-agent-console`, `E/` это `.verify-evidence`. Разделы вида «3.3» ссылаются на [environments.md](environments.md).

## 1. Цель

1. В окружении можно выбрать образ с LibreOffice и poppler, и сессии этого окружения получают `soffice`, `pdftoppm` и Python с офисными библиотеками без установки при каждом старте.
2. Пакеты из списка окружения ставятся предсказуемо: неверный список отклоняется при сохранении ответом 400, сбой установки виден пользователю по-русски с именем менеджера.
3. Агент знает, где он работает и что в образе есть.
4. Навыки docx, xlsx и pptx держат только чтение, правку и проверку. Две строки промпта дают то, что в оценке давал навык: перечитать файл после записи и слайды 16:9.

## 2. Что есть

Состояние: «вживую» значит работает в запущенном приложении, «в коде» значит есть код и тесты, но в приложении не включено, «нет» значит кода нет.

| Часть | Где | Состояние |
|---|---|---|
| Пакеты шести менеджеров в API | `P/managed-agents-api/src/contracts/environments.ts:67-77`, `P/managed-agents-application/src/environments/application.ts:95-122` | вживую, `env.settings_saved` в прогоне `E/20261018-050648` |
| Установка при старте VM | `P/sandbox/src/environment-setup.ts:143, 167-216`, `P/sandbox-adapter-litebox/src/litebox.ts:677-704`. Порядок apt, pip, npm, cargo, go, gem | вживую: apt `jq` (`env.packages_applied`), 2 apt и 6 pip в окружении оценки навыков |
| Таймауты | установка 600 с (`litebox.ts:74`), bash 120 с по умолчанию (`litebox.ts:230`). У создания VM своего таймаута нет | в коде |
| Сбой установки | `litebox.ts:693-701` бросает ошибку с кодом выхода, подсказкой про сеть и 600 знаками хвоста, текст по-английски. Если VM создаёт подготовка хода (навыки, файлы), раннер пишет `session.error` с `unknown_error` и `retryStatus: exhausted` (`N/lib/node-managed-session-runner.ts:807-818`). Если VM создаёт первый bash, ошибку бросает `exec` (`litebox.ts:228`), и она, видимо, приходит модели результатом инструмента | в коде, вживую сбой не вызывали, второй путь не проверен |
| Кэш пакетов | нет. Каждая VM ставит список заново. Отпечаток VM включает весь `environment.config` (`node-managed-session-runner.ts:290-294`), поэтому любая правка окружения пересоздаёт VM | нет |
| Сеть `unrestricted`, `limited`, `allowed_hosts` | `litebox.ts:1005-1040` | вживую, `env.networking_limited_applied` и `env.networking_allowed_host` |
| `allow_package_managers` | открывает хосты всех шести менеджеров (`environment-setup.ts:128-141`), с Ubuntu, Alpine, crates, rubygems и Go | проверено тестом VM 16.10 (`es2-vm.json`, 15 хостов), вживую не проверено |
| 400 за пакеты в `limited` без `allow_package_managers` | нет ни в политике, ни в сервисе. VM падает при установке с подсказкой (`litebox.ts:695-697`) | нет |
| Политика оператора и проверка имён | `N/lib/environment-config-policy.ts:164-212`, тест `NT/environment-config-policy.test.ts`. `environmentsModule` не передаёт `configPolicy` (`P/managed-agents-app/src/modules/environments.ts:41-49`), порт и `rejectedConfig` готовы (`application.ts:178-186`). Политика ждёт каталог синхронно, а `loadSandboxCatalog` асинхронный (`N/lib/sandbox-catalog.ts:486`) | в коде. Комментарий `C/pages/EnvironmentDetail.tsx:58-60` обещает 400, которого нет |
| Каталог образов | `N/lib/sandbox-catalog.ts:126-136, 486-525`, `I/catalog.json` | в коде. На пробной копии выключен: `grep -c` дал 0 для `SANDBOX_IMAGE_CATALOG` и `SANDBOX_IMAGE_DIR`, `.claude/launch.json` их не задаёт |
| `GET /v1/oma/sandbox-catalog` | `N/modules/node-http.ts:366-367`, коммит 45694b6 | вживую: пробная копия без входа отвечает 401, прогон 050648 получил 200 и `enabled=false` |
| `config.image` до VM | `N/modules/node-managed.ts:443`, `N/lib/sandbox-environment-image.ts:66-82`, `litebox.ts:540-580, 611` | проверено тестом VM 16.10: `workplace` поднялся этим путём за 34,8 с, bash, `/opt/venv`, pip в venv. `workplace-office` прошёл только `I/boxlite-smoke.mjs`, через сервер не проверен |
| `config.image = null` | `sandbox-environment-image.ts:71` даёт образ сервера и каталог не читает | в коде. Расходится с 1.5, где `null` значит `default_image` |
| Собранные образы | `~/.cache/ai-backoffice-v3/environments/sandbox-images`: `workplace-2026.10.1` 554 МБ, `workplace-office-2026.10.1` 688 МБ, дайджест в `index.json`, `.manifest.json` и `.digest` один | проверено вживую сегодня. В office есть `libreoffice-impress-nogui`, `poppler-utils`, LibreOffice 7.4.7.2 |
| Песочница пробной копии | в `~/.boxlite/images/disk-images` один диск образа 1,4 ГБ и две базы по 268 МБ, диска образа каталога нет. Манифест `node:22-bookworm` (`sha256:0e5f9065…2a8`) там есть | вживую: `soffice` и `pdftoppm` нет (сессии pptx A2 и xlsx A3 оценки) |
| Консоль: раздел «Образ» и шаблоны сервера | `C/pages/EnvironmentDetail.tsx:118-120, 294-299`, `C/lib/sandbox-catalog.ts:219-233`. Без каталога кодовый шаблон «Документы» (`C/lib/environment-templates.ts:91-93`) | в коде, тесты `EnvironmentDetail.image.test.tsx` и `EnvironmentsList.templates.test.tsx` |
| Блок «Окружение» в промпте | `N/lib/environment-prompt-reminder.ts:190`, `A/harness/environment-prompt.ts` | в коде. `node-managed.ts:636-639` его не добавляет |
| Требования навыков `oma.requires.*` | `N/lib/skill-requirements.ts` | в коде, встроенные навыки их не объявляют |
| verify-agent-console | `env.probe*`, `env.settings_saved`, `env.packages_applied`, `env.networking_*`, `env.sandbox_catalog` (`S/scripts/journey-env-to-agent.mjs:826-1000`) | вживую: прогон 050648 дал 91 проверку без провалов, образ `node:22-bookworm`, модель fake. `S/scripts/launch.sh:98` передаёт только `SANDBOX_IMAGE`, каталог в прогоне не включить |

Цена установки без кэша, проверено вживую по журналам оценки. В окружении из шаблона «Документы» первый bash агента B шёл 23 с (`raw/xlsx_B_events.json`) и 33 с (`raw/pptx_B_events.json`). Агент A ждал столько же до `session.status_running` (21 с, `raw/xlsx_A_events.json`), потому что раскладка навыков создаёт VM раньше хода. Значит, «задержка старта A» из отчёта это та же установка, а не раскладка файлов. Сколько из этого старт VM и сколько apt и pip, не проверено. `python: not found` из оценки чинит образ: симлинк `python` в `I/Dockerfile:26`.

## 3. Дыры

1. На пробной копии каталог выключен. Все сессии идут на `node:22-bookworm` без LibreOffice и poppler.
2. Окружение с `image = null` не получит новый образ и после включения каталога. Образ нужно выбрать на карточке окружения.
3. Политика окружения не подключена: нет 400 за неизвестный образ, плохое имя пакета и пакеты в `limited` без менеджеров.
4. apt в образах каталога смотрит на `snapshot.debian.org` (`I/Dockerfile:12`). Этого хоста нет среди хостов менеджеров, поэтому в `limited` с менеджерами `apt-get update` упадёт. Вывод по коду, вживую не проверено.
5. Хосты менеджеров не учитывают манифест образа (1.7).
6. `apt-get update` идёт при каждом старте, даже если пакеты уже в образе (`environment-setup.ts:186-193`).
7. Сбой установки пользователь видит как английский `unknown_error`.
8. Кэша пакетов нет. Слой из 3.3 и 3.4 не начат.
9. Агент не знает ОС, root, venv и наличие `soffice`.
10. verify-agent-console не умеет включать каталог.

## 4. Срезы окружения

Порядок такой: сначала шаги владельца из раздела 6, затем срезы. Тесты через `test-slot` с `--maxWorkers=2`, тяжёлые команды через `nice -n 15` и по одной.

### П1. verify-agent-console с каталогом

- Правка. `S/scripts/launch.sh` пишет в `run.env` `SANDBOX_IMAGE_CATALOG` и `SANDBOX_IMAGE_DIR` из `VERIFY_SANDBOX_IMAGE_CATALOG` и `VERIFY_SANDBOX_IMAGE_DIR`. Новые проверки в `journey-env-to-agent.mjs`: `env.catalog_enabled` (у `workplace` и `workplace-office` `built: true`, дайджест как в `index.json`), `env.office_tools` (окружение с `image: "workplace-office"`, bash `soffice --version; pdftoppm -v; python --version`), `env.render` (pptx от python-pptx через `soffice --convert-to pdf` и `pdftoppm -png` даёт непустой PNG).
- Красный тест. Прогон с `VERIFY_SANDBOX_IMAGE_CATALOG` сейчас падает на `env.catalog_enabled` с `enabled=false`.
- Доказательство. `summary.md` прогона с тремя новыми проверками. Таймаут первого хода 900 с (`journey-env-to-agent.mjs:40`) покрывает холодный старт office 44-51 с.

### П2. Политика окружения и 400

- Правка. `createEnvironmentConfigPolicy` берёт асинхронный геттер каталога. Новое правило: непустые `packages`, сеть `limited` и `allow_package_managers` не `true` дают 400 с полем `config.packages`. Правило смотрит итог слияния с текущей конфигурацией, как `normalizeConfig` (`application.ts:254-262`). Опциональный порт в `environmentsModule`, привязка в `N/modules/node-managed.ts` рядом с `createNodePlatform` (:1102). Файл `SANDBOX_PACKAGE_POLICY` читается при старте, плохой файл останавливает старт с именем переменной.
- Красный тест. HTTP-тест main-node через SDK: `POST /v1/environments` с `image: "nope"`, с `pip: ["--index-url=https://x"]` и с `limited` без менеджеров и `pip: ["rich"]`. Сейчас все три дают 201, после правки 400 `invalid_request_error`.
- Доказательство. curl на экземпляре verify с ответами 400 и полем. Снимок консоли с ошибкой при сохранении такого окружения.

### П3. apt и хосты на образах каталога

- Правка. Адаптер открывает хосты только менеджеров из `package_managers` манифеста снимка. Образ сервера остаётся как сейчас. Для apt на образе каталога добавляется хост источника из образа (вопрос В3). Скрипт apt пропускает `apt-get update`, если `dpkg -s` видит все пакеты.
- Красный тест. `P/sandbox-adapter-litebox/test/litebox-catalog.test.ts`: `limited` с менеджерами на манифесте `workplace` даёт `allowNet` без `crates.io` и с хостом apt образа. `P/sandbox/test/environment-setup.test.ts`: в скрипте apt проверка `dpkg -s` стоит до `apt-get update`. Опционально VM-тест `OMA_LITEBOX_VM_TEST=1` с apt `figlet` в `limited`.
- Доказательство. Прогон П1 с окружением `limited` и apt `figlet`: `command -v figlet` в VM, в логе `allow N host(s)` без Ubuntu, Alpine, crates, rubygems и Go.

### П4. Блок «Окружение» в промпте

- Правка. `node-managed.ts:636` первым ставит в `platformReminders` результат `buildNodeManagedEnvironmentReminder` по `environmentSnapshot()` песочницы.
- Красный тест. Тест сборки контекста хода в main-node: `systemPrompt` содержит `<source name="environment">` и для манифеста office называет `soffice`.
- Доказательство. В журнале фейковой модели прогона П1 `system` содержит блок. Затем одна сессия Qwen на `workplace-office`.

### П5. Понятный сбой установки

- Правка. `SandboxEnvironmentError` получает код `packages_failed` и имя менеджера. Раннер пишет `session.error` с типом из списка CMA и русским текстом «Пакеты окружения не поставились: pip, код 1» и хвостом вывода. Так же он поступает, когда VM падает на первом bash. Консоль показывает ошибку над полем ввода со ссылкой на окружение.
- Красный тест. Тест раннера на оба пути, подготовку и первый bash: событие `session.error` несёт менеджер и русский текст.
- Доказательство. Проверка в П1 с несуществующим apt-пакетом: событие в журнале и снимок консоли.

Позже, вне этого плана: слой пакетов (3.3, 3.4, ES7) и переход старых окружений на `workplace` (EX4). EX4 требует правки кода, потому что `null` сейчас значит образ сервера.

## 5. Срезы навыков

### Н0. Закреплённые версии

Версия встроенного навыка это хеш его файлов (`N/lib/builtin-skills.ts:81`). После Н1 и Н2 у docx, xlsx и pptx новые версии. Агент, закреплённый на старой, падает при подготовке VM с `Managed Skill pptx@<версия> was not found` (`N/lib/node-managed-session-inputs.ts:373-375`). Навык без версии сервер записывает как `latest` (`P/managed-agents-application/src/agents/definition-resolution.ts:202`), риск есть у агентов, которым версию задали явно через API или помощник. До коммита Н1 нужен список агентов, у которых навык `anthropic` docx, xlsx или pptx стоит с версией не `latest` (`GET /v1/agents` пробной копии со входом). Такие агенты переводятся на `latest`. pdf прошёл тот же путь в e45917b.

### Н1. Подзаголовок в pptx_create.py

- Правка. `B/pptx/scripts/pptx_create.py:120-131` пишет `subtitle` в заполнитель 1, потом `bullets` очищает тот же заполнитель. На макете без заполнителя типа SUBTITLE подзаголовок идёт отдельной надписью под заголовком, пункты остаются в теле. Неизвестный ключ слайда даёт выход 1 с местом и списком ключей, как `pdf_create.py` после e45917b.
- Красный тест. `B/pptx/tests/test_powerpoint_skill.py`: спека `title_content` с `subtitle` и `bullets`, после записи текст подзаголовка есть на слайде и пункты целы. Сейчас падает.
- Доказательство. Спека A3 из `E/skill-eval-qwen/raw/pptx_A_r3_*` через помощник, `pptx_read.py --outline` показывает подзаголовок. На `workplace-office` картинка слайда через `pptx_render.py`.

### Н2. Урезать docx, xlsx и pptx

- Правка. В трёх SKILL.md убрать процедуру создания и строки создания в Quick Reference. Остаются чтение, правка, шаблоны, рецензирование и правки docx, пересчёт xlsx, перевод в PDF и проверка картинкой. Скрипты создания остаются в `scripts/` одной строкой в Quick Reference (вопрос В5): на них стоят тесты. Platform notes вместо `--break-system-packages` и шаблона «Документы» называют образ «Рабочее место с LibreOffice». ATTRIBUTION.md отмечает правку, как в e45917b.
- Красный тест. На текст его нет. Новый тест загрузчика встроенных навыков проверяет, что каждый скрипт из SKILL.md лежит в `scripts/`. pytest трёх навыков и тесты загрузчика остаются зелёными.
- Доказательство. Повтор задач xlsx и pptx из `E/skill-eval-qwen/plan.json` на Qwen с урезанным навыком: баллы по той же рубрике и входные токены против отчёта (у A3 в xlsx 118 тыс.).

### Н3. Две строки в platformGuidance

- Правка. В `A/harness/platform-guidance.ts:25` две константы по одному предложению: «After you write a file for the user, read it back and check it against the task.» и «Make new slide decks 16:9 unless the user asks for another size.» Заголовок файла (:1-5) напоминает, что каждая строка идёт в каждый ход каждого агента на пути кэша промпта, поэтому строк две и они короткие.
- Красный тест. Новый `platform/apps/agent/test/platform-guidance.test.ts`: `composeSystemPrompt` содержит обе строки.
- Доказательство. `system` в журнале фейковой модели прогона verify. Одна сессия Qwen на `workplace-office` с задачей pptx из `plan.json`: файл 16:9 и вызов чтения файла после записи.

Порядок: Н0, затем Н1 и Н2 (одна папка pptx), затем Н3.

## 6. Шаги владельца

1. Включить каталог. Две строки путей, секретов в них нет. Время секунды, диск 0.

```sh
cd ~/orca/projects/ai-native-backoffice-v3
printf '\n%s\n%s\n' \
  'SANDBOX_IMAGE_CATALOG=/home/vnkjd/orca/projects/ai-native-backoffice-v3/platform/sandbox-images/catalog.json' \
  'SANDBOX_IMAGE_DIR=/home/vnkjd/.cache/ai-backoffice-v3/environments/sandbox-images' >> platform/.env
grep -c '^SANDBOX_IMAGE_CATALOG=.' platform/.env; grep -c '^SANDBOX_IMAGE_DIR=.' platform/.env
```

Ожидается `1` и `1`. Каталог увидит и `oma-server-preview` (8787), он тоже читает `.env`.

2. Перезапустить `oma-server-try`: `preview_stop`, затем `preview_start oma-server-try`. Около 30 с. Сборка образов не нужна, обе версии 2026.10.1 собраны 16.10 и дайджесты сходятся.
3. В консоли 5174 открыть карточку окружения оценки, в разделе «Образ» выбрать «Рабочее место с LibreOffice», убрать пакеты apt и pip (они есть в образе), сохранить. Сеть останется «Без ограничений». Активные сессии окружения пересоздадут VM на следующем ходе.
4. Новая сессия, в ней `soffice --version; pdftoppm -v; python --version`. Первая VM на образе собирает диск ext4: по замеру 44-51 с и около 1,9 ГБ в `~/.boxlite` (оценка по `rootfs_bytes`, не проверено). Следующие VM по README стартуют за 0,3 с, через сервер это не мерили.
5. Пересборка нужна только для новой версии, например после ответа на В3. Нужны 3 ГиБ свободной памяти и не выше 92°C, `build.sh` ждёт сам. Не запускать рядом с тестами.

```sh
cd ~/orca/projects/ai-native-backoffice-v3/platform/sandbox-images
export SANDBOX_IMAGE_DIR="$HOME/.cache/ai-backoffice-v3/environments/sandbox-images"
nice -n 15 ./build.sh workplace 2026.10.2
nice -n 15 ./build.sh office 2026.10.2
```

Замер 16.10 с тёплым кэшем buildx: 98 с и 55 с. Холодную сборку не мерили. Диск: каталоги OCI 0,58 и 0,72 ГБ, образы в Docker 1,57 и 1,91 ГБ распакованными, плюс кэш buildx. После сборки в `I/catalog.json` меняются `oci_dir`. Свободно на `/home` 53 ГБ.

## 7. Риски

- Память. Пробный сервер работает в scope с `MemoryHigh=4G` и `MemoryMax=5G` (`.claude/launch.json`, b13bd62), VM BoxLite считаются в нём. VM office берёт 2048 МиБ. Две сессии office и сервер выходят за `MemoryHigh`, oomd ударит по серверу. Пик памяти office в замере 741 МБ.
- Нагрев. Холодные старты BoxLite грели процессор до 96-98°C (`I/README.md`, замеры).
- Картинки. В оценке `read` PNG дал пустой результат в журнале. Видит ли Qwen картинки, не проверено. Если нет, рендер в PNG Qwen не поможет, останутся `pdftotext` и `pptx_read.py`. Проверка в доказательстве П4 и Н3.
- Сеть шаблона. Серверный шаблон «Документы и офис» даёт `limited` без хостов. Окружение из него закрывает агенту интернет из VM.
- Старые окружения остаются на образе сервера, пока их не правят руками (дыра 2).
- Закреплённые версии навыков после Н1 и Н2 (Н0).
- Рендер LibreOffice 7.4 отличается от Microsoft Office. `render-ru.py` распознал кириллицу в docx 1,00, xlsx 0,98, pptx 1,00.
- Две строки промпта получает каждый агент, около 40 токенов на ход.

## 8. Вопросы владельцу

- В1. Память пробной копии. Рекомендация: в `I/catalog.json` поставить office `memory_mib: 1536` (пик 741 МБ это 48%) и гонять сессии office по одной. Подъём `MemoryMax` оставить на крайний случай: oomd уже трижды убивал сессию Claude.
- В2. 400 за пакеты в `limited` без менеджеров, как в CMA, или установка из слоя при любой сети, как в 3.6. Рекомендация: 400 сейчас. Сегодня пакеты ставятся по сети внутри VM и при закрытых реестрах всё равно падают. К вопросу вернуться вместе со слоем.
- В3. apt на образах каталога. Рекомендация: сейчас П3 открывает `snapshot.debian.org` для образов каталога, без пересборки. Следующая версия образа берёт снимок только при сборке и оставляет в VM `deb.debian.org`.
- В4. Смысл `image = null`. Рекомендация: пока оставить образ сервера, образ выбирается на карточке. Переход по умолчанию решить в EX4 после П1.
- В5. Скрипты создания в docx, xlsx и pptx. Рекомендация: оставить файлы и одну строку в Quick Reference, процедуру убрать. Удаление трогает тесты и ATTRIBUTION.md без пользы для Qwen.
- В6. Закреплённая версия встроенного навыка пропала. Рекомендация: оставить явную ошибку и делать проверку Н0 перед каждой правкой навыков. Тихая подмена на `latest` меняет поведение агента без следа.
