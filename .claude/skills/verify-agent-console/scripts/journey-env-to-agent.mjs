#!/usr/bin/env node
// Главный сценарий verify-agent-console (Playwright, интерфейс консоли на русском):
//   вход тестовой учёткой → создать окружение → доказать, что окружение работает
//   (VM поднимается и выполняет команду) → задать окружению пакет и сеть «Ограниченный»
//   и проверить, что они действуют в VM → создать агента → создать сессию с этим
//   окружением → ход агента с bash в песочнице → итоговый ответ → доказательства
//   (скриншоты, ARIA, API, файлы, логи, поток событий) → архив сессий (VM останавливаются).
// Побочные эффекты проверяются через API (cookie той же сессии браузера) и файлы прогона.
// Запуск: scripts/journey.sh --run <RUN_ID> (задаёт VERIFY_RUN_DIR, nice -n 15, Node 24).
// Итог: $EVIDENCE_DIR/summary.md; код 0 — все обязательные проверки прошли.
import { createRequire } from "node:module";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------- прогон ---
const SKILL_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
// Только явный прогон: общего указателя «текущий прогон» нет (параллельные прогоны не путаются).
const RUN_DIR = (() => {
  const dir = process.env.VERIFY_RUN_DIR ?? "";
  if (!dir || !existsSync(join(dir, ".verify-agent-console-run"))) {
    throw new Error("прогон не задан: VERIFY_RUN_DIR=<папка прогона> (scripts/journey.sh --run <RUN_ID> задаёт её сам)");
  }
  return dir;
})();
const run = Object.fromEntries(
  readFileSync(join(RUN_DIR, "run.env"), "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const user = JSON.parse(readFileSync(join(RUN_DIR, "state", "test-user.json"), "utf8"));
const EV = run.EVIDENCE_DIR;
for (const sub of ["screens", "aria", "api", "logs"]) mkdirSync(join(EV, sub), { recursive: true });
const BASE = run.BASE_URL;
const FAKE = run.MODEL_MODE === "fake";
const MODEL = run.AGENT_MODEL;
const FIRST_TURN_TIMEOUT = Number(process.env.VERIFY_FIRST_TURN_TIMEOUT_MS ?? 900_000);
const TURN_TIMEOUT = Number(process.env.VERIFY_TURN_TIMEOUT_MS ?? 600_000);
const KEEP_SESSION = process.env.VERIFY_KEEP_SESSION === "1";
const VIEW = { width: 1280, height: 860 };
const MAX_SHOT_HEIGHT = 6000;
// Те же флаги, что шлёт консоль (apps/console/src/lib/api.ts:2-10).
const BETAS = [
  "managed-agents-2026-04-01", "files-api-2025-04-14", "skills-2025-10-02", "agent-memory-2026-07-22",
  "dreaming-2026-04-21", "mcp-tunnels-2026-06-22", "user-profiles-2026-08-18",
].join(",");
const HOST_KERNEL = os.release();
// Пакет для проверки настроек окружения: в образе node:22-bookworm его нет
// (это подтверждает первая проба, строка env.probe.baseline).
const ENV_PACKAGE = { manager: "apt", name: "jq" };
const NET_PROBE_URL = "https://example.com";

const newNonce = () => randomBytes(4).toString("hex");
const nonce = newNonce();
const probeNonce = newNonce();
const settingsNonce = newNonce();
const names = {
  env: `verify-env-${nonce}`,
  agent: `verify-agent-${nonce}`,
  session: `verify-session-${nonce}`,
  probeAgent: `verify-env-probe-${probeNonce}`,
  probeSession: `verify-env-probe-${probeNonce}`,
  settingsSession: `verify-env-settings-${settingsNonce}`,
};
const ids = {};
const created = { sessions: [], agents: [], environments: [] };
// Подфункции из features/*.md, которые сценарий действительно прошёл.
// Остальные попадают в summary.md как «не проверено» автоматически.
const covered = new Set();
const cover = (...list) => list.forEach((id) => covered.add(id));

const require = createRequire(join(run.PLATFORM_DIR, "package.json"));
const { chromium } = require("@playwright/test");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toTimeString().slice(0, 8), ...parts);

// --------------------------------------------------------------- проверки ---
// Статусы: «проверено», «провал», «не проверено», «внимание».
const checks = [];
// Сообщения Playwright и вывод bash содержат ANSI-цвета и переносы строк: в summary.md они ломают таблицу.
const plain = (text) => String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
function record(id, title, status, evidence = "", note = "") {
  evidence = plain(evidence);
  note = plain(note);
  checks.push({ id, title, status, evidence, note });
  log(`${status.padEnd(12)} ${id}: ${title}${note ? ` (${note})` : ""}`);
}
async function check(id, title, fn) {
  try {
    const evidence = await fn();
    record(id, title, "проверено", evidence ?? "");
    return true;
  } catch (error) {
    record(id, title, "провал", "", error.message);
    if (page) await shot(`fail-${id}`).catch(() => {});
    return false;
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ----------------------------------------------------------- доказательства ---
let shotN = 0;
let page;
let context;
const screens = [];
let lastStepShot = null;
const duplicateShots = [];
// Высота внутренней прокрутки: оболочка консоли прокручивает main, а не документ,
// поэтому fullPage её не снимает. Если открыт диалог, считается только он.
async function hiddenScrollHeight() {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const scope = dialog ?? document.body;
    let extra = 0;
    for (const el of scope.querySelectorAll("*")) {
      if (el.clientHeight < 200) continue;
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY !== "auto" && overflowY !== "scroll") continue;
      extra = Math.max(extra, el.scrollHeight - el.clientHeight);
    }
    return extra;
  }).catch(() => 0);
}
// Скриншот шага: ширина 1280, высота окна на время снимка растягивается на скрытую
// прокрутку (до MAX_SHOT_HEIGHT). Два подряд одинаковых скриншота шагов (sha256) — провал
// evidence.screens_distinct: значит, страница не перерисовалась и снимок ничего не доказывает.
async function shot(name) {
  const file = `screens/${String(++shotN).padStart(2, "0")}-${name}.png`;
  const extra = await hiddenScrollHeight();
  const tall = extra > 4;
  if (tall) {
    await page.setViewportSize({ width: VIEW.width, height: Math.min(VIEW.height + extra, MAX_SHOT_HEIGHT) });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  let buffer;
  try {
    buffer = await page.screenshot({ path: join(EV, file), fullPage: true });
  } finally {
    if (tall) await page.setViewportSize(VIEW);
  }
  const sha = createHash("sha256").update(buffer).digest("hex");
  const isStep = !/^(fail-|abort$)/.test(name);
  if (isStep && lastStepShot?.sha === sha) duplicateShots.push(`${lastStepShot.file} = ${file}`);
  if (isStep) lastStepShot = { file, sha };
  screens.push({ file, sha, tall: tall ? Math.min(VIEW.height + extra, MAX_SHOT_HEIGHT) : 0 });
  return file;
}
async function aria(name) {
  const file = `aria/${String(shotN).padStart(2, "0")}-${name}.yml`;
  writeFileSync(join(EV, file), await page.locator("body").ariaSnapshot());
  return file;
}
function saveJson(name, data) {
  const file = `api/${name}.json`;
  writeFileSync(join(EV, file), JSON.stringify(data, null, 2));
  return file;
}
function saveCreated() {
  writeFileSync(join(RUN_DIR, "state", "created.json"), JSON.stringify(created, null, 2));
}

// -------------------------------------------------------------------- API ---
async function api(method, path, body) {
  const headers = { "anthropic-beta": BETAS, origin: BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await context.request.fetch(BASE + path, {
    method,
    headers,
    data: body === undefined ? undefined : JSON.stringify(body),
    failOnStatusCode: false,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${text.slice(0, 300)}`);
  return json;
}
async function listEvents(sessionId) {
  const all = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ limit: "100", order: "asc" });
    if (cursor) q.set("page", cursor);
    const page_ = await api("GET", `/v1/sessions/${sessionId}/events?${q}`);
    all.push(...(page_.data ?? []));
    if (!page_.next_page) break;
    cursor = page_.next_page;
  }
  return all;
}
// Параллельно консоли слушаем тот же поток /events/stream (cookie браузера), чтобы видеть,
// какие события консоль получает вживую. Возвращается после заголовков ответа.
async function captureStream(sessionId) {
  const cookie = (await context.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join("; ");
  const abort = new AbortController();
  const seen = { status: 0, events: [], error: null };
  const res = await fetch(`${BASE}/v1/sessions/${sessionId}/events/stream?event_deltas[]=agent.message`, {
    headers: { cookie, origin: BASE, "anthropic-beta": BETAS, accept: "text/event-stream" },
    signal: abort.signal,
  });
  seen.status = res.status;
  const reading = (async () => {
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const name = frame.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim();
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (!data || name === "ping") continue;
          try {
            const event = JSON.parse(data);
            seen.events.push({ sse: name ?? null, type: event.type ?? null, id: event.id ?? null, text: textOf(event.content).slice(0, 160) });
          } catch {
            seen.events.push({ sse: name ?? null, raw: data.slice(0, 160) });
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) seen.error = error.message;
    }
  })();
  return { seen, stop: async () => { abort.abort(); await reading.catch(() => {}); } };
}

// ------------------------------------------------------------ разбор хода ---
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block?.type === "text" ? String(block.text ?? "") : "")).join("\n");
}
const retryType = (event) => (typeof event.retry_status === "string" ? event.retry_status : event.retry_status?.type);

// Команды ходов. Сеть проверяется отдельным ходом и после него ход «alive»:
// на этом стенде любой сетевой запрос из VM (даже getent hosts) рвёт поток exec BoxLite,
// и следующая команда в той же VM получает Connection refused.
function commandFor(kind, n) {
  switch (kind) {
    case "probe": // работает ли VM; pkg_jq — установлен ли пакет из настроек окружения
      return `echo VERIFY_OK_${n} && echo kernel=$(uname -r) && . /etc/os-release && echo os=$ID-$VERSION_CODENAME && echo pwd=$(pwd); `
        + `echo pkg_${ENV_PACKAGE.name}=$(dpkg-query -W -f='\${Status}' ${ENV_PACKAGE.name} 2>/dev/null || echo missing)`;
    case "net": // HTTP-код внешнего хоста из VM (000 = недоступен)
      return `echo VERIFY_OK_${n}; echo net_example=$(curl -s -m 10 -o /dev/null -w '%{http_code}' ${NET_PROBE_URL} || true)`;
    case "alive": // отвечает ли VM после сетевого хода
      return `echo VERIFY_OK_${n} && echo alive_kernel=$(uname -r)`;
    default: // ход агента в главной сессии
      return `mkdir -p /mnt/session/outputs && echo VERIFY_OK_${n} > /mnt/session/outputs/verify-${n}.txt && cat /mnt/session/outputs/verify-${n}.txt && echo kernel=$(uname -r)`;
  }
}
function promptFor(kind, n) {
  return [
    `Выполни инструментом bash ровно одну команду, затем ответь одной строкой VERIFY_DONE_${n}.`,
    `Команда: ${commandFor(kind, n)}`,
    `VERIFY_${kind === "run" ? "AGENT_RUN" : "ENV_PROBE"} nonce=${n}`,
  ].join("\n");
}

function analyzeTurn(events, n) {
  const pos = (event) => events.indexOf(event);
  const userMessage = events.find((e) => e.type === "user.message" && textOf(e.content).includes(`nonce=${n}`));
  if (!userMessage) return { userMessage: null, errors: [] };
  const after = events.slice(pos(userMessage) + 1);
  const toolUses = after.filter((e) => e.type === "agent.tool_use" && e.name === "bash");
  const results = after.filter((e) => e.type === "agent.tool_result");
  let pair = null;
  for (const toolUse of toolUses) {
    const byId = results.find((r) => r.tool_use_id === toolUse.id);
    const result = byId ?? results.find((r) => pos(r) > pos(toolUse));
    if (result && textOf(result.content).includes(`VERIFY_OK_${n}`)) {
      pair = { toolUse, toolResult: result, linkedById: Boolean(byId) };
      break;
    }
  }
  const messages = after.filter((e) => e.type === "agent.message");
  return {
    userMessage,
    toolUses,
    results,
    pair,
    lastMessage: messages.at(-1),
    idle: after.find((e) => e.type === "session.status_idle"),
    errors: after.filter((e) => e.type === "session.error"),
    pos,
  };
}
// Факты пробы: строки pkg_jq=…, kernel=… из вывода bash.
function probeFacts(events, n) {
  const a = analyzeTurn(events, n);
  const text = a.pair ? textOf(a.pair.toolResult.content) : "";
  return {
    ran: Boolean(a.pair && a.idle && a.idle.stop_reason?.type === "end_turn"),
    pkg: text.match(new RegExp(`^pkg_${ENV_PACKAGE.name}=(.*)$`, "m"))?.[1]?.trim(),
    kernel: text.match(/kernel=(\S+)/)?.[1],
  };
}
// Вывод bash первого tool_result после user.message с маркером n (даже без VERIFY_OK).
function firstResultText(events, n) {
  const a = analyzeTurn(events, n);
  return a.results?.length ? textOf(a.results[0].content) : "";
}
const BROKEN_EXEC = /Attach stream error|\[exit -1\]|\[error: /;
const reachable = (code) => /^[23]\d\d$/.test(code ?? "");
// Сетевой ход и ход «alive» в той же сессии. Возвращает код, признак обрыва exec и жива ли VM.
async function networkTurns(sessionId, label, evName) {
  const netN = newNonce();
  const aliveN = newNonce();
  await sendTurn(sessionId, "net", netN);
  let events = await waitTurnIdle(sessionId, netN, TURN_TIMEOUT, `${label}: сеть`);
  await sendTurn(sessionId, "alive", aliveN);
  events = await waitTurnIdle(sessionId, aliveN, TURN_TIMEOUT, `${label}: VM после сети`);
  const file = saveJson(evName, events);
  const netText = firstResultText(events, netN);
  const aliveText = firstResultText(events, aliveN);
  return {
    file,
    code: netText.match(/^net_example=(\d{3})/m)?.[1],
    broken: BROKEN_EXEC.test(netText),
    netText: plain(netText).slice(0, 220),
    alive: aliveText.includes(`VERIFY_OK_${aliveN}`),
    aliveText: plain(aliveText).slice(0, 220),
  };
}
async function sendTurn(sessionId, kind, n) {
  await api("POST", `/v1/sessions/${sessionId}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text: promptFor(kind, n) }] }],
  });
}
// Доступен ли внешний хост с самого хоста: без этого проверка сети VM не имеет базы.
async function hostReach() {
  try {
    const res = await fetch(NET_PROBE_URL, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return String(res.status);
  } catch (error) {
    return `000 (${error.cause?.code ?? error.name})`;
  }
}
const describeNet = (n) => n.broken
  ? `поток exec BoxLite оборвался: «${n.netText}»`
  : `net_example=${n.code ?? "нет строки"}`;

async function waitTurnIdle(sessionId, n, timeout, label) {
  const t0 = Date.now();
  let lastLog = 0;
  for (;;) {
    const events = await listEvents(sessionId);
    const a = analyzeTurn(events, n);
    if (a.idle || a.errors.some((e) => retryType(e) === "exhausted")) return events;
    if (Date.now() - t0 > timeout) {
      throw new Error(`${label}: нет session.status_idle за ${Math.round(timeout / 1000)} с; последние события: ${events.slice(-5).map((e) => e.type).join(", ")}`);
    }
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      log(`${label}: ждём ход, событий ${events.length}, последнее ${events.at(-1)?.type ?? "нет"}`);
    }
    await sleep(2000);
  }
}

