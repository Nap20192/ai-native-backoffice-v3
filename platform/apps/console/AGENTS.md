# Консоль: правила для агентов

Пути ниже от `platform/apps/console/`. Оформление по `docs/ddc-design-system.md` в корне репозитория: читать перед новой страницей или новым компонентом.

## Запуск и тесты

- Dev-сервер проксирует API на `VITE_API_TARGET`, по умолчанию 8787. Для пробной копии владельца нужен `VITE_API_TARGET=http://localhost:8788`.
- Один тест: `pnpm vitest run src/pages/SkillsList.delete.test.tsx`. Typecheck консоли проверяет и `packages/sdk/src`.

## API

- `/v1/*` через `useManagedApi()` (`src/lib/managed-api.ts`). Клиент сам ставит `anthropic-beta` и `If-Match`. Точные URL и тела держит `src/lib/managed-api.contract.test.ts`: новый метод клиента получает строку в этом тесте.
- `/v1/oma/*` и прочее через `useApi()` (`src/lib/api.ts`). Он ставит cookie, `anthropic-beta` и `x-active-tenant`.
- Списки через `src/lib/useApiQuery.ts`. У каждого семейства свой курсор: Managed `page` (`useInfiniteApiQuery`), файлы `before_id` (`useFilesInfiniteApiQuery`), OMA `cursor` (`useOmaInfiniteApiQuery`).

## Ошибки

- Пользователь видит русский текст из `localizeApiError` (`src/lib/api.ts`), английский текст сервера уходит в `console.error`.
- Страница, которая сама рисует `LoadError`, зовёт `api(path, { quiet: true })`, чтобы тост не дублировал ошибку. `useApiQuery` флаг `quiet` не передаёт.

## Компоненты

Страница собирается из готовых частей:

- контролы из `@/components/ui/*` (`src/lib/mature-components.contract.test.ts` валит тест на нативных `<button>`, `<input>`, `<table>` вне `components/ui`);
- подтверждение: `ConfirmDialog`; архив и удаление: `DangerDialog`, он сам читает зависимости, показывает 409 и шлёт `If-Match`;
- пустой список: `EmptyState` после первой загрузки, скелетон во время загрузки; ошибка загрузки: `LoadError`;
- кнопка мутации: `useAsyncAction` (`src/hooks/`) гасит повторный клик;
- иконки: lucide-react, общий набор `src/components/nav-icons.ts`;
- цвета: токены `brand`, `ink` и пять тонов статуса, у каждого светлого класса пара `dark:`;
- даты: `src/lib/date-format.ts` (`dd.MM.yyyy HH:mm`), относительное время по-русски `src/pages/ru-format.ts`; пустое значение `–` (U+2013);
- кнопка без текста: `aria-label` и `title` по-русски.

## Тексты

- Консоль только русская, словарь один: `src/i18n/ru.ts`. Ключ добавляется в `src/i18n/types.ts` и в `ru.ts` одной правкой, иначе падает typecheck.
- Многие русские строки записаны прямо в компонентах. Новый текст следует соседнему коду.

## Тесты

Образец: `src/pages/SkillsList.delete.test.tsx`. Тест лежит рядом с кодом, суффикс по теме (`.crud.test.tsx`, `.archive.test.tsx`).

- `describe`, `it`, `expect` импортируются из `vitest`.
- Каждый запрос теста получает обработчик MSW через `server.use(http.get(...))`: запрос без обработчика валит тест.
- `ResizeObserver` и `scrollIntoView` заглушаются в тесте, как в образце.
- В тестах работает только алиас `@`.

## Доказательство

Правка страницы доказывается снимком работающей страницы на ширине 1280 и 390.
