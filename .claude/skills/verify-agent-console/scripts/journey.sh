#!/usr/bin/env bash
# Обёртка главного сценария: проверка нагрузки, Node 24, nice -n 15,
# затем journey-env-to-agent.mjs (Playwright). Код выхода = код сценария.
# PID сценария пишется в state/pids (роль journey), PID Chromium — сам сценарий
# (роль journey-child): cleanup.sh остановит их, даже если сценарий убили по таймауту.
# Использование: scripts/journey.sh --run <RUN_ID|папка>   (или VERIFY_RUN_DIR=<папка>)
# Переменные сценария: VERIFY_FIRST_TURN_TIMEOUT_MS (900000), VERIFY_TURN_TIMEOUT_MS (600000),
#   VERIFY_KEEP_SESSION=1 (не архивировать сессии в конце), VERIFY_HEADED=1, VERIFY_CHROMIUM=<путь>.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
vac_parse_args "$@"
vac_load_run
trap 'vac_abort_summary "$EVIDENCE_DIR" journey "${VAC_LAST_ERROR:-journey.sh завершился до запуска сценария}"' EXIT
vac_node24
[ -f "$RUN_DIR/state/test-user.json" ] || vac_die "нет тестовой учётки: сначала scripts/seed-user.sh"
vac_wait_cool
export VERIFY_RUN_DIR="$RUN_DIR"
# exec сохраняет PID и время старта: запись относится к процессу node сценария.
vac_record_pid journey "$$"
trap - EXIT
exec nice -n 15 "$VAC_NODE_BIN" "$VAC_SCRIPTS/journey-env-to-agent.mjs"
