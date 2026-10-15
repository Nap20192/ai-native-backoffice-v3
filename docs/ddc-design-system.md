# Дизайн-система DDC (портал БСБ)

Описание оформления DDC-Portal, корпоративного портала БСБ. Цель: перекрасить другое React-приложение так, чтобы оно выглядело и вело себя как портал.

## Как читать этот документ

- Источник (только чтение): `/home/vnkjd/orca/projects/dco-portal-передача-2026-10-13/dco-portal`. Ниже он сокращён до `dco-portal/`.
- Стек портала: React 18, Tailwind CSS 3.4, framer-motion, lucide-react, react-hot-toast (`dco-portal/client/package.json`). Установлен Tailwind 3.4.19 (`dco-portal/node_modules/tailwindcss/package.json`).
- Главные файлы: `dco-portal/docs/DESIGN-RULES.md` (правила), `dco-portal/client/tailwind.config.js` (шкалы), `dco-portal/client/src/styles/index.css` (все общие классы; другого CSS в `client/src` нет, проверено `find client -name "*.css"`), `dco-portal/client/src/lib/tone.ts` (тона), `dco-portal/client/src/lib/motion.ts` (движение).
- Все размеры в пикселях при корневом шрифте 16px. Пометка «вычислено» значит: число получено сложением классов или скриптом, а не записано в исходнике.
- Значения цветов Tailwind (rose, amber, emerald, sky) прочитаны командой `node -e 'require("./node_modules/tailwindcss/colors")'` в корне портала.
- Готовые токены для Tailwind v4: `platform/apps/console/src/styles/ddc-tokens.css` (раздел 6). Файл нигде не подключён.

## 1. Принципы и 16 правил

### Принципы

1. **Одна система классов.** Кнопки, поля, вкладки, плитки и прочее заданы классами в `index.css` (`btn-*`, `input*`, `tabs`, `kpi*` и т. д.). Других общих классов нет, новые общие файлы не заводят (`DESIGN-RULES.md`, вступление).
2. **Высота ряда одна.** Всё в одном ряду одной высоты: 40, 36 или 32px. Высоту даёт класс, а не `h-*` на месте (`DESIGN-RULES.md`, раздел 1).
3. **Только токены.** Цвета берутся из шкал `brand` и `ink` и пяти статусных тонов. Сырые hex и чужие шкалы (`slate`, `blue`, `violet`) запрещены (раздел 4).
4. **Каждой светлой паре есть тёмная.** Любой `text-ink-500`, `bg-*-50`, `border-*` пишется вместе с `dark:` парой (раздел 3).
5. **Спокойно, без украшений.** Нет эмодзи, градиентных плиток, свечения, цветных полос по краю карточки (раздел 2).
6. **Движение всегда включено.** Анимации не отключаются системной настройкой «уменьшить движение»: сотрудники работают через удалённый рабочий стол, где Windows выключает анимации сама (раздел 15, `main.tsx`).
7. **Всё доступно с клавиатуры.** Одно кольцо фокуса, `aria-*` у вкладок и переключателей, Escape закрывает поповеры (раздел 10).
8. **Без внешних CDN.** Шрифт системный: портал работает во внутреннем контуре (`client/index.html`, `tailwind.config.js`).

### 16 правил коротко

Источник всех пунктов: `dco-portal/docs/DESIGN-RULES.md`, номер раздела в скобках.

1. **Высота контролов (1).** Ряд страницы (шапка, фильтры, форма, подвал окна): 40px, текст `text-sm`, иконка 16px. Панель инструментов и шапка колонки: 36px (`btn-sm`, `input-sm`, `btn-icon-sm`). Плотно (строка таблицы, пагинация, «Закрыть»): 32px (`btn-xs`, `input-xs`, `btn-icon-xs`), текст `text-xs`, иконка 14px. Главное действие героя: 44px (`btn-primary btn-lg`), одно на экран. На кнопках и полях нельзя `py-*`, `h-*`, `text-sm`, `rounded-*`, `!p-*`. Подпись кнопки не переносится. В ячейке таблицы у кнопки `-my-1.5`, чтобы строка осталась 40px.
2. **Иконки (2).** Только lucide-react. Размер по тексту: `text-sm` и `text-base` 16px, `text-xs` 14px, `text-2xs` 12px, плитка 40px даёт 20px, пустое состояние 24px. Приглушённая иконка `text-ink-400 dark:text-ink-500`. Спиннер `Loader2` того же размера с `animate-spin`. Нельзя: эмодзи, `Sparkles`, свечение, `backdrop-blur-xl`, `border-l-4`.
3. **Текст и тёмная тема (3).** Заголовок `text-ink-900 dark:text-ink-50`. Вторичный текст `text-muted` (ink-500 / ink-400). Ошибка `text-error` (rose-600 / rose-400). Выбранное `bg-brand-50 dark:bg-brand-500/15`. Наведение на строку `hover:bg-ink-50 dark:hover:bg-ink-800/60`.
4. **Цвета только токены (4).** Статус красится одним из тонов: neutral, info (sky), warning (amber), success (emerald), danger (rose), ghost. `brand` означает выбор и акцент, а не статус. Пользовательские цвета (проекты, группы) только из 8 образцов, первый `#00805E`.
5. **Вкладки, сегменты, пресеты, переключатель (5).** Одна панель вкладок `tabs` + `tab`, активность через `aria-selected` или `aria-current`. Сегменты `segmented` 40px (`h-9` даёт 36px). Пресеты `chip-toggle` 32px. Вкл/выкл `switch` с `role="switch"`. Счётчик `count-pill`, больше 99 пишется «99+».
6. **KPI (6).** Плитка `kpi` (отступ 20px) или `kpi kpi-compact` (16px). Сетка `grid-cols-2 gap-4 lg:grid-cols-4`. Значение от `text-lg` до `text-2xl`.
7. **Заголовки и подписи (7).** Заголовок страницы только `PageHeader`. Заголовок секции `section-title` (16px, semibold). Надпись над группой `eyebrow` (12px, заглавные, разрядка 0.05em). Подпись поля `label`. Таблица `th` / `td`. Статус только `Badge` высотой 20px.
8. **Карточки и отступы (8).** Секция и форма `card p-5`, панель фильтров и плитка `card p-4`, колонка канбана `card p-3`, вложенная панель `rounded-xl bg-ink-50 p-3`. Ритм: страница `space-y-6`, внутри карточки и формы `space-y-4`, сетки `gap-4`, кнопки `gap-2`, фильтры `gap-3`. Между блоками шаг только 4px: `gap-2.5`, `space-y-2.5`, `mt-2.5` запрещены.
9. **Flex-строки (9).** Текстовая колонка `min-w-0 flex-1`, остальное `flex-none`. `truncate` всегда с `title`. Размеры аватара: 24, 32, 40, 64, 96. Полоса прогресса 6px (`h-1.5`), заливка `bg-brand-500`.
10. **Состояния и доступность (10).** Глобальное кольцо `:focus-visible`, на кнопках не ставить `outline-none`. Отключение атрибутом `disabled` (вид `opacity-50`, `cursor-not-allowed`). Кнопка без текста получает `aria-label` и `title` по-русски. Чекбоксы нативные, 16px.
11. **Окна, меню, подтверждения, занятая кнопка (11).** Любое окно только `Modal`. Подвал: «Отмена» (`btn-ghost`) и действие справа, обе 40px. Удаление только через `ConfirmDialog`, `window.confirm` запрещён. Занятая кнопка: подпись остаётся, иконку заменяет спиннер, `disabled` и `aria-busy`.
12. **Пустые состояния и скелетоны (12).** `EmptyState` только после первой загрузки. Скелетон повторяет разметку: строка `h-4` для `text-sm`, `h-3` для `text-xs`. Повторная загрузка: содержимому `opacity-60`.
13. **Телефон 390px (13).** Горизонтальной прокрутки страницы нет. Вкладки прокручиваются. Вторичные колонки таблицы `hidden md:table-cell`. Цель нажатия не меньше 32px.
14. **Текст и числа (14).** Регистр предложения. Числа `tabular-nums`. Даты `dd.MM.yyyy`, `d MMMM yyyy`, время `HH:mm`. Микротекст `text-2xs` (11/16px), произвольные `text-[10px]` запрещены.
15. **Движение (15).** Только пресеты `@/lib/motion`. Полноэкранный слой `animate-fade`, всплывающая карточка и тост `animate-fade-in`. Двойного появления нет.
16. **Словарь имён (16).** Как назвать то, что отчёт называет иначе: `KpiTile` это `kpi`, `IconButton` это `btn-ghost btn-icon-xs`, `Switch` это `switch`, `rounded-card` это `rounded-xl`, `h-[42px]` это класс размера на 40px.

## 2. Токены

### 2.1 Бренд: шкала `brand` (зелёный НБК)

Источник: `dco-portal/client/tailwind.config.js`, `theme.extend.colors.brand`. Комментарий там говорит, что ступени взяты из корпоративного стандарта, сам стандарт в репозиторий не входит.

| Ступень | Hex | Роль в портале |
|---|---|---|
| 50 | `#E3F0EA` | Выбранное и тон brand в светлой теме, подложка бейджа brand |
| 100 | `#C2DFD4` | Наведение на кнопку звонка (`hover:bg-brand-100`) |
| 200 | `#A5E0C9` | Текст brand в тёмной теме (бейдж, наведение ссылки), кольцо бейджа brand |
| 300 | `#6ECDAB` | Акцентный текст в тёмной теме: активная вкладка, пункт меню, ссылка |
| 400 | `#3EB58C` | Кольцо фокуса и `accent-color` в тёмной теме, ползунок прокрутки |
| 500 | `#189A72` | Кольцо фокуса в светлой теме, рамка поля в фокусе, полоса прогресса; `brand-500/15` это выбранное в тёмной теме |
| 600 | `#00805E` | Фирменный тон: основная кнопка, `theme-color`, аватар по умолчанию, `accent-color`, ссылка, включённый `switch` |
| 700 | `#005A43` | Наведение на основную кнопку, акцентный текст в светлой теме, панель входа (`bg-brand-700`) |
| 800 | `#00432F` | Текст выноски brand |
| 900 | `#0F2B22` | Есть в шкале; правило 3 запрещает `dark:bg-brand-900/20…40` для выбранного |
| 950 | `#061713` | Есть в шкале, использование не проверял |

`theme-color` в `client/index.html` тоже `#00805E`.

### 2.2 Нейтральные: шкала `ink` (холодный сланцевый)

Источник: `tailwind.config.js`, `colors.ink`. Комментарий: серый с холодным сдвигом, иначе рядом с зелёным он выглядит грязно-тёплым.

| Ступень | Hex | Светлая тема | Тёмная тема |
|---|---|---|---|
| 50 | `#F6F8FB` | Фон body, наведение строки, вложенная панель | Заголовки |
| 100 | `#ECEFF4` | Разделители, рамка карточки (80%), дорожка сегментов, скелетон, `count-pill` | Основной текст |
| 200 | `#D8DEE6` | Рамка поля и `btn-outline` | Текст `btn-ghost`, текст тона neutral |
| 300 | `#B6BFCB` | Выключенный `switch`, точка neutral | Текст `label` |
| 400 | `#8B95A3` | Плейсхолдер, иконки, шеврон select | Вторичный текст (`text-muted`) |
| 500 | `#69727F` | Вторичный текст (`text-muted`), `eyebrow`, `th` | Приглушённые иконки |
| 600 | `#525A66` | Текст `label`, неактивный пункт меню и вкладка | Точка neutral |
| 700 | `#3F4651` | Текст `btn-ghost`, текст тона neutral | Рамка поля и `btn-outline`, выключенный `switch` |
| 800 | `#2A2F38` | Нет | Разделители, рамка карточки (80%), подложки, наведение (60%) |
| 900 | `#0F141A` | Основной текст и заголовки | Поверхность карточки, шапки, бокового меню |
| 950 | `#070A0E` | Фон под окном (40%) | Фон body и оболочки |

