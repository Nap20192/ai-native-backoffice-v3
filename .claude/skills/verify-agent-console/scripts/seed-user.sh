#!/usr/bin/env bash
# Создаёт тестовую учётку в экземпляре прогона, заданного через --run или VERIFY_RUN_DIR, через Better Auth:
#   POST /auth/sign-up/email {email, password, name} с заголовком origin.
# Рабочее пространство tn_… создаёт хук user.create.after (packages/auth-config/src/index.ts:237-249).
# Проверяет cookie better-auth.session_token, почту и user.id в /auth/get-session,
# user.id, tenant и роль owner в /v1/oma/me, затем /v1/agents с заголовком beta.
# Пишет state/test-user.json (почта, пароль, name, user_id, tenant_id) с правами 600
# и cookie-jar state/cookies.txt. Пароль и токен не печатаются.
# В доказательства идут api/01-auth-me.json и api/01-auth-get-session.json (без токена).
# При сбое без summary.md пишет «ПРЕРВАН на шаге seed-user».
# Использование: scripts/seed-user.sh --run <RUN_ID|папка>   (или VERIFY_RUN_DIR=<папка>)
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
vac_require_tools curl jq openssl
vac_parse_args "$@"
vac_load_run
SEED_OK=0
trap '[ "$SEED_OK" = 1 ] || vac_abort_summary "$EVIDENCE_DIR" seed-user "${VAC_LAST_ERROR:-seed-user.sh завершился с ошибкой}"' EXIT

USER_FILE="$RUN_DIR/state/test-user.json"
JAR="$RUN_DIR/state/cookies.txt"
[ -f "$USER_FILE" ] && vac_die "учётка уже создана в этом прогоне: $USER_FILE"
curl -fsS "$BASE_URL/health" >/dev/null || vac_die "экземпляр $BASE_URL не отвечает; сначала scripts/launch.sh"

EMAIL="verify-$RUN_ID@verify.test"
NAME="Проверка $RUN_ID"
PASSWORD="$(openssl rand -hex 16)"
BETA="managed-agents-2026-04-01"

umask 077
BODY="$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" --arg n "$NAME" '{email:$e,password:$p,name:$n}')"
CODE="$(curl -sS -o "$RUN_DIR/state/sign-up.json" -w '%{http_code}' -c "$JAR" -b "$JAR" \
  -X POST "$BASE_URL/auth/sign-up/email" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  --data-binary @- <<<"$BODY")"
[ "$CODE" = "200" ] || { jq -c 'del(.token)' "$RUN_DIR/state/sign-up.json" >&2 2>/dev/null || true; vac_die "sign-up вернул $CODE"; }
grep -q 'better-auth.session_token' "$JAR" || vac_die "после sign-up нет cookie better-auth.session_token"

USER_ID="$(jq -r '.user.id // empty' "$RUN_DIR/state/sign-up.json")"
[ -n "$USER_ID" ] || vac_die "в ответе sign-up нет user.id"
# Почту проверяем через Better Auth: /v1/oma/me на main-node отдаёт email "" —
# buildMeRoutes подключён без loadUser (apps/main-node/src/modules/node-http.ts:444-475).
SESS_CODE="$(curl -sS -o "$RUN_DIR/state/get-session.json" -w '%{http_code}' -b "$JAR" -H "origin: $BASE_URL" "$BASE_URL/auth/get-session")"
[ "$SESS_CODE" = "200" ] || vac_die "/auth/get-session вернул $SESS_CODE"
[ "$(jq -r '.user.id' "$RUN_DIR/state/get-session.json")" = "$USER_ID" ] || vac_die "/auth/get-session: другой user.id"
[ "$(jq -r '.user.email' "$RUN_DIR/state/get-session.json")" = "$EMAIL" ] || vac_die "/auth/get-session: другая почта"

ME_CODE="$(curl -sS -o "$RUN_DIR/state/me.json" -w '%{http_code}' -b "$JAR" -H "origin: $BASE_URL" "$BASE_URL/v1/oma/me")"
[ "$ME_CODE" = "200" ] || vac_die "/v1/oma/me вернул $ME_CODE"
TENANT="$(jq -r '.tenant.id // empty' "$RUN_DIR/state/me.json")"
case "$TENANT" in tn_*) ;; *) vac_die "в /v1/oma/me нет tenant.id вида tn_… (получено: ${TENANT:-пусто})" ;; esac
[ "$(jq -r '.user.id' "$RUN_DIR/state/me.json")" = "$USER_ID" ] || vac_die "/v1/oma/me вернул другого пользователя"
[ "$(jq -r --arg t "$TENANT" '[.tenants[]? | select(.id == $t and .role == "owner")] | length' "$RUN_DIR/state/me.json")" = "1" ] \
  || vac_die "/v1/oma/me: учётка не владелец своего рабочего пространства $TENANT"
ME_EMAIL="$(jq -r '.user.email' "$RUN_DIR/state/me.json")"
[ "$ME_EMAIL" = "$EMAIL" ] || vac_say "внимание: /v1/oma/me.user.email = \"$ME_EMAIL\" (на main-node loadUser не подключён); почта сверена через /auth/get-session"

AG_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" -H "origin: $BASE_URL" -H "anthropic-beta: $BETA" "$BASE_URL/v1/agents")"
[ "$AG_CODE" = "200" ] || vac_die "GET /v1/agents с cookie вернул $AG_CODE"

jq -n --arg e "$EMAIL" --arg p "$PASSWORD" --arg n "$NAME" --arg t "$TENANT" --arg u "$USER_ID" \
  '{email:$e,password:$p,name:$n,tenant_id:$t,user_id:$u}' > "$USER_FILE"
cp "$RUN_DIR/state/me.json" "$EVIDENCE_DIR/api/01-auth-me.json"
jq '{user: (.user | {id, email, name}), session: (.session | {userId, expiresAt})}' "$RUN_DIR/state/get-session.json" \
  > "$EVIDENCE_DIR/api/01-auth-get-session.json"
umask 022
SEED_OK=1
printf 'учётка: %s, рабочее пространство %s (пароль в %s)\n' "$EMAIL" "$TENANT" "$USER_FILE" >&2