async function turnChecks(prefix, events, n, evidenceFile) {
  const a = analyzeTurn(events, n);
  await check(`${prefix}.user_message`, "в журнале есть user.message с маркером хода", () => {
    assert(a.userMessage, `нет user.message с nonce=${n}`);
    return evidenceFile;
  });
  await check(`${prefix}.no_session_error`, "в ходе нет session.error", () => {
    assert(a.errors.length === 0, `session.error: ${JSON.stringify(a.errors.map((e) => e.error ?? e)).slice(0, 400)}`);
    return evidenceFile;
  });
  await check(`${prefix}.tool_use`, "агент вызвал bash (agent.tool_use name=bash)", () => {
    assert(a.toolUses?.length > 0, "нет agent.tool_use с name=bash");
    return `${evidenceFile}: ${a.toolUses.map((t) => JSON.stringify(t.input?.command ?? "")).join("; ").slice(0, 200)}`;
  });
  await check(`${prefix}.tool_result`, `bash вернул VERIFY_OK_${n} без ошибки (agent.tool_result)`, () => {
    assert(a.pair, `нет agent.tool_result с VERIFY_OK_${n}; результаты: ${a.results?.map((r) => textOf(r.content)).join(" | ").slice(0, 400)}`);
    assert(!a.pair.toolResult.is_error, "tool_result.is_error = true");
    return `${evidenceFile}: ${textOf(a.pair.toolResult.content).slice(0, 200)}`;
  });
  if (a.pair) {
    record(`${prefix}.tool_link`, "tool_result.tool_use_id = id события tool_use",
      a.pair.linkedById ? "проверено" : "внимание", evidenceFile,
      a.pair.linkedById ? "" : "связь по id не совпала, пара найдена по порядку событий");
    const noise = textOf(a.pair.toolResult.content).split("\n").filter((l) => /\u001b\[|libcontainer::/.test(l));
    record(`${prefix}.tool_output_clean`, "в выводе bash нет служебных строк рантайма песочницы (ANSI, libcontainer)",
      noise.length === 0 ? "проверено" : "внимание", evidenceFile,
      noise.length === 0 ? "" : `строк ${noise.length}, первая: ${plain(noise[0]).slice(0, 160)}; stderr рантайма VM попадает в tool_result, его видят модель и пользователь`);
  }
  const vmKernel = a.pair ? textOf(a.pair.toolResult.content).match(/kernel=(\S+)/)?.[1] : undefined;
  await check(`${prefix}.in_vm`, "команда выполнена в VM, а не на хосте (ядро VM ≠ ядро хоста)", () => {
    assert(vmKernel, "в выводе bash нет строки kernel=…");
    assert(vmKernel !== HOST_KERNEL, `ядро в песочнице совпало с хостом: ${vmKernel}`);
    return `VM ${vmKernel}, хост ${HOST_KERNEL}`;
  });
  await check(`${prefix}.answer`, FAKE ? `итоговый ответ агента VERIFY_DONE_${n}` : "есть итоговый ответ агента (agent.message)", () => {
    assert(a.lastMessage, "нет agent.message после хода");
    const text = textOf(a.lastMessage.content);
    if (FAKE) assert(text.includes(`VERIFY_DONE_${n}`), `ответ: ${text.slice(0, 200)}`);
    else assert(text.trim().length > 0, "пустой agent.message");
    return `${evidenceFile}: ${text.slice(0, 120)}`;
  });
  await check(`${prefix}.idle_end_turn`, "ход завершён: session.status_idle, stop_reason end_turn", () => {
    assert(a.idle, "нет session.status_idle");
    assert(a.idle.stop_reason?.type === "end_turn", `stop_reason ${JSON.stringify(a.idle.stop_reason)}`);
    return evidenceFile;
  });
  await check(`${prefix}.order`, "порядок: user.message → tool_use → tool_result → agent.message → status_idle", () => {
    assert(a.pair && a.lastMessage && a.idle, "не хватает событий для проверки порядка");
    const order = [a.userMessage, a.pair.toolUse, a.pair.toolResult, a.lastMessage, a.idle].map(a.pos);
    assert(order.every((p, i) => i === 0 || p > order[i - 1]), `позиции ${order.join(",")}`);
    return `позиции в журнале ${order.join(" < ")}`;
  });
  return { a, vmKernel };
}

// ---------------------------------------------------------- файлы прогона ---
function boxliteLog() {
  const homes = [
    { label: "BOXLITE_HOME", dir: join(run.BOXLITE_HOME, "logs") },
    { label: "HOME сервера/.boxlite", dir: join(run.SERVER_HOME, ".boxlite", "logs") },
  ];
  const out = { started: 0, stopped: 0, where: new Set() };
  for (const home of homes) {
    if (!existsSync(home.dir)) continue;
    for (const file of readdirSync(home.dir)) {
      for (const line of readFileSync(join(home.dir, file), "utf8").split("\n")) {
        if (line.slice(0, 19) < run.RUN_STARTED_AT_UTC) continue;
        if (line.includes("Box started successfully")) { out.started++; out.where.add(home.label); }
        if (line.includes("Box stopped")) { out.stopped++; out.where.add(home.label); }
      }
    }
  }
  return { ...out, where: [...out.where] };
}
// Строки «boxlite-shim subprocess spawned box_id=… pid=…» из лога BOXLITE_HOME после старта прогона.
function boxliteShims() {
  const dir = join(run.BOXLITE_HOME, "logs");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir)) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (line.slice(0, 19) < run.RUN_STARTED_AT_UTC) continue;
      const m = line.match(/boxlite-shim subprocess spawned box_id=(\S+) pid=(\d+)/);
      if (m) out.push({ boxId: m[1], pid: Number(m[2]) });
    }
  }
  return out;
}
// Поля /proc/<pid>/stat после «(comm) »: [1] ppid, [19] starttime.
const procStat = (pid) => {
  try {
    const rest = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ");
    return { ppid: Number(rest[1]), start: rest[19] };
  } catch {
    return null;
  }
};
const procComm = (pid) => {
  try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return "?"; }
};
function ancestry(pid) {
  const chain = [];
  for (let p = pid; p > 1 && chain.length < 32; ) {
    chain.push(p);
    const st = procStat(p);
    if (!st) break;
    p = st.ppid;
  }
  return chain;
}
// Потомки сценария (Chromium) пишутся в state/pids с ролью journey-child: cleanup.sh
// остановит их по PID и времени старта, если сценарий убьют по таймауту.
function recordJourneyChildren() {
  const lines = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    const chain = ancestry(pid);
    if (!chain.slice(1).includes(process.pid)) continue;
    const st = procStat(pid);
    if (st) lines.push(`journey-child ${pid} ${st.start}`);
  }
  if (lines.length) appendFileSync(join(RUN_DIR, "state", "pids"), lines.join("\n") + "\n");
  return lines.length;
}
function recordedPid(role) {
  const lines = readFileSync(join(RUN_DIR, "state", "pids"), "utf8").split("\n").filter((l) => l.startsWith(`${role} `));
  return Number(lines.at(-1)?.split(" ")[1] ?? 0);
}
const scratchDirs = (sessionId) => {
  const dir = join(run.SANDBOX_WORKDIR, sessionId, ".openma");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("litebox-scratch-")) : [];
};
const serverLogLines = () => (existsSync(run.SERVER_LOG) ? readFileSync(run.SERVER_LOG, "utf8").split("\n") : []);
function fakeRequests(n) {
  if (!existsSync(run.FAKE_REQUESTS)) return [];
  return readFileSync(run.FAKE_REQUESTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.nonce === n);
}

