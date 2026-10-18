#!/usr/bin/env node
// Сценарий «ассистент платформы» verify-agent-console (docs/plans/builder-agent.md, раздел 6).
// Playwright, консоль на русском, фейковая модель (fake-model.mjs с fake-model-builder.mjs).
//   6.2 основной путь: панель по Ctrl I, установка ассистента, пачка «окружение, навык, агент»,
//       деплоймент на паузе, правка агента, сессия, первое сообщение;
//   6.3 отказ, прямое подтверждение, обход политики, встроенные инструменты, выключатель;
//   6.4 чужое пространство, второй участник, прямой вход;
//   6.5 и 6.6 в journey-builder-guard.mjs: подложенные указания, смена объекта после preview;
//   6.7 утечка секретов: канарейки, ротация, подбор секрета.
// Модель ассистента и созданного им агента это карточка vb-fake-<n> на фейк. Ключ карточки тоже канарейка:
// в заголовке он законен, в теле запроса его быть не должно.
// Запуск: scripts/journey.sh --run <RUN_ID> --scenario builder (после seed-user.sh --others).
// Живая проверка 6.8 (VERIFY_BUILDER_MODE=live): ассистент на настоящей модели через карточку
// (по умолчанию qwen3.6-35b, провайдер openai-compatible, адрес VERIFY_LIVE_BASE_URL). Ключ берётся из
// файла VERIFY_LIVE_SECRET_FILE (права 600) или, с согласия владельца, одной переменной platform/.env,
// имя в VERIFY_LIVE_ENV_KEY. Значение не печатается и уходит только в карточку модели.
// Итог: $EVIDENCE_DIR/summary.md; код 0, если все проверки прошли.
import { createRequire } from "node:module";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { oraclePlan, readCanaries, canaryForms } from "./fake-model-builder.mjs";
import { guardSteps } from "./journey-builder-guard.mjs";

// ---------------------------------------------------------------- прогон ---
const SKILL_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RUN_DIR = (() => {
  const dir = process.env.VERIFY_RUN_DIR ?? "";
  if (!dir || !existsSync(join(dir, ".verify-agent-console-run"))) {
    throw new Error("прогон не задан: VERIFY_RUN_DIR=<папка прогона> (scripts/journey.sh --run <RUN_ID> --scenario builder задаёт её сам)");
  }
  return dir;
})();
const run = Object.fromEntries(
  readFileSync(join(RUN_DIR, "run.env"), "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const readState = (name) => JSON.parse(readFileSync(join(RUN_DIR, "state", name), "utf8"));
const user = readState("test-user.json");
const member = existsSync(join(RUN_DIR, "state", "member.json")) ? readState("member.json") : null;
const foreign = existsSync(join(RUN_DIR, "state", "foreign.json")) ? readState("foreign.json") : null;
const EV = run.EVIDENCE_DIR;
for (const sub of ["screens", "aria", "api", "logs"]) mkdirSync(join(EV, sub), { recursive: true });
const BASE = run.BASE_URL;
const VIEW = { width: 1280, height: 860 };
const MAX_SHOT_HEIGHT = 6000;
const TURN_TIMEOUT = Number(process.env.VERIFY_TURN_TIMEOUT_MS ?? 180_000);
const BETAS = [
  "managed-agents-2026-04-01", "files-api-2025-04-14", "skills-2025-10-02", "agent-memory-2026-07-22",
  "dreaming-2026-04-21", "mcp-tunnels-2026-06-22", "user-profiles-2026-08-18",
].join(",");
const CANARY_FILE = join(RUN_DIR, "state", "canaries.json");
const ORACLE_FILE = join(RUN_DIR, "state", "oracle.json");
if (run.MODEL_MODE !== "fake") throw new Error("сценарий builder идёт на экземпляре в режиме fake (VERIFY_MODEL_MODE=fake); живая модель задаётся карточкой, VERIFY_BUILDER_MODE=live");
const LIVE = process.env.VERIFY_BUILDER_MODE === "live";
const LIVE_CARD = process.env.VERIFY_LIVE_CARD ?? "qwen3.6-35b";
const LIVE_PROMPT = process.env.VERIFY_LIVE_PROMPT
  ?? "Сделай агента, который сводит заявки в xlsx, окружение для документов и запусти сессию с заданием";

const nonce = randomBytes(4).toString("hex");
const rnd = (n, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789") => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join("");
const names = {
  card: `vb-fake-${nonce}`,
  env: `vb-env-${nonce}`,
  skill: `vb-skill-${nonce}`,
  agent: `vb-agent-${nonce}`,
  dep: `vb-dep-${nonce}`,
  session: `vb-session-${nonce}`,
  input: `vb-input-${nonce}.txt`,
};
const ids = {};
const created = { sessions: [], agents: [], environments: [] };
const covered = new Set();
const cover = (...list) => list.forEach((id) => covered.add(id));

// Таблица инструментов платформы (platform/apps/main-node/src/lib/platform-mcp/tool-table.ts) по группам
// комплекта ассистента (builder-template.ts, builder-bundle.ts). Модель видит ровно эти имена с приставкой
// mcp__platform__. Инструментов карточек harness (D41), создания карточки модели и exec в таблице нет.
// Опасный класс (crud.md 3.1) только у архива и удаления, возврат из архива идёт правкой.
// Новый или пропавший инструмент валит vb.fake_tools и vb.danger_class, пока таблицу здесь не сверят с кодом.
const PLATFORM_TOOL_GROUPS = {
  read: ["help", "search_docs", "search_config", "list", "get", "read_content", "get_session_events", "get_trajectory", "request_secret", "get_dependencies"],
  draft: ["preview_change"],
  write: [
    "create_agent", "create_environment", "create_skill", "upload_file", "create_memory_store", "create_deployment",
    "create_session", "send_message", "update_session", "add_session_resource", "write_memory", "update_agent",
    "restore_agent_version", "update_environment", "create_skill_version", "update_memory_store", "update_deployment",
    "update_model_card", "pause_deployment", "unpause_deployment", "run_deployment", "unarchive_object", "apply_changes",
  ],
  danger: ["archive_object", "delete_object"],
};
const PLATFORM_TOOLS = Object.values(PLATFORM_TOOL_GROUPS).flat();

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
let browser;
const screens = [];
let lastStepShot = null;
const duplicateShots = [];
async function hiddenScrollHeight(p) {
  return p.evaluate(() => {
    let extra = 0;
    for (const el of document.querySelectorAll("main, .assistant-panel-body")) {
      extra = Math.max(extra, el.scrollHeight - el.clientHeight);
    }
    return extra;
  }).catch(() => 0);
}
async function shot(name, p = page) {
  const file = `screens/${String(++shotN).padStart(2, "0")}-vb-${name}.png`;
  const size = p.viewportSize() ?? VIEW;
  const extra = size.width >= 1000 ? await hiddenScrollHeight(p) : 0;
  const tall = extra > 4;
  if (tall) {
    await p.setViewportSize({ width: size.width, height: Math.min(size.height + extra, MAX_SHOT_HEIGHT) });
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  let buffer;
  try {
    buffer = await p.screenshot({ path: join(EV, file), fullPage: true });
  } finally {
    if (tall) await p.setViewportSize(size);
  }
  const sha = createHash("sha256").update(buffer).digest("hex");
  const isStep = !/^(fail-|abort$)/.test(name);
  if (isStep && lastStepShot?.sha === sha) duplicateShots.push(`${lastStepShot.file} = ${file}`);
  if (isStep) lastStepShot = { file, sha };
  screens.push({ file, sha, tall: tall ? Math.min(size.height + extra, MAX_SHOT_HEIGHT) : 0 });
  return file;
}
async function aria(name, locator) {
  const file = `aria/${String(shotN).padStart(2, "0")}-vb-${name}.yml`;
  writeFileSync(join(EV, file), await (locator ?? page.locator("body")).ariaSnapshot());
  return file;
}
function saveJson(name, data) {
  const file = `api/vb-${name}.json`;
  writeFileSync(join(EV, file), JSON.stringify(data, null, 2));
  return file;
}
function saveCreated() {
  writeFileSync(join(RUN_DIR, "state", "created.json"), JSON.stringify(created, null, 2));
}

// -------------------------------------------------------------------- API ---
function parseBody(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}
/** Запрос от тестового пользователя (cookie браузера). */
async function apiRaw(method, path, body, headers = {}) {
  const isForm = body instanceof FormData;
  const res = await context.request.fetch(BASE + path, {
    method,
    headers: { "anthropic-beta": BETAS, origin: BASE, ...(body === undefined || isForm ? {} : { "content-type": "application/json" }), ...headers },
    ...(isForm ? { multipart: Object.fromEntries(body) } : { data: body === undefined ? undefined : JSON.stringify(body) }),
    failOnStatusCode: false,
  });
  const text = await res.text();
  return { status: res.status(), json: parseBody(text), text, headers: res.headers() };
}
async function api(method, path, body, headers) {
  const r = await apiRaw(method, path, body, headers);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}
/** Cookie из cookie-jar curl (seed-user.sh). */
function jarCookie(file) {
  return readFileSync(file, "utf8").split("\n")
    .map((line) => line.replace(/^#HttpOnly_/, ""))
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 7)
    .map((parts) => `${parts[5]}=${parts[6]}`)
    .join("; ");
}
/** Запрос от другого пользователя: member (в пространстве тестовой учётки) или foreign (своё пространство). */
async function apiAs(who, method, path, body, extra = {}) {
  const info = who === "member" ? member : foreign;
  const headers = {
    cookie: jarCookie(join(RUN_DIR, "state", `${who}-cookies.txt`)),
    origin: BASE,
    "anthropic-beta": BETAS,
    "x-active-tenant": info.tenant_id,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...extra,
  };
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: parseBody(text), text };
}
async function listEvents(sessionId, raw = apiRaw) {
  const all = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ limit: "100", order: "asc" });
    if (cursor) q.set("page", cursor);
    const r = await raw("GET", `/v1/sessions/${sessionId}/events?${q}`);
    if (r.status !== 200) throw new Error(`GET events ${sessionId} -> ${r.status}`);
    all.push(...(r.json.data ?? []));
    if (!r.json.next_page) break;
    cursor = r.json.next_page;
  }
  return all;
}
/** Текст содержимого события. Результат MCP встроенного цикла приходит строкой JSON {content, isError}. */
function textOf(content) {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.map((block) => (block?.type === "text" ? String(block.text ?? "") : "")).join("\n") : "";
  return unwrapMcp(text);
}
function unwrapMcp(text) {
  if (!text.startsWith("{") || !text.includes('"content"')) return text;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.content)) return parsed.content.map((block) => (block?.type === "text" ? String(block.text ?? "") : "")).join("\n");
  } catch {
    /* обычный текст */
  }
  return text;
}
async function waitFor(what, probe, timeout = 60_000, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() - t0 > timeout) throw new Error(`нет за ${Math.round(timeout / 1000)} с: ${what}`);
    await sleep(every);
  }
}
/** Первый session.status_idle после позиции from в журнале. */
async function waitIdle(sessionId, from, timeout = TURN_TIMEOUT) {
  let events = [];
  const idle = await waitFor(`session.status_idle в ${sessionId}`, async () => {
    events = await listEvents(sessionId);
    const after = events.slice(from);
    const error = after.find((e) => e.type === "session.error");
    if (error && !after.some((e) => e.type === "session.status_idle")) {
      log(`session.error в ${sessionId}: ${JSON.stringify(error.error ?? error).slice(0, 300)}`);
    }
    return after.find((e) => e.type === "session.status_idle");
  }, timeout, 1000);
  return { idle, stop: idle.stop_reason ?? null, events };
}
async function actions(sessionId) {
  const page = await api("GET", `/v1/oma/platform-mcp/actions?session_id=${encodeURIComponent(sessionId)}&limit=200`);
  const rows = [...(page.actions ?? [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.op_index - b.op_index);
  return { rows, confirmations: page.confirmations ?? [] };
}
function fakeLog() {
  if (!existsSync(run.FAKE_REQUESTS)) return [];
  return readFileSync(run.FAKE_REQUESTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const fakeFor = (kind, n = nonce) => fakeLog().filter((r) => r.kind === kind && r.nonce === n);
const mcpResult = (events, toolUseId) => events.find((e) => e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id === toolUseId);
const mcpUses = (events, tool) => events.filter((e) => e.type === "agent.mcp_tool_use" && e.name === `mcp__platform__${tool}`);

/** Сессия ассистента по API, как её создаёт консоль (метки разговора, явная версия агента). */
async function newAssistantSession(title, extra = {}) {
  const s = await api("POST", "/v1/sessions", {
    agent: { type: "agent", id: ids.builderAgent, version: ids.builderVersion },
    environment_id: ids.builderEnv,
    title,
    metadata: { oma_assistant_chat: "1", oma_assistant_user: user.user_id },
    ...extra,
  });
  created.sessions.push(s.id);
  saveCreated();
  return s.id;
}
async function sayApi(sessionId, text, raw = apiRaw) {
  const before = (await listEvents(sessionId)).length;
  const r = await raw("POST", `/v1/sessions/${sessionId}/events`, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
  if (r.status >= 300) throw new Error(`user.message -> ${r.status} ${r.text.slice(0, 200)}`);
  return waitIdle(sessionId, before);
}
/** Состав tools ассистента с другой политикой платформы или встроенными инструментами. */
function builderTools({ allowAll = false, builtins = [] } = {}) {
  const tools = JSON.parse(JSON.stringify(ids.builderTools));
  const mcp = tools.find((t) => t.type === "mcp_toolset");
  if (allowAll) {
    mcp.default_config = { ...(mcp.default_config ?? {}), permission_policy: { type: "always_allow" } };
    mcp.configs = (mcp.configs ?? []).map((c) => ({ ...c, permission_policy: { type: "always_allow" } }));
  }
  if (builtins.length) {
    const set = tools.find((t) => t.type === "agent_toolset_20260401");
    set.configs = builtins.map((name) => ({ name, enabled: true }));
  }
  return tools;
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
function procStat(pid) {
  try {
    const rest = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ");
    return { ppid: Number(rest[1]), start: rest[19] };
  } catch {
    return null;
  }
}
function recordJourneyChildren() {
  const lines = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    const chain = [];
    for (let p = pid; p > 1 && chain.length < 32; ) {
      chain.push(p);
      const st = procStat(p);
      if (!st) break;
      p = st.ppid;
    }
    if (!chain.slice(1).includes(process.pid)) continue;
    const st = procStat(pid);
    if (st) lines.push(`journey-child ${pid} ${st.start}`);
  }
  if (lines.length) appendFileSync(join(RUN_DIR, "state", "pids"), lines.join("\n") + "\n");
  return lines.length;
}
async function login(p, creds) {
  await p.goto(`${BASE}/login`);
  await p.getByRole("button", { name: "Продолжить с почтой" }).click();
  await p.locator("#auth-email").fill(creds.email);
  await p.locator("#auth-password").fill(creds.password);
  await p.getByRole("group", { name: "Действия входа" }).getByRole("button", { name: "Войти", exact: true }).click();
  await p.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  await p.getByRole("navigation", { name: "Разделы консоли" }).waitFor();
}

// Перехват preview и confirm консоли: какой отпечаток карточка получила и какой отправила.
const previews = [];
const confirms = [];
function watchCards(p) {
  p.on("response", async (res) => {
    const url = res.url();
    if (!url.includes("/v1/oma/platform-mcp/")) return;
    try {
      const req = JSON.parse(res.request().postData() ?? "{}");
      if (url.endsWith("/preview")) {
        const body = await res.json().catch(() => null);
        previews.push({ tool_use_id: req.tool_use_id, status: res.status(), digest: body?.preview_digest ?? null, body });
      } else if (url.endsWith("/confirm")) {
        const body = await res.json().catch(() => null);
        confirms.push({ tool_use_id: req.tool_use_id, result: req.result, digest: req.preview_digest ?? null, status: res.status(), error: body?.error?.type ?? null });
      }
    } catch {
      /* ответ без тела */
    }
  });
}

// ----------------------------------------------------------------- панель ---
const panel = () => page.locator('aside[aria-label="Ассистент"]');
const card = (tool, phase = "pending") => panel().locator(`article.assistant-card[data-tool="${tool}"]${phase ? `[data-phase="${phase}"]` : ""}`).last();
async function openPanel() {
  if (await panel().count()) return;
  await page.keyboard.press("Control+i");
  await panel().waitFor({ timeout: 15_000 });
}
/** id разговора, который консоль держит в localStorage. */
async function panelSessionId() {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("oma_assistant_chat:")) return localStorage.getItem(key);
    }
    return null;
  });
}
async function newConversation() {
  await panel().getByRole("button", { name: "Новый разговор" }).click();
  await waitFor("пустой разговор", async () => (await panelSessionId()) === null || undefined, 10_000, 200);
}
/** Отправить реплику в панели и дождаться остановки хода. */
async function sendPanel(text) {
  const sid0 = await panelSessionId();
  const before = sid0 ? (await listEvents(sid0)).length : 0;
  const box = panel().getByRole("textbox", { name: "Сообщение ассистенту" });
  await box.fill(text);
  await box.press("Enter");
  const sid = await waitFor("сессия разговора", async () => (await panelSessionId()) ?? undefined, 20_000, 300);
  if (!created.sessions.includes(sid)) {
    created.sessions.push(sid);
    saveCreated();
  }
  const turn = await waitIdle(sid, sid === sid0 ? before : 0);
  return { sid, ...turn };
}
/** Кнопка карточки готова (preview загружен) или карточка показала причину блокировки. */
async function cardReady(c) {
  await c.waitFor({ timeout: 30_000 });
  await waitFor("preview карточки", async () => (await c.getByText("Готовлю предложение").count()) === 0 || undefined, 30_000, 200);
}
/** Нажать кнопку карточки и дождаться следующей остановки хода. */
async function clickAndWait(sid, c, buttonName) {
  const before = (await listEvents(sid)).length;
  await c.getByRole("button", { name: buttonName, exact: true }).click();
  return waitIdle(sid, before);
}
/** «Отклонить» шлёт отказ сразу; причину добавляет ссылка «Отклонить с причиной». */
async function denyCard(sid, c, reason) {
  const before = (await listEvents(sid)).length;
  if (reason) {
    await c.getByRole("button", { name: "Отклонить с причиной", exact: true }).click();
    await c.getByRole("textbox").fill(reason);
    await c.getByRole("button", { name: "Отправить отказ", exact: true }).click();
  } else {
    await c.getByRole("button", { name: "Отклонить", exact: true }).click();
  }
  return waitIdle(sid, before);
}

// ------------------------------------------------------------- подготовка ---
async function stepLogin() {
  await login(page, user);
  await page.getByRole("main").getByRole("heading", { level: 1 }).first().waitFor();
  const me = await api("GET", "/v1/oma/me");
  await check("vb.auth", "вход в консоль тестовой учёткой", () => {
    assert(me.user?.id === user.user_id && me.tenant?.id === user.tenant_id, `me ${me.user?.id} ${me.tenant?.id}`);
    return "GET /v1/oma/me";
  });
}

const canaries = [];
function addCanary(id, value, extra = {}) {
  canaries.push({ id, value, ...extra });
  writeFileSync(CANARY_FILE, JSON.stringify({ values: canaries }, null, 2), { mode: 0o600 });
}
const b64Shift = (value, shift) => {
  const pad = randomBytes(30 + shift);
  return Buffer.concat([pad.subarray(0, shift + 12), Buffer.from(value, "utf8"), pad.subarray(shift + 12)]).toString("base64");
};
const urlEnc = (value) => encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());

