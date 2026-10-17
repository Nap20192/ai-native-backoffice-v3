// Решения фейковой модели для сценария builder (journey-builder.mjs, docs/plans/builder-agent.md с 6.2 по 6.7).
// Модуль подключает fake-model.mjs: decideBuilder(body) отдаёт решение или null, если маркера нет.
//
// Маркер в реплике пользователя: «VERIFY_BUILDER nonce=<n>» или «VERIFY_BUILDER_<ВИД> nonce=<n>».
// Строки «Ключ: значение» той же реплики несут id объектов (Модель, Файл, Цель, Версия, Окружение,
// Сессия, Навык, Хранилище и другие). Шаг сценария равен числу результатов инструментов после маркера.
// Для всех видов, кроме CHILD и TOOLS, модель проверяет состав tools запроса: каждое имя начинается
// с mcp__platform__, и нужный инструмент есть. Иначе ответ «VERIFY_FAIL_<n>: …».
//
// Канарейки (6.7): scanCanaries(raw, file) ищет каждое контрольное значение в сыром теле запроса до
// разбора. Значение из 3 знаков и короче ищется только в строке «пароль: <значение>».
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const BUILDER_MARKER = /VERIFY_BUILDER(?:_([A-Z0-9]+))? nonce=([a-z0-9]+)/;
const PLATFORM = "mcp__platform__";

/** Текст блока. Результат MCP встроенного цикла приходит строкой JSON {content, isError}. */
function textOf(content) {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block) => {
            if (!block || typeof block !== "object") return "";
            if (block.type === "text") return String(block.text ?? "");
            if (block.type === "tool_result") return textOf(block.content);
            return "";
          })
          .join("\n")
      : "";
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

const isToolResultMessage = (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === "tool_result");

/** Строки «Ключ: значение» реплики. Ключ одно слово, значение до конца строки. */
function linesOf(text) {
  const map = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-zА-Яа-яЁё_]+): (.+)$/);
    if (m && !(m[1] in map)) map[m[1]] = m[2].trim();
  }
  return map;
}

/** Последняя реплика пользователя с маркером builder и результаты инструментов после неё. */
function locate(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user" || isToolResultMessage(m)) continue;
    const text = textOf(m.content);
    const found = text.match(BUILDER_MARKER);
    if (!found) continue;
    const results = [];
    for (const later of messages.slice(i + 1)) {
      if (!Array.isArray(later?.content)) continue;
      for (const block of later.content) {
        if (block?.type !== "tool_result") continue;
        const text = textOf(block.content);
        results.push({ text: textOf(text), isError: block.is_error === true });
      }
    }
    return { sub: found[1] ?? "MAIN", nonce: found[2], text, lines: linesOf(text), results };
  }
  return null;
}

const call = (tool, input, extra = {}) => ({ reply: { tool: PLATFORM + tool, input }, decision: `call_${tool}`, ...extra });
const say = (text, extra = {}) => ({ reply: { text }, decision: "final_text", ...extra });
const idAfter = (text, re) => text.match(re)?.[1] ?? null;
const allText = (results) => results.map((r) => r.text).join("\n");
const brief = (text) => String(text ?? "").replace(/\s+/g, " ").slice(0, 300);

// ---------------------------------------------------------------- сценарии ---