let vmStarts = 0;
async function sandboxEvidence(prefix, sessionId) {
  vmStarts += 1;
  const minStarted = vmStarts;
  await check(`${prefix}.scratch`, "на хосте есть рабочая папка песочницы сессии (.openma/litebox-scratch-*)", () => {
    const dirs = scratchDirs(sessionId);
    assert(dirs.length > 0, `нет ${join(run.SANDBOX_WORKDIR, sessionId, ".openma", "litebox-scratch-*")}`);
    return join(run.SANDBOX_WORKDIR, sessionId, ".openma", dirs[0]);
  });
  await check(`${prefix}.boxlite_started`, `BoxLite записал старт VM (Box started successfully ≥ ${minStarted} с начала прогона)`, () => {
    const b = boxliteLog();
    assert(b.started >= minStarted, `стартов VM в логах BoxLite: ${b.started}`);
    return `стартов ${b.started}, лог: ${b.where.join(", ")}`;
  });
  const b = boxliteLog();
  if (b.where.includes("HOME сервера/.boxlite")) {
    record(`${prefix}.boxlite_home`, "BoxLite писал в BOXLITE_HOME прогона", "внимание", "",
      `записи найдены в ${run.SERVER_HOME}/.boxlite: переменная BOXLITE_HOME не учтена, но кэш всё равно не общий ~/.boxlite`);
  }
  await check(`${prefix}.vm_process`, "VM-процесс boxlite-shim (pid из лога BoxLite) жив и запущен нашим сервером (потомок server-node)", () => {
    const shims = boxliteShims();
    assert(shims.length >= minStarted, `строк «boxlite-shim subprocess spawned» после старта прогона: ${shims.length}`);
    const last = shims.at(-1);
    const serverNode = recordedPid("server-node");
    const chain = ancestry(last.pid);
    assert(chain.length > 0 && procStat(last.pid), `процесса ${last.pid} (box ${last.boxId}) нет`);
    assert(chain.includes(serverNode), `цепочка ${chain.join(" <- ")} не содержит server-node ${serverNode}`);
    return `box ${last.boxId}: ${chain.map((p) => `${p}(${procComm(p)})`).join(" <- ")}`;
  });
  // litebox-sandbox пишет «creating box (image=…)» модульным логгером, но на main-node
  // этот логгер — заглушка: модуль адаптера грузится в components.ts:90 раньше
  // setRootLogger (modules/node-foundation.ts:98), а getLogger вызывается при импорте (litebox.ts:34).
  const creatingBox = serverLogLines().filter((l) => l.includes("creating box (image=")).length;
  record(`${prefix}.server_log_box`, "в логе сервера есть «creating box (image=…)» от litebox-sandbox",
    creatingBox >= minStarted ? "проверено" : "внимание", run.SERVER_LOG,
    creatingBox >= minStarted ? "" : `строк ${creatingBox}: логгер litebox-sandbox на main-node не подключён (litebox.ts:34, components.ts:90 раньше node-foundation.ts:98); старт VM доказан проверкой ${prefix}.vm_process`);
}

async function archiveAndProveStop(prefix, sessionId) {
  const before = boxliteLog().stopped;
  const archived = await api("POST", `/v1/sessions/${sessionId}/archive`);
  saveJson(`${prefix}-archived`, archived);
  let state = { scratch: scratchDirs(sessionId), stopped: before };
  for (let i = 0; i < 60; i++) {
    state = { scratch: scratchDirs(sessionId), stopped: boxliteLog().stopped };
    if (state.scratch.length === 0 && state.stopped > before) break;
    await sleep(1000);
  }
  await check(`${prefix}.archived`, "сессия в архиве (archived_at задан)", () => {
    assert(archived?.archived_at, "archived_at пустой");
    return `api/${prefix}-archived.json`;
  });
  await check(`${prefix}.vm_stopped`, "после архива VM остановлена (BoxLite: Box stopped) и scratch удалён", () => {
    assert(state.stopped > before, `новых «Box stopped» нет (было ${before}, стало ${state.stopped})`);
    assert(state.scratch.length === 0, `scratch остался: ${state.scratch.join(", ")}`);
    return `Box stopped: ${before} → ${state.stopped}`;
  });
}

