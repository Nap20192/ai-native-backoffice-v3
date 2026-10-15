#!/usr/bin/env node
// Локальная фейковая модель для verify-agent-console.
// Отвечает в протоколе Anthropic Messages потоком SSE, как в
// platform/apps/main-node/test/_helpers/openai-node-process.ts.
//
// Поведение задаёт сообщение пользователя (его пишет journey-env-to-agent.mjs):
//   строка-маркер  "VERIFY_AGENT_RUN nonce=<n>" или "VERIFY_ENV_PROBE nonce=<n>";
//   строка         "Команда: <shell-команда>".
// Ход 1 (после сообщения нет tool_result): tool_use "bash" с этой командой.
// Ход 2 (tool_result есть): текст "VERIFY_DONE_<n>", если в результате есть
//   "VERIFY_OK_<n>", иначе "VERIFY_FAIL_<n>: ..." (сценарий это поймает).
// Запрос без маркера получает текст FAKE_MODEL_NO_MARKER.
//
// Запуск: node fake-model.mjs --port 8792 --log <файл.jsonl>
// GET /health -> {"ok":true,"requests":N}. Каждый запрос модели пишется строкой в --log.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: process.env.VERIFY_FAKE_PORT ?? "8792" },
    host: { type: "string", default: "127.0.0.1" },
    log: { type: "string" },
  },
});

const MARKER = /VERIFY_(ENV_PROBE|AGENT_RUN) nonce=([a-z0-9]+)/;
const COMMAND = /^Команда: (.+)$/m;
let requestCount = 0;

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

function decide(body) {
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
    return { kind, nonce, decision: "tool_use", reply: { tool: "bash", input: { command } }, toolNames };
  }
  const marker = `VERIFY_OK_${nonce}`;
  const ok = results.includes(marker);
  return {
    kind,
    nonce,
    decision: "final_text",
    toolResultHasMarker: ok,
    toolResultExcerpt: results.slice(0, 500),
    reply: { text: ok ? `VERIFY_DONE_${nonce}` : `VERIFY_FAIL_${nonce}: в результате bash нет ${marker}` },
    toolNames,
  };
}

function sse(model, n, reply) {
  const calling = "tool" in reply;
  const events = [
    { type: "message_start", message: { id: `msg_verify_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: calling ? { type: "tool_use", id: `toolu_verify_${n}`, name: reply.tool, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: calling ? { type: "input_json_delta", partial_json: JSON.stringify(reply.input) } : { type: "text_delta", text: reply.text } },
    { type: "content_block_stop", index: 0 },
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
  if (req.method !== "POST" || !url.pathname.endsWith("/messages")) {
    record({ path: url.pathname, method: req.method, decision: "not_found" });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fake model: unknown path" } }));
    return;
  }
  const n = ++requestCount;
  const model = typeof body.model === "string" ? body.model : "fake";
  if (body.stream !== true) {
    record({ n, path: url.pathname, stream: false, model, decision: "non_stream_ok" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `msg_verify_${n}`, type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
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
    command: d.reply.input?.command ?? null,
    reply_text: d.reply.text ?? null,
    tools: d.toolNames,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
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
