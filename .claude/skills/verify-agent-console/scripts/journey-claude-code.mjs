#!/usr/bin/env node
// Сценарий «Claude Code в песочнице» verify-agent-console (Playwright, консоль на русском):
//   вход → окружение с npm-пакетом @agentclientprotocol/claude-agent-acp (консоль) →
//   хранилище с учётными данными «переменная окружения» (API: в консоли такого типа нет) →
//   агент на harness acp-sandbox с ACP-агентом claude-acp (консоль, YAML) → сессия с этим
//   окружением и хранилищем (консоль) → ход: Claude Code внутри VM LiteBox пишет и читает
//   verify.txt в рабочей папке (= /mnt/session/outputs), Bash без разрешения отклоняется →
//   доказательства (события, поток, выводы, файл на хосте, VM, журнал модели) → второй ход:
//   ps в VM (ACP-сессия возобновлена, в VM один claude-agent-acp, на хосте его нет) → архив.
// Модель: режим fake (по умолчанию): Claude Code в VM ходит в fake-model.mjs хоста через
//   ANTHROPIC_BASE_URL=http://host.boxlite.internal:<порт фейка>, ключ фиктивный и лежит в хранилище.
//   Режим real (VERIFY_CC_MODE=real) только явно: настоящий ключ или токен подписки из файла
//   VERIFY_CC_SECRET_FILE кладётся в хранилище, базовый URL не задаётся. Сейчас не запускался.
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
// Хост из VM BoxLite: gvproxy отвечает на host.boxlite.internal адресом 192.168.127.254
// и пересылает его на 127.0.0.1 хоста (проверено 2026-10-16), поэтому фейку хватает 127.0.0.1.
const FAKE_URL_VM = `http://host.boxlite.internal:${run.VERIFY_FAKE_PORT}`;
// Версия закреплена: пакет ставится из npm при каждом старте VM, и новый релиз Claude Code
// не должен менять сценарий. 0.91.0 прошла в прогоне 20261016-012333.
const CC_PACKAGE = "@agentclientprotocol/claude-agent-acp@0.91.0";
const WORKDIR = "/mnt/session/outputs";
// Обёртка запуска: пишет настройки Claude Code (только список allow, без режима обхода)
// в его CLAUDE_CONFIG_DIR, который задаёт профиль claude-code (acp-runtime/native-state.ts),
// и заменяет себя на claude-agent-acp.
const CLAUDE_WRAPPER = 'mkdir -p "$CLAUDE_CONFIG_DIR" && printf \'%s\' "$OMA_CLAUDE_SETTINGS" > "$CLAUDE_CONFIG_DIR/settings.json" && exec claude-agent-acp';
// Bash(ps:*) нужен второму ходу (процессы VM); контрольный touch по-прежнему вне списка.
const CLAUDE_SETTINGS = { permissions: { allow: ["Read", "Write", "Edit", "Bash(ps:*)"] } };

const newNonce = () => randomBytes(4).toString("hex");
const nonce = newNonce();
const names = {
  env: `verify-cc-env-${nonce}`,
  vault: `verify-cc-vault-${nonce}`,
  agent: `verify-cc-agent-${nonce}`,
  session: `verify-cc-session-${nonce}`,
};
const ids = {};
const created = { sessions: [], agents: [], environments: [], vaults: [] };
const covered = new Set();
const cover = (...list) => list.forEach((id) => covered.add(id));

