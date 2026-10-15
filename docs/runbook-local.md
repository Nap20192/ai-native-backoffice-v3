# Локальный запуск OpenMA (platform/)

Рецепт проверен 2026-10-15 на этой машине. Сервер работает как процесс node на хосте.
База данных Postgres работает в одном контейнере. Сборка docker-образа не нужна.

## Что получится

| Что | Где |
|---|---|
| API и консоль | http://localhost:8787 (сервер слушает только 127.0.0.1) |
| Postgres | контейнер `oma-dev-pg`, порт 127.0.0.1:55432, база/пользователь/пароль `oma` |
| Песочница агента | LiteBox (BoxLite, микро-VM через /dev/kvm), `SANDBOX_PROVIDER=litebox` |
| Лог сервера | `platform/apps/main-node/data/main-node.log` |
| Данные сервера | `platform/apps/main-node/data/` (memory-blobs, files-blobs, session-outputs, sandboxes) |
| Кэш BoxLite | `~/.boxlite` (рантайм и скачанные образы) |

## 0. Окружение

```sh
eval "$(fnm env)"; fnm use 24
cd /home/vnkjd/orca/projects/ai-native-backoffice-v3/platform
pnpm install            # один раз
```

Ноутбук греется. Перед тяжёлыми шагами смотреть `cat /proc/loadavg` и
`sensors | grep 'Package id 0'`. Тяжёлые команды запускать через `nice -n 15`.

## 1. Собрать консоль (один раз и после правок консоли)

```sh
nice -n 15 pnpm --filter managed-agents-console build
# результат: apps/console/dist (сервер раздаёт его через CONSOLE_DIR)
```

## 2. Файл platform/.env

Файл уже создан и не попадает в git. Если его нет, создать заново:

```sh
cp .env.example .env
# вписать BETTER_AUTH_SECRET=$(openssl rand -hex 32)
# вписать PLATFORM_ROOT_SECRET=$(openssl rand -base64 32)
# строку ANTHROPIC_API_KEY=sk-... закомментировать или вписать настоящий ключ
```

И дописать в конец:

```sh
HOST=127.0.0.1
PORT=8787
PUBLIC_BASE_URL=http://localhost:8787
DATABASE_URL=postgres://oma:oma@127.0.0.1:55432/oma
SANDBOX_PROVIDER=litebox
SANDBOX_IMAGE=node:22-bookworm
CONSOLE_DIR=../console/dist
```

Важно:

- Пустая строка `ANTHROPIC_API_KEY=` ломает старт: сервер падает с
  `Anthropic API key is required for Dream curation`. Без ключа строку надо
  закомментировать (так сделано сейчас). Тогда сервер сам берёт
  дедуплицирующий куратор (`apps/main-node/src/modules/node-managed.ts`, около строки 905).
- Проверить, что ключ задан, не печатая его: `grep -c '^ANTHROPIC_API_KEY=.' .env`.
- Пути в `.env` относительные. Они считаются от `apps/main-node`, потому что
  `pnpm --filter ... start` запускает процесс оттуда.

## 3. Поднять Postgres

```sh
# первый раз
docker run -d --name oma-dev-pg \
  -e POSTGRES_USER=oma -e POSTGRES_PASSWORD=oma -e POSTGRES_DB=oma \
  -p 127.0.0.1:55432:5432 postgres:16
# следующие разы
docker start oma-dev-pg

docker exec oma-dev-pg pg_isready -U oma -d oma
```

Схема создаётся сама при старте сервера (миграции из `apps/main-node/migrations`).
В логе будут сообщения NOTICE от Postgres про `already exists, skipping` и
`will be truncated`. Это не ошибки.

## 4. Запустить сервер

```sh
cd apps/main-node
mkdir -p data
set -a; . ../../.env; set +a
nice -n 15 pnpm start > data/main-node.log 2>&1 &
```

Через 2-3 секунды:

```sh
curl -s http://127.0.0.1:8787/health
# {"status":"ok","runtime":"node",...,"auth":"better-auth-pg",
#  "backends":{"agents":"postgres",...,"db":"postgres 127.0.0.1:55432/oma"}}
```

Консоль: открыть http://localhost:8787 в браузере. Вход по почте и паролю
(регистрация в консоли). Без SMTP код подтверждения, если он нужен, печатается в
лог сервера (`apps/main-node/src/auth/config.ts`, строка 27). Вход через консоль
в этой проверке не делался.

### Вариант без входа (только для локальной проверки API)

```sh
set -a; . ../../.env; set +a
AUTH_DISABLED=1 nice -n 15 pnpm start > data/main-node.log 2>&1 &
```