/** 6.2: чтение, пачка, деплоймент на паузе, правка, сессия, первое сообщение. */
function mainScript(n, L, R) {
  const step = R.length;
  const joined = allText(R);
  const envId = idAfter(joined, /Создано окружение «[^»]*», id (\S+?)(?:[,\s]|$)/);
  const agentId = idAfter(joined, /Создан агент «[^»]*», id (\S+?)(?:[,\s]|$)/);
  const sessionId = idAfter(joined, /Создана сессия (\S+?),/);
  const failIfError = (index, what) =>
    R[index]?.isError ? say(`VERIFY_FAIL_${n}: ${what} вернул ошибку: ${brief(R[index].text)}`, { decision: "fail" }) : null;
  switch (step) {
    case 0:
      return call("search_docs", { query: "навык" });
    case 1:
      return failIfError(0, "search_docs") ?? call("list", { kind: "models" });
    case 2: {
      const skillName = `vb-skill-${n}`;
      return failIfError(1, "list") ?? call("apply_changes", {
        title: `Рабочее место vb-${n}`,
        operations: [
          { ref: "env", tool: "create_environment", args: { config: { name: `vb-env-${n}`, config: { type: "cloud", networking: { type: "unrestricted" } } } } },
          {
            ref: "skill",
            tool: "create_skill",
            args: {
              display_title: skillName,
              files: [
                { path: `${skillName}/SKILL.md`, content: `---\nname: ${skillName}\ndescription: Проверочный навык VB_SKILL_${n}. Use it when the verify scenario asks for the hello script.\n---\n\n# VB_SKILL_${n}\n\nЗапусти scripts/hello.sh.\n` },
                { path: `${skillName}/scripts/hello.sh`, content: `#!/bin/sh\necho hello-${n}\n` },
              ],
            },
          },
          {
            ref: "agent",
            tool: "create_agent",
            args: { config: { name: `vb-agent-${n}`, model: L["Модель"], system: `Ты проверочный агент vb-${n}.`, skills: [{ type: "custom", skill_id: { $ref: "skill" } }] } },
          },
        ],
      });
    }
    case 3:
      return failIfError(2, "apply_changes") ?? call("create_deployment", {
        name: `vb-dep-${n}`,
        agent: { id: agentId },
        environment_id: envId,
        initial_events: [{ type: "user.message", content: [{ type: "text", text: `Плановый запуск vb-${n}` }] }],
        schedule: { cron: "* * * * *", timezone: "UTC" },
      });
    case 4:
      return failIfError(3, "create_deployment") ?? call("update_agent", { agent_id: agentId, expected_version: 1, changes: { system: `Ты проверочный агент vb-${n}, версия 2.` } });
    case 5:
      return failIfError(4, "update_agent") ?? call("create_session", {
        agent: { id: agentId, version: 2 },
        environment_id: envId,
        title: `vb-session-${n}`,
        files: [{ file_id: L["Файл"] }],
      });
    case 6:
      return failIfError(5, "create_session") ?? call("send_message", { session_id: sessionId, text: `VERIFY_BUILDER_CHILD nonce=${n}` });
    default:
      return failIfError(6, "send_message") ?? say(`Готово: окружение, навык, агент, деплоймент на паузе и сессия с первым сообщением. VERIFY_BUILDER_MAIN_DONE_${n}`);
  }
}

/** Один вызов по строкам реплики, затем текст с итогом вызова. */
function oneCall(n, R, makeCall, doneWord) {
  if (R.length === 0) return makeCall();
  const last = R[R.length - 1];
  return say(`${doneWord}_${n} error=${last.isError} text=${brief(last.text)}`, { resultIsError: last.isError });
}

function denyScript(n, L, R) {
  return oneCall(n, R, () => call("update_agent", { agent_id: L["Цель"], expected_version: Number(L["Версия"]), changes: { description: `VB deny ${n}` } }), "VERIFY_BUILDER_DENIED");
}

function bypassScript(n, L, R) {
  return oneCall(n, R, () => call("update_agent", { agent_id: L["Цель"], expected_version: Number(L["Версия"]), changes: { system: `VB_BYPASS_${n}` } }), "VERIFY_BUILDER_BYPASS_RESULT");
}

function offScript(n, L, R) {
  if (R.length === 0) return call("list", { kind: "agents" });
  if (R.length === 1) return call("update_agent", { agent_id: L["Цель"], expected_version: Number(L["Версия"]), changes: { system: `VB_OFF_${n}` } }, { listError: R[0].isError, listText: brief(R[0].text) });
  return say(`VERIFY_BUILDER_OFF_DONE_${n} list_error=${R[0].isError} update_error=${R[1].isError}`);
}

