#!/usr/bin/env node
// Локальный MCP-сервер для verify-agent-console. По его журналу видно, ушёл ли вызов
// инструмента во «внешнюю систему» и когда (сценарий mcp-ask, journey-mcp-ask.mjs).
//
// Streamable HTTP без сессии, ответы JSON, только POST:
//   POST /mcp требует Authorization: Bearer <непустой>, иначе 401. Токен подставляет прокси
//     main-node из хранилища сессии (resolveNodeMcpProxyTarget в
//     platform/apps/main-node/src/modules/node-managed.ts), harness его не видит;
//   GET и DELETE на /mcp получают 405: поток SSE и закрытие сессии сервер не ведёт;
//   server/discover и другие неизвестные методы получают ошибку JSON-RPC -32601, по ней клиент
//     MCP v2 в режиме auto откатывается на initialize (classifyRpcError в @modelcontextprotocol/client);
//   методы: initialize, notifications/* (202 без тела), ping, tools/list, tools/call.
//
// Инструменты, аргумент nonce связывает вызов с ходом сценария:
//   read_report {nonce}        чтение отчёта, readOnlyHint: true;
//   write_act {nonce, text}    запись акта во внешнюю систему, readOnlyHint: false.
// Оба отвечают текстом «VERIFY_TOOL_OK_<nonce> ...».
//
// Журнал JSONL (--log), строка на каждое сообщение JSON-RPC: время, путь, метод HTTP и JSON-RPC,
// имя инструмента и аргументы, первые 12 знаков sha256 токена (сам токен не пишется),
// заголовки MCP-Protocol-Version и user-agent, код ответа.
// GET /health -> {"ok":true,"requests":N,"calls":{"<инструмент>":N},"pid":P}.
// Запуск: node fake-mcp.mjs --port 8793 --log <файл.jsonl>   (его запускает launch.sh)
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: process.env.VERIFY_FAKE_MCP_PORT ?? "8793" },
    host: { type: "string", default: "127.0.0.1" },
    log: { type: "string" },
  },
});

const MCP_PATH = "/mcp";
const DEFAULT_PROTOCOL = "2025-06-18";
const TOOLS = [
  {
    name: "read_report",
    title: "Прочитать отчёт",
    description: "Читает проверочный отчёт из внешней системы. Ничего не меняет.",
    inputSchema: {
      type: "object",
      properties: { nonce: { type: "string", description: "Метка хода проверки" } },
      required: ["nonce"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_act",
    title: "Записать акт",
    description: "Записывает акт во внешнюю систему. Меняет данные.",
    inputSchema: {
      type: "object",
      properties: {
        nonce: { type: "string", description: "Метка хода проверки" },
        text: { type: "string", description: "Текст акта" },
      },
      required: ["nonce"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

let requestCount = 0;
const calls = {};
const sha12 = (value) => (value ? createHash("sha256").update(String(value)).digest("hex").slice(0, 12) : null);

function record(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  process.stdout.write(line + "\n");
  if (args.log) appendFileSync(args.log, line + "\n");
}

function callTool(name, input) {
  const nonce = typeof input?.nonce === "string" ? input.nonce : "";
  if (name === "read_report") {
    return { content: [{ type: "text", text: `VERIFY_TOOL_OK_${nonce} report: в отчёте 3 строки, расхождений нет.` }], isError: false };
  }
  if (name === "write_act") {
    const text = typeof input?.text === "string" ? input.text : "";
    return { content: [{ type: "text", text: `VERIFY_TOOL_OK_${nonce} act: акт записан во внешнюю систему (${text.length} знаков).` }], isError: false };
  }
  return { content: [{ type: "text", text: `Неизвестный инструмент: ${name}` }], isError: true };
}

/** Ответ на одно сообщение JSON-RPC; null у уведомления. */
function answer(message) {
  const id = message?.id;
  const method = typeof message?.method === "string" ? message.method : "";
  if (id === undefined || id === null) return null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "verify-fake-mcp", version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(message.params?.name ?? "");
      calls[name] = (calls[name] ?? 0) + 1;
      return ok(callTool(name, message.params?.arguments ?? {}));
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://fake-mcp");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, requests: requestCount, calls, pid: process.pid }));
    return;
  }
  const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1]?.trim() ?? "";
  const base = {
    path: url.pathname,
    http_method: req.method,
    token_sha256: sha12(bearer),
    protocol_version: req.headers["mcp-protocol-version"] ?? null,
    user_agent: req.headers["user-agent"] ?? null,
  };
  if (url.pathname !== MCP_PATH) {
    record({ ...base, status: 404 });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  if (req.method !== "POST") {
    record({ ...base, status: 405 });
    res.writeHead(405, { allow: "POST", "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    record({ ...base, status: 400, error: "invalid_json" });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    return;
  }
  if (!bearer) {
    record({ ...base, rpc_method: body?.method ?? null, status: 401 });
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="verify-fake-mcp"' });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const messages = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const message of messages) {
    requestCount++;
    const reply = answer(message);
    if (reply) replies.push(reply);
    const isCall = message?.method === "tools/call";
    record({
      ...base,
      n: requestCount,
      rpc_method: message?.method ?? null,
      rpc_id: message?.id ?? null,
      tool: isCall ? String(message.params?.name ?? "") : null,
      arguments: isCall ? message.params?.arguments ?? {} : null,
      tool_use_id: isCall ? message.params?._meta?.["oma/tool_use_id"] ?? null : null,
      error: reply?.error?.code ?? null,
      status: reply ? 200 : 202,
    });
  }
  if (replies.length === 0) {
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
});

server.on("error", (error) => {
  process.stderr.write(`fake mcp: ${error.message}\n`);
  process.exit(1);
});
server.listen(Number(args.port), args.host, () => {
  process.stdout.write(`fake mcp listening on http://${args.host}:${args.port}${MCP_PATH} pid ${process.pid}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  });
}
