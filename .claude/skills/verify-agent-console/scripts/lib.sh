#!/usr/bin/env bash
# Общие переменные и функции verify-agent-console.
# Остальные скрипты подключают файл через `. lib.sh`.
# Прямой запуск `scripts/lib.sh` печатает порты, папки и живые прогоны.
# Общего указателя «текущий прогон» нет: doctor, seed-user, journey и cleanup
# работают только с прогоном, который им передали явно (--run или VERIFY_RUN_DIR),
# чтобы не остановить и не испортить параллельный прогон другого агента.

VAC_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAC_SKILL_DIR="$(cd "$VAC_SCRIPTS/.." && pwd)"
REPO_ROOT="${VERIFY_REPO_ROOT:-$(cd "$VAC_SKILL_DIR/../../.." && pwd)}"
PLATFORM_DIR="$REPO_ROOT/platform"
MAIN_NODE_DIR="$PLATFORM_DIR/apps/main-node"
CONSOLE_SRC_DIR="$PLATFORM_DIR/apps/console"

VERIFY_HOST="127.0.0.1"
VERIFY_PORT="${VERIFY_PORT:-8791}"
VERIFY_FAKE_PORT="${VERIFY_FAKE_PORT:-8792}"
VERIFY_STATE_ROOT="${VERIFY_STATE_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/verify-agent-console}"
# Кэш BoxLite (образы VM) и HOME сервера живут между прогонами, чтобы образ
# не скачивался каждый раз. Общий ~/.boxlite не используется.
VERIFY_BOXLITE_HOME="${VERIFY_BOXLITE_HOME:-$VERIFY_STATE_ROOT/boxlite}"
VERIFY_SERVER_HOME="${VERIFY_SERVER_HOME:-$VERIFY_STATE_ROOT/home}"
VERIFY_EVIDENCE_ROOT="${VERIFY_EVIDENCE_ROOT:-$REPO_ROOT/.verify-evidence}"
VERIFY_MODEL_MODE="${VERIFY_MODEL_MODE:-fake}"
VERIFY_AGENT_MODEL="${VERIFY_AGENT_MODEL:-claude-sonnet-4-6}"
VERIFY_SANDBOX_IMAGE="${VERIFY_SANDBOX_IMAGE:-node:22-bookworm}"
VERIFY_START_TIMEOUT_S="${VERIFY_START_TIMEOUT_S:-180}"

# Чужие порты: другой workflow (8787), пробная копия владельца (8788, 5174), vite (5173).
VAC_FORBIDDEN_PORTS="8787 8788 5173 5174"
VAC_RUN_MARKER=".verify-agent-console-run"

