#!/usr/bin/env bash
# Поднимает изолированный экземпляр конструктора агентов для проверки:
#   1) пустая папка данных прогона ($VERIFY_STATE_ROOT/runs/<RUN_ID>);
#   2) сборка консоли в эту папку (apps/console/dist не трогается);
#   3) фейковая модель на $VERIFY_FAKE_PORT (режим fake);
#   4) main-node на SQLite на $VERIFY_PORT с CONSOLE_DIR из п. 2;
#   5) ожидание готовности: /health, /auth-info, GET /, миграции, строка listening.
# Использование: RUN="$(scripts/launch.sh)"   (stdout — только папка прогона, всё остальное в stderr)
# Код 0: экземпляр готов, на stdout одна строка — папка прогона для --run / VERIFY_RUN_DIR.
# Код 1: экземпляр не готов; всё, что этот вызов успел запустить, он сам останавливает
#   (scripts/cleanup.sh для своей папки) и пишет «ПРЕРВАН на шаге launch» в summary.md.
# Переменные: VERIFY_PORT (8791), VERIFY_FAKE_PORT (8792), VERIFY_MODEL_MODE (fake|real),
#   VERIFY_LITEBOX_DISK_SIZE_GB / VERIFY_LITEBOX_MEMORY_MIB (диск и память VM, по умолчанию как в BoxLite),
#   VERIFY_CONSOLE_DIR (готовая сборка консоли, тогда сборка пропускается), VERIFY_RUN_ID.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

vac_require_tools curl jq ss sqlite3 openssl sha256sum awk sed
vac_node24

vac_guard_port_value "$VERIFY_PORT"
vac_guard_port_value "$VERIFY_FAKE_PORT"
[ "$VERIFY_PORT" != "$VERIFY_FAKE_PORT" ] || vac_die "VERIFY_PORT и VERIFY_FAKE_PORT совпадают"
vac_port_busy "$VERIFY_PORT" && vac_die "порт $VERIFY_PORT уже занят: чужой экземпляр не ведём (scripts/doctor.sh покажет, чей)"
MODE="$(vac_model_mode)"
[ "$MODE" = fake ] && vac_port_busy "$VERIFY_FAKE_PORT" && vac_die "порт $VERIFY_FAKE_PORT уже занят"

# Один прогон за раз: кэш BoxLite допускает только один рантайм на папку.
# Проверяются все прогоны в runs/, а не «последний»: чужой прогон этот скрипт не трогает.
LIVE_RUNS="$(vac_live_runs | tr '\n' ' ')"
[ -z "${LIVE_RUNS// /}" ] || vac_die "ещё жив прогон: $LIVE_RUNS; если он ваш, остановите его: VERIFY_RUN_DIR=<папка> scripts/cleanup.sh; чужой не трогайте"

[ -r /dev/kvm ] && [ -w /dev/kvm ] || vac_die "/dev/kvm недоступен на чтение и запись: LiteBox не запустит VM"
[ -x "$MAIN_NODE_DIR/node_modules/.bin/tsx" ] || vac_die "нет $MAIN_NODE_DIR/node_modules/.bin/tsx: зависимости platform не установлены"
[ -x "$CONSOLE_SRC_DIR/node_modules/.bin/vite" ] || vac_die "нет vite в apps/console/node_modules"

RUN_ID="${VERIFY_RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
RUN_DIR="$VERIFY_STATE_ROOT/runs/$RUN_ID"
EVIDENCE_DIR="$VERIFY_EVIDENCE_ROOT/$RUN_ID"
[ -e "$RUN_DIR" ] && vac_die "папка прогона уже есть: $RUN_DIR"
DATA_DIR="$RUN_DIR/data"
mkdir -p "$DATA_DIR" "$RUN_DIR/logs" "$RUN_DIR/state" "$VERIFY_BOXLITE_HOME" "$VERIFY_SERVER_HOME"
chmod 700 "$RUN_DIR/state"
touch "$RUN_DIR/$VAC_RUN_MARKER"
mkdir -p "$EVIDENCE_DIR"/{screens,aria,api,logs}
[ -z "$(ls -A "$DATA_DIR")" ] || vac_die "папка данных не пустая: $DATA_DIR"

