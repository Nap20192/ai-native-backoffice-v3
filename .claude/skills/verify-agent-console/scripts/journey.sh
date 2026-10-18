#!/usr/bin/env bash
# Обёртка главного сценария: проверка нагрузки, Node 24, nice -n 15,
# затем journey-env-to-agent.mjs (Playwright). Код выхода = код сценария.
# PID сценария пишется в state/pids (роль journey), PID Chromium — сам сценарий
# (роль journey-child): cleanup.sh остановит их, даже если сценарий убили по таймауту.
# Использование: scripts/journey.sh --run <RUN_ID|папка> [--scenario env-to-agent|builder|crud|mcp-ask|multiagent]
#   (или VERIFY_RUN_DIR=<папка>). По умолчанию главный сценарий env-to-agent;
#   builder: journey-builder.mjs (ассистент платформы, нужен seed-user.sh --others);
#   crud: journey-crud.mjs (архив, возврат и удаление в консоли и через помощника);
#   mcp-ask: journey-mcp-ask.mjs (вызов MCP ждёт «Разрешить» на странице сессии, fake-mcp.mjs);
#   multiagent: journey-multiagent.mjs (подтверждение в потоке субагента, предел сессии, блок multiagent_20261001).
# Переменные сценария: VERIFY_FIRST_TURN_TIMEOUT_MS (900000), VERIFY_TURN_TIMEOUT_MS (600000),
#   VERIFY_KEEP_SESSION=1 (не архивировать сессии в конце), VERIFY_HEADED=1, VERIFY_CHROMIUM=<путь>.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
vac_parse_args "$@"
SCENARIO=env-to-agent
set -- ${VAC_REST[@]+"${VAC_REST[@]}"}
while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) [ $# -ge 2 ] || vac_die "--scenario без значения"; SCENARIO="$2"; shift 2 ;;
    --scenario=*) SCENARIO="${1#--scenario=}"; shift ;;
    *) vac_die "неизвестный аргумент: $1" ;;
  esac
done
case "$SCENARIO" in
  env-to-agent) JOURNEY_SCRIPT=journey-env-to-agent.mjs ;;
  builder) JOURNEY_SCRIPT=journey-builder.mjs ;;
  crud) JOURNEY_SCRIPT=journey-crud.mjs ;;
  mcp-ask) JOURNEY_SCRIPT=journey-mcp-ask.mjs ;;
  multiagent) JOURNEY_SCRIPT=journey-multiagent.mjs ;;
  *) vac_die "сценарий $SCENARIO неизвестен: env-to-agent, builder, crud, mcp-ask или multiagent" ;;
esac
vac_load_run
trap 'vac_abort_summary "$EVIDENCE_DIR" journey "${VAC_LAST_ERROR:-journey.sh завершился до запуска сценария}"' EXIT
vac_node24
[ -f "$RUN_DIR/state/test-user.json" ] || vac_die "нет тестовой учётки: сначала scripts/seed-user.sh"
vac_wait_cool
export VERIFY_RUN_DIR="$RUN_DIR"
# exec сохраняет PID и время старта: запись относится к процессу node сценария.
vac_record_pid journey "$$"
trap - EXIT
exec nice -n 15 "$VAC_NODE_BIN" "$VAC_SCRIPTS/$JOURNEY_SCRIPT"