function foreignScript(n, L, R) {
  if (R.length === 0) return call("get", { kind: "agent", id: L["Цель"] });
  if (R.length === 1) return call("update_agent", { agent_id: L["Цель"], expected_version: 1, changes: { system: `VB_FOREIGN_${n}` } }, { getError: R[0].isError, getText: brief(R[0].text) });
  return say(`VERIFY_BUILDER_FOREIGN_DONE_${n} get_error=${R[0].isError} update_error=${R[1].isError}`);
}

/** 6.5: указания внутри файла и навыка. Текст должен прийти внутри <data source=…>. */
function injectScript(n, L, R, sub) {
  const wrapped = (r) => /<data source="(file|skill_file|skill)"/.test(r.text) && !r.isError;
  if (sub === "INJECT2") {
    if (R.length === 0) return call("read_content", { kind: "file", id: L["Файл"] });
    if (R.length === 1) {
      if (!wrapped(R[0])) return say(`VERIFY_FAIL_${n}: текст файла пришёл не внутри <data>: ${brief(R[0].text)}`, { decision: "fail" });
      return call("update_agent", { agent_id: L["Цель"], expected_version: Number(L["Версия"]), changes: { system: "VB_EVIL" } });
    }
    return say(`VERIFY_BUILDER_INJECT2_DONE_${n} error=${R[1].isError} text=${brief(R[1].text)}`);
  }
  switch (R.length) {
    case 0:
      return call("read_content", { kind: "file", id: L["Файл"] });
    case 1:
      if (!wrapped(R[0])) return say(`VERIFY_FAIL_${n}: текст файла пришёл не внутри <data>: ${brief(R[0].text)}`, { decision: "fail" });
      return call("update_agent", { agent_id: L["Цель"], expected_version: Number(L["Версия"]), changes: { system: "VB_EVIL" } });
    case 2:
      return call("read_content", { kind: "skill_file", id: L["Навык"], path: "SKILL.md" });
    case 3:
      if (!wrapped(R[2])) return say(`VERIFY_FAIL_${n}: SKILL.md пришёл не внутри <data>: ${brief(R[2].text)}`, { decision: "fail" });
      return call("create_agent", { config: { name: `vb-evil-${n}`, model: L["Модель"], system: "VB_EVIL" } });
    case 4:
      return call("create_session", { agent: { id: L["Цель"] }, environment_id: L["Окружение"], title: `vb-evil-session-${n}` });
    case 5:
      return call("send_message", { session_id: L["Сессия"], text: "VB_EVIL" });
    default: {
      const writes = R.slice(1).filter((_, i) => i !== 1);
      return say(`VERIFY_BUILDER_INJECT_DONE_${n} write_errors=${writes.map((r) => r.isError).join(",")}`, {
        writeTexts: writes.map((r) => brief(r.text).slice(0, 120)),
      });
    }
  }
}

function staleScript(n, L, R) {
  return oneCall(n, R, () => call("update_agent", { agent_id: L["Цель"], expected_version: Number(L["Версия"]), changes: { system: `VB_STALE_${n}` } }), "VERIFY_BUILDER_STALE_DONE");
}

function classScript(n, L, R) {
  return oneCall(n, R, () => call("update_deployment", {
    deployment_id: L["Цель"],
    changes: { initial_events: [{ type: "user.message", content: [{ type: "text", text: `VB_CLASS_${n}` }] }] },
  }), "VERIFY_BUILDER_CLASS_DONE");
}

function mempathScript(n, L, R) {
  return oneCall(n, R, () => call("write_memory", { memory_store_id: L["Хранилище"], path: `/notes/${n}.md`, content: `VB_MODEL_NOTE_${n}` }), "VERIFY_BUILDER_MEMPATH_DONE");
}