# С этого места папка прогона есть: при любом сбое останавливаем только своё
# (cleanup.sh с явной папкой этого прогона) и отмечаем «ПРЕРВАН» в summary.md.
LAUNCH_OK=0
on_exit() {
  local rc=$?
  [ "$LAUNCH_OK" = 1 ] && return 0
  vac_abort_summary "$EVIDENCE_DIR" launch "${VAC_LAST_ERROR:-экземпляр не готов, см. logs/launch.txt} (код $rc)"
  vac_say "launch не удался: останавливаю процессы этого прогона ($RUN_DIR)"
  VERIFY_RUN_DIR="$RUN_DIR" "$VAC_SCRIPTS/cleanup.sh" >&2 || true
}
trap on_exit EXIT

LAUNCH_LOG="$EVIDENCE_DIR/logs/launch.txt"
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LAUNCH_LOG" >&2; }

CONSOLE_DIR="${VERIFY_CONSOLE_DIR:-$RUN_DIR/console}"
BASE_URL="http://$VERIFY_HOST:$VERIFY_PORT"
FAKE_URL="http://$VERIFY_HOST:$VERIFY_FAKE_PORT"
GIT_REV="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
# shellcheck disable=SC2086
CONSOLE_DIRTY="$( (git -C "$REPO_ROOT" status --porcelain -- $VAC_CONSOLE_PATHS 2>/dev/null || true) | wc -l | tr -d ' ')"
# shellcheck disable=SC2086
SERVER_DIRTY="$( (git -C "$REPO_ROOT" status --porcelain -- $VAC_SERVER_PATHS 2>/dev/null || true) | wc -l | tr -d ' ')"
# Хэши изменений рабочего дерева: doctor.sh сверяет их, чтобы не вести устаревшую сборку.
# shellcheck disable=SC2086
CONSOLE_TREE_HASH="$(vac_tree_hash $VAC_CONSOLE_PATHS)"
# shellcheck disable=SC2086
SERVER_TREE_HASH="$(vac_tree_hash $VAC_SERVER_PATHS)"
HOST_BOXLITE_LOGS_BEFORE="$( (cat "$HOME"/.boxlite/logs/* 2>/dev/null || true) | wc -c | tr -d ' ')"

case "$RUN_DIR$EVIDENCE_DIR$REPO_ROOT$CONSOLE_DIR$VERIFY_BOXLITE_HOME$VERIFY_SERVER_HOME" in
  *[[:space:]\"\'\$\`]*) vac_die "в путях есть пробелы или кавычки: run.env так не записать" ;;
esac
cat > "$RUN_DIR/run.env" <<EOF
RUN_ID=$RUN_ID
RUN_DIR=$RUN_DIR
RUN_STARTED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%S)
EVIDENCE_DIR=$EVIDENCE_DIR
REPO_ROOT=$REPO_ROOT
PLATFORM_DIR=$PLATFORM_DIR
BASE_URL=$BASE_URL
VERIFY_PORT=$VERIFY_PORT
FAKE_URL=$FAKE_URL
VERIFY_FAKE_PORT=$VERIFY_FAKE_PORT
SANDBOX_GATEWAY_BASE_URL=http://host.boxlite.internal:$VERIFY_PORT
MODEL_MODE=$MODE
AGENT_MODEL=$VERIFY_AGENT_MODEL
SANDBOX_IMAGE=$VERIFY_SANDBOX_IMAGE
LITEBOX_DISK_SIZE_GB=${VERIFY_LITEBOX_DISK_SIZE_GB:-}
LITEBOX_MEMORY_MIB=${VERIFY_LITEBOX_MEMORY_MIB:-}
DATA_DIR=$DATA_DIR
DB_PATH=$DATA_DIR/oma.db
AUTH_DB_PATH=$DATA_DIR/auth.db
MEMORY_BLOB_DIR=$DATA_DIR/memory-blobs
FILES_BLOB_DIR=$DATA_DIR/files-blobs
SANDBOX_WORKDIR=$DATA_DIR/sandboxes
SESSION_OUTPUTS_DIR=$DATA_DIR/session-outputs
CONSOLE_DIR=$CONSOLE_DIR
BOXLITE_HOME=$VERIFY_BOXLITE_HOME
SERVER_HOME=$VERIFY_SERVER_HOME
SERVER_LOG=$RUN_DIR/logs/main-node.log
FAKE_LOG=$RUN_DIR/logs/fake-model.log
FAKE_REQUESTS=$RUN_DIR/logs/fake-model-requests.jsonl
GIT_REV=$GIT_REV
CONSOLE_DIRTY_FILES=$CONSOLE_DIRTY
SERVER_DIRTY_FILES=$SERVER_DIRTY
CONSOLE_TREE_HASH=$CONSOLE_TREE_HASH
SERVER_TREE_HASH=$SERVER_TREE_HASH
HOST_BOXLITE_LOGS_BEFORE=$HOST_BOXLITE_LOGS_BEFORE
EOF
# Тестовые секреты этого прогона: только для одноразовой базы, в лог не попадают.
umask 077
{
  printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
  printf 'PLATFORM_ROOT_SECRET=%s\n' "$(openssl rand -base64 32)"
} > "$RUN_DIR/state/secrets.env"
umask 022