async function uploadFile(filename, content) {
  const form = new FormData();
  form.set("file", new Blob([content], { type: "text/plain" }), filename);
  const r = await context.request.fetch(`${BASE}/v1/files`, {
    method: "POST",
    headers: { "anthropic-beta": BETAS, origin: BASE },
    multipart: { file: { name: filename, mimeType: "text/plain", buffer: Buffer.from(content, "utf8") } },
    failOnStatusCode: false,
  });
  const text = await r.text();
  if (r.status() >= 300) throw new Error(`POST /v1/files ${filename} -> ${r.status()} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
async function browserCookie() {
  return (await context.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join("; ");
}
/** Навык из файлов: multipart с повторяющимся полем files[] (Playwright так не умеет, поэтому fetch). */
async function createSkillApi(title, files) {
  const form = new FormData();
  form.set("display_title", title);
  for (const f of files) form.append("files[]", new File([f.content], f.path, { type: "text/plain" }));
  const r = await fetch(`${BASE}/v1/skills`, { method: "POST", headers: { cookie: await browserCookie(), origin: BASE, "anthropic-beta": BETAS }, body: form });
  const text = await r.text();
  if (r.status >= 300) throw new Error(`POST /v1/skills -> ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Карточка модели на фейк и файл для сессии. Ключ карточки идёт в набор канареек. */
async function stepSeedBasics() {
  ids.cardKey = `vb-card-key-${rnd(20)}`;
  addCanary("fake_card_key", ids.cardKey);
  const cardRes = await apiRaw("POST", "/v1/oma/model_cards", {
    model_id: names.card, provider: "anthropic", model: "claude-sonnet-4-6", api_key: ids.cardKey, base_url: run.FAKE_URL,
  });
  assert(cardRes.status === 201, `карточка модели: ${cardRes.status} ${cardRes.text.slice(0, 200)}`);
  ids.card = cardRes.json.id;
  const file = await uploadFile(names.input, `Входные данные vb-${nonce}\n`);
  ids.inputFile = file.id;
  addCanary("platform_token_prefix", "oma-mcp-v1.");
  await check("vb.seed", `карточка модели ${names.card} на фейк и файл ${names.input} для сессии`, () => `${ids.card}, файл ${ids.inputFile}`);
}

/** Контрольные секреты 6.7 до первого хода ассистента. */
async function stepSeedSecrets() {
  const s = {
    card2Key: `vbk2${rnd(24)}`, card2Header: `vbhdr${rnd(20)}`, card2Login: `vblogin${rnd(8)}`, card2Pass: `vbpass${rnd(12)}`, card2Query: `vbq${rnd(16)}`,
    bearer: `vbbearer${rnd(20)}`, envValue: `vbenv${rnd(16)}`, short: `k#3${rnd(1, "QWERTYZ")}z!`, tiny: `${rnd(1, "XYZ")}${rnd(1, "qwr")}${rnd(1, "79")}`,
    agentToken1: `vbtok1${rnd(16)}`, agentToken2: `vbtok2${rnd(16)}`, urlPass: `vbup${rnd(12)}`, urlToken: `vbut${rnd(14)}`,
    refresh: `vbrefresh${rnd(16)}`, clientSecret: `vbcs${rnd(18)}`, access: `vbaccess${rnd(16)}`, gh: `vbgh${rnd(24)}`,
    ghp: `ghp_${rnd(36, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")}`, sk: `sk-vb${rnd(30)}`,
    bearer2: `vbrot${rnd(20)}`, oracle: rnd(12),
  };
  ids.secrets = s;
  for (const [id, value] of [
    ["card2_key", s.card2Key], ["card2_header", s.card2Header], ["card2_login", s.card2Login], ["card2_pass", s.card2Pass], ["card2_query", s.card2Query],
    ["static_bearer", s.bearer], ["env_value", s.envValue], ["agent_env_v1", s.agentToken1], ["agent_env_v2", s.agentToken2],
    ["agent_url_pass", s.urlPass], ["agent_url_token", s.urlToken], ["oauth_refresh", s.refresh], ["oauth_client_secret", s.clientSecret],
    ["oauth_access", s.access], ["github_token", s.gh], ["ghp_pattern", s.ghp], ["sk_pattern", s.sk],
  ]) addCanary(id, value);
  addCanary("short_pass", s.short, { password: true });
  addCanary("tiny", s.tiny, { password: true });
  writeFileSync(ORACLE_FILE, JSON.stringify({ value: s.oracle }), { mode: 0o600 });

  // Вторая карточка модели: ключ, заголовок, логин, пароль и параметр key в base_url.
  const card2 = await apiRaw("POST", "/v1/oma/model_cards", {
    model_id: `vb-canary-card-${nonce}`, provider: "anthropic", model: "claude-sonnet-4-6", api_key: s.card2Key,
    base_url: `http://${s.card2Login}:${s.card2Pass}@127.0.0.1:9/v1?key=${s.card2Query}`, custom_headers: { Authorization: s.card2Header },
  });
  assert(card2.status === 201, `вторая карточка: ${card2.status} ${card2.text.slice(0, 200)}`);
  // Мёртвая карточка: сессия с секретами в сообщении не должна ходить в фейк.
  const dead = await apiRaw("POST", "/v1/oma/model_cards", { model_id: `vb-dead-${nonce}`, provider: "anthropic", model: "claude-sonnet-4-6", api_key: `vbdead${rnd(8)}`, base_url: "http://127.0.0.1:9" });
  assert(dead.status === 201, `мёртвая карточка: ${dead.status}`);

  const vault = await api("POST", "/v1/vaults", { display_name: `vb-vault-${nonce}` });
  ids.vault = vault.id;
  const cred = (auth, display_name) => api("POST", `/v1/vaults/${vault.id}/credentials`, { auth, display_name });
  ids.bearerCred = (await cred({ type: "static_bearer", token: s.bearer, mcp_server_url: "https://mcp.vb.test/sse" }, "vb-bearer")).id;
  await cred({ type: "environment_variable", secret_name: "VB_ENV", secret_value: s.envValue, networking: { type: "unrestricted" } }, "vb-env");
  await cred({ type: "environment_variable", secret_name: "SHORT_PASS", secret_value: s.short, networking: { type: "unrestricted" } }, "SHORT_PASS");
  await cred({ type: "environment_variable", secret_name: "TINY", secret_value: s.tiny, networking: { type: "unrestricted" } }, "TINY");
  await cred({ type: "environment_variable", secret_name: "ORACLE_VALUE", secret_value: s.oracle, networking: { type: "unrestricted" } }, "ORACLE_VALUE");
  await cred({
    type: "mcp_oauth", access_token: s.access, mcp_server_url: "https://oauth.vb.test/mcp",
    refresh: { client_id: "vb-client", refresh_token: s.refresh, token_endpoint: "https://oauth.vb.test/token", token_endpoint_auth: { type: "client_secret_post", client_secret: s.clientSecret } },
  }, "vb-oauth");

  const copies = [s.urlPass, s.urlToken, s.card2Login, s.card2Pass, s.gh, s.clientSecret, s.agentToken1];
  const copyText = `Копии: ${copies.join(" ")}\n`;
  const store = await api("POST", "/v1/memory_stores", { name: `vb-mem-${nonce}` });
  ids.memStore = store.id;
  const mem = async (path, content) => (await api("POST", `/v1/memory_stores/${store.id}/memories`, { path, content })).id;
  ids.memShort = await mem("/short.md", `пароль: ${s.short}\nпароль: ${s.tiny}\n`);
  ids.memCopy = await mem("/copy.md", `${copyText}ключ ${s.sk}\n`);
  await mem(`/keys/${s.oracle}.md`, "ключ\n");

  const files = {
    short: await uploadFile(`vb-short-${nonce}.txt`, `пароль: ${s.short}\nпароль: ${s.tiny}\n`),
    enc: await uploadFile(`vb-enc-${nonce}.txt`, `base64: ${b64Shift(s.bearer, 1)}\nurl: ${urlEnc(s.bearer)}\n`),
    copy: await uploadFile(`vb-copy-${nonce}.txt`, `${copyText}токен ${s.ghp}\n`),
    copyEnc: await uploadFile(`vb-copy-enc-${nonce}.txt`, copies.map((v, i) => `${i}: ${b64Shift(v, i % 3)} ${urlEnc(v)}`).join("\n") + "\n"),
    rot: await uploadFile(`vb-rot-${nonce}.txt`, `новый токен ${s.bearer2}\n`),
    other: await uploadFile(`vb-other-${nonce}.txt`, `обычный текст vb-${nonce}\n`),
  };
  ids.secretFiles = files;
  const skill = await createSkillApi(`vb-copy-skill-${nonce}`, [{ path: `vb-copy-skill-${nonce}/SKILL.md`, content: `---\nname: vb-copy-skill-${nonce}\ndescription: Навык с копиями. Use it never.\n---\n\n${copyText}` }]);
  ids.copySkill = skill.id;

  const secretAgent = await apiRaw("POST", "/v1/agents", {
    name: `vb-secret-agent-${nonce}`, model: `vb-dead-${nonce}`, system: `VB_FIND_${nonce} ${s.bearer}`,
    mcp_servers: [
      { type: "url", name: "vb-url", url: `https://vbuser:${s.urlPass}@mcp.secret.vb.test/mcp?token=${s.urlToken}` },
      { type: "stdio", name: "vb-stdio", command: "/usr/bin/vb-mcp", env: { API_TOKEN: s.agentToken1 } },
    ],
    tools: [{ type: "mcp_toolset", mcp_server_name: "vb-url" }, { type: "mcp_toolset", mcp_server_name: "vb-stdio" }],
  });
  if (secretAgent.status === 200 || secretAgent.status === 201) {
    ids.secretAgent = secretAgent.json.id;
    await api("POST", `/v1/agents/${ids.secretAgent}`, {
      version: secretAgent.json.version,
      mcp_servers: [
        { type: "url", name: "vb-url", url: `https://vbuser:${s.urlPass}@mcp.secret.vb.test/mcp?token=${s.urlToken}` },
        { type: "stdio", name: "vb-stdio", command: "/usr/bin/vb-mcp", env: { API_TOKEN: s.agentToken2 } },
      ],
      tools: [{ type: "mcp_toolset", mcp_server_name: "vb-url" }, { type: "mcp_toolset", mcp_server_name: "vb-stdio" }],
    });
  } else {
    record("vb.secret_agent_stdio", "агент с stdio MCP и секретом в env создаётся по API", "внимание", "", `${secretAgent.status} ${secretAgent.text.slice(0, 200)}`);
  }
  const oracleAgent = await api("POST", "/v1/agents", { name: `vb-oracle-agent-${nonce}`, model: `vb-dead-${nonce}`, system: s.oracle });
  ids.oracleAgent = oracleAgent.id;

  const secretEnv = await api("POST", "/v1/environments", { name: `vb-secret-env-${nonce}`, config: { type: "cloud", networking: { type: "unrestricted" } } });
  ids.secretEnv = secretEnv.id;
  created.environments.push(secretEnv.id);
  const deadAgent = await api("POST", "/v1/agents", { name: `vb-dead-agent-${nonce}`, model: `vb-dead-${nonce}` });
  const gh = await apiRaw("POST", "/v1/deployments", {
    name: `vb-gh-${nonce}`, agent: { type: "agent", id: deadAgent.id }, environment_id: secretEnv.id,
    initial_events: [{ type: "user.message", content: [{ type: "text", text: "never" }] }],
    resources: [{ type: "github_repository", url: "https://github.com/vb/repo", authorization_token: s.gh }],
    _oma: { paused: true },
  });
  assert(gh.status < 300, `деплоймент с GitHub: ${gh.status} ${gh.text.slice(0, 200)}`);
  ids.ghDeployment = gh.json.id;
  await api("POST", `/v1/deployments/${ids.ghDeployment}/archive`, {});
  // Отдельная сессия: сообщение пользователя с sk-… и копиями. Модель мёртвой карточки недоступна,
  // поэтому секреты из сообщения к фейку не уходят.
  const secretSession = await api("POST", "/v1/sessions", { agent: deadAgent.id, environment_id: secretEnv.id, title: `vb-secret-session-${nonce}` });
  ids.secretSession = secretSession.id;
  created.sessions.push(secretSession.id);
  saveCreated();
  await api("POST", `/v1/sessions/${secretSession.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: `ключ ${s.sk} ${copyText}` }] }] });
  await check("vb.secrets_seeded", "контрольные секреты 6.7 разложены до первого хода (канарейки в state/canaries.json)", () =>
    `канареек ${canaries.length}, карточки vb-canary-card и vb-dead, хранилище ${ids.vault}, память ${ids.memStore}, файлов ${Object.keys(files).length}, навык ${ids.copySkill}, деплоймент ${ids.ghDeployment} в архиве, сессия ${ids.secretSession}`);
}

// ------------------------------------------------------------ 6.2: путь ---
async function stepInstall() {
  await page.getByRole("navigation", { name: "Разделы консоли" }).getByRole("link", { name: "Агенты", exact: true }).click();
  await page.getByRole("main").getByRole("heading", { level: 1, name: "Агенты", exact: true }).waitFor();
  await page.keyboard.press("Control+i");
  await panel().waitFor({ timeout: 15_000 });
  await panel().getByText("Ассистента здесь ещё нет").waitFor({ timeout: 20_000 });
  await panel().locator("select").first().selectOption(names.card);
  await shot("install");
  await panel().getByRole("button", { name: "Установить", exact: true }).click();
  const box = panel().getByRole("textbox", { name: "Сообщение ассистенту" });
  await waitFor("поле ввода включено", async () => (await box.isEnabled()) || undefined, 30_000, 300);
  const chip = await panel().getByText("Агенты").first().isVisible().catch(() => false);
  await shot("installed");
  const agents = await api("GET", "/v1/agents?limit=100");
  const builder = (agents.data ?? []).find((a) => a.metadata?.oma_role === "builder");
  assert(builder, "после установки нет агента с oma_role: builder");
  ids.builderAgent = builder.id;
  ids.builderVersion = builder.version;
  ids.builderTools = builder.tools;
  const envs = await api("GET", "/v1/environments?limit=100");
  ids.builderEnv = (envs.data ?? []).find((e) => e.metadata?.oma_role === "builder")?.id;
  created.agents.push(builder.id);
  await check("vb.install", "Ctrl I на /agents открыл панель, «Установить» поставил ассистента с карточкой фейка, чип контекста «Агенты»", () => {
    assert(builder.model?.id === names.card || builder.model === names.card, `модель ассистента ${JSON.stringify(builder.model)}`);
    assert(ids.builderEnv, "нет окружения «Ассистент»");
    assert(chip, "нет чипа контекста «Агенты»");
    const mcp = builder.tools.find((t) => t.type === "mcp_toolset");
    assert(mcp?.default_config?.permission_policy?.type === "always_ask", "политика по умолчанию не always_ask");
    return `агент ${builder.id} v${builder.version}, окружение ${ids.builderEnv}`;
  });
  cover("builder-install", "builder-panel");
}

async function namesExist() {
  const [envs, skills, agents] = await Promise.all([api("GET", "/v1/environments?limit=100"), api("GET", "/v1/skills?limit=100"), api("GET", "/v1/agents?limit=100")]);
  return {
    env: (envs.data ?? []).find((e) => e.name === names.env),
    skill: (skills.data ?? []).find((s) => s.display_title === names.skill),
    agent: (agents.data ?? []).find((a) => a.name === names.agent),
  };
}

async function stepMain() {
  const marker = [`VERIFY_BUILDER nonce=${nonce}`, `Модель: ${names.card}`, `Файл: ${ids.inputFile}`, "Собери рабочее место по шагам проверки."].join("\n");
  const first = await sendPanel(marker);
  const sid = first.sid;
  ids.mainSession = sid;
  const batch = card("apply_changes");
  await cardReady(batch);
  const before = await namesExist();
  await shot("batch-card");
  await aria("batch-card", panel());
  const batchUse = mcpUses(first.events, "apply_changes")[0];
  await check("vb.batch_requires_action", "пачка «Создать 3 объекта»: ход закрыт requires_action с id вызова apply_changes, до клика объектов нет", async () => {
    assert(first.stop?.type === "requires_action", `stop_reason ${JSON.stringify(first.stop)}`);
    assert(batchUse && first.stop.event_ids?.includes(batchUse.id), `event_ids ${JSON.stringify(first.stop.event_ids)}`);
    assert(batchUse.evaluated_permission === "ask", `evaluated_permission ${batchUse.evaluated_permission}`);
    const title = await batch.getByRole("heading").first().textContent();
    assert(/Создать 3 объекта/.test(title ?? ""), `заголовок «${title}»`);
    assert((await batch.locator('ul[aria-label="Объекты пачки"] > li').count()) === 3, "строк в пачке не 3");
    assert(!before.env && !before.skill && !before.agent, `до клика уже есть: ${JSON.stringify(Object.keys(before).filter((k) => before[k]))}`);
    const tools = mcpUses(first.events, "search_docs").length + mcpUses(first.events, "list").length;
    assert(tools === 2, `до пачки вызовов search_docs и list ${tools}`);
    return `tool_use ${batchUse.id}`;
  });
  const afterBatch = await clickAndWait(sid, batch, "Создать");
  const made = await namesExist();
  ids.env = made.env?.id;
  ids.skill = made.skill?.id;
  ids.agent = made.agent?.id;
  if (ids.agent) created.agents.push(ids.agent);
  if (ids.env) created.environments.push(ids.env);
  saveCreated();
  await check("vb.batch_applied", "после «Создать» окружение, навык и агент есть; у окружения и агента метки oma_created_via и oma_assistant_session (у навыка нет поля metadata, его связь с разговором видна в журнале)", async () => {
    assert(made.env && made.skill && made.agent, `создано: ${JSON.stringify({ env: !!made.env, skill: !!made.skill, agent: !!made.agent })}`);
    for (const [kind, obj] of Object.entries({ env: made.env, agent: made.agent })) {
      assert(obj.metadata?.oma_created_via === "assistant", `${kind}: oma_created_via ${obj.metadata?.oma_created_via}`);
      assert(obj.metadata?.oma_assistant_session === sid, `${kind}: oma_assistant_session ${obj.metadata?.oma_assistant_session}`);
    }
    const skillRow = (await actions(sid)).rows.find((r) => r.tool === "create_skill" && r.target_id === made.skill.id);
    assert(skillRow?.result === "ok", "в журнале нет create_skill с id навыка");
    const applied = panel().locator('article.assistant-card[data-tool="apply_changes"][data-phase="applied"]').last();
    await applied.waitFor({ timeout: 15_000 });
    assert((await applied.getByRole("link").count()) >= 1, "в карточке нет строк «Создан …» со ссылками");
    return `${ids.env}, ${ids.skill}, ${ids.agent}`;
  });
  await check("vb.skill_and_agent", "последняя версия навыка содержит VB_SKILL и scripts/hello.sh, у агента этот навык и модель карточки", async () => {
    const agent = await api("GET", `/v1/agents/${ids.agent}`);
    assert((agent.skills ?? []).some((s) => s.skill_id === ids.skill), `skills ${JSON.stringify(agent.skills)}`);
    assert((agent.model?.id ?? agent.model) === names.card, `model ${JSON.stringify(agent.model)}`);
    const skill = await api("GET", `/v1/skills/${ids.skill}`);
    const content = await context.request.fetch(`${BASE}/v1/skills/${ids.skill}/versions/${skill.latest_version}/content`, { headers: { "anthropic-beta": BETAS, origin: BASE } });
    const zip = Buffer.from(await content.body()).toString("latin1");
    assert(zip.includes("scripts/hello.sh"), "в архиве навыка нет scripts/hello.sh");
    assert(zip.includes(`VB_SKILL_${nonce}`) || zip.includes("SKILL.md"), "в архиве нет SKILL.md");
    return `навык ${skill.latest_version}, модель ${names.card}`;
  });

  // Деплоймент на паузе.
  const dep = card("create_deployment");
  await cardReady(dep);
  await shot("deployment-card");
  await check("vb.deployment_card", "карточка «Создать деплоймент на паузе» с тремя ближайшими запусками и строкой про паузу", async () => {
    assert(afterBatch.stop?.type === "requires_action", `после пачки stop ${JSON.stringify(afterBatch.stop)}`);
    const title = await dep.getByRole("heading").first().textContent();
    assert(/деплоймент на паузе/.test(title ?? ""), `заголовок «${title}»`);
    assert((await dep.locator('ul[aria-label="Ближайшие запуски"] > li').count()) === 3, "ближайших запусков не 3");
    assert(await dep.getByText("Деплоймент создаётся на паузе. Запустить его можно в консоли").isVisible(), "нет строки про паузу");
    return title;
  });
  const afterDep = await clickAndWait(sid, dep, "Создать");
  const deps = await api("GET", "/v1/deployments?limit=100");
  const deployment = (deps.data ?? []).find((d) => d.name === names.dep);
  ids.deployment = deployment?.id;
  ids.deploymentCreatedAt = Date.now();
  await check("vb.deployment_paused", "деплоймент vb-dep в статусе paused с расписанием, updated_at = created_at", () => {
    assert(deployment, "деплоймента нет");
    assert(deployment.status === "paused", `status ${deployment.status}`);
    assert(deployment.schedule?.expression === "* * * * *", `schedule ${JSON.stringify(deployment.schedule)}`);
    assert(deployment.updated_at === deployment.created_at, `updated_at ${deployment.updated_at} created_at ${deployment.created_at}`);
    return deployment.id;
  });

  // Правка агента.
  const upd = card("update_agent");
  await cardReady(upd);
  await shot("update-agent-card");
  await check("vb.update_card", "карточка правки «версия 1 станет 2» с разницей строки system", async () => {
    assert(afterDep.stop?.type === "requires_action", `stop ${JSON.stringify(afterDep.stop)}`);
    const title = await upd.getByRole("heading").first().textContent();
    assert(/версия 1 станет 2/.test(title ?? ""), `заголовок «${title}»`);
    assert((await upd.textContent()).includes("версия 2."), "в разнице нет нового system");
    return title;
  });
  const afterUpd = await clickAndWait(sid, upd, "Применить");
  await check("vb.agent_v2", "агент в версии 2 с новым system", async () => {
    const agent = await api("GET", `/v1/agents/${ids.agent}`);
    assert(agent.version === 2 && agent.system.includes("версия 2."), `v${agent.version} ${agent.system}`);
    return `v${agent.version}`;
  });

  // Сессия.
  const sess = card("create_session");
  await cardReady(sess);
  await shot("session-card");
  const sessionsBefore = await api("GET", `/v1/sessions?agent_id=${ids.agent}&limit=50`);
  await check("vb.session_card", "карточка «Создать сессию» со строкой про пустую сессию, агентом v2, окружением и файлом", async () => {
    assert(afterUpd.stop?.type === "requires_action", `stop ${JSON.stringify(afterUpd.stop)}`);
    const text = await sess.textContent();
    assert(text.includes("Создать сессию"), "нет заголовка");
    assert(text.includes("Сессия создаётся пустой. Агент начнёт работу после первого сообщения"), "нет строки про пустую сессию");
    assert(text.includes(names.agent) && text.includes("версия 2"), "нет агента и версии");
    assert(text.includes(names.env), "нет окружения");
    assert(text.includes(names.input), "нет файла");
    assert(!(sessionsBefore.data ?? []).some((s) => s.title === names.session), "сессия уже есть до клика");
    return "карточка сессии";
  });
  const afterSess = await clickAndWait(sid, sess, "Создать");
  const sessions = await api("GET", `/v1/sessions?agent_id=${ids.agent}&limit=50`);
  const child = (sessions.data ?? []).find((s) => s.title === names.session);
  ids.childSession = child?.id;
  if (child) created.sessions.push(child.id);
  saveCreated();
  await check("vb.session_created", "сессия vb-session idle, без user.message, агент v2, окружение, файл, метки oma_*", async () => {
    assert(child, "сессии нет");
    const full = await api("GET", `/v1/sessions/${child.id}`);
    assert(full.status === "idle", `status ${full.status}`);
    assert(full.agent?.id === ids.agent && full.agent?.version === 2, `agent ${JSON.stringify(full.agent)}`);
    assert(full.environment_id === ids.env, `environment ${full.environment_id}`);
    assert((full.resources ?? []).some((r) => r.type === "file" && r.file_id === ids.inputFile), `resources ${JSON.stringify(full.resources)}`);
    assert(full.metadata?.oma_created_via === "assistant" && full.metadata?.oma_assistant_session === sid, `metadata ${JSON.stringify(full.metadata)}`);
    const events = await listEvents(child.id);
    assert(!events.some((e) => String(e.type).startsWith("user.")), "в сессии уже есть события user.*");
    return child.id;
  });

  // Первое сообщение.
  const msg = card("send_message");
  await cardReady(msg);
  await shot("message-card");
  const childText = `VERIFY_BUILDER_CHILD nonce=${nonce}`;
  await check("vb.message_card", "карточка «Отправить первое сообщение» с полным текстом и строкой про запуск агента", async () => {
    assert(afterSess.stop?.type === "requires_action", `stop ${JSON.stringify(afterSess.stop)}`);
    const pre = await msg.locator('pre[aria-label="Текст сообщения"]').textContent();
    assert(pre === childText, `текст «${pre}»`);
    assert(await msg.getByText("Агент начнёт работу сразу после отправки").isVisible(), "нет строки про запуск");
    assert(await msg.getByRole("button", { name: "Отправить", exact: true }).isEnabled(), "кнопка «Отправить» выключена");
    return "полный текст на карточке";
  });
  const childBefore = await listEvents(child.id);
  await check("vb.message_before", "до «Отправить» в vb-session нет событий user.*", () => {
    assert(!childBefore.some((e) => String(e.type).startsWith("user.")), "есть user.*");
    return `событий ${childBefore.length}`;
  });
  const afterMsg = await clickAndWait(sid, msg, "Отправить");
  const childTurn = await waitIdle(child.id, 0, TURN_TIMEOUT);
  await check("vb.message_sent", "в vb-session ровно одно user.message с текстом карточки, ход агента ответил VERIFY_CHILD_DONE, ход ассистента закрыт end_turn", () => {
    assert(afterMsg.stop?.type === "end_turn", `ход ассистента после «Отправить»: stop ${JSON.stringify(afterMsg.stop)}`);
    const users = childTurn.events.filter((e) => e.type === "user.message");
    assert(users.length === 1 && textOf(users[0].content) === childText, `user.message: ${users.map((e) => textOf(e.content)).join(" | ")}`);
    const answer = childTurn.events.filter((e) => e.type === "agent.message").map((e) => textOf(e.content)).join(" ");
    assert(answer.includes(`VERIFY_CHILD_DONE_${nonce}`), `ответ «${answer.slice(0, 200)}»`);
    return `stop ${childTurn.stop?.type}`;
  });
  saveJson("20-child-session-events", childTurn.events);

  // Журнал, подтверждения, фейк.
  const { rows, confirmations } = await actions(sid);
  saveJson("21-main-actions", { rows, confirmations });
  await check("vb.action_log", "журнал действий: 9 строк в порядке шагов, все ok, от тестового пользователя; три строки пачки с одним tool_use_id, op_index 0..2 и одним confirmation_id", () => {
    const batchUseId = batchUse?.id;
    // Строка пачки несёт инструмент своей операции, вызов пачки виден по tool_use_id.
    const got = rows.map((r) => (r.tool_use_id === batchUseId ? `apply_changes#${r.op_index}:${r.tool}` : r.tool));
    const want = ["search_docs", "list", "apply_changes#0:create_environment", "apply_changes#1:create_skill", "apply_changes#2:create_agent", "create_deployment", "update_agent", "create_session", "send_message"];
    assert(JSON.stringify(got) === JSON.stringify(want), `строки ${got.join(", ")}`);
    assert(rows.every((r) => r.result === "ok" && r.user_id === user.user_id), `результаты ${rows.map((r) => r.result).join(",")}`);
    const batchRows = rows.filter((r) => r.tool_use_id === batchUseId);
    assert(new Set(batchRows.map((r) => r.confirmation_id)).size === 1 && batchRows[0].confirmation_id, "у строк пачки разные confirmation_id");
    return `${rows.length} строк`;
  });
  await check("vb.confirmations", "пять подтверждений allow, отпечаток каждого равен отпечатку preview консоли, в сессии пять user.tool_confirmation", async () => {
    const allow = confirmations.filter((c) => c.result === "allow");
    assert(allow.length === 5, `подтверждений allow ${allow.length}`);
    for (const c of allow) {
      const seen = previews.filter((p) => p.tool_use_id === c.tool_use_id).map((p) => p.digest);
      assert(seen.includes(c.preview_digest), `${c.tool_use_id}: отпечаток не из preview консоли`);
      assert(c.user_id === user.user_id, `${c.tool_use_id}: user ${c.user_id}`);
    }
    const events = await listEvents(sid);
    const tc = events.filter((e) => e.type === "user.tool_confirmation");
    assert(tc.length === 5, `user.tool_confirmation ${tc.length}`);
    return `${allow.length} подтверждений`;
  });
  await check("vb.fake_tools", `в каждом запросе сессии ассистента к модели ровно ${PLATFORM_TOOLS.length} инструментов таблицы платформы: имени вне таблицы нет, ни один не пропал`, () => {
    const reqs = fakeFor("BUILDER_MAIN");
    assert(reqs.length >= 7, `запросов ${reqs.length}`);
    const want = new Set(PLATFORM_TOOLS.map((name) => `mcp__platform__${name}`));
    for (const r of reqs) {
      const got = new Set(r.tools ?? []);
      const extra = [...got].filter((name) => !want.has(name));
      const missing = [...want].filter((name) => !got.has(name));
      assert(extra.length === 0, `запрос ${r.n}: имён нет в таблице: ${extra.join(", ")}`);
      assert(missing.length === 0, `запрос ${r.n}: нет инструментов таблицы: ${missing.join(", ")}`);
    }
    const fails = reqs.filter((r) => String(r.decision).startsWith("fail"));
    assert(fails.length === 0, `решения фейка: ${fails.map((r) => r.reply_text).join(" | ")}`);
    return `${want.size} инструментов в ${reqs.length} запросах`;
  });
  const bundle = await apiRaw("GET", "/v1/oma/platform-mcp/builder-bundle");
  await check("vb.danger_class", "archive_object и delete_object в комплекте ассистента только в группе «Архив и удаление» с подтверждением, остальные группы совпадают с таблицей; у агента ассистента они на always_ask", () => {
    assert(bundle.status === 200, `builder-bundle ${bundle.status} ${bundle.text.slice(0, 160)}`);
    const groups = bundle.json?.tool_groups ?? [];
    const sorted = (list) => JSON.stringify([...(list ?? [])].sort());
    assert(sorted(groups.map((g) => g.id)) === sorted(Object.keys(PLATFORM_TOOL_GROUPS)), `группы ${groups.map((g) => g.id).join(", ")}`);
    for (const [id, tools] of Object.entries(PLATFORM_TOOL_GROUPS)) {
      const group = groups.find((g) => g.id === id);
      assert(sorted(group.tools) === sorted(tools), `группа ${id}: ${(group.tools ?? []).join(", ")}`);
      assert(group.confirm === (id === "write" || id === "danger"), `группа ${id}: confirm ${group.confirm}`);
    }
    const danger = groups.find((g) => g.id === "danger");
    assert(danger.title === "Архив и удаление", `заголовок группы «${danger.title}»`);
    const mcp = (ids.builderTools ?? []).find((t) => t.type === "mcp_toolset");
    assert(mcp?.default_config?.permission_policy?.type === "always_ask", `политика по умолчанию ${JSON.stringify(mcp?.default_config)}`);
    const quiet = [...PLATFORM_TOOL_GROUPS.read, ...PLATFORM_TOOL_GROUPS.draft];
    const loose = (mcp.configs ?? []).filter((c) => c.permission_policy?.type !== "always_ask" && !quiet.includes(c.name));
    assert(loose.length === 0, `без подтверждения: ${loose.map((c) => `${c.name}=${c.permission_policy?.type}`).join(", ")}`);
    return `danger: ${danger.tools.join(", ")}; без подтверждения только чтение и черновик (${(mcp.configs ?? []).length})`;
  });

  // Вкладка «Изменения» и лист на 390 px.
  await panel().getByRole("tab", { name: "Изменения" }).click();
  const list = panel().locator('ul[aria-label="Журнал действий"] > li');
  await list.first().waitFor({ timeout: 15_000 });
  await shot("changes-tab");
  await check("vb.changes_tab", "на вкладке «Изменения» 9 строк", async () => {
    const n = await list.count();
    assert(n === 9, `строк ${n}`);
    return `${n} строк`;
  });
  await panel().getByRole("tab", { name: "Чат" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const sheet = page.locator(".assistant-sheet");
  await sheet.waitFor({ timeout: 10_000 }).catch(() => {});
  await shot("mobile-sheet");
  const box = await sheet.boundingBox().catch(() => null);
  await page.setViewportSize(VIEW);
  await panel().waitFor({ timeout: 10_000 }).catch(() => {});
  await check("vb.mobile_sheet", "на 390 px панель открыта нижним листом", () => {
    assert(box, "нижнего листа нет");
    assert(box.y > 100 && box.y + box.height >= 840, `лист ${JSON.stringify(box)}`);
    return `y=${Math.round(box.y)} h=${Math.round(box.height)}`;
  });
  cover("builder-batch", "builder-deployment", "builder-update", "builder-session", "builder-message", "builder-changes");
}

/** Деплоймент на паузе не запускался: проверка через 2 минуты после создания. */
async function stepDeploymentQuiet() {
  if (!ids.deployment) throw new Error("деплоймента из 6.2 нет");
  const wait = ids.deploymentCreatedAt + 125_000 - Date.now();
  if (wait > 0) {
    log(`жду ${Math.round(wait / 1000)} с: деплоймент «каждую минуту» на паузе не должен запуститься`);
    await sleep(wait);
  }
  const runs = await apiRaw("GET", `/v1/deployment_runs?deployment_id=${ids.deployment}&limit=50`);
  const sessions = await api("GET", `/v1/sessions?deployment_id=${ids.deployment}&limit=50`);
  const dep = await api("GET", `/v1/deployments/${ids.deployment}`);
  await check("vb.deployment_no_runs", "через 2 минуты у деплоймента на паузе нет запусков и сессий", () => {
    const runList = runs.status === 200 ? (runs.json.data ?? []) : [];
    assert(runs.status === 200, `deployment_runs ${runs.status}`);
    assert(runList.length === 0, `запусков ${runList.length}`);
    assert((sessions.data ?? []).length === 0, `сессий ${(sessions.data ?? []).length}`);
    assert(dep.status === "paused" && dep.updated_at === dep.created_at, `status ${dep.status}`);
    return "запусков 0, сессий 0";
  });
}

// ------------------------------------------------------- 6.3: отказ и обход ---
async function stepDeny() {
  await page.goto(`${BASE}/agents/${ids.agent}`);
  await page.getByRole("main").getByRole("heading", { level: 1 }).first().waitFor();
  await openPanel();
  await newConversation();
  const turn = await sendPanel([`VERIFY_BUILDER_DENY nonce=${nonce}`, `Цель: ${ids.agent}`, "Версия: 2"].join("\n"));
  const sid = turn.sid;
  const c = card("update_agent");
  await cardReady(c);
  const use = mcpUses(turn.events, "update_agent")[0];
  const rowsBefore = (await actions(sid)).rows.length;
  const direct = await apiRaw("POST", `/v1/sessions/${sid}/events`, { events: [{ type: "user.tool_confirmation", tool_use_id: use.id, result: "allow" }] });
  await check("vb.direct_confirmation", "прямой user.tool_confirmation allow: 403 «Подтверждайте через карточку», вызов не исполнен", async () => {
    assert(direct.status === 403, `код ${direct.status}`);
    assert(direct.text.includes("Подтверждайте через карточку"), direct.text.slice(0, 200));
    const events = await listEvents(sid);
    assert(!mcpResult(events, use.id), "вызов исполнен");
    assert((await actions(sid)).rows.length === rowsBefore, "в журнале прибавились строки");
    return "403";
  });
  await shot("deny-card");
  const after = await denyCard(sid, c, `причина vb-${nonce}`);
  await shot("deny-done");
  await check("vb.deny", "«Отклонить» с причиной: версия прежняя, результат вызова is_error с Denied, строка журнала denied", async () => {
    const agent = await api("GET", `/v1/agents/${ids.agent}`);
    assert(agent.version === 2, `версия ${agent.version}`);
    const result = mcpResult(after.events, use.id);
    assert(result?.is_error === true, `is_error ${result?.is_error}`);
    assert(/denied/i.test(textOf(result.content)) || /отклон/i.test(textOf(result.content)), `текст «${textOf(result.content).slice(0, 200)}»`);
    const rows = (await actions(sid)).rows.filter((r) => r.tool_use_id === use.id);
    assert(rows.map((r) => r.result).join() === "denied", `журнал ${rows.map((r) => r.result).join()}`);
    return textOf(result.content).slice(0, 80);
  });
  cover("builder-deny");
}

async function stepBypass() {
  const sid = await newAssistantSession(`vb-bypass-${nonce}`);
  const set = await apiRaw("POST", `/v1/sessions/${sid}`, { agent: { tools: builderTools({ allowAll: true }) } });
  assert(set.status === 200, `смена tools: ${set.status} ${set.text.slice(0, 200)}`);
  const turn = await sayApi(sid, [`VERIFY_BUILDER_BYPASS nonce=${nonce}`, `Цель: ${ids.agent}`, "Версия: 2"].join("\n"));
  const use = mcpUses(turn.events, "update_agent")[0];
  await check("vb.bypass", "always_allow у всех инструментов: harness исполнил update_agent без вопроса, сервер ответил «Нужно подтверждение», версия прежняя, refused_confirmation", async () => {
    assert(use, "вызова update_agent нет");
    assert(use.evaluated_permission !== "ask", `evaluated_permission ${use.evaluated_permission}`);
    const result = mcpResult(turn.events, use.id);
    assert(result?.is_error === true && textOf(result.content).includes("Нужно подтверждение"), `результат «${textOf(result?.content).slice(0, 200)}»`);
    const agent = await api("GET", `/v1/agents/${ids.agent}`);
    assert(agent.version === 2 && !agent.system.includes("VB_BYPASS"), `агент v${agent.version}`);
    const rows = (await actions(sid)).rows;
    assert(rows.some((r) => r.tool === "update_agent" && r.result === "refused_confirmation"), `журнал ${rows.map((r) => `${r.tool}:${r.result}`).join(",")}`);
    return "refused_confirmation";
  });
  cover("builder-bypass");
}

async function toolsCase(label, prepare, extra = {}) {
  const sid = await newAssistantSession(`vb-tools-${label}-${nonce}`, extra);
  if (prepare) await prepare(sid);
  const n2 = `${nonce}${label === "bash" ? "a" : "b"}`;
  const turn = await sayApi(sid, `VERIFY_BUILDER_TOOLS nonce=${n2}`);
  const reqs = fakeFor("BUILDER_TOOLS", n2);
  const tools = new Set(reqs.flatMap((r) => r.tools ?? []));
  const warning = turn.events.find((e) => e.type === "session.warning" && /MCP setup failed/.test(JSON.stringify(e)));
  const rows = (await actions(sid)).rows;
  return { sid, tools, warning, rows, turn };
}

async function stepBuiltins() {
  const bash = await toolsCase("bash", async (sid) => {
    const set = await apiRaw("POST", `/v1/sessions/${sid}`, { agent: { tools: builderTools({ builtins: ["bash", "read"] }) } });
    assert(set.status === 200, `смена tools: ${set.status} ${set.text.slice(0, 200)}`);
  });
  await check("vb.builtins_bash", "bash и read в сессии ассистента: у модели bash и ни одного mcp__platform__*, session.warning «MCP setup failed», журнал пуст", () => {
    assert(bash.tools.has("bash"), `tools ${[...bash.tools].join(",")}`);
    assert(![...bash.tools].some((n) => n.startsWith("mcp__platform__")), `есть платформа: ${[...bash.tools].filter((n) => n.startsWith("mcp__")).join(",")}`);
    assert(bash.warning, "нет session.warning MCP setup failed");
    assert(bash.rows.length === 0, `строк журнала ${bash.rows.length}`);
    return `${bash.tools.size} инструментов`;
  });
  // Маршрут ресурсов сессии принимает только файлы, поэтому хранилище памяти идёт в тело создания сессии.
  const mem = await toolsCase("memory", null, { resources: [{ type: "memory_store", memory_store_id: ids.memStore }] });
  await check("vb.builtins_memory", "ресурс memory_store в сессии ассистента: у модели нет mcp__platform__*, session.warning, журнал пуст", () => {
    assert(![...mem.tools].some((n) => n.startsWith("mcp__platform__")), `есть платформа: ${[...mem.tools].join(",")}`);
    assert(mem.warning, "нет session.warning MCP setup failed");
    assert(mem.rows.length === 0, `строк журнала ${mem.rows.length}`);
    return `инструменты: ${[...mem.tools].join(", ") || "нет"}`;
  });
  cover("builder-tool-check");
}

async function stepSwitch() {
  await page.goto(`${BASE}/agents`);
  await page.getByRole("main").getByRole("heading", { level: 1, name: "Агенты", exact: true }).waitFor();
  await openPanel();
  await newConversation();
  // Разговор начинается до выключения: реплика без маркера, фейк отвечает текстом.
  const opened = await sendPanel("привет");
  const sid = opened.sid;
  await panel().getByRole("button", { name: "Меню ассистента" }).click();
  await page.getByRole("menuitem", { name: "Выключить ассистента в пространстве" }).click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog", { name: "Выключить ассистента?" })).getByRole("button", { name: "Выключить", exact: true }).click();
  await panel().getByText("Ассистент выключен", { exact: false }).first().waitFor({ timeout: 15_000 });
  await shot("switch-off");
  const settings = await api("GET", "/v1/oma/platform-mcp/settings");
  await check("vb.switch_off_ui", "выключатель в меню панели: панель пишет «Ассистент выключен», поле ввода выключено", async () => {
    assert(settings.enabled === false, `enabled ${settings.enabled}`);
    const box = panel().getByRole("textbox", { name: "Сообщение ассистенту" });
    assert(await box.isDisabled(), "поле ввода включено");
    return "enabled=false";
  });
  const turn = await sayApi(sid, [`VERIFY_BUILDER_OFF nonce=${nonce}`, `Цель: ${ids.agent}`, "Версия: 2"].join("\n"));
  const listUse = mcpUses(turn.events, "list").at(-1);
  const updUse = mcpUses(turn.events, "update_agent").at(-1);
  const pv = updUse ? await apiRaw("POST", "/v1/oma/platform-mcp/preview", { session_id: sid, tool_use_id: updUse.id }) : null;
  const cf = updUse ? await apiRaw("POST", "/v1/oma/platform-mcp/confirm", { session_id: sid, tool_use_id: updUse.id, result: "allow", preview_digest: pv?.json?.preview_digest ?? "x" }) : null;
  const c = card("update_agent");
  const visible = await c.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  if (visible) await cardReady(c);
  await shot("switch-off-card");
  await check("vb.switch_off_tools", "при выключенном: list вернул isError «Ассистент выключен», refused_disabled; preview disabled, confirm 409 disabled; версия прежняя", async () => {
    const lr = listUse && mcpResult(turn.events, listUse.id);
    assert(lr?.is_error === true && textOf(lr.content).includes("Ассистент выключен"), `list «${textOf(lr?.content).slice(0, 160)}»`);
    const rows = (await actions(sid)).rows;
    assert(rows.some((r) => r.tool === "list" && r.result === "refused_disabled"), `журнал ${rows.map((r) => `${r.tool}:${r.result}`).join(",")}`);
    assert(turn.stop?.type === "requires_action" && updUse, `stop ${JSON.stringify(turn.stop)}`);
    assert(pv.status === 200 && pv.json.disabled === true, `preview ${pv.status} ${JSON.stringify(pv.json).slice(0, 160)}`);
    assert(cf.status === 409 && cf.json?.error?.type === "disabled", `confirm ${cf.status} ${cf.text.slice(0, 160)}`);
    const agent = await api("GET", `/v1/agents/${ids.agent}`);
    assert(agent.version === 2, `версия ${agent.version}`);
    return "refused_disabled, 409 disabled";
  });
  await check("vb.switch_off_card", "карточка правки в панели при выключенном ассистенте пишет «Ассистент выключен в пространстве», кнопка выключена", async () => {
    assert(visible, "в панели нет карточки: при выключенном ассистенте лента не показана");
    assert(await c.getByText("Ассистент выключен в пространстве").isVisible(), "нет текста блокировки");
    assert(await c.getByRole("button", { name: "Применить", exact: true }).isDisabled(), "кнопка включена");
    return "кнопка выключена";
  });
  await panel().getByRole("button", { name: "Меню ассистента" }).click();
  await page.getByRole("menuitem", { name: "Включить ассистента" }).click();
  const box = panel().getByRole("textbox", { name: "Сообщение ассистенту" });
  await waitFor("поле включено", async () => (await box.isEnabled()) || undefined, 15_000, 300);
  const c2 = card("update_agent");
  await cardReady(c2);
  await c2.getByRole("button", { name: "Обновить", exact: true }).click().catch(() => {});
  await cardReady(c2);
  await shot("switch-on-card");
  await check("vb.switch_on", "после включения «Обновить» на карточке: кнопка «Применить» снова работает", async () => {
    await waitFor("кнопка включена", async () => (await c2.getByRole("button", { name: "Применить", exact: true }).isEnabled()) || undefined, 15_000, 300);
    return "Применить включена";
  });
  await denyCard(sid, c2, "проверка выключателя");
  cover("builder-switch");
}

// ----------------------------------------------- 6.4: чужие и второй участник ---
async function stepForeign() {
  assert(foreign && member, "нет второго пользователя и участника: seed-user.sh --others");
  const fa = await apiAs("foreign", "POST", "/v1/agents", { name: `vb-foreign-${nonce}`, model: "claude-sonnet-4-6" });
  assert(fa.status < 300, `агент второго пользователя: ${fa.status} ${fa.text.slice(0, 200)}`);
  ids.foreignAgent = fa.json.id;
  const sid = await newAssistantSession(`vb-foreign-${nonce}`);
  ids.foreignSession = sid;
  const turn = await sayApi(sid, [`VERIFY_BUILDER_FOREIGN nonce=${nonce}`, `Цель: ${ids.foreignAgent}`].join("\n"));
  const getUse = mcpUses(turn.events, "get").at(-1);
  const updUse = mcpUses(turn.events, "update_agent").at(-1);
  ids.foreignPending = updUse?.id;
  const pv = updUse ? await apiRaw("POST", "/v1/oma/platform-mcp/preview", { session_id: sid, tool_use_id: updUse.id }) : null;
  const cf = updUse ? await apiRaw("POST", "/v1/oma/platform-mcp/confirm", { session_id: sid, tool_use_id: updUse.id, result: "allow", preview_digest: pv?.json?.preview_digest ?? "x" }) : null;
  await check("vb.foreign", "чужой агент: get «не найден», preview «Объект не найден», confirm 404, агент второго пользователя прежней версии, подтверждений нет", async () => {
    const gr = getUse && mcpResult(turn.events, getUse.id);
    assert(gr?.is_error === true && /не найден/i.test(textOf(gr.content)), `get «${textOf(gr?.content).slice(0, 160)}»`);
    assert(updUse && turn.stop?.type === "requires_action", `stop ${JSON.stringify(turn.stop)}`);
    assert(pv.status === 404 || pv.json?.not_found || pv.json?.notFound || /не найден/i.test(pv.text), `preview ${pv.status} ${pv.text.slice(0, 160)}`);
    assert(cf.status === 404, `confirm ${cf.status} ${cf.text.slice(0, 160)}`);
    const theirs = await apiAs("foreign", "GET", `/v1/agents/${ids.foreignAgent}`);
    assert(theirs.json.version === 1 && !String(theirs.json.system ?? "").includes("VB_FOREIGN"), `агент v${theirs.json.version}`);
    assert((await actions(sid)).confirmations.length === 0, "есть подтверждения");
    return `preview ${pv.status}, confirm ${cf.status}`;
  });
  // Карточка в панели: разговор из «Истории».
  await openPanel();
  await panel().getByRole("button", { name: "История" }).click();
  await panel().getByRole("button", { name: `vb-foreign-${nonce}` }).click();
  const c = card("update_agent");
  await cardReady(c);
  await shot("foreign-card");
  await check("vb.foreign_card", "карточка правки чужого агента пишет «Объект не найден», кнопка выключена", async () => {
    assert(await c.getByText("Объект не найден").first().isVisible(), "нет «Объект не найден»");
    assert(await c.getByRole("button", { name: "Применить", exact: true }).isDisabled().catch(() => true), "кнопка включена");
    return "кнопка выключена";
  });
  cover("builder-foreign");
}

async function stepMember() {
  const sid = ids.foreignSession;
  const pending = ids.foreignPending;
  assert(sid && pending, "нет ждущего вызова из шага чужого пространства");
  const eventsBefore = (await listEvents(sid)).length;
  const sessionBefore = await api("GET", `/v1/sessions/${sid}`);
  const logBefore = await actions(sid);
  const ev = (event) => apiAs("member", "POST", `/v1/sessions/${sid}/events`, { events: [event] });
  const attempts = {
    "user.message": await ev({ type: "user.message", content: [{ type: "text", text: "от участника" }] }),
    "system.message": await ev({ type: "system.message", content: [{ type: "text", text: "от участника" }] }),
    "user.define_outcome": await ev({ type: "user.define_outcome", description: "x", rubric: { type: "text", content: "x" } }),
    "user.tool_confirmation": await ev({ type: "user.tool_confirmation", tool_use_id: pending, result: "allow" }),
    "user.tool_result": await ev({ type: "user.tool_result", tool_use_id: pending, content: [{ type: "text", text: "x" }] }),
    "POST tools": await apiAs("member", "POST", `/v1/sessions/${sid}`, { agent: { tools: builderTools({ allowAll: true }) } }),
    "POST mcp_servers": await apiAs("member", "POST", `/v1/sessions/${sid}`, { agent: { mcp_servers: [{ type: "url", name: "platform", url: "http://127.0.0.1:9/mcp" }] } }),
    resources: await apiAs("member", "POST", `/v1/sessions/${sid}/resources`, { type: "file", file_id: ids.inputFile }),
    confirm: await apiAs("member", "POST", "/v1/oma/platform-mcp/confirm", { session_id: sid, tool_use_id: pending, result: "deny" }),
    settings: await apiAs("member", "POST", "/v1/oma/platform-mcp/settings", { enabled: false }),
  };
  const preview = await apiAs("member", "POST", "/v1/oma/platform-mcp/preview", { session_id: sid, tool_use_id: pending });
  saveJson("40-member-attempts", Object.fromEntries(Object.entries(attempts).map(([k, v]) => [k, { status: v.status, text: v.text.slice(0, 200) }])));
  await check("vb.member_refused", "второй участник: все записи в сессию ассистента, confirm и выключатель дают 403, preview отвечает", async () => {
    const bad = Object.entries(attempts).filter(([, r]) => r.status !== 403).map(([k, r]) => `${k}:${r.status}`);
    assert(bad.length === 0, `не 403: ${bad.join(", ")}`);
    assert(preview.status === 200, `preview ${preview.status}`);
    assert(preview.json?.can_confirm === false, `can_confirm ${preview.json?.can_confirm}`);
    return `${Object.keys(attempts).length} запросов 403, preview 200`;
  });
  await check("vb.member_no_effect", "после попыток участника: событий столько же, tools и mcp_servers прежние, вызов ждёт, журнал и подтверждения без новых строк, ассистент включён", async () => {
    const events = await listEvents(sid);
    assert(events.length === eventsBefore, `событий ${eventsBefore} -> ${events.length}`);
    assert(!mcpResult(events, pending), "вызов исполнен");
    const sessionAfter = await api("GET", `/v1/sessions/${sid}`);
    assert(JSON.stringify(sessionAfter.agent?.tools) === JSON.stringify(sessionBefore.agent?.tools), "tools изменились");
    assert(JSON.stringify(sessionAfter.agent?.mcp_servers) === JSON.stringify(sessionBefore.agent?.mcp_servers), "mcp_servers изменились");
    const logAfter = await actions(sid);
    assert(logAfter.rows.length === logBefore.rows.length && logAfter.confirmations.length === logBefore.confirmations.length, "журнал изменился");
    const settings = await api("GET", "/v1/oma/platform-mcp/settings");
    assert(settings.enabled === true, "ассистент выключен");
    return `событий ${events.length}`;
  });
  // Браузер участника: карточка без кнопок.
  const ctx2 = await browser.newContext({ baseURL: BASE, viewport: VIEW, locale: "ru-RU" });
  const p2 = await ctx2.newPage();
  p2.setDefaultTimeout(20_000);
  try {
    await login(p2, member);
    await p2.evaluate(([tenant, session]) => {
      localStorage.setItem("oma_active_tenant_id", tenant);
      localStorage.setItem(`oma_assistant_chat:${tenant}`, session);
    }, [user.tenant_id, sid]);
    await p2.goto(`${BASE}/agents`);
    await p2.getByRole("main").getByRole("heading", { level: 1 }).first().waitFor();
    await p2.keyboard.press("Control+i");
    const aside = p2.locator('aside[aria-label="Ассистент"]');
    await aside.waitFor();
    const c = aside.locator('article.assistant-card[data-tool="update_agent"]').last();
    await c.waitFor({ timeout: 30_000 });
    await waitFor("preview у участника", async () => (await c.getByText("Подтвердить может только").count()) > 0 || undefined, 30_000, 300);
    await shot("member-card", p2);
    await check("vb.member_card", "участник видит карточку без кнопок и подпись «Подтвердить может только …»", async () => {
      assert((await c.getByRole("button", { name: "Применить", exact: true }).count()) === 0, "у участника есть «Применить»");
      assert((await c.getByRole("button", { name: "Отклонить", exact: true }).count()) === 0, "у участника есть «Отклонить»");
      return (await c.getByText("Подтвердить может только").first().textContent()) ?? "";
    });
  } finally {
    await ctx2.close().catch(() => {});
  }
  const own = await apiAs("member", "POST", "/v1/sessions", {
    agent: { type: "agent", id: ids.builderAgent, version: ids.builderVersion }, environment_id: ids.builderEnv, title: `vb-member-own-${nonce}`,
  });
  const ownMsg = own.status < 300 ? await apiAs("member", "POST", `/v1/sessions/${own.json.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "привет от участника" }] }] }) : null;
  if (own.status < 300) created.sessions.push(own.json.id);
  saveCreated();
  await check("vb.member_own", "участник начинает свою сессию с тем же агентом и пишет в неё", () => {
    assert(own.status < 300, `создание ${own.status} ${own.text.slice(0, 160)}`);
    assert(ownMsg.status < 300, `сообщение ${ownMsg.status} ${ownMsg.text.slice(0, 160)}`);
    return own.json.id;
  });
  // Ждущий вызов закрывает владелец.
  await apiRaw("POST", "/v1/oma/platform-mcp/confirm", { session_id: sid, tool_use_id: pending, result: "deny" });
  // Прямой вход в MCP-сервер платформы с cookie и с ключом API.
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const viaCookie = await apiRaw("POST", "/v1/oma/platform-mcp", rpc, { accept: "application/json, text/event-stream" });
  const key = await api("POST", "/v1/oma/api_keys", { name: `vb-key-${nonce}` });
  const viaKey = await fetch(`${BASE}/v1/oma/platform-mcp`, {
    method: "POST",
    headers: { "x-api-key": key.key, "content-type": "application/json", accept: "application/json, text/event-stream", "anthropic-beta": BETAS },
    body: JSON.stringify(rpc),
  });
  await check("vb.direct_entry", "POST /v1/oma/platform-mcp с cookie и с ключом API: 403", () => {
    assert(viaCookie.status === 403, `cookie ${viaCookie.status}`);
    assert(viaKey.status === 403, `ключ ${viaKey.status}`);
    return "403, 403";
  });
  cover("builder-member");
}

// ---------------------------------------------------------- 6.7: секреты ---
async function stepSecrets() {
  const s = ids.secrets;
  const sid = await newAssistantSession(`vb-secrets-${nonce}`);
  ids.secretsSession = sid;
  const f = ids.secretFiles;
  const lines = [
    `VERIFY_BUILDER_SECRETS nonce=${nonce}`,
    ...(ids.secretAgent ? [`Агент: ${ids.secretAgent}`] : []),
    `Хранилище_секретов: ${ids.vault}`,
    `Деплоймент: ${ids.ghDeployment}`,
    `Файлы: ${[f.short.id, f.enc.id, f.copy.id, f.copyEnc.id].join(",")}`,
    `Навык: ${ids.copySkill}`,
    `Записи: ${ids.memStore}:${ids.memShort},${ids.memStore}:${ids.memCopy}`,
    `Поиск: VB_FIND_${nonce}`,
    `Сессия: ${ids.secretSession}`,
  ];
  const turn = await sayApi(sid, lines.join("\n"));
  saveJson("60-secrets-events", turn.events.map((e) => ({ type: e.type, name: e.name, is_error: e.is_error, text: e.type === "agent.mcp_tool_result" ? textOf(e.content).slice(0, 400) : undefined })));
  const final = turn.events.filter((e) => e.type === "agent.message").map((e) => textOf(e.content)).join(" ");
  await check("vb.secrets_masked", "чтение всего с секретами: в результатах [скрыто], короткие значения в строках «пароль:» заменены", () => {
    assert(final.includes(`VERIFY_BUILDER_SECRETS_DONE_${nonce}`), `ответ фейка «${final.slice(0, 300)}»`);
    return final.slice(0, 80);
  });
  const rows = (await actions(sid)).rows;
  await check("vb.secrets_masked_count", "у строк журнала чтений с секретами masked_count больше нуля", () => {
    const reads = rows.filter((r) => ["read_content", "search_config", "get_session_events"].includes(r.tool));
    assert(reads.length >= 5, `строк чтения ${reads.length}`);
    const zero = reads.filter((r) => !(r.masked_count > 0));
    assert(zero.length === 0, `masked_count 0 у ${zero.map((r) => r.tool).join(",")}`);
    return `строк ${reads.length}`;
  });

  // Подбор секрета.
  const osid = await newAssistantSession(`vb-oracle-${nonce}`);
  const L = { "Хранилище": ids.memStore, "Агент": ids.oracleAgent, "Своя": osid };
  const ot = await sayApi(osid, [`VERIFY_BUILDER_ORACLE nonce=${nonce}`, `Хранилище: ${ids.memStore}`, `Агент: ${ids.oracleAgent}`, `Своя: ${osid}`].join("\n"));
  const plan = oraclePlan(nonce, L, { value: s.oracle });
  const results = ot.events.filter((e) => e.type === "agent.mcp_tool_result").map((e) => ({ text: textOf(e.content), isError: e.is_error === true }));
  saveJson("61-oracle-results", results.map((r, i) => ({ step: plan[i]?.group, real: plan[i]?.real, isError: r.isError, length: r.text.length })));
  await check("vb.oracle_search", "search_config и list по префиксам секрета (1, 2, 4, 8 знаков и полное значение) не находят system агента vb-oracle-agent и запись /keys/…; от 4 знаков ответ равен ответу на случайную строку той же длины", () => {
    assert(results.length === plan.length, `результатов ${results.length} из ${plan.length}`);
    const norm = (i) => results[i].text.split(plan[i].query).join("Q");
    const problems = [];
    const groups = {};
    plan.forEach((p, i) => {
      if (!p.group.startsWith("search") && !p.group.startsWith("list")) return;
      (groups[p.group] ??= []).push(i);
      if (!p.real) return;
      let parsed = null;
      try { parsed = JSON.parse(results[i].text); } catch { problems.push(`${p.group}: ответ не JSON`); return; }
      const items = parsed.results ?? parsed.data ?? [];
      for (const item of items) {
        // Совпадение по system: строка совпадения из очищенного текста, где значение уже [скрыто].
        // Агент vb-oracle-agent находится только по имени; совпадение в другой строке значит, что system не скрыт.
        if (item.id === ids.oracleAgent && !String(item.line ?? "").includes("vb-oracle-agent")) problems.push(`${p.group}: агент найден по строке «${String(item.line).slice(0, 40)}»`);
        // Путь /keys/[скрыто].md может совпасть по короткому запросу с «keys» или «.md»; утечка это путь без маски.
        const path = String(item.path ?? item.name ?? "");
        if (path.startsWith("/keys/") && !path.includes("[скрыто]")) problems.push(`${p.group}: найдена запись /keys/ без маски`);
      }
    });
    for (const [g, idx] of Object.entries(groups)) {
      const len = Number(g.split(":")[1]);
      if (g.startsWith("search") && len < 4) continue; // короткая строка совпадает с именами объектов
      if (new Set(idx.map(norm)).size > 1) problems.push(`${g}: ответ отличается от ответа на случайную строку`);
    }
    assert(problems.length === 0, problems.join("; "));
    return `${Object.keys(groups).length} групп`;
  });
  await check("vb.oracle_preview", "preview_change: строки модели в after_yaml как есть, before_yaml с system: [скрыто]; события своей сессии закрыты", () => {
    const i = plan.findIndex((p) => p.group === "preview");
    const pv = JSON.parse(results[i].text);
    assert(typeof pv.after_yaml === "string", `ответ preview_change без after_yaml: ${results[i].text.slice(0, 120)}`);
    assert(pv.after_yaml.includes(s.oracle) && pv.after_yaml.includes(plan[i].decoy), "в after_yaml нет строк модели");
    assert(!pv.after_yaml.includes("[скрыто]"), "в after_yaml есть [скрыто]");
    assert(/system: .?\[скрыто\]/.test(pv.before_yaml ?? ""), `before_yaml «${String(pv.before_yaml).slice(0, 120)}»`);
    const own = results[plan.findIndex((p) => p.group === "own")];
    assert(own.isError && own.text.includes("События разговоров с ассистентом закрыты"), `своя сессия «${own.text.slice(0, 120)}»`);
    return "after_yaml без маски";
  });
  // Ротация идёт последней: после неё старое значение static_bearer уже не секрет, и широкий поиск подбора его покажет.
  const rsid = await newAssistantSession(`vb-rotate-${nonce}`);
  const t1 = await sayApi(rsid, [`VERIFY_BUILDER_ROTATE nonce=${nonce}`, `Файл: ${f.other.id}`].join("\n"));
  await api("POST", `/v1/vaults/${ids.vault}/credentials/${ids.bearerCred}`, { auth: { type: "static_bearer", token: s.bearer2 } });
  addCanary("static_bearer_rotated", s.bearer2);
  const t2 = await sayApi(rsid, [`VERIFY_BUILDER_ROTATE2 nonce=${nonce}`, `Файл: ${f.rot.id}`].join("\n"));
  await check("vb.rotation", "после ротации static_bearer новое значение скрыто в первом же ответе", () => {
    const a1 = t1.events.filter((e) => e.type === "agent.message").map((e) => textOf(e.content)).join(" ");
    const a2 = t2.events.filter((e) => e.type === "agent.message").map((e) => textOf(e.content)).join(" ");
    assert(a1.includes(`VERIFY_BUILDER_ROTATE_DONE_${nonce}`), `ход 1 «${a1.slice(0, 200)}»`);
    assert(a2.includes(`VERIFY_BUILDER_ROTATE2_DONE_${nonce} masked=true`), `ход 2 «${a2.slice(0, 200)}»`);
    return "masked=true";
  });

  cover("builder-secrets");
}

/** Итог по канарейкам: ни одного попадания, значения не в журнале фейка и не в доказательствах. */
async function stepCanaryVerdict() {
  const hits = fakeLog().filter((r) => r.decision === "canary_hit");
  await check("vb.canary_hits", "ни одной строки canary_hit в журнале фейковой модели за прогон", () => {
    assert(hits.length === 0, `попадания: ${[...new Set(hits.map((h) => h.canary_id))].join(", ")}`);
    return `канареек ${readCanaries(CANARY_FILE).length}`;
  });
  await check("vb.canary_not_logged", "журнал фейка и доказательства не содержат ни одного контрольного значения длиннее 3 знаков", () => {
    const sources = [run.FAKE_REQUESTS, run.FAKE_LOG, ...readdirSync(join(EV, "api")).map((f) => join(EV, "api", f))].filter((f) => existsSync(f));
    const found = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const c of readCanaries(CANARY_FILE)) {
        if (c.value.length <= 3 || c.id === "platform_token_prefix") continue;
        if (canaryForms(c.value).some((form) => form.length > 3 && text.includes(form))) found.push(`${c.id} в ${file.split("/").pop()}`);
      }
    }
    assert(found.length === 0, found.join("; "));
    return `файлов ${sources.length}`;
  });
}

// ------------------------------------------------------------ 6.8: живая ---
/** Ключ живой модели: файл с правами 600 или одна переменная platform/.env. Значение не печатается. */
function loadLiveKey() {
  const file = process.env.VERIFY_LIVE_SECRET_FILE ?? "";
  if (file) {
    if (file.startsWith(join(os.homedir(), ".claude"))) throw new Error("учётные данные из ~/.claude не используются");
    const mode = statSync(file).mode & 0o077;
    if (mode !== 0) throw new Error(`${file}: права шире 600`);
    const value = readFileSync(file, "utf8").trim();
    if (!value || value.includes("\n")) throw new Error(`${file}: нужен один ключ одной строкой`);
    return value;
  }
  const name = process.env.VERIFY_LIVE_ENV_KEY ?? "";
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("VERIFY_BUILDER_MODE=live: задайте VERIFY_LIVE_SECRET_FILE или VERIFY_LIVE_ENV_KEY (имя переменной в platform/.env)");
  const line = readFileSync(join(run.PLATFORM_DIR, ".env"), "utf8").split("\n").filter((l) => l.startsWith(`${name}=`)).at(-1);
  const value = (line ?? "").slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
  if (!value) throw new Error(`в platform/.env нет значения ${name}`);
  return value;
}

async function stepLiveCard() {
  const baseUrl = process.env.VERIFY_LIVE_BASE_URL ?? "";
  if (!baseUrl) throw new Error("VERIFY_BUILDER_MODE=live: задайте VERIFY_LIVE_BASE_URL (адрес шлюза, например LiteLLM …/v1)");
  const key = loadLiveKey();
  const res = await apiRaw("POST", "/v1/oma/model_cards", {
    model_id: LIVE_CARD,
    provider: process.env.VERIFY_LIVE_PROVIDER ?? "openai-compatible",
    model: process.env.VERIFY_LIVE_WIRE_MODEL ?? LIVE_CARD,
    api_key: key,
    base_url: baseUrl,
  });
  assert(res.status === 201, `карточка ${LIVE_CARD}: ${res.status} ${res.text.slice(0, 200)}`);
  names.card = LIVE_CARD;
  await check("live.card", `карточка ${LIVE_CARD} на живую модель, проба ключа при создании`, () => {
    const probe = res.json?.probe;
    assert(probe?.ok !== false, `проба ключа: ${probe?.message ?? "ошибка"}`);
    return `проба: ${probe?.ok === null ? "провайдер без пробы" : "ok"}`;
  });
}

/** Ход живой модели: подтверждать карточки, отвечать на вопросы, пока не будет первого сообщения. */
async function stepLive() {
  const t0 = Date.now();
  const deadline = t0 + Number(process.env.VERIFY_LIVE_TIMEOUT_MS ?? 1_200_000);
  const nudges = [
    "Да, делай как предлагаешь. Названия выбери сам, записи я подтвержу кнопкой.",
    "Создай всё одной пачкой, затем сессию и отдельно первое сообщение с заданием.",
    "Продолжай: нужна сессия с этим агентом и первое сообщение в неё.",
  ];
  let turn = await sendPanel(LIVE_PROMPT);
  const sid = turn.sid;
  ids.liveSession = sid;
  let turns = 1;
  let firstProposalTurn = null;
  const confirmed = [];
  let nudge = 0;
  while (Date.now() < deadline) {
    if (turn.stop?.type === "requires_action") {
      firstProposalTurn ??= turns;
      const pending = panel().locator('article.assistant-card[data-phase="pending"]').last();
      await cardReady(pending);
      const tool = await pending.getAttribute("data-tool");
      await shot(`live-card-${confirmed.length + 1}`);
      const button = pending.getByRole("button", { name: /^(Создать|Применить|Отправить)$/ }).first();
      if (await button.isDisabled()) {
        const reason = (await pending.textContent())?.slice(0, 300) ?? "";
        confirmed.push({ tool, result: "blocked", reason });
        turn = await denyCard(sid, pending, "Эта карточка не подходит, собери заново");
      } else {
        confirmed.push({ tool, result: "allow" });
        turn = await clickAndWait(sid, pending, (await button.textContent()).trim());
      }
      turns++;
      continue;
    }
    const { rows } = await actions(sid);
    if (rows.some((r) => r.tool === "send_message" && r.result === "ok")) break;
    if (nudge >= nudges.length) break;
    turn = await sendPanel(nudges[nudge++]);
    turns++;
  }
  const events = await listEvents(sid);
  const { rows, confirmations } = await actions(sid);
  saveJson("80-live-events", events.map((e) => ({ type: e.type, name: e.name, is_error: e.is_error, text: textOf(e.content).slice(0, 600), input: e.type === "agent.mcp_tool_use" ? e.input : undefined })));
  saveJson("81-live-actions", { rows, confirmations, confirmed });
  const results = events.filter((e) => e.type === "agent.mcp_tool_result");
  const schemaErrors = results.filter((e) => e.is_error && /Аргументы не прошли схему|Validation failed|не прошёл проверку|Строка YAML/.test(textOf(e.content)));
  const calls = events.filter((e) => e.type === "agent.mcp_tool_use");
  const ok = (tool) => rows.filter((r) => r.tool === tool && r.result === "ok");
  const created = { agent: ok("create_agent")[0], environment: ok("create_environment")[0], session: ok("create_session")[0], message: ok("send_message")[0] };
  const batchRows = rows.filter((r) => calls.some((c) => c.id === r.tool_use_id && c.name === "mcp__platform__apply_changes"));
  record("live.metrics", "замеры 6.8", "проверено",
    `вызовов ${calls.length}, ошибок схемы ${schemaErrors.length}, ходов ${turns}, первая карточка на ходу ${firstProposalTurn ?? "—"}, пачка ${batchRows.length > 0 ? "да" : "нет"}, карточек ${confirmed.length} (${confirmed.map((c) => `${c.tool}:${c.result}`).join(", ")}), время ${Math.round((Date.now() - t0) / 1000)} с`);
  await check("live.agent", "агент создан по подтверждению", () => { assert(created.agent, "create_agent ok нет"); return created.agent.target_id; });
  await check("live.environment", "окружение создано по подтверждению", () => { assert(created.environment, "create_environment ok нет"); return created.environment.target_id; });
  await check("live.session", "сессия создана по подтверждению", () => { assert(created.session, "create_session ok нет"); return created.session.target_id; });
  await check("live.message_card", "первое сообщение ушло отдельной карточкой send_message", () => {
    assert(created.message, "send_message ok нет");
    assert(!batchRows.some((r) => r.tool === "send_message"), "сообщение внутри пачки");
    return created.message.target_id;
  });
  await check("live.schema_errors", "на прогон не больше 2 ошибок схемы", () => {
    assert(schemaErrors.length <= 2, `ошибок схемы ${schemaErrors.length}: ${schemaErrors.map((e) => textOf(e.content).slice(0, 120)).join(" | ")}`);
    return `${schemaErrors.length}`;
  });
  await check("live.confirmed_only", "каждая запись прошла через подтверждение владельца", () => {
    const writes = rows.filter((r) => !["search_docs", "search_config", "list", "get", "read_content", "get_session_events", "get_trajectory", "help", "request_secret", "preview_change"].includes(r.tool) && r.result === "ok");
    assert(writes.every((r) => r.confirmation_id), "есть запись без confirmation_id");
    return `записей ${writes.length}`;
  });
  if (created.message) {
    const child = created.message.target_id;
    created.sessions.push(child);
    saveCreated();
    const childTurn = await waitIdle(child, 0, Number(process.env.VERIFY_LIVE_CHILD_TIMEOUT_MS ?? 900_000));
    saveJson("82-live-child-events", childTurn.events.map((e) => ({ type: e.type, name: e.name, is_error: e.is_error, text: textOf(e.content).slice(0, 600) })));
    await check("live.child_answered", "созданная сессия ответила на первое сообщение", () => {
      const answer = childTurn.events.filter((e) => e.type === "agent.message").map((e) => textOf(e.content)).join(" ").trim();
      assert(answer.length > 0, `ответа нет, stop ${JSON.stringify(childTurn.stop)}`);
      assert(!childTurn.events.some((e) => e.type === "session.error"), "в сессии session.error");
      return answer.slice(0, 160);
    });
  }
  await panel().getByRole("tab", { name: "Изменения" }).click();
  await shot("live-changes");
  await panel().getByRole("tab", { name: "Чат" }).click();
  cover("builder-qwen");
}

// -------------------------------------------------------------------- итог ---
function featureEntries() {
  const dir = join(SKILL_DIR, "features");
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    if (!text.includes("<!-- scenario: builder -->")) continue;
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
  const notChecked = LIVE ? [] : [
    ["vb.tunnel_token", "токен туннеля: стенд проверки туннелей не поднимает"],
    ["vb.after_click_window", "окно между кликом и исполнением браузер не ловит, его проверяют тесты gate и platform-mcp-e2e (6.6)"],
    ["vb.rerun_6_2", "повтор 6.2 после негативных сценариев в том же прогоне не делается, его даёт следующий прогон"],
  ];
  // Живой прогон считает только подфункцию 6.8, фейковый все остальные и её как непроверенную.
  const features = featureEntries().filter((f) => !LIVE || f.id === "builder-qwen");
  const uncovered = features.filter((f) => !covered.has(f.id));
  const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# verify-agent-console: сценарий builder${LIVE ? `, живая модель ${LIVE_CARD}` : ""} (ассистент платформы), прогон ${run.RUN_ID}`,
    "",
    `Итог: ${abortError ? "ПРЕРВАН" : failed.length ? "ПРОВАЛ" : "ПРОЙДЕН"} (проверок: ${checks.length}, провалов: ${failed.length}, подфункций сценария пройдено ${features.length - uncovered.length} из ${features.length}).`,
    abortError ? `Сценарий прерван: ${plain(abortError.message)}` : "",
    "",
    "## Экземпляр",
    "",
    `- URL: ${BASE}, фейк ${run.FAKE_URL}, git ${run.GIT_REV}; хэши изменений: консоль ${run.CONSOLE_TREE_HASH}, сервер ${run.SERVER_TREE_HASH}`,
    `- учётка ${user.email}, пространство ${user.tenant_id}; участник ${member?.user_id ?? "—"}, второй пользователь ${foreign?.user_id ?? "—"}`,
    `- ассистент ${ids.builderAgent ?? "—"} v${ids.builderVersion ?? "?"}, окружение ${ids.builderEnv ?? "—"}, карточка модели ${names.card}; nonce ${nonce}`,
    `- разговор 6.2 ${ids.mainSession ?? "—"}; окружение ${ids.env ?? "—"}, навык ${ids.skill ?? "—"}, агент ${ids.agent ?? "—"}, деплоймент ${ids.deployment ?? "—"}, сессия ${ids.childSession ?? "—"}`,
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
    "RUN=\"$(scripts/launch.sh)\" && { scripts/doctor.sh --run \"$RUN\" && scripts/seed-user.sh --run \"$RUN\" --others && scripts/journey.sh --run \"$RUN\" --scenario builder; scripts/cleanup.sh --run \"$RUN\"; } (папка .claude/skills/verify-agent-console).",
    "",
  ];
  writeFileSync(join(EV, "summary.md"), lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n"));
}

function copyLogs() {
  for (const [from, to] of [
    [run.SERVER_LOG, "logs/main-node.journey.log"],
    [run.FAKE_LOG, "logs/fake-model.log"],
  ]) if (from && existsSync(from)) copyFileSync(from, join(EV, to));
  // Журнал фейка без канареек: сами значения в доказательства не копируются, только строки решений.
  if (existsSync(run.FAKE_REQUESTS)) {
    const values = readCanaries(CANARY_FILE).filter((c) => c.value.length > 3).flatMap((c) => canaryForms(c.value)).filter((v) => v.length > 3);
    const lines = readFileSync(run.FAKE_REQUESTS, "utf8").split("\n").filter(Boolean)
      .map((line) => values.reduce((acc, v) => acc.split(v).join("[канарейка]"), line));
    writeFileSync(join(EV, "logs", "fake-model-requests.jsonl"), lines.join("\n") + "\n");
  }
}

const ctx = {
  nonce, names, ids, user, created, previews, confirms, BASE, TURN_TIMEOUT,
  get page() { return page; },
  api, apiRaw, listEvents, waitIdle, waitFor, actions, fakeFor, mcpResult, mcpUses, textOf,
  newAssistantSession, sayApi, builderTools, uploadFile, createSkillApi,
  panel, card, openPanel, newConversation, sendPanel, panelSessionId, cardReady, clickAndWait, denyCard,
  shot, aria, saveJson, saveCreated, check, record, assert, cover, log, sleep,
};

let abortError = null;
log(`прогон ${run.RUN_ID}, сценарий builder, nonce ${nonce}, доказательства ${EV}`);
try {
  const health = await (await fetch(`${BASE}/health`)).json();
  if (health?.backends?.db !== `sqlite ${run.DB_PATH}`) throw new Error(`на ${BASE} не экземпляр этого прогона (db: ${health?.backends?.db})`);
  const fh = await (await fetch(`${run.FAKE_URL}/health`)).json().catch(() => null);
  if (!fh?.ok) throw new Error(`фейковая модель ${run.FAKE_URL} не отвечает`);
  browser = await chromium.launch({ executablePath: pickChromium(), headless: process.env.VERIFY_HEADED !== "1", args: ["--disable-gpu"] });
  context = await browser.newContext({ baseURL: BASE, viewport: VIEW, locale: "ru-RU" });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  watchCards(page);
  log(`процессов браузера записано в state/pids: ${recordJourneyChildren()}`);
  const only = (process.env.VERIFY_BUILDER_ONLY ?? "").split(",").filter(Boolean);
  const failedSteps = new Set();
  const steps = LIVE
    ? [
        ["вход", stepLogin, true],
        ["карточка живой модели", stepLiveCard, true],
        ["установка ассистента", stepInstall, true],
        ["6.8 живая модель", stepLive, false],
      ]
    : null;
  for (const [name, fn, critical, needs = []] of steps ?? [
    ["вход", stepLogin, true],
    ["карточка модели и файл", stepSeedBasics, true],
    ["контрольные секреты", stepSeedSecrets, true],
    ["установка ассистента", stepInstall, true],
    ["6.2 основной путь", stepMain, false],
    ["6.3 отклонить", stepDeny, false, ["6.2 основной путь"]],
    ["6.3 обход политики", stepBypass, false, ["6.2 основной путь"]],
    ["6.3 встроенные инструменты", stepBuiltins, false],
    ["6.3 выключатель", stepSwitch, false, ["6.2 основной путь"]],
    ["6.4 чужое пространство", stepForeign, false],
    ["6.4 второй участник", stepMember, false, ["6.4 чужое пространство"]],
    ...guardSteps(ctx).map(([n, f, needs2]) => [n, f, false, needs2 ?? ["6.2 основной путь"]]),
    ["6.7 секреты", stepSecrets, false],
    ["деплоймент без запусков", stepDeploymentQuiet, false, ["6.2 основной путь"]],
  ]) {
    if (only.length && !critical && !only.some((o) => name.includes(o))) continue;
    const missing = needs.filter((need) => failedSteps.has(need));
    if (missing.length > 0) {
      failedSteps.add(name);
      record(`vb.step_skipped.${name.replace(/\s+/g, "_")}`, `шаг «${name}»`, "не проверено", "", `не выполнен шаг: ${missing.join(", ")}`);
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
      record(`vb.step_failed.${name.replace(/\s+/g, "_")}`, `шаг «${name}» выполнен до конца`, "провал", "", error.message);
      await shot(`fail-step-${name.replace(/\s+/g, "-")}`).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.setViewportSize(VIEW).catch(() => {});
    }
  }
  copyLogs();
  if (!LIVE) await stepCanaryVerdict();
} catch (error) {
  abortError = error;
  record("vb.abort", "сценарий дошёл до конца", "провал", "", error.message);
  if (page) await shot("abort").catch(() => {});
} finally {
  record("vb.screens_distinct", "скриншоты соседних шагов различаются (sha256)",
    duplicateShots.length === 0 ? "проверено" : "провал", `скриншотов ${screens.length}`,
    duplicateShots.length === 0 ? "" : `совпали: ${duplicateShots.join("; ")}`);
  copyLogs();
  writeSummary(abortError);
  await browser?.close().catch(() => {});
}
const failedCount = checks.filter((c) => c.status === "провал").length;
log(`итог: ${abortError ? "ПРЕРВАН" : failedCount ? "ПРОВАЛ" : "ПРОЙДЕН"}, ${join(EV, "summary.md")}`);
process.exit(failedCount ? 1 : 0);