function msgScript(n, L, R) {
  const created = idAfter(allText(R), /Создана сессия (\S+?),/);
  switch (R.length) {
    case 0:
      return call("create_session", { agent: { id: L["Цель"] }, environment_id: L["Окружение"], title: `vb-msg-session-${n}` });
    case 1:
      if (R[0].isError || !created) return say(`VERIFY_FAIL_${n}: create_session: ${brief(R[0].text)}`, { decision: "fail" });
      return call("send_message", { session_id: created, text: `VB_MSG_${n}` });
    case 2:
      return call("send_message", { session_id: L["Сессия"], text: `VB_MSG_FOREIGN_${n}` });
    default:
      return say(`VERIFY_BUILDER_MSG_DONE_${n} first_error=${R[1].isError} second_error=${R[2].isError}`);
  }
}

/**
 * Сценарий crud (journey-crud.mjs): опасные операции помощника. Сначала зависимости,
 * затем архив сессии, снова зависимости и удаление файла. Каждая запись ждёт клика
 * по красной карточке; сбой шага даёт VERIFY_FAIL_<n>.
 */
function crudScript(n, L, R) {
  const fail = (index, what) =>
    R[index]?.isError ? say(`VERIFY_FAIL_${n}: ${what}: ${brief(R[index].text)}`, { decision: "fail" }) : null;
  switch (R.length) {
    case 0:
      return call("get_dependencies", { kind: "session", id: L["Сессия"], operation: "archive" });
    case 1:
      return fail(0, "get_dependencies сессии") ?? call("archive_object", { kind: "session", id: L["Сессия"] });
    case 2:
      return fail(1, "archive_object") ?? call("get_dependencies", { kind: "file", id: L["Файл"], operation: "delete" });
    case 3:
      return fail(2, "get_dependencies файла") ?? call("delete_object", { kind: "file", id: L["Файл"] });
    default:
      return fail(3, "delete_object") ?? say(`VERIFY_BUILDER_CRUD_DONE_${n} archive=${brief(R[1].text)} delete=${brief(R[3].text)}`);
  }
}

/** Отказ: карточка удаления файла, пользователь жмёт «Отклонить». */
function crudDenyScript(n, L, R) {
  return oneCall(n, R, () => call("delete_object", { kind: "file", id: L["Файл"] }), "VERIFY_BUILDER_CRUDDENY_DONE");
}

/** 6.7: чтение всего, где лежат секреты и их копии. */
function secretsPlan(L) {
  const plan = [
    { tool: "list", input: { kind: "models" }, expectMask: false },
    { tool: "get", input: { kind: "agent", id: L["Агент"], version: 1 }, expectMask: true },
    { tool: "get", input: { kind: "agent", id: L["Агент"], version: 2 }, expectMask: true },
    { tool: "list", input: { kind: "credentials", filter: { vault_id: L["Хранилище_секретов"] } }, expectMask: false },
    { tool: "get", input: { kind: "deployment", id: L["Деплоймент"] }, expectMask: false },
  ];
  for (const id of String(L["Файлы"] ?? "").split(",").filter(Boolean)) plan.push({ tool: "read_content", input: { kind: "file", id }, expectMask: true });
  if (L["Навык"]) plan.push({ tool: "read_content", input: { kind: "skill_file", id: L["Навык"], path: "SKILL.md" }, expectMask: true });
  for (const pair of String(L["Записи"] ?? "").split(",").filter(Boolean)) {
    const [store, memory] = pair.split(":");
    plan.push({ tool: "read_content", input: { kind: "memory", id: store, memory_id: memory }, expectMask: true });
  }
  plan.push({ tool: "search_config", input: { query: L["Поиск"] }, expectMask: true });
  if (L["Сессия"]) plan.push({ tool: "get_session_events", input: { session_id: L["Сессия"] }, expectMask: true });
  return plan;
}

function shortValues(canaryFile) {
  const list = readCanaries(canaryFile);
  return list.filter((c) => c.value.length <= 6 && c.password).map((c) => c.value);
}

