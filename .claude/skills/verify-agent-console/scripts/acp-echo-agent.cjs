// Тестовый ACP-агент для карточки своего harness (сценарий claude-code, journey-claude-code.mjs).
// Минимальный JSON-RPC по stdio без зависимостей: initialize, session/new, session/prompt.
// На реплику с "nonce=<n>" агент один раз зовёт модель через прокси сервера по переменным
// OMA_INFERENCE_* (их задаёт сервер на ходе карточки) и отвечает одной строкой:
// "VERIFY_ACP_ECHO_<n> model=<код>:<ответ модели> protocol=… base=… token=<8 знаков> keys=<имя>:<true|false>,…".
// В keys все переменные с KEY, TOKEN, SECRET или PASSWORD в имени, true значит «значение равно токену хода».
// Значения ключей и токена в ответ не попадают, только первые 8 знаков токена хода.
// Сценарий склеивает файл в одну строку (строки комментариев «//» выбрасываются) и пишет её
// аргументом после «-e» в карточку: команда node, аргументы по одному в строке, каждый не
// длиннее 2000 знаков. Поэтому каждая строка кода заканчивается сама (точка с запятой или
// скобка), а комментариев в конце строк кода нет.
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("close", () => process.exit(0));
const ask = async (e, text) => {
  try {
    const r = await fetch(e.OMA_INFERENCE_BASE_URL + "/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer " + e.OMA_INFERENCE_TOKEN, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: e.OMA_MODEL, max_tokens: 64, messages: [{ role: "user", content: text }] }),
    });
    const body = await r.text();
    let said = body.slice(0, 120);
    try { said = JSON.parse(body).content.map((b) => b.text).join(""); } catch {}
    return r.status + ":" + said;
  } catch (x) {
    return "error:" + x.message;
  }
};
rl.on("line", async (line) => {
  let q;
  try { q = JSON.parse(line); } catch { return; }
  const ok = (r) => send({ jsonrpc: "2.0", id: q.id, result: r });
  if (q.method === "initialize") return ok({ protocolVersion: 1, agentCapabilities: {} });
  if (q.method === "session/new") return ok({ sessionId: "verify-echo-" + process.pid });
  if (q.method !== "session/prompt") return q.id === undefined || send({ jsonrpc: "2.0", id: q.id, error: { code: -32601, message: "Method not found" } });
  const e = process.env;
  const text = q.params.prompt.map((b) => b.text || "").join("\n");
  const n = (text.match(/nonce=([a-z0-9]+)/) || [])[1];
  const keys = Object.keys(e).filter((k) => /KEY|TOKEN|SECRET|PASSWORD/.test(k)).sort().map((k) => k + ":" + (e[k] === e.OMA_INFERENCE_TOKEN));
  const reply = "VERIFY_ACP_ECHO_" + n + " model=" + (await ask(e, text)) + " protocol=" + e.OMA_INFERENCE_PROTOCOL + " base=" + e.OMA_INFERENCE_BASE_URL + " token=" + String(e.OMA_INFERENCE_TOKEN).slice(0, 8) + " keys=" + keys;
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: q.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } });
  ok({ stopReason: "end_turn" });
});
