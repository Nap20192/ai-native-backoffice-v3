#!/usr/bin/env node
// Главный сценарий verify-agent-console (Playwright, интерфейс консоли на русском):
//   вход тестовой учёткой → создать окружение → доказать, что окружение работает
//   (VM поднимается и выполняет команду) → образы каталога (если launch.sh включил каталог:
//   workplace и workplace-office собраны, в VM на workplace-office есть soffice, pdftoppm и Python,
//   pptx переводится в PDF и PNG) → задать окружению пакет и сеть «Ограниченный»
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
import {
  CATALOG_IMAGE_KEYS,
  OFFICE_IMAGE_KEY,
  catalogImageFacts,
  officeToolsCommand,
  officeToolsFacts,
  officeToolsProblems,
  pngProblems,
  renderCommand,
  renderFacts,
  renderFileName,
  renderProblems,
  shortDigest,
} from "./catalog-checks.mjs";

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
// Хост, который пользователь разрешает в «Разрешённых хостах» карточки окружения.
// Адреса у него свои, не как у example.com: блокировку и пропуск видно раздельно.
const NET_ALLOWED_HOST = "example.org";
const NET_ALLOWED_URL = `https://${NET_ALLOWED_HOST}`;
// Усилие агента в форме: не «По умолчанию» и не high (его pi-ai ставит сам), чтобы
// в журнале фейка было видно именно выбор пользователя (output_config.effort).
const AGENT_EFFORT = { level: "low", label: "Низкое" };
// Строки YAML под ключом верхнего уровня key (вложенный блок с отступом) или его значение в строке.
function yamlBlock(text, key) {
  const lines = String(text ?? "").split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start < 0) return "";
  const out = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^\s/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

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
// Запросы консоли к каталогу образов (env.sandbox_catalog). До 45694b6 маршрут не был смонтирован,
// и каждая страница окружений получала 404, а консоль молчала (quiet).
const CATALOG_PATH = "/v1/oma/sandbox-catalog";
const catalogRequests = [];
const isCatalogUrl = (url) => {
  try {
    return new URL(url).pathname === CATALOG_PATH;
  } catch {
    return false;
  }
};
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
// Скриншот шага: ширина окна (1280, на шаге узкого экрана 390), высота окна на время снимка
// растягивается на скрытую прокрутку (до MAX_SHOT_HEIGHT). Два подряд одинаковых скриншота шагов
// (sha256) дают провал evidence.screens_distinct: страница не перерисовалась, и снимок ничего не доказывает.
async function shot(name) {
  const file = `screens/${String(++shotN).padStart(2, "0")}-${name}.png`;
  const view = page.viewportSize() ?? VIEW;
  const extra = await hiddenScrollHeight();
  const tall = extra > 4;
  if (tall) {
    await page.setViewportSize({ width: view.width, height: Math.min(view.height + extra, MAX_SHOT_HEIGHT) });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  let buffer;
  try {
    buffer = await page.screenshot({ path: join(EV, file), fullPage: true });
  } finally {
    if (tall) await page.setViewportSize(view);
  }
  const sha = createHash("sha256").update(buffer).digest("hex");
  const isStep = !/^(fail-|abort$)/.test(name);
  if (isStep && lastStepShot?.sha === sha) duplicateShots.push(`${lastStepShot.file} = ${file}`);
  if (isStep) lastStepShot = { file, sha };
  screens.push({ file, sha, tall: tall ? Math.min(view.height + extra, MAX_SHOT_HEIGHT) : 0 });
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
            // Реплику пользователя храним целиком: маркер nonce=<n> стоит в конце
            // промпта (после ~250 символов), и по обрезанному тексту
            // run.sse_user_message не нашёл бы её.
            const text = textOf(event.content);
            seen.events.push({ sse: name ?? null, type: event.type ?? null, id: event.id ?? null, text: event.type === "user.message" ? text : text.slice(0, 160) });
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
    case "net": // HTTP-коды внешнего и разрешённого хоста из VM (000 = недоступен)
      return `echo VERIFY_OK_${n}; echo net_example=$(curl -s -m 10 -o /dev/null -w '%{http_code}' ${NET_PROBE_URL} || true); `
        + `echo net_allowed=$(curl -s -m 10 -o /dev/null -w '%{http_code}' ${NET_ALLOWED_URL} || true)`;
    case "alive": // отвечает ли VM после сетевого хода
      return `echo VERIFY_OK_${n} && echo alive_kernel=$(uname -r)`;
    case "office": // программы образа workplace-office: коды выхода и версии (catalog-checks.mjs)
      return officeToolsCommand(n);
    case "render": // pptx → PDF → PNG в VM, PNG в /mnt/session/outputs (catalog-checks.mjs)
      return renderCommand(n);
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
    messages,
    lastMessage: messages.at(-1),
    idle: after.find((e) => e.type === "session.status_idle"),
    errors: after.filter((e) => e.type === "session.error"),
    pos,
  };
}
// Текст ответа и текст страницы. Консоль рисует ответ через Markdown: строк ``` нет,
// маркеры заголовков, списков, **, ` и ссылок убраны. Строки сверяются по порядку.
const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
function markdownLines(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) => squash(line
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|`/g, "")))
    .filter(Boolean);
}
// Первая строка ответа, которой нет в тексте страницы после предыдущей; null, если все на месте.
// Сравниваются только буквы и цифры: разметка таблиц, курсива и экранирование в режиме real
// не дают ложного провала, а срез начала ответа уносит буквы и виден.
const bare = (text) => String(text ?? "").replace(/[^\p{L}\p{N}]+/gu, "");
function missingInOrder(lines, pageText) {
  const hay = bare(pageText);
  let from = 0;
  for (const line of lines) {
    const needle = bare(line);
    if (!needle) continue;
    const at = hay.indexOf(needle, from);
    if (at < 0) return line;
    from = at + needle.length;
  }
  return null;
}
const occurrences = (haystack, needle) => (needle ? haystack.split(needle).length - 1 : 0);
// Подписи длительности в ходе: «Работал 12 с», «Работает 1 мин 5 с», «Думал 0 с» -> секунды.
function durationLabels(text) {
  return [...String(text ?? "").matchAll(/(Работал|Работает|Думал)\s+(?:(\d+)\s*мин\s*)?(\d+)\s*с(?![а-яё])/g)]
    .map((m) => ({ label: m[0], seconds: Number(m[2] ?? 0) * 60 + Number(m[3]) }));
}
// Короткая длительность строки вызова (formatShortDurationRu): «119 мс», «6,8 с», «3 мин 5 с» -> секунды.
function shortDurationSeconds(label) {
  const text = squash(label).replace(",", ".");
  const ms = text.match(/^(\d+)\s*мс$/);
  if (ms) return Number(ms[1]) / 1000;
  const parts = text.match(/^(?:(\d+)\s*ч\s*)?(?:(\d+)\s*мин\s*)?(?:([\d.]+)\s*с)?$/);
  if (!parts || !(parts[1] || parts[2] || parts[3])) return null;
  return Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
}
// Ждать конца анимаций внутри scope (CSS-переходы раскрытия): конечные анимации из
// getAnimations, не дольше 3 с, затем высота scope не меняется два замера подряд.
async function settleAnimations(scope) {
  await scope.evaluate((root) => Promise.race([
    Promise.all(root.getAnimations({ subtree: true })
      .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
      .map((a) => a.finished.catch(() => {}))),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])).catch(() => {});
  let previous = null;
  for (let i = 0; i < 30; i++) {
    const height = Math.round((await scope.boundingBox().catch(() => null))?.height ?? -1);
    if (height === previous) return;
    previous = height;
    await sleep(100);
  }
}
// Первая строка, которая на экране не видна целиком, или null, если видны все. innerText отдаёт
// и текст, срезанный overflow (свёрнутый или ещё раскрывающийся блок процесса, line-clamp,
// truncate), поэтому строка ищется в самом глубоком элементе и сверяется с его коробкой.
// Срезом считается overflow hidden или clip у предков до ближайшей прокрутки (auto, scroll):
// до текста в прокрутке можно докрутить. Сравниваются только буквы и цифры, как в missingInOrder.
async function clippedLine(scope, lines) {
  return scope.evaluate((root, wanted) => {
    const bare = (text) => String(text ?? "").replace(/[^\p{L}\p{N}]+/gu, "");
    const clips = (value) => value === "hidden" || value === "clip";
    const scrolls = (value) => value === "auto" || value === "scroll";
    const problem = (el) => {
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || style.display === "none" || style.visibility === "hidden") return "скрыт";
      }
      const box = el.getBoundingClientRect();
      if (box.height < 1 || box.width < 1) return "нулевой размер";
      const own = getComputedStyle(el);
      if ((clips(own.overflowY) && el.scrollHeight > el.clientHeight + 1) ||
          (clips(own.overflowX) && el.scrollWidth > el.clientWidth + 1)) return "текст не помещается в свой блок (line-clamp, truncate)";
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        const outer = node.getBoundingClientRect();
        if (clips(style.overflowY) && (box.bottom > outer.bottom + 1 || box.top < outer.top - 1)) {
          return `предок ${node.tagName.toLowerCase()}.${String(node.className).split(" ")[0]} (overflow ${style.overflowY}) показывает ${Math.max(0, Math.round(Math.min(box.bottom, outer.bottom) - Math.max(box.top, outer.top)))} из ${Math.round(box.height)} px`;
        }
        if (clips(style.overflowX) && (box.right > outer.right + 1 || box.left < outer.left - 1)) {
          return `предок ${node.tagName.toLowerCase()}.${String(node.className).split(" ")[0]} (overflow-x ${style.overflowX}) срезает по ширине`;
        }
        if (scrolls(style.overflowY) || scrolls(style.overflowX)) break;
      }
      return null;
    };
    for (const line of wanted) {
      const needle = bare(line);
      if (!needle) continue;
      const holders = [...root.querySelectorAll("*")].filter((el) => bare(el.textContent).includes(needle));
      const deepest = holders.filter((el) => !holders.some((other) => other !== el && el.contains(other)));
      if (deepest.length === 0) return `«${line}»: нет на странице`;
      const problems = deepest.map(problem);
      if (problems.every(Boolean)) return `«${line}»: ${problems[0]}`;
    }
    return null;
  }, lines);
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
    allowedCode: netText.match(/^net_allowed=(\d{3})/m)?.[1],
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
async function hostReach(url = NET_PROBE_URL) {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return String(res.status);
  } catch (error) {
    return `000 (${error.cause?.code ?? error.name})`;
  }
}
const describeNet = (n) => n.broken
  ? `поток exec BoxLite оборвался: «${n.netText}»`
  : `net_example=${n.code ?? "нет строки"}, net_allowed=${n.allowedCode ?? "нет строки"}`;

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
    // Дефект исправлен 2026-10-16 (stripRuntimeNoise в litebox.ts), поэтому провал, а не «внимание».
    await check(`${prefix}.tool_output_clean`, "в выводе bash нет служебных строк рантайма песочницы (ANSI, libcontainer)", () => {
      assert(noise.length === 0, `строк ${noise.length}, первая: ${plain(noise[0]).slice(0, 160)}; stderr рантайма VM попадает в tool_result (stripRuntimeNoise в packages/sandbox-adapter-litebox/src/litebox.ts)`);
      return evidenceFile;
    });
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
  // litebox-sandbox пишет «creating box (image=…)» логгером, который берётся в момент
  // записи (moduleLogger в litebox.ts), поэтому строка попадает в корневой логгер main-node.
  const creatingBox = serverLogLines().filter((l) => l.includes("creating box (image=")).length;
  await check(`${prefix}.server_log_box`, "в логе сервера есть «creating box (image=…)» от litebox-sandbox", () => {
    assert(creatingBox >= minStarted, `строк ${creatingBox}, нужно ${minStarted}: логгер litebox-sandbox не дошёл до лога сервера (moduleLogger в packages/sandbox-adapter-litebox/src/litebox.ts)`);
    return `${run.SERVER_LOG}: строк ${creatingBox}`;
  });
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
  await check("auth.me_email", "/v1/oma/me отдаёт почту пользователя", () => {
    assert(me.user?.email === user.email, `email «${me.user?.email ?? ""}»: проверьте loadUser в buildMeRoutes (apps/main-node/src/modules/node-http.ts)`);
    return "api/02-me-browser.json";
  });
}

async function stepCreateEnvironment() {
  // Ждём ответ каталога, иначе проверка гонится с запросом страницы.
  const catalogLoaded = page.waitForResponse((r) => isCatalogUrl(r.url()), { timeout: 20_000 }).catch(() => null);
  const wasEmpty = await openSection("Окружения", "Окружений пока нет");
  await catalogLoaded;
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
  const catalogApi = await api("GET", CATALOG_PATH).catch((error) => ({ error: error.message }));
  const catalogFile = saveJson("10-sandbox-catalog", { requests: [...catalogRequests], response: catalogApi });
  await check("env.sandbox_catalog", `список и карточка окружений получают каталог образов: каждый запрос консоли к ${CATALOG_PATH} отвечает 200`, () => {
    assert(catalogRequests.length > 0, `на страницах окружений консоль не запрашивала ${CATALOG_PATH}`);
    const bad = catalogRequests.filter((r) => r.status !== 200);
    assert(bad.length === 0, `неудачные запросы: ${bad.map((r) => `${r.status || r.failure} на ${r.page}`).join("; ")}; маршрут монтирует apps/main-node/src/modules/node-http.ts`);
    assert(!catalogApi?.error, `GET ${CATALOG_PATH} по API: ${catalogApi?.error}`);
    return `${catalogFile}; запросов ${catalogRequests.length}, enabled=${catalogApi?.enabled}, образов ${(catalogApi?.images ?? []).length}`;
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
async function startProbeSession(title, environmentId = ids.environment) {
  const agentId = await ensureProbeAgent();
  const session = await api("POST", "/v1/sessions", { agent: agentId, environment_id: environmentId, title });
  created.sessions.push(session.id);
  saveCreated();
  return session;
}

async function stepProbeEnvironment() {
  // Обходной путь: в API и консоли нет проверки окружения, песочница ленивая
  // (apps/main-node/src/lib/node-session-router.ts, NodeSessionRouter.init). Технический агент по API,
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
  ids.hostAllowed = await hostReach(NET_ALLOWED_URL);
  const net = await networkTurns(session.id, "проба сети", "21b-probe-network-events");
  ids.baselineNet = net;
  if (!reachable(ids.hostNet)) {
    record("env.probe.network", `сеть «Без ограничений»: ${NET_PROBE_URL} доступен из VM, VM работает после запроса`, "не проверено", net.file,
      `с хоста ${NET_PROBE_URL} недоступен (${ids.hostNet}): сравнивать не с чем; из VM: ${describeNet(net)}`);
  } else {
    await check("env.probe.network", `сеть «Без ограничений»: ${NET_PROBE_URL} доступен из VM (с хоста код ${ids.hostNet}), VM работает после запроса`, () => {
      assert(reachable(net.code), `из VM: ${describeNet(net)}`);
      assert(net.alive, `VM после сетевого запроса не отвечает: «${net.aliveText}»`);
      return `${net.file}: net_example=${net.code}, net_allowed=${net.allowedCode}`;
    });
  }
  if (!KEEP_SESSION) await archiveAndProveStop("env.probe", session.id);
}

// Образы каталога (docs/plans/environment-programs.md, срез П1). Каталог включают
// VERIFY_SANDBOX_IMAGE_CATALOG и VERIFY_SANDBOX_IMAGE_DIR у launch.sh, в run.env это
// SANDBOX_IMAGE_CATALOG и SANDBOX_IMAGE_DIR. Без них три проверки идут строками «не проверено».
// Окружение с образом создаётся по API, это обходной путь, как проба: раздел «Образ» карточки
// (подфункция env-image) сценарий не ведёт. Одна сессия и два хода (программы, затем рендер),
// чтобы холодный старт образа был один. Шаг идёт до настроек: агент пробы ещё не в архиве.
const CATALOG_TITLES = {
  catalog: `каталог образов включён: ${CATALOG_IMAGE_KEYS.join(" и ")} собраны (built: true), дайджест из GET ${CATALOG_PATH} равен index.json каталога образа и файлу .digest на диске`,
  office: `окружение с образом ${OFFICE_IMAGE_KEY} (по API): VM поднята из этого образа (в логе сервера «creating box» с его дайджестом), soffice --version, pdftoppm -v, python --version и импорт docx, openpyxl, pptx выходят с кодом 0`,
  render: `в VM на ${OFFICE_IMAGE_KEY} python-pptx пишет слайд 16:9, soffice --headless --convert-to pdf даёт PDF, pdftoppm -png даёт непустой PNG, PNG через /mnt/session/outputs лежит на хосте`,
};
async function stepCatalogImages() {
  const skip = (list, why) => list.forEach(([id, title]) => record(id, title, "не проверено", "", why));
  const officeChecks = [["env.office_tools", CATALOG_TITLES.office], ["env.render", CATALOG_TITLES.render]];
  if (!run.SANDBOX_IMAGE_CATALOG) {
    skip([["env.catalog_enabled", CATALOG_TITLES.catalog], ...officeChecks],
      "каталог образов в прогоне выключен: launch.sh запущен без VERIFY_SANDBOX_IMAGE_CATALOG и VERIFY_SANDBOX_IMAGE_DIR");
    return;
  }
  // Пути образов ответ сервера не отдаёт: oci_dir берётся из catalog.json, index.json и .digest с диска.
  const response = await api("GET", CATALOG_PATH).catch((error) => ({ error: error.message }));
  let catalogFile = null;
  let fileError = null;
  try {
    catalogFile = JSON.parse(readFileSync(run.SANDBOX_IMAGE_CATALOG, "utf8"));
  } catch (error) {
    fileError = error.message;
  }
  const facts = catalogImageFacts({ response, catalogFile, imageDir: run.SANDBOX_IMAGE_DIR });
  const catalogJson = saveJson("50-sandbox-catalog", { catalog: run.SANDBOX_IMAGE_CATALOG, image_dir: run.SANDBOX_IMAGE_DIR, response, disk: facts.images });
  const okCatalog = await check("env.catalog_enabled", CATALOG_TITLES.catalog, () => {
    assert(!response?.error, `GET ${CATALOG_PATH}: ${response?.error}`);
    assert(!fileError, `${run.SANDBOX_IMAGE_CATALOG} не читается: ${fileError}`);
    assert(facts.problems.length === 0, facts.problems.join("; "));
    return `${catalogJson}; ${facts.images.map((i) => `${i.key} ${shortDigest(i.apiDigest)}${i.fileDigest ? " = .digest" : ", файла .digest нет"}`).join(", ")}`;
  });
  if (okCatalog) cover("env-catalog");
  const image = (response?.images ?? []).find((i) => i?.key === OFFICE_IMAGE_KEY);
  if (response?.enabled !== true || image?.built !== true || !image.image_digest) {
    skip(officeChecks, `образ ${OFFICE_IMAGE_KEY} не готов по ответу сервера (enabled=${response?.enabled}, built=${image?.built ?? "нет образа"}): см. env.catalog_enabled`);
    return;
  }

  const officeNonce = newNonce();
  const renderNonce = newNonce();
  names.officeEnv = `verify-office-${officeNonce}`;
  let session = null;
  let vmRan = false;
  const okTools = await check("env.office_tools", CATALOG_TITLES.office, async () => {
    const env = await api("POST", "/v1/environments", {
      name: names.officeEnv,
      description: `verify-agent-console ${run.RUN_ID}: образ ${OFFICE_IMAGE_KEY}`,
      config: { type: "cloud", image: OFFICE_IMAGE_KEY },
    });
    ids.officeEnvironment = env.id;
    created.environments.push(env.id);
    saveCreated();
    const envFile = saveJson("51-office-environment", env);
    assert(env.config?.image === OFFICE_IMAGE_KEY, `${envFile}: config.image ${JSON.stringify(env.config?.image)}`);
    session = await startProbeSession(names.officeEnv, env.id);
    ids.officeSession = session.id;
    await sendTurn(session.id, "office", officeNonce);
    log(`образ ${OFFICE_IMAGE_KEY}: сессия ${session.id}, первый старт VM собирает диск образа в BOXLITE_HOME`);
    const events = await waitTurnIdle(session.id, officeNonce, FIRST_TURN_TIMEOUT, `образ ${OFFICE_IMAGE_KEY}`);
    const evFile = saveJson("52-office-session-events", events);
    const a = analyzeTurn(events, officeNonce);
    const text = firstResultText(events, officeNonce);
    vmRan = Boolean(a.pair);
    assert(a.errors.length === 0, `session.error: ${JSON.stringify(a.errors.map((e) => e.error ?? e)).slice(0, 400)}`);
    assert(a.pair, `нет tool_result с VERIFY_OK_${officeNonce}; вывод: «${plain(text).slice(0, 300)}»`);
    const f = officeToolsFacts(text);
    assert(f.kernel && f.kernel !== HOST_KERNEL, `kernel=${f.kernel}: команда выполнена не в VM`);
    // Подпись образа в строке лога: «<ключ> <дайджест>» (boxPlan в litebox.ts). Так видно, что VM
    // поднялась из каталога OCI этого образа, а не из образа сервера с такими же программами.
    const boxLine = `creating box (image=${OFFICE_IMAGE_KEY} ${image.image_digest}`;
    assert(serverLogLines().some((l) => l.includes(boxLine)),
      `в логе сервера нет «${boxLine}…»: VM поднялась не из образа каталога; путь config.image → createSandboxImageSpec (apps/main-node/src/lib/sandbox-environment-image.ts) → boxPlan (packages/sandbox-adapter-litebox/src/litebox.ts)`);
    const problems = officeToolsProblems(f);
    assert(problems.length === 0, `${problems.join("; ")}; вывод: «${plain(text).slice(0, 300)}»`);
    return `${evFile}: ${f.tools.filter((t) => t.version).map((t) => t.version).join(", ")}, импорт docx, openpyxl, pptx с кодом 0, kernel=${f.kernel}; лог сервера: image=${OFFICE_IMAGE_KEY} ${shortDigest(image.image_digest)}`;
  });
  if (vmRan) vmStarts += 1;
  if (!vmRan) {
    skip([officeChecks[1]], "VM на образе не выполнила команду: см. env.office_tools");
  } else {
    const okRender = await check("env.render", CATALOG_TITLES.render, async () => {
      await sendTurn(session.id, "render", renderNonce);
      const events = await waitTurnIdle(session.id, renderNonce, TURN_TIMEOUT, `рендер на ${OFFICE_IMAGE_KEY}`);
      const evFile = saveJson("52-office-session-events", events);
      const a = analyzeTurn(events, renderNonce);
      const text = firstResultText(events, renderNonce);
      assert(a.errors.length === 0, `session.error: ${JSON.stringify(a.errors.map((e) => e.error ?? e)).slice(0, 400)}`);
      const f = renderFacts(text);
      const problems = renderProblems(f);
      assert(problems.length === 0, `${problems.join("; ")}; конец вывода: «${plain(text).slice(-300)}»`);
      const name = renderFileName(renderNonce);
      const hostFile = join(run.SESSION_OUTPUTS_DIR, user.tenant_id, session.id, name);
      assert(existsSync(hostFile), `нет ${hostFile}: PNG не дошёл до хоста через /mnt/session/outputs`);
      const png = readFileSync(hostFile);
      const pngIssues = pngProblems(png);
      assert(pngIssues.length === 0, `${hostFile}: ${pngIssues.join("; ")}`);
      assert(png.length === f.pngBytes, `на хосте ${png.length} байт, в VM png_bytes=${f.pngBytes}`);
      const copy = `api/53-${name}`;
      copyFileSync(hostFile, join(EV, copy));
      return `${evFile}; ${copy}: PNG ${png.length} байт`;
    });
    if (okTools && okRender) cover("env-office");
  }
  // VM образа берёт до 1536 МиБ памяти: архив останавливает её до шагов настроек и агента.
  if (session && !KEEP_SESSION) {
    if (vmRan) await archiveAndProveStop("env.office", session.id);
    else await api("POST", `/v1/sessions/${session.id}/archive`).catch(() => {});
  }
}

async function stepConfigureEnvironment() {
  // Карточка окружения (env-detail): описание, сеть «Ограниченный» с одним разрешённым
  // хостом (менеджерам пакетов сеть тоже разрешена) и пакет apt jq. Затем сверка через API.
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
  await page.getByRole("textbox", { name: "Разрешённые хосты" }).fill(NET_ALLOWED_HOST);
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
  await check("env.settings_saved", `карточка окружения сохранила описание, сеть limited с хостом ${NET_ALLOWED_HOST} и пакет ${ENV_PACKAGE.manager} ${ENV_PACKAGE.name} (GET /v1/environments/:id)`, () => {
    const net = env.config?.networking ?? {};
    assert(env.description === description, `description ${JSON.stringify(env.description)}`);
    assert(net.type === "limited", `networking.type ${net.type}`);
    assert(net.allow_package_managers === true, `allow_package_managers ${net.allow_package_managers}`);
    assert(JSON.stringify(net.allowed_hosts) === JSON.stringify([NET_ALLOWED_HOST]), `allowed_hosts ${JSON.stringify(net.allowed_hosts)}`);
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
    record("env.networking_limited_applied", "сеть «Ограниченный» закрывает неразрешённый внешний хост в VM", "не проверено", evFile, "проба после настроек не выполнилась");
    record("env.networking_allowed_host", `сеть «Ограниченный» пропускает разрешённый пользователем ${NET_ALLOWED_HOST} из VM`, "не проверено", evFile, "проба после настроек не выполнилась");
  } else {
    if (base.pkg !== "missing") {
      record("env.packages_applied", `пакет ${ENV_PACKAGE.manager} ${ENV_PACKAGE.name} из настроек окружения установлен в VM`, "не проверено", evFile,
        `до настроек pkg_${ENV_PACKAGE.name}=${base.pkg ?? "?"}: пакет уже был в образе или проба не дала базы, выберите другой пакет`);
    } else {
      await check("env.packages_applied", `пакет ${ENV_PACKAGE.manager} ${ENV_PACKAGE.name} из настроек окружения установлен в VM новой сессии`, () => {
        assert(facts.pkg === "install ok installed",
          `pkg_${ENV_PACKAGE.name}=${facts.pkg}: пакеты окружения не встали; путь: buildSandbox в createManagedNodeRuntime (apps/main-node/src/modules/node-managed.ts) → initializeBox в packages/sandbox-adapter-litebox/src/litebox.ts (закрепление хостов, установка); ошибку установки ищите в api/22-settings-probe-events.json`);
        return evFile;
      });
    }
    const net = await networkTurns(session.id, "проба сети после настроек", "22b-settings-network-events");
    const title = `сеть «Ограниченный»: неразрешённый ${NET_PROBE_URL} из VM недоступен (curl даёт 000), VM работает после запроса`;
    if (!reachable(ids.hostNet)) {
      record("env.networking_limited_applied", title, "не проверено", net.file,
        `с хоста ${NET_PROBE_URL} недоступен (${ids.hostNet}): блокировку не отличить от отсутствия сети; из VM: ${describeNet(net)}`);
    } else {
      await check("env.networking_limited_applied", title, () => {
        const baseNote = ids.baselineNet ? `; при «Без ограничений» было: ${describeNet(ids.baselineNet)}` : "";
        assert(!reachable(net.code),
          `net_example=${net.code}: VM ходит во внешнюю сеть; сеть окружения переводит в allowNet liteBoxNetwork (packages/sandbox-adapter-litebox/src/litebox.ts), строка «creating box (… network=…)» в логе сервера`);
        assert(!net.broken && net.code === "000",
          `${describeNet(net)}: блокировку не увидеть, запрос рвёт VM${baseNote}; обход падения boxlite-shim на DNS — applyShimDnsWorkaround (packages/sandbox-adapter-litebox/src/litebox.ts)`);
        assert(net.alive, `VM после сетевого запроса не отвечает: «${net.aliveText}»`);
        return `${net.file}: net_example=${net.code}`;
      });
    }
    const allowedTitle = `сеть «Ограниченный»: разрешённый пользователем ${NET_ALLOWED_HOST} из VM отвечает 200, как с хоста`;
    if (ids.hostAllowed !== "200") {
      record("env.networking_allowed_host", allowedTitle, "не проверено", net.file,
        `с хоста ${NET_ALLOWED_URL} даёт ${ids.hostAllowed}, а не 200: сравнивать не с чем; из VM: ${describeNet(net)}`);
    } else {
      await check("env.networking_allowed_host", allowedTitle, () => {
        assert(!net.broken, `${describeNet(net)}: запрос рвёт VM`);
        assert(net.allowedCode === "200",
          `net_allowed=${net.allowedCode ?? "нет строки"}: разрешённый хост из VM недоступен; хост идёт в allowNet (liteBoxNetwork) и закрепляется в /etc/hosts VM (pinAllowedHosts, строка «pinned N allowed host(s)» в логе сервера), оба в packages/sandbox-adapter-litebox/src/litebox.ts`);
        return `${net.file}: net_allowed=${net.allowedCode}, net_example=${net.code}`;
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
  // Модель и усилие задаются в режиме «Форма», без YAML. Список моделей форма берёт из
  // GET /v1/oma/model_options: модели каталога Pi по ключу сервера и карточки рабочего
  // пространства (ModelPicker.tsx), поэтому карточки моделей для этого не нужны.
  const options = await api("GET", "/v1/oma/model_options");
  saveJson("29-model-options", options);
  const option = (options.data ?? []).find((o) => o.handle === MODEL);
  const harnessBox = dialog.getByRole("combobox", { name: "Harness", exact: true });
  const modelBox = dialog.getByRole("combobox", { name: "Модель", exact: true });
  const effortBox = dialog.getByRole("combobox", { name: "Усилие", exact: true });
  await modelBox.click();
  const modelItem = page.locator(`[data-slot="command-item"][data-value^="${MODEL} "]`).first();
  await modelItem.waitFor({ timeout: 15_000 });
  await modelItem.click();
  await modelBox.filter({ hasText: option?.label ?? MODEL }).waitFor({ timeout: 10_000 });
  await effortBox.click();
  await page.getByRole("option", { name: AGENT_EFFORT.label, exact: true }).click();
  await effortBox.filter({ hasText: AGENT_EFFORT.label }).waitFor({ timeout: 10_000 });
  const formShot = await shot("agent-form-model-effort");
  cover("agent-form");
  const okFormModel = await check("agent.form_model_effort", `в режиме «Форма» выбраны модель ${MODEL} (ключ сервера, без карточек моделей) и усилие «${AGENT_EFFORT.label}», выбора harness в форме нет`, async () => {
    assert(option, `модели ${MODEL} нет в GET /v1/oma/model_options: ${(options.data ?? []).map((o) => o.handle).join(", ").slice(0, 300)}`);
    assert(option.source === "builtin", `источник ${option.source}, ожидался builtin (ключ сервера)`);
    assert((option.effort_levels ?? []).includes(AGENT_EFFORT.level), `уровни усилия модели: ${JSON.stringify(option.effort_levels)}`);
    assert((await dialog.getByText("Модели не настроены").count()) === 0, "в форме предупреждение «Модели не настроены»");
    // С 2026-10-17 ход ведёт только Pi (D41), поле «Harness» из формы убрано.
    assert((await harnessBox.count()) === 0, "в форме осталось поле «Harness»");
    const modelText = plain(await modelBox.textContent());
    assert(modelText.includes(option.label) && modelText.includes(MODEL), `Модель: «${modelText}»`);
    const effortText = plain(await effortBox.textContent());
    assert(effortText === AGENT_EFFORT.label, `Усилие: «${effortText}»`);
    return `${formShot}, api/29-model-options.json`;
  });
  await dialog.getByRole("tab", { name: /^Инструменты/ }).click();
  await dialog.getByRole("tabpanel").filter({ hasText: /bash/ }).first().waitFor();
  await shot("agent-form-tools");
  cover("agent-tools");
  // YAML той же формы: выбор модели и усилия сериализован, обратный переход его не теряет.
  // Агент создаётся из режима «Форма».
  const modeGroup = dialog.getByRole("group", { name: "Режим правки" });
  await modeGroup.getByRole("button", { name: "YAML", exact: true }).click();
  const editor = dialog.getByRole("textbox", { name: "Конфигурация агента в формате YAML" });
  const yaml = await editor.inputValue();
  writeFileSync(join(EV, "api", "30-agent-create.yaml"), yaml);
  await shot("agent-form-yaml");
  await modeGroup.getByRole("button", { name: "Форма", exact: true }).click();
  await dialog.getByRole("tab", { name: /^Основное/ }).click();
  await modelBox.waitFor();
  const okYaml = await check("agent.yaml_roundtrip", `YAML формы несёт model.id ${MODEL} и effort ${AGENT_EFFORT.level}, после возврата в «Форму» модель и усилие на месте`, async () => {
    const block = yamlBlock(yaml, "model");
    assert(new RegExp(`^\\s+id: ${MODEL}$`, "m").test(block), `блок model в YAML: ${JSON.stringify(block)}`);
    assert(new RegExp(`^\\s+effort: ${AGENT_EFFORT.level}$`, "m").test(block), `нет effort: ${AGENT_EFFORT.level} в блоке model: ${JSON.stringify(block)}`);
    const modelText = plain(await modelBox.textContent());
    const effortText = plain(await effortBox.textContent());
    assert(modelText.includes(MODEL) && effortText === AGENT_EFFORT.label, `после возврата: Модель «${modelText}», Усилие «${effortText}»`);
    return "api/30-agent-create.yaml";
  });
  if (okYaml) cover("agent-code");
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
  const okCreated = await check("agent.created", `агент сохранён из формы: имя, модель ${MODEL} с усилием ${AGENT_EFFORT.level}, системный промпт, без _oma.harness и _oma.acp`, () => {
    const modelId = typeof agent.model === "string" ? agent.model : agent.model?.id;
    assert(agent.name === names.agent, `name ${agent.name}`);
    assert(modelId === MODEL, `model ${JSON.stringify(agent.model)}`);
    // API отдаёт усилие объектом {type: <уровень>} (toAgentResponse в packages/managed-agents-api/src/mappers/agents.ts),
    // на входе принимает и строку, и объект.
    assert(agent.model?.effort?.type === AGENT_EFFORT.level, `model.effort ${JSON.stringify(agent.model?.effort)}, ожидалось {"type":"${AGENT_EFFORT.level}"}: форма не передала усилие (buildModelValue в pages/agents/agentFormCodec.ts)`);
    assert(!agent._oma?.harness && !agent._oma?.acp, `_oma ${JSON.stringify(agent._oma)}: встроенный цикл не пишет harness`);
    assert(String(agent.system ?? "").includes("агент проверки"), "system не тот");
    return "api/31-agent.json";
  });
  if (okFormModel && okCreated) cover("agent-model");
  await check("agent.bash_enabled", "у агента включён набор инструментов и bash не отключён", () => {
    const toolset = (agent.tools ?? []).find((t) => t.type === "agent_toolset_20260401");
    assert(toolset, "нет agent_toolset_20260401");
    const bash = (toolset.configs ?? []).find((c) => c.name === "bash");
    const enabled = bash?.enabled ?? toolset.default_config?.enabled ?? true;
    assert(enabled !== false, "bash отключён");
    return "api/31-agent.json";
  });
  await check("agent.detail_ui", `карточка агента в консоли показывает модель и «Усилие: ${AGENT_EFFORT.label.toLowerCase()}»`, async () => {
    const props = page.getByRole("region", { name: "Свойства агента" }).first();
    await props.getByText(`Усилие: ${AGENT_EFFORT.label.toLowerCase()}`).first().waitFor({ timeout: 10_000 }).catch(() => {});
    const text = plain(await props.textContent());
    assert(text.includes(MODEL), "в «Свойства агента» нет модели");
    assert(text.includes(`Усилие: ${AGENT_EFFORT.label.toLowerCase()}`), `нет «Усилие: ${AGENT_EFFORT.label.toLowerCase()}»: ${text.slice(0, 200)}`);
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
  const sessionNewShot = await shot("session-new");
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
      "Поле ведёт Controller (pages/SessionsList.tsx, поле title окна «Новая сессия»); onChange react-hook-form register() ищет поле по event.target.name, поэтому name=\"oma-session-title\" поверх register() теряет ввод");
    return "api/40-session-created.json";
  });
  // Сервер создаёт сессию idle, если initialEvents не запускают ход
  // (packages/managed-agents-application/src/sessions/application.ts, admitsBootstrapTurn).
  // Консоль берёт статус из GET /v1/sessions/:id: при running шапка «Выполняется»
  // и вечное «Агент работает…» в пустом разговоре.
  await check("session.initial_status", "новая сессия без сообщений: API status idle, в шапке «Ожидает», в разговоре нет «Агент работает…»", async () => {
    assert(session.status === "idle", `API status=${session.status}, ожидался idle`);
    await page.getByRole("main").getByRole("heading", { level: 1, name: names.session }).waitFor({ timeout: 10_000 })
      .catch(() => {});
    const pill = (await page.getByText(/^(Ожидает|Выполняется)$/).first().textContent().catch(() => null))?.trim();
    assert(pill === "Ожидает", `в шапке «${pill ?? "нет плашки статуса"}», ожидалось «Ожидает»`);
    const working = await page.getByText("Агент работает…").count();
    assert(working === 0, `до отправки в разговоре «Агент работает…» (${working} шт.)`);
    return `api/40-session-created.json; ${sessionNewShot}`;
  });
  // Чипы шапки это ссылки на агента и окружение с их именами (AgentChip, EnvironmentChip
  // в pages/session-detail/Panels.tsx); до переделки страницы 2026-10-16 это были бейджи с title.
  await check("session.header_ui", "в шапке сессии видны агент и окружение: чипы-ссылки с именами", async () => {
    const header = page.getByRole("main").locator("header", { has: page.getByRole("heading", { level: 1 }) }).first();
    const agentChip = header.locator(`a[href="/agents/${ids.agent}"]`, { hasText: names.agent });
    const envChip = header.locator(`a[href="/environments/${ids.environment}"]`, { hasText: names.env });
    assert((await agentChip.count()) > 0, `в шапке нет ссылки /agents/${ids.agent} с именем ${names.agent}`);
    assert((await envChip.count()) > 0, `в шапке нет ссылки /environments/${ids.environment} с именем ${names.env}`);
    return "screens: session-new";
  });
}

async function stepAgentTurn() {
  const box = page.getByRole("textbox", { name: "Сообщение" });
  const prompt = promptFor("run", nonce);
  await box.fill(prompt);
  await shot("turn-typed");
  // Подпись кнопки зависит от статуса сессии (ComposerPrimaryAction в SessionComposer.tsx): при status=running
  // это «Поставить сообщение в очередь». Нажимаем ту кнопку, которую видит пользователь.
  const sendButton = page.getByRole("button", { name: /^(Отправить сообщение|Поставить сообщение в очередь)$/ }).first();
  await sendButton.waitFor();
  const sendLabel = await sendButton.getAttribute("aria-label");
  await check("run.ui_send_label", "кнопка отправки в новой сессии называется «Отправить сообщение»", () => {
    assert(sendLabel === "Отправить сообщение",
      `подпись «${sendLabel}»: консоль считает новую сессию выполняющейся (см. session.initial_status)`);
    return screens.at(-1).file;
  });
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
  const { a: runTurn, vmKernel } = await turnChecks("run", events, nonce, evFile);
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
  // Консоль показывает реплику сразу (оптимистично), поэтому регресс серверного echo
  // user.message ловит только эта проверка: провал, а не «внимание».
  await check("run.sse_user_message", "поток /events/stream после отправки отдаёт user.message с маркером (консоль строит ход из потока)", () => {
    assert(sseUser.length > 0, `HTTP ${stream.seen.status}, событий ${stream.seen.events.length}, типы: ${sseTypes.join(", ") || "нет"}${stream.seen.error ? `, ошибка ${stream.seen.error}` : ""}`);
    return sseFile;
  });

  // Ответ хода целиком. Библиотека рисует сообщения ассистента через streamPrefixes
  // (@openma/common, dist/chat-ui/components.js:537): считает их накопительными чанками ACP
  // и передаёт prefixSkip = сумма длин предыдущих сообщений хода. У канонических событий
  // каждое agent.message полное, и итоговый ответ терял начало (дефект 2026-10-16).
  // Фейковая модель в ходе 1 пишет текст перед tool_use, поэтому сообщений в ходе два.
  // Блок процесса раскрывается переходом height 220 мс (.reasoning-collapse-inner, overflow
  // hidden): без ожидания снимок и clippedLine видят наполовину раскрытый блок (прогон 20261016-023057).
  // С переделки страницы 2026-10-16 блока «Работал N с» нет: каждый запрос к модели стоит своей
  // карточкой, и раскрывать нечего. Тогда страница не меняется, и отдельный снимок совпал бы
  // с turn-done (evidence.screens_distinct): openProcess сообщает, раскрыл ли он блок.
  let processOpened = false;
  const openProcess = async () => {
    const trigger = article.locator("[data-chat-reasoning-trigger]").first();
    if ((await trigger.count()) && (await trigger.getAttribute("aria-expanded")) !== "true") {
      await trigger.click();
      processOpened = true;
    }
    await settleAnimations(article);
  };
  await check("run.answer_full", "ответ хода виден целиком: [data-session-turn-answer] содержит весь итоговый agent.message, первое сообщение хода видно целиком, тексты не повторяются", async () => {
    const messages = (runTurn.messages ?? []).map((m) => textOf(m.content));
    assert(messages.length > 0, "в журнале нет agent.message после реплики");
    const finalText = messages.at(-1);
    const lead = messages.length > 1 ? messages[0] : null;
    if (FAKE) {
      const reqs = fakeRequests(nonce);
      const modelLead = reqs.find((r) => r.decision === "tool_use")?.reply_text ?? null;
      const modelFinal = reqs.find((r) => r.decision === "final_text")?.reply_text ?? null;
      assert(modelLead && modelLead.length >= 40,
        `фейковая модель не отдала текст перед tool_use (reply_text ${JSON.stringify(modelLead)}): без двух сообщений в ходе срез по префиксу не виден, см. leadText в scripts/fake-model.mjs`);
      assert(modelFinal?.includes("```") && modelFinal.includes(`VERIFY_DONE_${nonce}`),
        `итоговый текст фейковой модели без блока кода с VERIFY_DONE_${nonce}: ${JSON.stringify(modelFinal)}`);
      assert(squash(finalText) === squash(modelFinal), `последний agent.message в журнале не равен ответу модели: ${JSON.stringify(finalText.slice(0, 160))}`);
      assert(lead !== null && squash(lead) === squash(modelLead),
        `первый agent.message хода не равен тексту модели перед tool_use: ${JSON.stringify((lead ?? "нет").slice(0, 160))}`);
    }
    const answers = article.locator("[data-session-turn-answer]");
    await answers.first().waitFor({ timeout: 15_000 });
    const answerText = (await answers.allInnerTexts()).join("\n");
    writeFileSync(join(EV, "api", "46-turn-answer-text.txt"), `${answerText}\n`);
    const lost = missingInOrder(markdownLines(finalText), squash(answerText));
    assert(!lost,
      `в [data-session-turn-answer] нет строки итогового ответа «${lost}»; на странице «${squash(answerText).slice(0, 160)}» (api/46-turn-answer-text.txt). ` +
      `Начало срезано на длину первого сообщения (${lead?.length ?? 0} символов) — это prefixSkip из streamPrefixes (@openma/common dist/chat-ui/components.js:537) в renderAssistant (components/session/CanonicalSessionTurn.tsx)`);
    // Первое сообщение хода стоит в блоке процесса: оно видно после раскрытия «Работал N с».
    await openProcess();
    const leadLines = lead ? markdownLines(lead) : [];
    let pageText = squash(await article.innerText());
    for (let i = 0; i < 20 && missingInOrder(leadLines, pageText); i++) {
      await sleep(250);
      pageText = squash(await article.innerText());
    }
    const lostLead = missingInOrder(leadLines, pageText);
    assert(!lostLead, `первое сообщение хода не видно целиком после раскрытия [data-chat-reasoning-trigger]: нет «${lostLead}»`);
    if (FAKE) {
      // Склейка сообщений или чанки рядом с целым сообщением дают повтор текста.
      const finalLine = markdownLines(finalText)[0];
      const leadCount = occurrences(pageText, squash(lead));
      const finalCount = occurrences(pageText, finalLine);
      assert(leadCount === 1 && finalCount === 1,
        `повтор текста в ходе: первое сообщение ${leadCount} раз, строка «${finalLine}» итогового ответа ${finalCount} раз, ожидалось по 1`);
    }
    // innerText не видит overflow: проверяем, что строки на экране не срезаны.
    const clipped = await clippedLine(article, [...leadLines, ...markdownLines(finalText)]);
    assert(!clipped, `текст хода на экране срезан: ${clipped}`);
    return `${processOpened ? await shot("turn-answer-full") : screens.at(-1).file}, api/46-turn-answer-text.txt; сообщений в ходе ${messages.length}, первое ${lead?.length ?? 0} символов, итоговое ${finalText.length}`;
  });
  // «Работал N с»: библиотека считает секунды по turn.startedAt/endedAt
  // (agentUITurnElapsedSeconds, @openma/common dist/agent-ui/presentation.js:68), без них 0.
  await check("run.turn_duration", "подпись длительности хода («Работал N с») не «0 с», если ход длился дольше секунды, и не больше длительности по журналу", async () => {
    const started = Date.parse(runTurn.userMessage?.processed_at ?? "");
    const ended = Date.parse(runTurn.idle?.processed_at ?? "");
    assert(Number.isFinite(started) && Number.isFinite(ended),
      `нет processed_at: user.message ${runTurn.userMessage?.processed_at}, session.status_idle ${runTurn.idle?.processed_at}`);
    const actual = (ended - started) / 1000;
    const trigger = article.locator("[data-chat-reasoning-trigger]").first();
    const triggerText = (await trigger.count()) ? squash(await trigger.textContent()) : "";
    await openProcess();
    const labels = durationLabels(`${triggerText}\n${await article.innerText()}`);
    const turnLabel = durationLabels(triggerText)[0] ?? null;
    const evidence = `ход ${actual.toFixed(1)} с по журналу (user.message → session.status_idle), подпись «${triggerText || "нет"}»`;
    if (actual > 1) {
      const zeros = [...new Set(labels.filter((l) => l.seconds === 0).map((l) => l.label))];
      assert(zeros.length === 0,
        `${evidence}: на странице ${zeros.map((z) => `«${z}»`).join(", ")}. «Работал» — labels.workedFor(agentUITurnElapsedSeconds): projectCanonicalSessionTurn (components/session/CanonicalSessionTurn.tsx) не задаёт startedAt/endedAt; «Думал 0 с» — labels.thoughtFor(0) из AgentUITurnView`);
    }
    if (turnLabel) {
      assert(turnLabel.seconds <= Math.ceil(actual) + 2, `${evidence}: подпись больше длительности хода (время идёт и после конца хода?)`);
    }
    return evidence;
  });
  cover("session-answer");

  // ---- Страница сессии как в консоли Claude (docs/plans/session-page.md, образец docs/cma-console/03-sessions.md):
  // шапка без токенов, стоимости и бюджета, инспектор с пятью вкладками, выбор события, общий для ленты и «Событий»,
  // мини-карта, поиск по разговору, узкий экран. Id событий берутся из журнала API.
  const pageEvents = await listEvents(ids.session);
  const pageEventsFile = saveJson("47-session-page-events", pageEvents);
  const turnUser = runTurn.userMessage ?? null;
  const turnToolUse = runTurn.pair?.toolUse ?? runTurn.toolUses?.[0] ?? null;
  const inspector = page.getByRole("complementary", { name: "Инспектор сессии" });
  const inspectorTab = (name) => inspector.getByRole("tablist", { name: "Вкладки инспектора" }).getByRole("tab", { name, exact: true });
  const eventsTable = inspector.getByRole("table", { name: "События" });
  const eventRow = (id) => eventsTable.locator(`[role="row"][data-event-id="${id}"]`);
  const selectedEvent = inspector.getByRole("region", { name: "Выбранное событие" });
  const urlParam = (name) => new URL(page.url()).searchParams.get(name);
  // JSON выбранного события рисует Shiki асинхронно: ждём строку "id": "<id>".
  const selectedJson = async (id) => {
    await selectedEvent.waitFor({ timeout: 10_000 });
    let text = "";
    for (let i = 0; i < 40; i++) {
      text = await selectedEvent.innerText();
      if (text.includes(`"id": "${id}"`)) break;
      await sleep(250);
    }
    return text;
  };
  const waitSelectedRow = async (id) => {
    for (let i = 0; i < 40 && (await eventRow(id).getAttribute("aria-selected").catch(() => null)) !== "true"; i++) await sleep(250);
    return eventRow(id).getAttribute("aria-selected").catch(() => null);
  };

  // Расхода на странице нет: владелец отменил токены, стоимость и бюджет, модели внутренние
  // (docs/plans/session-page.md). Журнал по-прежнему хранит model_usage у span.model_request_end,
  // поэтому проверка жёсткая: шапка, подсказки её чипов, меню «Действия» и вкладка «Сессия».
  // Проблемы собираются списком, и провал называет всё, что вернулось.
  const requestEnds = pageEvents.filter((e) => e.type === "span.model_request_end");
  const usageSum = requestEnds.reduce((sum, e) => {
    const u = e.model_usage ?? {};
    return {
      withUsage: sum.withUsage + (e.model_usage ? 1 : 0),
      input: sum.input + (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      output: sum.output + (u.output_tokens ?? 0),
    };
  }, { withUsage: 0, input: 0, output: 0 });
  // Те же слова, что в тестах консоли (SessionHeader.test.tsx, SessionTab.test.tsx).
  const USAGE_WORDS = /токен|стоимост|бюджет|нет цены|кэш|\$/i;
  await check("session.ui_no_usage", "шапка и вкладка «Сессия» не показывают токены, стоимость и бюджет (модели внутренние), хотя журнал хранит model_usage: нет чипов tokens и cost, текста «нет цены», пункта и кнопки «Изменить бюджет»; чипы длительности и активности на месте", async () => {
    assert(requestEnds.length > 0, "в журнале сессии нет span.model_request_end");
    // В fake два запроса к модели, у каждого model_usage: токены в журнале есть, а на странице их быть не должно.
    if (FAKE) assert(requestEnds.length >= 2 && usageSum.withUsage === requestEnds.length && usageSum.output > 0,
      `запросов к модели ${requestEnds.length}, с model_usage ${usageSum.withUsage}, выход ${usageSum.output}; ожидалось 2 запроса с токенами (${pageEventsFile})`);
    const problems = [];
    const found = (where, text) => {
      const hits = [...new Set((squash(text).match(new RegExp(USAGE_WORDS.source, "gi")) ?? []).map((hit) => hit.toLowerCase()))];
      if (hits.length) problems.push(`${where}: ${hits.map((hit) => `«${hit}»`).join(", ")} в «${squash(text).slice(0, 160)}»`);
    };

    // Шапка: чипы и текст.
    const header = page.getByRole("main").locator("header", { has: page.getByRole("heading", { level: 1 }) }).first();
    await header.locator('[data-session-chip="duration"]').first().waitFor({ timeout: 15_000 });
    const chips = await header.locator("[data-session-chip]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-session-chip")));
    for (const name of ["duration", "activity"]) {
      if (!chips.includes(name)) problems.push(`в шапке нет чипа ${name}, чипы ${JSON.stringify(chips)}`);
    }
    for (const name of ["tokens", "cost"]) {
      const count = await page.locator(`[data-session-chip="${name}"]`).count();
      if (count) problems.push(`на странице чип [data-session-chip="${name}"] (${count} шт., components/session/SessionHeader.tsx)`);
    }
    found("текст шапки", await header.innerText());

    // Подсказки чипов (Radix Tooltip): раньше там стояли токены по видам и бюджет. Пока подсказка открыта,
    // Radix ставит чипу aria-describedby с id копии её текста (role="tooltip"). По этому id читается
    // подсказка именно этого чипа: подсказка прошлого чипа может ещё стоять в DOM.
    const tips = [];
    try {
      for (const name of chips) {
        const chip = header.locator(`[data-session-chip="${name}"]`).first();
        await chip.hover();
        let tipId = null;
        for (let i = 0; i < 25 && !tipId; i++) {
          tipId = await chip.getAttribute("aria-describedby");
          if (!tipId) await sleep(200);
        }
        const tipText = tipId ? squash(await page.locator(`[id=${JSON.stringify(tipId)}]`).innerText().catch(() => "")) : "";
        if (name === "duration" && !tipText.includes("Прошло с создания")) {
          problems.push(`подсказка чипа duration «${tipText || "не открылась"}», ожидалось «Прошло с создания …»`);
        }
        found(`подсказка чипа ${name}`, tipText);
        tips.push(`${name} «${tipText || "нет"}»`);
        // Мышь уходит в несколько шагов. После прыжка одним событием Radix считает точку внутри
        // коридора к подсказке (grace area) и оставляет подсказку открытой (прогон 20261016-065145).
        await page.mouse.move(0, 0, { steps: 5 });
        for (let i = 0; i < 25 && (await chip.getAttribute("aria-describedby")); i++) await sleep(200);
      }
    } finally {
      await page.mouse.move(0, 0, { steps: 5 });
    }

    // Меню «Действия»: пункта «Изменить бюджет» нет, остальные пункты на месте.
    const menu = page.getByRole("menu");
    let items = [];
    let menuShot = "";
    try {
      await header.getByRole("button", { name: "Действия", exact: true }).click();
      await menu.waitFor({ timeout: 5_000 });
      // Меню появляется анимацией (fade-in, zoom-in): без ожидания снимок полупрозрачный.
      await settleAnimations(menu);
      items = (await menu.getByRole("menuitem").allInnerTexts()).map(squash);
      menuShot = await shot("session-actions-menu");
    } finally {
      if (await menu.count()) {
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
      }
    }
    const budgetItems = items.filter((item) => /бюджет/i.test(item));
    if (budgetItems.length) problems.push(`в меню «Действия» пункт ${budgetItems.map((item) => `«${item}»`).join(", ")}: ${JSON.stringify(items)}`);
    for (const item of ["Прервать", "Задать результат…", "Архивировать"]) {
      if (!items.includes(item)) problems.push(`в меню «Действия» нет пункта «${item}»: ${JSON.stringify(items)}`);
    }
    items.filter((item) => !budgetItems.includes(item)).forEach((item) => found("пункт меню «Действия»", item));

    // Вкладка «Сессия»: свойства и таблица «Использование» с активным временем.
    await inspectorTab("Сессия").click();
    const panel = inspector.getByRole("tabpanel", { name: "Сессия" });
    await panel.waitFor({ timeout: 15_000 });
    const usageTable = panel.getByRole("table", { name: "Использование" });
    const rows = await usageTable.waitFor({ timeout: 15_000 })
      .then(() => usageTable.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.trim()).join(" "))), () => null);
    if (rows === null) problems.push("на вкладке «Сессия» нет таблицы «Использование»");
    else if (!rows.some((row) => row.startsWith("Активное время"))) problems.push(`в таблице «Использование» нет строки «Активное время»: ${JSON.stringify(rows)}`);
    found("вкладка «Сессия»", await panel.innerText());
    const budgetButtons = await page.getByRole("button", { name: /бюджет/i }).count();
    if (budgetButtons) problems.push(`на странице кнопка «Изменить бюджет» (${budgetButtons} шт., components/session/inspector/SessionTab.tsx)`);
    const noPrice = await page.getByText("нет цены").count();
    if (noPrice) problems.push(`на странице текст «нет цены» (${noPrice} шт.)`);
    const tabShot = await shot("session-tab");

    assert(problems.length === 0, `${problems.join("; ")}. Снимки ${menuShot || "меню не открылось"}, ${tabShot}`);
    return `${menuShot}, ${tabShot}; чипы шапки ${chips.join(", ")}; подсказки: ${tips.join(", ")}; меню «Действия»: ${items.join(", ")}; ` +
      `«Использование»: ${(rows ?? []).join(", ")}; в журнале запросов к модели ${requestEnds.length}, с model_usage ${usageSum.withUsage} (вход ${usageSum.input}, выход ${usageSum.output}), ${pageEventsFile}`;
  });
  cover("session-no-usage");

  await check("session.ui_inspector", "инспектор справа: закрывается крестиком, открывается кнопкой «Инспектор», в адресе inspector=, ширина 360..720 px, 5 вкладок: Сессия, События, Инструменты, Ресурсы, Потоки", async () => {
    await inspector.waitFor({ timeout: 15_000 });
    await inspector.getByRole("button", { name: "Закрыть инспектор" }).click();
    await inspector.waitFor({ state: "detached", timeout: 10_000 });
    assert(urlParam("inspector") === null, `инспектор закрыт, а в адресе inspector=${urlParam("inspector")}`);
    const closedShot = await shot("session-inspector-closed");
    await page.getByRole("button", { name: "Инспектор", exact: true }).click();
    await inspector.waitFor({ timeout: 10_000 });
    const tabs = (await inspector.getByRole("tablist", { name: "Вкладки инспектора" }).getByRole("tab").allInnerTexts()).map(squash);
    const want = ["Сессия", "События", "Инструменты", "Ресурсы", "Потоки"];
    assert(JSON.stringify(tabs) === JSON.stringify(want), `вкладки ${JSON.stringify(tabs)}, ожидались ${JSON.stringify(want)}`);
    assert(urlParam("inspector"), `после открытия в адресе нет inspector=: ${page.url()}`);
    const box = await inspector.boundingBox();
    assert(box && box.width >= 360 && box.width <= 720, `ширина инспектора ${box?.width} px, ожидалось 360..720`);
    return `${closedShot}, ${await shot("session-inspector")}; ширина ${Math.round(box.width)} px`;
  });
  cover("session-inspector");

  // Клик по строке вызова в ленте (ToolRow в components/session/CanonicalSessionTurn.tsx) раскрывает вызов,
  // ставит ?event=<id agent.tool_use> и выделяет ту же строку на вкладке «События» (раздел 7 docs/plans/session-page.md).
  const toolRow = article.locator(`[data-tool-call][data-event-id="${turnToolUse?.id}"]`);
  await check("run.ui_tool_card", "в разговоре строка вызова bash раскрывается кликом: блок команды и вывод с маркером", async () => {
    assert(turnToolUse?.id, "в журнале нет agent.tool_use bash этого хода");
    // «События» открыты до клика: выбор из ленты должен выделить строку там (session.ui_select_sync).
    await inspectorTab("События").click();
    await eventsTable.waitFor({ timeout: 15_000 });
    await toolRow.waitFor({ timeout: 15_000 });
    assert((await toolRow.getAttribute("data-open")) !== "true", "вызов раскрыт до клика: выбор остался от прошлого шага");
    await toolRow.locator("button[aria-expanded]").first().click();
    await toolRow.locator("[data-tool-details] [data-tool-output]", { hasText: `VERIFY_OK_${nonce}` }).waitFor({ timeout: 15_000 });
    const command = squash(await toolRow.locator("[data-tool-command]").first().innerText());
    assert(command.includes(`VERIFY_OK_${nonce}`), `в блоке команды нет маркера: «${command.slice(0, 160)}»`);
    return shot("turn-tool-card");
  });
  cover("session-tool-card");
  await check("session.ui_select_sync", "клик по строке вызова в разговоре ставит ?event=<id agent.tool_use> и выделяет эту строку на вкладке «События» с её JSON", async () => {
    const id = turnToolUse?.id;
    assert(id, "в журнале нет agent.tool_use bash этого хода");
    assert(urlParam("event") === id, `в адресе event=${urlParam("event")}, ожидался ${id}`);
    const selected = await waitSelectedRow(id);
    assert(selected === "true", `строка [data-event-id="${id}"] на вкладке «События»: aria-selected=${selected}`);
    const rows = await eventsTable.locator('[role="row"][aria-selected="true"]').count();
    assert(rows === 1, `выделено строк: ${rows}, ожидалась одна`);
    const json = await selectedJson(id);
    assert(json.includes(`"id": "${id}"`), `JSON выбранного события без "id": "${id}": «${squash(json).slice(0, 200)}»`);
    return `${screens.at(-1).file}; event=${id}`;
  });
  cover("session-select-sync");
  await check("run.ui_tool_output_text", "вывод bash в раскрытом вызове показан текстом: kernel= на своей строке, без JSON-обёртки content-блоков и литералов \\n", async () => {
    const content = toolRow.locator("[data-tool-output]").first();
    const text = await content.innerText();
    writeFileSync(join(EV, "api", "45-tool-card-text.txt"), text);
    const problems = [];
    if (!text.includes(`VERIFY_OK_${nonce}`)) problems.push(`нет VERIFY_OK_${nonce}`);
    if (/"type":\s*"text"/.test(text)) problems.push("виден JSON-массив content-блоков (\"type\": \"text\")");
    if (text.includes("\\n")) problems.push("литералы \\n вместо переносов");
    if (text.includes("\\u001b")) problems.push("литералы \\u001b (ANSI)");
    if (!text.split("\n").some((line) => line.trim().startsWith("kernel="))) problems.push("kernel= не на отдельной строке");
    assert(problems.length === 0, `${problems.join("; ")} (api/45-tool-card-text.txt). Текст вывода готовит formatToolOutput (lib/tool-output.ts), блок рисует ToolDetails (components/session/CanonicalSessionTurn.tsx, data-tool-output)`);
    return "api/45-tool-card-text.txt";
  });
  await check("run.ui_tool_duration", "длительность в строке вызова bash совпадает с журналом (agent.tool_use → agent.tool_result) и не 0", async () => {
    const result = runTurn.pair?.toolResult;
    const actual = (Date.parse(result?.processed_at ?? "") - Date.parse(turnToolUse?.processed_at ?? "")) / 1000;
    assert(Number.isFinite(actual), `нет processed_at у agent.tool_use или agent.tool_result: ${turnToolUse?.processed_at}, ${result?.processed_at}`);
    const labels = (await toolRow.locator("button[aria-expanded] [data-search-skip]").allInnerTexts()).map(squash).filter(Boolean);
    const label = labels.find((l) => shortDurationSeconds(l) !== null) ?? null;
    const shown = label === null ? null : shortDurationSeconds(label);
    assert(shown !== null, `в строке вызова нет длительности; подписи: ${JSON.stringify(labels)}`);
    // Подпись округлена до 0,1 с (до секунды после минуты); время событий живого потока может
    // отличаться от журнала на десятки миллисекунд.
    const tolerance = actual >= 60 ? 1 : 0.25;
    assert(shown > 0 && Math.abs(shown - actual) <= tolerance, `в строке «${label}» (${shown} с), по журналу ${actual.toFixed(3)} с`);
    return `«${label}», по журналу ${actual.toFixed(3)} с`;
  });

  await check("session.ui_events", "вкладка «События»: строки user.message и agent.tool_use хода с маркером (id из GET /events), выбор строки показывает JSON события с тем же id", async () => {
    assert(turnUser?.id && turnToolUse?.id, `в журнале нет user.message или agent.tool_use хода: ${turnUser?.id}, ${turnToolUse?.id}`);
    await inspectorTab("События").click();
    await eventsTable.waitFor({ timeout: 15_000 });
    assert(urlParam("inspector") === "events", `в адресе inspector=${urlParam("inspector")}, ожидалось events`);
    const seen = [];
    for (const [event, type, marker] of [[turnUser, "user.message", `nonce=${nonce}`], [turnToolUse, "agent.tool_use", `VERIFY_OK_${nonce}`]]) {
      const row = eventRow(event.id);
      await row.waitFor({ timeout: 15_000 }).catch(() => {});
      const total = await eventsTable.locator('[role="row"][data-event-id]').count();
      assert((await row.count()) === 1, `нет строки [data-event-id="${event.id}"] (${type}); строк событий ${total}`);
      const cellType = squash(await row.getByRole("cell").first().innerText());
      assert(cellType === type, `в строке ${event.id} тип «${cellType}», ожидался ${type}`);
      await row.click();
      assert(urlParam("event") === event.id, `после клика по строке в адресе event=${urlParam("event")}, ожидался ${event.id}`);
      const json = await selectedJson(event.id);
      assert(json.includes(`"id": "${event.id}"`), `JSON выбранного события без "id": "${event.id}": «${squash(json).slice(0, 200)}»`);
      assert(squash(json).includes(`Событие ${type}`), `заголовок панели не «Событие ${type}»: «${squash(json).slice(0, 80)}»`);
      assert(json.includes(`"type": "${type}"`) && json.includes(marker), `в JSON ${type} нет "type": "${type}" или маркера ${marker}`);
      assert((await row.getAttribute("aria-selected")) === "true", `строка ${event.id} не выделена после клика`);
      seen.push(`${type} ${event.id}`);
    }
    return `${await shot("session-inspector-events")}; ${seen.join(", ")}`;
  });
  cover("session-inspector-events");

  await check("session.ui_tools", "вкладка «Инструменты»: строка bash с 1 вызовом и 0 ошибок, как в журнале (agent.tool_use bash и agent.tool_result без is_error)", async () => {
    const apiBash = pageEvents.filter((e) => e.type === "agent.tool_use" && e.name === "bash");
    const apiFailed = pageEvents.filter((e) => e.type === "agent.tool_result" && e.is_error === true && apiBash.some((u) => u.id === e.tool_use_id));
    if (FAKE) assert(apiBash.length === 1 && apiFailed.length === 0, `по журналу bash вызван ${apiBash.length} раз, ошибок ${apiFailed.length}; ожидался 1 вызов без ошибки`);
    await inspectorTab("Инструменты").click();
    const table = inspector.getByRole("table", { name: "Инструменты" });
    await table.waitFor({ timeout: 15_000 });
    const rows = await table.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.trim())));
    const bash = rows.find((cells) => cells[0] === "bash");
    assert(bash, `нет строки bash; строки: ${JSON.stringify(rows)}`);
    assert(bash[2] === String(apiBash.length) && bash[3] === String(apiFailed.length),
      `bash: вызовов «${bash[2]}», ошибок «${bash[3]}»; по журналу ${apiBash.length} и ${apiFailed.length}. Таблицу считает computeToolStats (lib/session-stats.ts), рисует ToolsTab`);
    return `${await shot("session-inspector-tools")}; bash ${JSON.stringify(bash)}`;
  });
  cover("session-inspector-tools");

  await check("session.ui_minimap", "мини-карта «Карта хода»: отрезок реплики пользователя и по отрезку на каждый запрос к модели (span.model_request_start), наведение показывает карточку с именем агента", async () => {
    const minimap = page.getByRole("group", { name: "Карта хода" });
    await minimap.waitFor({ timeout: 10_000 });
    const segments = await minimap.locator("[data-minimap-segment]").evaluateAll((els) => els.map((el) => {
      const box = el.getBoundingClientRect();
      return { kind: el.dataset.kind, width: box.width, height: box.height, label: el.getAttribute("aria-label") };
    }));
    const starts = pageEvents.filter((e) => e.type === "span.model_request_start").length;
    const requests = segments.filter((s) => s.kind === "request" || s.kind === "error");
    const users = segments.filter((s) => s.kind === "user");
    assert(users.length >= 1, `нет отрезка реплики пользователя; отрезки: ${JSON.stringify(segments)}`);
    assert(requests.length === starts, `отрезков запросов ${requests.length}, в журнале span.model_request_start ${starts}`);
    const hidden = segments.filter((s) => s.width < 1 || s.height < 1);
    assert(hidden.length === 0, `невидимые отрезки: ${JSON.stringify(hidden)}`);
    await minimap.locator('[data-minimap-segment][data-kind="request"]').first().hover();
    const card = page.getByTestId("minimap-card");
    await card.waitFor({ timeout: 5_000 });
    const cardText = squash(await card.innerText());
    assert(cardText.includes(names.agent), `карточка отрезка без имени агента ${names.agent}: «${cardText}»`);
    const file = await shot("session-minimap-hover");
    await page.mouse.move(0, 0);
    return `${file}; отрезков ${segments.length}: реплик ${users.length}, запросов ${requests.length}`;
  });
  cover("session-minimap");

  await check("session.ui_search", `поиск «Найти в разговоре» находит маркер хода ${nonce}: счётчик 1/N (N ≥ 2: реплика и ответ), подсветка совпадений, метки на мини-карте`, async () => {
    const search = page.getByRole("searchbox", { name: "Найти в разговоре" });
    await search.fill(nonce);
    const counter = page.getByTestId("match-counter");
    await counter.waitFor({ timeout: 10_000 });
    let counted = "";
    for (let i = 0; i < 20; i++) {
      counted = squash(await counter.innerText());
      if (/^1\/\d+$/.test(counted)) break;
      await sleep(250);
    }
    const total = Number(counted.match(/^1\/(\d+)$/)?.[1] ?? 0);
    assert(total >= 2, `счётчик совпадений «${counted}», ожидалось 1/N при N ≥ 2`);
    const ranges = await page.evaluate(() => {
      const all = globalThis.CSS?.highlights?.get("session-search");
      return all ? [...all].map((range) => range.toString()) : null;
    });
    assert(ranges && ranges.length >= 1, "нет подсветки совпадений (CSS.highlights «session-search»)");
    assert(ranges.every((text) => text.toLowerCase() === nonce), `подсвечено не то: ${JSON.stringify(ranges.slice(0, 5))}`);
    const marks = await page.locator("[data-session-minimap] [data-minimap-match]").count();
    assert(marks >= 1, "на мини-карте нет меток совпадений");
    const file = await shot("session-search");
    await search.fill("");
    return `${file}; совпадений ${total}, подсвечено ${ranges.length}, меток на мини-карте ${marks}`;
  });
  cover("session-search");

  const filename = `verify-${nonce}.txt`;
  // С 19ea4b9 строка файла агента это кнопка просмотра, рядом кнопка «Скачать <имя>» (ResourcesTab.tsx).
  await check("run.ui_files", `на вкладке «Ресурсы» инспектора есть выходной файл /mnt/session/outputs/${filename}: строка открывает просмотр, «Скачать» отдаёт файл`, async () => {
    await inspectorTab("Ресурсы").click();
    const row = inspector.getByRole("button", { name: `/mnt/session/outputs/${filename}` });
    await row.waitFor({ timeout: 15_000 });
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15_000 }),
      inspector.getByRole("button", { name: `Скачать ${filename}` }).click(),
    ]);
    assert(download.suggestedFilename() === filename, `скачан файл ${download.suggestedFilename()}`);
    const body = readFileSync(await download.path(), "utf8");
    assert(body.includes(`VERIFY_OK_${nonce}`), `в скачанном файле «${body.slice(0, 80)}»`);
    return shot("session-files");
  });
  cover("session-files");

  // 390 px: оболочка консоли прокручивает main, поэтому проверяются и документ, и main.
  // Прокрутка вправо до упора должна остаться на нуле.
  await check("session.ui_mobile_390", "на 390 px у страницы сессии нет горизонтальной прокрутки (документ и main): с закрытым инспектором и с нижним листом «События»", async () => {
    const results = [];
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const [label, query] of [["инспектор закрыт", ""], ["лист «События»", "?inspector=events"]]) {
        await page.goto(`${BASE}/sessions/${ids.session}${query}`);
        await page.locator("article[data-turn-id] [data-session-turn-prompt]", { hasText: `nonce=${nonce}` }).first().waitFor({ timeout: 30_000 });
        if (!query && (await inspector.count())) await inspector.getByRole("button", { name: "Закрыть инспектор" }).click();
        if (query) await eventsTable.waitFor({ timeout: 15_000 });
        await settleAnimations(page.locator("body"));
        const m = await page.evaluate(() => {
          const doc = document.scrollingElement ?? document.documentElement;
          const main = document.querySelector("main");
          window.scrollTo(10_000, window.scrollY);
          if (main) main.scrollLeft = 10_000;
          const width = window.innerWidth;
          // Подсказка для разбора: самые правые элементы за краем экрана вне своих прокруток.
          const scrolls = (el) => { const x = getComputedStyle(el).overflowX; return x === "auto" || x === "scroll" || x === "hidden" || x === "clip"; };
          const outside = [...document.querySelectorAll("body *")].filter((el) => {
            const box = el.getBoundingClientRect();
            if (box.width < 1 || box.right <= width + 1) return false;
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (p !== main && scrolls(p)) return false;
            return true;
          }).slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 2).join(".")} right=${Math.round(el.getBoundingClientRect().right)}`);
          return {
            docExtra: doc.scrollWidth - doc.clientWidth,
            mainExtra: main ? main.scrollWidth - main.clientWidth : 0,
            scrollX: window.scrollX,
            mainScrollLeft: main ? main.scrollLeft : 0,
            outside,
          };
        });
        results.push({ label, ...m, shot: await shot(`session-390-${query ? "events" : "page"}`) });
      }
    } finally {
      await page.setViewportSize(VIEW);
    }
    const bad = results.filter((r) => r.docExtra > 0 || r.mainExtra > 0 || r.scrollX > 0 || r.mainScrollLeft > 0);
    assert(bad.length === 0, bad.map((r) => `${r.label}: документ шире на ${r.docExtra} px, main на ${r.mainExtra} px, scrollX=${r.scrollX}, main.scrollLeft=${r.mainScrollLeft}; за краем: ${r.outside.join("; ") || "нет"}`).join(" | "));
    return results.map((r) => `${r.label}: ${r.shot}`).join(", ");
  });
  cover("session-mobile");
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
    // Усилие из формы агента доходит до модели: Pi переводит model.effort в уровень
    // размышлений (thinkingLevel в buildHarnessContext, apps/main-node/src/modules/node-managed.ts),
    // pi-ai шлёт его как thinking {type: "adaptive"} и output_config.effort. База: технический
    // агент пробы без усилия, его запросы идут без output_config.effort.
    const probeReqs = fakeRequests(probeNonce);
    const okEffort = await check("run.fake_model_effort", `усилие «${AGENT_EFFORT.label}» из формы дошло до модели: в каждом запросе хода output_config.effort=${AGENT_EFFORT.level}, thinking adaptive; у агента пробы без усилия effort нет`, () => {
      assert(reqs.length > 0, "нет запросов хода в журнале фейка");
      const seen = reqs.map((r) => `${r.thinking ?? "-"}/${r.effort ?? "-"}`);
      assert(reqs.every((r) => r.effort === AGENT_EFFORT.level && r.thinking === "adaptive"),
        `thinking/effort запросов хода: ${seen.join(", ")}; путь: model.effort агента → thinkingLevel (createPiModelRuntime) → pi-ai anthropic-messages`);
      assert(probeReqs.length > 0 && probeReqs.every((r) => r.effort === null),
        `у агента пробы без усилия: ${probeReqs.map((r) => r.effort ?? "-").join(", ") || "нет запросов"}`);
      return `api/fake-model-requests.jsonl: ход ${seen.join(", ")}; проба ${probeReqs.map((r) => `${r.thinking ?? "-"}/${r.effort ?? "-"}`).join(", ")}`;
    });
    if (okEffort) cover("agent-effort");
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
    const text = readFileSync(join(dir, file), "utf8");
    // Подфункции отдельных сценариев (пометка «<!-- scenario: … -->») считает их сценарий.
    if (text.includes("<!-- scenario: ")) continue;
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
    ["env.probe_path", "проба окружения сделана техническим агентом по API: действия «проверить окружение» нет ни в консоли, ни в API"],
    ...(run.SANDBOX_IMAGE_CATALOG
      ? [["env.office_path", `окружение с образом ${OFFICE_IMAGE_KEY} создано по API: выбор образа в разделе «Образ» карточки сценарий не ведёт (подфункция env-image)`]]
      : []),
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
    `- URL: ${BASE}, режим модели: ${run.MODEL_MODE}, модель агента: ${MODEL} (усилие ${AGENT_EFFORT.level}, задано в форме), образ песочницы: ${run.SANDBOX_IMAGE}`,
    `- git ${run.GIT_REV}, незакоммиченных файлов: консоль ${run.CONSOLE_DIRTY_FILES}, сервер ${run.SERVER_DIRTY_FILES}; хэши изменений: консоль ${run.CONSOLE_TREE_HASH}, сервер ${run.SERVER_TREE_HASH}`,
    `- данные (удаляются cleanup.sh): ${run.DATA_DIR}`,
    `- учётка: ${user.email}, рабочее пространство ${user.tenant_id}`,
    `- окружение ${ids.environment ?? "—"} (${names.env}), агент ${ids.agent ?? "—"} (${names.agent}), сессия ${ids.session ?? "—"} (${names.session})`,
    `- проба окружения: агент ${ids.probeAgent ?? "—"}, сессии ${ids.probeSession ?? "—"} (nonce ${probeNonce}) и ${ids.settingsSession ?? "—"} после настроек (nonce ${settingsNonce}); ход агента: nonce ${nonce}`,
    run.SANDBOX_IMAGE_CATALOG
      ? `- каталог образов: ${run.SANDBOX_IMAGE_CATALOG}, папка образов ${run.SANDBOX_IMAGE_DIR}; окружение ${OFFICE_IMAGE_KEY} ${ids.officeEnvironment ?? "—"} (${names.officeEnv ?? "—"}), сессия ${ids.officeSession ?? "—"}`
      : "- каталог образов выключен: launch.sh без VERIFY_SANDBOX_IMAGE_CATALOG и VERIFY_SANDBOX_IMAGE_DIR",
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
  page.on("response", (response) => {
    if (isCatalogUrl(response.url())) catalogRequests.push({ status: response.status(), page: new URL(page.url()).pathname, at: new Date().toISOString() });
  });
  page.on("requestfailed", (request) => {
    if (isCatalogUrl(request.url())) catalogRequests.push({ status: 0, failure: request.failure()?.errorText ?? "", page: new URL(page.url()).pathname, at: new Date().toISOString() });
  });
  log(`процессов браузера записано в state/pids: ${recordJourneyChildren()}`);
  // critical=false: сбой шага пишется провалом, а сценарий идёт дальше (настройки окружения
  // не нужны агенту и сессии). Сбой обязательного шага прерывает сценарий.
  let settingsOk = true;
  for (const [name, fn, critical, enabled] of [
    ["вход", stepLogin, true],
    ["окружение", stepCreateEnvironment, true],
    ["проба окружения", stepProbeEnvironment, true],
    ["образы каталога", stepCatalogImages, false],
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
