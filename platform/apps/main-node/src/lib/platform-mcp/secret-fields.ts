// Fields the platform MCP server never shows to the model (builder-agent.md 2.6).
// `response-shape.ts` hides every field of this table, `known-secrets.ts` (BS2)
// reads the values of every field labelled `secret` into the scanner set.
//
// Path grammar: `a.b` nests, `[]` walks array items, `{*}` walks map values,
// `{secret}` walks map values whose key is a secret name, `#url` means the
// user, password, query and fragment of a URL string.

export type SecretFieldLabel = "secret" | "drop";

export type SecretFieldKind =
  | "agent"
  | "session"
  | "deployment"
  | "model_card"
  | "credential"
  | "tunnel";

export interface SecretField {
  kind: SecretFieldKind;
  path: string;
  label: SecretFieldLabel;
  /** Where the field lives in code. */
  source: string;
  note: string;
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|PWD|AUTH|CREDENTIAL|COOKIE|PRIVATE/i;

/** A variable name that holds a secret (2.6). */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export const SECRET_FIELDS: readonly SecretField[] = [
  {
    kind: "agent",
    path: "mcp_servers[].env{secret}",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/agent-input-components.ts:146",
    note: "значения env с секретным именем у stdio MCP-сервера",
  },
  {
    kind: "agent",
    path: "mcp_servers[].url#url",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/agent-input-components.ts:137",
    note: "логин, пароль, строка запроса и фрагмент в адресе MCP-сервера",
  },
  {
    kind: "agent",
    path: "_oma.acp.agent.env{secret}",
    label: "secret",
    source: "сохранённые версии агентов до D41 (openma.acp)",
    note: "значения env с секретным именем у старого ACP-агента: API их не отдаёт, сканер их по-прежнему скрывает",
  },
  {
    kind: "session",
    path: "agent.mcp_servers[].env{secret}",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/agent-response-components.ts:169",
    note: "MCP-серверы сессии, как у агента",
  },
  {
    kind: "session",
    path: "agent.mcp_servers[].url#url",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/agent-response-components.ts",
    note: "адрес MCP-сервера сессии, как у агента",
  },
  {
    kind: "session",
    path: "agent._oma.acp.agent.env{secret}",
    label: "secret",
    source: "сохранённые сессии до D41 (agent.openma.acp)",
    note: "старый ACP-агент в конфигурации сессии, как у агента",
  },
  {
    kind: "session",
    path: "resources[].authorization_token",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/sessions.ts:86",
    note: "токен ресурса GitHub",
  },
  {
    kind: "deployment",
    path: "resources[].authorization_token",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/deployments.ts:69",
    note: "токен ресурса GitHub, в том числе у деплоймента в архиве",
  },
  {
    kind: "model_card",
    path: "api_key",
    label: "secret",
    source: "P/http-routes/src/model-cards/index.ts:27",
    note: "ключ провайдера, маршрут ключа закрыт",
  },
  {
    kind: "model_card",
    path: "custom_headers{*}",
    label: "secret",
    source: "P/http-routes/src/model-cards/index.ts:29",
    note: "значения заголовков карточки, имена видны",
  },
  {
    kind: "model_card",
    path: "base_url#url",
    label: "secret",
    source: "P/http-routes/src/model-cards/index.ts:28",
    note: "логин, пароль, строка запроса и фрагмент в адресе провайдера",
  },
  {
    kind: "model_card",
    path: "api_key_preview",
    label: "drop",
    source: "P/http-routes/src/model-cards/index.ts:27",
    note: "часть ключа, сам ключ уже в наборе",
  },
  {
    kind: "credential",
    path: "auth.access_token",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/credentials.ts:112",
    note: "токен доступа OAuth",
  },
  {
    kind: "credential",
    path: "auth.refresh.refresh_token",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/credentials.ts:82",
    note: "токен обновления OAuth",
  },
  {
    kind: "credential",
    path: "auth.refresh.token_endpoint_auth.client_secret",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/credentials.ts:47",
    note: "секрет клиента OAuth",
  },
  {
    kind: "credential",
    path: "auth.token",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/credentials.ts:121",
    note: "токен static_bearer",
  },
  {
    kind: "credential",
    path: "auth.secret_value",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/credentials.ts:130",
    note: "значение переменной окружения",
  },
  {
    kind: "credential",
    path: "auth.mcp_server_url#url",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/credentials.ts:113",
    note: "логин, пароль, строка запроса и фрагмент в адресе MCP-сервера",
  },
  {
    kind: "tunnel",
    path: "tunnel_token",
    label: "secret",
    source: "P/managed-agents-api/src/contracts/tunnels.ts:54",
    note: "токен туннеля, маршрут reveal_token закрыт",
  },
];

export function secretFieldsOf(kind: SecretFieldKind): readonly SecretField[] {
  return SECRET_FIELDS.filter((field) => field.kind === kind);
}