vac_say() { printf '%s\n' "$*" >&2; }
# VAC_LAST_ERROR читают обработчики EXIT (запись «ПРЕРВАН» в summary.md).
vac_die() { VAC_LAST_ERROR="$*"; printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

vac_require_tools() {
  local t
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || vac_die "нет утилиты $t"; done
}

# Node 24 через fnm. VAC_NODE_BIN — абсолютный путь к node (не ссылка fnm_multishells).
vac_node24() {
  command -v fnm >/dev/null 2>&1 || vac_die "нет fnm"
  eval "$(fnm env --shell bash)"
  fnm use 24 >/dev/null 2>&1 || vac_die "fnm use 24 не сработал"
  VAC_NODE_BIN="$(readlink -f "$(command -v node)")"
  local major
  major="$("$VAC_NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  [ "$major" = "24" ] || vac_die "нужен Node 24, а найден $("$VAC_NODE_BIN" -v)"
  export PATH="$(dirname "$VAC_NODE_BIN"):$PATH"
}

# Перед тяжёлой командой: при load1 >= 10 или температуре >= 93°C ждём 60 с, не больше 10 раз.
vac_wait_cool() {
  local i load1 temp
  for i in 1 2 3 4 5 6 7 8 9 10; do
    load1="$(cut -d' ' -f1 /proc/loadavg)"
    temp="$(sensors 2>/dev/null | grep 'Package id 0' | grep -oE '\+[0-9]+(\.[0-9]+)?' | head -1 | tr -d '+' || true)"
    if awk -v l="$load1" -v t="${temp:-0}" 'BEGIN { exit !(l >= 10 || t >= 93) }'; then
      vac_say "нагрузка высокая: load1=$load1, CPU ${temp:-?}°C; жду 60 с ($i/10)"
      sleep 60
    else
      vac_say "нагрузка: load1=$load1, CPU ${temp:-нет данных}°C"
      return 0
    fi
  done
  vac_die "нагрузка не спала за 10 ожиданий по 60 с; тяжёлую команду не запускаю"
}

vac_port_busy() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }
vac_port_pids() { ss -Hltnp "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u; }

vac_guard_port_value() {
  local p
  for p in $VAC_FORBIDDEN_PORTS; do
    [ "$1" = "$p" ] && vac_die "порт $1 чужой (8787, 8788, 5173, 5174 не трогаем); задайте другой"
  done
  return 0
}

# Поля /proc/<pid>/stat после "(comm) ": $2 = ppid, $20 = starttime.
vac_stat_field() { sed -E 's/^.*\) //' "/proc/$1/stat" 2>/dev/null | awk -v n="$2" '{print $n}'; }
vac_starttime() { vac_stat_field "$1" 20; }
vac_ppid() { vac_stat_field "$1" 2; }
vac_same_process() { [ -d "/proc/$1" ] && [ "$(vac_starttime "$1")" = "$2" ]; }

# Все потомки PID (по ppid), без самого PID.
vac_descendants() {
  local root="$1" pid ppid
  declare -A kids=()
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    ppid="$(vac_ppid "$pid")" || continue
    [ -n "$ppid" ] && kids[$ppid]+="$pid "
  done
  local queue=("$root") cur
  while [ "${#queue[@]}" -gt 0 ]; do
    cur="${queue[0]}"; queue=("${queue[@]:1}")
    for pid in ${kids[$cur]:-}; do echo "$pid"; queue+=("$pid"); done
  done
}

# --- Выбор прогона ------------------------------------------------------------------
# Аргументы скриптов: --run <RUN_ID|папка прогона> (или переменная VERIFY_RUN_DIR).
# vac_parse_args "$@" заполняет VAC_RUN_REF и массив VAC_REST (остальные аргументы).
vac_parse_args() {
  VAC_RUN_REF="${VERIFY_RUN_DIR:-}"
  VAC_REST=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --run) [ $# -ge 2 ] || vac_die "--run без значения"; VAC_RUN_REF="$2"; shift 2 ;;
      --run=*) VAC_RUN_REF="${1#--run=}"; shift ;;
      *) VAC_REST+=("$1"); shift ;;
    esac
  done
}

# RUN_ID или путь -> абсолютная папка прогона (только с маркером launch.sh).
vac_resolve_run() {
  local ref="$1" dir
  [ -n "$ref" ] || return 1
  case "$ref" in */*) dir="$ref" ;; *) dir="$VERIFY_STATE_ROOT/runs/$ref" ;; esac
  [ -f "$dir/$VAC_RUN_MARKER" ] || return 1
  (cd "$dir" && pwd)
}

# Жив ли хоть один записанный процесс прогона (по PID и времени старта).
vac_run_alive() {
  local role pid start
  [ -f "$1/state/pids" ] || return 1
  while read -r role pid start; do
    [ -n "${pid:-}" ] && vac_same_process "$pid" "$start" && return 0
  done < "$1/state/pids"
  return 1
}

# Папки прогонов, у которых жив хоть один записанный процесс.
vac_live_runs() {
  local d
  for d in "$VERIFY_STATE_ROOT"/runs/*/; do
    [ -f "$d$VAC_RUN_MARKER" ] || continue
    vac_run_alive "${d%/}" && printf '%s\n' "${d%/}"
  done
  return 0
}

vac_load_run() {
  RUN_DIR="$(vac_resolve_run "${VAC_RUN_REF:-}")" \
    || vac_die "прогон не задан или не найден (${VAC_RUN_REF:-пусто}): передайте --run <RUN_ID> или VERIFY_RUN_DIR=<папка>, их печатает launch.sh; живые прогоны: $(vac_live_runs | tr '\n' ' ')"
  [ -f "$RUN_DIR/run.env" ] || vac_die "нет $RUN_DIR/run.env"
  # run.env пишет launch.sh: KEY=VALUE без пробелов и кавычек.
  # shellcheck disable=SC1091
  . "$RUN_DIR/run.env"
}