### 2.3 Статусы и тона

Источники: `dco-portal/client/src/lib/tone.ts` (TONE_CHIP, TONE_BADGE), `DESIGN-RULES.md` раздел 4 (точки), hex из Tailwind 3.4.19.

| Тон | Смысл (раздел 4) | Подложка светлая / тёмная | Текст светлый / тёмный | Кольцо бейджа светлое / тёмное | Точка `h-2 w-2` |
|---|---|---|---|---|---|
| neutral | Новое, не начато, черновик | ink-100 `#ECEFF4` / ink-800 `#2A2F38` | ink-700 `#3F4651` / ink-200 `#D8DEE6` | нет | ink-300 `#B6BFCB` / ink-600 `#525A66` |
| info | В работе, идёт | sky-50 `#F0F9FF` / sky-900 30% `#0C4A6E` | sky-700 `#0369A1` / sky-300 `#7DD3FC` | sky-200 60% / sky-700 60% | sky-500 `#0EA5E9` |
| warning | На проверке, ждёт, скоро срок | amber-50 `#FFFBEB` / amber-900 30% `#78350F` | amber-700 `#B45309` / amber-300 `#FCD34D` | amber-200 60% / amber-700 60% | amber-500 `#F59E0B` |
| success | Готово, закрыто, выиграно | emerald-50 `#ECFDF5` / emerald-900 30% `#064E3B` | emerald-700 `#047857` / emerald-300 `#6EE7B7` | emerald-200 60% / emerald-700 60% | emerald-500 `#10B981` |
| danger | Отменено, просрочено, ошибка | rose-50 `#FFF1F2` / rose-900 30% `#881337` | rose-700 `#BE123C` / rose-300 `#FDA4AF` | rose-200 60% / rose-700 60% | rose-500 `#F43F5E` |
| ghost | Архив, исключено | прозрачная | ink-500 `#69727F` / ink-400 `#8B95A3` | ink-200 60% / ink-700 60% | ink-300 / ink-600 |
| brand | Выбор, своё, текущее (не статус) | brand-50 `#E3F0EA` / brand-500 15% | brand-700 `#005A43` / brand-200 `#A5E0C9` | brand-200 60% / brand-700 60% | не используется |

Сплошные статусные цвета: опасная кнопка rose-600 `#E11D48` (наведение rose-700 `#BE123C`, нажатие rose-800 `#9F1239`), `text-error` rose-600 / rose-400 `#FB7185`, предупреждение amber-700 / amber-400 `#FBBF24`, успех emerald-700 / emerald-400 `#34D399` (`index.css`, `.btn-danger`, `.text-error`; `DESIGN-RULES.md` раздел 3).

Стадии CRM и полоса воронки: `bg-ink-300`, `bg-sky-400`, `bg-sky-600`, `bg-amber-500`, `bg-emerald-500`, `bg-rose-500` (раздел 4).

Пользовательские цвета, 8 образцов (раздел 4): `#00805E` Зелёный, `#1D4ED8` Синий, `#0369A1` Голубой, `#6D28D9` Фиолетовый, `#BE185D` Розовый, `#BE123C` Красный, `#B45309` Янтарный, `#525A66` Графит. Цвет текста поверх них даёт `readableOn()`: яркость по WCAG больше 0.19 даёт `#0F141A`, иначе `#FFFFFF` (`lib/tone.ts`).

Цвета тостов задаются строкой, не классом: успех `#00805E`, ошибка `#F43F5E`, глиф `#FFFFFF` (`client/src/main.tsx`).

### 2.4 Роли цвета: фон, поверхность, текст, границы

Источники: `client/index.html` (body), `index.css` (`.app-shell`, `.card`, `.input`, `.btn-*`, `.text-muted`), `DESIGN-RULES.md` раздел 3.

| Роль | Светлая | Тёмная | Классы портала |
|---|---|---|---|
| Фон body | `#F6F8FB` | `#070A0E` | `bg-ink-50 dark:bg-ink-950` |
| Фон оболочки | `#EEF6F2` (вычислено: brand-50 60% + белый 40%) и два пятна: brand-300 30% в точке 8% / -12% (эллипс 1100x560), brand-500 14% в правом верхнем углу (900x520) | `#070A0E`, пятна brand-500 12% и brand-600 12% | `.app-shell` |
| Поверхность (карточка, шапка, меню) | `#FFFFFF` | `#0F141A` | `bg-white dark:bg-ink-900` |
| Вложенная панель, наведение строки | `#F6F8FB` | ink-800 60% | `bg-ink-50 dark:bg-ink-800/60` |
| Подложка (дорожка сегментов, скелетон) | `#ECEFF4` | `#2A2F38` | `bg-ink-100 dark:bg-ink-800` |
| Подвал окна | ink-50 60% | ink-950 40% | `bg-ink-50/60 dark:bg-ink-950/40` |
| Затемнение под окном | ink-950 40% + размытие 4px | то же | `bg-ink-950/40 backdrop-blur-sm` |
| Основной текст | `#0F141A` | `#ECEFF4` | наследуется от body |
| Заголовок | `#0F141A` | `#F6F8FB` | `text-ink-900 dark:text-ink-50` |
| Вторичный текст | `#69727F` | `#8B95A3` | `text-muted` |
| Подпись поля | `#525A66` | `#B6BFCB` | `.label` |
| Плейсхолдер, прочерк, разделитель «·» | `#8B95A3` | `#8B95A3` | `text-ink-400` |
| Рамка карточки | ink-100 80% | ink-800 80% | `border-ink-100/80 dark:border-ink-800/80` |
| Разделитель | `#ECEFF4` | `#2A2F38` | `divide-ink-100 dark:divide-ink-800` |
| Рамка поля и `btn-outline` | `#D8DEE6` | `#3F4651` | `border-ink-200`, тёмная через `:where(.dark)` |
| Выбранное | `#E3F0EA` | brand-500 15% (на ink-900 это `#102827`, вычислено) | `bg-brand-50 dark:bg-brand-500/15` |
| Акцентный текст | `#005A43` | `#6ECDAB` | `text-brand-700 dark:text-brand-300` |
| Кольцо фокуса | `#189A72` | `#3EB58C` | `:focus-visible` в `index.css` |

Контраст (вычислено скриптом по формуле WCAG): белый на brand-600 4.94:1, белый на rose-600 4.70:1, ink-500 на белом 4.87:1, ink-400 на ink-900 6.10:1, ink-500 на ink-900 3.80:1 (поэтому в тёмной теме вторичный текст на ступень светлее, так и сказано в `index.css` у `.text-muted`), brand-700 на brand-50 7.04:1, brand-300 на ink-900 9.67:1.

### 2.5 Типографика

Источники: `tailwind.config.js` (`fontFamily`, `fontSize`), `index.css`, компоненты. Размеры по умолчанию Tailwind 3 прочитаны из `defaultTheme`.

