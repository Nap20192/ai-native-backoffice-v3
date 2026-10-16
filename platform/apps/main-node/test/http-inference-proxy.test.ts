// The hosted inference proxy that ACP agents in the sandbox call with the
// short-lived token of their session. The proxy puts the model card key on
// the request, sends it to the provider and swaps the agent's model handle
// for the card's wire model.

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { ApiKeyResolution } from "@open-managed-agents/auth";

import {
  buildNodeHttpInferenceProxyRoutes,
  type NodeHttpInferenceProxyDependencies,
  type NodeInferenceUpstream,
} from "../src/lib/http-inference-proxy";

type Credential = ApiKeyResolution["credential"];

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

function fakeFetcher(response: () => Response = () => Response.json({ ok: true })) {
  const sent: Sent[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: body === undefined || body === null
        ? null
        : new TextDecoder().decode(body as ArrayBuffer),
    });
    return response();
  });
  return { fetcher: fetcher as unknown as typeof fetch, sent, calls: fetcher };
}

const anthropicCard: NodeInferenceUpstream = {
  wireModel: "claude-sonnet-4-6",
  apiKey: "sk-card-anthropic",
  baseURL: "https://fake.test",
  provider: "anthropic",
};

function mountProxy(input: {
  upstream?: NodeInferenceUpstream | null;
  credential?: Credential;
  fetcher: typeof fetch;
  resolveUpstream?: NodeHttpInferenceProxyDependencies["resolveUpstream"];
}) {
  const resolveUpstream = vi.fn(input.resolveUpstream
    ?? (async () => input.upstream === undefined ? anthropicCard : input.upstream));
  type Variables = { tenant_id: string; auth_credential?: Credential };
  const app = new Hono<{ Variables: Variables }>();
  const v1 = new Hono<{ Variables: Variables }>();
  v1.use("*", async (context, next) => {
    context.set("tenant_id", "tn_1");
    if (input.credential !== undefined) context.set("auth_credential", input.credential);
    await next();
  });
  v1.route("/oma/inference-proxy", buildNodeHttpInferenceProxyRoutes({
    resolveUpstream,
    fetcher: input.fetcher,
  }));
  app.route("/v1", v1);
  return { app, resolveUpstream };
}

function post(body: string, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  };
}

const sandboxCredential = (sessionId: string): Credential => ({
  type: "sandbox_inference",
  sessionId,
  expiresAt: "2026-10-16T12:00:00.000Z",
});