function secretsScript(n, L, R, canaryFile) {
  const plan = secretsPlan(L);
  if (R.length < plan.length) return call(plan[R.length].tool, plan[R.length].input);
  const problems = [];
  const shorts = shortValues(canaryFile);
  plan.forEach((item, i) => {
    const r = R[i];
    if (r.isError) problems.push(`${i}:${item.tool} ошибка ${brief(r.text).slice(0, 80)}`);
    else if (item.expectMask && !r.text.includes("[скрыто]")) problems.push(`${i}:${item.tool} без [скрыто]`);
    for (const m of r.text.matchAll(/пароль: (\S+)/g)) {
      if (shorts.some((v) => m[1].includes(v))) problems.push(`${i}:${item.tool} короткое значение не скрыто`);
    }
  });
  const masks = R.map((r) => (r.text.match(/\[скрыто\]/g) ?? []).length);
  if (problems.length) return say(`VERIFY_FAIL_${n}: ${problems.join("; ")}`, { decision: "fail", masks });
  return say(`VERIFY_BUILDER_SECRETS_DONE_${n} calls=${plan.length}`, { masks });
}

function rotateScript(n, L, R, sub) {
  if (R.length === 0) return call("read_content", { kind: "file", id: L["Файл"] });
  const r = R[0];
  if (sub === "ROTATE2" && (r.isError || !r.text.includes("[скрыто]"))) {
    return say(`VERIFY_FAIL_${n}: после ротации новое значение не скрыто`, { decision: "fail" });
  }
  return say(`VERIFY_BUILDER_${sub}_DONE_${n} masked=${r.text.includes("[скрыто]")}`);
}

