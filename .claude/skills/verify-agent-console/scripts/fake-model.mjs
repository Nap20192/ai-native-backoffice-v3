#!/usr/bin/env node
// Локальная фейковая модель для verify-agent-console.
// Отвечает в протоколе Anthropic Messages потоком SSE, как в
// platform/apps/main-node/test/_helpers/openai-node-process.ts.
//
// Поведение задаёт сообщение пользователя (его пишет journey-env-to-agent.mjs):
//   строка-маркер  "VERIFY_AGENT_RUN nonce=<n>" или "VERIFY_ENV_PROBE nonce=<n>";
//   строка         "Команда: <shell-команда>".
// Ход 1 (после сообщения нет tool_result): tool_use "bash" с этой командой.
//   Для VERIFY_AGENT_RUN перед tool_use идёт текстовый блок leadText(n) (больше 100
//   символов), как у настоящих моделей: в ходе два agent.message, и срез итогового
//   ответа на длину первого (streamPrefixes в @openma/common) виден в консоли.
// Ход 2 (tool_result есть): текст "VERIFY_DONE_<n>", если в результате есть
//   "VERIFY_OK_<n>", иначе "VERIFY_FAIL_<n>: ..." (сценарий это поймает).
//   Для VERIFY_AGENT_RUN вместо "VERIFY_DONE_<n>" идёт finalRunText(n): строка, блок
//   кода с VERIFY_DONE_<n> и строка после него. Оба текста пишутся в журнал (reply_text).
// Запрос без маркера получает текст FAKE_MODEL_NO_MARKER.
//
// Режим Claude Code (journey-claude-code.mjs): маркер "VERIFY_CLAUDE_CODE nonce=<n>".
// Основной запрос агента (в tools есть Write и Read):
//   1) tool_use Write {file_path: <рабочая папка>/verify.txt, content: "VERIFY_OK\n"};
//   2) после его tool_result: tool_use Read того же файла;
//   3) после результата Read с VERIFY_OK: tool_use Bash (контроль разрешений: Bash
//      не разрешён настройками агента, без режима обхода Claude Code его отклоняет);
//   4) после результата Bash: "VERIFY_CC_DONE_<n>", если Bash отклонён (is_error),
//      иначе "VERIFY_FAIL_<n>: ...". Сбой Write/Read тоже даёт VERIFY_FAIL_<n>.
//      Рабочая папка берётся из строки
//      "Primary working directory: <путь>" (без учёта регистра) из системного промпта
//      или сообщений Claude Code; без неё /workspace. Контрольная команда Bash:
//      touch <рабочая папка>/bash-ran-<n>.txt: при отказе файла в выводах нет.
// Второй ход той же сессии (маркер "VERIFY_CLAUDE_CODE nonce=<n> turn=2"):
//   1) tool_use Bash "ps -eo pid,ppid,args" (процессы VM: сколько живых claude-agent-acp);
//   2) tool_use Bash "ps eww -o args= -p <pid>": окружение главного процесса claude-agent-acp
//      (pid из вывода шага 1). Значения в журнал не пишутся: только имена переменных,
//      sha256 значений (12 знаков), ANTHROPIC_BASE_URL, ANTHROPIC_MODEL и первые 8 знаков
//      ANTHROPIC_AUTH_TOKEN (поле env);
//   3) после результата: "VERIFY_CC_TURN2_<n> acp_processes=<k>". В журнал пишутся
//      число процессов (acp_processes), их строки и есть ли в истории запроса
//      реплика первого хода (history_has_turn1: ACP-сессия возобновлена с историей).
// Служебные запросы Claude Code без инструментов (заголовок, тема) получают
// короткий текст. В журнал пишутся user-agent, sha256 ключа (12 знаков, не сам
// ключ), версия anthropic-beta и инструменты запроса.
// У каждого запроса в журнале есть thinking (тип thinking из тела) и effort
// (output_config.effort): так видно, дошло ли усилие агента до модели.
//
// Свой ACP-агент из карточки harness (acp-echo-agent.cjs) шлёт запрос без потока с
// маркером "VERIFY_ACP_CARD nonce=<n>" и получает текст "VERIFY_MODEL_SAW_<n>".
// POST …/chat/completions (проверка ключа карточки модели OpenAI при создании)
// получает короткий ответ OpenAI.
//
// Запуск: node fake-model.mjs --port 8792 --log <файл.jsonl>
// GET /health -> {"ok":true,"requests":N}. Каждый запрос модели пишется строкой в --log.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: process.env.VERIFY_FAKE_PORT ?? "8792" },
    host: { type: "string", default: "127.0.0.1" },
    log: { type: "string" },
  },
});