log "прогон $RUN_ID, режим модели: $MODE, git $GIT_REV (изменённых файлов: консоль $CONSOLE_DIRTY, сервер $SERVER_DIRTY; хэши изменений: консоль $CONSOLE_TREE_HASH, сервер $SERVER_TREE_HASH)"
log "данные: $DATA_DIR"
log "доказательства: $EVIDENCE_DIR"

# --- 1. Консоль ---------------------------------------------------------------
if [ -n "${VERIFY_CONSOLE_DIR:-}" ]; then
  [ -f "$CONSOLE_DIR/index.html" ] || vac_die "VERIFY_CONSOLE_DIR=$CONSOLE_DIR без index.html"
  log "консоль: готовая сборка $CONSOLE_DIR (сборка пропущена)"
else
  vac_wait_cool
  log "сборка консоли в $CONSOLE_DIR"
  ( cd "$CONSOLE_SRC_DIR" && nice -n 15 ./node_modules/.bin/vite build --outDir "$CONSOLE_DIR" --emptyOutDir ) \
    > "$RUN_DIR/logs/console-build.log" 2>&1 || { tail -30 "$RUN_DIR/logs/console-build.log" >&2; vac_die "сборка консоли упала"; }
  cp "$RUN_DIR/logs/console-build.log" "$EVIDENCE_DIR/logs/console-build.log"
  [ -f "$CONSOLE_DIR/index.html" ] || vac_die "после сборки нет $CONSOLE_DIR/index.html"
fi

# --- 2. Фейковая модель ------------------------------------------------------------
if [ "$MODE" = fake ]; then
  ( exec nice -n 15 "$VAC_NODE_BIN" "$VAC_SCRIPTS/fake-model.mjs" \
      --port "$VERIFY_FAKE_PORT" --log "$RUN_DIR/logs/fake-model-requests.jsonl" \
      --canary-file "$RUN_DIR/state/canaries.json" --oracle-file "$RUN_DIR/state/oracle.json" ) \
    > "$RUN_DIR/logs/fake-model.log" 2>&1 < /dev/null &
  vac_record_pid fake-model "$!"
  for _ in $(seq 1 50); do curl -fsS "$FAKE_URL/health" >/dev/null 2>&1 && break; sleep 0.2; done
  curl -fsS "$FAKE_URL/health" >/dev/null || { cat "$RUN_DIR/logs/fake-model.log" >&2; vac_die "фейковая модель не ответила"; }
  log "фейковая модель: $FAKE_URL"
fi