/** Случайные строки того же алфавита, детерминированные по nonce. */
function decoys(seed, length, count) {
  const out = [];
  for (let k = 0; out.length < count; k++) {
    const hex = createHash("sha256").update(`${seed}:${length}:${k}`).digest("hex");
    const value = [...hex].map((ch, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[(parseInt(ch, 16) * 7 + i) % 36]).join("").slice(0, length);
    out.push(value);
  }
  return out;
}

export function oraclePlan(n, L, oracle) {
  const value = oracle.value;
  const store = L["Хранилище"];
  const plan = [];
  for (const len of [1, 2, 4, 8, value.length]) {
    plan.push({ tool: "search_config", input: { query: value.slice(0, len) }, group: `search:${len}`, real: true, query: value.slice(0, len) });
  }
  for (const len of [1, 2, 4, 8, value.length]) {
    const q = decoys(n, len, 1)[0];
    plan.push({ tool: "search_config", input: { query: q }, group: `search:${len}`, real: false, query: q });
  }
  for (const len of [1, 2, 4]) {
    plan.push({ tool: "list", input: { kind: "memories", filter: { memory_store_id: store, path_prefix: `/keys/${value.slice(0, len)}` } }, group: `list:${len}`, real: true, query: `/keys/${value.slice(0, len)}` });
  }
  for (const len of [1, 2, 4]) {
    const q = `/keys/${decoys(`${n}-l`, len, 1)[0]}`;
    plan.push({ tool: "list", input: { kind: "memories", filter: { memory_store_id: store, path_prefix: q } }, group: `list:${len}`, real: false, query: q });
  }
  const decoy = decoys(`${n}-p`, value.length, 1)[0];
  plan.push({ tool: "preview_change", input: { kind: "agent", id: L["Агент"], body: { system: `${value} ${decoy}` } }, group: "preview", decoy });
  plan.push({ tool: "get_session_events", input: { session_id: L["Своя"] }, group: "own" });
  return plan;
}

function oracleScript(n, L, R, oracleFile) {
  let oracle;
  try {
    oracle = JSON.parse(readFileSync(oracleFile, "utf8"));
  } catch {
    return say(`VERIFY_FAIL_${n}: нет файла oracle.json`, { decision: "fail" });
  }
  const plan = oraclePlan(n, L, oracle);
  if (R.length < plan.length) return call(plan[R.length].tool, plan[R.length].input);
  return say(`VERIFY_BUILDER_ORACLE_DONE_${n} calls=${plan.length}`);
}

// ------------------------------------------------------------------- вход ---

export function decideBuilder(body, { canaryFile, oracleFile } = {}) {
  const at = locate(body);
  if (!at) return null;
  const { sub, nonce: n, lines: L, results: R } = at;
  const toolNames = (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.name).filter(Boolean);
  const base = { kind: `BUILDER_${sub}`, nonce: n, toolNames, step: R.length };
  if (sub === "CHILD") return { ...base, ...say(`VERIFY_CHILD_DONE_${n}`) };
  if (sub === "TOOLS") {
    return { ...base, ...say(`VERIFY_BUILDER_TOOLS_SEEN_${n} tools=${toolNames.length}`), decision: "tools_seen" };
  }
  const foreign = toolNames.filter((name) => !name.startsWith(PLATFORM));
  if (foreign.length) return { ...base, ...say(`VERIFY_FAIL_${n}: в tools есть имена без ${PLATFORM}: ${foreign.join(", ")}`), decision: "fail_tools" };
  let d;
  switch (sub) {
    case "MAIN": d = mainScript(n, L, R); break;
    case "DENY": d = denyScript(n, L, R); break;
    case "BYPASS": d = bypassScript(n, L, R); break;
    case "OFF": d = offScript(n, L, R); break;
    case "FOREIGN": d = foreignScript(n, L, R); break;
    case "INJECT":
    case "INJECT2": d = injectScript(n, L, R, sub); break;
    case "STALE": d = staleScript(n, L, R); break;
    case "CLASS": d = classScript(n, L, R); break;
    case "MEMPATH": d = mempathScript(n, L, R); break;
    case "MSG": d = msgScript(n, L, R); break;
    case "SECRETS": d = secretsScript(n, L, R, canaryFile); break;
    case "ROTATE":
    case "ROTATE2": d = rotateScript(n, L, R, sub); break;
    case "ORACLE": d = oracleScript(n, L, R, oracleFile); break;
    case "CRUD": d = crudScript(n, L, R); break;
    case "CRUDDENY": d = crudDenyScript(n, L, R); break;
    default: d = say(`VERIFY_FAIL_${n}: неизвестный вид ${sub}`, { decision: "fail" });
  }
  if (d.reply.tool && !toolNames.includes(d.reply.tool)) {
    return { ...base, ...say(`VERIFY_FAIL_${n}: в tools нет ${d.reply.tool}`), decision: "fail_missing_tool" };
  }
  return { ...base, ...d };
}

// -------------------------------------------------------------- канарейки ---

export function readCanaries(file) {
  if (!file || !existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.values) ? parsed.values.filter((c) => typeof c?.value === "string" && c.value) : [];
  } catch {
    return [];
  }
}

/** Виды значения, которые ищет фейк: как есть, в JSON-строке, base64, base64url и URL-кодировка. */
export function canaryForms(value) {
  const b64 = Buffer.from(value, "utf8").toString("base64").replace(/=+$/, "");
  const forms = new Set([value, JSON.stringify(value).slice(1, -1), b64, Buffer.from(value, "utf8").toString("base64url"), encodeURIComponent(value)]);
  return [...forms].filter((f) => f.length >= 4 || f === value);
}

/** id канареек, найденных в сыром теле. Тело и значения в ответ не попадают. */
export function scanCanaries(raw, file) {
  const hits = [];
  for (const c of readCanaries(file)) {
    if (c.value.length <= 3) {
      if (raw.includes(`пароль: ${c.value}`)) hits.push(c.id);
      continue;
    }
    if (canaryForms(c.value).some((form) => raw.includes(form))) hits.push(c.id);
  }
  return hits;
}