const MARKER = /VERIFY_(ENV_PROBE|AGENT_RUN) nonce=([a-z0-9]+)/;
const CC_MARKER = /VERIFY_CLAUDE_CODE nonce=([a-z0-9]+)/;
const CC_TURN2 = /VERIFY_CLAUDE_CODE nonce=[a-z0-9]+ turn=2/;
// Главный процесс ACP-агента в VM: "node /usr/local/bin/claude-agent-acp". Пути внутри
// пакета (…/claude-agent-acp/node_modules/…, дочерний Claude Code SDK) не считаются.
const ACP_PROCESS = /(^|[\s/])claude-agent-acp(\s|$)/;
const WORKDIR = /working directory:\s*`?(\/[^\s`]*)/i;
const COMMAND = /^Команда: (.+)$/m;
const CARD_MARKER = /VERIFY_ACP_CARD nonce=([a-z0-9]+)/;
let requestCount = 0;
const sha12 = (value) => (value ? createHash("sha256").update(String(value)).digest("hex").slice(0, 12) : null);

// Окружение процесса из вывода «ps eww -o args= -p <pid>»: «<команда> NAME=value …».
// Значение с пробелами режется на первом пробеле. Секретов в журнал не пишем.
function envFacts(text) {
  const vars = {};
  for (const token of String(text ?? "").split(/\s+/)) {
    const m = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !(m[1] in vars)) vars[m[1]] = m[2];
  }
  const auth = vars.ANTHROPIC_AUTH_TOKEN ?? "";
  return {
    names: Object.keys(vars).sort(),
    sha12: Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, sha12(value)])),
    anthropic_base_url: vars.ANTHROPIC_BASE_URL ?? null,
    anthropic_model: vars.ANTHROPIC_MODEL ?? null,
    auth_token_prefix: auth ? auth.slice(0, 8) : null,
  };
}

// Запрос своего ACP-агента из карточки harness: маркер в любой реплике пользователя.
function cardNonce(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of messages) {
    const found = m?.role === "user" ? textOf(m.content).match(CARD_MARKER) : null;
    if (found) return found[1];
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text") return String(block.text ?? "");
      if (block.type === "tool_result") return textOf(block.content);
      return "";
    })
    .join("\n");
}

const hasToolResult = (message) =>
  Array.isArray(message?.content) && message.content.some((block) => block?.type === "tool_result");

const toolResults = (message) =>
  Array.isArray(message?.content) ? message.content.filter((block) => block?.type === "tool_result") : [];

