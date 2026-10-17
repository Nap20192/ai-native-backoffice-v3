#!/usr/bin/env bash
# Только чтение экземпляра: стоит ли вести этот прогон?
# Проверяет: процессы прогона живы и это те же PID; порт слушает наш node;
# /health смотрит в папку прогона; консоль = сборка прогона; код не менялся после
# сборки (HEAD и хэши изменений консоли и сервера = значения из run.env); вход работает;
# фейковая модель и фейковый MCP-сервер отвечают; /dev/kvm; кэш BoxLite не занят чужим процессом;
# ошибки в логе; нагрузка. Экземпляр не меняет; вывод пишет в
# $EVIDENCE_DIR/logs/doctor-<время>.txt, а при FAIL без summary.md — «ПРЕРВАН на шаге doctor».
# Использование: scripts/doctor.sh --run <RUN_ID|папка>   (или VERIFY_RUN_DIR=<папка>)
# Код 0 = можно вести, 1 = нет.
set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
vac_parse_args "$@"

bad=0
DOC_LOG=""
out()  { printf '%s\n' "$*"; [ -n "$DOC_LOG" ] && printf '%s\n' "$*" >> "$DOC_LOG"; return 0; }
ok()   { out "OK    $*"; }
fail() { out "FAIL  $*"; bad=1; }
info() { out "INFO  $*"; }

if ! RUN_DIR="$(vac_resolve_run "${VAC_RUN_REF:-}")"; then
  fail "прогон не задан или не найден (${VAC_RUN_REF:-пусто}): --run <RUN_ID> или VERIFY_RUN_DIR=<папка>; живые прогоны: $(vac_live_runs | tr '\n' ' ')"
  exit 1
fi
# shellcheck disable=SC1091
. "$RUN_DIR/run.env"
mkdir -p "$EVIDENCE_DIR/logs"
DOC_LOG="$EVIDENCE_DIR/logs/doctor-$(date +%H%M%S).txt"
: > "$DOC_LOG"
info "прогон $RUN_ID, режим модели $MODEL_MODE; данные $DATA_DIR; доказательства $EVIDENCE_DIR"

for role in server-tsx server-node $( [ "$MODEL_MODE" = fake ] && echo fake-model ) ${FAKE_MCP_URL:+fake-mcp}; do
  read -r pid start <<<"$(vac_pid_of "$role")"
  if [ -n "${pid:-}" ] && vac_same_process "$pid" "$start"; then ok "$role pid $pid жив"; else fail "$role не запущен или PID сменился (${pid:-нет записи})"; fi
done

read -r node_pid _ <<<"$(vac_pid_of server-node)"
port_pids=" $(vac_port_pids "$VERIFY_PORT" | tr '\n' ' ')"
case "$port_pids " in
  *" ${node_pid:-x} "*) ok "порт $VERIFY_PORT слушает наш node $node_pid" ;;
  "  ") fail "порт $VERIFY_PORT никто не слушает" ;;
  *) fail "порт $VERIFY_PORT слушает чужой процесс:$port_pids" ;;
esac

if H="$(curl -fsS --max-time 5 "$BASE_URL/health" 2>/dev/null)"; then
  [ "$(jq -r .pid <<<"$H")" = "${node_pid:-x}" ] && ok "/health.pid = наш node" || fail "/health.pid $(jq -r .pid <<<"$H") не наш"
  [ "$(jq -r .backends.db <<<"$H")" = "sqlite $DB_PATH" ] && ok "база: sqlite $DB_PATH" || fail "база не та: $(jq -r .backends.db <<<"$H")"
  [ "$(jq -r .auth <<<"$H")" = "better-auth-sqlite" ] && ok "auth: better-auth-sqlite" || fail "auth: $(jq -r .auth <<<"$H")"
  [ "$(jq -r .backends.files_blobs <<<"$H")" = "localfs $FILES_BLOB_DIR" ] && ok "files_blobs в папке прогона" || fail "files_blobs: $(jq -r .backends.files_blobs <<<"$H")"
  info "uptime $(jq -r .uptime_s <<<"$H") с"
else
  fail "$BASE_URL/health не отвечает"
fi

[ "$(curl -fsS --max-time 5 "$BASE_URL/auth-info" 2>/dev/null | jq -r .email_password)" = "true" ] \
  && ok "вход по почте включён (/auth-info.email_password)" || fail "/auth-info без email_password:true"
if [ -f "$CONSOLE_DIR/index.html" ]; then
  served="$(curl -fsS --max-time 5 "$BASE_URL/" 2>/dev/null | sha256sum | cut -d' ' -f1)"
  [ "$served" = "$(sha256sum < "$CONSOLE_DIR/index.html" | cut -d' ' -f1)" ] \
    && ok "GET / отдаёт index.html сборки $CONSOLE_DIR" || fail "GET / отдаёт не ту консоль"
else
  fail "нет сборки консоли $CONSOLE_DIR/index.html"
fi