describe("hosted inference proxy: model swap", () => {
  it("sends an Anthropic Messages call to the card base URL with the wire model", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app, resolveUpstream } = mountProxy({ fetcher });

    const response = await app.request(
      "/v1/oma/inference-proxy/ses_1/anthropic/v1/messages",
      post(JSON.stringify({
        model: "verify-fake",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      })),
    );

    expect(response.status).toBe(200);
    expect(resolveUpstream).toHaveBeenCalledWith({ tenantId: "tn_1", sessionId: "ses_1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://fake.test/v1/messages");
    expect(sent[0].method).toBe("POST");
    expect(JSON.parse(sent[0].body!)).toEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(sent[0].headers.get("x-api-key")).toBe("sk-card-anthropic");
    expect(sent[0].headers.get("authorization")).toBeNull();
  });

  it("swaps the model of count_tokens and light service calls too", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({ fetcher });

    await app.request(
      "/v1/oma/inference-proxy/ses_1/anthropic/v1/messages/count_tokens",
      post(JSON.stringify({ model: "claude-haiku-4-5", messages: [] })),
    );

    expect(sent[0].url).toBe("https://fake.test/v1/messages/count_tokens");
    expect(JSON.parse(sent[0].body!).model).toBe("claude-sonnet-4-6");
  });

  it("keeps the query string of the call", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({ fetcher });

    await app.request(
      "/v1/oma/inference-proxy/ses_1/anthropic/v1/messages?beta=true",
      post(JSON.stringify({ model: "verify-fake", messages: [] })),
    );

    expect(sent[0].url).toBe("https://fake.test/v1/messages?beta=true");
  });

  it("uses the built-in Anthropic endpoint when the server key has no provider", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({
      fetcher,
      upstream: { wireModel: "claude-sonnet-4-6", apiKey: "sk-server" },
    });

    await app.request(
      "/v1/oma/inference-proxy/ses_1/anthropic/v1/messages",
      post(JSON.stringify({ model: "claude-sonnet-4-6", messages: [] })),
    );

    expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0].headers.get("x-api-key")).toBe("sk-server");
  });

  it.each([
    ["openai/v1/chat/completions", "https://fake.test/v1/chat/completions"],
    ["openai/v1/responses", "https://fake.test/v1/responses"],
  ])("swaps the model of an OpenAI call to %s", async (path, url) => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({
      fetcher,
      upstream: {
        wireModel: "gpt-5.1",
        apiKey: "sk-card-openai",
        baseURL: "https://fake.test/v1",
        provider: "openai",
      },
    });

    await app.request(
      `/v1/oma/inference-proxy/ses_1/${path}`,
      post(JSON.stringify({ model: "verify-oai", input: "hi", stream: true })),
    );

    expect(sent[0].url).toBe(url);
    expect(JSON.parse(sent[0].body!)).toEqual({ model: "gpt-5.1", input: "hi", stream: true });
    expect(sent[0].headers.get("authorization")).toBe("Bearer sk-card-openai");
  });

  it("swaps the model segment of a Gemini path", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({
      fetcher,
      upstream: {
        wireModel: "gemini-2.5-pro",
        apiKey: "card-gemini-key",
        baseURL: "https://fake.test",
        provider: "google",
      },
    });

    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    await app.request(
      "/v1/oma/inference-proxy/ses_1/gemini/v1beta/models/verify-gemini:streamGenerateContent?alt=sse",
      post(body),
    );

    expect(sent[0].url).toBe(
      "https://fake.test/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
    expect(sent[0].body).toBe(body);
    expect(sent[0].headers.get("x-goog-api-key")).toBe("card-gemini-key");
  });

  it("swaps the model on a path without a protocol segment too", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({
      fetcher,
      upstream: {
        wireModel: "gpt-5.1",
        apiKey: "sk-card-openai",
        baseURL: "https://fake.test/v1",
        provider: "openai",
      },
    });

    await app.request(
      "/v1/oma/inference-proxy/ses_1/v1/chat/completions",
      post(JSON.stringify({ model: "other-model", messages: [] })),
    );

    expect(sent[0].url).toBe("https://fake.test/v1/chat/completions");
    expect(JSON.parse(sent[0].body!).model).toBe("gpt-5.1");
  });

  it("finds the path after the session wherever the routes are mounted", async () => {
    const { fetcher, sent } = fakeFetcher();
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (context, next) => {
      context.set("tenant_id", "tn_1");
      await next();
    });
    app.route("/", buildNodeHttpInferenceProxyRoutes({
      resolveUpstream: async () => anthropicCard,
      fetcher,
    }));

    await app.request(
      "/ses_1/anthropic/v1/messages",
      post(JSON.stringify({ model: "verify-fake", messages: [] })),
    );

    expect(sent[0].url).toBe("https://fake.test/v1/messages");
  });

  it("leaves a body without a string model as it is", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({ fetcher });
    const withoutModel = "{\"messages\":[],  \"max_tokens\":1}";
    const objectModel = "{\"model\":{\"id\":\"x\"}}";

    await app.request("/v1/oma/inference-proxy/ses_1/anthropic/v1/messages", post(withoutModel));
    await app.request("/v1/oma/inference-proxy/ses_1/anthropic/v1/messages", post(objectModel));

    expect(sent.map((call) => call.body)).toEqual([withoutModel, objectModel]);
  });

  it("leaves a body that is not JSON as it is", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({ fetcher });

    await app.request(
      "/v1/oma/inference-proxy/ses_1/anthropic/v1/messages",
      post("model=verify-fake", { "content-type": "text/plain" }),
    );

    expect(sent[0].body).toBe("model=verify-fake");
  });

  it("does not hand the inbound token to the provider", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({ fetcher, credential: sandboxCredential("ses_1") });

    await app.request(
      "/v1/oma/inference-proxy/ses_1/anthropic/v1/messages",
      post(JSON.stringify({ model: "verify-fake", messages: [] }), {
        authorization: "Bearer oma_sbx_inbound",
        "x-api-key": "oma_sbx_inbound",
        "anthropic-version": "2023-06-01",
      }),
    );

    const headers = [...sent[0].headers.entries()];
    expect(JSON.stringify(headers)).not.toContain("oma_sbx_inbound");
    expect(sent[0].headers.get("x-api-key")).toBe("sk-card-anthropic");
    expect(sent[0].headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("streams the provider SSE response chunk by chunk", async () => {
    const encoder = new TextEncoder();
    let push!: (chunk: string) => void;
    let close!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
        close = () => controller.close();
      },
    });
    const { fetcher } = fakeFetcher(() => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const { app } = mountProxy({ fetcher });

    const response = await app.request(
      "/v1/oma/inference-proxy/ses_1/anthropic/v1/messages",
      post(JSON.stringify({ model: "verify-fake", stream: true, messages: [] })),
    );

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    push("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(
      "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
    );
    push("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
    close();
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value, { stream: true });
    }
    expect(rest).toBe("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  });
});