// Ход Claude Code: Write → Read → итоговый текст. null, если маркера режима нет.
function decideClaudeCode(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolNames = (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.name);
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && CC_MARKER.test(textOf(m.content))) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const [, nonce] = textOf(messages[start].content).match(CC_MARKER);
  if (!toolNames.includes("Write") || !toolNames.includes("Read")) {
    return { kind: "CLAUDE_CODE", nonce, decision: "cc_side", reply: { text: "VERIFY_SIDE" }, toolNames };
  }
  const system = typeof body.system === "string" ? body.system : textOf(body.system);
  // Claude Code 2.1 кладёт окружение («Primary working directory: …») в сообщение
  // с ролью system после реплики пользователя, поэтому ищем по всем сообщениям.
  const context = `${system}\n${messages.map((m) => textOf(m.content)).join("\n")}`;
  const workdir = context.match(WORKDIR)?.[1] ?? "/workspace";
  const dirHint = context.match(/.{0,80}[Dd]irectory.{0,120}/)?.[0] ?? null;
  const file = `${workdir.replace(/\/$/, "")}/verify.txt`;
  const results = messages.slice(start + 1).flatMap(toolResults);
  const base = { kind: "CLAUDE_CODE", nonce, workdir, dirHint, file, toolNames };
  const step = results.length;
  const last = results[step - 1];
  const lastText = last ? textOf(last.content) : "";
  const excerpt = lastText.slice(0, 500);
  const fail = (decision, why) => ({ ...base, decision, toolResultExcerpt: excerpt, reply: { text: `VERIFY_FAIL_${nonce}: ${why}` } });
  if (CC_TURN2.test(textOf(messages[start].content))) {
    const historyHasTurn1 = messages.slice(0, start).some((m) => m?.role === "user" && CC_MARKER.test(textOf(m.content)) && !CC_TURN2.test(textOf(m.content)));
    if (step === 0) {
      return { ...base, decision: "cc2_ps", historyHasTurn1, reply: { tool: "Bash", input: { command: "ps -eo pid,ppid,args", description: "list sandbox processes" } } };
    }
    // Результат 1: вывод ps (процессы). Результат 2: окружение главного claude-agent-acp.
    const psResult = results[0];
    const psText = textOf(psResult.content);
    const acpLines = psText.split("\n").filter((line) => ACP_PROCESS.test(line));
    const acpPid = acpLines[0]?.trim().split(/\s+/)[0] ?? "";
    const psFacts = {
      historyHasTurn1,
      acpProcesses: acpLines.length,
      acpLines: acpLines.map((line) => line.trim().slice(0, 200)),
      // Вывод ps без окружения: в нём нет токена хода.
      toolResultExcerpt: psText.slice(0, 500),
    };
    if (psResult.is_error) {
      return { ...base, ...psFacts, decision: "cc2_final_text", reply: { text: `VERIFY_FAIL_${nonce}: ps не выполнился: ${psText.slice(0, 200)}` } };
    }
    if (step === 1 && /^\d+$/.test(acpPid)) {
      return { ...base, ...psFacts, decision: "cc2_env", reply: { tool: "Bash", input: { command: `ps eww -o args= -p ${acpPid}`, description: "environment of the ACP process" } } };
    }
    const envResult = step >= 2 ? results[1] : null;
    return {
      ...base,
      ...psFacts,
      decision: "cc2_final_text",
      env: envResult && !envResult.is_error ? envFacts(textOf(envResult.content)) : null,
      envError: envResult?.is_error ? textOf(envResult.content).slice(0, 200) : null,
      reply: { text: `VERIFY_CC_TURN2_${nonce} acp_processes=${acpLines.length}` },
    };
  }
  if (step === 0) {
    return { ...base, decision: "cc_write", reply: { tool: "Write", input: { file_path: file, content: "VERIFY_OK\n" } } };
  }
  if (step === 1) {
    if (last.is_error) return fail("cc_write_failed", `Write вернул ошибку: ${lastText.slice(0, 200)}`);
    return { ...base, decision: "cc_read", toolResultExcerpt: excerpt, reply: { tool: "Read", input: { file_path: file } } };
  }
  if (step === 2) {
    if (last.is_error || !lastText.includes("VERIFY_OK")) return fail("cc_read_failed", `в результате Read нет VERIFY_OK: ${lastText.slice(0, 200)}`);
    // Контроль разрешений: Bash не в списке allow, без режима обхода он должен быть отклонён.
    return {
      ...base,
      decision: "cc_bash_probe",
      toolResultHasMarker: true,
      toolResultExcerpt: excerpt,
      // touch, а не echo: команды только для чтения Claude Code выполняет без запроса разрешения.
      reply: { tool: "Bash", input: { command: `touch ${workdir}/bash-ran-${nonce}.txt && echo VERIFY_BASH_RAN_${nonce}`, description: "permission probe" } },
    };
  }
  const denied = last.is_error === true;
  return {
    ...base,
    decision: "cc_final_text",
    bashDenied: denied,
    toolResultExcerpt: excerpt,
    reply: {
      text: denied
        ? `VERIFY_CC_DONE_${nonce}: файл ${file} содержит VERIFY_OK, Bash без разрешения отклонён`
        : `VERIFY_FAIL_${nonce}: Bash выполнился без разрешения`,
    },
  };
}

// Тексты хода агента (VERIFY_AGENT_RUN). Первый длиннее, чем часть итогового ответа
// до конца блока кода: если консоль срежет итоговый ответ на длину первого (как
// streamPrefixes для накопительных чанков ACP), VERIFY_DONE_<n> пропадёт целиком.
// Без разметки, кроме блока кода: сценарий сверяет строки с текстом страницы.
const leadText = (n) =>
  `Запускаю проверочную команду в песочнице: запишу файл verify-${n}.txt в папку выводов и прочитаю его.`;
const finalRunText = (n) =>
  ["Готово, итог проверки:", "", "```text", `VERIFY_DONE_${n}`, "```", "", `Файл verify-${n}.txt записан в /mnt/session/outputs и прочитан командой cat.`].join("\n");

function decide(body) {
  const cc = decideClaudeCode(body);
  if (cc) return cc;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && !hasToolResult(m) && MARKER.test(textOf(m.content))) {
      start = i;
      break;
    }
  }
  const toolNames = (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.name);
  if (start < 0) return { kind: null, nonce: null, decision: "no_marker", reply: { text: "FAKE_MODEL_NO_MARKER" }, toolNames };
  const prompt = textOf(messages[start].content);
  const [, kind, nonce] = prompt.match(MARKER);
  const results = messages
    .slice(start + 1)
    .filter(hasToolResult)
    .map((m) => textOf(m.content))
    .join("\n");
  if (!results) {
    const command = prompt.match(COMMAND)?.[1]?.trim();
    if (!command) {
      return { kind, nonce, decision: "no_command", reply: { text: `VERIFY_FAIL_${nonce}: в сообщении нет строки «Команда: …»` }, toolNames };
    }
    if (!toolNames.includes("bash")) {
      return { kind, nonce, decision: "no_bash_tool", reply: { text: `VERIFY_FAIL_${nonce}: в запросе нет инструмента bash` }, toolNames };
    }
    const reply = { tool: "bash", input: { command } };
    if (kind === "AGENT_RUN") reply.text = leadText(nonce);
    return { kind, nonce, decision: "tool_use", reply, toolNames };
  }
  const marker = `VERIFY_OK_${nonce}`;
  const ok = results.includes(marker);
  return {
    kind,
    nonce,
    decision: "final_text",
    toolResultHasMarker: ok,
    toolResultExcerpt: results.slice(0, 500),
    reply: {
      text: !ok
        ? `VERIFY_FAIL_${nonce}: в результате bash нет ${marker}`
        : kind === "AGENT_RUN" ? finalRunText(nonce) : `VERIFY_DONE_${nonce}`,
    },
    toolNames,
  };
}