// Секрет для хранилища. fake: одноразовый фиктивный ключ. real: файл владельца (не ~/.claude).
// Читается в начале сценария (внутри try), значение не печатается и уходит только в API хранилища.
let secret = { name: "—", value: "" };
const loadSecret = () => {
  if (FAKE) return { name: "ANTHROPIC_API_KEY", value: `verify-cc-fake-key-${nonce}` };
  const file = process.env.VERIFY_CC_SECRET_FILE ?? "";
  const name = process.env.VERIFY_CC_SECRET_NAME ?? "CLAUDE_CODE_OAUTH_TOKEN";
  if (!["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].includes(name)) {
    throw new Error("VERIFY_CC_SECRET_NAME: ANTHROPIC_API_KEY или CLAUDE_CODE_OAUTH_TOKEN");
  }
  if (!file) throw new Error("VERIFY_CC_MODE=real: задайте VERIFY_CC_SECRET_FILE (файл с ключом или токеном claude setup-token, права 600)");
  const abs = resolve(file);
  if (abs.startsWith(join(os.homedir(), ".claude"))) throw new Error("учётные данные Claude Code из ~/.claude не используются: сохраните токен в отдельный файл");
  if ((statSync(abs).mode & 0o077) !== 0) throw new Error(`${abs}: права шире 600`);
  const value = readFileSync(abs, "utf8").trim();
  if (!value || value.includes("\n")) throw new Error(`${abs}: нужен один ключ или токен одной строкой`);
  return { name, value };
};
const sha12 = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);

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
function fakeRequests() {
  if (!existsSync(run.FAKE_REQUESTS)) return [];
  return readFileSync(run.FAKE_REQUESTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.nonce === nonce);
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
  const credential = await api("POST", `/v1/vaults/${ids.vault}/credentials`, {
    display_name: `Claude Code: ${secret.name}`,
    auth: { type: "environment_variable", secret_name: secret.name, secret_value: secret.value, networking: { type: "unrestricted" } },
  });
  saveJson("20-vault-credential", credential);
  const ok_cc_vault = await check("cc.vault_secret", `в хранилище есть учётные данные «переменная окружения» ${secret.name}, значение API не отдаёт`, () => {
    assert(credential.auth?.type === "environment_variable", `auth.type ${credential.auth?.type}`);
    assert(credential.auth?.secret_name === secret.name, `secret_name ${credential.auth?.secret_name}`);
    assert(!JSON.stringify(credential).includes(secret.value), "значение секрета вернулось в ответе API");
    return "api/cc-20-vault-credential.json";
  });
  record("cc.vault_api_path", "учётные данные «переменная окружения» созданы через API", "внимание", "",
    "в консоли (pages/VaultDetail.tsx) нет формы для типа environment_variable, только MCP-сервер и CLI; хранилище видно в консоли и выбирается в окне «Новая сессия»");
  await page.goto(`${BASE}/vaults/${ids.vault}`);
  await page.getByRole("heading", { level: 1, name: names.vault }).first().waitFor();
  await page.getByText(secret.name).first().waitFor({ timeout: 15_000 });
  await shot("vault-detail");
  if (ok_cc_vault) cover("cc-vault");
}