# --- 3. Сервер ---------------------------------------------------------------------
vac_wait_cool
start_server() {
  local real_key="" real_base=""
  if [ "$MODE" = real ]; then
    # Режим real не проверялся. Из platform/.env берутся только две переменные,
    # без source: значения не печатаются и остаются в окружении сервера.
    # Это исключение из правила «.env не читать», его согласует владелец.
    real_key="$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$PLATFORM_DIR/.env" | tail -1)"
    real_base="$(sed -n 's/^ANTHROPIC_BASE_URL=//p' "$PLATFORM_DIR/.env" | tail -1)"
    real_key="${real_key%\"}"; real_key="${real_key#\"}"; real_key="${real_key%\'}"; real_key="${real_key#\'}"
    real_base="${real_base%\"}"; real_base="${real_base#\"}"; real_base="${real_base%\'}"; real_base="${real_base#\'}"
  fi
  # Значения VERIFY_* копируются до очистки окружения: если их передали снаружи
  # (VERIFY_PORT=8795 launch.sh), они экспортированы и цикл ниже их снимет.
  # Размер VM нужен сценарию Claude Code: agent CLI из npm весит ~330 МБ, а свободно в образе ~120 МБ.
  local disk_gb="${VERIFY_LITEBOX_DISK_SIZE_GB:-}" memory_mib="${VERIFY_LITEBOX_MEMORY_MIB:-}"
  local port="$VERIFY_PORT" host="$VERIFY_HOST" image="$VERIFY_SANDBOX_IMAGE"
  local server_home="$VERIFY_SERVER_HOME" boxlite_home="$VERIFY_BOXLITE_HOME"
  # Чистое окружение: из оболочки остаются только PATH и локаль.
  local v
  for v in $(compgen -e); do
    case "$v" in PATH|LANG|LC_ALL|LC_CTYPE|TERM|USER|LOGNAME|SHELL) ;; *) unset "$v" 2>/dev/null || true ;; esac
  done
  set -a; . "$RUN_DIR/state/secrets.env"; set +a
  export HOME="$server_home" BOXLITE_HOME="$boxlite_home"
  export HOST="$host" PORT="$port" PUBLIC_BASE_URL="$BASE_URL"
  # Адрес сервера для ACP-агентов в VM (прокси модели): 127.0.0.1 из VM ведёт в саму VM,
  # а host.boxlite.internal gvproxy BoxLite пересылает на 127.0.0.1 хоста.
  export SANDBOX_GATEWAY_BASE_URL="http://host.boxlite.internal:$port"
  export DATABASE_PATH="$DATA_DIR/oma.db" AUTH_DATABASE_PATH="$DATA_DIR/auth.db"
  export MEMORY_BLOB_DIR="$DATA_DIR/memory-blobs" FILES_BLOB_DIR="$DATA_DIR/files-blobs"
  export SANDBOX_WORKDIR="$DATA_DIR/sandboxes" SESSION_OUTPUTS_DIR="$DATA_DIR/session-outputs"
  export CONSOLE_DIR="$CONSOLE_DIR" SANDBOX_PROVIDER=litebox SANDBOX_IMAGE="$image"
  export DREAM_CURATOR_MODE=dedup LOG_LEVEL=info
  [ -n "$disk_gb" ] && export LITEBOX_DISK_SIZE_GB="$disk_gb"
  [ -n "$memory_mib" ] && export LITEBOX_MEMORY_MIB="$memory_mib"
  if [ "$MODE" = fake ]; then
    export ANTHROPIC_API_KEY=verify-local-fake-key ANTHROPIC_BASE_URL="$FAKE_URL"
  else
    export ANTHROPIC_API_KEY="$real_key"
    [ -n "$real_base" ] && export ANTHROPIC_BASE_URL="$real_base"
  fi
  cd "$MAIN_NODE_DIR"
  exec nice -n 15 ./node_modules/.bin/tsx src/index.ts
}
( start_server ) > "$RUN_DIR/logs/main-node.log" 2>&1 < /dev/null &
SERVER_PID=$!
vac_record_pid server-tsx "$SERVER_PID"
log "сервер запущен: tsx pid $SERVER_PID, лог $RUN_DIR/logs/main-node.log"

deadline=$(( $(date +%s) + VERIFY_START_TIMEOUT_S ))
until curl -fsS "$BASE_URL/health" > "$RUN_DIR/state/health.json" 2>/dev/null; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    tail -40 "$RUN_DIR/logs/main-node.log" >&2
    vac_die "сервер завершился при старте"
  fi
  [ "$(date +%s)" -lt "$deadline" ] || { tail -40 "$RUN_DIR/logs/main-node.log" >&2; vac_die "нет /health за ${VERIFY_START_TIMEOUT_S} с"; }
  sleep 1