// --------------------------------------------------------------- браузер ---
function pickChromium() {
  if (process.env.VERIFY_CHROMIUM) return process.env.VERIFY_CHROMIUM;
  const own = chromium.executablePath();
  if (existsSync(own)) return own;
  const cache = join(os.homedir(), ".cache", "ms-playwright");
  const revs = existsSync(cache)
    ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  const complete = revs.filter((d) => existsSync(join(cache, d, "INSTALLATION_COMPLETE")));
  for (const d of [...complete, ...revs]) {
    const exe = join(cache, d, "chrome-linux64", "chrome");
    if (existsSync(exe)) return exe;
  }
  if (existsSync("/usr/bin/google-chrome-stable")) return "/usr/bin/google-chrome-stable";
  throw new Error("не найден Chromium: задайте VERIFY_CHROMIUM или выполните в platform: pnpm exec playwright install chromium");
}
const nav = (name) => page.getByRole("navigation", { name: "Разделы консоли" }).getByRole("link", { name, exact: true });
const tableRow = (text) => page.locator('[data-testid="data-body-table"] tr[data-slot="table-row"]', { hasText: text });

// Открыть раздел и дождаться его содержимого, а не только URL: клиентский роутер меняет
// URL раньше, чем перерисует страницу (из-за этого скриншоты «до действия» снимали прошлый экран).
async function openSection(name, emptyText) {
  await nav(name).click();
  await page.getByRole("main").getByRole("heading", { level: 1, name, exact: true }).waitFor();
  const empty = page.getByText(emptyText, { exact: true });
  await empty.or(page.locator('[data-testid="data-body-table"] tr[data-slot="table-row"]')).first().waitFor();
  return (await empty.count()) > 0;
}

async function pickCombobox(dialog, index, id) {
  const box = dialog.getByRole("combobox").nth(index);
  await box.click();
  const option = page.locator('[data-slot="command-item"]').filter({ hasText: id }).first();
  await option.waitFor({ timeout: 15_000 });
  await option.click();
  await box.filter({ hasText: id }).waitFor({ timeout: 10_000 });
}