// Ответ из блоков: текст (если reply.text есть), затем tool_use (если reply.tool есть).
// Ответ из одного блока даёт тот же поток, что и раньше (index 0).
function sse(model, n, reply) {
  const calling = "tool" in reply;
  const blocks = [];
  if (typeof reply.text === "string") {
    blocks.push({ start: { type: "text", text: "" }, delta: { type: "text_delta", text: reply.text } });
  }
  if (calling) {
    blocks.push({
      start: { type: "tool_use", id: `toolu_verify_${n}`, name: reply.tool, input: {} },
      delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.input) },
    });
  }
  const events = [
    { type: "message_start", message: { id: `msg_verify_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block.start },
      { type: "content_block_delta", index, delta: block.delta },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: calling ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function record(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  process.stdout.write(line + "\n");
  if (args.log) appendFileSync(args.log, line + "\n");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, requests: requestCount, pid: process.pid }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try {
    body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    body = {};
  }
  if (req.method === "POST" && url.pathname.endsWith("/messages/count_tokens")) {
    record({ path: url.pathname, decision: "count_tokens" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: 10 }));
    return;
  }
  const model = typeof body.model === "string" ? body.model : "fake";
  const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
  const client = {
    user_agent: req.headers["user-agent"] ?? null,
    api_key_sha256: sha12(req.headers["x-api-key"]),
    bearer_sha256: sha12(bearer),
    anthropic_beta: req.headers["anthropic-beta"] ?? null,
    query: url.search || null,
  };
  // Усилие агента: pi-ai шлёт его как output_config.effort при thinking {type: "adaptive"}.
  const reasoning = {
    thinking: typeof body.thinking?.type === "string" ? body.thinking.type : null,
    effort: typeof body.output_config?.effort === "string" ? body.output_config.effort : null,
  };
  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    record({ path: url.pathname, model, decision: "openai_probe", ...client });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl-verify", object: "chat.completion", created: 0, model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  if (req.method !== "POST" || !url.pathname.endsWith("/messages")) {
    record({ path: url.pathname, method: req.method, decision: "not_found" });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fake model: unknown path" } }));
    return;
  }
  const n = ++requestCount;
  if (body.stream !== true) {
    const card = cardNonce(body);
    record({
      n, path: url.pathname, stream: false, model,
      ...(card ? { kind: "ACP_CARD", nonce: card } : {}),
      decision: card ? "card_reply" : "non_stream_ok",
      ...reasoning, ...client,
    });
    const text = card ? `VERIFY_MODEL_SAW_${card}` : "ok";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `msg_verify_${n}`, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    return;
  }
  const d = decide(body);
  record({
    n,
    path: url.pathname,
    stream: true,
    model,
    kind: d.kind,
    nonce: d.nonce,
    decision: d.decision,
    tool_result_has_marker: d.toolResultHasMarker ?? null,
    bash_denied: d.bashDenied ?? null,
    acp_processes: d.acpProcesses ?? null,
    acp_lines: d.acpLines ?? null,
    history_has_turn1: d.historyHasTurn1 ?? null,
    env: d.env ?? null,
    env_error: d.envError ?? null,
    tool_result_excerpt: d.toolResultExcerpt ?? null,
    command: d.reply.input?.command ?? null,
    reply_tool: d.reply.tool ?? null,
    reply_input: d.reply.input ?? null,
    reply_text: d.reply.text ?? null,
    workdir: d.workdir ?? null,
    workdir_hint: d.workdir === "/workspace" ? d.dirHint ?? null : undefined,
    tools: d.toolNames,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
    ...reasoning,
    ...client,
  });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.end(sse(model, n, d.reply));
});

server.on("error", (error) => {
  process.stderr.write(`fake model: ${error.message}\n`);
  process.exit(1);
});
server.listen(Number(args.port), args.host, () => {
  process.stdout.write(`fake model listening on http://${args.host}:${args.port} pid ${process.pid}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  });
}