Тогда все запросы идут от арендатора `default`, и `curl` работает без cookie.
В `.env` эту переменную не записывать.

## 5. Смоук (с AUTH_DISABLED=1)

Все маршруты `/v1/agents`, `/v1/environments`, `/v1/sessions` требуют заголовок
`anthropic-beta: managed-agents-2026-04-01`. Без него ответ 400.
Сессии нужен `environment_id`, поэтому сначала создаётся окружение.

```sh
B=http://127.0.0.1:8787
H='anthropic-beta: managed-agents-2026-04-01'

curl -s $B/health
curl -s -o /dev/null -w '%{http_code}\n' $B/          # 200, index.html консоли

AID=$(curl -s -X POST $B/v1/agents -H "$H" -H 'content-type: application/json' \
  -d '{"name":"smoke","model":"claude-sonnet-4-6","system":"Use bash to answer.","tools":[{"type":"agent_toolset_20260401"}]}' | jq -r .id)

EID=$(curl -s -X POST $B/v1/environments -H "$H" -H 'content-type: application/json' \
  -d '{"name":"local","config":{"type":"cloud","networking":{"type":"unrestricted"}}}' | jq -r .id)

SID=$(curl -s -X POST $B/v1/sessions -H "$H" -H 'content-type: application/json' \
  -d "{\"agent\":\"$AID\",\"environment_id\":\"$EID\"}" | jq -r .id)

# поток событий (в отдельном терминале)
curl -N -H "$H" $B/v1/sessions/$SID/events/stream

# сообщение агенту (нужен ANTHROPIC_API_KEY в .env)
curl -s -X POST $B/v1/sessions/$SID/events -H "$H" -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Run: uname -a"}]}]}'
```

При первом ходе LiteBox скачает образ `node:22-bookworm` в `~/.boxlite`.
Это несколько сотен мегабайт, первый ход будет долгим.

## 6. Логи

- Сервер: `tail -f apps/main-node/data/main-node.log` (JSON-строки pino).
  Уровень 50 означает ошибку.
- Postgres: `docker logs -f oma-dev-pg`.
- BoxLite: `~/.boxlite/logs`.

## 7. Остановить

```sh
# сервер: корректное завершение по SIGTERM
kill -TERM $(ss -ltnp | grep ':8787 ' | sed -E 's/.*pid=([0-9]+).*/\1/')
# база
docker stop oma-dev-pg
# удалить базу полностью (данные пропадут, тома нет)
docker rm oma-dev-pg
```

## Известные ограничения (проверено 2026-10-15)

1. **Postgres: фоновый захват исполнений падает.** В режиме Postgres сервер раз в
   секунду пишет ошибку `session_execution.claim` с
   `PostgresError 42P18: could not determine data type of parameter $1`.
   Два запуска: 74 ошибки за 74 секунды и 100 ошибок за 100 секунд.
   В режиме SQLite за 17 секунд ошибок 0.
   Причина, скорее всего, в запросе `selectCandidate` в
   `packages/session-runtime-sql/src/coordination.ts` (строки 476-478):
   конструкция `? IS NULL` без типа. Postgres не может вывести тип параметра.
   Код совпадает с исходным репозиторием (`diff -r` пустой), то есть это не
   ошибка копирования. Возможная правка (не сделана): `CAST(? AS TEXT) IS NULL`.
   Дойдёт ли из-за этого ход агента до модели в режиме Postgres, не проверено:
   нет ключа.
   Обход: запускать на SQLite. Для этого при старте задать `DATABASE_URL=`
   (пусто) и, по желанию, `DATABASE_PATH=./data/oma.db`.
2. **Ход агента не проверен.** В `.env` нет `ANTHROPIC_API_KEY`.
3. **LiteBox проверен отдельно.** Микро-VM из образа `alpine:3.20` поднялась за
   9 секунд и выполнила команду. Ядро внутри Linux 6.12.76, на хосте 6.18.55.
   Через сервер песочница не запускалась, потому что без ключа нет хода агента.
4. **Docker-сборка из этой копии не соберётся.** `apps/main-node/Dockerfile`
   копирует `.pnpm-approve-builds.json`, `apps/main`, `apps/main-fly`,
   `apps/integrations`, `apps/docs`. Их в `platform/` нет. `docker-compose*.yml`
   ссылаются на `apps/oma-vault`, его тоже нет. Сборка не запускалась.
5. **oma-vault не запускается.** Подстановка секретов в исходящие запросы
   песочницы (`OMA_VAULT_PROXY_URL`) недоступна, приложение `apps/oma-vault`
   не скопировано.
