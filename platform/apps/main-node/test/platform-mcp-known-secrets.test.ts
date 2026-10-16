// Known secrets of a workspace (builder-agent.md 2.6, 6.1 "секреты", "ротация").

import { describe, expect, it } from "vitest";
import {
  KNOWN_SECRET_SOURCE_OF,
  createKnownSecrets,
  secretValuesOf,
  type KnownSecretSources,
} from "../src/lib/platform-mcp/known-secrets";
import { SECRET_FIELDS, type SecretFieldKind } from "../src/lib/platform-mcp/secret-fields";
import { createFakePlatform } from "./helpers/platform-mcp-fake";

type Json = Record<string, any>;

function emptySources(): Record<keyof KnownSecretSources, Json[]> {
  return { agentVersions: [], sessions: [], deployments: [], credentials: [], modelCards: [], tunnels: [] };
}

function sourcesOf(data: Record<keyof KnownSecretSources, Json[]>, reads?: { count: number }): KnownSecretSources {
  const read = (key: keyof KnownSecretSources) => async () => {
    if (reads && key === "agentVersions") reads.count += 1;
    return data[key];
  };
  return {
    agentVersions: read("agentVersions"),
    sessions: read("sessions"),
    deployments: read("deployments"),
    credentials: read("credentials"),
    modelCards: read("modelCards"),
    tunnels: read("tunnels"),
  };
}

