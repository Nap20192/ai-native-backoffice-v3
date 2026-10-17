#!/usr/bin/env node
// Сценарий «crud» verify-agent-console: правка, архив и удаление сущностей через консоль
// (docs/plans/crud.md). Playwright, консоль на русском, фейковая модель.
//   агент и окружение: архив и возврат из архива в списке;
//   окружение с живой сессией: окно удаления со списком «Мешает» и 409 сервера, после архива
//     сессии удаление проходит;
//   деплоймент: создание на паузе со страницы агента, «Запустить» на паузе выключен,
//     «Продолжить», запуск с прогоном, «Пауза», архив;
//   «Файлы»: загрузка кнопкой «Загрузить» и удаление;
//   помощник: архив сессии и удаление файла только после клика по красной карточке,
//     прямое подтверждение без карточки 403, «Отклонить» оставляет файл.
// Решения фейка для помощника: VERIFY_BUILDER_CRUD и VERIFY_BUILDER_CRUDDENY в fake-model-builder.mjs.
// Запуск: scripts/journey.sh --run <RUN_ID> --scenario crud. Итог: $EVIDENCE_DIR/summary.md.
import { createRequire } from "node:module";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------- прогон ---
const SKILL_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RUN_DIR = (() => {
  const dir = process.env.VERIFY_RUN_DIR ?? "";
  if (!dir || !existsSync(join(dir, ".verify-agent-console-run"))) {
    throw new Error("прогон не задан: VERIFY_RUN_DIR=<папка прогона> (scripts/journey.sh --run <RUN_ID> --scenario crud задаёт её сам)");
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
const VIEW = { width: 1280, height: 860 };
const MAX_SHOT_HEIGHT = 6000;
const TURN_TIMEOUT = Number(process.env.VERIFY_TURN_TIMEOUT_MS ?? 180_000);
const BETAS = ["managed-agents-2026-04-01", "files-api-2025-04-14", "skills-2025-10-02", "agent-memory-2026-07-22"].join(",");
if (run.MODEL_MODE !== "fake") throw new Error("сценарий crud идёт на экземпляре в режиме fake (VERIFY_MODEL_MODE=fake)");

const nonce = randomBytes(4).toString("hex");
const names = {
  card: `vc-fake-${nonce}`,
  agent: `vc-agent-${nonce}`,
  env: `vc-env-${nonce}`,
  envDel: `vc-env-del-${nonce}`,
  sessionDel: `vc-session-del-${nonce}`,
  sessionX: `vc-session-x-${nonce}`,
  deployment: `vc-dep-${nonce}`,
  upload: `vc-upload-${nonce}.txt`,
  fileX: `vc-file-x-${nonce}.txt`,
  fileDeny: `vc-file-deny-${nonce}.txt`,
};
const ids = {};
const created = { sessions: [], agents: [], environments: [] };
const covered = new Set();
const cover = (...list) => list.forEach((id) => covered.add(id));

const require = createRequire(join(run.PLATFORM_DIR, "package.json"));
const { chromium } = require("@playwright/test");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...parts) => console.log(new Date().toTimeString().slice(0, 8), ...parts);

// --------------------------------------------------------------- проверки ---
const checks = [];
const plain = (text) => String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
function record(id, title, status, evidence = "", note = "") {
  checks.push({ id, title, status, evidence: plain(evidence), note: plain(note) });
  log(`${status.padEnd(12)} ${id}: ${title}${note ? ` (${plain(note)})` : ""}`);
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
    for (const el of document.querySelectorAll("main, .assistant-panel-body")) extra = Math.max(extra, el.scrollHeight - el.clientHeight);
    return extra;
  }).catch(() => 0);
}
async function shot(name, p = page) {
  const file = `screens/${String(++shotN).padStart(2, "0")}-vc-${name}.png`;
  const size = p.viewportSize() ?? VIEW;
  // Окно подтверждения висит поверх страницы: растягивать её под снимок нельзя, окно уедет.
  const modal = await p.locator('[role="dialog"], [role="alertdialog"]').count().catch(() => 0);
  const extra = size.width >= 1000 && !modal ? await hiddenScrollHeight(p) : 0;
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
  const file = `aria/${String(shotN).padStart(2, "0")}-vc-${name}.yml`;
  writeFileSync(join(EV, file), await (locator ?? page.locator("body")).ariaSnapshot());
  return file;
}
function saveJson(name, data) {
  const file = `api/vc-${name}.json`;
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
async function apiRaw(method, path, body, headers = {}) {
  const res = await context.request.fetch(BASE + path, {
    method,
    headers: { "anthropic-beta": BETAS, origin: BASE, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    data: body === undefined ? undefined : JSON.stringify(body),
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
async function uploadFileApi(filename, content) {
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
async function listEvents(sessionId) {
  const all = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ limit: "100", order: "asc" });
    if (cursor) q.set("page", cursor);
    const r = await apiRaw("GET", `/v1/sessions/${sessionId}/events?${q}`);
    if (r.status !== 200) throw new Error(`GET events ${sessionId} -> ${r.status}`);
    all.push(...(r.json.data ?? []));
    if (!r.json.next_page) break;
    cursor = r.json.next_page;
  }
  return all;
}
function textOf(content) {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.map((b) => (b?.type === "text" ? String(b.text ?? "") : "")).join("\n") : "";
  if (!text.startsWith("{") || !text.includes('"content"')) return text;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.content)) return parsed.content.map((b) => (b?.type === "text" ? String(b.text ?? "") : "")).join("\n");
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
async function waitIdle(sessionId, from, timeout = TURN_TIMEOUT) {
  let events = [];
  const idle = await waitFor(`session.status_idle в ${sessionId}`, async () => {
    events = await listEvents(sessionId);
    return events.slice(from).find((e) => e.type === "session.status_idle");
  }, timeout, 1000);
  return { idle, stop: idle.stop_reason ?? null, events };
}
async function actions(sessionId) {
  const pageRows = await api("GET", `/v1/oma/platform-mcp/actions?session_id=${encodeURIComponent(sessionId)}&limit=200`);
  return [...(pageRows.actions ?? [])];
}
const mcpUses = (events, tool) => events.filter((e) => e.type === "agent.mcp_tool_use" && e.name === `mcp__platform__${tool}`);
const mcpResult = (events, toolUseId) => events.find((e) => e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id === toolUseId);
const lastAgentText = (events) => events.filter((e) => e.type === "agent.message").map((e) => textOf(e.content)).pop() ?? "";

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

// Перехват preview консоли: класс и отпечаток карточки.
const previews = [];
function watchCards(p) {
  p.on("response", async (res) => {
    if (!res.url().endsWith("/v1/oma/platform-mcp/preview")) return;
    try {
      const req = JSON.parse(res.request().postData() ?? "{}");
      previews.push({ tool_use_id: req.tool_use_id, status: res.status(), body: await res.json().catch(() => null) });
    } catch {
      /* ответ без тела */
    }
  });
}

// --------------------------------------------------------------- страницы ---
const main = () => page.getByRole("main");
const nav = () => page.getByRole("navigation", { name: "Разделы консоли" });
const rows = () => page.locator('[data-testid="data-body-table"] tr[data-slot="table-row"]');
const rowOf = (text) => rows().filter({ hasText: text });
async function openSection(link, heading = link) {
  await nav().getByRole("link", { name: link, exact: true }).click();
  await main().getByRole("heading", { level: 1, name: heading, exact: true }).waitFor();
}
/** Пункт контекстного меню строки (правая кнопка мыши, как у пользователя). */
async function rowMenu(text, item) {
  const row = rowOf(text).first();
  await row.waitFor({ timeout: 20_000 });
  await row.click({ button: "right" });
  const entry = page.getByRole("menuitem", { name: item, exact: true });
  await entry.waitFor({ timeout: 10_000 });
  return entry;
}
/** Окно архива или удаления после проверки зависимостей. */
async function dangerDialog(title) {
  const dialog = page.getByRole("dialog", { name: title });
  await dialog.waitFor({ timeout: 15_000 });
  await waitFor("зависимости в окне", async () => (await dialog.getByText("Проверяем, что связано с объектом").count()) === 0 || undefined, 20_000, 200);
  return dialog;
}
async function setStatusFilter(label) {
  await main().getByRole("button", { name: /^Статус/ }).first().click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await page.keyboard.press("Escape");
}

// ----------------------------------------------------------------- панель ---
const panel = () => page.locator('aside[aria-label="Ассистент"]');
const card = (tool, phase = "pending") => panel().locator(`article.assistant-card[data-tool="${tool}"]${phase ? `[data-phase="${phase}"]` : ""}`).last();
async function openPanel() {
  if (await panel().count()) return;
  await page.keyboard.press("Control+i");
  await panel().waitFor({ timeout: 15_000 });
}
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
  return { sid, ...(await waitIdle(sid, sid === sid0 ? before : 0)) };
}
async function cardReady(c) {
  await c.waitFor({ timeout: 30_000 });
  await waitFor("preview карточки", async () => (await c.getByText("Готовлю предложение").count()) === 0 || undefined, 30_000, 200);
}
async function clickAndWait(sid, c, buttonName) {
  const before = (await listEvents(sid)).length;
  await c.getByRole("button", { name: buttonName, exact: true }).click();
  return waitIdle(sid, before);
}

// ------------------------------------------------------------------- шаги ---
async function stepLogin() {
  await page.goto(`${BASE}/login`);
  await page.getByRole("button", { name: "Продолжить с почтой" }).click();
  await page.locator("#auth-email").fill(user.email);
  await page.locator("#auth-password").fill(user.password);
  await page.getByRole("group", { name: "Действия входа" }).getByRole("button", { name: "Войти", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  await nav().waitFor();
  const me = await api("GET", "/v1/oma/me");
  await check("crud.auth", "вход в консоль тестовой учёткой", () => {
    assert(me.user?.id === user.user_id && me.tenant?.id === user.tenant_id, `me ${me.user?.id} ${me.tenant?.id}`);
    return "GET /v1/oma/me";
  });
}

/** Исходные объекты по API: их создание проверяют другие сценарии, здесь проверяются правка, архив и удаление. */
async function stepSeed() {
  const cardRes = await apiRaw("POST", "/v1/oma/model_cards", {
    model_id: names.card, provider: "anthropic", model: "claude-sonnet-4-6", api_key: `vc-card-key-${nonce}`, base_url: run.FAKE_URL,
  });
  assert(cardRes.status === 201, `карточка модели: ${cardRes.status} ${cardRes.text.slice(0, 200)}`);
  const agent = await api("POST", "/v1/agents", { name: names.agent, model: names.card, system: `Проверочный агент vc-${nonce}.` });
  ids.agent = agent.id;
  created.agents.push(agent.id);
  const envConfig = { type: "cloud", networking: { type: "unrestricted" } };
  ids.env = (await api("POST", "/v1/environments", { name: names.env, config: envConfig })).id;
  ids.envDel = (await api("POST", "/v1/environments", { name: names.envDel, config: envConfig })).id;
  created.environments.push(ids.env, ids.envDel);
  ids.sessionDel = (await api("POST", "/v1/sessions", { agent: ids.agent, environment_id: ids.envDel, title: names.sessionDel })).id;
  ids.sessionX = (await api("POST", "/v1/sessions", { agent: ids.agent, environment_id: ids.env, title: names.sessionX })).id;
  created.sessions.push(ids.sessionDel, ids.sessionX);
  saveCreated();
  ids.fileX = (await uploadFileApi(names.fileX, `Файл для помощника vc-${nonce}\n`)).id;
  ids.fileDeny = (await uploadFileApi(names.fileDeny, `Файл для отказа vc-${nonce}\n`)).id;
  await check("crud.seed", "исходные объекты по API: карточка модели на фейк, агент, два окружения, две сессии без сообщений, два файла", () =>
    `агент ${ids.agent}, окружения ${ids.env} и ${ids.envDel}, сессии ${ids.sessionDel} и ${ids.sessionX}, файлы ${ids.fileX} и ${ids.fileDeny}`);
}

/** Архив и возврат из архива в списке: агент или окружение. */
async function archiveRoundTrip({ kind, link, name, id, path, dialogTitle, checkPrefix, feature }) {
  await openSection(link);
  await rowOf(name).first().waitFor();
  await shot(`${kind}-list`);
  await (await rowMenu(name, "В архив")).click();
  const dialog = await dangerDialog(dialogTitle);
  const dialogText = plain(await dialog.textContent());
  await shot(`${kind}-archive-dialog`);
  await dialog.getByRole("button", { name: "В архив", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  await rowOf(name).first().waitFor({ state: "detached", timeout: 15_000 });
  await shot(`${kind}-archived`);
  const archived = await api("GET", `${path}/${id}`);
  saveJson(`${kind}-archived`, archived);
  await check(`${checkPrefix}_archive`, `${link}: пункт «В архив» в меню строки, окно «${dialogTitle}» со строкой «Можно вернуть из архива», после подтверждения строка ушла из активных, archived_at в API`, () => {
    assert(dialogText.includes("Можно вернуть из архива"), `текст окна «${dialogText.slice(0, 200)}»`);
    assert(archived.archived_at, `archived_at ${archived.archived_at}`);
    return `archived_at ${archived.archived_at}`;
  });
  await setStatusFilter("В архиве");
  const archivedRow = rowOf(name).first();
  await archivedRow.waitFor({ timeout: 15_000 });
  const badge = plain(await archivedRow.textContent());
  await shot(`${kind}-archived-filter`);
  await (await rowMenu(name, "Вернуть из архива")).click();
  const restored = await waitFor(`${kind} вернулся из архива`, async () => {
    const now = await api("GET", `${path}/${id}`);
    return now.archived_at ? undefined : now;
  }, 15_000, 300);
  await setStatusFilter("Активные");
  await rowOf(name).first().waitFor({ timeout: 15_000 });
  await shot(`${kind}-restored`);
  saveJson(`${kind}-restored`, restored);
  await check(`${checkPrefix}_unarchive`, `${link}: фильтр «Статус: В архиве» показывает строку с меткой «В архиве», пункт «Вернуть из архива» снимает archived_at, строка снова в активных`, () => {
    assert(badge.includes("В архиве"), `строка «${badge.slice(0, 160)}»`);
    assert(restored.archived_at === null || restored.archived_at === undefined, `archived_at ${restored.archived_at}`);
    return `archived_at ${restored.archived_at ?? null}`;
  });
  cover(feature);
}

async function stepAgentArchive() {
  await archiveRoundTrip({
    kind: "agent", link: "Агенты", name: names.agent, id: ids.agent, path: "/v1/agents",
    dialogTitle: "Отправить агента в архив?", checkPrefix: "crud.agent", feature: "crud-agent-archive",
  });
}

async function stepEnvArchive() {
  await archiveRoundTrip({
    kind: "env", link: "Окружения", name: names.env, id: ids.env, path: "/v1/environments",
    dialogTitle: "Отправить окружение в архив?", checkPrefix: "crud.env", feature: "crud-env-archive",
  });
}

async function stepEnvDelete() {
  const title = `Удалить окружение «${names.envDel}»?`;
  await openSection("Окружения");
  await (await rowMenu(names.envDel, "Удалить")).click();
  let dialog = await dangerDialog(title);
  const blocking = dialog.getByRole("region", { name: "Мешает" });
  await blocking.waitFor({ timeout: 15_000 }).catch(() => {});
  const blockingText = plain(await blocking.textContent().catch(() => ""));
  const confirmDisabled = await dialog.getByRole("button", { name: "Удалить", exact: true }).isDisabled();
  const alertText = plain(await dialog.getByRole("alert").first().textContent().catch(() => ""));
  await shot("env-delete-blocked");
  await aria("env-delete-blocked", dialog);
  const refused = await apiRaw("DELETE", `/v1/environments/${ids.envDel}`);
  saveJson("env-delete-409", { status: refused.status, body: refused.json });
  const still = await apiRaw("GET", `/v1/environments/${ids.envDel}`);
  await check("crud.env_delete_blocked", "окружение с живой сессией: окно удаления показывает «Мешает» с этой сессией и выключает «Удалить»; DELETE отвечает 409 dependency_conflict_error со списком, окружение на месте", () => {
    assert(blockingText.includes(names.sessionDel) || blockingText.includes(ids.sessionDel), `«Мешает»: «${blockingText.slice(0, 200)}»`);
    assert(confirmDisabled, "кнопка «Удалить» включена");
    assert(/недоступно/.test(alertText), `причина «${alertText}»`);
    assert(refused.status === 409, `DELETE -> ${refused.status}`);
    assert(refused.json?.error?.type === "dependency_conflict_error", `тип ${refused.json?.error?.type}`);
    const rowsBlocking = refused.json?.error?.dependencies?.blocking ?? [];
    assert(rowsBlocking.some((d) => d.kind === "session" && d.id === ids.sessionDel), `blocking ${JSON.stringify(rowsBlocking).slice(0, 200)}`);
    assert(still.status === 200, `GET после отказа -> ${still.status}`);
    return `409, blocking ${rowsBlocking.map((d) => `${d.kind}:${d.id}`).join(", ")}`;
  });
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });

  // Остановка: сессия уходит в архив из списка сессий.
  await openSection("Сессии");
  await (await rowMenu(names.sessionDel, "В архив")).click();
  const sessionDialog = await dangerDialog("Отправить сессию в архив?");
  await shot("session-archive-dialog");
  await sessionDialog.getByRole("button", { name: "В архив", exact: true }).click();
  await sessionDialog.waitFor({ state: "hidden", timeout: 15_000 });
  const sessionNow = await waitFor("сессия в архиве", async () => {
    const s = await api("GET", `/v1/sessions/${ids.sessionDel}`);
    return s.archived_at ? s : undefined;
  }, 15_000, 300);
  await check("crud.session_archive_ui", "«Сессии»: пункт «В архив» и окно «Отправить сессию в архив?» архивируют сессию", () => `archived_at ${sessionNow.archived_at}`);

  await openSection("Окружения");
  await (await rowMenu(names.envDel, "Удалить")).click();
  dialog = await dangerDialog(title);
  const blockingAfter = await dialog.getByRole("region", { name: "Мешает" }).count();
  const enabled = await dialog.getByRole("button", { name: "Удалить", exact: true }).isEnabled();
  const dialogText = plain(await dialog.textContent());
  await shot("env-delete-free");
  await dialog.getByRole("button", { name: "Удалить", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  await rowOf(names.envDel).first().waitFor({ state: "detached", timeout: 15_000 });
  await shot("env-deleted");
  const gone = await apiRaw("GET", `/v1/environments/${ids.envDel}`);
  await check("crud.env_delete_after_stop", "после архива сессии окно удаления без «Мешает», «Удалить» включена, «Это нельзя отменить»; окружение удалено (GET 404), строка ушла", () => {
    assert(blockingAfter === 0, "в окне остался список «Мешает»");
    assert(enabled, "кнопка «Удалить» выключена");
    assert(dialogText.includes("Это нельзя отменить"), `текст окна «${dialogText.slice(0, 200)}»`);
    assert(gone.status === 404, `GET -> ${gone.status}`);
    return "GET 404";
  });
  created.environments = created.environments.filter((e) => e !== ids.envDel);
  saveCreated();

  // Сессия удалённого окружения остаётся в архиве, её тоже можно удалить.
  await openSection("Сессии");
  await setStatusFilter("В архиве");
  await (await rowMenu(names.sessionDel, "Удалить")).click();
  const deleteSession = await dangerDialog(`Удалить сессию «${names.sessionDel}»?`);
  await shot("session-delete-dialog");
  await deleteSession.getByRole("button", { name: "Удалить", exact: true }).click();
  const closed = await deleteSession.waitFor({ state: "hidden", timeout: 15_000 }).then(() => true, () => false);
  const failure = closed ? "" : plain(await deleteSession.getByRole("alert").first().textContent().catch(() => ""));
  if (!closed) await deleteSession.getByRole("button", { name: "Отмена", exact: true }).click().catch(() => {});
  await shot("session-deleted");
  const sessionGone = await apiRaw("GET", `/v1/sessions/${ids.sessionDel}`);
  await check("crud.session_delete_after_env_delete", "архивную сессию удалённого окружения можно удалить: «Сессии», фильтр «В архиве», «Удалить», окно закрылось, GET 404", () => {
    assert(closed, `окно не закрылось: «${failure.slice(0, 200)}»`);
    assert(sessionGone.status === 404, `GET -> ${sessionGone.status}`);
    return "GET 404";
  });
  if (sessionGone.status === 404) {
    created.sessions = created.sessions.filter((x) => x !== ids.sessionDel);
    saveCreated();
  }
  cover("crud-env-delete");
}

async function stepDeployment() {
  await openSection("Агенты");
  await (await rowMenu(names.agent, "Создать деплоймент")).click();
  await page.waitForURL((url) => url.pathname === "/deployments/new" && url.searchParams.get("agent") === ids.agent, { timeout: 15_000 });
  await page.locator("#deployment-name").fill(names.deployment);
  const agentBox = main().getByRole("combobox").nth(0);
  const envBox = main().getByRole("combobox").nth(1);
  await agentBox.filter({ hasText: ids.agent }).waitFor({ timeout: 15_000 });
  await envBox.click();
  const envItem = page.locator('[data-slot="command-item"]').filter({ hasText: ids.env }).first();
  await envItem.waitFor({ timeout: 15_000 });
  await envItem.click();
  await envBox.filter({ hasText: ids.env }).waitFor({ timeout: 10_000 });
  await page.locator("#deployment-message").fill(`Запуск деплоймента vc-${nonce}`);
  await shot("deployment-form");
  await main().getByRole("button", { name: "Создать", exact: true }).click();
  await page.waitForURL((url) => /^\/deployments\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/new"), { timeout: 20_000 });
  ids.deployment = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  await main().getByRole("heading", { level: 1 }).filter({ hasText: names.deployment }).waitFor();
  await shot("deployment-created");
  const createdDep = await api("GET", `/v1/deployments/${ids.deployment}`);
  saveJson("deployment-created", createdDep);
  const header = plain(await main().getByRole("heading", { level: 1 }).first().textContent());
  const runButton = main().getByRole("button", { name: "Запустить", exact: true });
  const runDisabledWhenPaused = await runButton.isDisabled().catch(() => false);
  await check("crud.deployment_created_paused", "«Создать деплоймент» в меню агента открывает форму с агентом, «Создать» даёт деплоймент на паузе с этим агентом, окружением и сообщением", () => {
    assert(createdDep.status === "paused", `status ${createdDep.status}`);
    assert(createdDep.agent?.id === ids.agent && createdDep.environment_id === ids.env, `агент ${createdDep.agent?.id}, окружение ${createdDep.environment_id}`);
    assert(JSON.stringify(createdDep.initial_events ?? []).includes(`vc-${nonce}`), "нет начального сообщения");
    assert(header.includes("На паузе"), `заголовок «${header}»`);
    return `${ids.deployment} paused`;
  });
  await check("crud.deployment_run_paused_disabled", "у деплоймента на паузе кнопка «Запустить» выключена: сервер запускает только активный деплоймент", () => {
    assert(runDisabledWhenPaused, "кнопка «Запустить» включена у деплоймента на паузе, клик даст 409 «is not active»");
    return "выключена";
  });

  await main().getByRole("button", { name: "Продолжить", exact: true }).click();
  const active = await waitFor("деплоймент активен", async () => {
    const d = await api("GET", `/v1/deployments/${ids.deployment}`);
    return d.status === "active" ? d : undefined;
  }, 15_000, 300);
  await main().getByRole("button", { name: "Пауза", exact: true }).waitFor();
  await shot("deployment-active");
  await runButton.click();
  const runs = await waitFor("прогон деплоймента", async () => {
    const r = await api("GET", `/v1/deployment_runs?deployment_id=${encodeURIComponent(ids.deployment)}`);
    const list = r.data ?? [];
    return list.length > 0 && list.every((x) => x.session_id || x.error) ? list : undefined;
  }, 30_000, 500);
  saveJson("deployment-runs", runs);
  for (const r of runs) if (r.session_id && !created.sessions.includes(r.session_id)) created.sessions.push(r.session_id);
  saveCreated();
  await main().getByRole("tab", { name: "Прогоны" }).click();
  const runRow = main().locator("table tbody tr").first();
  await runRow.waitFor({ timeout: 15_000 });
  const runRowText = plain(await runRow.textContent());
  await shot("deployment-runs");
  await check("crud.deployment_run", "«Продолжить» делает деплоймент активным, «Запустить» создаёт прогон с сессией, вкладка «Прогоны» показывает его", () => {
    assert(active.status === "active", `status ${active.status}`);
    assert(runs.length === 1, `прогонов ${runs.length}`);
    assert(runs[0].session_id && !runs[0].error, `прогон ${JSON.stringify(runs[0]).slice(0, 200)}`);
    assert(runRowText.includes("Создана сессия"), `строка «${runRowText.slice(0, 160)}»`);
    return `прогон ${runs[0].id}, сессия ${runs[0].session_id}`;
  });

  await main().getByRole("button", { name: "Пауза", exact: true }).click();
  const paused = await waitFor("деплоймент на паузе", async () => {
    const d = await api("GET", `/v1/deployments/${ids.deployment}`);
    return d.status === "paused" ? d : undefined;
  }, 15_000, 300);
  await main().getByRole("button", { name: "Продолжить", exact: true }).waitFor();
  await shot("deployment-paused");
  await check("crud.deployment_pause", "«Пауза» ставит деплоймент на паузу, причина «вручную»", () => {
    assert(paused.paused_reason?.type === "manual", `paused_reason ${JSON.stringify(paused.paused_reason)}`);
    return "paused, manual";
  });

  await main().getByRole("button", { name: "В архив", exact: true }).click();
  const dialog = await dangerDialog("Отправить деплоймент в архив?");
  await shot("deployment-archive-dialog");
  await dialog.getByRole("button", { name: "В архив", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  await main().getByRole("button", { name: "Вернуть из архива", exact: true }).waitFor({ timeout: 15_000 });
  await shot("deployment-archived");
  const archivedDep = await api("GET", `/v1/deployments/${ids.deployment}`);
  saveJson("deployment-archived", archivedDep);
  await openSection("Деплойменты");
  await main().getByRole("heading", { level: 1, name: "Деплойменты", exact: true }).waitFor();
  // Список деплойментов по умолчанию показывает все статусы, архивная строка помечена «В архиве».
  const listedRow = rowOf(names.deployment).first();
  await listedRow.waitFor({ timeout: 15_000 });
  const listedText = plain(await listedRow.textContent());
  await shot("deployments-list");
  await check("crud.deployment_archive", "«В архив» с окном подтверждения архивирует деплоймент, на карточке остаётся «Вернуть из архива», в списке «Деплойменты» строка со статусом «В архиве»", () => {
    assert(archivedDep.archived_at, `archived_at ${archivedDep.archived_at}`);
    assert(listedText.includes("В архиве"), `строка «${listedText.slice(0, 160)}»`);
    return `archived_at ${archivedDep.archived_at}`;
  });
  cover("crud-deployments");
}

async function stepFiles() {
  await openSection("Файлы");
  const content = `Загружено со страницы «Файлы» vc-${nonce}\n`;
  const chooserPromise = page.waitForEvent("filechooser");
  await main().getByRole("button", { name: "Загрузить", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: names.upload, mimeType: "text/plain", buffer: Buffer.from(content, "utf8") });
  await rowOf(names.upload).first().waitFor({ timeout: 20_000 });
  await shot("file-uploaded");
  const list = await api("GET", "/v1/files?limit=100");
  const uploaded = (list.data ?? []).find((f) => f.filename === names.upload);
  ids.upload = uploaded?.id;
  await check("crud.file_upload", "«Файлы»: «Загрузить» и выбор файла дают строку с именем, файл в GET /v1/files с тем же размером", () => {
    assert(uploaded, "файла нет в API");
    assert(uploaded.size_bytes === Buffer.byteLength(content, "utf8"), `размер ${uploaded.size_bytes}`);
    return `${uploaded.id}, ${uploaded.size_bytes} Б`;
  });
  await (await rowMenu(names.upload, "Удалить")).click();
  const dialog = await dangerDialog(`Удалить файл «${names.upload}»?`);
  const dialogText = plain(await dialog.textContent());
  await shot("file-delete-dialog");
  await dialog.getByRole("button", { name: "Удалить", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
  await rowOf(names.upload).first().waitFor({ state: "detached", timeout: 15_000 });
  await shot("file-deleted");
  const gone = ids.upload ? await apiRaw("GET", `/v1/files/${ids.upload}`) : { status: 0 };
  await check("crud.file_delete", "пункт «Удалить» и окно «Удалить файл …?» со строкой «Это нельзя отменить» удаляют файл: строка ушла, GET 404", () => {
    assert(dialogText.includes("Это нельзя отменить"), `текст окна «${dialogText.slice(0, 200)}»`);
    assert(gone.status === 404, `GET -> ${gone.status}`);
    return "GET 404";
  });
  cover("crud-files");
}

async function stepInstall() {
  await openSection("Агенты");
  await page.keyboard.press("Control+i");
  await panel().waitFor({ timeout: 15_000 });
  await panel().getByText("Ассистента здесь ещё нет").waitFor({ timeout: 20_000 });
  await panel().locator("select").first().selectOption(names.card);
  await panel().getByRole("button", { name: "Установить", exact: true }).click();
  const box = panel().getByRole("textbox", { name: "Сообщение ассистенту" });
  await waitFor("поле ввода включено", async () => (await box.isEnabled()) || undefined, 30_000, 300);
  const agents = await api("GET", "/v1/agents?limit=100");
  const builder = (agents.data ?? []).find((a) => a.metadata?.oma_role === "builder");
  assert(builder, "после установки нет агента с oma_role: builder");
  created.agents.push(builder.id);
  const toolNames = JSON.stringify(builder.tools ?? []);
  await check("crud.assistant_install", "помощник установлен с карточкой фейка, в его наборе есть archive_object, delete_object и get_dependencies", () => {
    for (const tool of ["archive_object", "delete_object", "get_dependencies"]) {
      if (toolNames.includes('"configs"')) assert(!new RegExp(`"name":"${tool}","enabled":false`).test(toolNames), `${tool} выключен в наборе`);
    }
    return `агент ${builder.id} v${builder.version}`;
  });
}

async function stepAssistantDanger() {
  await page.goto(`${BASE}/sessions`);
  await main().getByRole("heading", { level: 1, name: "Сессии", exact: true }).waitFor();
  await openPanel();
  await newConversation();
  const first = await sendPanel([`VERIFY_BUILDER_CRUD nonce=${nonce}`, `Сессия: ${ids.sessionX}`, `Файл: ${ids.fileX}`, "Отправь сессию в архив и удали файл."].join("\n"));
  const sid = first.sid;
  ids.chat = sid;
  const archiveCard = card("archive_object");
  await cardReady(archiveCard);
  const archiveUse = mcpUses(first.events, "archive_object")[0];
  const depsRead = mcpUses(first.events, "get_dependencies").length;
  await sleep(3000);
  const sessionBefore = await api("GET", `/v1/sessions/${ids.sessionX}`);
  await shot("assistant-archive-card");
  await aria("assistant-archive-card", archiveCard);
  const archiveText = plain(await archiveCard.textContent());
  const archiveHeading = plain(await archiveCard.getByRole("heading").first().textContent());
  const archivePreview = previews.filter((p) => p.tool_use_id === archiveUse?.id).pop()?.body;
  await check("crud.assistant_archive_card", "ход помощника: get_dependencies, затем archive_object ждёт клика (requires_action); красная карточка «Архивировать сессию …» с меткой «Опасное», строкой «Объект можно вернуть из архива» и кнопкой «В архив»; до клика сессия не в архиве", async () => {
    assert(depsRead === 1, `get_dependencies до карточки ${depsRead}`);
    assert(first.stop?.type === "requires_action" && archiveUse && first.stop.event_ids?.includes(archiveUse.id), `stop ${JSON.stringify(first.stop)}`);
    assert((await archiveCard.getAttribute("data-danger")) === "true", "карточка не красная (нет data-danger)");
    assert(archiveHeading.startsWith("Архивировать сессию"), `заголовок «${archiveHeading}»`);
    assert(archiveText.includes("Опасное") && archiveText.includes("Объект можно вернуть из архива"), `текст «${archiveText.slice(0, 240)}»`);
    assert(await archiveCard.getByRole("button", { name: "В архив", exact: true }).isEnabled(), "кнопка «В архив» выключена");
    assert(archivePreview?.class === "danger", `класс preview ${archivePreview?.class}`);
    assert(!sessionBefore.archived_at, "сессия в архиве до клика");
    return `tool_use ${archiveUse.id}, класс ${archivePreview.class}`;
  });

  const direct = await apiRaw("POST", `/v1/sessions/${sid}/events`, { events: [{ type: "user.tool_confirmation", tool_use_id: archiveUse.id, result: "allow" }] });
  const afterDirect = await api("GET", `/v1/sessions/${ids.sessionX}`);
  await check("crud.assistant_no_click_refused", "подтверждение без карточки (прямой user.tool_confirmation allow) даёт 403 «Подтверждайте через карточку», сессия не в архиве", async () => {
    assert(direct.status === 403, `код ${direct.status}`);
    assert(direct.text.includes("Подтверждайте через карточку"), direct.text.slice(0, 200));
    assert(!afterDirect.archived_at, "сессия ушла в архив без клика");
    assert(!mcpResult(await listEvents(sid), archiveUse.id), "вызов исполнен");
    return "403";
  });

  const second = await clickAndWait(sid, archiveCard, "В архив");
  const sessionAfter = await api("GET", `/v1/sessions/${ids.sessionX}`);
  const deleteCard = card("delete_object");
  await cardReady(deleteCard);
  const deleteUse = mcpUses(second.events, "delete_object")[0];
  const fileBefore = await apiRaw("GET", `/v1/files/${ids.fileX}`);
  await shot("assistant-delete-card");
  await aria("assistant-delete-card", deleteCard);
  const deleteText = plain(await deleteCard.textContent());
  const deleteHeading = plain(await deleteCard.getByRole("heading").first().textContent());
  await check("crud.assistant_archive_applied", "после «В архив» сессия в архиве, результат вызова без ошибки, карточка в состоянии «применено»", async () => {
    assert(sessionAfter.archived_at, "сессия не в архиве");
    const res = mcpResult(second.events, archiveUse.id);
    assert(res && res.is_error !== true, `результат ${textOf(res?.content).slice(0, 200)}`);
    assert(await panel().locator(`article.assistant-card[data-tool="archive_object"][data-phase="applied"]`).count(), "карточка не «применено»");
    return `archived_at ${sessionAfter.archived_at}`;
  });
  await check("crud.assistant_delete_card", "следующий вызов delete_object: красная карточка «Удалить файл …» со строкой «Это нельзя отменить» и кнопкой «Удалить»; до клика файл на месте", async () => {
    assert(deleteUse && second.stop?.type === "requires_action", `stop ${JSON.stringify(second.stop)}`);
    assert((await deleteCard.getAttribute("data-danger")) === "true", "карточка не красная");
    assert(deleteHeading.startsWith("Удалить файл"), `заголовок «${deleteHeading}»`);
    assert(deleteText.includes("Это нельзя отменить"), `текст «${deleteText.slice(0, 240)}»`);
    assert(await deleteCard.getByRole("button", { name: "Удалить", exact: true }).isEnabled(), "кнопка «Удалить» выключена");
    assert(fileBefore.status === 200, `файл до клика: ${fileBefore.status}`);
    return `tool_use ${deleteUse.id}`;
  });

  const third = await clickAndWait(sid, deleteCard, "Удалить");
  const fileAfter = await apiRaw("GET", `/v1/files/${ids.fileX}`);
  const applied = panel().locator(`article.assistant-card[data-tool="delete_object"][data-phase="applied"]`);
  await applied.waitFor({ timeout: 15_000 });
  const appliedText = plain(await applied.textContent());
  await shot("assistant-delete-applied");
  const rowsLog = await actions(sid);
  saveJson("assistant-actions", rowsLog);
  await check("crud.assistant_delete_applied", "после «Удалить» файл удалён (GET 404), карточка «Удалено: файл …», ответ помощника VERIFY_BUILDER_CRUD_DONE, в журнале две строки ok", () => {
    assert(fileAfter.status === 404, `GET -> ${fileAfter.status}`);
    assert(appliedText.includes("Удалено: файл"), `карточка «${appliedText.slice(0, 200)}»`);
    const final = lastAgentText(third.events);
    assert(final.includes(`VERIFY_BUILDER_CRUD_DONE_${nonce}`), `ответ «${final.slice(0, 200)}»`);
    const done = rowsLog.filter((r) => ["archive_object", "delete_object"].includes(r.tool)).map((r) => `${r.tool}:${r.result}`);
    assert(done.includes("archive_object:ok") && done.includes("delete_object:ok"), `журнал ${done.join(",")}`);
    return done.join(", ");
  });
  cover("crud-assistant-danger");
}

async function stepAssistantDeny() {
  await newConversation();
  const turn = await sendPanel([`VERIFY_BUILDER_CRUDDENY nonce=${nonce}`, `Файл: ${ids.fileDeny}`].join("\n"));
  const sid = turn.sid;
  const c = card("delete_object");
  await cardReady(c);
  const use = mcpUses(turn.events, "delete_object")[0];
  await sleep(5000);
  const waiting = await apiRaw("GET", `/v1/files/${ids.fileDeny}`);
  await shot("assistant-deny-card");
  const before = (await listEvents(sid)).length;
  await c.getByRole("button", { name: "Отклонить", exact: true }).click();
  const after = await waitIdle(sid, before);
  const denied = panel().locator(`article.assistant-card[data-tool="delete_object"][data-phase="denied"]`);
  await denied.waitFor({ timeout: 15_000 });
  await shot("assistant-deny-done");
  const still = await apiRaw("GET", `/v1/files/${ids.fileDeny}`);
  const rowsLog = (await actions(sid)).filter((r) => r.tool_use_id === use?.id);
  await check("crud.assistant_deny", "карточка удаления без клика 5 с: файл на месте; «Отклонить»: файл на месте, результат вызова is_error, строка журнала denied, карточка «Отклонено»", () => {
    assert(use, "вызова delete_object нет");
    assert(waiting.status === 200, `файл без клика: ${waiting.status}`);
    assert(still.status === 200, `файл после отказа: ${still.status}`);
    const res = mcpResult(after.events, use.id);
    assert(res?.is_error === true, `is_error ${res?.is_error}`);
    assert(rowsLog.map((r) => r.result).join() === "denied", `журнал ${rowsLog.map((r) => r.result).join()}`);
    return textOf(res.content).slice(0, 80);
  });
  cover("crud-assistant-deny");
}

// -------------------------------------------------------------------- итог ---
function featureEntries() {
  const dir = join(SKILL_DIR, "features");
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    if (!text.includes("<!-- scenario: crud -->")) continue;
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
  const features = featureEntries();
  const uncovered = features.filter((f) => !covered.has(f.id));
  const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# verify-agent-console: сценарий crud (правка, архив и удаление), прогон ${run.RUN_ID}`,
    "",
    `Итог: ${abortError ? "ПРЕРВАН" : failed.length ? "ПРОВАЛ" : "ПРОЙДЕН"} (проверок: ${checks.length}, провалов: ${failed.length}, подфункций сценария пройдено ${features.length - uncovered.length} из ${features.length}).`,
    abortError ? `Сценарий прерван: ${plain(abortError.message)}` : "",
    "",
    "## Экземпляр",
    "",
    `- URL: ${BASE}, фейк ${run.FAKE_URL}, git ${run.GIT_REV}; хэши изменений: консоль ${run.CONSOLE_TREE_HASH}, сервер ${run.SERVER_TREE_HASH}`,
    `- учётка ${user.email}, пространство ${user.tenant_id}; nonce ${nonce}, карточка модели ${names.card}`,
    `- агент ${ids.agent ?? "нет"}, окружения ${ids.env ?? "нет"} и ${ids.envDel ?? "нет"} (удалено), сессии ${ids.sessionDel ?? "нет"} и ${ids.sessionX ?? "нет"}, деплоймент ${ids.deployment ?? "нет"}, разговор помощника ${ids.chat ?? "нет"}`,
    "",
    "## Проверки",
    "",
    "| Проверка | Что доказывает | Статус | Доказательство |",
    "|---|---|---|---|",
    ...checks.map((c) => `| ${c.id} | ${cell(c.title)} | ${c.status} | ${cell([c.evidence, c.note].filter(Boolean).join("; "))} |`),
    "| crud.seed_path | исходные объекты создаются по API: их создание через консоль проверяют сценарии env-to-agent и builder | не проверено | нет |",
    ...uncovered.map((f) => `| feature.${f.id} | ${cell(f.desc)} | не проверено | рецепт: features/${f.file} |`),
    "",
    "## Скриншоты",
    "",
    ...screens.map((s) => `- ${s.file} (sha256 ${s.sha.slice(0, 12)}${s.tall ? `, высота ${s.tall}` : ""})`),
    "",
    "## Повтор",
    "",
    "RUN=\"$(scripts/launch.sh)\" && { scripts/doctor.sh --run \"$RUN\" && scripts/seed-user.sh --run \"$RUN\" && scripts/journey.sh --run \"$RUN\" --scenario crud; scripts/cleanup.sh --run \"$RUN\"; } (папка .claude/skills/verify-agent-console).",
    "",
  ];
  writeFileSync(join(EV, "summary.md"), lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n"));
}

function copyLogs() {
  for (const [from, to] of [
    [run.SERVER_LOG, "logs/main-node.journey.log"],
    [run.FAKE_LOG, "logs/fake-model.log"],
    [run.FAKE_REQUESTS, "logs/fake-model-requests.jsonl"],
  ]) if (from && existsSync(from)) copyFileSync(from, join(EV, to));
}

let abortError = null;
log(`прогон ${run.RUN_ID}, сценарий crud, nonce ${nonce}, доказательства ${EV}`);
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
  const failedSteps = new Set();
  for (const [name, fn, critical, needs = []] of [
    ["вход", stepLogin, true],
    ["исходные объекты", stepSeed, true],
    ["архив агента", stepAgentArchive, false],
    ["архив окружения", stepEnvArchive, false],
    ["удаление окружения", stepEnvDelete, false],
    ["деплоймент", stepDeployment, false],
    ["файлы", stepFiles, false],
    ["установка помощника", stepInstall, false],
    ["помощник: архив и удаление", stepAssistantDanger, false, ["установка помощника"]],
    ["помощник: отказ", stepAssistantDeny, false, ["установка помощника"]],
  ]) {
    const missing = needs.filter((need) => failedSteps.has(need));
    if (missing.length > 0) {
      failedSteps.add(name);
      record(`crud.step_skipped.${name.replace(/[\s:]+/g, "_")}`, `шаг «${name}»`, "не проверено", "", `не выполнен шаг: ${missing.join(", ")}`);
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
      record(`crud.step_failed.${name.replace(/[\s:]+/g, "_")}`, `шаг «${name}» выполнен до конца`, "провал", "", error.message);
      await shot(`fail-step-${name.replace(/[\s:]+/g, "-")}`).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.setViewportSize(VIEW).catch(() => {});
    }
  }
} catch (error) {
  abortError = error;
  record("crud.abort", "сценарий дошёл до конца", "провал", "", error.message);
  if (page) await shot("abort").catch(() => {});
} finally {
  record("crud.screens_distinct", "скриншоты соседних шагов различаются (sha256)",
    duplicateShots.length === 0 ? "проверено" : "провал", `скриншотов ${screens.length}`,
    duplicateShots.length === 0 ? "" : `совпали: ${duplicateShots.join("; ")}`);
  copyLogs();
  writeSummary(abortError);
  await browser?.close().catch(() => {});
}
const failedCount = checks.filter((c) => c.status === "провал").length;
log(`итог: ${abortError ? "ПРЕРВАН" : failedCount ? "ПРОВАЛ" : "ПРОЙДЕН"}, ${join(EV, "summary.md")}`);
process.exit(failedCount ? 1 : 0);