- **Шрифт:** `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. Только системный, без веб-шрифтов. `-webkit-font-smoothing: antialiased` (`index.css`, `html`).
- **Моноширинный:** `font-mono` только для кода, cron, IP, технических идентификаторов (раздел 14). Свой стек не задан, берётся стандартный Tailwind.

| Токен | Размер / строка | Где |
|---|---|---|
| `text-2xs` | 11 / 16 (своё, `tailwind.config.js`) | Время, счётчики, `count-pill`, `kbd`, аватар xs |
| `text-xs` | 12 / 16 | `label`, `eyebrow`, `th`, `chip`, `Badge`, `btn-xs`, `input-xs`, подсказки |
| `text-sm` | 14 / 20 | Основной размер интерфейса: кнопки, поля, вкладки, меню, описание страницы |
| `text-base` | 16 / 24 | `section-title`, заголовок пустого состояния |
| `text-lg` | 18 / 28 | Заголовок окна, значение `kpi-compact` |
| `text-2xl` | 24 / 32 | Заголовок страницы, значение `kpi` (строка 32px через `leading-8`) |
| `text-xl`, `text-3xl` | 20 / 28, 30 / 36 | Инициалы аватаров lg и xl |

| Вес | Где |
|---|---|
| 500 `font-medium` | Кнопки, вкладки, сегменты, `label`, `chip`, неактивный пункт меню, `link` |
| 600 `font-semibold` | `section-title`, заголовок окна, `eyebrow`, `th`, `count-pill`, активный пункт меню, `btn-lg`, инициалы аватара |
| 700 `font-bold` | Заголовок страницы, значение KPI, название «DDC-Portal» в меню |

Разрядка: `tracking-tight` (-0.025em) у заголовка страницы и значения KPI, `tracking-wider` (0.05em) у `eyebrow` и `th` вместе с `uppercase`. Цифры: `tabular-nums` у чисел, сумм, времени, `count-pill`, `kpi-value`.

### 2.6 Отступы

Шаг 4px, разрешены 1, 2, 3, 4, 5, 6, 8 (4, 8, 12, 16, 20, 24, 32px). `2.5` в ритме между блоками запрещён (`DESIGN-RULES.md`, раздел 8). Внутри компонентов `index.css` использует и полушаги (`px-3.5`, `py-2.5`, `py-[9px]`), это часть рецептов.

| Что | Значение | Источник |
|---|---|---|
| Поле страницы `.page` | 24px, с md 32px | `index.css` |
| Поля шапки `.gutter-x` | 24px; с md слева 32px, справа 32px + 6px под полосу прокрутки | `index.css` |
| Запас снизу под кружок ИИ | `pb-24` (96px), пока кружок виден | `index.css` |
| Карточка-секция, форма | 20px (`p-5`) | раздел 8 |
| Панель фильтров, плитка | 16px (`p-4`) | раздел 8 |
| Колонка канбана, вложенная панель | 12px (`p-3`) | раздел 8 |
| Меню | 6px (`p-1.5`) | `.menu` |
| Окно | шапка `px-6 pt-5 pb-4`, тело `py-5 px-6`, подвал `px-6 py-4` | `Modal.tsx` |
| Строка списка в карточке | `px-5 py-3`, шапка списка `px-5 py-4` | раздел 8 |
| Ячейка таблицы | `px-3 py-2.5` | `.th`, `.td` |
| Между блоками страницы | 24px (`space-y-6`, `mb-6` у `PageHeader`) | раздел 8, `PageHeader.tsx` |
| Между блоками в карточке и полями формы | 16px (`space-y-4`) | раздел 8 |
| Сетки карточек, KPI, полей формы | 16px (`gap-4`) | разделы 6, 8, 11 |
| Кнопки в ряду | 8px (`gap-2`) | раздел 8 |
| Фильтры в панели | 12px (`gap-3`) | раздел 8 |
| Подпись над полем | 6px (`mb-1.5`) | `.label` |
| Подсказка и ошибка под полем | `mt-1.5` | раздел 11 |

### 2.7 Радиусы

Значения шкалы Tailwind 3: `rounded-md` 6px, `rounded-lg` 8px, `rounded-xl` 12px, `rounded-2xl` 16px. Своих радиусов в `tailwind.config.js` нет.

| Радиус | Где (`index.css`, компоненты) |
|---|---|
| 16px `rounded-2xl` | `.card` и всё, что на нём: окно, меню, панель вкладок, KPI, тост; плитка иконки пустого состояния (56px) |
| 12px `rounded-xl` | `.btn` (40, 36, 44px), `.input`, `.tab`, `.segmented`, `.kpi-icon`, `.callout`, вложенная панель, пункт бокового меню |
| 8px `rounded-lg` | `.btn-xs`, `.btn-icon-xs`, `.input-xs`, `.segmented-item`, `.chip-toggle`, `.menu-item`, скелетон по умолчанию |
| 6px `rounded-md` | `.chip` и `Badge`, `.kbd` |
| круг `rounded-full` | `count-pill`, `switch`, аватар, точка статуса, `btn-add`, чип человека, полоса прогресса |

Вложенность выдержана: карточка 16px, отступ 4px, вкладка 12px (`index.css`, комментарий у `.tabs`).

### 2.8 Тени

Источник: `tailwind.config.js`, `boxShadow`.

| Токен | Значение | Где |
|---|---|---|
| `shadow-card` | `0 1px 2px rgba(15,20,26,0.04), 0 8px 24px -8px rgba(15,20,26,0.08)` | `.card` в обеих темах; `.btn-primary` и `.btn-danger` только в светлой (`dark:shadow-none`) |
| `shadow-soft` | `0 8px 24px -12px rgba(15,20,26,0.14)` | Лист документа на диске |
| `shadow-sm` (Tailwind 3) | `0 1px 2px 0 rgb(0 0 0 / 0.05)` | Выбранный сегмент, бегунок `switch`, аватар |

Цветные тени и свечение запрещены (раздел 2). Вместо свечения «говорит» рисуется `ring-2 ring-emerald-400` (раздел 4).

### 2.9 Движение

Источники: `tailwind.config.js` (`animation`, `keyframes`), `client/src/lib/motion.ts`, `client/src/main.tsx`, собранный `client/dist/assets/*.css` (переход у `.btn`).

| Токен | Значение | Где |
|---|---|---|
| `transition` у `.btn`, `.input` | 150ms, `cubic-bezier(0.4, 0, 0.2, 1)` (видно в `dist`) | Кнопки, поля |
| `duration-150` | 150ms | Вкладки, сегменты, меню, `switch`, ссылки, `card-link` |
| `active:scale-[0.98]` | лёгкое вдавливание | Все `.btn` |
| `animate-fade` | `fade 0.15s ease-out`, только прозрачность | Полноэкранный слой: лайтбокс, входящий звонок |
| `animate-fade-in` | `fadeIn 0.15s ease-out`, прозрачность и сдвиг 4px снизу | Тосты, всплывающие карточки |
| `animate-shimmer` | `shimmer 2s linear infinite`, блик по фону 200% | Скелетон |
| `animate-ping-soft` | `pingSoft 1.6s cubic-bezier(0,0,0.2,1) infinite`, масштаб 1.6 и затухание | Точка «идёт сейчас» |
| `spring` | пружина: жёсткость 420, затухание 34, масса 0.8 | По умолчанию для всех motion-узлов (`MotionConfig`) |
| `springSoft` | 260 / 30 / 0.9 | Окно, выдвижные панели |
| `easeOut` | 0.18s, `[0.22, 1, 0.36, 1]` | Смена страницы, `fadeUp`, `slideDown`, переезд заливки пункта меню |
| `exitFast` | 0.12s, `easeIn` | Любой уход |
| `fadeUp` | y 6px и прозрачность, уход y -4px | Строки, карточки, пустое состояние |
| `pop` | масштаб 0.85 и прозрачность | Счётчики, реакции |
| `slideDown` | y -6px, масштаб 0.98 | Выпадающие меню |
| `page` | y 8px, 0.22s | Смена содержимого по вкладке |
| `stagger(0.03, 0.02)` | шаг 30ms | Списки |

`MotionConfig reducedMotion="never"`, медиазапроса `prefers-reduced-motion` в CSS нет (`main.tsx`, конец `index.css`).

### 2.10 Высоты, ширины, слои

| Что | Значение | Источник |
|---|---|---|
| Кнопка и поле | 44 / 40 / 36 / 32px (вычислено: строка 20px + отступы 2x11, 2x9, 2x7 + рамка 2px; у xs строка 16px) | `index.css`, `.btn*`, `.input*` |
| Кнопка-иконка | 40, 36, 32px квадрат | `.btn-icon`, `.btn-icon-sm`, `.btn-icon-xs` |
| Сегменты | 40px (`h-10`), в панели 36px (`h-9`) | `.segmented`, раздел 5 |
| `chip-toggle` | 32px | `.chip-toggle` |
| `Badge`, `count-pill`, `kbd` | 20px | `.chip` (вычислено), `.count-pill`, `.kbd` |
| `switch` | 44x24, бегунок 20px | `.switch` |
| Шапка приложения | 64px (`h-16`) | `Topbar.tsx` |
| Боковое меню | 256px, свёрнутое 64px, на телефоне 288px | `Sidebar.tsx` |
| Строка таблицы | 40px (вычислено: 20px + 2x10px) | `.td`, раздел 1 |
| Слои | шапка `z-30`; поповер, меню, фон выдвижного меню `z-40`; окно и выдвижное меню `z-50`; экран звонка `z-[55]` | `Topbar.tsx`, `NotificationBell.tsx`, `Sidebar.tsx`, `Modal.tsx` |

Точки перелома: стандартные Tailwind 3 (`sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536) и произвольные `min-[1800px]:`, `min-[2200px]:`. Своих экранов в конфиге нет (`index.css`, комментарий у `.page`, пункт 5).

## 3. Компоненты

Классы ниже выписаны из `dco-portal/client/src/styles/index.css` и компонентов. «Тёмная» значит, что даёт `dark:` или `:where(.dark)`.

### Кнопка

Файл: `index.css`, `.btn`, `.btn-*`.

```
.btn          inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-transparent
              px-4 py-[9px] text-sm font-medium leading-5 transition active:scale-[0.98]
              disabled:cursor-not-allowed disabled:opacity-50
.btn-primary  btn bg-brand-600 text-white shadow-card hover:bg-brand-700 dark:shadow-none
.btn-outline  btn border-ink-200 bg-white hover:bg-ink-50
              тёмная: border-ink-700 bg-ink-900, hover bg-ink-800
.btn-ghost    btn text-ink-700 hover:bg-ink-100 dark:hover:bg-ink-800; тёмная: text ink-200
.btn-danger   btn bg-rose-600 text-white shadow-card hover:bg-rose-700 active:bg-rose-800 dark:shadow-none
.btn-danger-ghost  btn text-rose-600 hover:bg-rose-50 hover:text-rose-700
              тёмная: text rose-400, hover bg-rose-900/30 text-rose-300
.btn-add      inline-flex items-center gap-1.5 rounded-full border border-dashed border-ink-300 px-2.5 py-1
              text-xs font-medium text-ink-600 hover:border-brand-500 hover:text-brand-700
              тёмная: border-ink-600 text-ink-300, hover border-brand-400 text-brand-300; иконка 14px
```

| Вариант | Когда |
|---|---|
| `btn-primary` | Одно главное действие ряда |
| `btn-outline` | Второстепенное, своя белая подложка (на тонированной панели прозрачная не видна) |
| `btn-ghost` | «Отмена», третичное, иконки |
| `btn-danger` | Подтверждение удаления |
| `btn-danger-ghost` | «Удалить» среди других действий |
| `btn-add` | «+ строка», «+ участник» пунктиром |

| Размер | Классы | Высота | Иконка |
|---|---|---|---|
| lg | `btn-lg`: `px-5 py-[11px] font-semibold` | 44 | 16px |
| по умолчанию | нет | 40 | 16px |
| sm | `btn-sm`: `px-3 py-[7px]` | 36 | 16px |
| xs | `btn-xs`: `gap-1.5 rounded-lg px-2.5 py-[7px] text-xs leading-4` | 32 | 14px |
| иконка | `btn-icon` `h-10 w-10 p-0`, `btn-icon-sm` `h-9 w-9`, `btn-icon-xs` `h-8 w-8 rounded-lg` | 40 / 36 / 32 | 16px |

Иконка внутри `.btn-*` без своего класса получает 16px (в `btn-xs` 14px) и не сжимается: правило `:where(.btn, …) > svg` в конце `index.css`.

Состояния: наведение меняет фон; нажатие `scale(0.98)`; фокус общее кольцо 2px brand-500 (тёмная brand-400) с отступом 2px; `disabled` даёт `opacity-50` и `cursor-not-allowed`.

**Занятая кнопка** (раздел 11, `ConfirmDialog.tsx`): подпись остаётся, спиннер на месте иконки, кнопка заблокирована, «Отмена» тоже.

```tsx
<button className="btn-primary" disabled={saving} aria-busy={saving}>
  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Сохранить
</button>
```

Приглушённая кнопка-иконка в строке: `btn-ghost btn-icon-xs text-ink-400 dark:text-ink-500`, удаление краснеет только при наведении: `hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/30 dark:hover:text-rose-400` (`pages/crm/deals/dealsHelpers.ts`).

### Поле ввода

Файл: `index.css`, `.input`, `.label`.

```
.input     w-full rounded-xl border border-ink-200 bg-white px-3.5 py-[9px] text-sm leading-5 transition
           placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30
           тёмная: border-ink-700 bg-ink-900; фокус border-brand-400 ring-brand-400/30
.input:disabled  cursor-not-allowed resize-none border-ink-200/40 bg-ink-50 text-ink-600 opacity-100
           тёмная: border-ink-700/40 bg-ink-800/40 text-ink-300
.input-sm  py-[7px]                                   36px
.input-xs  rounded-lg px-2.5 py-[7px] text-xs leading-4  32px
.label     block text-xs font-medium text-ink-600 dark:text-ink-300 mb-1.5
```

- Высота 40px, как у кнопки. `textarea` носит тот же класс, высота не зафиксирована.
- Ошибка (раздел 11): `aria-invalid`, `border-rose-400 focus:border-rose-500 focus:ring-rose-500/30`, текст `mt-1.5 text-xs text-error`. Подсказка `mt-1.5 text-xs text-muted`.
- Отключённое поле остаётся читаемым: это режим просмотра, а не подсказка.
- Поиск с иконкой (`pages/crm/deals/DealsPage.tsx`): `input pl-9 pr-9`, иконка `Search` `absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400 dark:text-ink-500`, очистка `btn-ghost btn-icon-xs absolute right-1`.
- Форма в окне: `space-y-4`, пары полей `grid gap-4 sm:grid-cols-2`, у каждого поля `label htmlFor` (`pages/crm/deals/DealForm.tsx`).

### Select и множественный фильтр

`select.input` (`index.css`): `appearance: none`, справа место 36px, шеврон lucide `chevron-down` цвета `#8B95A3` размером 16px в 12px от края. У `input-xs` отступ 32px, шеврон 14px. В режиме высокой контрастности возвращается системная стрелка.

`MultiSelectFilter` (`components/MultiSelectFilter.tsx`): триггер это `button.input` той же высоты.

```
триггер    input items-center gap-2 whitespace-nowrap pr-3 inline-flex !w-auto (+ input-sm)
           выбран не весь список: border-brand-500 text-brand-700 dark:border-brand-400 dark:text-brand-300
           шеврон h-4 w-4 text-ink-400, открыт: rotate-180
список     menu absolute z-30 mt-1 max-h-72 w-max min-w-full max-w-80 overflow-y-auto, анимация slideDown
строка     menu-item, галочка h-4 w-4 rounded border-2: отмечено border-brand-600 bg-brand-600 text-white,
           нет: border-ink-400 dark:border-ink-500
```

ARIA: `aria-haspopup="listbox"`, `aria-expanded`, `role="listbox" aria-multiselectable`, строки `role="option" aria-selected`.

### Чекбокс и радио

Нативные (`index.css`, `@layer base`): 16x16, не сжимаются, `cursor: pointer`. Цвет отметки даёт `accent-color`: brand-600, в тёмной теме brand-400. `color-scheme: dark` в тёмной теме перекрашивает нативные части. Классы плагина форм запрещены, опасный выбор `accent-rose-600` (раздел 10).

### Переключатель

`index.css`, `.switch`:

```
.switch       relative inline-flex h-6 w-11 flex-none cursor-pointer items-center rounded-full bg-ink-300
              transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-ink-700
[aria-checked=true]  bg-brand-600
.switch-knob  pointer-events-none inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow-sm
              transition-transform duration-150; включён: translate-x-[22px]
```

Разметка: `<button type="button" role="switch" aria-checked={on} aria-label="…" className="switch"><span className="switch-knob" /></button>`.

### Вкладки, сегменты, пресеты, счётчик

`index.css`, `.tabs`, `.tab`, `.segmented*`, `.chip-toggle`, `.count-pill`, `.kbd`.

```
.tabs          card inline-flex max-w-full gap-1 overflow-x-auto p-1
.tab           inline-flex flex-none items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium
               leading-5 text-ink-600 hover:bg-ink-50 hover:text-ink-900 focus-visible:-outline-offset-2
               тёмная: text-ink-300 hover:bg-ink-800/60 hover:text-ink-100
активная       [aria-selected=true] или [aria-current=page]: bg-brand-50 text-brand-700
               тёмная: bg-brand-500/15 text-brand-300
.segmented     inline-flex h-10 max-w-full flex-none items-stretch gap-1 rounded-xl bg-ink-100 p-1 dark:bg-ink-800
.segmented-item  inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium
               text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-100
выбранный      [aria-pressed=true] или [aria-checked=true]: bg-white text-ink-900 shadow-sm dark:bg-ink-700 dark:text-ink-50
.chip-toggle   inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-ink-600 hover:bg-ink-100
               тёмная: text-ink-300 hover:bg-ink-800/60
выбранный      bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200/60
               тёмная: bg-brand-500/15 text-brand-200 ring-brand-700/60
.count-pill    inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-ink-100 px-1.5 text-2xs
               font-semibold tabular-nums text-ink-700; тёмная: bg-ink-800 text-ink-200
.kbd           inline-flex h-5 items-center rounded-md bg-ink-100 px-1.5 text-2xs font-medium text-ink-600
               тёмная: bg-ink-800 text-ink-300
```

- Вкладка 36px (вычислено: 20 + 2x8), панель вкладок 46px с рамкой (вычислено). Ряд вкладок прокручивается, не переносится. Подчёркивание и сплошная заливка вкладки запрещены (раздел 5).
- Выбранный сегмент приподнят белым, а не утоплен тёмным.
- Счётчик: непрочитанные `count-pill bg-brand-600 text-white`; уведомления `bg-rose-600 text-white`; тревожный `bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200/60` (тёмная `bg-rose-900/30 text-rose-300 ring-rose-700/60`); поверх иконки `absolute -right-1 -top-1 h-4 min-w-4 px-1 ring-2 ring-white dark:ring-ink-900` (раздел 5).
- Примеры: `pages/Settings.tsx` (вкладки с `role="tablist"`), `components/ThemeToggle.tsx` (сегменты «Светлая / Тёмная / Системная»), `pages/crm/deals/DealsPage.tsx` (сегменты «Воронка / Список»).

### Карточка

`index.css`, `.card`, `.card-link`:

```
.card       bg-white dark:bg-ink-900 border border-ink-100/80 dark:border-ink-800/80 rounded-2xl shadow-card
.card-link  transition-colors duration-150 hover:border-brand-300/70 dark:hover:border-brand-700/70
```

Карточка-ссылка при наведении меняет только рамку, без фона и тени. Отступы по роли в разделе 2.6. Список строк в карточке: `card overflow-hidden`, шапка `flex items-center justify-between gap-3 border-b border-ink-100 px-5 py-4 dark:border-ink-800`, строка `px-5 py-3`.

Выноска (`index.css`, `.callout`): `flex items-start gap-2 rounded-xl border border-ink-200 bg-ink-50 px-4 py-3 text-sm text-ink-700`, тёмная `border-ink-700 bg-ink-800/60 text-ink-200`. Варианты `callout-brand`, `callout-warning`, `callout-danger`: рамка 200, фон 50/70, текст 800, в тёмной рамка 800, фон 900/20, текст 200.

### Таблица

`index.css`, `.th`, `.td`; пример `pages/crm/deals/DealsTable.tsx`.

```
обёртка  card overflow-hidden > div.relative.overflow-x-auto > table.min-w-full.text-sm
.th      whitespace-nowrap border-b border-ink-100 px-3 py-2.5 text-left text-xs font-semibold uppercase
         tracking-wider text-ink-500 dark:border-ink-800 dark:text-ink-400
.td      px-3 py-2.5 align-middle
tbody    divide-y divide-ink-100 dark:divide-ink-800
```

- Первая колонка `pl-5`, чтобы совпасть с полями карточки.
- Числа `text-right tabular-nums`, суммы `font-semibold`. Пустое значение `<span className="text-ink-400">`.
- Ширина: одна длинная текстовая колонка `w-full`, короткие `w-px whitespace-nowrap` (`index.css`, комментарий у `.page`, пункт 3).
- Вторичные колонки прячутся: `hidden sm:table-cell`, `lg:`, `xl:`, `2xl:`. Подсветка строки `hover:bg-ink-50 dark:hover:bg-ink-800/60` только у кликабельной.
- Кнопки в ячейке `btn-ghost btn-icon-xs -my-1.5`.

### Бейдж и точка статуса

`components/Badge.tsx`, `lib/tone.ts`, `index.css` `.chip`:

```
.chip   inline-flex items-center gap-1 whitespace-nowrap px-2 py-0.5 rounded-md text-xs font-medium
Badge   chip [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:flex-none + TONE_BADGE[tone]
```

Высота 20px. Контур рисует внутреннее кольцо `ring-1 ring-inset`, а не рамка, поэтому бейдж совпадает по размеру с чипом без контура. Цвета тонов в таблице 2.3. Тон по умолчанию `neutral`. Точку внутри тонового бейджа не рисуют (раздел 4).

Точка статуса: `h-2 w-2 flex-none rounded-full` + цвет из таблицы 2.3. Присутствие человека (`components/StatusDot.tsx`): online emerald-500 «В сети», away amber-500 «Нет на месте», offline `bg-ink-300 dark:bg-ink-600` «Не в сети»; размеры 8, 10, 12px, кольцо `ring-2 ring-white dark:ring-ink-900`.

### KPI-плитка

`index.css` `.kpi*`, `components/KpiTile.tsx`:

```
.kpi          card flex h-full min-w-0 flex-col gap-3 p-5
.kpi-icon     inline-flex h-10 w-10 flex-none items-center justify-center rounded-xl  (+ TONE_CHIP[tone], иконка 20px)
.kpi-value    truncate text-2xl font-bold leading-8 tracking-tight tabular-nums text-ink-900 dark:text-ink-50
.kpi-label    text-sm text-ink-500 dark:text-ink-400
.kpi-compact  flex-row items-center p-4; значение text-lg leading-7; подпись text-xs
```

- Вертикальная: сверху иконка и дельта в углу (`text-xs tabular-nums text-muted`), снизу значение и подпись (`mt-auto`).
- Нет данных: приглушённый прочерк `text-ink-400 dark:text-ink-500`. Загрузка: `Skeleton h-6 w-24` (в компактной `h-5 w-12`).
- Плитка-ссылка: `kpi card-link` и стрелка `ArrowUpRight` 16px.
- Появление `fadeUp`, в сетке со `stagger` по очереди.

### Модальное окно и подтверждение

`components/Modal.tsx`, `components/ConfirmDialog.tsx`.

```
корень    fixed inset-0 z-50 flex items-center justify-center p-4
фон       absolute inset-0 bg-ink-950/40 backdrop-blur-sm
окно      card relative flex max-h-full w-full flex-col overflow-hidden text-ink-900 dark:text-ink-100
размер    sm max-w-sm (384), md max-w-md (448, по умолчанию), lg max-w-lg (512), xl max-w-2xl (672), 2xl max-w-5xl (1024)
шапка     flex items-start justify-between gap-3 px-6 pb-4 pt-5, border-b border-ink-100 dark:border-ink-800
заголовок flex items-center gap-2 text-lg font-semibold text-ink-900 dark:text-ink-50
описание  mt-1 text-sm text-muted
крестик   btn-ghost btn-icon-xs -my-0.5 -mr-1, aria-label «Закрыть»
тело      min-h-0 overflow-y-auto py-5 pl-6 pr-[calc(1.5rem-6px)] [scrollbar-gutter:stable]
подвал    flex flex-wrap items-center justify-end gap-2 bg-ink-50/60 px-6 py-4 dark:bg-ink-950/40, border-t
```

- Движение: фон затухает (`easeOut`), окно появляется с y 12px и масштаба 0.97 пружиной `springSoft`, уходит за 0.12s.
- Поведение: ловушка фокуса Tab, Escape закрывает только верхнее окно из стека, фокус возвращается на кнопку открытия, `closeDisabled` блокирует закрытие во время отправки. `role="dialog" aria-modal aria-labelledby aria-describedby`.
- Тело прокручивается, шапка и подвал остаются на экране.
- `ConfirmDialog`: окно `sm`, текст в описании (его читает диктор), подвал «Отмена» (`btn-ghost`) и действие: `btn-danger` при `destructive`, иначе `btn-primary`. Подписи по умолчанию «Подтвердить» и «Отмена». Пока идёт действие, обе кнопки заблокированы и окно не закрывается.
- Удаление по правилу 11: `title="Удалить …?" message="Действие нельзя отменить." confirmLabel="Удалить"`.

### Меню

`index.css` `.menu`, `.menu-item`; пример `components/Topbar.tsx` (меню пользователя).

```
.menu              card p-1.5 text-sm
.menu-item         flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm leading-5 text-ink-700
                   hover:bg-ink-50 focus-visible:bg-ink-50 focus-visible:-outline-offset-2
                   disabled:cursor-not-allowed disabled:opacity-50
                   тёмная: text-ink-200 hover:bg-ink-800/60
.menu-item-danger  text-rose-600 hover:bg-rose-50, тёмная text-rose-400 hover:bg-rose-900/30
разделитель        my-1 h-px bg-ink-100 dark:bg-ink-800
```

Пункт 36px (вычислено). Иконка пункта 16px цвета ink-400, у опасного пункта цвета текста. Появление `slideDown` с `transformOrigin: top right`. `role="menu"` / `role="menuitem"`, Escape возвращает фокус на триггер. Меню пользователя: `menu absolute right-0 w-56`.

Поповер (раздел 13, `components/NotificationBell.tsx`): `card fixed inset-x-2 top-[4.25rem] z-40 max-h-[min(480px,calc(100dvh-5rem))] overflow-y-auto sm:absolute sm:inset-x-auto sm:right-0 sm:w-96`, липкая шапка `sticky top-0 border-b px-4 py-3 bg-white dark:bg-ink-900`.

### Тост

Системный тост (`client/src/main.tsx`, react-hot-toast):

- Место: справа сверху, `top: 9rem` (ниже ряда действий шапки страницы, комментарий в коде).
- Время показа 3500ms, снятие 200ms.
- Вид как у карточки: `!bg-white dark:!bg-ink-900 !text-ink-900 dark:!text-ink-100 !border !border-ink-100/80 dark:!border-ink-800/80 !rounded-2xl !shadow-card !text-sm prose-wrap`.
- Появление `animate-fade-in`, уход `-translate-y-1 opacity-0 transition`. Своя анимация библиотеки выключена.
- Иконки: успех `#00805E`, ошибка `#F43F5E`, глиф белый.

Тост уведомления (`components/NotificationToast.tsx`): `card flex w-[min(360px,calc(100vw-2rem))] items-start gap-3 p-3 pr-2`, плитка `h-9 w-9 rounded-xl` тона brand (сообщение) или warning, заголовок `text-sm font-semibold truncate`, текст `text-xs text-muted line-clamp-2`, крестик `btn-ghost btn-icon-xs`.

### Пустое состояние

`components/EmptyState.tsx`:

```
корень     flex flex-col items-center justify-center text-center, py-12 px-6 по умолчанию
плитка     mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl + TONE_CHIP[tone] (по умолчанию brand), иконка 24px
заголовок  text-balance text-base font-semibold text-ink-900 dark:text-ink-50
описание   mt-1 max-w-sm text-balance text-sm text-muted
действия   mt-5 flex flex-wrap justify-center gap-2
```

- Появляется сам (`fadeUp`), обёртка простой `div.card` без своего отступа (раздел 12).
- Компактно `className="py-8"`. Только после первой загрузки.
- «Ничего не найдено»: иконка `SearchX`, действие `btn-outline` «Сбросить поиск». Пусто: иконка раздела и `btn-primary` (`pages/crm/deals/DealsPage.tsx`).

### Скелетон

`components/Skeleton.tsx`:

```
Skeleton  rounded-lg relative overflow-hidden bg-ink-100 dark:bg-ink-800
          before:absolute before:inset-0 before:bg-[length:200%_100%] before:bg-gradient-to-r
          before:from-transparent before:via-white/60 dark:before:via-white/5 before:to-transparent before:animate-shimmer
SkeletonText  space-y-2, строки h-3, последняя w-2/3
```

Скелетон повторяет разметку: строка `h-4` под `text-sm`, `h-3` под `text-xs`, заголовок `h-5 w-40`, аватар `rounded-full`, плитка 40px `rounded-xl`, карточка `rounded-2xl`, бейдж `h-5 rounded-md` (раздел 12, `pages/crm/deals/DealsSkeletons.tsx`). Обёртке `aria-busy="true"` и скрытый текст «Загрузка…».

### Ошибка загрузки

`components/LoadError.tsx`: это `EmptyState` с тоном `warning`, иконкой `AlertTriangle` 24px, отступом `py-10` (компактно `py-6`), без своего появления.

- Причина второй строкой в `role="alert"`, по умолчанию «Проверьте соединение и попробуйте ещё раз.»
- Кнопка «Повторить» с `RefreshCw`, во время повтора `Loader2 animate-spin`, `disabled`, `aria-busy`. Кнопка не исчезает, чтобы фокус не падал на body.
- **Расхождение:** у кнопки класс `btn-secondary`, а такого класса нет ни в `index.css`, ни в собранном `client/dist/assets/*.css` (проверено `grep`). При переносе ставить `btn-outline`. Как кнопка выглядит в портале сейчас, не проверял.

### Шапка страницы

`components/PageHeader.tsx`:

```
корень    mb-6 flex flex-wrap items-start gap-x-6 gap-y-4
текст     min-w-0 grow basis-80
h1        flex items-center gap-2 text-2xl font-bold tracking-tight text-ink-900 prose-wrap dark:text-ink-50
описание  mt-1 max-w-3xl text-sm text-muted prose-wrap [text-wrap:balance]
действия  -mt-1 flex min-h-10 max-w-full flex-wrap items-center gap-2
```

Действия справа, пока колонке текста остаётся не меньше 20rem (320px), иначе уходят под описание. Решает место, а не ширина окна. Заголовок блока внутри страницы: `.head-row` (`flex flex-wrap items-start justify-between gap-x-6 gap-y-3`), `.head-main` (`flex: 1 1 24rem`), `.head-actions` (`flex flex-wrap items-center gap-2`). Заголовок секции `.section-title`: `flex items-center gap-2 text-base font-semibold`, иконка ink-400.

### Боковое меню и шапка приложения

`components/Sidebar.tsx`:

```
панель     flex flex-col overflow-hidden border-r border-ink-100 bg-white dark:border-ink-800 dark:bg-ink-900
           от md: static h-full, w-64 (256) или свёрнуто w-16 (64)
           телефон: fixed inset-y-0 left-0 z-50 w-72 (288), выезд translate-x, фон z-40 bg-ink-950/40 backdrop-blur-sm
шапка      flex h-16 items-center gap-2 border-b pl-3.5 pr-3; знак 36px; «DDC-Portal» text-sm font-bold tracking-tight;
           «Корпоративный портал» text-2xs font-medium uppercase text-muted md:tracking-wider
список     min-h-0 flex-1 space-y-1 overflow-y-auto py-3 pl-3 pr-1.5 [scrollbar-gutter:stable]
пункт      group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm leading-5 transition-colors duration-150
           активный: font-semibold text-brand-700 dark:text-brand-300 + заливка bg-brand-50 dark:bg-brand-500/15
           обычный:  font-medium text-ink-600 hover:bg-ink-50 dark:text-ink-300 dark:hover:bg-ink-800/60
раздел     eyebrow px-3 pb-1 pt-4 («CRM», «Администрирование»); в свёрнутом виде короткая черта h-px w-6
низ        border-t py-2: «Настройки» и кнопка сворачивания (только от md)
```

- Заливка активного пункта переезжает к новому пункту (`layoutId`, `easeOut`).
- Иконки 16px. Счётчик непрочитанных `count-pill bg-brand-600 text-white`; в свёрнутом виде он на углу иконки.
- Подписи при сворачивании гаснут (`transition-opacity duration-150`), а не исчезают рывком.
- Состояние сворачивания хранится в `localStorage` под ключом `vibe.sidebar.collapsed` (`Layout.tsx`).
- Длинный список затухает снизу маской, пока есть что прокрутить.

`components/Topbar.tsx`:

```
шапка      gutter-x z-30 flex h-16 flex-none items-center gap-2 border-b border-ink-100 bg-white
           dark:border-ink-800 dark:bg-ink-900 sm:gap-3
меню       btn-ghost btn-icon-sm -ml-2.5 md:hidden (открывает выдвижное меню)
поиск      input input-sm hidden max-w-xl flex-1 sm:flex, иконка Search, подсказка kbd «Ctrl K» с lg;
           на телефоне вместо поля btn-ghost btn-icon-sm
справа     ml-auto flex flex-none items-center gap-2: чип итерации, набор номера (если включена телефония),
           рабочий день, статус AD (с lg), колокольчик, тема (с sm),
           пользователь: btn-ghost btn-icon-sm с аватаром sm, с lg ещё имя (text-xs semibold) и должность (text-2xs muted)
```

### Аватар

`components/Avatar.tsx`:

| Размер | Классы | Где (раздел 9) |
|---|---|---|
| xs | `h-6 w-6 text-2xs` (24) | Чипы, стопки |
| sm | `h-8 w-8 text-xs` (32) | Плотные строки, комментарии |
| md | `h-10 w-10 text-sm` (40) | Строки списков, шапки |
| lg | `h-16 w-16 text-xl` (64) | Карточки людей |
| xl | `h-24 w-24 text-3xl` (96) | Профиль |

- Основа: `relative inline-flex flex-none select-none items-center justify-center rounded-full font-semibold tracking-tight shadow-sm`.
- Без своего цвета: `bg-brand-600 text-white`. Со своим цветом: фон из `style`, текст из `readableOn()`.
- Фото поверх инициалов `absolute inset-0 rounded-full object-cover`; пока фото не загрузилось, видны инициалы.
- Точка присутствия в углу, кольцо цвета фона. Подпись для диктора «Имя, в сети».
- Стопка (`AvatarStack.tsx`): `ring-2 ring-white dark:ring-ink-900`.
- Чип человека (раздел 9): `inline-flex max-w-full items-center gap-1.5 rounded-full bg-ink-100 py-0.5 pl-0.5 pr-2 text-xs dark:bg-ink-800` + аватар xs.

### Прочее из `index.css`

- `.eyebrow`: `text-xs font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400`.
- `.link`: `font-medium text-brand-600 underline-offset-2 hover:text-brand-700 hover:underline dark:text-brand-300 dark:hover:text-brand-200`.
- `.link-hover`: цвет текста, при наведении `text-brand-700` / `dark:text-brand-300`.
- `.text-muted`, `.text-error`, `.prose-wrap` (`overflow-wrap: anywhere`).
- Полоса прогресса (раздел 9): дорожка `h-1.5 w-full rounded-full bg-ink-100 dark:bg-ink-800`, заливка `bg-brand-500 transition-[width] duration-300`.

## 4. Раскладка

### Оболочка

`components/Layout.tsx`:

```
<div class="h-dvh overflow-hidden flex app-shell">
  <Sidebar/>                                   колонка 256 / 64px, на телефоне выдвижная
  <div class="flex-1 flex flex-col min-w-0 min-h-0 relative">
    <Topbar/>                                  64px, z-30
    <AnnouncementBanner/>                      полоса объявления в потоке
    <div class="absolute inset-x-0 top-16 bottom-0 pointer-events-none"><WebBackground/></div>
    <main class="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]">
      страница (появление opacity, easeOut, при смене раздела)
    </main>
  </div>
</div>
```

- Прокручивается только `<main>`. Меню и шапка всегда на экране.
- Место под полосу прокрутки занято всегда, чтобы кнопки шапки не прыгали.
- Под содержимым неподвижный холст «паутинка» (`components/WebBackground.tsx`): узлы цвета brand-600 (тёмная brand-400), прозрачность 0.2 (тёмная 0.22), плотность 1.2. Узлы обходят текст и кнопки. Холст встаёт на паузу под развёрнутым звонком. Это заметная черта портала; переносить ли её, решать отдельно.
- Справа снизу кружок ИИ; пока он виден, у `.page` запас снизу `pb-24`.

### Ширина содержимого

Страница выбирает ширину один раз по своему типу (`index.css`, комментарий у `.page`; подсчёт `grep` по `client/src/pages`):

| Тип страницы | Классы | Ширина |
|---|---|---|
| Форма, настройки | `page mx-auto w-full max-w-4xl` или `page-narrow` | 896 или 768px |
| Лента для чтения (уведомления, «Сегодня», звонки) | `page mx-auto w-full max-w-5xl` | 1024px |
| Список или карточка с заголовком и действиями | `page mx-auto w-full max-w-[110rem]` | 1760px |
| Плотные данные (дашборд, канбан, календарь, диск, CRM, админка, мессенджер) | `page` | вся ширина |

Самый частый вариант в страницах: `page space-y-6` (20 мест).

### Сетки

| Что | Классы | Источник |
|---|---|---|
| KPI | `grid grid-cols-2 gap-4 lg:grid-cols-4`; с деньгами `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` | раздел 6 |
| Плитки | `grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))]`, файлы `7.5rem` | раздел 13 |
| Карточки проектов | минимум 16rem, с 2xl 24rem | `index.css`, пункт 4 |
| Плашки людей | 16rem, с 2xl 22rem | `index.css`, пункт 4 |
| Поля формы | `grid gap-4 sm:grid-cols-2` | раздел 11 |
| Колонка канбана | `card p-3 flex flex-col gap-3` | раздел 8 |
| Страница входа | `min-h-screen grid lg:grid-cols-2`, левая панель `bg-brand-700 text-white px-12 py-32` с lg | `pages/Login.tsx` |

`auto-fill`, а не `auto-fit`: одна карточка не растягивается на весь ряд.

### Телефон, 390px

Источники: `DESIGN-RULES.md` раздел 13, `Sidebar.tsx`, `Topbar.tsx`. В браузере на 390px не проверял.

- Горизонтальной прокрутки страницы нет. Поле страницы 24px.
- Меню выезжает слева поверх страницы (288px) с затемнённым фоном, закрывается по Escape, по фону и после перехода.
- В шапке: кнопка меню, кнопка поиска вместо поля; справа остаются рабочий день, колокольчик и пользователь, переключатель темы уходит в «Настройки» (`Topbar.tsx`, `hidden sm:contents`).
- `PageHeader` идёт столбиком, у вторичных кнопок подпись `hidden sm:inline` и `aria-label` на кнопке.
- Вкладки прокручиваются по горизонтали.
- Панель фильтров `flex flex-wrap`, поиск `min-w-0 flex-1 basis-full sm:basis-auto`.
- Строки списка: мета уходит под заголовок, вторичные колонки `hidden sm:block`, в таблице `hidden md:table-cell`. Цель нажатия не меньше 32px.
- Поповер на всю ширину: `fixed inset-x-2 top-[4.25rem]`.

## 5. Тексты интерфейса

- Язык русский: `<html lang="ru">` (`client/index.html`), все подписи, `aria-label` и `title` по-русски (раздел 10). Комментарии в коде тоже по-русски (раздел 14).
- Регистр предложения: «Новое задание», «Экспорт CSV» (раздел 14).
- Сырые значения (`negotiation`, `high`, `offline`) не выводятся, только через словари `lib/*`. Пример: `USER_STATUS_LABEL` в `StatusDot.tsx` («В сети», «Нет на месте», «Не в сети»).
- Число со словом через общий `plural` («1 участник», «3 чата», «5 записей»). Реализация в `client/src/lib/plural.ts`; правило 14 называет `@/lib/assignments`.
- Многоточие одним символом «…»: «Загрузка…», «Название или компания…» (раздел 14, `DealsPage.tsx`).
- Мета-строка через « · » (`[a, b].filter(Boolean).join(" · ")`).
- Пустое значение: правило 14 требует длинное тире (U+2014) цвета `text-ink-400`. **Расхождение:** в коде в 56 местах стоит среднее тире (U+2013), например `DealsTable.tsx` и `KpiTile.tsx` (проверено `grep` и `python`).
- Запрета на длинное тире в тексте интерфейса в правилах DDC нет. Сами правила пишут с длинными тире.
- Даты: в таблице `dd.MM.yyyy`, в заголовке `d MMMM yyyy`, время `HH:mm` (раздел 14).
- Устойчивые подписи: «Отмена», «Сохранить», «Удалить», «Подтвердить», «Закрыть», «Повторить», «Сбросить поиск»; ссылки назад «К заданиям», «К задачам», «К группам»; удаление «Удалить …?» и «Действие нельзя отменить.» (разделы 7, 11, `ConfirmDialog.tsx`, `LoadError.tsx`).
- Эмодзи в интерфейсе запрещены (раздел 2).
- **Расхождение:** правило 2 называет раздел с иконкой `Gauge` «Дашборд», а в `Sidebar.tsx` пункт `/dashboard` подписан «Сводка».

## 6. Перенос на Tailwind v4

Готовый файл: `platform/apps/console/src/styles/ddc-tokens.css` (новый, нигде не подключён). Блок ниже совпадает с файлом.

### Что в файле

- `@custom-variant dark`: тёмная тема по классу `.dark` на `<html>`, как в портале (`client/public/theme.js` ставит класс до первой отрисовки).
- `@theme`: шкалы `brand` и `ink`, шкалы `rose`, `amber`, `emerald`, `sky` в hex Tailwind 3, системный шрифт, `text-2xs`, тени `card` и `soft`, четыре анимации с ключевыми кадрами. После подключения работают классы портала как есть: `bg-brand-600`, `text-ink-500`, `shadow-card`, `animate-fade-in`, `text-2xs`.
- `:root` и `.dark`: смысловые переменные `--ddc-*` для фона, поверхностей, текста, границ, акцента, тонов и точек статусов. Каждая подписана парой классов портала.
- `@theme inline`: утилиты из смысловых переменных, например `bg-ddc-surface`, `text-ddc-text-muted`, `border-ddc-border`, `bg-ddc-tone-success-bg`. Они сами меняются с темой, `dark:` пара не нужна.
- `@layer base`: шрифт, `color-scheme`, `accent-color`, курсор кнопок, кольцо фокуса, нативные чекбоксы, полоса прокрутки.
- `@utility ddc-app-shell`: зелёный фон оболочки с двумя пятнами.

Проверка: файл собран компилятором `@tailwindcss/node` 4.2.2 из `platform/node_modules` вместе с `@import "tailwindcss"`. Классы `bg-brand-600`, `dark:text-ink-400`, `bg-ddc-surface`, `dark:bg-ddc-surface`, `text-ddc-text-muted`, `ring-ddc-tone-brand-ring`, `shadow-card`, `animate-fade-in`, `animate-ping-soft`, `text-2xs`, `ddc-app-shell` попали в результат. Вид в браузере не проверял.

### Отличия v3 и v4, которые меняют вид

Проверено по `tailwindcss@4.2.2/theme.css` и `preflight.css` в `platform/node_modules/.pnpm` и по `defaultTheme` Tailwind 3.4.19 портала.

| Что | Портал (v3) | Что писать в v4 |
|---|---|---|
| `shadow-sm` | `0 1px 2px 0 rgb(0 0 0 / 0.05)` | `shadow-xs` (в v4 `shadow-sm` крупнее) |
| `backdrop-blur-sm` | 4px | `backdrop-blur-xs` (в v4 `sm` это 8px) |
| `focus:outline-none` у `.input` | прячет обводку | `focus:outline-hidden` |
| Цвета rose, amber, emerald, sky | hex | в v4 по умолчанию oklch, оттенки чуть другие; в файле закреплены hex v3 |
| Курсор кнопок | preflight v3 даёт `cursor: pointer` | в v4 его нет, правило добавлено в `@layer base` файла |
| `darkMode: "class"` | конфиг | `@custom-variant dark (&:where(.dark, .dark *))` |
| `theme("colors.brand.600" / 45%)` | функция в CSS | переменная `var(--color-brand-600)` или готовые `--ddc-*` |
| `@apply btn` внутри `.btn-primary` | работает в `@layer components` | только через `@utility`; проверено: класс из `@layer components` даёт ошибку `Cannot apply unknown utility class` |

Радиусы `rounded-md`, `lg`, `xl`, `2xl`, `full`, шкала текста `xs` до `2xl` и `tracking-*` в v4 те же (сверено с `theme.css`).

### Как перенести компонентные классы

Классы из раздела 3 переносятся через `@utility`, иначе `@apply` по ним не работает. Пример собран тем же компилятором без ошибок:

```css
@utility btn {
  @apply inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-transparent px-4 py-[9px] text-sm font-medium leading-5 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50;
}
@utility btn-primary {
  @apply btn bg-brand-600 text-white shadow-ddc-btn hover:bg-brand-700;
}
@utility input {
  @apply w-full rounded-xl border border-ddc-border-strong bg-ddc-surface px-3.5 py-[9px] text-sm leading-5 transition placeholder:text-ddc-placeholder focus:border-brand-500 focus:outline-hidden focus:ring-2 focus:ring-brand-500/30;
}
```

Правила с селекторами состояния (`.tab[aria-selected="true"]`, `.switch[aria-checked="true"] .switch-knob`, `:where(.btn) > svg`) удобнее оставить обычным CSS рядом или записать вариантами `aria-selected:` и `aria-checked:`. Эту часть не собирал.

В приложении на shadcn (как `platform/apps/console`) проще всего связать его переменные с `--ddc-*`: например `--primary` с `--ddc-primary`, `--background` с `--ddc-bg`, `--card` с `--ddc-surface`, `--muted-foreground` с `--ddc-text-muted`, `--border` с `--ddc-border-strong`, `--ring` с `--ddc-ring`, `--radius` 12px. Это предложение, в коде не проверено.

### Блок CSS

```css
/*
  DDC (портал БСБ): токены оформления для Tailwind v4.

  Источник значений (только чтение):
    dco-portal/client/tailwind.config.js      шкалы brand и ink, шрифт, text-2xs, тени, анимации
    dco-portal/client/src/styles/index.css    фон оболочки, фокус, полоса прокрутки, классы компонентов
    dco-portal/client/src/lib/tone.ts         тона бейджей и подложек иконок
    dco-portal/docs/DESIGN-RULES.md           точки статусов, роли текста
  Цвета rose, amber, emerald, sky: значения Tailwind 3.4.19 из node_modules портала.
  В Tailwind v4 эти шкалы заданы в oklch и немного отличаются, поэтому здесь
  они закреплены в hex, как в портале.

  Подключение: после @import "tailwindcss". Тёмная тема по классу .dark на <html>.
  Описание и правила: docs/ddc-design-system.md.
*/