/** An object with `value` in the field at `path`. */
function objectWith(path: string, value: string): Json {
  const url = path.endsWith("#url");
  const body = url ? path.slice(0, -4) : path;
  const leaf = url ? `https://user:pw@host.test/mcp?token=${value}#frag` : value;
  const parts = body.split(".");
  const build = (index: number): unknown => {
    if (index === parts.length) return leaf;
    const match = /^([^[{]*)((?:\[\]|\{\*\}|\{secret\})*)$/.exec(parts[index]!)!;
    let inner: unknown = build(index + 1);
    const suffixes = match[2]!.match(/\[\]|\{\*\}|\{secret\}/g) ?? [];
    for (const suffix of suffixes.reverse()) {
      if (suffix === "[]") inner = [inner];
      else if (suffix === "{*}") inner = { X_HEADER: inner };
      else inner = { GITHUB_TOKEN: inner, PLAIN_NAME: "visible-value" };
    }
    return match[1] ? { [match[1]]: inner } : inner;
  };
  return build(0) as Json;
}

describe("secretValuesOf", () => {
  it("reads every field labelled secret and nothing labelled drop", () => {
    for (const field of SECRET_FIELDS) {
      const value = `v_${field.kind}_${field.path.replace(/\W/g, "_")}`;
      const values = secretValuesOf(field.kind, objectWith(field.path, value));
      if (field.label === "secret") expect(values, `${field.kind} ${field.path}`).toContain(value);
      else expect(values, `${field.kind} ${field.path}`).not.toContain(value);
    }
  });

  it("has a source for every kind of secret-fields.ts", () => {
    const kinds = new Set(SECRET_FIELDS.map((field) => field.kind));
    for (const kind of kinds) expect(KNOWN_SECRET_SOURCE_OF[kind as SecretFieldKind], kind).toBeDefined();
  });

  it("takes only env values with a secret name", () => {
    const values = secretValuesOf("agent", {
      mcp_servers: [{ type: "stdio", name: "s", command: "x", env: { API_KEY: "k1", db_password: "p1", REGION: "eu-west-1" } }],
    });
    expect(values).toEqual(expect.arrayContaining(["k1", "p1"]));
    expect(values).not.toContain("eu-west-1");
  });

  it("splits a URL into user, password, the pair, the query, every parameter and the fragment", () => {
    const values = secretValuesOf("model_card", { base_url: "https://alice:s3cret@api.test/v1?key=abc&region=eu#frag" });
    expect(values).toEqual(expect.arrayContaining(["alice", "s3cret", "alice:s3cret", "key=abc&region=eu", "abc", "eu", "frag"]));
    expect(values).not.toContain("api.test");
  });

  it("skips empty and non-string values", () => {
    expect(secretValuesOf("model_card", { api_key: "", custom_headers: { A: 5, B: null } })).toEqual([]);
    expect(secretValuesOf("credential", null)).toEqual([]);
  });
});

describe("createKnownSecrets", () => {
  it("collects every source, archived objects too, and keeps no cache", async () => {
    const data = emptySources();
    data.agentVersions.push({ version: 1, mcp_servers: [{ type: "stdio", env: { TOKEN: "old-agent-token" } }] }, { version: 2, mcp_servers: [] });
    data.sessions.push({ archived_at: "2026-10-01T00:00:00Z", resources: [{ type: "github_repository", authorization_token: "ghs_archived" }] });
    data.deployments.push({ archived_at: "2026-10-01T00:00:00Z", resources: [{ authorization_token: "dep-token" }] });
    data.credentials.push({ auth: { type: "mcp_oauth", access_token: "at-1", refresh: { refresh_token: "rt-1", token_endpoint_auth: { client_secret: "cs-1" } } } });
    data.modelCards.push({ api_key: "mk-1", custom_headers: { "X-Org": "org-1" } });
    data.tunnels.push({ tunnel_token: "tun-1" });
    const reads = { count: 0 };
    const known = createKnownSecrets(sourcesOf(data, reads));
    const first = await known.collect("ws_1");
    expect(first).toEqual(expect.arrayContaining(["old-agent-token", "ghs_archived", "dep-token", "at-1", "rt-1", "cs-1", "mk-1", "org-1", "tun-1"]));
    expect(new Set(first).size).toBe(first.length);

    data.credentials[0]!.auth.access_token = "at-2";
    const second = await known.collect("ws_1");
    expect(second).toContain("at-2");
    expect(second).not.toContain("at-1");
    expect(reads.count).toBe(2);
  });

  it("passes the workspace to every source", async () => {
    const seen: string[] = [];
    const source = async (ws: string) => (seen.push(ws), []);
    const known = createKnownSecrets({ agentVersions: source, sessions: source, deployments: source, credentials: source, modelCards: source, tunnels: source });
    await known.collect("ws_9");
    expect(seen).toEqual(Array(6).fill("ws_9"));
  });

  it("collects a workspace with 1000 sessions in a bounded time", async () => {
    const data = emptySources();
    for (let i = 0; i < 1000; i++) {
      data.sessions.push({
        id: `sesn_${i}`,
        agent: {
          mcp_servers: [
            { type: "url", name: "a", url: `https://u${i}:p${i}@mcp.test/x?k=${i}` },
            { type: "stdio", name: "b", command: "c", env: { API_TOKEN: `t${i}`, MODE: "x" } },
          ],
          _oma: { acp: { agent: { env: { OPENAI_API_KEY: `ok${i}` } } } },
        },
        resources: [{ type: "github_repository", authorization_token: `gh${i}` }, { type: "file", file_id: "f" }],
      });
    }
    for (let i = 0; i < 200; i++) data.agentVersions.push({ mcp_servers: [{ type: "stdio", env: { SECRET: `as${i}` } }] });
    const known = createKnownSecrets(sourcesOf(data));
    const started = performance.now();
    const values = await known.collect("ws_1");
    const elapsed = performance.now() - started;
    console.info(`known secrets: ${values.length} values from 1000 sessions in ${elapsed.toFixed(1)} ms`);
    expect(values).toContain("gh999");
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("rotation through the platform MCP server", () => {
  it("hides a new credential value, model key and refreshed OAuth token from the first answer after the change", async () => {
    const fake = createFakePlatform();
    fake.setupAssistant();
    const data = emptySources();
    data.credentials.push({ auth: { type: "static_bearer", token: "first-static-value" } });
    data.credentials.push({ auth: { type: "mcp_oauth", access_token: "oauth-access-1", refresh: { refresh_token: "oauth-refresh-1" } } });
    data.modelCards.push({ api_key: "model-key-number-one" });
    const reads = { count: 0 };
    fake.deps.knownSecrets = createKnownSecrets(sourcesOf(data, reads));
    const file = fake.addFile(
      "notes.txt",
      new TextEncoder().encode("a=first-static-value b=second-static-value c=model-key-number-two d=oauth-access-2"),
    );

    const before = await fake.call("read_content", { kind: "file", id: file.id });
    expect(before.text).toContain("second-static-value");
    expect(before.text).not.toContain("first-static-value");

    // The vault route rewrites the credential, the card gets a new key, and a
    // background refresh writes a new OAuth token without any HTTP route.
    data.credentials[0]!.auth.token = "second-static-value";
    data.modelCards[0]!.api_key = "model-key-number-two";
    data.credentials[1]!.auth.access_token = "oauth-access-2";

    const after = await fake.call("read_content", { kind: "file", id: file.id });
    expect(after.text).not.toContain("second-static-value");
    expect(after.text).not.toContain("model-key-number-two");
    expect(after.text).not.toContain("oauth-access-2");
    expect(after.text).toContain("[скрыто]");
    expect(reads.count).toBe(2);
  });
});