# Сервер запущен через tsx без watch, консоль собрана при launch: правки кода после
# launch в экземпляр не попали. Сверяем ревизию и хэши изменений с run.env.
head_now="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
# shellcheck disable=SC2086
console_now="$(vac_tree_hash $VAC_CONSOLE_PATHS)"
# shellcheck disable=SC2086
server_now="$(vac_tree_hash $VAC_SERVER_PATHS)"
[ "$head_now" = "$GIT_REV" ] && ok "git HEAD $head_now = ревизия при launch" \
  || fail "git HEAD сменился: при launch $GIT_REV, сейчас $head_now; экземпляр крутит прежний код, перезапустите прогон"
[ "$console_now" = "${CONSOLE_TREE_HASH:-нет}" ] && ok "изменения консоли те же, что при сборке (хэш $console_now, файлов $CONSOLE_DIRTY_FILES)" \
  || fail "код консоли менялся после сборки: хэш при launch ${CONSOLE_TREE_HASH:-нет}, сейчас $console_now"
[ "$server_now" = "${SERVER_TREE_HASH:-нет}" ] && ok "изменения сервера те же, что при запуске (хэш $server_now, файлов $SERVER_DIRTY_FILES)" \
  || fail "код сервера менялся после запуска: хэш при launch ${SERVER_TREE_HASH:-нет}, сейчас $server_now"

if [ -f "$RUN_DIR/state/cookies.txt" ] && [ -f "$RUN_DIR/state/test-user.json" ]; then
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -b "$RUN_DIR/state/cookies.txt" -H "origin: $BASE_URL" "$BASE_URL/v1/oma/me")"
  [ "$code" = 200 ] && ok "тестовая учётка $(jq -r .email "$RUN_DIR/state/test-user.json"): /v1/oma/me 200" || fail "cookie тестовой учётки не принят ($code)"
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -b "$RUN_DIR/state/cookies.txt" -H "origin: $BASE_URL" -H 'anthropic-beta: managed-agents-2026-04-01' "$BASE_URL/v1/agents")"
  [ "$code" = 200 ] && ok "GET /v1/agents с beta: 200" || fail "GET /v1/agents: $code"
else
  info "тестовой учётки ещё нет (scripts/seed-user.sh)"
fi

if [ "$MODEL_MODE" = fake ]; then
  F="$(curl -fsS --max-time 3 "$FAKE_URL/health" 2>/dev/null)" && ok "фейковая модель отвечает, запросов: $(jq -r .requests <<<"$F")" || fail "фейковая модель $FAKE_URL не отвечает"
else
  info "режим real: модель api.anthropic.com, ключ из platform/.env (значение не печатается)"
fi
# Прогоны до 2026-10-18 фейковый MCP-сервер не поднимали: в их run.env нет FAKE_MCP_URL.
if [ -n "${FAKE_MCP_URL:-}" ]; then
  M="$(curl -fsS --max-time 3 "$FAKE_MCP_URL/health" 2>/dev/null)" && ok "фейковый MCP-сервер отвечает, сообщений JSON-RPC: $(jq -r .requests <<<"$M")" || fail "фейковый MCP-сервер $FAKE_MCP_URL не отвечает"
fi

[ -r /dev/kvm ] && [ -w /dev/kvm ] && ok "/dev/kvm доступен" || fail "/dev/kvm недоступен"
lock="$BOXLITE_HOME/.lock"
holders=""
for fd in /proc/[0-9]*/fd/*; do
  [ "$(readlink "$fd" 2>/dev/null)" = "$lock" ] && holders+=" $(cut -d/ -f3 <<<"$fd")"
done
holders="$(tr ' ' '\n' <<<"$holders" | sort -u | tr '\n' ' ')"
if [ -z "${holders// /}" ]; then
  info "кэш BoxLite $BOXLITE_HOME не держит ни один процесс (VM ещё не запускались или уже остановлены)"
else
  ours=" ${node_pid:-x} $(vac_descendants "${node_pid:-1}" 2>/dev/null | tr '\n' ' ') "
  foreign=""
  for p in $holders; do case "$ours" in *" $p "*) ;; *) foreign+=" $p" ;; esac; done
  [ -z "$foreign" ] && ok "кэш BoxLite держат только наши процессы:$holders" || fail "кэш BoxLite держат чужие процессы:$foreign"
fi

if [ -f "$SERVER_LOG" ]; then
  e50="$(grep -c '"level":50' "$SERVER_LOG" || true)"; e40="$(grep -c '"level":40' "$SERVER_LOG" || true)"
  [ "$e50" = 0 ] && ok "в логе сервера нет ошибок уровня 50" || fail "в логе сервера ошибок уровня 50: $e50 (grep '\"level\":50' $SERVER_LOG)"
  info "предупреждений уровня 40: $e40"
fi
info "нагрузка: $(cut -d' ' -f1-3 /proc/loadavg), $(sensors 2>/dev/null | grep 'Package id 0' | awk '{print $4}')"
for p in $VAC_FORBIDDEN_PORTS; do [ "$p" = "$VERIFY_PORT" ] && fail "VERIFY_PORT совпадает с чужим портом $p"; done

info "вывод сохранён: $DOC_LOG"
if [ "$bad" = 0 ]; then
  out "ИТОГ: можно вести"
else
  out "ИТОГ: вести нельзя, см. FAIL"
  vac_abort_summary "$EVIDENCE_DIR" doctor "doctor.sh нашёл FAIL, см. $(basename "$DOC_LOG")"
fi
exit "$bad"
