#!/usr/bin/env bash
# Останавливает экземпляр ОДНОГО прогона, заданного явно, и убирает его временные данные.
#   0) останавливает сценарий (роли journey, journey-child в state/pids) и его потомков;
#   1) пока сервер жив: архивирует сессии прогона (state/created.json) -> VM останавливаются;
#   2) запоминает потомков сервера (VM-шимы BoxLite и т. п.) по PID и времени старта;
#   3) SIGTERM серверу (tsx передаёт сигнал node), ждёт до 30 с, затем фейковой модели и фейковому MCP-серверу;
#   4) добивает только записанные PID этого прогона, если они пережили SIGTERM;
#   5) копирует финальные логи в доказательства и проверяет, что порты свободны;
#   6) удаляет папку прогона (данные, сборку консоли, секреты, учётку).
# Доказательства ($REPO/.verify-evidence/<RUN_ID>) и кэш BoxLite не трогаются.
# Процессы по имени не убиваются никогда. Без явного прогона скрипт ничего не делает:
# «последний» или «текущий» прогон может оказаться чужим.
# Если summary.md нет (сбой до сценария), пишет «ПРЕРВАН» с причиной.
# Использование: scripts/cleanup.sh --run <RUN_ID|папка> [--keep-state]   (или VERIFY_RUN_DIR=<папка>)
set -uo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

vac_require_tools jq curl ss
vac_parse_args "$@"
KEEP_STATE=0
for a in "${VAC_REST[@]}"; do
  case "$a" in --keep-state) KEEP_STATE=1 ;; *) vac_die "неизвестный аргумент: $a" ;; esac