function agentYaml() {
  const q = (value) => JSON.stringify(value);
  const env = {
    ...(FAKE ? { ANTHROPIC_BASE_URL: FAKE_URL_VM } : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    OMA_CLAUDE_SETTINGS: JSON.stringify(CLAUDE_SETTINGS),
  };
  return [
    `name: ${names.agent}`,
    `model: ${MODEL}`,
    `description: ${q("Claude Code (claude-agent-acp) внутри песочницы LiteBox")}`,
    `system: ${q("Агент на Claude Code. Работай в рабочей папке сессии.")}`,
    "_oma:",
    "  harness: acp-sandbox",
    "  acp:",
    "    agent:",
    "      id: claude-acp",
    "      command: sh",
    "      args:",
    `        - ${q("-c")}`,
    `        - ${q(CLAUDE_WRAPPER)}`,
    `      cwd: ${WORKDIR}`,
    "      env:",
    ...Object.entries(env).map(([k, v]) => `        ${k}: ${q(v)}`),
    "    per_turn_timeout_ms: 600000",
    "",
  ].join("\n");
}

async function stepAgent() {
  await openSection("Агенты", "Агентов пока нет");
  await page.getByRole("button", { name: "Новый агент" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новый агент" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: /^Пустой агент/ }).click();
  await dialog.getByRole("group", { name: "Режим правки" }).getByRole("button", { name: "YAML", exact: true }).click();
  const editor = dialog.getByRole("textbox", { name: "Конфигурация агента в формате YAML" });
  const yamlText = agentYaml();
  await editor.fill(yamlText);
  writeFileSync(join(EV, "api", "cc-30-agent-create.yaml"), yamlText);
  await shot("agent-yaml");
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
  await aria("agent-detail");
  const agent = await api("GET", `/v1/agents/${ids.agent}`);
  saveJson("31-agent", agent);
  const ok_cc_agent = await check("cc.agent_harness", "агент из консоли: harness acp-sandbox, ACP-агент claude-acp, рабочая папка /mnt/session/outputs", () => {
    const acp = agent._oma?.acp?.agent;
    assert(agent._oma?.harness === "acp-sandbox", `_oma.harness ${agent._oma?.harness}`);
    assert(acp?.id === "claude-acp", `_oma.acp.agent.id ${acp?.id}`);
    assert(acp?.cwd === WORKDIR, `cwd ${acp?.cwd}`);
    return "api/cc-31-agent.json, api/cc-30-agent-create.yaml";
  });
  await check("cc.agent_no_secret", "в конфигурации агента нет ключа и режима обхода разрешений", () => {
    const text = JSON.stringify(agent);
    assert(!text.includes(secret.value), "значение секрета есть в агенте");
    assert(!/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/.test(JSON.stringify(agent._oma?.acp?.agent?.env ?? {})), "переменная ключа задана в env агента");
    assert(!/bypassPermissions|dangerously/i.test(text), "в агенте есть bypassPermissions/dangerously");
    return "api/cc-31-agent.json";
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
  await check("cc.ui_tool_cards", "в ходе видны карточки инструментов Claude Code Write и Read", async () => {
    const reasoning = article.locator("[data-chat-reasoning-trigger]").first();
    if ((await reasoning.count()) && (await reasoning.getAttribute("aria-expanded")) !== "true") await reasoning.click();
    const group = article.getByRole("button", { name: /^Использован[о]? \d+ инструмент/ }).first();
    if (await group.count()) await group.click();
    for (const kind of ["Write", "Read"]) {
      await article.locator('[data-slot="collapsible-trigger"]', { hasText: kind }).first().waitFor({ timeout: 15_000 });
    }
    const readTrigger = article.locator('[data-slot="collapsible-trigger"]', { hasText: "Read" }).first();
    if ((await readTrigger.getAttribute("data-state")) !== "open") await readTrigger.click();
    await article.locator('[data-slot="collapsible-content"]', { hasText: "VERIFY_OK" }).first().waitFor({ timeout: 15_000 });
    return shot("turn-tool-cards");
  }) && cover("cc-tool-cards");
  if (FAKE) {
    await check("cc.ui_denied_badge", "карточка отклонённого Bash в консоли с бейджем «Ошибка», а не «Готово»", async () => {
      const trigger = article.locator('[data-slot="collapsible-trigger"]', { hasText: "bash-ran-" }).first();
      await trigger.waitFor({ timeout: 15_000 });
      const text = plain(await trigger.textContent());
      assert(text.includes("Ошибка") && !text.includes("Готово"), `заголовок карточки: ${text.slice(0, 160)}`);
      return text.slice(0, 120);
    });
  }
  await check("cc.ui_files", "в панели «Файлы сессии» есть verify.txt", async () => {
    await page.getByRole("button", { name: "Файлы сессии" }).click();
    await page.getByRole("complementary", { name: "Файлы сессии" }).getByRole("link", { name: "verify.txt" }).waitFor({ timeout: 15_000 });
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
    await check("cc.key_from_vault", "ключ в запросах Claude Code взят из хранилища (sha256 совпал), в агенте ключа нет", () => {
      const want = sha12(secret.value);
      const got = [...new Set(reqs.map((r) => r.api_key_sha256))];
      assert(got.length === 1 && got[0] === want, `sha256 ключа в запросах ${got.join(",")}, ожидалось ${want}`);
      return `x-api-key sha256 ${want}`;
    }) && cover("cc-key-vault");
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
  } else {
    record("cc.acp_in_vm_single", "в VM один процесс claude-agent-acp", "не проверено", "",
      "в режиме real вывод Bash Claude Code в событиях не виден (только «(status: completed)»), а журнала фейка нет");
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

async function archiveAndProveStop() {
  const before = boxliteCount("Box stopped");
  const archived = await api("POST", `/v1/sessions/${ids.session}/archive`);
  saveJson("50-session-archived", archived);
  let state = { scratch: scratchDirs(ids.session), stopped: before };
  for (let i = 0; i < 60; i++) {
    state = { scratch: scratchDirs(ids.session), stopped: boxliteCount("Box stopped") };
    if (state.scratch.length === 0 && state.stopped > before) break;
    await sleep(1000);
  }
  const ok_cc_archive = await check("cc.vm_stopped", "после архива сессии VM остановлена (Box stopped) и scratch удалён", () => {
    assert(archived?.archived_at, "archived_at пустой");
    assert(state.stopped > before, `новых «Box stopped» нет (было ${before}, стало ${state.stopped})`);
    assert(state.scratch.length === 0, `scratch остался: ${state.scratch.join(", ")}`);
    return `Box stopped: ${before} → ${state.stopped}`;
  });
  if (ok_cc_archive) cover("cc-archive");
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
      ? [["cc.model_real", "настоящая модель Anthropic не вызывалась: режим fake. Путь с ключом или токеном подписки через хранилище: VERIFY_CC_MODE=real, VERIFY_CC_SECRET_FILE, VERIFY_CC_SECRET_NAME (SKILL.md)"]]
      : [["cc.answer_text", "точный текст ответа настоящей модели и отказ Bash не проверяются, только Write/Read, файл и ответ"]]),
    ["cc.limited_network", "окружение с сетью «Ограниченный» для Claude Code не проверялось (нужны registry.npmjs.org и хост модели)"],
    ["cc.agent_mcp_servers", "MCP-серверы агента в Claude Code (projectAcpSandboxMcpServers) не проверялись"],
    ["cc.system_prompt", "системный промпт агента до Claude Code не доходит: AcpSandboxHarness.onSessionInit пишет /workspace/AGENTS.md, main-node этот хук не вызывает, а Claude Code читает CLAUDE.md; сценарий это не проверяет"],
    ["cc.secret_plain_in_vm", "секрет хранилища лежит в VM открытым текстом в окружении claude-agent-acp и его команд (подстановки на выходе нет). Что default-харнесс (Pi) его не получает, проверяет только тест apps/main-node/test/managed-session-vault-env.test.ts"],
    ...(KEEP_SESSION ? [["cc.vm_stop", "VERIFY_KEEP_SESSION=1: архив сессии и остановка VM не проверялись"]] : []),
  ];
  const features = featureEntries();
  const uncovered = features.filter((f) => !covered.has(f.id));
  const err50 = serverLogLines().filter((l) => l.includes('"level":50')).length;
  const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# verify-agent-console: сценарий Claude Code, прогон ${run.RUN_ID}`,
    "",
    `Итог: ${abortError ? "ПРЕРВАН" : failed.length ? "ПРОВАЛ" : "ПРОЙДЕН"} (проверок: ${checks.length}, провалов: ${failed.length}, подфункций сценария пройдено ${features.length - uncovered.length} из ${features.length}).`,
    abortError ? `Сценарий прерван: ${plain(abortError.message)}` : "",
    "",
    "## Экземпляр",
    "",
    `- URL: ${BASE}, режим Claude Code: ${CC_MODE}${FAKE ? ` (фейк ${run.FAKE_URL}, из VM ${FAKE_URL_VM})` : ""}, модель агента: ${MODEL}, образ: ${run.SANDBOX_IMAGE}, диск VM: ${run.LITEBOX_DISK_SIZE_GB || "по умолчанию"} ГБ`,
    `- git ${run.GIT_REV}, незакоммиченных файлов: консоль ${run.CONSOLE_DIRTY_FILES}, сервер ${run.SERVER_DIRTY_FILES}; хэши изменений: консоль ${run.CONSOLE_TREE_HASH}, сервер ${run.SERVER_TREE_HASH}`,
    `- учётка: ${user.email}, рабочее пространство ${user.tenant_id}`,
    `- окружение ${ids.environment ?? "—"} (${names.env}), хранилище ${ids.vault ?? "—"} (${names.vault}, секрет ${secret.name}${FAKE && secret.value ? `, sha256 фиктивного ключа ${sha12(secret.value)}` : ""}), агент ${ids.agent ?? "—"} (${names.agent}), сессия ${ids.session ?? "—"} (${names.session}), nonce ${nonce}`,
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
  secret = loadSecret();
  if (FAKE) {
    const fh = await (await fetch(`${run.FAKE_URL}/health`)).json().catch(() => null);
    if (!fh?.ok) throw new Error(`фейковая модель ${run.FAKE_URL} не отвечает`);
  }
  const executablePath = pickChromium();
  browser = await chromium.launch({ executablePath, headless: process.env.VERIFY_HEADED !== "1", args: ["--disable-gpu"] });
  context = await browser.newContext({ baseURL: BASE, viewport: VIEW, locale: "ru-RU" });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  log(`процессов браузера записано в state/pids: ${recordJourneyChildren()}`);
  for (const [name, fn] of [
    ["вход", stepLogin],
    ["окружение с claude-agent-acp", stepEnvironment],
    ["хранилище с ключом", stepVault],
    ["агент на Claude Code", stepAgent],
    ["сессия", stepSession],
    ["ход Claude Code", stepTurn],
    ["второй ход Claude Code", stepSecondTurn],
    ...(KEEP_SESSION ? [] : [["архив сессии", archiveAndProveStop]]),
  ]) {
    log(`== шаг: ${name}`);
    await fn();
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
