#!/usr/bin/env node
// Сценарий «Claude Code и свой harness в песочнице» verify-agent-console (Playwright, консоль на русском):
//   вход → карточки моделей (консоль): Anthropic на фейк с ключом карточки и OpenAI для
//   несовместимой модели → окружение с npm-пакетом @agentclientprotocol/claude-agent-acp (консоль) →
//   хранилище с ключом модели и обычной переменной «переменная окружения» (API: в консоли такого
//   типа нет) → guard на POST /v1/agents: 400 на секрет в env, неизвестный harness и несовместимую
//   модель (API и окно агента) → карточка своего harness на странице «Harness» (консоль) → агент
//   Claude Code из формы: Harness «Claude Code в песочнице», несовместимая модель выключена с
//   причиной, своя карточка видна в списке → сессия с окружением и хранилищем (консоль) → ход:
//   Claude Code внутри VM LiteBox пишет и читает verify.txt в рабочей папке (= /mnt/session/outputs),
//   Bash без разрешения отклоняется → доказательства (события, поток, выводы, файл на хосте, VM,
//   журнал модели) → второй ход: ps и окружение claude-agent-acp в VM (ACP-сессия возобновлена,
//   в VM один claude-agent-acp, ключа модели в окружении нет, модель идёт через прокси с токеном
//   сессии) → архив → агент на своей карточке (acp-echo-agent.cjs) отвечает в новой сессии.
// Модель: Claude Code и свой агент в VM ходят в модель через прокси сервера
//   (/v1/oma/inference-proxy/<сессия>, токен хода oma_sbx_), прокси берёт ключ и адрес карточки.
//   Режим fake (по умолчанию): адрес карточки это fake-model.mjs хоста, ключ фиктивный.
//   Режим real (VERIFY_CC_MODE=real) только явно: ключ API Anthropic из файла VERIFY_CC_SECRET_FILE
//   уходит в карточку модели, базовый URL не задаётся. Сейчас не запускался.
// Запуск: scripts/journey.sh --run <RUN_ID> --scenario claude-code.
// Итог: $EVIDENCE_DIR/summary.md; код 0, если все обязательные проверки прошли.
import { createRequire } from "node:module";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------- прогон ---
const SKILL_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RUN_DIR = (() => {
  const dir = process.env.VERIFY_RUN_DIR ?? "";
  if (!dir || !existsSync(join(dir, ".verify-agent-console-run"))) {
    throw new Error("прогон не задан: VERIFY_RUN_DIR=<папка прогона> (scripts/journey.sh --run <RUN_ID> --scenario claude-code задаёт её сам)");
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
const MODEL = run.AGENT_MODEL;
const TURN_TIMEOUT = Number(process.env.VERIFY_FIRST_TURN_TIMEOUT_MS ?? 900_000);
const KEEP_SESSION = process.env.VERIFY_KEEP_SESSION === "1";
const VIEW = { width: 1280, height: 860 };
const MAX_SHOT_HEIGHT = 6000;
const BETAS = [
  "managed-agents-2026-04-01", "files-api-2025-04-14", "skills-2025-10-02", "agent-memory-2026-07-22",
  "dreaming-2026-04-21", "mcp-tunnels-2026-06-22", "user-profiles-2026-08-18",
].join(",");
const HOST_KERNEL = os.release();

// Режим модели Claude Code: fake (фейк хоста) или real (только явно, тратит лимит/деньги).
const CC_MODE = process.env.VERIFY_CC_MODE ?? "fake";
if (!["fake", "real"].includes(CC_MODE)) throw new Error("VERIFY_CC_MODE должен быть fake или real");
const FAKE = CC_MODE === "fake";
if (FAKE && run.MODEL_MODE !== "fake") throw new Error("VERIFY_CC_MODE=fake требует экземпляр с фейковой моделью (VERIFY_MODEL_MODE=fake при launch)");
// Адрес сервера из VM BoxLite (SANDBOX_GATEWAY_BASE_URL, его задаёт launch.sh): gvproxy отвечает
// на host.boxlite.internal адресом 192.168.127.254 и пересылает его на 127.0.0.1 хоста.
const GATEWAY_VM = run.SANDBOX_GATEWAY_BASE_URL || `http://host.boxlite.internal:${run.VERIFY_PORT}`;
// Версия закреплена: пакет ставится из npm при каждом старте VM, и новый релиз Claude Code
// не должен менять сценарий. 0.91.0 прошла в прогоне 20261016-012333.
const CC_PACKAGE = "@agentclientprotocol/claude-agent-acp@0.91.0";
const WORKDIR = "/mnt/session/outputs";
// Форма агента пишет блок _oma.acp из каталога (обёртка sh -c и OMA_CLAUDE_SETTINGS со списком
// Read, Write, Edit). Bash(ps:*) нужен второму ходу (процессы и окружение VM), его сценарий
// добавляет в YAML той же формы, как советует подсказка вкладки «Инструменты»; контрольный
// touch по-прежнему вне списка.
const CLAUDE_ALLOW_EXTRA = "Bash(ps:*)";
// Модель карточки, которую прокси подставляет вместо handle агента (wire_model).
const WIRE_MODEL = process.env.VERIFY_CC_WIRE_MODEL ?? "claude-sonnet-4-6";

const newNonce = () => randomBytes(4).toString("hex");
const nonce = newNonce();
const cardNonce = newNonce();
const names = {
  env: `verify-cc-env-${nonce}`,
  vault: `verify-cc-vault-${nonce}`,
  agent: `verify-cc-agent-${nonce}`,
  session: `verify-cc-session-${nonce}`,
  // Карточки моделей: handle Claude Code и несовместимая с ним модель OpenAI.
  modelCard: `verify-cc-${nonce}`,
  oaiCard: `verify-oai-${nonce}`,
  // Свой harness: ID в агенте, название на странице «Harness», агент и сессия на нём.
  harnessId: `verify-echo-${nonce}`,
  harnessName: `Эхо ACP ${nonce}`,
  cardAgent: `verify-card-agent-${nonce}`,
  cardSession: `verify-card-session-${nonce}`,
  guardAgent: `verify-guard-${nonce}`,
  unknownHarness: `verify-unknown-${nonce}`,
};
const ids = {};
const created = { sessions: [], agents: [], environments: [], vaults: [] };
const covered = new Set();
const cover = (...list) => list.forEach((id) => covered.add(id));

// Ключ карточки модели. fake: одноразовый фиктивный ключ, адрес карточки это фейк хоста.
// real: ключ API Anthropic из файла владельца (не ~/.claude), адрес по умолчанию. Значение
// не печатается и уходит только в карточку модели; в VM его нет, его подставляет прокси.
let cardSecret = { key: "", baseUrl: "" };
const loadCardSecret = () => {
  if (FAKE) return { key: `verify-card-key-${nonce}`, baseUrl: run.FAKE_URL };
  const file = process.env.VERIFY_CC_SECRET_FILE ?? "";
  const name = process.env.VERIFY_CC_SECRET_NAME ?? "ANTHROPIC_API_KEY";
  if (name !== "ANTHROPIC_API_KEY") {
    throw new Error("VERIFY_CC_SECRET_NAME: только ANTHROPIC_API_KEY. Модель идёт через прокси с ключом карточки, токен подписки через прокси не поддерживается");
  }
  if (!file) throw new Error("VERIFY_CC_MODE=real: задайте VERIFY_CC_SECRET_FILE (файл с ключом API Anthropic, права 600)");
  const abs = resolve(file);
  if (abs.startsWith(join(os.homedir(), ".claude"))) throw new Error("учётные данные Claude Code из ~/.claude не используются: сохраните ключ в отдельный файл");
  if ((statSync(abs).mode & 0o077) !== 0) throw new Error(`${abs}: права шире 600`);
  const value = readFileSync(abs, "utf8").trim();
  if (!value || value.includes("\n")) throw new Error(`${abs}: нужен один ключ одной строкой`);
  return { key: value, baseUrl: "" };
};
// Хранилище сессии: ключ модели (до VM дойти не должен, skipModelKeys) и обычная переменная
// (до VM доходит, так видно, что окружение хранилища работает, а ключи моделей отсеяны).
const vaultSecrets = {
  modelKey: { name: "ANTHROPIC_API_KEY", value: `verify-vault-key-${nonce}` },
  note: { name: "VERIFY_VAULT_NOTE", value: `verify-vault-note-${nonce}` },
};
const sha12 = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
// Тестовый ACP-агент своей карточки одной строкой: аргумент после -e команды node.
const ECHO_AGENT = readFileSync(join(SKILL_DIR, "scripts", "acp-echo-agent.cjs"), "utf8")
  .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("//")).join(" ");

const require = createRequire(join(run.PLATFORM_DIR, "package.json"));
const { chromium } = require("@playwright/test");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...parts) => console.log(new Date().toTimeString().slice(0, 8), ...parts);

// --------------------------------------------------------------- проверки ---
const checks = [];
const plain = (text) => String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
function record(id, title, status, evidence = "", note = "") {
  evidence = plain(evidence);
  note = plain(note);
  checks.push({ id, title, status, evidence, note });
  log(`${status.padEnd(12)} ${id}: ${title}${note ? ` (${note})` : ""}`);
}
async function check(id, title, fn) {
  try {
    record(id, title, "проверено", (await fn()) ?? "");
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
async function shot(name) {
  const file = `screens/${String(++shotN).padStart(2, "0")}-cc-${name}.png`;
  const extra = await hiddenScrollHeight();
  const tall = extra > 4;
  if (tall) {
    await page.setViewportSize({ width: VIEW.width, height: Math.min(VIEW.height + extra, MAX_SHOT_HEIGHT) });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
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
  const file = `aria/${String(shotN).padStart(2, "0")}-cc-${name}.yml`;
  writeFileSync(join(EV, file), await page.locator("body").ariaSnapshot());
  return file;
}
function saveJson(name, data) {
  const file = `api/cc-${name}.json`;
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
    const chunk = await api("GET", `/v1/sessions/${sessionId}/events?${q}`);
    all.push(...(chunk.data ?? []));
    if (!chunk.next_page) break;
    cursor = chunk.next_page;
  }
  return all;
}
// Тот же поток, что слушает консоль: какие события приходят вживую во время хода.
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
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (!data) continue;
          try {
            const event = JSON.parse(data);
            seen.events.push({ type: event.type ?? null, id: event.id ?? null, name: event.name ?? null, text: textOf(event.content).slice(0, 200) });
          } catch {
            seen.events.push({ raw: data.slice(0, 160) });
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
const PROMPT = [
  "создай в рабочей папке файл verify.txt со словом VERIFY_OK и прочитай его",
  `VERIFY_CLAUDE_CODE nonce=${nonce}`,
].join("\n");
const TURN2_MARKER = `nonce=${nonce} turn=2`;
const PROMPT2 = ["покажи процессы песочницы командой ps", `VERIFY_CLAUDE_CODE ${TURN2_MARKER}`].join("\n");
// Главный процесс ACP-агента в выводе ps: "node /usr/local/bin/claude-agent-acp"
// (пути внутри пакета, …/claude-agent-acp/node_modules/…, не считаются). Как в fake-model.mjs.
const ACP_PROCESS = /(^|[\s/])claude-agent-acp(\s|$)/;
const toolKind = (event) => String(event.name ?? "").split(/\s/)[0];
// API событий отдаёт ключи input в camelCase (file_path из ACP приходит как filePath).
const filePathOf = (event) => String(event?.input?.file_path ?? event?.input?.filePath ?? "");
// Неудачный инструмент ACP-агента: is_error=true и текст «(status: failed)», если агент не прислал вывод.
const failedResult = (result) => result?.is_error === true || /\(status: failed\)/.test(textOf(result?.content));
// marker: первый user.message, в тексте которого он есть (ход 1: nonce=<n>, ход 2: TURN2_MARKER).
function analyzeTurn(events, marker = `nonce=${nonce}`) {
  const pos = (event) => events.indexOf(event);
  const userMessage = events.find((e) => e.type === "user.message" && textOf(e.content).includes(marker));
  if (!userMessage) return { userMessage: null, errors: [], idle: null };
  const after = events.slice(pos(userMessage) + 1);
  const toolUses = after.filter((e) => e.type === "agent.tool_use");
  const results = after.filter((e) => e.type === "agent.tool_result");
  const resultOf = (toolUse) => toolUse && results.find((r) => r.tool_use_id === toolUse.id);
  const write = toolUses.find((t) => toolKind(t) === "Write");
  const read = toolUses.find((t) => toolKind(t) === "Read");
  const bash = toolUses.find((t) => /bash-ran-/.test(String(t.input?.command ?? "")));
  return {
    userMessage,
    toolUses,
    results,
    write,
    writeResult: resultOf(write),
    read,
    readResult: resultOf(read),
    bash,
    bashResult: resultOf(bash),
    lastMessage: after.filter((e) => e.type === "agent.message").at(-1),
    spanStart: after.find((e) => e.type === "span.model_request_start"),
    idle: after.find((e) => e.type === "session.status_idle"),
    errors: after.filter((e) => e.type === "session.error"),
    pos,
  };
}
async function waitTurnIdle(sessionId, timeout, marker, onTick = () => {}) {
  const t0 = Date.now();
  let lastLog = 0;
  for (;;) {
    onTick();
    const events = await listEvents(sessionId);
    const a = analyzeTurn(events, marker);
    if (a.idle || a.errors.length > 0 && Date.now() - t0 > 60_000) return events;
    if (Date.now() - t0 > timeout) {
      throw new Error(`нет session.status_idle за ${Math.round(timeout / 1000)} с; последние события: ${events.slice(-5).map((e) => e.type).join(", ")}`);
    }
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      log(`ход Claude Code: ждём, событий ${events.length}, последнее ${events.at(-1)?.type ?? "нет"}`);
    }
    await sleep(2000);
  }
}

// ---------------------------------------------------------- файлы прогона ---
function boxliteLines() {
  const dir = join(run.BOXLITE_HOME, "logs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), "utf8").split("\n"))
    .filter((line) => line.slice(0, 19) >= run.RUN_STARTED_AT_UTC);
}
const boxliteCount = (text) => boxliteLines().filter((l) => l.includes(text)).length;
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
function recordJourneyChildren() {
  const lines = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    if (!ancestry(pid).slice(1).includes(process.pid)) continue;
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
// Процессы хоста с claude-agent-acp в командной строке среди потомков нашего server-node.
// Процессы VM (libkrun) в /proc хоста не видны, поэтому пусто = агент не на хосте.
function hostAcpProcesses() {
  const serverNode = recordedPid("server-node");
  const found = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let cmdline;
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch { continue; }
    if (!cmdline.includes("claude-agent-acp")) continue;
    if (ancestry(pid).slice(1).includes(serverNode)) found.push(`${pid} ${cmdline.slice(0, 160)}`);
  }
  return found;
}
function fakeRequests(n = nonce) {
  if (!existsSync(run.FAKE_REQUESTS)) return [];
  return readFileSync(run.FAKE_REQUESTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.nonce === n);
}
// Процессы хоста среди потомков server-node, в командной строке которых есть text.
function hostProcessesWith(text) {
  const serverNode = recordedPid("server-node");
  const found = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let cmdline;
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch { continue; }
    if (!cmdline.includes(text)) continue;
    if (ancestry(pid).slice(1).includes(serverNode)) found.push(`${pid} ${cmdline.slice(0, 160)}`);
  }
  return found;
}
// Запрос к API без исключения на коде ответа: guard проверяется по коду 400 и тексту.
async function apiRaw(method, path, body) {
  const res = await context.request.fetch(BASE + path, {
    method,
    headers: { "anthropic-beta": BETAS, origin: BASE, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    data: body === undefined ? undefined : JSON.stringify(body),
    failOnStatusCode: false,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status(), json, text };
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
  await page.getByRole("group", { name: "Действия входа" }).getByRole("button", { name: "Войти", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  await page.getByRole("navigation", { name: "Разделы консоли" }).waitFor();
  await page.getByRole("main").getByRole("heading", { level: 1 }).first().waitFor();
  await shot("after-login");
  const me = await api("GET", "/v1/oma/me");
  await check("cc.auth", "вход в консоль тестовой учёткой в её рабочем пространстве", () => {
    assert(me.user?.id === user.user_id, `user.id ${me.user?.id}`);
    assert(me.tenant?.id === user.tenant_id, `tenant ${me.tenant?.id}`);
    return "GET /v1/oma/me";
  });
}

// Карточка модели через консоль («Карточки моделей» → «Новая карточка модели»). Провайдер
// выбирается первым: плитка провайдера сбрасывает модель и адрес. При создании сервер проверяет
// ключ запросом к адресу карточки (probeModelCard в packages/http-routes/src/model-cards).
async function createModelCardUi({ id, provider, key, wire, baseUrl }) {
  await openSection("Карточки моделей", "Карточек моделей пока нет");
  await page.getByRole("button", { name: "Новая карточка модели" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новая карточка модели" });
  await dialog.waitFor();
  await dialog.getByRole("group", { name: "Провайдер Pi *" }).getByRole("button", { name: new RegExp(`^${provider.label}`) }).click();
  await dialog.locator("#modelcard-id").fill(id);
  await dialog.locator("#modelcard-api-key").fill(key);
  await dialog.locator("#modelcard-wire-model").fill(wire);
  if (baseUrl) await dialog.locator("#modelcard-base-url").fill(baseUrl);
  const filled = await shot(`model-card-${provider.value}-filled`);
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  const toast = page.getByText(new RegExp(`^Карточка модели (создана, ключ ${provider.value} проверен|сохранена)`)).first();
  await toast.waitFor({ timeout: 20_000 });
  const toastText = plain(await toast.textContent());
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  await tableRow(id).waitFor({ timeout: 15_000 });
  return { filled, toastText };
}

async function stepModelCards() {
  const cc = await createModelCardUi({
    id: names.modelCard, provider: { value: "anthropic", label: "Anthropic" },
    key: cardSecret.key, wire: WIRE_MODEL, baseUrl: cardSecret.baseUrl,
  });
  const oai = await createModelCardUi({
    id: names.oaiCard, provider: { value: "openai", label: "OpenAI" },
    key: `verify-oai-key-${nonce}`, wire: "gpt-4.1", baseUrl: `${run.FAKE_URL}/v1`,
  });
  await shot("model-cards");
  const options = await api("GET", "/v1/oma/model_options");
  saveJson("05-model-options", options);
  const byHandle = (handle) => (options.data ?? []).find((o) => o.handle === handle);
  const ccOption = byHandle(names.modelCard);
  const oaiOption = byHandle(names.oaiCard);
  ids.ccOption = ccOption;
  ids.oaiOption = oaiOption;
  const ok = await check("cc.model_cards", `карточки моделей из консоли: ${names.modelCard} (anthropic-messages, подходит Claude Code) и ${names.oaiCard} (протоколы OpenAI, Claude Code не подходит); ключ карточки проверен при создании`, () => {
    assert(ccOption, `нет ${names.modelCard} в GET /v1/oma/model_options`);
    assert(oaiOption, `нет ${names.oaiCard} в GET /v1/oma/model_options`);
    assert(ccOption.source === "card" && ccOption.wire_model === WIRE_MODEL, `${names.modelCard}: source ${ccOption.source}, wire_model ${ccOption.wire_model}`);
    assert(JSON.stringify(ccOption.protocols) === JSON.stringify(["anthropic-messages"]), `протоколы ${names.modelCard}: ${JSON.stringify(ccOption.protocols)}`);
    assert((ccOption.harnesses ?? []).includes("claude-acp"), `harnesses ${names.modelCard}: ${JSON.stringify(ccOption.harnesses)}`);
    assert(!(oaiOption.protocols ?? []).includes("anthropic-messages") && (oaiOption.protocols ?? []).length > 0, `протоколы ${names.oaiCard}: ${JSON.stringify(oaiOption.protocols)}`);
    assert(!(oaiOption.harnesses ?? []).includes("claude-acp"), `harnesses ${names.oaiCard}: ${JSON.stringify(oaiOption.harnesses)}`);
    assert(/проверен/.test(cc.toastText), `тост карточки ${names.modelCard}: «${cc.toastText}»`);
    assert(!JSON.stringify(options).includes(cardSecret.key), "ключ карточки вернулся в GET /v1/oma/model_options");
    return `api/cc-05-model-options.json, ${cc.filled}, ${oai.filled}; тосты: «${cc.toastText}», «${oai.toastText}»`;
  });
  if (ok) cover("cc-model-card");
}

// Окружение через консоль: создать, затем в карточке добавить npm-пакет агента.
async function stepEnvironment() {
  await openSection("Окружения", "Окружений пока нет");
  await page.getByRole("button", { name: "Новое окружение" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новое окружение" });
  await dialog.waitFor();
  await dialog.getByLabel("Название", { exact: true }).fill(names.env);
  await dialog.getByLabel("Описание (необязательно)").fill("Claude Code (claude-agent-acp) в VM LiteBox");
  await shot("environment-create-dialog");
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  const row = tableRow(names.env);
  await row.waitFor({ timeout: 15_000 });
  const list = await api("GET", "/v1/environments?limit=100");
  ids.environment = (list.data ?? []).find((e) => e.name === names.env)?.id;
  assert(ids.environment, `окружение ${names.env} не найдено через API`);
  created.environments.push(ids.environment);
  saveCreated();
  await row.click();
  await page.waitForURL(new RegExp(`/environments/${ids.environment}$`));
  await page.getByRole("heading", { level: 1, name: names.env }).first().waitFor();
  await page.getByRole("button", { name: "Добавить пакет" }).click();
  await page.getByRole("combobox", { name: "Менеджер пакетов" }).last().click();
  await page.getByRole("option", { name: "npm", exact: true }).click();
  await page.getByRole("textbox", { name: "Пакеты и версии" }).last().fill(CC_PACKAGE);
  await shot("environment-package-filled");
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await page.getByText("Окружение сохранено", { exact: true }).first().waitFor({ timeout: 15_000 });
  await shot("environment-saved");
  const ariaFile = await aria("environment-saved");
  const env = await api("GET", `/v1/environments/${ids.environment}`);
  saveJson("10-environment", env);
  const ok_cc_environment = await check("cc.env_package", `окружение сохранило npm-пакет ${CC_PACKAGE} и сеть без ограничений (консоль → GET /v1/environments/:id)`, () => {
    assert((env.config?.packages?.npm ?? []).includes(CC_PACKAGE), `packages ${JSON.stringify(env.config?.packages)}`);
    assert(env.config?.networking?.type === "unrestricted", `networking ${JSON.stringify(env.config?.networking)}`);
    return `api/cc-10-environment.json, ${ariaFile}`;
  });
  if (ok_cc_environment) cover("cc-environment");
}

// Хранилище и секрет. Тип «переменная окружения» в консоли не создаётся (VaultDetail.tsx умеет
// только MCP и CLI), поэтому обходной путь идёт через API, а консоль показывает результат.
async function stepVault() {
  const vault = await api("POST", "/v1/vaults", { display_name: names.vault });
  ids.vault = vault.id;
  created.vaults.push(ids.vault);
  saveCreated();
  // Ключ модели в хранилище: с 2026-10-16 сервер его в VM не кладёт (skipModelKeys в
  // applyVaultEnvironment), второй ход это проверяет. Обычная переменная доходит до VM.
  const credentials = [];
  for (const item of [vaultSecrets.modelKey, vaultSecrets.note]) {
    credentials.push(await api("POST", `/v1/vaults/${ids.vault}/credentials`, {
      display_name: `verify: ${item.name}`,
      auth: { type: "environment_variable", secret_name: item.name, secret_value: item.value, networking: { type: "unrestricted" } },
    }));
  }
  saveJson("20-vault-credentials", credentials);
  const ok_cc_vault = await check("cc.vault_secret", `в хранилище учётные данные «переменная окружения» ${vaultSecrets.modelKey.name} и ${vaultSecrets.note.name}, значения API не отдаёт`, () => {
    for (const [i, item] of [vaultSecrets.modelKey, vaultSecrets.note].entries()) {
      assert(credentials[i]?.auth?.type === "environment_variable", `auth.type ${credentials[i]?.auth?.type}`);
      assert(credentials[i]?.auth?.secret_name === item.name, `secret_name ${credentials[i]?.auth?.secret_name}`);
      assert(!JSON.stringify(credentials).includes(item.value), `значение ${item.name} вернулось в ответе API`);
    }
    return "api/cc-20-vault-credentials.json";
  });
  record("cc.vault_api_path", "учётные данные «переменная окружения» созданы через API", "внимание", "",
    "в консоли (pages/VaultDetail.tsx) нет формы для типа environment_variable, только MCP-сервер и CLI; хранилище видно в консоли и выбирается в окне «Новая сессия»");
  await page.goto(`${BASE}/vaults/${ids.vault}`);
  await page.getByRole("heading", { level: 1, name: names.vault }).first().waitFor();
  await page.getByText(vaultSecrets.modelKey.name).first().waitFor({ timeout: 15_000 });
  await shot("vault-detail");
  if (ok_cc_vault) cover("cc-vault");
}

// Guard на POST /v1/agents (apps/main-node/src/lib/agent-config-guard.ts): 400 и текст по-русски
// в формате managed API, агент не создаётся. Тот же отказ видит пользователь в окне агента.
async function stepGuard() {
  const claudeBlock = (env) => ({
    harness: "acp-sandbox",
    acp: {
      agent: { id: "claude-acp", command: "sh", args: ["-c", "exec claude-agent-acp"], cwd: WORKDIR, env },
      per_turn_timeout_ms: 600000,
    },
  });
  const cases = [
    { id: "cc.guard_secret_env", title: "секрет в env агента: GITHUB_TOKEN",
      body: { name: `${names.guardAgent}-secret`, model: names.modelCard, _oma: claudeBlock({ GITHUB_TOKEN: `verify-not-a-secret-${nonce}` }) },
      want: "Переменная «GITHUB_TOKEN» похожа на секрет" },
    { id: "cc.guard_model_key_env", title: "ключ модели в env агента: ANTHROPIC_API_KEY",
      body: { name: `${names.guardAgent}-key`, model: names.modelCard, _oma: claudeBlock({ ANTHROPIC_API_KEY: `verify-guard-key-${nonce}` }) },
      want: "Переменную «ANTHROPIC_API_KEY» задаёт сервер" },
    { id: "cc.guard_unknown_harness", title: `неизвестный harness ${names.unknownHarness}`,
      body: { name: `${names.guardAgent}-harness`, model: names.modelCard, _oma: { harness: names.unknownHarness } },
      want: `Неизвестный harness «${names.unknownHarness}»` },
    { id: "cc.guard_incompatible_model", title: `модель ${names.oaiCard} без anthropic-messages для Claude Code`,
      body: { name: `${names.guardAgent}-model`, model: names.oaiCard, _oma: claudeBlock({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }) },
      want: `Модель «${names.oaiCard}» не подходит для «Claude Code в песочнице»` },
  ];
  const answers = [];
  for (const item of cases) {
    const res = await apiRaw("POST", "/v1/agents", item.body);
    answers.push({ id: item.id, status: res.status, body: res.json ?? res.text.slice(0, 300) });
    await check(item.id, `guard: POST /v1/agents отвечает 400 (${item.title}), invalid_request_error с текстом «${item.want}…»`, () => {
      assert(res.status === 400, `код ${res.status}: ${res.text.slice(0, 200)}`);
      assert(res.json?.type === "error" && res.json?.error?.type === "invalid_request_error", `тело ${res.text.slice(0, 200)}`);
      assert(String(res.json?.error?.message ?? "").includes(item.want), `текст «${res.json?.error?.message}»`);
      return `api/cc-25-guard.json: ${plain(res.json.error.message).slice(0, 140)}`;
    });
  }
  saveJson("25-guard", answers);
  const agents = await api("GET", "/v1/agents?limit=100&include_archived=true");
  await check("cc.guard_nothing_created", "после отказов guard агентов verify-guard-* нет (GET /v1/agents)", () => {
    const leaked = (agents.data ?? []).filter((a) => String(a.name).startsWith(names.guardAgent));
    assert(leaked.length === 0, `созданы: ${leaked.map((a) => `${a.name} ${a.id}`).join(", ")}`);
    return `агентов в списке: ${(agents.data ?? []).length}`;
  });
  // Тот же отказ в консоли: окно «Новый агент», режим YAML, неизвестный harness.
  await openSection("Агенты", "Агентов пока нет");
  await page.getByRole("button", { name: "Новый агент" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новый агент" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: /^Пустой агент/ }).click();
  await dialog.getByRole("group", { name: "Режим правки" }).getByRole("button", { name: "YAML", exact: true }).click();
  const editor = dialog.getByRole("textbox", { name: "Конфигурация агента в формате YAML" });
  await editor.fill([`name: ${names.guardAgent}-ui`, `model: ${names.modelCard}`, "_oma:", `  harness: ${names.unknownHarness}`, ""].join("\n"));
  await dialog.getByRole("button", { name: "Создать агента", exact: true }).click();
  const alert = dialog.getByRole("alert").filter({ hasText: `Неизвестный harness «${names.unknownHarness}»` }).first();
  await check("cc.guard_ui_alert", "окно «Новый агент» показывает отказ guard (400) блоком role=alert и остаётся открытым", async () => {
    await alert.waitFor({ timeout: 15_000 });
    assert(/\/agents$/.test(new URL(page.url()).pathname), `адрес ${page.url()}: окно ушло на карточку агента`);
    return shot("guard-ui-alert");
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  if (["cc.guard_secret_env", "cc.guard_unknown_harness", "cc.guard_nothing_created", "cc.guard_ui_alert"]
    .every((id) => checks.some((c) => c.id === id && c.status === "проверено"))) cover("cc-guard");
}

// Карточка своего harness на странице «Harness»: команда node и тестовый ACP-агент
// (scripts/acp-echo-agent.cjs) одной строкой после -e. Пакетов не нужно: node есть в образе.
async function stepHarnessCard() {
  await nav("Harness").click();
  await page.getByRole("main").getByRole("heading", { level: 1, name: "Harness", exact: true }).waitFor();
  const builtin = page.getByRole("region", { name: "Встроенные" });
  const claudeRow = builtin.locator("tr", { hasText: "Claude Code в песочнице" }).first();
  await claudeRow.waitFor({ timeout: 15_000 });
  await page.getByText("Своих harness нет", { exact: true }).first().waitFor({ timeout: 15_000 });
  const pageShot = await shot("harness-page");
  await check("harness.page_builtin", "страница «Harness» из меню: встроенные записи, «Claude Code в песочнице» со статусом «Готово», своих harness нет", async () => {
    const text = plain(await claudeRow.textContent());
    assert(text.includes("claude-acp") && text.includes("Готово"), `строка Claude Code: «${text}»`);
    return pageShot;
  });
  await page.getByRole("button", { name: "Новый harness" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новый harness" });
  await dialog.waitFor();
  await dialog.locator("#harness-card-name").fill(names.harnessName);
  await dialog.locator("#harness-card-id").fill(names.harnessId);
  await dialog.locator("#harness-card-command").fill("node");
  await dialog.locator("#harness-card-args").fill(`-e\n${ECHO_AGENT}`);
  await dialog.getByRole("checkbox", { name: "Anthropic Messages" }).check();
  const filled = await shot("harness-card-filled");
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await page.getByText("Harness создан", { exact: true }).first().waitFor({ timeout: 15_000 });
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  await tableRow(names.harnessName).waitFor({ timeout: 15_000 });
  const listed = await shot("harness-card-listed");
  const cards = await api("GET", "/v1/oma/harness_cards");
  const catalog = await api("GET", "/v1/oma/harnesses");
  saveJson("26-harness-cards", cards);
  saveJson("27-harnesses", catalog);
  const card = (cards.data ?? []).find((c) => c.harness_id === names.harnessId);
  const entry = (catalog.data ?? []).find((e) => e.id === names.harnessId);
  ids.harnessCard = card?.id;
  const ok = await check("harness.card_created", `карточка своего harness создана в консоли: ${names.harnessId}, команда node -e <агент>, протокол anthropic-messages, статус «Не проверено» (API карточек и каталог)`, () => {
    assert(card, `нет карточки ${names.harnessId} в GET /v1/oma/harness_cards`);
    assert(card.name === names.harnessName && card.command === "node", `name ${card.name}, command ${card.command}`);
    assert(card.args?.length === 2 && card.args[0] === "-e" && card.args[1] === ECHO_AGENT, `args: ${JSON.stringify(card.args).slice(0, 120)}`);
    assert(JSON.stringify(card.protocols) === JSON.stringify(["anthropic-messages"]), `protocols ${JSON.stringify(card.protocols)}`);
    assert(card.cwd === WORKDIR && card.status === "unverified", `cwd ${card.cwd}, status ${card.status}`);
    assert(entry?.source === "card" && entry.runtime_harness === "acp-sandbox" && entry.status === "unverified", `запись каталога: ${JSON.stringify(entry ?? null).slice(0, 200)}`);
    assert(entry.acp?.agent?.id === names.harnessId && entry.acp?.agent?.command === "node", `блок acp каталога: ${JSON.stringify(entry.acp?.agent ?? null).slice(0, 160)}`);
    return `api/cc-26-harness-cards.json, api/cc-27-harnesses.json, ${filled}, ${listed}`;
  });
  if (ok) cover("harness-card-page");
}

// Окно «Новый агент»: пустой шаблон, название и промпт в разделе «Основное».
async function openBlankAgentForm(name, system) {
  await openSection("Агенты", "Агентов пока нет");
  await page.getByRole("button", { name: "Новый агент" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новый агент" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: /^Пустой агент/ }).click();
  await dialog.locator("#agent-name").fill(name);
  await dialog.locator("#agent-system").fill(system);
  return dialog;
}
// Пункт списка выбора Harness или модели (Popover и Command): cmdk пишет в data-value
// строку «<id> <подпись>» (HarnessPicker.tsx, ModelPicker.tsx).
const commandItem = (id) => page.locator(`[data-slot="command-item"][data-value^="${id} "]`).first();
async function pickFromCombobox(box, id) {
  await box.click();
  const item = commandItem(id);
  await item.waitFor({ timeout: 15_000 });
  await item.click();
  await box.filter({ hasText: id }).or(box.filter({ hasText: names.harnessName })).first().waitFor({ timeout: 10_000 });
}
async function createAgentAndOpen(dialog, name) {
  await dialog.getByRole("button", { name: "Создать агента", exact: true }).click();
  try {
    await page.waitForURL(/\/agents\/[^/]+$/, { timeout: 30_000 });
  } catch {
    const alert = await dialog.getByRole("alert").first().textContent().catch(() => null);
    throw new Error(`агент не создан${alert ? `: ${alert}` : ""}`);
  }
  const id = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  created.agents.push(id);
  saveCreated();
  await page.getByRole("heading", { level: 1, name }).first().waitFor();
  return id;
}

// Агент Claude Code из формы: Harness «Claude Code в песочнице», модель карточки. Форма
// пишет блок _oma.acp из каталога и убирает усилие. Список allow расширяется в YAML той же формы.
async function stepAgent() {
  const dialog = await openBlankAgentForm(names.agent, "Агент на Claude Code. Работай в рабочей папке сессии.");
  const harnessBox = dialog.getByRole("combobox", { name: "Harness", exact: true });
  const modelBox = dialog.getByRole("combobox", { name: "Модель", exact: true });
  // Своя карточка со страницы «Harness» видна в списке, группа «Свои».
  await harnessBox.click();
  const ownItem = commandItem(names.harnessId);
  const ownGroup = page.locator("[cmdk-group]").filter({ has: page.locator("[cmdk-group-heading]", { hasText: /^Свои$/ }) });
  const ok_in_form = await check("harness.card_in_form", `своя карточка «${names.harnessName}» (${names.harnessId}) видна в списке Harness формы агента: группа «Свои», чип «Не проверено», пункт включён`, async () => {
    await ownItem.waitFor({ timeout: 15_000 });
    assert((await ownGroup.locator(`[data-value^="${names.harnessId} "]`).count()) > 0, "пункт не в группе «Свои»");
    const text = plain(await ownItem.textContent());
    assert(text.includes(names.harnessName) && text.includes("Не проверено"), `пункт: «${text}»`);
    assert((await ownItem.getAttribute("aria-disabled")) !== "true", `пункт выключен: ${await ownItem.getAttribute("title")}`);
    return shot("agent-harness-list");
  });
  if (ok_in_form) cover("harness-card-form");
  await page.keyboard.press("Escape");
  await ownItem.waitFor({ state: "hidden", timeout: 10_000 });
  // Со встроенным циклом выбрать модель OpenAI, затем Claude Code: форма заменяет модель на совместимую.
  await pickFromCombobox(modelBox, names.oaiCard);
  await pickFromCombobox(harnessBox, "claude-acp");
  const replacedNote = `Модель заменена: ${names.oaiCard} не работает с Claude Code в песочнице`;
  await check("cc.form_model_replaced", "при смене Harness на Claude Code несовместимая модель заменена на совместимую карточку, под полем «Модель заменена…»", async () => {
    await dialog.getByText(replacedNote, { exact: true }).waitFor({ timeout: 10_000 });
    const modelText = plain(await modelBox.textContent());
    assert(!modelText.includes(names.oaiCard), `в поле осталась ${names.oaiCard}: «${modelText}»`);
    return replacedNote;
  });
  // Несовместимая модель видна, но выключена; причина в строке, title и aria-describedby.
  await modelBox.click();
  const oaiItem = commandItem(names.oaiCard);
  await oaiItem.waitFor({ timeout: 15_000 });
  const reason = `Claude Code в песочнице работает только с моделями с протоколом anthropic-messages, у модели ${names.oaiCard}: ${(ids.oaiOption?.protocols ?? []).join(", ")}`;
  const ok_incompatible = await check("cc.form_incompatible_model", `в списке моделей при Harness «Claude Code в песочнице» ${names.oaiCard} выключена с причиной «${reason}», ${names.modelCard} включена`, async () => {
    assert((await oaiItem.getAttribute("aria-disabled")) === "true", `aria-disabled=${await oaiItem.getAttribute("aria-disabled")}`);
    const describedBy = await oaiItem.getAttribute("aria-describedby");
    const described = describedBy ? plain(await page.locator(`[id="${describedBy}"]`).textContent()) : "";
    assert(described === reason, `причина по aria-describedby: «${described}»`);
    assert((await oaiItem.getAttribute("title")) === reason, `title «${await oaiItem.getAttribute("title")}»`);
    assert((await commandItem(names.modelCard).getAttribute("aria-disabled")) !== "true", `${names.modelCard} выключена`);
    return shot("agent-model-incompatible");
  });
  if (ok_incompatible) cover("cc-incompatible-model");
  // Клик по выключенной модели ничего не выбирает.
  await oaiItem.click({ force: true }).catch(() => {});
  await commandItem(names.modelCard).click();
  await modelBox.filter({ hasText: names.modelCard }).waitFor({ timeout: 10_000 });
  await check("cc.form_acp_hints", "при Claude Code поле «Усилие» скрыто, видны «Усилие и скорость ACP-агенту не передаются» и требование к окружению с пакетом claude-agent-acp", async () => {
    assert((await dialog.getByRole("combobox", { name: "Усилие", exact: true }).count()) === 0, "поле «Усилие» видно");
    await dialog.getByText("Усилие и скорость ACP-агенту не передаются", { exact: true }).waitFor({ timeout: 5_000 });
    await dialog.getByText(`В окружении сессии должны стоять пакеты: npm ${CC_PACKAGE}`).first().waitFor({ timeout: 5_000 });
    return shot("agent-form-claude-code");
  });
  // Bash(ps:*) для второго хода: правка OMA_CLAUDE_SETTINGS в YAML той же формы.
  await dialog.getByRole("group", { name: "Режим правки" }).getByRole("button", { name: "YAML", exact: true }).click();
  const editor = dialog.getByRole("textbox", { name: "Конфигурация агента в формате YAML" });
  const formYaml = await editor.inputValue();
  const yamlText = formYaml.includes('"Edit"]')
    ? formYaml.replace('"Edit"]', `"Edit","${CLAUDE_ALLOW_EXTRA}"]`)
    : formYaml.replace('\\"Edit\\"]', `\\"Edit\\",\\"${CLAUDE_ALLOW_EXTRA}\\"]`);
  assert(yamlText !== formYaml, `в YAML формы нет списка allow с "Edit": ${formYaml.slice(0, 400)}`);
  await editor.fill(yamlText);
  writeFileSync(join(EV, "api", "cc-30-agent-create.yaml"), yamlText);
  await shot("agent-yaml");
  ids.agent = await createAgentAndOpen(dialog, names.agent);
  await shot("agent-detail");
  const ariaFile = await aria("agent-detail");
  const agent = await api("GET", `/v1/agents/${ids.agent}`);
  saveJson("31-agent", agent);
  const acp = agent._oma?.acp?.agent;
  let settings = null;
  try { settings = JSON.parse(acp?.env?.OMA_CLAUDE_SETTINGS ?? "null"); } catch { settings = null; }
  const ok_cc_agent = await check("cc.agent_harness", `агент из формы: harness acp-sandbox, ACP-агент claude-acp из каталога (sh, рабочая папка ${WORKDIR}), модель ${names.modelCard} без усилия, allow + ${CLAUDE_ALLOW_EXTRA}`, () => {
    const model = typeof agent.model === "string" ? agent.model : agent.model?.id;
    assert(agent._oma?.harness === "acp-sandbox", `_oma.harness ${agent._oma?.harness}`);
    assert(acp?.id === "claude-acp" && acp?.command === "sh", `_oma.acp.agent ${JSON.stringify({ id: acp?.id, command: acp?.command })}`);
    assert(acp?.cwd === WORKDIR, `cwd ${acp?.cwd}`);
    assert(model === names.modelCard, `model ${JSON.stringify(agent.model)}`);
    assert(typeof agent.model === "string" || (agent.model?.effort === undefined && agent.model?.speed === undefined), `усилие или скорость в модели: ${JSON.stringify(agent.model)}`);
    const allow = settings?.permissions?.allow ?? [];
    assert(["Read", "Write", "Edit", CLAUDE_ALLOW_EXTRA].every((rule) => allow.includes(rule)), `permissions.allow ${JSON.stringify(allow)}`);
    return "api/cc-31-agent.json, api/cc-30-agent-create.yaml";
  });
  await check("cc.agent_no_secret", "в конфигурации агента нет ключей, адреса модели и режима обхода разрешений", () => {
    const text = JSON.stringify(agent);
    for (const value of [cardSecret.key, vaultSecrets.modelKey.value]) assert(!text.includes(value), "значение ключа есть в агенте");
    assert(!/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN/.test(JSON.stringify(acp?.env ?? {})), `env агента: ${Object.keys(acp?.env ?? {}).join(", ")}`);
    assert(!/bypassPermissions|dangerously/i.test(text), "в агенте есть bypassPermissions/dangerously");
    return "api/cc-31-agent.json";
  });
  await check("cc.agent_detail_ui", "карточка агента: Harness «Claude Code в песочнице» и модель карточки", async () => {
    const text = plain(await page.getByRole("region", { name: "Свойства агента" }).first().textContent());
    assert(text.includes("Claude Code в песочнице") && text.includes(names.modelCard), `«Свойства агента»: ${text.slice(0, 240)}`);
    return ariaFile;
  });
  if (ok_cc_agent) cover("cc-agent");
}

async function stepSession() {
  await openSection("Сессии", "Сессий пока нет");
  await page.getByRole("button", { name: "Новая сессия" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новая сессия" });
  await dialog.waitFor();
  await pickCombobox(dialog, 0, ids.agent);
  await pickCombobox(dialog, 1, ids.environment);
  const vaultBox = dialog.getByRole("checkbox", { name: new RegExp(ids.vault) });
  await vaultBox.click();
  await dialog.locator("#session-title").fill(names.session);
  await shot("session-dialog");
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  ids.session = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  created.sessions.push(ids.session);
  saveCreated();
  await page.getByRole("textbox", { name: "Сообщение" }).waitFor();
  const session = await api("GET", `/v1/sessions/${ids.session}`);
  saveJson("40-session-created", session);
  const ok_cc_session = await check("cc.session_created", "сессия из консоли: этот агент, это окружение и хранилище с ключом", () => {
    assert(session.agent?.id === ids.agent, `agent ${session.agent?.id}`);
    assert(session.environment_id === ids.environment, `environment_id ${session.environment_id}`);
    assert((session.vault_ids ?? []).includes(ids.vault), `vault_ids ${JSON.stringify(session.vault_ids)}`);
    return "api/cc-40-session-created.json";
  });
  if (ok_cc_session) cover("cc-session");
}

async function stepTurn() {
  const box = page.getByRole("textbox", { name: "Сообщение" });
  await box.fill(PROMPT);
  const sendButton = page.getByRole("button", { name: /^(Отправить сообщение|Поставить сообщение в очередь)$/ }).first();
  await sendButton.waitFor();
  const stream = await captureStream(ids.session);
  const t0 = Date.now();
  await sendButton.click();
  for (let i = 0; i < 20 && (await box.inputValue()) !== ""; i++) await sleep(250);
  await shot("turn-sent");
  const events = await waitTurnIdle(ids.session, TURN_TIMEOUT, `nonce=${nonce}`);
  const turnSeconds = Math.round((Date.now() - t0) / 1000);
  const evFile = saveJson("41-session-events", events);
  const a = analyzeTurn(events);
  log(`ход занял ${turnSeconds} с, событий ${events.length}`);

  await check("cc.turn_no_error", "ход дошёл до session.status_idle (end_turn) без session.error", () => {
    assert(a.userMessage, `нет user.message с nonce=${nonce}`);
    assert(a.errors.length === 0, `session.error: ${JSON.stringify(a.errors.map((e) => e.error ?? e)).slice(0, 400)}`);
    assert(a.idle?.stop_reason?.type === "end_turn", `stop_reason ${JSON.stringify(a.idle?.stop_reason)}`);
    return `${evFile}; ход ${turnSeconds} с`;
  });
  await check("cc.tool_write", "Claude Code вызвал Write для verify.txt в рабочей папке, Write успешен", () => {
    assert(a.write, `нет agent.tool_use Write; инструменты: ${a.toolUses?.map((t) => t.name).join(", ")}`);
    assert(filePathOf(a.write) === `${WORKDIR}/verify.txt`, `file_path ${filePathOf(a.write)}`);
    assert(a.writeResult && !failedResult(a.writeResult), `результат Write: ${JSON.stringify(a.writeResult ?? null).slice(0, 300)}`);
    return `${evFile}: ${a.write.name} (${filePathOf(a.write)}) → ${textOf(a.writeResult.content).slice(0, 120)}`;
  });
  await check("cc.tool_read", "Claude Code прочитал файл (Read), в результате VERIFY_OK", () => {
    assert(a.read, "нет agent.tool_use Read");
    assert(filePathOf(a.read) === `${WORKDIR}/verify.txt`, `file_path ${filePathOf(a.read)}`);
    assert(a.readResult && !failedResult(a.readResult) && textOf(a.readResult.content).includes("VERIFY_OK"), `результат Read: ${JSON.stringify(a.readResult ?? null).slice(0, 300)}`);
    return `${evFile}: ${a.read.name} → ${plain(textOf(a.readResult.content)).slice(0, 80)}`;
  });
  await check("cc.event_order", "порядок: user.message → Write → результат → Read → результат → agent.message → idle", () => {
    const order = [a.userMessage, a.write, a.writeResult, a.read, a.readResult, a.lastMessage, a.idle].map((e) => (e ? a.pos(e) : -1));
    assert(order.every((p, i) => p >= 0 && (i === 0 || p > order[i - 1])), `позиции ${order.join(", ")}`);
    return order.join(" < ");
  });
  await check("cc.answer", FAKE ? `итоговый ответ VERIFY_CC_DONE_${nonce}` : "есть итоговый ответ (agent.message)", () => {
    assert(a.lastMessage, "нет agent.message");
    const text = textOf(a.lastMessage.content);
    if (FAKE) assert(text.includes(`VERIFY_CC_DONE_${nonce}`), `ответ: ${text.slice(0, 200)}`);
    else assert(text.trim().length > 0, "пустой ответ");
    return text.slice(0, 160);
  });
  if (["cc.turn_no_error", "cc.tool_write", "cc.tool_read", "cc.event_order", "cc.answer"]
    .every((id) => checks.some((c) => c.id === id && c.status === "проверено"))) cover("cc-turn");
  if (FAKE) {
    await check("cc.permission_denied", "Bash вне списка allow отклонён без режима обхода: tool_result is_error=true, файла bash-ran нет", () => {
      assert(a.bash, "нет agent.tool_use с контрольной командой Bash");
      // is_error ставит AcpTranslator для status=failed (apps/agent/src/harness/acp-translate.ts, #emitToolResult);
      // до правки 2026-10-16 отказ приходил только текстом «(status: failed)», и консоль рисовала «Готово».
      assert(a.bashResult?.is_error === true, `результат Bash: ${JSON.stringify(a.bashResult ?? null).slice(0, 300)}`);
      return `${a.bash.name} → ${plain(textOf(a.bashResult.content)).slice(0, 120)}`;
    }) && cover("cc-permissions");
  }

  // Ход на claude-acp: что видно в журнале событий и в логе сервера.
  const serverLines = serverLogLines();
  const acpInit = serverLines.filter((l) => l.includes("[acp-init]") && l.includes("mode=new"));
  const acpRuntime = serverLines.filter((l) => l.includes("[acp-runtime]") && l.includes("command=sh"));
  await check("cc.harness_claude_acp", "ход выполнил ACP-агент claude-acp: ACP-сессия поднята в песочнице ([acp-init] mode=new, [acp-runtime] command=sh), span.model_request_start перед Write", () => {
    assert(acpInit.length > 0, "в логе сервера нет [acp-init] … mode=new");
    assert(acpRuntime.length > 0, "в логе сервера нет [acp-runtime] … command=sh");
    // API событий не отдаёт поле model у span.model_request_start; сам span ставит AcpTranslator.
    assert(a.spanStart && a.pos(a.spanStart) < a.pos(a.write), "нет span.model_request_start перед Write");
    return `${plain(acpInit.at(-1)).slice(0, 140)}; ${plain(acpRuntime.at(-1)).slice(0, 100)}`;
  });
  const pkgLines = serverLines.filter((l) => l.includes(`installing environment packages (npm: ${CC_PACKAGE})`));
  const pkgDone = serverLines.filter((l) => l.includes("environment packages installed in"));
  await check("cc.package_installed", `при старте VM установлен ${CC_PACKAGE} (пакеты окружения, лог litebox-sandbox)`, () => {
    assert(pkgLines.length > 0, "нет строки installing environment packages (npm: …)");
    assert(pkgDone.length > 0, "нет строки environment packages installed");
    return plain(pkgDone.at(-1)).match(/environment packages installed in \d+ ms/)?.[0] ?? "есть";
  });

  // UI: ход, ответ, карточки инструментов, файлы.
  const article = page.locator("article[data-turn-id]").last();
  await check("cc.ui_turn_done", "в консоли ход завершён и виден ответ", async () => {
    await article.waitFor({ timeout: 60_000 });
    const t1 = Date.now();
    let status = await article.getAttribute("data-session-turn-status");
    while (/^(running|queued)$/.test(status ?? "running") && Date.now() - t1 < 60_000) {
      await sleep(1000);
      status = await article.getAttribute("data-session-turn-status");
    }
    assert(/^complete(d)?$/.test(status ?? ""), `data-session-turn-status=${status}`);
    const answer = article.locator("[data-session-turn-answer]").first();
    await answer.waitFor({ timeout: 30_000 });
    if (FAKE) assert((await answer.textContent())?.includes(`VERIFY_CC_DONE_${nonce}`), "в ответе нет VERIFY_CC_DONE");
    return `${await shot("turn-done")}, ${await aria("turn-done")}`;
  });
  // Страница сессии как в консоли Claude (с 2026-10-16): каждый вызов инструмента стоит в ходе строкой
  // [data-tool-call][data-event-id=<id agent.tool_use>] (ToolRow в components/session/CanonicalSessionTurn.tsx),
  // кнопка строки раскрывает вызов ([data-tool-details], вывод в [data-tool-output]), статус «Ошибка» бейджем.
  // Файлы сессии лежат на вкладке «Ресурсы» инспектора, панели «Файлы сессии» больше нет.
  const toolRow = (event) => article.locator(`[data-tool-call][data-event-id="${event?.id}"]`).first();
  await check("cc.ui_tool_cards", "в ходе видны строки вызовов Claude Code Write и Read (id из журнала), раскрытый Read показывает VERIFY_OK", async () => {
    assert(a.write?.id && a.read?.id, "в журнале нет agent.tool_use Write и Read");
    for (const [kind, event] of [["Write", a.write], ["Read", a.read]]) {
      const row = toolRow(event);
      await row.waitFor({ timeout: 15_000 });
      const title = plain(await row.locator("button[aria-expanded]").first().innerText());
      assert(title.startsWith(kind), `строка вызова ${event.id}: «${title.slice(0, 120)}»`);
    }
    const readRow = toolRow(a.read);
    if ((await readRow.getAttribute("data-open")) !== "true") await readRow.locator("button[aria-expanded]").first().click();
    await readRow.locator("[data-tool-details] [data-tool-output]", { hasText: "VERIFY_OK" }).first().waitFor({ timeout: 15_000 });
    return shot("turn-tool-cards");
  }) && cover("cc-tool-cards");
  if (FAKE) {
    await check("cc.ui_denied_badge", "строка отклонённого Bash в консоли с бейджем «Ошибка»", async () => {
      assert(a.bash?.id, "в журнале нет agent.tool_use с контрольной командой Bash");
      const row = toolRow(a.bash);
      await row.waitFor({ timeout: 15_000 });
      const title = plain(await row.locator("button[aria-expanded]").first().innerText());
      assert(title.includes("bash-ran-") && title.includes("Ошибка"), `строка вызова: ${title.slice(0, 160)}`);
      return title.slice(0, 120);
    });
  }
  await check("cc.ui_files", `на вкладке «Ресурсы» инспектора есть ${WORKDIR}/verify.txt со ссылкой на скачивание`, async () => {
    const inspector = page.getByRole("complementary", { name: "Инспектор сессии" });
    if (!(await inspector.count())) await page.getByRole("button", { name: "Инспектор", exact: true }).click();
    await inspector.waitFor({ timeout: 15_000 });
    await inspector.getByRole("tablist", { name: "Вкладки инспектора" }).getByRole("tab", { name: "Ресурсы", exact: true }).click();
    const link = inspector.getByRole("link", { name: `${WORKDIR}/verify.txt` });
    await link.waitFor({ timeout: 15_000 });
    const href = await link.getAttribute("href");
    assert(href?.endsWith("/outputs/verify.txt"), `ссылка ведёт на ${href}`);
    return shot("session-files");
  }) && cover("cc-files");
  await sleep(500);
  await stream.stop();
  const sseFile = saveJson("41-session-stream", stream.seen);
  const sseTools = stream.seen.events.filter((e) => e.type === "agent.tool_use").map((e) => toolKind(e));
  record("cc.sse_tools", "поток /events/stream отдал вживую agent.tool_use Write и Read",
    sseTools.includes("Write") && sseTools.includes("Read") ? "проверено" : "внимание", sseFile,
    sseTools.includes("Write") && sseTools.includes("Read") ? "" : `HTTP ${stream.seen.status}, tool_use: ${sseTools.join(", ") || "нет"}`);

  // Выводы сессии: API и файл на хосте (каталог смонтирован в VM как /mnt/session/outputs).
  const outputs = await api("GET", `/v1/sessions/${ids.session}/outputs`);
  saveJson("43-session-outputs", outputs);
  const outNames = (outputs.data ?? []).map((f) => f.filename);
  await check("cc.outputs_api", "GET /v1/sessions/:id/outputs содержит verify.txt" + (FAKE ? ", а bash-ran-* нет" : ""), () => {
    assert(outNames.includes("verify.txt"), `файлы: ${outNames.join(", ")}`);
    if (FAKE) assert(!outNames.some((n) => n.startsWith("bash-ran-")), `есть файл отклонённой команды: ${outNames.join(", ")}`);
    return `api/cc-43-session-outputs.json: ${outNames.join(", ")}`;
  });
  const hostDir = join(run.SESSION_OUTPUTS_DIR, user.tenant_id, ids.session);
  const hostFile = join(hostDir, "verify.txt");
  await check("cc.outputs_file", "verify.txt, записанный Claude Code в VM, лежит на хосте и содержит VERIFY_OK", () => {
    assert(existsSync(hostFile), `нет ${hostFile}`);
    const content = readFileSync(hostFile, "utf8");
    assert(content.includes("VERIFY_OK"), `содержимое: ${content.slice(0, 80)}`);
    if (FAKE) assert(!existsSync(join(hostDir, `bash-ran-${nonce}.txt`)), "файл отклонённой команды Bash есть на хосте");
    copyFileSync(hostFile, join(EV, "api", "cc-44-verify.txt"));
    return hostFile;
  });

  // VM: процесс boxlite-shim запущен нашим сервером, BoxLite записал старт.
  await check("cc.vm_process", "VM BoxLite запущена нашим сервером (boxlite-shim, потомок server-node), Box started в логе", () => {
    const shims = boxliteLines().map((l) => l.match(/boxlite-shim subprocess spawned box_id=(\S+) pid=(\d+)/)).filter(Boolean);
    assert(boxliteCount("Box started successfully") > 0, "нет Box started successfully после старта прогона");
    assert(shims.length > 0, "нет строки boxlite-shim subprocess spawned");
    const last = shims.at(-1);
    const pid = Number(last[2]);
    const chain = ancestry(pid);
    assert(procStat(pid), `процесса ${pid} нет`);
    assert(chain.includes(recordedPid("server-node")), `цепочка ${chain.join(" <- ")} без server-node`);
    return `box ${last[1]}: ${chain.map((p) => `${p}(${procComm(p)})`).join(" <- ")}`;
  });

  if (FAKE) {
    const reqs = fakeRequests();
    const main = reqs.filter((r) => r.decision !== "cc_side");
    writeFileSync(join(EV, "api", "cc-fake-model-requests.json"), JSON.stringify(reqs, null, 2));
    await check("cc.fake_model_claude_cli", "модель вызывал Claude Code из VM: user-agent claude-cli, его инструменты Write/Read/Bash", () => {
      assert(main.length > 0, "нет запросов к фейку с этим nonce");
      assert(reqs.every((r) => /^claude-cli\//.test(r.user_agent ?? "")), `user-agent: ${[...new Set(reqs.map((r) => r.user_agent))].join(" | ")}`);
      assert(["Write", "Read", "Bash"].every((t) => (main[0].tools ?? []).includes(t)), `инструменты: ${(main[0].tools ?? []).join(",")}`);
      return `${reqs[0].user_agent}; запросов ${reqs.length}`;
    });
    await check("cc.fake_model_flow", "фейк: Write → Read → Bash → текст, рабочая папка /mnt/session/outputs, Bash отклонён", () => {
      const flow = main.map((r) => r.decision).join(",");
      assert(flow === "cc_write,cc_read,cc_bash_probe,cc_final_text", `решения: ${flow}`);
      assert(main.every((r) => r.workdir === WORKDIR), `workdir: ${[...new Set(main.map((r) => r.workdir))].join(",")}`);
      assert(main.at(-1).bash_denied === true, "bash_denied не true");
      return "api/cc-fake-model-requests.json";
    });
    // Прокси сервера (apps/main-node/src/lib/http-inference-proxy.ts) срезает входящий токен
    // хода, ставит ключ карточки и меняет model на wire_model. Claude Code шлёт handle карточки
    // (ANTHROPIC_MODEL, окружение проверяет второй ход), а фейк видит только wire_model.
    await check("cc.proxy_card_key", `Claude Code ходит в модель через прокси сервера: во всех запросах хода ключ карточки ${names.modelCard} (x-api-key, sha256), без Bearer, model = wire_model ${WIRE_MODEL}; ключа из хранилища нет`, () => {
      const want = sha12(cardSecret.key);
      const got = [...new Set(reqs.map((r) => r.api_key_sha256))];
      const vaultSha = sha12(vaultSecrets.modelKey.value);
      assert(got.length === 1 && got[0] === want, `sha256 x-api-key в запросах ${got.join(",")}, ожидался ключ карточки ${want}${got.includes(vaultSha) ? "; пришёл ключ из хранилища" : ""}`);
      const bearers = [...new Set(reqs.map((r) => r.bearer_sha256))];
      assert(bearers.length === 1 && bearers[0] === null, `Bearer в запросах к модели: ${bearers.join(",")}; токен хода дошёл до провайдера`);
      const models = [...new Set(reqs.map((r) => r.model))];
      assert(models.length === 1 && models[0] === WIRE_MODEL, `model в запросах: ${models.join(",")}, ожидалась ${WIRE_MODEL} (swapModelInJsonBody)`);
      return `x-api-key sha256 ${want} (карточка), model ${WIRE_MODEL}, запросов ${reqs.length}`;
    }) && cover("cc-proxy");
  }
}

// Второй ход в той же сессии. main-node создаёт харнесс на каждый ход и после хода
// закрывает его (runHarnessForTurn, dispose "shutdown"): процесс claude-agent-acp первого
// хода завершён, второй ход поднимает новый и возобновляет ACP-сессию по чекпойнту.
// Без dispose в VM жили бы два claude-agent-acp.
async function stepSecondTurn() {
  const box = page.getByRole("textbox", { name: "Сообщение" });
  await box.fill(PROMPT2);
  const sendButton = page.getByRole("button", { name: /^(Отправить сообщение|Поставить сообщение в очередь)$/ }).first();
  await sendButton.waitFor();
  const initBefore = serverLogLines().filter((l) => l.includes("[acp-init]")).length;
  const hostSeen = new Set();
  const sampleHost = () => { for (const line of hostAcpProcesses()) hostSeen.add(line); };
  const t0 = Date.now();
  await sendButton.click();
  for (let i = 0; i < 20 && (await box.inputValue()) !== ""; i++) await sleep(250);
  await shot("turn2-sent");
  const events = await waitTurnIdle(ids.session, TURN_TIMEOUT, TURN2_MARKER, sampleHost);
  sampleHost();
  const turnSeconds = Math.round((Date.now() - t0) / 1000);
  const evFile = saveJson("42-session-events-turn2", events);
  const a = analyzeTurn(events, TURN2_MARKER);
  log(`второй ход занял ${turnSeconds} с`);

  await check("cc.turn2_no_error", "второй ход в той же сессии дошёл до session.status_idle (end_turn) без session.error", () => {
    assert(a.userMessage, `нет user.message с ${TURN2_MARKER}`);
    assert(a.errors.length === 0, `session.error: ${JSON.stringify(a.errors.map((e) => e.error ?? e)).slice(0, 400)}`);
    assert(a.idle?.stop_reason?.type === "end_turn", `stop_reason ${JSON.stringify(a.idle?.stop_reason)}`);
    return `${evFile}; ход ${turnSeconds} с`;
  });
  const inits = serverLogLines().filter((l) => l.includes("[acp-init]")).slice(initBefore);
  const resumeFailures = serverLogLines().filter((l) => /\[acp\] session\/(resume|load)\(.*failed/.test(l));
  const turn2Requests = FAKE ? fakeRequests().filter((r) => String(r.decision).startsWith("cc2_")) : [];
  await check("cc.turn2_resumed", "второй ход поднял новый claude-agent-acp и возобновил ACP-сессию первого хода ([acp-init] mode=resume|load)", () => {
    assert(inits.length === 1, `строк [acp-init] за второй ход: ${inits.length}`);
    const mode = inits[0].match(/mode=(\S+)/)?.[1];
    assert(mode === "resume" || mode === "load", `mode=${mode}; ошибки возобновления: ${resumeFailures.map(plain).join(" | ").slice(0, 300) || "нет"}`);
    if (FAKE) assert(turn2Requests.length > 0 && turn2Requests.every((r) => r.history_has_turn1 === true), `в истории запросов второго хода нет реплики первого: ${JSON.stringify(turn2Requests.map((r) => r.history_has_turn1))}`);
    return `${plain(inits[0]).slice(0, 140)}${FAKE ? "; в истории модели есть реплика первого хода" : ""}`;
  });
  const psUse = a.toolUses?.find((t) => /^ps\b/.test(String(t.input?.command ?? "")));
  const psResult = psUse && a.results.find((r) => r.tool_use_id === psUse.id);
  // Вывод Bash Claude Code в agent.tool_result не попадает: AcpTranslator пишет только
  // «(status: completed)» (ACP присылает вывод терминалом). Поэтому вывод ps берётся из
  // запроса Claude Code к фейку: это то, что Claude Code получил от своего Bash в VM.
  const psRequest = turn2Requests.findLast((r) => r.decision === "cc2_final_text");
  const acpLines = psRequest?.acp_lines ?? [];
  writeFileSync(join(EV, "api", "cc-45-turn2-ps.txt"), [
    `agent.tool_result: ${plain(textOf(psResult?.content))}`,
    `строки claude-agent-acp (запрос Claude Code к фейку): ${acpLines.length}`,
    ...acpLines,
    "начало вывода ps:",
    psRequest?.tool_result_excerpt ?? "",
  ].join("\n"));
  let ok_vm = false;
  let ok_host = false;
  if (FAKE) {
    ok_vm = await check("cc.acp_in_vm_single", "в VM во время второго хода ровно один процесс claude-agent-acp (процесс первого хода закрыт), ps выполнил Claude Code в VM", () => {
      assert(psUse, `нет agent.tool_use Bash с ps; инструменты: ${a.toolUses?.map((t) => t.name).join(", ")}`);
      assert(psResult && !failedResult(psResult), `результат ps: ${JSON.stringify(psResult ?? null).slice(0, 300)}`);
      assert(psRequest, "нет запроса cc2_final_text к фейку с выводом ps");
      assert(psRequest.acp_processes === 1, `процессов claude-agent-acp ${psRequest.acp_processes}: ${acpLines.join(" | ").slice(0, 300)}`);
      return `api/cc-45-turn2-ps.txt: ${plain(acpLines[0]).slice(0, 120)}`;
    });
    ok_host = await check("cc.acp_not_on_host", "на хосте среди потомков server-node процесса claude-agent-acp не было ни разу за второй ход, а в VM он был", () => {
      assert(hostSeen.size === 0, `на хосте: ${[...hostSeen].join(" | ").slice(0, 300)}`);
      assert(acpLines.length > 0, "в VM процесс не найден, сравнивать не с чем (см. cc.acp_in_vm_single)");
      return "опрос /proc хоста каждые 2 с во время хода; в VM строка из вывода ps";
    });
    // Окружение главного claude-agent-acp в VM (ps eww, шаг cc2_env фейка): имена, sha256 значений,
    // адрес и модель. Адаптер Claude (packages/harness-inference-adapters/src/adapters/claude.ts)
    // ставит адрес прокси и токен хода; ключи моделей хранилища сервер в VM не кладёт
    // (skipModelKeys в apps/main-node/src/lib/node-managed-vault-env.ts).
    const env = psRequest?.env ?? null;
    const proxyUrl = `${GATEWAY_VM}/v1/oma/inference-proxy/${ids.session}/anthropic`;
    const envFile = saveJson("46-turn2-env", { proxy_expected: proxyUrl, env, env_error: psRequest?.env_error ?? null });
    const ok_proxy_env = await check("cc.vm_env_proxy", `Claude Code в VM ходит в модель через прокси с токеном сессии: у claude-agent-acp ANTHROPIC_BASE_URL = ${proxyUrl}, ANTHROPIC_AUTH_TOKEN = токен хода oma_sbx_…, ANTHROPIC_MODEL = ${names.modelCard}`, () => {
      assert(env, `нет окружения процесса claude-agent-acp: ${psRequest?.env_error ?? "шаг ps eww не выполнен (решения второго хода: " + turn2Requests.map((r) => r.decision).join(",") + ")"}`);
      assert(env.anthropic_base_url === proxyUrl, `ANTHROPIC_BASE_URL ${env.anthropic_base_url}`);
      assert(env.auth_token_prefix === "oma_sbx_", `ANTHROPIC_AUTH_TOKEN начинается с «${env.auth_token_prefix}»`);
      assert(env.anthropic_model === names.modelCard, `ANTHROPIC_MODEL ${env.anthropic_model}`);
      return `${envFile}: переменных ${env.names.length}`;
    });
    const modelKeyNames = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"];
    const skipped = serverLogLines().filter((l) => l.includes('"op":"main-node.vault_env.model_key_skipped"') && l.includes(`"secretName":"${vaultSecrets.modelKey.name}"`));
    const ok_no_key = await check("cc.vm_env_no_key", `ключа модели в окружении VM нет: у claude-agent-acp нет ${modelKeyNames.join(", ")}, нет значений ключа карточки и ключа ${vaultSecrets.modelKey.name} из хранилища сессии; ${vaultSecrets.modelKey.name} хранилища сервер пропустил (model_key_skipped), а ${vaultSecrets.note.name} дошла`, () => {
      assert(env, "нет окружения процесса (см. cc.vm_env_proxy)");
      const leaked = modelKeyNames.filter((name) => env.names.includes(name));
      assert(leaked.length === 0, `в окружении VM есть ${leaked.join(", ")}`);
      const shas = Object.values(env.sha12 ?? {});
      assert(!shas.includes(sha12(cardSecret.key)), "значение ключа карточки есть в окружении VM");
      assert(!shas.includes(sha12(vaultSecrets.modelKey.value)), `значение ${vaultSecrets.modelKey.name} из хранилища есть в окружении VM`);
      assert(env.sha12?.[vaultSecrets.note.name] === sha12(vaultSecrets.note.value), `${vaultSecrets.note.name} хранилища нет в окружении VM: переменные хранилища не дошли, проверка пропуска ключа ничего не доказывает`);
      assert(skipped.length > 0, `в логе сервера нет main-node.vault_env.model_key_skipped для ${vaultSecrets.modelKey.name}`);
      return `${envFile}; ${plain(skipped[0]).match(/"op":"[^"]+"/)?.[0] ?? ""}`;
    });
    if (ok_proxy_env && ok_no_key) cover("cc-no-key-in-vm");
    if (env?.names?.includes(vaultSecrets.note.name)) {
      record("cc.vault_plain_in_vm", "переменные хранилища, кроме ключей моделей, лежат в VM открытым текстом", "внимание", envFile,
        `${vaultSecrets.note.name} есть в окружении claude-agent-acp: подстановки секрета на выходе нет, это видят Claude Code, его инструменты и bash`);
    }
  } else {
    record("cc.acp_in_vm_single", "в VM один процесс claude-agent-acp", "не проверено", "",
      "в режиме real вывод Bash Claude Code в событиях не виден (только «(status: completed)»), а журнала фейка нет");
    record("cc.vm_env_proxy", "у claude-agent-acp в VM адрес прокси сессии и токен хода", "не проверено", "",
      "окружение процесса видно только в выводе ps, который Claude Code отправляет фейку; в режиме real журнала фейка нет");
    record("cc.vm_env_no_key", "ключа модели в окружении VM нет", "не проверено", "", "как cc.vm_env_proxy");
    ok_host = await check("cc.acp_not_on_host", "на хосте среди потомков server-node процесса claude-agent-acp не было ни разу за второй ход", () => {
      assert(hostSeen.size === 0, `на хосте: ${[...hostSeen].join(" | ").slice(0, 300)}`);
      return "опрос /proc хоста каждые 2 с во время хода";
    });
    ok_vm = ok_host;
  }
  const article = page.locator("article[data-turn-id]").last();
  const ok_ui = await check("cc.ui_turn2_done", "в консоли второй ход завершён" + (FAKE ? `, ответ VERIFY_CC_TURN2_${nonce}` : ""), async () => {
    const t1 = Date.now();
    let status = await article.getAttribute("data-session-turn-status");
    while (/^(running|queued)$/.test(status ?? "running") && Date.now() - t1 < 60_000) {
      await sleep(1000);
      status = await article.getAttribute("data-session-turn-status");
    }
    assert(/^complete(d)?$/.test(status ?? ""), `data-session-turn-status=${status}`);
    const answer = article.locator("[data-session-turn-answer]").first();
    await answer.waitFor({ timeout: 30_000 });
    if (FAKE) assert((await answer.textContent())?.includes(`VERIFY_CC_TURN2_${nonce} acp_processes=1`), `ответ: ${plain(await answer.textContent()).slice(0, 160)}`);
    return shot("turn2-done");
  });
  if (ok_vm && ok_host && ok_ui && checks.some((c) => c.id === "cc.turn2_resumed" && c.status === "проверено")) cover("cc-multi-turn");
}

async function archiveAndProveStop(sessionId = ids.session, checkId = "cc.vm_stopped", file = "50-session-archived") {
  const before = boxliteCount("Box stopped");
  const archived = await api("POST", `/v1/sessions/${sessionId}/archive`);
  saveJson(file, archived);
  let state = { scratch: scratchDirs(sessionId), stopped: before };
  for (let i = 0; i < 60; i++) {
    state = { scratch: scratchDirs(sessionId), stopped: boxliteCount("Box stopped") };
    if (state.scratch.length === 0 && state.stopped > before) break;
    await sleep(1000);
  }
  const ok_archive = await check(checkId, "после архива сессии VM остановлена (Box stopped) и scratch удалён", () => {
    assert(archived?.archived_at, "archived_at пустой");
    assert(state.stopped > before, `новых «Box stopped» нет (было ${before}, стало ${state.stopped})`);
    assert(state.scratch.length === 0, `scratch остался: ${state.scratch.join(", ")}`);
    return `Box stopped: ${before} → ${state.stopped}`;
  });
  if (ok_archive && checkId === "cc.vm_stopped") cover("cc-archive");
  return ok_archive;
}

// Агент на своей карточке harness из формы: Harness из группы «Свои», модель карточки.
async function stepCardAgent() {
  const dialog = await openBlankAgentForm(names.cardAgent, "Агент на своей карточке harness: отвечает эхом и одной строкой о модели.");
  const harnessBox = dialog.getByRole("combobox", { name: "Harness", exact: true });
  const modelBox = dialog.getByRole("combobox", { name: "Модель", exact: true });
  await pickFromCombobox(harnessBox, names.harnessId);
  await pickFromCombobox(modelBox, names.modelCard);
  const hint = "Свой ACP-агент из карточки. Запускается в VM окружения командой node. Не проверено.";
  await dialog.getByText(hint, { exact: true }).waitFor({ timeout: 10_000 });
  await shot("card-agent-form");
  ids.cardAgent = await createAgentAndOpen(dialog, names.cardAgent);
  await shot("card-agent-detail");
  const agent = await api("GET", `/v1/agents/${ids.cardAgent}`);
  saveJson("60-card-agent", agent);
  const acp = agent._oma?.acp?.agent;
  await check("harness.card_agent", `агент из формы на своей карточке: _oma.harness acp-sandbox, _oma.acp.agent из карточки (id ${names.harnessId}, node -e), модель ${names.modelCard}; карточка агента показывает Harness с «Не проверено»`, async () => {
    const model = typeof agent.model === "string" ? agent.model : agent.model?.id;
    assert(agent._oma?.harness === "acp-sandbox", `_oma.harness ${agent._oma?.harness}`);
    assert(acp?.id === names.harnessId && acp?.command === "node", `_oma.acp.agent ${JSON.stringify({ id: acp?.id, command: acp?.command })}`);
    assert(acp?.args?.[0] === "-e" && acp?.args?.[1] === ECHO_AGENT, `args ${JSON.stringify(acp?.args ?? null).slice(0, 120)}`);
    assert(model === names.modelCard, `model ${JSON.stringify(agent.model)}`);
    const text = plain(await page.getByRole("region", { name: "Свойства агента" }).first().textContent());
    assert(text.includes(names.harnessName) && text.includes("Не проверено"), `«Свойства агента»: ${text.slice(0, 240)}`);
    return "api/cc-60-card-agent.json";
  });
}

// Ход агента на своей карточке: сессия и сообщение через консоль. Тестовый ACP-агент в VM
// получает OMA_INFERENCE_* (cardInferenceEnv, apps/main-node/src/lib/sandbox-hosted-inference.ts),
// зовёт модель через прокси с токеном хода и отвечает одной строкой.
async function stepCardTurn() {
  await openSection("Сессии", "Сессий пока нет");
  await page.getByRole("button", { name: "Новая сессия" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новая сессия" });
  await dialog.waitFor();
  await pickCombobox(dialog, 0, ids.cardAgent);
  await pickCombobox(dialog, 1, ids.environment);
  await dialog.locator("#session-title").fill(names.cardSession);
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  ids.cardSession = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  created.sessions.push(ids.cardSession);
  saveCreated();
  const box = page.getByRole("textbox", { name: "Сообщение" });
  await box.waitFor();
  await box.fill(["ответь эхом и скажи, что ответила модель", `VERIFY_ACP_CARD nonce=${cardNonce}`].join("\n"));
  const sendButton = page.getByRole("button", { name: /^(Отправить сообщение|Поставить сообщение в очередь)$/ }).first();
  await sendButton.waitFor();
  const runtimeBefore = serverLogLines().filter((l) => l.includes("[acp-runtime]") && l.includes("command=node")).length;
  const startedBefore = boxliteCount("Box started successfully");
  const hostSeen = new Set();
  const sampleHost = () => { for (const line of hostProcessesWith("VERIFY_ACP_ECHO_")) hostSeen.add(line); };
  const t0 = Date.now();
  await sendButton.click();
  for (let i = 0; i < 20 && (await box.inputValue()) !== ""; i++) await sleep(250);
  await shot("card-turn-sent");
  const events = await waitTurnIdle(ids.cardSession, TURN_TIMEOUT, `nonce=${cardNonce}`, sampleHost);
  sampleHost();
  const turnSeconds = Math.round((Date.now() - t0) / 1000);
  const evFile = saveJson("61-card-session-events", events);
  const a = analyzeTurn(events, `nonce=${cardNonce}`);
  const answer = textOf(a.lastMessage?.content);
  const field = (name) => answer.match(new RegExp(`(?:^|\\s)${name}=(\\S*)`))?.[1] ?? null;
  const proxyUrl = `${GATEWAY_VM}/v1/oma/inference-proxy/${ids.cardSession}/anthropic`;
  log(`ход своего harness занял ${turnSeconds} с: ${plain(answer).slice(0, 200)}`);
  const ok_turn = await check("harness.card_turn", `агент на своей карточке ответил в сессии: agent.message VERIFY_ACP_ECHO_${cardNonce}, session.status_idle end_turn, без session.error`, () => {
    assert(a.userMessage, `нет user.message с nonce=${cardNonce}`);
    assert(a.errors.length === 0, `session.error: ${JSON.stringify(a.errors.map((e) => e.error ?? e)).slice(0, 400)}`);
    assert(answer.includes(`VERIFY_ACP_ECHO_${cardNonce}`), `ответ: «${plain(answer).slice(0, 200)}»`);
    assert(a.idle?.stop_reason?.type === "end_turn", `stop_reason ${JSON.stringify(a.idle?.stop_reason)}`);
    return `${evFile}; ход ${turnSeconds} с`;
  });
  const ok_proxy = await check("harness.card_proxy", `свой агент в VM получил прокси модели этой сессии (OMA_INFERENCE_BASE_URL ${proxyUrl}, протокол anthropic-messages, токен хода oma_sbx_…) и ответ модели${FAKE ? ` VERIFY_MODEL_SAW_${cardNonce}` : ""}; ключей моделей в его окружении нет: все переменные с KEY, TOKEN, SECRET, PASSWORD в имени несут токен хода`, () => {
    assert(field("base") === proxyUrl, `base=${field("base")}`);
    assert(field("protocol") === "anthropic-messages", `protocol=${field("protocol")}`);
    assert(field("token") === "oma_sbx_", `token=${field("token")}`);
    const model = field("model") ?? "";
    assert(FAKE ? model === `200:VERIFY_MODEL_SAW_${cardNonce}` : model.startsWith("200:"), `model=${model}`);
    // keys=<имя>:<true|false>: все переменные с KEY, TOKEN, SECRET, PASSWORD в имени и равно ли значение токену хода.
    const keys = (field("keys") ?? "").split(",").filter(Boolean).map((item) => item.split(":"));
    assert(keys.length > 0 && keys.every(([, same]) => same === "true" || same === "false"), `keys=${field("keys")}: тестовый агент без признака значения`);
    const leaked = keys.filter(([name]) => ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"].includes(name));
    assert(leaked.length === 0, `ключи моделей в окружении агента: ${leaked.map(([name]) => name).join(", ")}`);
    const foreign = keys.filter(([, same]) => same !== "true").map(([name]) => name);
    assert(foreign.length === 0, `переменные с ключом или токеном, значение которых не токен хода: ${foreign.join(", ")}`);
    return `ответ агента: ${plain(answer).replace(/base=\S+/, "base=<прокси сессии>").slice(0, 200)}`;
  });
  if (FAKE) {
    const reqs = fakeRequests(cardNonce);
    writeFileSync(join(EV, "api", "cc-62-card-fake-requests.json"), JSON.stringify(reqs, null, 2));
    await check("harness.card_fake_model", `запрос своего агента дошёл до модели через прокси: ключ карточки ${names.modelCard} (x-api-key), без Bearer, model = wire_model ${WIRE_MODEL}`, () => {
      assert(reqs.length === 1 && reqs[0].decision === "card_reply", `запросов с nonce ${cardNonce}: ${reqs.map((r) => r.decision).join(",") || "нет"}`);
      const r = reqs[0];
      assert(r.api_key_sha256 === sha12(cardSecret.key), `sha256 x-api-key ${r.api_key_sha256}, ожидался ключ карточки ${sha12(cardSecret.key)}`);
      assert(r.bearer_sha256 === null, "Bearer дошёл до модели: прокси не срезал токен хода");
      assert(r.model === WIRE_MODEL, `model ${r.model}, ожидалась ${WIRE_MODEL}`);
      return `api/cc-62-card-fake-requests.json: user-agent ${r.user_agent}`;
    });
  }
  const runtimeLines = serverLogLines().filter((l) => l.includes("[acp-runtime]") && l.includes("command=node"));
  const ok_vm = await check("harness.card_in_vm", "свой агент запущен в VM сессии: новая строка [acp-runtime] … command=node, BoxLite стартовал VM, на хосте среди потомков server-node процесса агента не было", () => {
    assert(runtimeLines.length > runtimeBefore, `строк [acp-runtime] command=node: было ${runtimeBefore}, стало ${runtimeLines.length}`);
    assert(boxliteCount("Box started successfully") > startedBefore, "BoxLite не записал новый старт VM");
    assert(hostSeen.size === 0, `на хосте: ${[...hostSeen].join(" | ").slice(0, 300)}`);
    return plain(runtimeLines.at(-1)).slice(0, 140);
  });
  const article = page.locator("article[data-turn-id]").last();
  const ok_ui = await check("harness.card_ui_answer", `в консоли ход своего агента завершён, ответ VERIFY_ACP_ECHO_${cardNonce}`, async () => {
    const t1 = Date.now();
    let status = await article.getAttribute("data-session-turn-status");
    while (/^(running|queued)$/.test(status ?? "running") && Date.now() - t1 < 60_000) {
      await sleep(1000);
      status = await article.getAttribute("data-session-turn-status");
    }
    assert(/^complete(d)?$/.test(status ?? ""), `data-session-turn-status=${status}`);
    await article.locator("[data-session-turn-answer]", { hasText: `VERIFY_ACP_ECHO_${cardNonce}` }).first().waitFor({ timeout: 30_000 });
    return shot("card-turn-done");
  });
  const ok_stop = KEEP_SESSION ? true : await archiveAndProveStop(ids.cardSession, "harness.card_vm_stopped", "63-card-session-archived");
  if (ok_turn && ok_proxy && ok_vm && ok_ui && ok_stop) cover("harness-card-turn");
}

// ------------------------------------------------------------------ итог ---
// Подфункции сценария: файлы features/*.md с пометкой «<!-- scenario: claude-code -->».
function featureEntries() {
  const dir = join(SKILL_DIR, "features");
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    if (!text.includes("<!-- scenario: claude-code -->")) continue;
    const section = text.split(/^## /m).find((s) => s.startsWith("Sub-features"));
    for (const line of (section ?? "").split("\n")) {
      const m = line.match(/^- `([a-z0-9-]+)`(?: —|:) (.+)$/);
      if (m) out.push({ id: m[1], desc: m[2], file });
    }
  }
  return out;
}

function writeSummary(abortError) {
  const failed = checks.filter((c) => c.status === "провал");
  const notChecked = [
    ...(FAKE
      ? [["cc.model_real", "настоящая модель Anthropic не вызывалась: режим fake. Путь с ключом API в карточке модели: VERIFY_CC_MODE=real, VERIFY_CC_SECRET_FILE (SKILL.md); Claude Code через наш прокси против настоящего API не проверялся"]]
      : [["cc.answer_text", "точный текст ответа настоящей модели и отказ Bash не проверяются, только Write/Read, файл и ответ"]]),
    ["cc.limited_network", "окружение с сетью «Ограниченный» для Claude Code не проверялось (нужны registry.npmjs.org и адрес шлюза на порту 80 или 443)"],
    ["cc.agent_mcp_servers", "MCP-серверы агента в Claude Code (projectAcpSandboxMcpServers) не проверялись"],
    ["cc.system_prompt", "системный промпт агента до Claude Code не доходит: AcpSandboxHarness.onSessionInit пишет /workspace/AGENTS.md, main-node этот хук не вызывает, а Claude Code читает CLAUDE.md; сценарий это не проверяет"],
    ["cc.proxy_token_scope", "что токен хода oma_sbx_ не открывает другие пути API и прокси чужой сессии (403), проверяют тесты apps/main-node/test/models-harness-http.test.ts и sandbox-inference-token.test.ts; сценарий видит только его начало"],
    ["harness.card_multi_turn", "второй ход агента на своей карточке не проверялся"],
    ...(KEEP_SESSION ? [["cc.vm_stop", "VERIFY_KEEP_SESSION=1: архив сессии и остановка VM не проверялись"]] : []),
  ];
  const features = featureEntries();
  const uncovered = features.filter((f) => !covered.has(f.id));
  const err50 = serverLogLines().filter((l) => l.includes('"level":50')).length;
  const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# verify-agent-console: сценарий Claude Code и свой harness, прогон ${run.RUN_ID}`,
    "",
    `Итог: ${abortError ? "ПРЕРВАН" : failed.length ? "ПРОВАЛ" : "ПРОЙДЕН"} (проверок: ${checks.length}, провалов: ${failed.length}, подфункций сценария пройдено ${features.length - uncovered.length} из ${features.length}).`,
    abortError ? `Сценарий прерван: ${plain(abortError.message)}` : "",
    "",
    "## Экземпляр",
    "",
    `- URL: ${BASE}, режим Claude Code: ${CC_MODE}${FAKE ? ` (фейк ${run.FAKE_URL})` : ""}, адрес сервера из VM: ${GATEWAY_VM}, образ: ${run.SANDBOX_IMAGE}, диск VM: ${run.LITEBOX_DISK_SIZE_GB || "по умолчанию"} ГБ`,
    `- git ${run.GIT_REV}, незакоммиченных файлов: консоль ${run.CONSOLE_DIRTY_FILES}, сервер ${run.SERVER_DIRTY_FILES}; хэши изменений: консоль ${run.CONSOLE_TREE_HASH}, сервер ${run.SERVER_TREE_HASH}`,
    `- учётка: ${user.email}, рабочее пространство ${user.tenant_id}`,
    `- карточки моделей: ${names.modelCard} (wire_model ${WIRE_MODEL}${FAKE && cardSecret.key ? `, sha256 фиктивного ключа ${sha12(cardSecret.key)}` : ""}) и ${names.oaiCard}; хранилище ${ids.vault ?? "—"} (${names.vault}: ${vaultSecrets.modelKey.name} sha256 ${sha12(vaultSecrets.modelKey.value)}, ${vaultSecrets.note.name})`,
    `- окружение ${ids.environment ?? "—"} (${names.env}), агент ${ids.agent ?? "—"} (${names.agent}), сессия ${ids.session ?? "—"} (${names.session}), nonce ${nonce}`,
    `- свой harness ${names.harnessId} (${names.harnessName}, карточка ${ids.harnessCard ?? "—"}), агент ${ids.cardAgent ?? "—"} (${names.cardAgent}), сессия ${ids.cardSession ?? "—"} (${names.cardSession}), nonce ${cardNonce}`,
    `- ядро хоста ${HOST_KERNEL}; ошибок уровня 50 в логе сервера: ${err50}`,
    "",
    "## Проверки",
    "",
    "| Проверка | Что доказывает | Статус | Доказательство |",
    "|---|---|---|---|",
    ...checks.map((c) => `| ${c.id} | ${cell(c.title)} | ${c.status} | ${cell([c.evidence, c.note].filter(Boolean).join("; "))} |`),
    ...notChecked.map(([id, why]) => `| ${id} | ${cell(why)} | не проверено | — |`),
    ...uncovered.map((f) => `| feature.${f.id} | ${cell(f.desc)} | не проверено | рецепт: features/${f.file} |`),
    "",
    "## Скриншоты",
    "",
    ...screens.map((s) => `- ${s.file} (sha256 ${s.sha.slice(0, 12)}${s.tall ? `, высота ${s.tall}` : ""})`),
    "",
    "## Повтор",
    "",
    "RUN=\"$(VERIFY_PORT=8795 VERIFY_FAKE_PORT=8796 VERIFY_LITEBOX_DISK_SIZE_GB=4 scripts/launch.sh)\" && { scripts/doctor.sh --run \"$RUN\" && scripts/seed-user.sh --run \"$RUN\" && scripts/journey.sh --run \"$RUN\" --scenario claude-code; scripts/cleanup.sh --run \"$RUN\"; } (папка .claude/skills/verify-agent-console).",
    "",
  ];
  writeFileSync(join(EV, "summary.md"), lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n"));
}

function copyLogs() {
  for (const [from, to] of [
    [run.SERVER_LOG, "logs/main-node.journey.log"],
    [run.FAKE_LOG, "logs/fake-model.log"],
    [run.FAKE_REQUESTS, "api/fake-model-requests.jsonl"],
  ]) if (from && existsSync(from)) copyFileSync(from, join(EV, to));
}

let browser;
let abortError = null;
log(`прогон ${run.RUN_ID}, сценарий claude-code, режим ${CC_MODE}, доказательства ${EV}`);
try {
  const health = await (await fetch(`${BASE}/health`)).json();
  if (health?.backends?.db !== `sqlite ${run.DB_PATH}`) {
    throw new Error(`на ${BASE} не экземпляр этого прогона (db: ${health?.backends?.db}); сценарий не запускаю`);
  }
  cardSecret = loadCardSecret();
  if (FAKE) {
    const fh = await (await fetch(`${run.FAKE_URL}/health`)).json().catch(() => null);
    if (!fh?.ok) throw new Error(`фейковая модель ${run.FAKE_URL} не отвечает`);
  }
  if (ECHO_AGENT.length > 2000) throw new Error(`acp-echo-agent.cjs одной строкой ${ECHO_AGENT.length} знаков, карточка принимает аргумент до 2000`);
  const executablePath = pickChromium();
  browser = await chromium.launch({ executablePath, headless: process.env.VERIFY_HEADED !== "1", args: ["--disable-gpu"] });
  context = await browser.newContext({ baseURL: BASE, viewport: VIEW, locale: "ru-RU" });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  log(`процессов браузера записано в state/pids: ${recordJourneyChildren()}`);
  // critical: сбой прерывает сценарий. Сбой другого шага пишется провалом, и сценарий идёт
  // дальше; шаг, которому нужен упавший (needs), пишется строкой «не проверено».
  const failedSteps = new Set();
  const stepId = (name) => name.replace(/\s+/g, "_");
  for (const [name, fn, critical, needs = []] of [
    ["вход", stepLogin, true],
    ["карточки моделей", stepModelCards, true],
    ["окружение с claude-agent-acp", stepEnvironment, true],
    ["хранилище с ключом", stepVault, false],
    ["guard агента", stepGuard, false],
    ["карточка своего harness", stepHarnessCard, false],
    ["агент на Claude Code", stepAgent, false],
    ["сессия", stepSession, false, ["агент на Claude Code", "хранилище с ключом"]],
    ["ход Claude Code", stepTurn, false, ["сессия"]],
    ["второй ход Claude Code", stepSecondTurn, false, ["ход Claude Code"]],
    ...(KEEP_SESSION ? [] : [["архив сессии", () => archiveAndProveStop(), false, ["сессия"]]]),
    ["агент на своей карточке", stepCardAgent, false, ["карточка своего harness"]],
    ["ход своего агента", stepCardTurn, false, ["агент на своей карточке"]],
  ]) {
    const missing = needs.filter((need) => failedSteps.has(need));
    if (missing.length > 0) {
      failedSteps.add(name);
      record(`cc.step_skipped.${stepId(name)}`, `шаг «${name}»`, "не проверено", "", `не выполнен шаг: ${missing.join(", ")}`);
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
      failedSteps.add(name);
      record(`cc.step_failed.${stepId(name)}`, `шаг «${name}» выполнен до конца`, "провал", "", error.message);
      await shot(`fail-step-${name.replace(/\s+/g, "-")}`).catch(() => {});
      // Открытое окно или меню мешает следующему шагу.
      await page.keyboard.press("Escape").catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
} catch (error) {
  abortError = error;
  record("cc.abort", "сценарий дошёл до конца", "провал", "", error.message);
  if (page) await shot("abort").catch(() => {});
} finally {
  record("cc.screens_distinct", "скриншоты соседних шагов различаются (sha256)",
    duplicateShots.length === 0 ? "проверено" : "провал", `скриншотов ${screens.length}`,
    duplicateShots.length === 0 ? "" : `совпали: ${duplicateShots.join("; ")}`);
  copyLogs();
  writeSummary(abortError);
  await browser?.close().catch(() => {});
}
const failedCount = checks.filter((c) => c.status === "провал").length;
log(`итог: ${abortError ? "ПРЕРВАН" : failedCount ? "ПРОВАЛ" : "ПРОЙДЕН"}, ${join(EV, "summary.md")}`);
process.exit(failedCount ? 1 : 0);