done
vac_load_run
case "$RUN_DIR" in "$VERIFY_STATE_ROOT"/runs/*) ;; *) vac_die "папка прогона вне $VERIFY_STATE_ROOT/runs: $RUN_DIR" ;; esac
NOTE="$EVIDENCE_DIR/logs/cleanup.txt"
mkdir -p "$EVIDENCE_DIR/logs"
say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$NOTE" >&2; }

alive() { read -r p s <<<"$(vac_pid_of "$1")"; [ -n "${p:-}" ] && vac_same_process "$p" "$s"; }
pid_of() { vac_pid_of "$1" | cut -d' ' -f1; }

stop_pid() { # $1 pid, $2 starttime, $3 подпись, $4 секунд ожидания
  local pid="$1" start="$2" label="$3" wait_s="$4" i
  vac_same_process "$pid" "$start" || return 0
  kill -TERM "$pid" 2>/dev/null
  for i in $(seq 1 $((wait_s * 2))); do vac_same_process "$pid" "$start" || { say "$label ($pid) остановлен по SIGTERM"; return 0; }; sleep 0.5; done
  kill -KILL "$pid" 2>/dev/null
  sleep 0.5
  vac_same_process "$pid" "$start" && { say "$label ($pid) не остановился даже после SIGKILL"; return 1; }
  say "$label ($pid) остановлен SIGKILL после ${wait_s} с"
}

# --- 0. Сценарий и его Chromium (если ещё живы, например после таймаута) ------------
: > "$RUN_DIR/state/journey-procs"
while read -r jp js; do
  [ -n "${jp:-}" ] && vac_same_process "$jp" "$js" || continue
  printf '%s %s\n' "$jp" "$js" >> "$RUN_DIR/state/journey-procs"
  for d in $(vac_descendants "$jp"); do printf '%s %s\n' "$d" "$(vac_starttime "$d")" >> "$RUN_DIR/state/journey-procs"; done
done < <(vac_pids_of journey)
vac_pids_of journey-child >> "$RUN_DIR/state/journey-procs"
jstopped=0
while read -r jp js; do
  [ -n "${jp:-}" ] && vac_same_process "$jp" "$js" || continue
  stop_pid "$jp" "$js" "сценарий/браузер" 5; jstopped=$((jstopped + 1))
done < <(sort -u "$RUN_DIR/state/journey-procs")
say "живых процессов сценария и браузера остановлено: $jstopped"

# --- 1. Архив сессий, пока сервер жив --------------------------------------------
if alive server-node && [ -f "$RUN_DIR/state/created.json" ] && [ -f "$RUN_DIR/state/cookies.txt" ]; then
  for sid in $(jq -r '.sessions[]?' "$RUN_DIR/state/created.json"); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST -b "$RUN_DIR/state/cookies.txt" \
      -H "origin: $BASE_URL" -H 'anthropic-beta: managed-agents-2026-04-01' "$BASE_URL/v1/sessions/$sid/archive")"
    say "архив сессии $sid: HTTP $code"
  done
fi

# --- 2. Потомки сервера ------------------------------------------------------------
: > "$RUN_DIR/state/descendants"
for role in server-tsx server-node; do
  if alive "$role"; then
    for d in $(vac_descendants "$(pid_of "$role")"); do
      printf '%s %s\n' "$d" "$(vac_starttime "$d")" >> "$RUN_DIR/state/descendants"
    done
  fi
done
sort -u -o "$RUN_DIR/state/descendants" "$RUN_DIR/state/descendants"
say "потомков сервера записано: $(wc -l < "$RUN_DIR/state/descendants")"

# --- 3. Сервер и фейковая модель ----------------------------------------------------
read -r tsx_pid tsx_start <<<"$(vac_pid_of server-tsx)"
read -r node_pid node_start <<<"$(vac_pid_of server-node)"
[ -n "${tsx_pid:-}" ] && stop_pid "$tsx_pid" "$tsx_start" "сервер (tsx)" 30
[ -n "${node_pid:-}" ] && stop_pid "$node_pid" "$node_start" "сервер (node)" 10
grep -q '"op":"main-node.shutdown"' "$SERVER_LOG" 2>/dev/null \
  && say "в логе сервера есть op main-node.shutdown" || say "в логе сервера нет op main-node.shutdown"
read -r fake_pid fake_start <<<"$(vac_pid_of fake-model)"
[ -n "${fake_pid:-}" ] && stop_pid "$fake_pid" "$fake_start" "фейковая модель" 5
read -r mcp_pid mcp_start <<<"$(vac_pid_of fake-mcp)"
[ -n "${mcp_pid:-}" ] && stop_pid "$mcp_pid" "$mcp_start" "фейковый MCP-сервер" 5

# --- 4. Пережившие потомки (только записанные PID) ---------------------------------
left=0
while read -r d s; do
  [ -n "${d:-}" ] || continue
  if vac_same_process "$d" "$s"; then
    left=$((left + 1))
    say "потомок $d ($(tr '\0' ' ' 2>/dev/null < "/proc/$d/cmdline" | cut -c1-80)) пережил сервер"
    stop_pid "$d" "$s" "потомок" 5
  fi
done < "$RUN_DIR/state/descendants"
say "потомков, переживших остановку сервера: $left"

# --- 5. Логи и порты ----------------------------------------------------------------
[ -f "$SERVER_LOG" ] && cp "$SERVER_LOG" "$EVIDENCE_DIR/logs/main-node.final.log"
[ -f "$FAKE_LOG" ] && cp "$FAKE_LOG" "$EVIDENCE_DIR/logs/fake-model.final.log"
[ -f "$FAKE_REQUESTS" ] && cp "$FAKE_REQUESTS" "$EVIDENCE_DIR/logs/fake-model-requests.final.jsonl"
# Прогоны до 2026-10-18 не знали фейкового MCP-сервера: в их run.env нет FAKE_MCP_*.
[ -n "${FAKE_MCP_LOG:-}" ] && [ -f "$FAKE_MCP_LOG" ] && cp "$FAKE_MCP_LOG" "$EVIDENCE_DIR/logs/fake-mcp.final.log"
[ -n "${FAKE_MCP_REQUESTS:-}" ] && [ -f "$FAKE_MCP_REQUESTS" ] && cp "$FAKE_MCP_REQUESTS" "$EVIDENCE_DIR/logs/fake-mcp.final.jsonl"
rc=0
for port in "$VERIFY_PORT" "$VERIFY_FAKE_PORT" ${FAKE_MCP_URL:+"$VERIFY_FAKE_MCP_PORT"}; do
  if vac_port_busy "$port"; then say "порт $port всё ещё занят: $(vac_port_pids "$port" | tr '\n' ' ')"; rc=1; else say "порт $port свободен"; fi
done
say "ящиков BoxLite в кэше: $(ls -A "$BOXLITE_HOME/boxes" 2>/dev/null | wc -l) (autoRemove: должно быть 0)"
# Процессы, которые не потомки сервера, но ссылаются на кэш BoxLite прогона: только отчёт, без kill.
strays=""
for d in /proc/[0-9]*; do
  p="${d#/proc/}"
  [ "$p" = "$$" ] && continue
  tr '\0' ' ' 2>/dev/null < "$d/cmdline" | grep -qF "$BOXLITE_HOME" && strays+=" $p"
done
[ -z "$strays" ] && say "процессов с $BOXLITE_HOME в командной строке нет" \
  || { say "ВНИМАНИЕ: процессы с $BOXLITE_HOME в командной строке:$strays (не записаны как наши, не убиты; проверьте вручную)"; rc=1; }

# --- 6. Временные данные ------------------------------------------------------------
if [ "$KEEP_STATE" = 1 ]; then
  say "--keep-state: папка прогона оставлена: $RUN_DIR"
elif [ "$rc" = 0 ] && [ -f "$RUN_DIR/$VAC_RUN_MARKER" ]; then
  rm -rf -- "$RUN_DIR"
  say "папка прогона удалена: $RUN_DIR"
else
  say "папка прогона НЕ удалена (процессы или порты не освобождены): $RUN_DIR"
fi
if [ -d "$EVIDENCE_DIR" ]; then
  if [ ! -f "$EVIDENCE_DIR/summary.md" ]; then
    vac_abort_summary "$EVIDENCE_DIR" "до сценария" "summary.md не записан: сценарий не запускался или упал до записи итога; см. logs/"
    say "summary.md не было: записан итог «ПРЕРВАН»"
  fi
  say "доказательства сохранены: $EVIDENCE_DIR (файлов: $(find "$EVIDENCE_DIR" -type f | wc -l))"
else
  say "ВНИМАНИЕ: папки доказательств нет: $EVIDENCE_DIR"; rc=1
fi
exit "$rc"