// ------------------------------------------------------------------ шаги ---
async function stepLogin() {
  await page.goto(`${BASE}/login`);
  await page.getByRole("button", { name: "Продолжить с почтой" }).click();
  await page.locator("#auth-email").fill(user.email);
  await page.locator("#auth-password").fill(user.password);
  await shot("login-form");
  await page.getByRole("group", { name: "Действия входа" }).getByRole("button", { name: "Войти", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  await page.getByRole("navigation", { name: "Разделы консоли" }).waitFor();
  await page.getByRole("main").getByRole("heading", { level: 1 }).first().waitFor();
  await shot("after-login");
  await check("auth.cookie", "после входа в браузере есть cookie better-auth.session_token", async () => {
    const cookies = await context.cookies(BASE);
    assert(cookies.some((c) => c.name === "better-auth.session_token"), "cookie нет");
    return "context.cookies()";
  });
  const authSession = await api("GET", "/auth/get-session");
  saveJson("02-get-session-browser", { user: authSession?.user ?? null, session: { userId: authSession?.session?.userId ?? null } });
  const me = await api("GET", "/v1/oma/me");
  saveJson("02-me-browser", me);
  await check("auth.me", "сессия браузера = тестовая учётка (почта и id в Better Auth) в своём рабочем пространстве", () => {
    assert(authSession?.user?.email === user.email, `почта в /auth/get-session: ${authSession?.user?.email}`);
    assert(authSession?.user?.id === user.user_id, `user.id в /auth/get-session: ${authSession?.user?.id}`);
    assert(me.user?.id === user.user_id, `user.id в /v1/oma/me: ${me.user?.id}`);
    assert(me.tenant?.id === user.tenant_id, `tenant ${me.tenant?.id}`);
    return "api/02-get-session-browser.json, api/02-me-browser.json";
  });
  record("auth.me_email", "/v1/oma/me отдаёт почту пользователя",
    me.user?.email === user.email ? "проверено" : "внимание", "api/02-me-browser.json",
    me.user?.email === user.email ? "" : "email пустой: main-node подключает buildMeRoutes без loadUser (apps/main-node/src/modules/node-http.ts:444-475)");
}

async function stepCreateEnvironment() {
  const wasEmpty = await openSection("Окружения", "Окружений пока нет");
  await shot("environments-list");
  await check("env.list_empty", "на старте список окружений пуст: видно «Окружений пока нет»", () => {
    assert(wasEmpty, "пустого состояния нет: в свежей базе уже есть окружения");
    return screens.at(-1).file;
  });
  await page.getByRole("button", { name: "Новое окружение" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новое окружение" });
  await dialog.waitFor();
  await dialog.getByLabel("Название", { exact: true }).fill(names.env);
  await dialog.getByLabel("Описание (необязательно)").fill(`verify-agent-console ${run.RUN_ID}`);
  await shot("environment-create-dialog");
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  const row = tableRow(names.env);
  await row.waitFor({ timeout: 15_000 });
  await shot("environment-listed");
  cover("env-create");

  const list = await api("GET", "/v1/environments?limit=100");
  const matches = (list.data ?? []).filter((e) => e.name === names.env);
  assert(matches.length === 1, `окружений с именем ${names.env}: ${matches.length}`);
  ids.environment = matches[0].id;
  created.environments.push(ids.environment);
  saveCreated();
  const env = await api("GET", `/v1/environments/${ids.environment}`);
  saveJson("10-environment", env);
  await check("env.created", "окружение сохранено: GET /v1/environments/:id, cloud, без архива", () => {
    assert(env.name === names.env, `name ${env.name}`);
    assert(env.config?.type === "cloud", `config.type ${env.config?.type}`);
    assert(env.archived_at === null, "окружение в архиве");
    return "api/10-environment.json";
  });
  record("env.networking_default", "сеть нового окружения по умолчанию unrestricted",
    env.config?.networking?.type === "unrestricted" ? "проверено" : "внимание", "api/10-environment.json");

  await row.click();
  await page.waitForURL(new RegExp(`/environments/${ids.environment}$`));
  await page.getByRole("heading", { level: 1, name: names.env }).first().waitFor();
  await shot("environment-detail");
  const ariaFile = await aria("environment-detail");
  await check("env.detail_ui", "карточка окружения в консоли показывает созданное окружение", async () => {
    assert((await page.locator("#env-name").inputValue()) === names.env, "в #env-name другое значение");
    return ariaFile;
  });
  const probeButtons = await page.getByRole("button", { name: /провер|запуст|тест/i }).count();
  record("env.no_check_action", "в консоли нет действия «проверить окружение» и статуса (пробел продукта)",
    probeButtons === 0 ? "проверено" : "внимание", ariaFile,
    probeButtons === 0 ? "поэтому работа окружения доказывается шагом env.probe через сессию" : `найдено кнопок: ${probeButtons}, обновите карту функций`);
}

const PROBE_SYSTEM = "Ты технический агент проверки окружения. Выполняй присланную команду инструментом bash и коротко отвечай.";
async function ensureProbeAgent() {
  if (ids.probeAgent) return ids.probeAgent;
  const agent = await api("POST", "/v1/agents", {
    name: names.probeAgent,
    model: MODEL,
    system: PROBE_SYSTEM,
    tools: [{
      type: "agent_toolset_20260401",
      default_config: { enabled: false },
      configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_allow" } }],
    }],
  });
  ids.probeAgent = agent.id;
  created.agents.push(agent.id);
  saveCreated();
  return agent.id;
}
async function startProbeSession(title) {
  const agentId = await ensureProbeAgent();
  const session = await api("POST", "/v1/sessions", { agent: agentId, environment_id: ids.environment, title });
  created.sessions.push(session.id);
  saveCreated();
  return session;
}

async function stepProbeEnvironment() {
  // Обходной путь: в API и консоли нет проверки окружения, песочница ленивая
  // (apps/main-node/src/lib/node-session-router.ts:41). Технический агент по API,
  // сессия на этом окружении и одна команда bash доказывают, что VM поднимается.
  const session = await startProbeSession(names.probeSession);
  ids.probeSession = session.id;
  saveJson("20-probe-session-created", session);
  record("env.lazy_sandbox", "до первого сообщения песочница не создана (папка сессии отсутствует)",
    existsSync(join(run.SANDBOX_WORKDIR, session.id)) ? "внимание" : "проверено", run.SANDBOX_WORKDIR);

  await sendTurn(session.id, "probe", probeNonce);
  log(`проба окружения: сессия ${session.id}, первый старт VM может скачивать образ ${run.SANDBOX_IMAGE}`);
  const events = await waitTurnIdle(session.id, probeNonce, FIRST_TURN_TIMEOUT, "проба окружения");
  const evFile = saveJson("21-probe-session-events", events);
  const { vmKernel } = await turnChecks("env.probe", events, probeNonce, evFile);
  ids.probeVmKernel = vmKernel;
  cover("env-probe");
  await sandboxEvidence("env.probe", session.id);
  ids.baseline = probeFacts(events, probeNonce);
  record("env.probe.baseline", `до настроек пакета ${ENV_PACKAGE.manager} ${ENV_PACKAGE.name} в образе нет (база для env.packages_applied)`,
    ids.baseline.pkg === "missing" ? "проверено" : "внимание", evFile, `pkg_${ENV_PACKAGE.name}=${ids.baseline.pkg ?? "?"}`);
  if (FAKE) {
    const reqs = fakeRequests(probeNonce);
    await check("env.probe.fake_model", "фейковая модель: tool_use, затем текст после результата с маркером", () => {
      assert(reqs.map((r) => r.decision).join(",") === "tool_use,final_text", `решения: ${reqs.map((r) => r.decision).join(",")}`);
      assert(reqs[1].tool_result_has_marker === true, "в результате bash, который видела модель, нет маркера");
      return "api/fake-model-requests.jsonl";
    });
  }
  await page.goto(`${BASE}/sessions/${session.id}`);
  await check("env.probe.ui_visible", "сессия пробы видна в консоли: реплика с маркером и ответ VERIFY_DONE (история из GET /events)", async () => {
    const turn = page.locator("article[data-turn-id]").last();
    await turn.locator("[data-session-turn-answer]", { hasText: `VERIFY_DONE_${probeNonce}` }).first().waitFor({ timeout: 30_000 });
    await turn.locator("[data-session-turn-prompt]", { hasText: `nonce=${probeNonce}` }).first().waitFor({ timeout: 5_000 });
    return shot("probe-session-in-console");
  });
  // Сеть при настройке по умолчанию («Без ограничений»): внешний хост должен быть доступен,
  // а VM должна отвечать и после запроса.
  ids.hostNet = await hostReach();
  const net = await networkTurns(session.id, "проба сети", "21b-probe-network-events");
  ids.baselineNet = net;
  if (!reachable(ids.hostNet)) {
    record("env.probe.network", `сеть «Без ограничений»: ${NET_PROBE_URL} доступен из VM, VM работает после запроса`, "не проверено", net.file,
      `с хоста ${NET_PROBE_URL} недоступен (${ids.hostNet}): сравнивать не с чем; из VM: ${describeNet(net)}`);
  } else {
    await check("env.probe.network", `сеть «Без ограничений»: ${NET_PROBE_URL} доступен из VM (с хоста код ${ids.hostNet}), VM работает после запроса`, () => {
      assert(reachable(net.code), `из VM: ${describeNet(net)}`);
      assert(net.alive, `VM после сетевого запроса не отвечает: «${net.aliveText}»`);
      return `${net.file}: net_example=${net.code}`;
    });
  }
  if (!KEEP_SESSION) await archiveAndProveStop("env.probe", session.id);
}

async function stepConfigureEnvironment() {
  // Карточка окружения (env-detail): описание, сеть «Ограниченный» без разрешённых хостов
  // (менеджерам пакетов сеть разрешена) и пакет apt jq. Затем сверка через API.
  await openSection("Окружения", "Окружений пока нет");
  await shot("environments-list-with-env");
  await tableRow(names.env).click();
  await page.waitForURL(new RegExp(`/environments/${ids.environment}$`));
  await page.getByRole("heading", { level: 1, name: names.env }).first().waitFor();
  const description = `verify-agent-console ${run.RUN_ID}: настройки ${settingsNonce}`;
  await page.locator("#env-description").fill(description);
  await page.getByRole("combobox", { name: "Тип доступа" }).click();
  await page.getByRole("option", { name: "Ограниченный", exact: true }).click();
  const pmSwitch = page.getByRole("switch", { name: "Разрешить сетевой доступ менеджерам пакетов" });
  if ((await pmSwitch.getAttribute("aria-checked")) !== "true") await pmSwitch.click();
  await page.getByRole("button", { name: "Добавить пакет" }).click();
  await page.getByRole("combobox", { name: "Менеджер пакетов" }).last().click();
  await page.getByRole("option", { name: ENV_PACKAGE.manager, exact: true }).click();
  await page.getByRole("textbox", { name: "Пакеты и версии" }).last().fill(ENV_PACKAGE.name);
  await shot("environment-settings-filled");
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await page.getByText("Окружение сохранено", { exact: true }).first().waitFor({ timeout: 15_000 });
  await shot("environment-saved");
  const ariaFile = await aria("environment-saved");
  const env = await api("GET", `/v1/environments/${ids.environment}`);
  saveJson("12-environment-configured", env);
  await check("env.settings_saved", `карточка окружения сохранила описание, сеть limited и пакет ${ENV_PACKAGE.manager} ${ENV_PACKAGE.name} (GET /v1/environments/:id)`, () => {
    const net = env.config?.networking ?? {};
    assert(env.description === description, `description ${JSON.stringify(env.description)}`);
    assert(net.type === "limited", `networking.type ${net.type}`);
    assert(net.allow_package_managers === true, `allow_package_managers ${net.allow_package_managers}`);
    assert(Array.isArray(net.allowed_hosts) && net.allowed_hosts.length === 0, `allowed_hosts ${JSON.stringify(net.allowed_hosts)}`);
    assert((env.config?.packages?.[ENV_PACKAGE.manager] ?? []).includes(ENV_PACKAGE.name), `packages ${JSON.stringify(env.config?.packages)}`);
    return `api/12-environment-configured.json, ${ariaFile}`;
  });
  cover("env-detail");
}

async function stepProbeSettings() {
  // Новая сессия на том же окружении: песочница создаётся заново и должна учесть настройки.
  const session = await startProbeSession(names.settingsSession);
  ids.settingsSession = session.id;
  await sendTurn(session.id, "probe", settingsNonce);
  const events = await waitTurnIdle(session.id, settingsNonce, TURN_TIMEOUT, "проба настроек окружения");
  const evFile = saveJson("22-settings-probe-events", events);
  const facts = probeFacts(events, settingsNonce);
  ids.settingsFacts = facts;
  await check("env.settings_probe.ran", "сессия на настроенном окружении выполнила bash в VM и завершила ход", () => {
    assert(facts.ran, `нет tool_result с VERIFY_OK_${settingsNonce} или end_turn; события: ${events.map((e) => e.type).join(", ").slice(0, 300)}`);
    assert(facts.kernel && facts.kernel !== HOST_KERNEL, `kernel=${facts.kernel}`);
    return `${evFile}: pkg_${ENV_PACKAGE.name}=${facts.pkg ?? "?"}, kernel=${facts.kernel}`;
  });
  if (facts.ran) vmStarts += 1;
  const base = ids.baseline ?? {};
  if (!facts.ran) {
    record("env.packages_applied", `пакет ${ENV_PACKAGE.manager} ${ENV_PACKAGE.name} из настроек окружения установлен в VM`, "не проверено", evFile, "проба после настроек не выполнилась");
    record("env.networking_limited_applied", "сеть «Ограниченный» без разрешённых хостов закрывает внешний хост в VM", "не проверено", evFile, "проба после настроек не выполнилась");
  } else {
    if (base.pkg !== "missing") {
      record("env.packages_applied", `пакет ${ENV_PACKAGE.manager} ${ENV_PACKAGE.name} из настроек окружения установлен в VM`, "не проверено", evFile,
        `до настроек pkg_${ENV_PACKAGE.name}=${base.pkg ?? "?"}: пакет уже был в образе или проба не дала базы, выберите другой пакет`);
    } else {
      await check("env.packages_applied", `пакет ${ENV_PACKAGE.manager} ${ENV_PACKAGE.name} из настроек окружения установлен в VM новой сессии`, () => {
        assert(facts.pkg === "install ok installed",
          `pkg_${ENV_PACKAGE.name}=${facts.pkg}: пакеты окружения на main-node не ставятся; установка (ensureSetupApplied) вызывается только в Cloudflare SessionDO (apps/agent/src/runtime/session-do.ts:3608), в apps/main-node ссылок на неё нет`);
        return evFile;
      });
    }
    const net = await networkTurns(session.id, "проба сети после настроек", "22b-settings-network-events");
    const title = `сеть «Ограниченный» без разрешённых хостов: ${NET_PROBE_URL} из VM недоступен (curl даёт 000), VM работает после запроса`;
    if (!reachable(ids.hostNet)) {
      record("env.networking_limited_applied", title, "не проверено", net.file,
        `с хоста ${NET_PROBE_URL} недоступен (${ids.hostNet}): блокировку не отличить от отсутствия сети; из VM: ${describeNet(net)}`);
    } else {
      await check("env.networking_limited_applied", title, () => {
        const baseNote = ids.baselineNet ? `; при «Без ограничений» было: ${describeNet(ids.baselineNet)}` : "";
        assert(!reachable(net.code),
          `net_example=${net.code}: VM ходит во внешнюю сеть; LiteBox всегда создаётся с network: { mode: "enabled" } (packages/sandbox-adapter-litebox/src/litebox.ts:325)`);
        assert(!net.broken && net.code === "000",
          `${describeNet(net)}: блокировку не увидеть, запрос рвёт VM${baseNote}; LiteBox создаётся с network: { mode: "enabled" } независимо от настроек (litebox.ts:325)`);
        assert(net.alive, `VM после сетевого запроса не отвечает: «${net.aliveText}»`);
        return `${net.file}: net_example=${net.code}`;
      });
    }
  }
  if (facts.ran) cover("env-packages", "env-networking");
  if (!KEEP_SESSION) await archiveAndProveStop("env.settings_probe", session.id);
  // Технический агент больше не нужен: в архиве он не виден в списке «Агенты»,
  // и UI-шаг агентов идёт по пустому списку, как у нового пользователя.
  const archivedAgent = await api("POST", `/v1/agents/${ids.probeAgent}/archive`);
  saveJson("23-probe-agent-archived", archivedAgent);
  record("env.probe_agent_archived", "технический агент пробы в архиве (до UI-шага агентов)",
    archivedAgent?.archived_at ? "проверено" : "внимание", "api/23-probe-agent-archived.json");
}

async function stepCreateAgent() {
  const wasEmpty = await openSection("Агенты", "Агентов пока нет");
  await shot("agents-list");
  await check("agent.list_empty", "до создания список агентов пуст: видно «Агентов пока нет» (технический агент пробы в архиве)", () => {
    assert(wasEmpty, "в списке агентов есть строки");
    return screens.at(-1).file;
  });
  await page.getByRole("button", { name: "Новый агент" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новый агент" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: /^Пустой агент/ }).first().waitFor();
  await shot("agent-templates");
  await dialog.getByRole("button", { name: /^Пустой агент/ }).click();
  cover("agent-template");
  await page.locator("#agent-name").fill(names.agent);
  await page.locator("#agent-system").fill("Ты агент проверки. Выполняй присланную команду инструментом bash и отвечай ровно той строкой, которую просит пользователь.");
  const noCards = await dialog.getByText("Карточки моделей не настроены").count();
  const modelGroup = await dialog.getByRole("group", { name: "Модель" }).count();
  await shot("agent-form-basic");
  cover("agent-form");
  record("agent.form_without_model_cards", "в режиме «Форма» можно задать модель агента",
    noCards === 0 && modelGroup > 0 ? "проверено" : "внимание", screens.at(-1).file,
    noCards === 0 && modelGroup > 0 ? "" : "карточек моделей нет: группы «Модель» в форме нет (AgentFormDialog.tsx:725-736), шаблоны дают model: \"\" (data/templates.ts:17), поэтому агента создать можно только через YAML/JSON или после создания карточки");
  await dialog.getByRole("tab", { name: /^Инструменты/ }).click();
  await dialog.getByRole("tabpanel").filter({ hasText: /bash/ }).first().waitFor();
  await shot("agent-form-tools");
  cover("agent-tools");
  // Без карточек моделей в форме нет поля модели, поэтому модель задаётся в режиме YAML той же формы.
  await dialog.getByRole("group", { name: "Режим правки" }).getByRole("button", { name: "YAML", exact: true }).click();
  const editor = dialog.getByRole("textbox", { name: "Конфигурация агента в формате YAML" });
  const yaml = await editor.inputValue();
  const nextYaml = /^model:.*$/m.test(yaml) ? yaml.replace(/^model:.*$/m, `model: ${MODEL}`) : `model: ${MODEL}\n${yaml}`;
  await editor.fill(nextYaml);
  writeFileSync(join(EV, "api", "30-agent-create.yaml"), nextYaml);
  await shot("agent-form-yaml");
  cover("agent-code");
  await dialog.getByRole("button", { name: "Создать агента", exact: true }).click();
  try {
    await page.waitForURL(/\/agents\/[^/]+$/, { timeout: 30_000 });
  } catch {
    const alert = await dialog.getByRole("alert").first().textContent().catch(() => null);
    throw new Error(`агент не создан${alert ? `: ${alert}` : ""}`);
  }
  ids.agent = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  created.agents.push(ids.agent);
  saveCreated();
  await page.getByRole("heading", { level: 1, name: names.agent }).first().waitFor();
  await shot("agent-detail");
  const ariaFile = await aria("agent-detail");
  cover("agent-detail");
  const agent = await api("GET", `/v1/agents/${ids.agent}`);
  saveJson("31-agent", agent);
  await check("agent.created", "агент сохранён: имя, модель, системный промпт", () => {
    const modelId = typeof agent.model === "string" ? agent.model : agent.model?.id;
    assert(agent.name === names.agent, `name ${agent.name}`);
    assert(modelId === MODEL, `model ${JSON.stringify(agent.model)}`);
    assert(String(agent.system ?? "").includes("агент проверки"), "system не тот");
    return "api/31-agent.json";
  });
  await check("agent.bash_enabled", "у агента включён набор инструментов и bash не отключён", () => {
    const toolset = (agent.tools ?? []).find((t) => t.type === "agent_toolset_20260401");
    assert(toolset, "нет agent_toolset_20260401");
    const bash = (toolset.configs ?? []).find((c) => c.name === "bash");
    const enabled = bash?.enabled ?? toolset.default_config?.enabled ?? true;
    assert(enabled !== false, "bash отключён");
    return "api/31-agent.json";
  });
  await check("agent.detail_ui", "карточка агента в консоли показывает модель", async () => {
    const props = page.getByRole("region", { name: "Свойства агента" }).first();
    assert((await props.textContent())?.includes(MODEL), "в «Свойства агента» нет модели");
    return ariaFile;
  });
  record("agent.no_environment_field", "окружение выбирается в сессии, у агента его нет (поля в форме нет)",
    JSON.stringify(agent).includes("environment") ? "внимание" : "проверено", "api/31-agent.json");
}

async function stepCreateSession() {
  await openSection("Сессии", "Сессий пока нет");
  await shot("sessions-list");
  await page.getByRole("button", { name: "Новая сессия" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новая сессия" });
  await dialog.waitFor();
  await pickCombobox(dialog, 0, ids.agent);
  await pickCombobox(dialog, 1, ids.environment);
  await dialog.locator("#session-title").fill(names.session);
  await shot("session-create-dialog");
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  ids.session = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  created.sessions.push(ids.session);
  saveCreated();
  const heading = page.getByRole("main").getByRole("heading", { level: 1 }).first();
  await heading.waitFor();
  await page.getByRole("textbox", { name: "Сообщение" }).waitFor();
  await shot("session-new");
  cover("session-create");
  const session = await api("GET", `/v1/sessions/${ids.session}`);
  saveJson("40-session-created", session);
  await check("session.created", "сессия создана с этим агентом и этим окружением", () => {
    assert(session.agent?.id === ids.agent, `agent ${session.agent?.id}`);
    assert(session.environment_id === ids.environment, `environment_id ${session.environment_id}`);
    assert(session.archived_at === null, "сессия в архиве");
    return "api/40-session-created.json";
  });
  const headingText = (await heading.textContent())?.trim() ?? "";
  await check("session.title_saved", "название из окна «Новая сессия» сохранено (API title и h1 страницы)", () => {
    assert(session.title === names.session && headingText === names.session,
      `API title=${JSON.stringify(session.title)}, h1=${JSON.stringify(headingText)}; введено ${names.session}. ` +
      "Вероятная причина: SessionsList.tsx:865-867 переопределяет name у {...register(\"title\")}, а onChange react-hook-form ищет поле по event.target.name");
    return "api/40-session-created.json";
  });
  const statusPill = await page.getByText(/^(Ожидает|Выполняется)$/).first().textContent().catch(() => null);
  record("session.initial_status", "новая сессия без сообщений в статусе idle («Ожидает»)",
    session.status === "idle" ? "проверено" : "внимание", "api/40-session-created.json",
    session.status === "idle" ? "" : `status=${session.status}, в шапке «${statusPill ?? "?"}»: сервер создаёт сессию со status "running" (packages/managed-agents-application/src/sessions/application.ts:322), консоль показывает «Агент работает…» и кнопку «Поставить сообщение в очередь»`);
  await check("session.header_ui", "в шапке сессии видны агент и окружение", async () => {
    const agentBadge = page.locator(`[title="Агент: ${names.agent}"], [title="Агент: ${ids.agent}"]`);
    const envBadge = page.locator(`[title="Окружение: ${names.env}"], [title="Окружение: ${ids.environment}"]`);
    assert((await agentBadge.count()) > 0, "нет бейджа агента");
    assert((await envBadge.count()) > 0, "нет бейджа окружения");
    return "screens: session-new";
  });
}

async function stepAgentTurn() {
  const box = page.getByRole("textbox", { name: "Сообщение" });
  const prompt = promptFor("run", nonce);
  await box.fill(prompt);
  await shot("turn-typed");
  // Подпись кнопки зависит от статуса сессии (SessionComposer.tsx:163-166): при status=running
  // это «Поставить сообщение в очередь». Нажимаем ту кнопку, которую видит пользователь.
  const sendButton = page.getByRole("button", { name: /^(Отправить сообщение|Поставить сообщение в очередь)$/ }).first();
  await sendButton.waitFor();
  const sendLabel = await sendButton.getAttribute("aria-label");
  record("run.ui_send_label", "кнопка отправки в новой сессии называется «Отправить сообщение»",
    sendLabel === "Отправить сообщение" ? "проверено" : "внимание", screens.at(-1).file,
    sendLabel === "Отправить сообщение" ? "" : `подпись «${sendLabel}»: консоль считает новую сессию выполняющейся (см. session.initial_status)`);
  // Тот же поток событий, что слушает консоль: что приходит вживую после отправки.
  const stream = await captureStream(ids.session);
  await sendButton.click();
  cover("session-turn");
  // Отправка очищает поле ввода: ждём этого, чтобы снимок показывал состояние после действия.
  for (let i = 0; i < 20 && (await box.inputValue()) !== ""; i++) await sleep(250);
  await shot("turn-sent");
  const promptInTurn = page.locator("article[data-turn-id] [data-session-turn-prompt]", { hasText: `nonce=${nonce}` });
  await check("run.ui_prompt_on_send", "после отправки реплика пользователя видна в ходе разговора ([data-session-turn-prompt] с маркером)", async () => {
    try {
      await promptInTurn.first().waitFor({ timeout: 15_000 });
    } catch {
      const anywhere = await page.getByText(`VERIFY_AGENT_RUN nonce=${nonce}`).count();
      throw new Error(`за 15 с после отправки в article[data-turn-id] нет [data-session-turn-prompt] с nonce=${nonce}; текст промпта на странице встречается ${anywhere} раз`);
    }
    return shot("turn-prompt-visible");
  });
  const events = await waitTurnIdle(ids.session, nonce, TURN_TIMEOUT, "ход агента");
  const evFile = saveJson("41-session-events", events);
  const { vmKernel } = await turnChecks("run", events, nonce, evFile);
  ids.vmKernel = vmKernel;

  const article = page.locator("article[data-turn-id]").last();
  await check("run.ui_turn_done", "в разговоре ход завершён и виден ответ агента", async () => {
    await article.waitFor({ timeout: 60_000 });
    const t0 = Date.now();
    let status = await article.getAttribute("data-session-turn-status");
    while (/^(running|queued)$/.test(status ?? "running") && Date.now() - t0 < 60_000) {
      await sleep(1000);
      status = await article.getAttribute("data-session-turn-status");
    }
    assert(/^complete(d)?$/.test(status ?? ""), `data-session-turn-status=${status}`);
    const answer = article.locator("[data-session-turn-answer]").first();
    await answer.waitFor({ timeout: 30_000 });
    if (FAKE) assert((await answer.textContent())?.includes(`VERIFY_DONE_${nonce}`), "в ответе нет VERIFY_DONE");
    return `${await shot("turn-done")}, ${await aria("turn-done")}`;
  });
  await check("run.ui_prompt_visible", "после завершения хода реплика пользователя видна в этом ходе ([data-session-turn-prompt] с маркером)", async () => {
    const count = await article.locator("[data-session-turn-prompt]", { hasText: `nonce=${nonce}` }).count();
    assert(count > 0, `в завершённом ходе нет [data-session-turn-prompt] с nonce=${nonce} (см. aria/*-turn-done.yml)`);
    return "aria/*-turn-done.yml";
  });
  await sleep(1000);
  await stream.stop();
  const sseFile = saveJson("41-session-stream", stream.seen);
  const sseUser = stream.seen.events.filter((e) => e.type === "user.message" && String(e.text).includes(`nonce=${nonce}`));
  const sseTypes = [...new Set(stream.seen.events.map((e) => e.type ?? e.sse))];
  record("run.sse_user_message", "поток /events/stream после отправки отдаёт user.message с маркером (консоль строит ход из потока)",
    sseUser.length > 0 ? "проверено" : "внимание", sseFile,
    sseUser.length > 0 ? "" : `HTTP ${stream.seen.status}, событий ${stream.seen.events.length}, типы: ${sseTypes.join(", ") || "нет"}${stream.seen.error ? `, ошибка ${stream.seen.error}` : ""}`);

  await check("run.ui_tool_card", "в разговоре раскрывается карточка bash с выводом команды", async () => {
    const reasoning = article.locator("[data-chat-reasoning-trigger]").first();
    if ((await reasoning.count()) && (await reasoning.getAttribute("aria-expanded")) !== "true") await reasoning.click();
    const group = article.getByRole("button", { name: /^Использовано \d+ инструмент/ }).first();
    if (await group.count()) await group.click();
    const trigger = article.locator('[data-slot="collapsible-trigger"]', { hasText: "bash" }).first();
    await trigger.waitFor({ timeout: 15_000 });
    if ((await trigger.getAttribute("data-state")) !== "open") await trigger.click();
    await article.locator('[data-slot="collapsible-content"]', { hasText: `VERIFY_OK_${nonce}` }).first().waitFor({ timeout: 15_000 });
    return shot("turn-tool-card");
  });
  cover("session-tool-card");
  await check("run.ui_tool_output_text", "вывод bash в карточке показан текстом: kernel= на своей строке, без JSON-обёртки content-блоков и литералов \\n", async () => {
    const content = article.locator('[data-slot="collapsible-content"]', { hasText: `VERIFY_OK_${nonce}` }).last();
    const text = await content.innerText();
    writeFileSync(join(EV, "api", "45-tool-card-text.txt"), text);
    const problems = [];
    if (/"type":\s*"text"/.test(text)) problems.push("виден JSON-массив content-блоков (\"type\": \"text\")");
    if (text.includes("\\n")) problems.push("литералы \\n вместо переносов");
    if (text.includes("\\u001b")) problems.push("литералы \\u001b (ANSI)");
    if (!text.split("\n").some((line) => line.trim().startsWith("kernel="))) problems.push("kernel= не на отдельной строке");
    assert(problems.length === 0, `${problems.join("; ")} (api/45-tool-card-text.txt). Причина: CanonicalSessionTurn.tsx:140-147 делает JSON.stringify(rawOutput) для массива content-блоков, а ai-elements/tool.tsx:187-209 показывает строку, начинающуюся с «[», как JSON`);
    return "api/45-tool-card-text.txt";
  });
  await check("run.ui_timeline", "на вкладке «Хронология» есть строка bash", async () => {
    await page.getByRole("tab", { name: "Хронология" }).click();
    await page.locator('[title^="bash · "]').first().waitFor({ timeout: 15_000 });
    const file = await shot("timeline");
    await page.getByRole("tab", { name: "Разговор" }).click();
    return file;
  });
  cover("session-timeline");
  const filename = `verify-${nonce}.txt`;
  await check("run.ui_files", `в панели «Файлы сессии» есть ${filename}`, async () => {
    await page.getByRole("button", { name: "Файлы сессии" }).click();
    await page.getByRole("complementary", { name: "Файлы сессии" }).getByRole("link", { name: filename }).waitFor({ timeout: 15_000 });
    return shot("session-files");
  });
  cover("session-files");
  await check("run.ui_prompt_after_reload", "после перезагрузки страницы реплика пользователя видна в ходе (история из GET /events)", async () => {
    await page.reload();
    await page.locator("article[data-turn-id] [data-session-turn-prompt]", { hasText: `nonce=${nonce}` }).first().waitFor({ timeout: 30_000 });
    return shot("turn-after-reload");
  });

  const session = await api("GET", `/v1/sessions/${ids.session}`);
  saveJson("42-session-final", session);
  await check("run.session_idle", "GET /v1/sessions/:id: status idle после хода", () => {
    assert(session.status === "idle", `status ${session.status}`);
    return "api/42-session-final.json";
  });
  const outputs = await api("GET", `/v1/sessions/${ids.session}/outputs`);
  saveJson("43-session-outputs", outputs);
  await check("run.outputs_api", `GET /v1/sessions/:id/outputs содержит ${filename}`, () => {
    assert((outputs.data ?? []).some((f) => f.filename === filename), `файлы: ${(outputs.data ?? []).map((f) => f.filename).join(", ")}`);
    return "api/43-session-outputs.json";
  });
  const hostFile = join(run.SESSION_OUTPUTS_DIR, user.tenant_id, ids.session, filename);
  await check("run.outputs_file", "файл, записанный в VM в /mnt/session/outputs, лежит на хосте с тем же содержимым", () => {
    assert(existsSync(hostFile), `нет ${hostFile}`);
    const content = readFileSync(hostFile, "utf8").trim();
    assert(content === `VERIFY_OK_${nonce}`, `содержимое: ${content.slice(0, 80)}`);
    copyFileSync(hostFile, join(EV, "api", `44-${filename}`));
    return hostFile;
  });
  await sandboxEvidence("run", ids.session);
  if (FAKE) {
    const reqs = fakeRequests(nonce);
    await check("run.fake_model", "фейковая модель: tool_use, затем текст; модель видела результат bash с маркером", () => {
      assert(reqs.map((r) => r.decision).join(",") === "tool_use,final_text", `решения: ${reqs.map((r) => r.decision).join(",")}`);
      assert(reqs[1].tool_result_has_marker === true, "нет маркера в результате");
      return "api/fake-model-requests.jsonl";
    });
  }
  if (!KEEP_SESSION) {
    await archiveAndProveStop("run", ids.session);
    cover("session-archive");
  }
}

// ------------------------------------------------------------------ итог ---
// Подфункции из features/*.md (раздел «Sub-features»: строки «- `id` — описание»).
function featureEntries() {
  const dir = join(SKILL_DIR, "features");
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    const section = readFileSync(join(dir, file), "utf8").split(/^## /m).find((s) => s.startsWith("Sub-features"));
    for (const line of (section ?? "").split("\n")) {
      const m = line.match(/^- `([a-z0-9-]+)` — (.+)$/);
      if (m) out.push({ id: m[1], desc: m[2], file });
    }
  }
  return out;
}

function writeSummary(abortError) {
  const failed = checks.filter((c) => c.status === "провал");
  const notChecked = [
    ["env.probe_path", "проба окружения сделана техническим агентом по API: действия «проверить окружение» нет ни в консоли, ни в API"],
    ...(FAKE
      ? [["model.real", "настоящая модель не вызывалась (режим fake); путь real: VERIFY_MODEL_MODE=real при grep -c '^ANTHROPIC_API_KEY=.' platform/.env = 1"]]
      : [["model.answer_text", "точный текст ответа настоящей модели не проверяется, только события tool_use/tool_result и наличие agent.message"]]),
    ["server.stop", "остановку VM при завершении сервера проверяет scripts/cleanup.sh, не этот сценарий"],
    ...(KEEP_SESSION ? [["vm.stop", "VERIFY_KEEP_SESSION=1: архив сессий и остановка VM не проверялись"]] : []),
  ];
  const features = featureEntries();
  const uncovered = features.filter((f) => !covered.has(f.id));
  const err50 = serverLogLines().filter((l) => l.includes('"level":50')).length;
  const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# verify-agent-console: прогон ${run.RUN_ID}`,
    "",
    `Итог: ${abortError ? "ПРЕРВАН" : failed.length ? "ПРОВАЛ" : "ПРОЙДЕН"} (проверок: ${checks.length}, провалов: ${failed.length}, подфункций карты пройдено ${features.length - uncovered.length} из ${features.length}).`,
    abortError ? `Сценарий прерван: ${plain(abortError.message)}` : "",
    "",
    "## Экземпляр",
    "",
    `- URL: ${BASE}, режим модели: ${run.MODEL_MODE}, модель агента: ${MODEL}, образ песочницы: ${run.SANDBOX_IMAGE}`,
    `- git ${run.GIT_REV}, незакоммиченных файлов: консоль ${run.CONSOLE_DIRTY_FILES}, сервер ${run.SERVER_DIRTY_FILES}; хэши изменений: консоль ${run.CONSOLE_TREE_HASH}, сервер ${run.SERVER_TREE_HASH}`,
    `- данные (удаляются cleanup.sh): ${run.DATA_DIR}`,
    `- учётка: ${user.email}, рабочее пространство ${user.tenant_id}`,
    `- окружение ${ids.environment ?? "—"} (${names.env}), агент ${ids.agent ?? "—"} (${names.agent}), сессия ${ids.session ?? "—"} (${names.session})`,
    `- проба окружения: агент ${ids.probeAgent ?? "—"}, сессии ${ids.probeSession ?? "—"} (nonce ${probeNonce}) и ${ids.settingsSession ?? "—"} после настроек (nonce ${settingsNonce}); ход агента: nonce ${nonce}`,
    `- ядро хоста ${HOST_KERNEL}, ядро VM ${ids.vmKernel ?? ids.probeVmKernel ?? "—"}`,
    `- ошибок уровня 50 в логе сервера: ${err50} (logs/main-node.journey.log)`,
    "",
    "## Проверки",
    "",
    "| Проверка | Что доказывает | Статус | Доказательство |",
    "|---|---|---|---|",
    ...checks.map((c) => `| ${c.id} | ${cell(c.title)} | ${c.status} | ${cell([c.evidence, c.note].filter(Boolean).join("; "))} |`),
    ...notChecked.map(([id, why]) => `| ${id} | ${cell(why)} | не проверено | — |`),
    ...uncovered.map((f) => `| feature.${f.id} | ${cell(f.desc)} | не проверено | в главном сценарии нет шага; рецепт: features/${f.file} |`),
    "",
    "## Скриншоты",
    "",
    "Ширина 1280. Если у страницы есть внутренняя прокрутка, высота окна на время снимка растягивается на неё (до 6000 px).",
    "",
    ...screens.map((s) => `- ${s.file} (sha256 ${s.sha.slice(0, 12)}${s.tall ? `, высота ${s.tall}` : ""})`),
    "",
    "## Повтор",
    "",
    "RUN=\"$(scripts/launch.sh)\" && { scripts/doctor.sh --run \"$RUN\" && scripts/seed-user.sh --run \"$RUN\" && scripts/journey.sh --run \"$RUN\"; scripts/cleanup.sh --run \"$RUN\"; } (папка .claude/skills/verify-agent-console).",
    "",
  ];
  writeFileSync(join(EV, "summary.md"), lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"));
}

function copyLogs() {
  const copies = [
    [run.SERVER_LOG, "logs/main-node.journey.log"],
    [run.FAKE_LOG, "logs/fake-model.log"],
    [run.FAKE_REQUESTS, "api/fake-model-requests.jsonl"],
  ];
  for (const [from, to] of copies) if (from && existsSync(from)) copyFileSync(from, join(EV, to));
}

let browser;
let abortError = null;
log(`прогон ${run.RUN_ID}, режим модели ${run.MODEL_MODE}, доказательства ${EV}`);
try {
  const health = await (await fetch(`${BASE}/health`)).json();
  if (health?.backends?.db !== `sqlite ${run.DB_PATH}`) {
    throw new Error(`на ${BASE} не экземпляр этого прогона (db: ${health?.backends?.db}); сценарий не запускаю`);
  }
  const executablePath = pickChromium();
  log(`chromium: ${executablePath}`);
  browser = await chromium.launch({ executablePath, headless: process.env.VERIFY_HEADED !== "1", args: ["--disable-gpu"] });
  context = await browser.newContext({ baseURL: BASE, viewport: VIEW, locale: "ru-RU" });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  log(`процессов браузера записано в state/pids: ${recordJourneyChildren()}`);
  // critical=false: сбой шага пишется провалом, а сценарий идёт дальше (настройки окружения
  // не нужны агенту и сессии). Сбой обязательного шага прерывает сценарий.
  let settingsOk = true;
  for (const [name, fn, critical, enabled] of [
    ["вход", stepLogin, true],
    ["окружение", stepCreateEnvironment, true],
    ["проба окружения", stepProbeEnvironment, true],
    ["настройки окружения", stepConfigureEnvironment, false],
    ["проба настроек окружения", stepProbeSettings, false, () => settingsOk],
    ["агент", stepCreateAgent, true],
    ["сессия", stepCreateSession, true],
    ["ход агента", stepAgentTurn, true],
  ]) {
    if (enabled && !enabled()) {
      record(`journey.skipped.${name.replace(/\s+/g, "_")}`, `шаг «${name}»`, "не проверено", "", "предыдущий шаг настроек не выполнен");
      continue;
    }
    log(`== шаг: ${name}`);
    if (critical) {
      await fn();
      continue;
    }
    try {
      await fn();
    } catch (error) {
      if (fn === stepConfigureEnvironment) settingsOk = false;
      record(`journey.step_failed.${name.replace(/\s+/g, "_")}`, `шаг «${name}» выполнен до конца`, "провал", "", error.message);
      await shot(`fail-step-${name.replace(/\s+/g, "-")}`).catch(() => {});
    }
  }
} catch (error) {
  abortError = error;
  record("journey.abort", "сценарий дошёл до конца", "провал", "", error.message);
  if (page) await shot("abort").catch(() => {});
} finally {
  record("evidence.screens_distinct", "скриншоты соседних шагов различаются (sha256): каждый снимок показывает новое состояние",
    duplicateShots.length === 0 ? "проверено" : "провал", `скриншотов ${screens.length}`,
    duplicateShots.length === 0 ? "" : `совпали: ${duplicateShots.join("; ")}`);
  copyLogs();
  writeSummary(abortError);
  await browser?.close().catch(() => {});
}
const failedCount = checks.filter((c) => c.status === "провал").length;
log(`итог: ${abortError ? "ПРЕРВАН" : failedCount ? "ПРОВАЛ" : "ПРОЙДЕН"}, ${join(EV, "summary.md")}`);
process.exit(failedCount ? 1 : 0);
