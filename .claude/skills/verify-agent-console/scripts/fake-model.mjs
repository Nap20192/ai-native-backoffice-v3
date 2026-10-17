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
// В журнал пишутся user-agent, sha256 ключа (12 знаков, не сам ключ), версия anthropic-beta
// и инструменты запроса.
// У каждого запроса в журнале есть thinking (тип thinking из тела) и effort
// (output_config.effort): так видно, дошло ли усилие агента до модели.
//
// Запрос без потока получает короткий текст "ok".
// POST …/chat/completions (проверка ключа карточки модели OpenAI при создании)
// получает короткий ответ OpenAI.
//
// Сценарий builder (journey-builder.mjs): маркер «VERIFY_BUILDER[_<ВИД>] nonce=<n>», решения в
// fake-model-builder.mjs. С --canary-file фейк перечитывает файл контрольных секретов на каждом
// запросе и ищет их в сыром теле до разбора. Попадание пишется строкой {decision: "canary_hit",
// canary_id, n} без значения. --oracle-file: значение для подбора секрета (6.7), его фейк шлёт сам.
//
// Запуск: node fake-model.mjs --port 8792 --log <файл.jsonl> [--canary-file <canaries.json>] [--oracle-file <oracle.json>]
// GET /health -> {"ok":true,"requests":N}. Каждый запрос модели пишется строкой в --log.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { decideBuilder, scanCanaries } from "./fake-model-builder.mjs";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: process.env.VERIFY_FAKE_PORT ?? "8792" },
    host: { type: "string", default: "127.0.0.1" },
    log: { type: "string" },
    "canary-file": { type: "string" },
    "oracle-file": { type: "string" },
  },
});

const MARKER = /VERIFY_(ENV_PROBE|AGENT_RUN) nonce=([a-z0-9]+)/;
const COMMAND = /^Команда: (.+)$/m;
let requestCount = 0;
const sha12 = (value) => (value ? createHash("sha256").update(String(value)).digest("hex").slice(0, 12) : null);

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

// Тексты хода агента (VERIFY_AGENT_RUN). Первый длиннее, чем часть итогового ответа
// до конца блока кода: если консоль срежет итоговый ответ на длину первого (как
// streamPrefixes для накопительных чанков ACP), VERIFY_DONE_<n> пропадёт целиком.
// Без разметки, кроме блока кода: сценарий сверяет строки с текстом страницы.
const leadText = (n) =>
  `Запускаю проверочную команду в песочнице: запишу файл verify-${n}.txt в папку выводов и прочитаю его.`;
const finalRunText = (n) =>
  ["Готово, итог проверки:", "", "```text", `VERIFY_DONE_${n}`, "```", "", `Файл verify-${n}.txt записан в /mnt/session/outputs и прочитан командой cat.`].join("\n");

function decide(body) {
  const builder = decideBuilder(body, { canaryFile: args["canary-file"], oracleFile: args["oracle-file"] });
  if (builder) return builder;
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
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = {};
  try {
    body = chunks.length ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }
  // Контрольные секреты ищутся в сыром теле до разбора и до сокращения журнала.
  if (args["canary-file"]) {
    for (const canaryId of scanCanaries(raw, args["canary-file"])) {
      record({ decision: "canary_hit", canary_id: canaryId, n: requestCount + 1, path: url.pathname });
    }
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
    record({ n, path: url.pathname, stream: false, model, decision: "non_stream_ok", ...reasoning, ...client });
    const text = "ok";
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
    tool_result_excerpt: d.toolResultExcerpt ?? null,
    step: d.step ?? null,
    builder: d.kind?.startsWith("BUILDER_") ? {
      result_is_error: d.resultIsError ?? null,
      list_error: d.listError ?? null,
      get_error: d.getError ?? null,
      masks: d.masks ?? null,
      write_texts: d.writeTexts ?? null,
    } : undefined,
    command: d.reply.input?.command ?? null,
    reply_tool: d.reply.tool ?? null,
    reply_input: d.reply.input ?? null,
    reply_text: d.reply.text ?? null,
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