done
# Фоновое восстановление может идти после первого /health (test/crash-recovery.test.ts).
sleep 0.5

# --- 4. Признаки «можно работать» ---------------------------------------------------
H="$RUN_DIR/state/health.json"
cp "$H" "$EVIDENCE_DIR/api/00-health.json"
fail=0
expect() { # $1 описание, $2 фактическое, $3 ожидаемое
  if [ "$2" = "$3" ]; then log "OK   $1: $2"; else log "FAIL $1: $2 (ожидалось $3)"; fail=1; fi
}
expect "health.status" "$(jq -r .status "$H")" "ok"
expect "health.backends.db" "$(jq -r .backends.db "$H")" "sqlite $DATA_DIR/oma.db"
expect "health.auth" "$(jq -r .auth "$H")" "better-auth-sqlite"
expect "health.backends.memory_blobs" "$(jq -r .backends.memory_blobs "$H")" "localfs $DATA_DIR/memory-blobs"
expect "health.backends.files_blobs" "$(jq -r .backends.files_blobs "$H")" "localfs $DATA_DIR/files-blobs"
curl -fsS "$BASE_URL/auth-info" > "$EVIDENCE_DIR/api/00-auth-info.json" || echo "{}" > "$EVIDENCE_DIR/api/00-auth-info.json"
expect "auth-info.email_password" "$(jq -r .email_password "$EVIDENCE_DIR/api/00-auth-info.json")" "true"
ROOT_CT="$(curl -sS -o "$RUN_DIR/state/root.html" -w '%{http_code} %{content_type}' "$BASE_URL/" || echo "000 нет-ответа")"
expect "GET / код" "${ROOT_CT%% *}" "200"
case "$ROOT_CT" in *text/html*) log "OK   GET / тип: text/html" ;; *) log "FAIL GET / тип: $ROOT_CT"; fail=1 ;; esac
expect "GET / = index.html этой сборки" "$(sha256sum < "$RUN_DIR/state/root.html" | cut -d' ' -f1)" "$(sha256sum < "$CONSOLE_DIR/index.html" | cut -d' ' -f1)"
JOURNAL="$(jq '.entries | length' "$MAIN_NODE_DIR/migrations-sqlite/meta/_journal.json")"
expect "миграции SQLite применены" "$(sqlite3 -readonly "$DATA_DIR/oma.db" 'select count(*) from __drizzle_migrations' 2>/dev/null || echo нет)" "$JOURNAL"
grep -q '"op":"main-node.listening"' "$RUN_DIR/logs/main-node.log" \
  && log "OK   в логе есть op main-node.listening" || { log "FAIL в логе нет op main-node.listening"; fail=1; }
ERR50="$(grep -c '"level":50' "$RUN_DIR/logs/main-node.log" || true)"
expect "ошибок уровня 50 при старте" "$ERR50" "0"
log "предупреждений уровня 40 при старте: $(grep -c '"level":40' "$RUN_DIR/logs/main-node.log" || true)"

CHILD_PID="$(jq -r .pid "$H")"
expect "родитель pid из /health = наш tsx" "$(vac_ppid "$CHILD_PID")" "$SERVER_PID"
vac_record_pid server-node "$CHILD_PID"
case " $(vac_port_pids "$VERIFY_PORT" | tr '\n' ' ') " in
  *" $CHILD_PID "*) log "OK   порт $VERIFY_PORT слушает наш node $CHILD_PID" ;;
  *) log "FAIL порт $VERIFY_PORT слушает не наш процесс"; fail=1 ;;
esac

if [ "$fail" -ne 0 ]; then
  VAC_LAST_ERROR="экземпляр не готов: есть строки FAIL в logs/launch.txt"
  log "экземпляр не готов; процессы этого прогона останавливаются (cleanup.sh)"
  exit 1
fi
log "ГОТОВО: $BASE_URL (консоль и API), прогон $RUN_ID"
log "дальше: VERIFY_RUN_DIR=$RUN_DIR scripts/doctor.sh, затем seed-user.sh, journey.sh, cleanup.sh с той же папкой"
LAUNCH_OK=1
printf '%s\n' "$RUN_DIR"
