#!/usr/bin/env bash
# Перезапускаемая проверка пути «агент конструктора -> oma bridge -> Claude Code ноутбука»
# на нашем Node-сервере. Рецепт и контекст: docs/runbook-claude-code-harness.md.
#
#   scripts/verify-claude-code-harness.sh [папка-доказательств]
#
# Что делает: поднимает сервер на 127.0.0.1:${OMA_VERIFY_PORT:-8795} с SQLite во временной
# папке (umask 077), заводит тестовую учётку, сохраняет ответы маршрутов моста, проверяет
# CLI и автотесты изоляции демона, затем останавливает свой сервер по PID и удаляет
# временную папку. Claude Code не запускает и лимит владельца не тратит.
#
# Код выхода: 0, если состояние совпало с описанным в рецепте; 1, если нет.
# Приёмка моста (ход агента в Claude Code) записывается отдельно строкой ACCEPTANCE.

set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLATFORM=$ROOT/platform
STAMP=$(date +%Y%m%d-%H%M%S)
EVID=${1:-$ROOT/.verify-evidence/claude-code-harness/$STAMP}
PORT=${OMA_VERIFY_PORT:-8795}
B=http://127.0.0.1:$PORT
BETA="anthropic-beta: managed-agents-2026-04-01"

mkdir -p "$EVID/http"
OUT=$EVID/verify.txt
: > "$OUT"
FAILS=0
T=$(mktemp -d /tmp/oma-bridge-verify-XXXXXX)
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM -- "-$SERVER_PID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
  fi
  rm -rf "$T"
}
trap cleanup EXIT

log() { printf '%s\n' "$*" | tee -a "$OUT"; }
expect_eq() { # имя ожидание факт
  if [ "$2" = "$3" ]; then log "OK   $1 => $3"; else log "FAIL $1 => ждали $2, получили $3"; FAILS=$((FAILS + 1)); fi
}
http() { # имя метод путь [доп. аргументы curl]; печатает код, тело кладёт в доказательства
  local name=$1 method=$2 path=$3; shift 3
  curl -s -o "$EVID/http/$name.body" -w '%{http_code}' -X "$method" -b "$T/cj" -H "$BETA" "$@" "$B$path" || echo "000"
}

log "# verify-claude-code-harness $(date -Iseconds)"
log "repo: $(git -C "$ROOT" rev-parse --short HEAD) (рабочее дерево с незакоммиченными правками: $(git -C "$ROOT" status --short | wc -l) путей)"

if ss -ltnH "sport = :$PORT" | grep -q .; then
  log "FAIL порт $PORT занят, сервер не запускался"; exit 1
fi

eval "$(fnm env)" >/dev/null; fnm use 24 >/dev/null
log "node: $(node --version)"

log "## 1. Сервер (127.0.0.1:$PORT, SQLite в $T)"
(
  cd "$PLATFORM/apps/main-node"
  exec setsid env -u DATABASE_URL -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN \
    HOST=127.0.0.1 PORT="$PORT" PUBLIC_BASE_URL="$B" \
    DATABASE_PATH="$T/oma.db" AUTH_DATABASE_PATH="$T/auth.db" \
    MEMORY_BLOB_DIR="$T/memory-blobs" FILES_BLOB_DIR="$T/files-blobs" \
    SANDBOX_WORKDIR="$T/sandboxes" SESSION_OUTPUTS_DIR="$T/session-outputs" \
    SANDBOX_PROVIDER=litebox BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
    nice -n 15 ./node_modules/.bin/tsx src/index.ts > "$T/server.log" 2>&1
) &
SERVER_PID=$!
health=000
for _ in $(seq 1 60); do
  health=$(curl -s -o /dev/null -w '%{http_code}' "$B/health" || true)
  [ "$health" = "200" ] && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done
expect_eq "GET /health" 200 "$health"
if [ "$health" != "200" ]; then
  log "сервер не поднялся; хвост журнала:"; tail -n 20 "$T/server.log" | tee -a "$OUT"; exit 1
fi

PW=$(openssl rand -hex 12)
EMAIL="bridge-verify-$STAMP@example.test"
su=$(curl -s -o /dev/null -w '%{http_code}' -c "$T/cj" -X POST "$B/auth/sign-up/email" -H "origin: $B" \
  -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"name\":\"bridge verify\"}")