# Строки state/pids: <роль> <pid> <starttime>.
vac_record_pid() { printf '%s %s %s\n' "$1" "$2" "$(vac_starttime "$2")" >> "$RUN_DIR/state/pids"; }
vac_pid_of() { awk -v r="$1" '$1 == r { print $2 " " $3 }' "$RUN_DIR/state/pids" 2>/dev/null | tail -1; }
vac_pids_of() { awk -v r="$1" '$1 == r { print $2 " " $3 }' "$RUN_DIR/state/pids" 2>/dev/null; }

# Если сценарий не записал summary.md (сбой до него), пишем строку «ПРЕРВАН».
# $1 папка доказательств, $2 шаг, $3 причина.
vac_abort_summary() {
  local ev="$1" step="$2" reason="$3"
  [ -n "$ev" ] && [ -d "$ev" ] || return 0
  [ -f "$ev/summary.md" ] && return 0
  {
    printf '# verify-agent-console: прогон %s\n\n' "$(basename "$ev")"
    printf 'Итог: ПРЕРВАН на шаге %s (проверок сценария нет: summary.md сценария не записан).\n\n' "$step"
    printf 'Причина: %s\n\n' "${reason:-неизвестна, см. логи}"
    printf 'Логи: logs/launch.txt, logs/doctor-*.txt, logs/cleanup.txt, logs/main-node.final.log (что есть в папке).\n'
  } > "$ev/summary.md"
}

# Состояние кода для сверки сборки: хэш изменений рабочего дерева относительно HEAD
# (git diff HEAD плюс содержимое неотслеживаемых файлов) по путям $@.
vac_tree_hash() {
  {
    git -C "$REPO_ROOT" diff HEAD --binary -- "$@" 2>/dev/null
    git -C "$REPO_ROOT" ls-files -o --exclude-standard -z -- "$@" 2>/dev/null \
      | (cd "$REPO_ROOT" && xargs -0 -r sha256sum)
  } | sha256sum | cut -c1-16
}
VAC_CONSOLE_PATHS="platform/apps/console"
# apps/agent: харнессы (Pi, acp-sandbox, AcpTranslator), их тоже исполняет сервер.
VAC_SERVER_PATHS="platform/apps/main-node platform/apps/agent platform/packages"

vac_count_env_var() { grep -c "^$1=." "$PLATFORM_DIR/.env" 2>/dev/null || true; }

vac_model_mode() {
  case "$VERIFY_MODEL_MODE" in
    fake) echo fake ;;
    real)
      [ "$(vac_count_env_var ANTHROPIC_API_KEY)" = "1" ] \
        || vac_die "VERIFY_MODEL_MODE=real, но grep -c '^ANTHROPIC_API_KEY=.' platform/.env не равен 1"
      echo real ;;
    *) vac_die "VERIFY_MODEL_MODE должен быть fake или real" ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  cat <<EOF
REPO_ROOT=$REPO_ROOT
PLATFORM_DIR=$PLATFORM_DIR
VERIFY_PORT=$VERIFY_PORT  (сервер и консоль: http://$VERIFY_HOST:$VERIFY_PORT)
VERIFY_FAKE_PORT=$VERIFY_FAKE_PORT  (фейковая модель)
VERIFY_STATE_ROOT=$VERIFY_STATE_ROOT  (прогоны: runs/<RUN_ID>)
VERIFY_BOXLITE_HOME=$VERIFY_BOXLITE_HOME
VERIFY_SERVER_HOME=$VERIFY_SERVER_HOME
VERIFY_EVIDENCE_ROOT=$VERIFY_EVIDENCE_ROOT
VERIFY_MODEL_MODE=$VERIFY_MODEL_MODE  VERIFY_AGENT_MODEL=$VERIFY_AGENT_MODEL
VERIFY_SANDBOX_IMAGE=$VERIFY_SANDBOX_IMAGE
живые прогоны (есть записанные процессы): $(vac_live_runs | tr '\n' ' ')
EOF
fi
