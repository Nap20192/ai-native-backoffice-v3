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
# С --others (сценарий builder, docs/plans/builder-agent.md 6.2 и 6.4) ещё два пользователя:
#   участник пространства тестовой учётки с ролью member (приглашение владельца и
#   POST /v1/oma/tenants/invitations/accept), state/member.json и state/member-cookies.txt;
#   второй пользователь со своим пространством, state/foreign.json и state/foreign-cookies.txt.
# Использование: scripts/seed-user.sh --run <RUN_ID|папка> [--others]   (или VERIFY_RUN_DIR=<папка>)
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
vac_require_tools curl jq openssl
vac_parse_args "$@"
SEED_OTHERS=0
for arg in ${VAC_REST[@]+"${VAC_REST[@]}"}; do
  case "$arg" in
    --others) SEED_OTHERS=1 ;;
    *) vac_die "неизвестный аргумент: $arg" ;;
  esac
done
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
# Почту проверяем через Better Auth (источник истины); /v1/oma/me берёт её через
# loadUser в buildMeRoutes (apps/main-node/src/modules/node-http.ts, маршрут /oma/me).
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

# Ещё один пользователь: sign-up, cookie-jar, user.id и его собственное пространство.
# $1 роль в именах файлов (member или foreign), $2 подпись в имени.
seed_other() {
  local role="$1" label="$2" email password jar out code uid tenant
  email="verify-$RUN_ID-$role@verify.test"
  password="$(openssl rand -hex 16)"
  jar="$RUN_DIR/state/$role-cookies.txt"
  out="$RUN_DIR/state/$role-sign-up.json"
  code="$(jq -n --arg e "$email" --arg p "$password" --arg n "$label $RUN_ID" '{email:$e,password:$p,name:$n}' \
    | curl -sS -o "$out" -w '%{http_code}' -c "$jar" -b "$jar" -X POST "$BASE_URL/auth/sign-up/email" \
      -H 'content-type: application/json' -H "origin: $BASE_URL" --data-binary @-)"
  [ "$code" = "200" ] || vac_die "sign-up $role вернул $code"
  uid="$(jq -r '.user.id // empty' "$out")"
  [ -n "$uid" ] || vac_die "в ответе sign-up $role нет user.id"
  tenant="$(curl -sS -b "$jar" -H "origin: $BASE_URL" "$BASE_URL/v1/oma/me" | jq -r '.tenant.id // empty')"
  case "$tenant" in tn_*) ;; *) vac_die "у $role нет своего пространства" ;; esac
  jq -n --arg e "$email" --arg p "$password" --arg n "$label $RUN_ID" --arg u "$uid" --arg t "$tenant" \
    '{email:$e,password:$p,name:$n,user_id:$u,own_tenant_id:$t}' > "$RUN_DIR/state/$role.json"
  printf '%s' "$uid"
}

if [ "$SEED_OTHERS" = 1 ]; then
  MEMBER_ID="$(seed_other member "Участник")"
  # Приглашение владельца с ролью member и его принятие вторым пользователем.
  INVITE="$(curl -sS -b "$JAR" -H "origin: $BASE_URL" -H 'content-type: application/json' \
    -X POST "$BASE_URL/v1/oma/tenants/$TENANT/invitations" --data '{"role":"member"}')"
  INVITE_TOKEN="$(jq -r '.token // empty' <<<"$INVITE")"
  [ -n "$INVITE_TOKEN" ] || vac_die "приглашение участника не создано"
  ACCEPT_CODE="$(jq -n --arg t "$INVITE_TOKEN" '{token:$t}' | curl -sS -o "$RUN_DIR/state/member-accept.json" -w '%{http_code}' \
    -b "$RUN_DIR/state/member-cookies.txt" -H "origin: $BASE_URL" -H 'content-type: application/json' \
    -X POST "$BASE_URL/v1/oma/tenants/invitations/accept" --data-binary @-)"
  unset INVITE INVITE_TOKEN
  [ "$ACCEPT_CODE" = "200" ] || vac_die "участник не принял приглашение: код $ACCEPT_CODE"
  MEMBER_ROLE="$(curl -sS -b "$JAR" -H "origin: $BASE_URL" "$BASE_URL/v1/oma/tenants/$TENANT/members" \
    | jq -r --arg u "$MEMBER_ID" '[.data[]? | select(.user_id == $u) | .role][0] // empty')"
  [ "$MEMBER_ROLE" = "member" ] || vac_die "участник в пространстве $TENANT с ролью «${MEMBER_ROLE:-нет}», ожидалась member"
  jq --arg t "$TENANT" '. + {tenant_id:$t, role:"member"}' "$RUN_DIR/state/member.json" > "$RUN_DIR/state/member.json.tmp" \
    && mv "$RUN_DIR/state/member.json.tmp" "$RUN_DIR/state/member.json"
  FOREIGN_ID="$(seed_other foreign "Чужой")"
  jq '. + {tenant_id: .own_tenant_id}' "$RUN_DIR/state/foreign.json" > "$RUN_DIR/state/foreign.json.tmp" \
    && mv "$RUN_DIR/state/foreign.json.tmp" "$RUN_DIR/state/foreign.json"
  printf 'участник %s (member в %s), второй пользователь %s со своим пространством\n' "$MEMBER_ID" "$TENANT" "$FOREIGN_ID" >&2
fi
umask 022
SEED_OK=1
printf 'учётка: %s, рабочее пространство %s (пароль в %s)\n' "$EMAIL" "$TENANT" "$USER_FILE" >&2