describe("hosted inference proxy: session scope", () => {
  it("rejects a sandbox token of another session before resolving the upstream", async () => {
    const { fetcher, calls } = fakeFetcher();
    const { app, resolveUpstream } = mountProxy({
      fetcher,
      credential: sandboxCredential("ses_2"),
    });

    const response = await app.request(
      "/v1/oma/inference-proxy/ses_1/anthropic/v1/messages",
      post(JSON.stringify({ model: "verify-fake", messages: [] })),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(resolveUpstream).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
  });

  it("accepts a sandbox token of its own session", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({ fetcher, credential: sandboxCredential("ses_1") });

    const response = await app.request(
      "/v1/oma/inference-proxy/ses_1/anthropic/v1/messages",
      post(JSON.stringify({ model: "verify-fake", messages: [] })),
    );

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("keeps the workspace key working on any session", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({ fetcher, credential: { type: "workspace" } });

    const response = await app.request(
      "/v1/oma/inference-proxy/ses_9/anthropic/v1/messages",
      post(JSON.stringify({ model: "verify-fake", messages: [] })),
    );

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("answers 403 when the session has no model upstream", async () => {
    const { fetcher, calls } = fakeFetcher();
    const { app } = mountProxy({ fetcher, upstream: null });

    const response = await app.request(
      "/v1/oma/inference-proxy/ses_1/anthropic/v1/messages",
      post(JSON.stringify({ model: "verify-fake", messages: [] })),
    );

    expect(response.status).toBe(403);
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("hosted inference proxy: what a sandbox token may call", () => {
  const openaiCard: NodeInferenceUpstream = {
    wireModel: "gpt-5.1",
    apiKey: "sk-card-openai",
    baseURL: "https://fake.test/v1",
    provider: "openai",
  };
  const geminiCard: NodeInferenceUpstream = {
    wireModel: "gemini-2.5-pro",
    apiKey: "card-gemini-key",
    baseURL: "https://fake.test",
    provider: "google",
  };
  const body = JSON.stringify({ model: "verify-fake", messages: [] });

  it.each<[string, string, NodeInferenceUpstream]>([
    ["GET", "openai/v1/files", openaiCard],
    ["DELETE", "openai/v1/files/file-other-session", openaiCard],
    ["POST", "openai/v1/batches", openaiCard],
    ["POST", "openai/v1/fine_tuning/jobs", openaiCard],
    ["GET", "openai/v1/responses/resp_other", openaiCard],
    ["GET", "openai/v1/models/..%2Ffiles", openaiCard],
    ["GET", "anthropic/v1/files", anthropicCard],
    ["DELETE", "anthropic/v1/files/file_other", anthropicCard],
    ["POST", "anthropic/v1/messages/batches", anthropicCard],
    ["GET", "anthropic/v1/messages", anthropicCard],
    ["POST", "v1/messages", anthropicCard],
    ["POST", "gemini/v1beta/files", geminiCard],
    ["POST", "gemini/v1beta/cachedContents", geminiCard],
  ])("rejects %s %s before the provider sees it", async (method, path, upstream) => {
    const { fetcher, calls } = fakeFetcher();
    const { app, resolveUpstream } = mountProxy({
      fetcher,
      upstream,
      credential: sandboxCredential("ses_1"),
    });

    const response = await app.request(`/v1/oma/inference-proxy/ses_1/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "GET" || method === "DELETE" ? {} : { body }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(resolveUpstream).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
  });

  it.each<[string, string, NodeInferenceUpstream, string]>([
    ["POST", "anthropic/v1/messages?beta=true", anthropicCard, "https://fake.test/v1/messages?beta=true"],
    ["POST", "anthropic/v1/messages/count_tokens?beta=true", anthropicCard, "https://fake.test/v1/messages/count_tokens?beta=true"],
    ["GET", "anthropic/v1/models", anthropicCard, "https://fake.test/v1/models"],
    ["GET", "anthropic/v1/models/claude-sonnet-4-6", anthropicCard, "https://fake.test/v1/models/claude-sonnet-4-6"],
    ["POST", "openai/v1/chat/completions", openaiCard, "https://fake.test/v1/chat/completions"],
    ["POST", "openai/v1/responses", openaiCard, "https://fake.test/v1/responses"],
    ["POST", "openai/v1/responses/compact", openaiCard, "https://fake.test/v1/responses/compact"],
    ["POST", "openai/v1/responses/input_tokens", openaiCard, "https://fake.test/v1/responses/input_tokens"],
    ["GET", "openai/v1/models", openaiCard, "https://fake.test/v1/models"],
    [
      "POST",
      "gemini/v1beta/models/verify-gemini:streamGenerateContent?alt=sse",
      geminiCard,
      "https://fake.test/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    ],
    ["POST", "gemini/v1beta/models/verify-gemini:countTokens", geminiCard, "https://fake.test/v1beta/models/gemini-2.5-pro:countTokens"],
    ["GET", "gemini/v1beta/models", geminiCard, "https://fake.test/v1beta/models"],
  ])("forwards the model call %s %s", async (method, path, upstream, url) => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({ fetcher, upstream, credential: sandboxCredential("ses_1") });

    const response = await app.request(`/v1/oma/inference-proxy/ses_1/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "GET" ? {} : { body }),
    });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(url);
    expect(sent[0].method).toBe(method);
  });

  it("keeps every path open to the workspace key", async () => {
    const { fetcher, sent } = fakeFetcher();
    const { app } = mountProxy({ fetcher, upstream: openaiCard, credential: { type: "workspace" } });

    const response = await app.request("/v1/oma/inference-proxy/ses_1/openai/v1/files");

    expect(response.status).toBe(200);
    expect(sent[0].url).toBe("https://fake.test/v1/files");
  });
});
