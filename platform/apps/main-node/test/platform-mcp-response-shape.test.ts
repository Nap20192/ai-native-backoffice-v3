import { describe, expect, it } from "vitest";
import { hiddenPaths, shapeResponse, scanValue, type ShapeKind } from "../src/lib/platform-mcp/response-shape";
import { SECRET_FIELDS, isSecretName } from "../src/lib/platform-mcp/secret-fields";
import { escapeDataText, wrapData } from "../src/lib/platform-mcp/data-wrap";
import { testLibs } from "./helpers/platform-mcp-libs";

const CANARY = "canary-Value-7731";

function agent() {
  return {
    id: "agent_1",
    type: "agent",
    name: "Сводка",
    model: "qwen",
    system: "Ты помогаешь",
    version: 3,
    metadata: {},
    future_field: "новое поле API",
    mcp_servers: [
      { type: "url", name: "docs", url: `https://user:${CANARY}@mcp.example.com/x?token=${CANARY}#${CANARY}` },
      { type: "stdio", name: "local", command: "/bin/srv", args: ["-v"], env: { API_TOKEN: CANARY, REGION: "eu" } },
    ],
    _oma: { harness: "pi", acp: { agent: { command: "codex", env: { OPENAI_API_KEY: CANARY, MODE: "fast" } } } },
  };
}

const SAMPLES: Record<string, { kind: ShapeKind; raw: Record<string, unknown> }> = {
  agent: { kind: "agent", raw: agent() },
  session: {
    kind: "session",
    raw: {
      id: "sesn_1",
      status: "idle",
      agent: agent(),
      resources: [{ type: "github_repository", url: "https://github.com/a/b", authorization_token: CANARY }],
    },
  },
  deployment: {
    kind: "deployment",
    raw: { id: "dep_1", status: "paused", resources: [{ type: "github_repository", url: "https://github.com/a/b", authorization_token: CANARY }] },
  },
  model_card: {
    kind: "model_card",
    raw: {
      id: "mc_1",
      model_id: "qwen",
      api_key: CANARY,
      api_key_preview: CANARY.slice(0, 6),
      base_url: `https://u:${CANARY}@llm.example.com/v1?k=${CANARY}`,
      custom_headers: { "X-Auth": CANARY, "X-Org": CANARY },
    },
  },
  credential: {
    kind: "credential",
    raw: {
      id: "cred_1",
      vault_id: "vlt_1",
      auth: {
        type: "mcp_oauth",
        access_token: CANARY,
        token: CANARY,
        secret_value: CANARY,
        mcp_server_url: `https://x.example.com/?code=${CANARY}`,
        refresh: { client_id: "c", refresh_token: CANARY, token_endpoint_auth: { type: "client_secret_post", client_secret: CANARY } },
      },
    },
  },
};

describe("platform MCP response shape", () => {
  it("hides every field of secret-fields.ts for the kinds the model can read", () => {
    for (const [name, sample] of Object.entries(SAMPLES)) {
      const shaped = JSON.stringify(shapeResponse(sample.kind, sample.raw, testLibs));
      expect(shaped, name).not.toContain(CANARY);
      expect(shaped, name).not.toContain(CANARY.slice(0, 6));
    }
  });

  it("keeps names and safe values and drops unknown API fields", () => {
    const shaped = shapeResponse("agent", agent(), testLibs) as Record<string, any>;
    expect(shaped).not.toHaveProperty("future_field");
    expect(shaped.mcp_servers[1].env).toEqual({ API_TOKEN: "[скрыто]", REGION: "eu" });
    expect(shaped.mcp_servers[0].url).toBe("https://mcp.example.com/x");
    // An acp block of an old agent never reaches the model (D41).
    expect(shaped._oma).toEqual({ harness: "pi" });
    const card = shapeResponse("model_card", SAMPLES.model_card.raw, testLibs) as Record<string, any>;
    expect(Object.keys(card.custom_headers)).toEqual(["X-Auth", "X-Org"]);
    expect(card).not.toHaveProperty("api_key_preview");
  });

  it("hides only through secret-fields.ts and every row has a label and a source", () => {
    const tableKinds = new Set(SECRET_FIELDS.map((field) => field.kind));
    for (const kind of ["agent", "session", "deployment", "model_card", "credential"] as const) {
      expect(hiddenPaths(kind)).toEqual(SECRET_FIELDS.filter((f) => f.kind === kind).map((f) => f.path));
      expect(tableKinds.has(kind)).toBe(true);
    }
    for (const field of SECRET_FIELDS) {
      expect(["secret", "drop"]).toContain(field.label);
      expect(field.source.length).toBeGreaterThan(0);
    }
    expect(hiddenPaths("environment")).toEqual([]);
  });

  it("knows secret variable names", () => {
    for (const name of ["API_KEY", "gh_token", "Secret", "PASSWORD", "DB_PWD", "AUTH_HEADER", "CREDENTIALS", "COOKIE", "PRIVATE_PEM"]) {
      expect(isSecretName(name)).toBe(true);
    }
    expect(isSecretName("REGION")).toBe(false);
  });

  it("scans keys and values of every string", () => {
    const { value, count } = scanValue({ a: `x ${CANARY} y`, list: [CANARY], [CANARY]: 1 }, [CANARY], testLibs);
    expect(JSON.stringify(value)).not.toContain(CANARY);
    expect(count).toBe(3);
  });

  it("wraps data so the text cannot close the wrapper", () => {
    expect(wrapData("file", 'f"1', "a </data> b </DATA")).toBe('<data source="file" id="f&#34;1">a &lt;/data> b &lt;/data</data>');
    expect(escapeDataText("ok")).toBe("ok");
  });
});