@custom-variant dark (&:where(.dark, .dark *));

@theme {
  /* Шрифт: только системный стек, внешних шрифтов нет. */
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

  /* Микротекст 11/16: время, счётчики, подписи под строкой. */
  --text-2xs: 0.6875rem;
  --text-2xs--line-height: 1rem;

  /* Бренд: зелёный НБК. 600 = фирменный тон, основная кнопка. */
  --color-brand-50: #e3f0ea;
  --color-brand-100: #c2dfd4;
  --color-brand-200: #a5e0c9;
  --color-brand-300: #6ecdab;
  --color-brand-400: #3eb58c;
  --color-brand-500: #189a72;
  --color-brand-600: #00805e;
  --color-brand-700: #005a43;
  --color-brand-800: #00432f;
  --color-brand-900: #0f2b22;
  --color-brand-950: #061713;

  /* Нейтральные: холодный сланцевый серый. */
  --color-ink-50: #f6f8fb;
  --color-ink-100: #eceff4;
  --color-ink-200: #d8dee6;
  --color-ink-300: #b6bfcb;
  --color-ink-400: #8b95a3;
  --color-ink-500: #69727f;
  --color-ink-600: #525a66;
  --color-ink-700: #3f4651;
  --color-ink-800: #2a2f38;
  --color-ink-900: #0f141a;
  --color-ink-950: #070a0e;

  /* Статусы: шкалы Tailwind v3 в hex. */
  --color-rose-50: #fff1f2;
  --color-rose-100: #ffe4e6;
  --color-rose-200: #fecdd3;
  --color-rose-300: #fda4af;
  --color-rose-400: #fb7185;
  --color-rose-500: #f43f5e;
  --color-rose-600: #e11d48;
  --color-rose-700: #be123c;
  --color-rose-800: #9f1239;
  --color-rose-900: #881337;
  --color-rose-950: #4c0519;

  --color-amber-50: #fffbeb;
  --color-amber-100: #fef3c7;
  --color-amber-200: #fde68a;
  --color-amber-300: #fcd34d;
  --color-amber-400: #fbbf24;
  --color-amber-500: #f59e0b;
  --color-amber-600: #d97706;
  --color-amber-700: #b45309;
  --color-amber-800: #92400e;
  --color-amber-900: #78350f;
  --color-amber-950: #451a03;

  --color-emerald-50: #ecfdf5;
  --color-emerald-100: #d1fae5;
  --color-emerald-200: #a7f3d0;
  --color-emerald-300: #6ee7b7;
  --color-emerald-400: #34d399;
  --color-emerald-500: #10b981;
  --color-emerald-600: #059669;
  --color-emerald-700: #047857;
  --color-emerald-800: #065f46;
  --color-emerald-900: #064e3b;
  --color-emerald-950: #022c22;

  --color-sky-50: #f0f9ff;
  --color-sky-100: #e0f2fe;
  --color-sky-200: #bae6fd;
  --color-sky-300: #7dd3fc;
  --color-sky-400: #38bdf8;
  --color-sky-500: #0ea5e9;
  --color-sky-600: #0284c7;
  --color-sky-700: #0369a1;
  --color-sky-800: #075985;
  --color-sky-900: #0c4a6e;
  --color-sky-950: #082f49;

  /* Тени. card: карточки, кнопки primary и danger в светлой теме. soft: лист документа. */
  --shadow-card: 0 1px 2px rgba(15, 20, 26, 0.04), 0 8px 24px -8px rgba(15, 20, 26, 0.08);
  --shadow-soft: 0 8px 24px -12px rgba(15, 20, 26, 0.14);

  /* Анимации. Не зависят от prefers-reduced-motion: так решено в портале. */
  --animate-fade: fade 0.15s ease-out;
  --animate-fade-in: fadeIn 0.15s ease-out;
  --animate-shimmer: shimmer 2s linear infinite;
  --animate-ping-soft: pingSoft 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;

  @keyframes fade {
    0% { opacity: 0; }
    100% { opacity: 1; }
  }
  @keyframes fadeIn {
    0% { opacity: 0; transform: translateY(4px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  @keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  @keyframes pingSoft {
    75%, 100% { transform: scale(1.6); opacity: 0; }
  }
}

/*
  Смысловые переменные. Каждая повторяет пару классов портала
  «светлая / dark:», указанную в комментарии.
*/
:root {
  --ddc-bg: #f6f8fb;                         /* body: bg-ink-50 */
  --ddc-shell: #eef6f2;                      /* .app-shell: color-mix(brand-50 60%, #fff), вычислено */
  --ddc-shell-glow-1: rgb(110 205 171 / 0.3);  /* пятно 1: brand-300 / 30% */
  --ddc-shell-glow-2: rgb(24 154 114 / 0.14);  /* пятно 2: brand-500 / 14% */
  --ddc-surface: #ffffff;                    /* .card: bg-white */
  --ddc-surface-muted: #f6f8fb;              /* bg-ink-50: вложенная панель, наведение строки */
  --ddc-surface-sunken: #eceff4;             /* bg-ink-100: дорожка сегментов, count-pill, скелетон */
  --ddc-footer: rgb(246 248 251 / 0.6);      /* подвал Modal: bg-ink-50/60 */
  --ddc-overlay: rgb(7 10 14 / 0.4);         /* фон под окном: bg-ink-950/40 */

  --ddc-text: #0f141a;                       /* body: text-ink-900 */
  --ddc-heading: #0f141a;                    /* text-ink-900 */
  --ddc-text-muted: #69727f;                 /* .text-muted: ink-500 */
  --ddc-label: #525a66;                      /* .label: ink-600 */
  --ddc-placeholder: #8b95a3;                /* placeholder:text-ink-400 */
  --ddc-icon-muted: #8b95a3;                 /* text-ink-400 */

  --ddc-border: rgb(236 239 244 / 0.8);      /* .card: border-ink-100/80 */
  --ddc-divider: #eceff4;                    /* divide-ink-100, border-ink-100 */
  --ddc-border-strong: #d8dee6;              /* .input, .btn-outline: border-ink-200 */

  --ddc-primary: #00805e;                    /* .btn-primary: bg-brand-600 */
  --ddc-primary-hover: #005a43;              /* hover:bg-brand-700 */
  --ddc-on-primary: #ffffff;
  --ddc-accent-text: #005a43;                /* text-brand-700 */
  --ddc-selected-bg: #e3f0ea;                /* bg-brand-50: вкладка, пункт меню, строка */
  --ddc-selected-text: #005a43;              /* .tab[aria-selected]: text-brand-700 */
  --ddc-link: #00805e;                       /* .link: text-brand-600 */
  --ddc-link-hover: #005a43;                 /* hover:text-brand-700 */
  --ddc-ring: #189a72;                       /* :focus-visible: brand-500 */
  --ddc-accent: #00805e;                     /* accent-color: brand-600 */

  --ddc-ghost-text: #3f4651;                 /* .btn-ghost: text-ink-700 */
  --ddc-ghost-hover: #eceff4;                /* hover:bg-ink-100 */
  --ddc-outline-bg: #ffffff;                 /* .btn-outline: bg-white */
  --ddc-outline-hover: #f6f8fb;              /* hover:bg-ink-50 */
  --ddc-switch-off: #b6bfcb;                 /* .switch: bg-ink-300 */

  --ddc-danger: #e11d48;                     /* .btn-danger: bg-rose-600 */
  --ddc-danger-hover: #be123c;               /* hover:bg-rose-700 */
  --ddc-danger-text: #e11d48;                /* .text-error: rose-600 */
  --ddc-warning-text: #b45309;               /* text-amber-700 */
  --ddc-success-text: #047857;               /* text-emerald-700 */

  --ddc-scroll-thumb: rgb(0 128 94 / 0.45);  /* полоса прокрутки: brand-600 / 45% */
  --ddc-scroll-thumb-hover: #00805e;
  --ddc-scroll-thumb-ff: rgb(0 128 94 / 0.35);  /* Firefox: brand-600 / 35% */

  /* Тона (lib/tone.ts): подложка, текст, внутреннее кольцо бейджа. */
  --ddc-tone-neutral-bg: #eceff4;            /* bg-ink-100 */
  --ddc-tone-neutral-fg: #3f4651;            /* text-ink-700 */
  --ddc-tone-brand-bg: #e3f0ea;              /* bg-brand-50 */
  --ddc-tone-brand-fg: #005a43;              /* text-brand-700 */
  --ddc-tone-brand-ring: rgb(165 224 201 / 0.6);   /* ring-brand-200/60 */
  --ddc-tone-success-bg: #ecfdf5;            /* bg-emerald-50 */
  --ddc-tone-success-fg: #047857;            /* text-emerald-700 */
  --ddc-tone-success-ring: rgb(167 243 208 / 0.6); /* ring-emerald-200/60 */
  --ddc-tone-warning-bg: #fffbeb;            /* bg-amber-50 */
  --ddc-tone-warning-fg: #b45309;            /* text-amber-700 */
  --ddc-tone-warning-ring: rgb(253 230 138 / 0.6); /* ring-amber-200/60 */
  --ddc-tone-danger-bg: #fff1f2;             /* bg-rose-50 */
  --ddc-tone-danger-fg: #be123c;             /* text-rose-700 */
  --ddc-tone-danger-ring: rgb(254 205 211 / 0.6);  /* ring-rose-200/60 */
  --ddc-tone-info-bg: #f0f9ff;               /* bg-sky-50 */
  --ddc-tone-info-fg: #0369a1;               /* text-sky-700 */
  --ddc-tone-info-ring: rgb(186 230 253 / 0.6);    /* ring-sky-200/60 */
  --ddc-tone-ghost-fg: #69727f;              /* text-ink-500 */
  --ddc-tone-ghost-ring: rgb(216 222 230 / 0.6);   /* ring-ink-200/60 */

  /* Точки статусов (DESIGN-RULES, раздел 4). */
  --ddc-dot-neutral: #b6bfcb;                /* bg-ink-300 */
  --ddc-dot-info: #0ea5e9;                   /* bg-sky-500 */
  --ddc-dot-warning: #f59e0b;                /* bg-amber-500 */
  --ddc-dot-success: #10b981;                /* bg-emerald-500 */
  --ddc-dot-danger: #f43f5e;                 /* bg-rose-500 */

  /* Тень кнопок primary и danger: в тёмной теме её нет. */
  --ddc-btn-shadow: var(--shadow-card);
}

.dark {
  --ddc-bg: #070a0e;                         /* dark:bg-ink-950 */
  --ddc-shell: #070a0e;                      /* .dark .app-shell: ink-950 */
  --ddc-shell-glow-1: rgb(24 154 114 / 0.12);  /* brand-500 / 12% */
  --ddc-shell-glow-2: rgb(0 128 94 / 0.12);    /* brand-600 / 12% */
  --ddc-surface: #0f141a;                    /* dark:bg-ink-900 */
  --ddc-surface-muted: rgb(42 47 56 / 0.6);  /* dark:bg-ink-800/60 */
  --ddc-surface-sunken: #2a2f38;             /* dark:bg-ink-800 */
  --ddc-footer: rgb(7 10 14 / 0.4);          /* dark:bg-ink-950/40 */
  --ddc-overlay: rgb(7 10 14 / 0.4);

  --ddc-text: #eceff4;                       /* dark:text-ink-100 */
  --ddc-heading: #f6f8fb;                    /* dark:text-ink-50 */
  --ddc-text-muted: #8b95a3;                 /* dark:text-ink-400 */
  --ddc-label: #b6bfcb;                      /* dark:text-ink-300 */
  --ddc-placeholder: #8b95a3;                /* ink-400 в обеих темах */
  --ddc-icon-muted: #69727f;                 /* dark:text-ink-500 */

  --ddc-border: rgb(42 47 56 / 0.8);         /* dark:border-ink-800/80 */
  --ddc-divider: #2a2f38;                    /* dark:divide-ink-800 */
  --ddc-border-strong: #3f4651;              /* dark .input, .btn-outline: border-ink-700 */

  --ddc-primary: #00805e;                    /* кнопка не меняется */
  --ddc-primary-hover: #005a43;
  --ddc-on-primary: #ffffff;
  --ddc-accent-text: #6ecdab;                /* dark:text-brand-300 */
  --ddc-selected-bg: rgb(24 154 114 / 0.15); /* dark:bg-brand-500/15 */
  --ddc-selected-text: #6ecdab;              /* dark:text-brand-300 */
  --ddc-link: #6ecdab;                       /* dark:text-brand-300 */
  --ddc-link-hover: #a5e0c9;                 /* dark:hover:text-brand-200 */
  --ddc-ring: #3eb58c;                       /* brand-400 */
  --ddc-accent: #3eb58c;                     /* accent-color: brand-400 */

  --ddc-ghost-text: #d8dee6;                 /* :where(.dark) .btn-ghost: ink-200 */
  --ddc-ghost-hover: #2a2f38;                /* dark:hover:bg-ink-800 */
  --ddc-outline-bg: #0f141a;                 /* bg-ink-900 */
  --ddc-outline-hover: #2a2f38;              /* bg-ink-800 */
  --ddc-switch-off: #3f4651;                 /* dark:bg-ink-700 */

  --ddc-danger: #e11d48;
  --ddc-danger-hover: #be123c;
  --ddc-danger-text: #fb7185;                /* dark:text-rose-400 */
  --ddc-warning-text: #fbbf24;               /* dark:text-amber-400 */
  --ddc-success-text: #34d399;               /* dark:text-emerald-400 */

  --ddc-scroll-thumb: rgb(62 181 140 / 0.4); /* brand-400 / 40% */
  --ddc-scroll-thumb-hover: #3eb58c;
  --ddc-scroll-thumb-ff: rgb(62 181 140 / 0.3); /* Firefox: brand-400 / 30% */

  --ddc-tone-neutral-bg: #2a2f38;            /* dark:bg-ink-800 */
  --ddc-tone-neutral-fg: #d8dee6;            /* dark:text-ink-200 */
  --ddc-tone-brand-bg: rgb(24 154 114 / 0.15);     /* dark:bg-brand-500/15 */
  --ddc-tone-brand-fg: #a5e0c9;              /* dark:text-brand-200 */
  --ddc-tone-brand-ring: rgb(0 90 67 / 0.6);       /* dark:ring-brand-700/60 */
  --ddc-tone-success-bg: rgb(6 78 59 / 0.3);       /* dark:bg-emerald-900/30 */
  --ddc-tone-success-fg: #6ee7b7;            /* dark:text-emerald-300 */
  --ddc-tone-success-ring: rgb(4 120 87 / 0.6);    /* dark:ring-emerald-700/60 */
  --ddc-tone-warning-bg: rgb(120 53 15 / 0.3);     /* dark:bg-amber-900/30 */
  --ddc-tone-warning-fg: #fcd34d;            /* dark:text-amber-300 */
  --ddc-tone-warning-ring: rgb(180 83 9 / 0.6);    /* dark:ring-amber-700/60 */
  --ddc-tone-danger-bg: rgb(136 19 55 / 0.3);      /* dark:bg-rose-900/30 */
  --ddc-tone-danger-fg: #fda4af;             /* dark:text-rose-300 */
  --ddc-tone-danger-ring: rgb(190 18 60 / 0.6);    /* dark:ring-rose-700/60 */
  --ddc-tone-info-bg: rgb(12 74 110 / 0.3);        /* dark:bg-sky-900/30 */
  --ddc-tone-info-fg: #7dd3fc;               /* dark:text-sky-300 */
  --ddc-tone-info-ring: rgb(3 105 161 / 0.6);      /* dark:ring-sky-700/60 */
  --ddc-tone-ghost-fg: #8b95a3;              /* dark:text-ink-400 */
  --ddc-tone-ghost-ring: rgb(63 70 81 / 0.6);      /* dark:ring-ink-700/60 */

  --ddc-dot-neutral: #525a66;                /* dark:bg-ink-600 */

  --ddc-btn-shadow: none;                    /* dark:shadow-none */
}

/* Утилиты из смысловых переменных: bg-ddc-surface, text-ddc-text-muted и т. д. */
@theme inline {
  --color-ddc-bg: var(--ddc-bg);
  --color-ddc-shell: var(--ddc-shell);
  --color-ddc-surface: var(--ddc-surface);
  --color-ddc-surface-muted: var(--ddc-surface-muted);
  --color-ddc-surface-sunken: var(--ddc-surface-sunken);
  --color-ddc-footer: var(--ddc-footer);
  --color-ddc-overlay: var(--ddc-overlay);
  --color-ddc-text: var(--ddc-text);
  --color-ddc-heading: var(--ddc-heading);
  --color-ddc-text-muted: var(--ddc-text-muted);
  --color-ddc-label: var(--ddc-label);
  --color-ddc-placeholder: var(--ddc-placeholder);
  --color-ddc-icon-muted: var(--ddc-icon-muted);
  --color-ddc-border: var(--ddc-border);
  --color-ddc-divider: var(--ddc-divider);
  --color-ddc-border-strong: var(--ddc-border-strong);
  --color-ddc-primary: var(--ddc-primary);
  --color-ddc-primary-hover: var(--ddc-primary-hover);
  --color-ddc-on-primary: var(--ddc-on-primary);
  --color-ddc-accent-text: var(--ddc-accent-text);
  --color-ddc-selected-bg: var(--ddc-selected-bg);
  --color-ddc-selected-text: var(--ddc-selected-text);
  --color-ddc-link: var(--ddc-link);
  --color-ddc-link-hover: var(--ddc-link-hover);
  --color-ddc-ring: var(--ddc-ring);
  --color-ddc-ghost-text: var(--ddc-ghost-text);
  --color-ddc-ghost-hover: var(--ddc-ghost-hover);
  --color-ddc-outline-bg: var(--ddc-outline-bg);
  --color-ddc-outline-hover: var(--ddc-outline-hover);
  --color-ddc-switch-off: var(--ddc-switch-off);
  --color-ddc-danger: var(--ddc-danger);
  --color-ddc-danger-hover: var(--ddc-danger-hover);
  --color-ddc-danger-text: var(--ddc-danger-text);
  --color-ddc-warning-text: var(--ddc-warning-text);
  --color-ddc-success-text: var(--ddc-success-text);
  --color-ddc-tone-neutral-bg: var(--ddc-tone-neutral-bg);
  --color-ddc-tone-neutral-fg: var(--ddc-tone-neutral-fg);
  --color-ddc-tone-brand-bg: var(--ddc-tone-brand-bg);
  --color-ddc-tone-brand-fg: var(--ddc-tone-brand-fg);
  --color-ddc-tone-brand-ring: var(--ddc-tone-brand-ring);
  --color-ddc-tone-success-bg: var(--ddc-tone-success-bg);
  --color-ddc-tone-success-fg: var(--ddc-tone-success-fg);
  --color-ddc-tone-success-ring: var(--ddc-tone-success-ring);
  --color-ddc-tone-warning-bg: var(--ddc-tone-warning-bg);
  --color-ddc-tone-warning-fg: var(--ddc-tone-warning-fg);
  --color-ddc-tone-warning-ring: var(--ddc-tone-warning-ring);
  --color-ddc-tone-danger-bg: var(--ddc-tone-danger-bg);
  --color-ddc-tone-danger-fg: var(--ddc-tone-danger-fg);
  --color-ddc-tone-danger-ring: var(--ddc-tone-danger-ring);
  --color-ddc-tone-info-bg: var(--ddc-tone-info-bg);
  --color-ddc-tone-info-fg: var(--ddc-tone-info-fg);
  --color-ddc-tone-info-ring: var(--ddc-tone-info-ring);
  --color-ddc-tone-ghost-fg: var(--ddc-tone-ghost-fg);
  --color-ddc-tone-ghost-ring: var(--ddc-tone-ghost-ring);
  --color-ddc-dot-neutral: var(--ddc-dot-neutral);
  --color-ddc-dot-info: var(--ddc-dot-info);
  --color-ddc-dot-warning: var(--ddc-dot-warning);
  --color-ddc-dot-success: var(--ddc-dot-success);
  --color-ddc-dot-danger: var(--ddc-dot-danger);
  --shadow-ddc-btn: var(--ddc-btn-shadow);
}

/* База портала (index.css, @layer base), переписанная на переменные. */
@layer base {
  html {
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    color-scheme: light;
    accent-color: var(--ddc-accent);
  }
  html.dark {
    color-scheme: dark;
  }
  body {
    min-height: 100vh;
    background-color: var(--ddc-bg);
    color: var(--ddc-text);
  }

  /* В Tailwind v4 у кнопок курсор по умолчанию, в v3 (на нём портал) был pointer. */
  button:not(:disabled),
  [role="button"]:not(:disabled) {
    cursor: pointer;
  }

  /* Одно кольцо фокуса на всё приложение: 2px, отступ 2px, цвет бренда. */
  :focus-visible {
    outline: 2px solid var(--ddc-ring);
    outline-offset: 2px;
  }

  /* Нативные чекбокс и радио: 16px, не сжимаются, цвет даёт accent-color. */
  :where(input[type="checkbox"], input[type="radio"]) {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    cursor: pointer;
  }
  :where(input[type="checkbox"], input[type="radio"]):disabled {
    cursor: not-allowed;
  }

  /* Полоса прокрутки 6px, ползунок виден только при наведении на область. */
  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background-color: transparent;
    border-radius: 9999px;
    transition: background-color 0.15s ease-out;
  }
  :hover::-webkit-scrollbar-thumb {
    background-color: var(--ddc-scroll-thumb);
  }
  :hover::-webkit-scrollbar-thumb:hover {
    background-color: var(--ddc-scroll-thumb-hover);
  }
  @supports not selector(::-webkit-scrollbar) {
    * {
      scrollbar-width: thin;
      scrollbar-color: var(--ddc-scroll-thumb-ff) transparent;
    }
  }
}

/* Фон оболочки приложения: светлый зелёный с двумя радиальными пятнами, в тёмной теме почти чёрный. */
@utility ddc-app-shell {
  background-color: var(--ddc-shell);
  background-image:
    radial-gradient(1100px 560px at 8% -12%, var(--ddc-shell-glow-1), transparent 62%),
    radial-gradient(900px 520px at 100% 0%, var(--ddc-shell-glow-2), transparent 60%);
}
```

## 7. Что проверено и что нет

Проверено чтением файлов и командами:

- Все классы раздела 3 выписаны из `index.css` и названных компонентов.
- Hex шкал `brand` и `ink` из `tailwind.config.js`, статусных шкал из Tailwind 3.4.19 портала.
- Контраст и смешанные цвета (`#EEF6F2`, `#102827`) посчитаны скриптом.
- Файл токенов собран Tailwind 4.2.2.
- Отсутствие `btn-secondary` в `index.css` и в `client/dist`.

Не проверено:

- Вид портала в браузере, скриншоты, работа на 390px.
- Свежесть `client/dist` относительно исходников.
- Где используются `brand-900`, `brand-950` и `shadow-soft`, кроме названных мест.
- Как выглядит кнопка `LoadError` с несуществующим классом.
- Вид `ddc-tokens.css` в живом приложении: файл нигде не подключён.
- Корпоративный стандарт, из которого взяты ступени `brand`: его нет в репозитории.