si=$(curl -s -o /dev/null -w '%{http_code}' -b "$T/cj" -c "$T/cj" -X POST "$B/auth/sign-in/email" -H "origin: $B" \
  -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
expect_eq "POST /auth/sign-up/email" 200 "$su"
expect_eq "POST /auth/sign-in/email" 200 "$si"

log "## 2. Маршруты моста (тела ответов: http/*.body)"
expect_eq "GET /v1/oma/runtimes" 200 "$(http runtimes-list GET /v1/oma/runtimes)"
log "     тело: $(head -c 200 "$EVID/http/runtimes-list.body")"
expect_eq "POST /v1/oma/runtimes/connect-runtime" 404 \
  "$(http connect-runtime POST /v1/oma/runtimes/connect-runtime -H "origin: $B" -H 'content-type: application/json' -d '{}')"
log "     тело: $(head -c 200 "$EVID/http/connect-runtime.body")"
expect_eq "POST /agents/runtime/exchange" 404 \
  "$(http runtime-exchange POST /agents/runtime/exchange -H 'content-type: application/json' -d '{}')"
log "     тело: $(head -c 200 "$EVID/http/runtime-exchange.body")"
expect_eq "GET /agents/runtime/_attach (Upgrade websocket)" 404 \
  "$(http runtime-attach GET /agents/runtime/_attach -H 'connection: Upgrade' -H 'upgrade: websocket' \
      -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==')"

agent_code=$(http agent-acp-proxy POST /v1/agents -H 'content-type: application/json' \
  -d '{"name":"bridge verify","model":"claude-sonnet-4-5","_oma":{"harness":"acp-proxy","runtime_binding":{"runtime_id":"rt_missing","acp_agent_id":"claude-acp"}}}')
agent_oma=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])).get("_oma")))' \
  "$EVID/http/agent-acp-proxy.body" 2>/dev/null || head -c 200 "$EVID/http/agent-acp-proxy.body")
log "INFO POST /v1/agents с _oma.harness=acp-proxy и несуществующим runtime_id => $agent_code, _oma в ответе $agent_oma"

log "## 3. Харнессы на Node (статически)"
if grep -q '"acp-proxy"' "$PLATFORM/apps/agent/src/harness/builtins.ts"; then
  log "FAIL acp-proxy в builtins.ts => зарегистрирован, рецепт устарел"; FAILS=$((FAILS + 1))
else
  log "OK   acp-proxy в apps/agent/src/harness/builtins.ts => не зарегистрирован (есть только в CF-воркере apps/agent/src/index.ts)"
fi

log "## 4. CLI"
set +e
node "$PLATFORM/packages/cli/dist/index.js" bridge --help > "$EVID/cli-bridge-help.txt" 2>&1
help_rc=$?
set -e
expect_eq "oma bridge --help, код выхода" 1 "$help_rc"
log "     подкоманды: $(grep -oE '^ +oma bridge [a-z]+' "$EVID/cli-bridge-help.txt" | awk '{print $3}' | tr '\n' ' ')"
log "INFO claude-agent-acp в PATH => $(command -v claude-agent-acp || echo нет)"

log "## 5. Автотесты изоляции демона (packages/cli)"
set +e
(cd "$PLATFORM/packages/cli" && nice -n 15 npx vitest run --config vitest.config.ts) > "$EVID/cli-tests.txt" 2>&1
tests_rc=$?
set -e
expect_eq "vitest packages/cli, код выхода" 0 "$tests_rc"
log "     $(grep -E 'Test Files|Tests ' "$EVID/cli-tests.txt" | tr -s ' ' | tr '\n' ';')"

log "## Итог"
log "ACCEPTANCE: FAIL, серверной части моста на Node нет (connect-runtime, exchange, _attach отвечают 404),"
log "            ход агента в Claude Code ноутбука выполнить нельзя; события сессии с claude-acp не получены."
log "MISMATCHES: $FAILS"

{
  echo "# Проверка oma bridge, $STAMP"
  echo
  echo "Скрипт: \`scripts/verify-claude-code-harness.sh\`, журнал: \`verify.txt\`, ответы: \`http/\`."
  echo
  echo "| Проверка | Результат |"
  echo "|---|---|"
  grep -E '^(OK|FAIL|INFO)' "$OUT" | sed -E 's/\|/\\|/g; s/^(OK|FAIL|INFO) +(.*) => (.*)$/| \2 | \1: \3 |/'
  echo
  echo "Приёмка моста: **не выполнена** (серверной части нет). Расхождений с рецептом: $FAILS."
} > "$EVID/summary.md"

[ "$FAILS" -eq 0 ]
