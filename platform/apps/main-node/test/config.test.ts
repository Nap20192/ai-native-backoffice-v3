// loadNodeConfig is the only place the Node control plane reads environment
// variables. It turns the flat string bag into typed data once, applies the
// documented defaults, and reports every problem in one error.

import { describe, expect, it } from "vitest";

import { loadNodeConfig, redactNodeConfig, type NodeConfig } from "../src/config";

const minimal = { NODE_ENV: "test" };

describe("loadNodeConfig", () => {
  it("applies the self-host defaults when nothing is set", () => {
    const config = loadNodeConfig(minimal);

    expect(config.database).toEqual({ kind: "sqlite", path: "./data/oma.db" });
    expect(config.auth).toMatchObject({ disabled: false, databasePath: "./data/auth.db", requireEmailVerify: false });
    expect(config.auth.secret).toBeUndefined();
    expect(config.blobs.memory).toEqual({ kind: "localfs", dir: "./data/memory-blobs" });
    expect(config.blobs.files).toEqual({ kind: "localfs", dir: "./data/files-blobs" });
    expect(config.memoryQueue).toBe("auto");
    expect(config.realtime).toEqual({ mode: "memory", pollIntervalMs: 300 });
    expect(config.execution.concurrency).toBe(8);
    // Session limits by the trial copy log (docs/plans/multiagent.md, 3.Б).
    expect(config.sessionLimits).toEqual({ maxTokens: 1_000_000, maxChildTurns: 20 });
    expect(config.workspace).toEqual({ strategy: "ephemeral", checkpointIntervalMs: 60_000 });
    expect(config.execution.ownerId).toMatch(/^node:\d+:/);
    expect(config.paths).toEqual({
      sandboxWorkdir: "./data/sandboxes",
      sessionOutputs: "./data/session-outputs",
      builtinSkills: expect.stringMatching(/platform\/skills\/builtin$/),
    });
    expect(config.http).toEqual({ host: "0.0.0.0", port: 8787, publicBaseUrl: undefined, consoleDir: undefined, metricsToken: undefined, apiKey: undefined });
    expect(loadNodeConfig({ ...minimal, HOST: "127.0.0.1", PORT: "18787" }).http).toMatchObject({ host: "127.0.0.1", port: 18787 });
    expect(loadNodeConfig({ ...minimal, PORT: "0" }).http.port).toBe(0);
    expect(() => loadNodeConfig({ ...minimal, PORT: "70000" })).toThrow(/PORT must be an integer between 0 and 65535/);
    expect(config.tunnels.domainSuffix).toBe("tunnels.localhost");
    expect(config.email).toBeNull();
    expect(config.dreamCurator).toBe("model");
    expect(config.cron).toEqual({
      evalTick: "* * * * *",
      memoryRetention: "* * * * *",
    });
    expect(config.sandbox.environment).toBe(minimal);
  });

  it("selects the database and realtime fanout from DATABASE_URL", () => {
    const pg = loadNodeConfig({ ...minimal, DATABASE_URL: "postgres://u:p@h:5432/db" });
    expect(pg.database).toEqual({ kind: "postgres", url: "postgres://u:p@h:5432/db" });
    expect(pg.realtime.mode).toBe("pg-notify");

    const polled = loadNodeConfig({ ...minimal, DATABASE_URL: "postgres://u:p@h:5432/db", OMA_REALTIME_FANOUT: "sql-poll", OMA_REALTIME_POLL_INTERVAL_MS: "500" });
    expect(polled.realtime).toEqual({ mode: "sql-poll", pollIntervalMs: 500 });
  });

  it("refuses a MySQL DATABASE_URL instead of falling back to SQLite (cleanup.md 5.3)", () => {
    expect(() => loadNodeConfig({ ...minimal, DATABASE_URL: "mysql://u:p@h:3306/db" }))
      .toThrow(/DATABASE_URL: MySQL is not supported/);
    expect(() => loadNodeConfig({ ...minimal, DATABASE_URL: "mysql2://u:p@h:3306/db" }))
      .toThrow(/DATABASE_URL: MySQL is not supported/);
  });

  it("reads S3 blob backends only when all four required values are present", () => {
    const partial = loadNodeConfig({ ...minimal, MEMORY_S3_ENDPOINT: "http://s3", MEMORY_S3_BUCKET: "b" });
    expect(partial.blobs.memory.kind).toBe("localfs");

    const full = loadNodeConfig({
      ...minimal,
      MEMORY_S3_ENDPOINT: "http://s3", MEMORY_S3_BUCKET: "mem", MEMORY_S3_ACCESS_KEY: "ak", MEMORY_S3_SECRET_KEY: "sk",
      MEMORY_S3_POLL_INTERVAL_SEC: "3",
      FILES_S3_ENDPOINT: "http://s3", FILES_S3_BUCKET: "files", FILES_S3_ACCESS_KEY: "ak2", FILES_S3_SECRET_KEY: "sk2", FILES_S3_REGION: "eu-west-1",
    });
    expect(full.blobs.memory).toEqual({
      kind: "s3", endpoint: "http://s3", bucket: "mem", accessKey: "ak", secretKey: "sk", region: "us-east-1",
      // MEMORY_S3_POLL_INTERVAL_SEC below 5s is clamped, as before.
      pollIntervalMs: 5_000,
    });
    expect(full.blobs.files).toEqual({ kind: "s3", endpoint: "http://s3", bucket: "files", accessKey: "ak2", secretKey: "sk2", region: "eu-west-1" });
  });

  it("scopes S3 blob stores with a key prefix and virtual-host/checksum options", () => {
    const config = loadNodeConfig({
      ...minimal,
      MEMORY_S3_ENDPOINT: "https://s3.example", MEMORY_S3_BUCKET: "shared", MEMORY_S3_ACCESS_KEY: "a", MEMORY_S3_SECRET_KEY: "s",
      MEMORY_S3_PREFIX: "prod/openma/memory/", MEMORY_S3_FORCE_PATH_STYLE: "0", MEMORY_S3_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
      FILES_S3_ENDPOINT: "https://s3.example", FILES_S3_BUCKET: "shared", FILES_S3_ACCESS_KEY: "a", FILES_S3_SECRET_KEY: "s",
      FILES_S3_PREFIX: "prod/openma/files/", FILES_S3_FORCE_PATH_STYLE: "0", FILES_S3_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
    });
    expect(config.blobs.memory).toMatchObject({ kind: "s3", prefix: "prod/openma/memory/", forcePathStyle: false, requestChecksumCalculation: "WHEN_REQUIRED" });
    expect(config.blobs.files).toMatchObject({ kind: "s3", prefix: "prod/openma/files/", forcePathStyle: false, requestChecksumCalculation: "WHEN_REQUIRED" });
    expect(() => loadNodeConfig({ ...minimal, MEMORY_S3_ENDPOINT: "https://s3.example", MEMORY_S3_BUCKET: "shared", MEMORY_S3_ACCESS_KEY: "a", MEMORY_S3_SECRET_KEY: "s", MEMORY_S3_PREFIX: "/absolute" })).toThrow(/MEMORY_S3_PREFIX/);
  });

  it("selects Aliyun OSS create-only semantics for S3 blob stores", () => {
    const s3 = (prefix: string) => ({ [`${prefix}_ENDPOINT`]: "https://oss.example", [`${prefix}_BUCKET`]: "b",
      [`${prefix}_ACCESS_KEY`]: "a", [`${prefix}_SECRET_KEY`]: "s", [`${prefix}_CONDITIONAL_CREATE`]: "oss-forbid-overwrite" });
    const config = loadNodeConfig({ ...minimal, ...s3("MEMORY_S3"), ...s3("FILES_S3") });
    expect(config.blobs.files).toMatchObject({ conditionalCreate: "oss-forbid-overwrite" });
    expect(config.blobs.memory).toMatchObject({ conditionalCreate: "oss-forbid-overwrite" });
    expect(loadNodeConfig({ ...minimal, ...s3("FILES_S3"), FILES_S3_CONDITIONAL_CREATE: undefined as unknown as string }).blobs.files)
      .not.toHaveProperty("conditionalCreate");
    expect(() => loadNodeConfig({ ...minimal, ...s3("FILES_S3"), FILES_S3_CONDITIONAL_CREATE: "sometimes" }))
      .toThrow(/FILES_S3_CONDITIONAL_CREATE/);
  });

  it("requires shared S3 blobs when checkpoint_restore is selected and parses its safe-point interval", () => {
    const workspace = { OMA_WORKSPACE_STRATEGY: "checkpoint_restore" };
    expect(() => loadNodeConfig({ ...minimal, ...workspace })).toThrow(/FILES_S3.*checkpoint_restore/i);
    expect(() => loadNodeConfig({ ...minimal, ...workspace, OMA_WORKSPACE_CHECKPOINT_INTERVAL_SEC: "0" }))
      .toThrow(/OMA_WORKSPACE_CHECKPOINT_INTERVAL_SEC/);
    expect(() => loadNodeConfig({ ...minimal, OMA_WORKSPACE_STRATEGY: "durable_mount" })).toThrow(/OMA_WORKSPACE_STRATEGY/);
    const configured = loadNodeConfig({ ...minimal, ...workspace, OMA_WORKSPACE_CHECKPOINT_INTERVAL_SEC: "45",
      FILES_S3_ENDPOINT: "https://oss.example", FILES_S3_BUCKET: "files",
      FILES_S3_ACCESS_KEY: "test-key", FILES_S3_SECRET_KEY: "test-secret" });
    expect(configured.workspace).toEqual({ strategy: "checkpoint_restore", checkpointIntervalMs: 45_000 });
  });

  it("parses the string-encoded flags and numbers exactly as the assembly did", () => {
    const config = loadNodeConfig({
      ...minimal,
      AUTH_DISABLED: "1", AUTH_REQUIRE_EMAIL_VERIFY: "1", MEMORY_QUEUE: "disabled",
      DREAM_CURATOR_MODE: "dedup", OMA_SESSION_EXECUTION_CONCURRENCY: "3", OMA_SESSION_EXECUTION_OWNER_ID: "replica-a",
      OMA_SESSION_MAX_TOKENS: "250000", OMA_SESSION_MAX_CHILD_TURNS: "5",
      ANTHROPIC_CUSTOM_HEADERS: "X-A: 1, X-B: two:parts",
      SMTP_HOST: "smtp", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "noreply@x",
      PUBLIC_BASE_URL: "https://pub",
    });
    expect(config.auth.disabled).toBe(true);
    expect(config.auth.requireEmailVerify).toBe(true);
    expect(config.memoryQueue).toBe("disabled");
    expect(config.dreamCurator).toBe("dedup");
    expect(config.execution).toEqual({ concurrency: 3, ownerId: "replica-a" });
    expect(config.sessionLimits).toEqual({ maxTokens: 250_000, maxChildTurns: 5 });
    expect(config.model.customHeaders).toEqual({ "X-A": "1", "X-B": "two:parts" });
    expect(config.email).toEqual({ host: "smtp", port: 465, secure: true, user: "u", pass: "p", fromAddress: "noreply@x" });
    expect(config.http.publicBaseUrl).toBe("https://pub");
  });

  it("reads extra trusted sign-in origins for a console served from another origin", () => {
    expect(loadNodeConfig(minimal).auth.trustedOrigins).toEqual([]);
    expect(loadNodeConfig({
      ...minimal,
      AUTH_TRUSTED_ORIGINS: " http://localhost:5174 , ,https://console.example ",
    }).auth.trustedOrigins).toEqual(["http://localhost:5174", "https://console.example"]);
  });

  it("reports every configuration problem at once", () => {
    let error: Error | undefined;
    try {
      loadNodeConfig({
        ...minimal,
        OMA_REALTIME_FANOUT: "redis",
        OMA_SESSION_EXECUTION_CONCURRENCY: "many",
        MEMORY_S3_ENDPOINT: "http://s3", MEMORY_S3_BUCKET: "b", MEMORY_S3_ACCESS_KEY: "a", MEMORY_S3_SECRET_KEY: "s",
        MEMORY_S3_POLL_INTERVAL_SEC: "soon",
        SMTP_HOST: "smtp", SMTP_PORT: "abc",
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.name).toBe("NodeConfigError");
    expect(error?.message).toContain("4 problems");
    for (const key of ["OMA_REALTIME_FANOUT", "OMA_SESSION_EXECUTION_CONCURRENCY", "MEMORY_S3_POLL_INTERVAL_SEC", "SMTP_PORT"]) {
      expect(error?.message.split(key).length - 1).toBe(1);
    }
  });

  it("ignores SANDBOX_GATEWAY_BASE_URL: no agent in the VM calls the server for its model (D41)", () => {
    const config = loadNodeConfig({ ...minimal, SANDBOX_GATEWAY_BASE_URL: "not a url" });
    expect(config.http).not.toHaveProperty("sandboxGatewayBaseUrl");
  });

  it("ignores OPENMA_PROCESS_MODE: the serverless mode is gone, every process runs its own background work (cleanup.md 4.6)", () => {
    const config = loadNodeConfig({ ...minimal, OPENMA_PROCESS_MODE: "serverless" });
    expect(config).not.toHaveProperty("processMode");
    expect(config.database).toEqual({ kind: "sqlite", path: "./data/oma.db" });
  });

  it("ignores GATEWAY_ORIGIN: only the removed integration webhooks read it (cleanup.md 5.1)", () => {
    const config = loadNodeConfig({ ...minimal, GATEWAY_ORIGIN: "https://gw" });
    expect(config.http).not.toHaveProperty("gatewayOrigin");
  });
});

describe("redactNodeConfig", () => {
  it("hides secrets and credentials but keeps everything needed to recognise a deployment", () => {
    const config: NodeConfig = loadNodeConfig({
      ...minimal,
      DATABASE_URL: "postgres://qa:supersecret@db.internal:5432/openma",
      BETTER_AUTH_SECRET: "auth-secret", PLATFORM_ROOT_SECRET: "root-secret", API_KEY: "static-key",
      GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret",
      ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: "https://llm",
      MEMORY_S3_ENDPOINT: "http://s3", MEMORY_S3_BUCKET: "mem", MEMORY_S3_ACCESS_KEY: "ak", MEMORY_S3_SECRET_KEY: "sk",
      SMTP_HOST: "smtp", SMTP_PASS: "smtp-pass",
      METRICS_BIND_TOKEN: "mt", OMA_MANAGED_AGENTS_WEBHOOK_SIGNING_KEY: "wk",
      E2B_API_KEY: "e2b-secret",
    });

    const redacted = JSON.stringify(redactNodeConfig(config));

    for (const secret of ["supersecret", "auth-secret", "root-secret", "static-key", "gsecret", "sk-ant", "\"sk\"", "smtp-pass", "\"mt\"", "\"wk\"", "e2b-secret"]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("postgres://qa:***@db.internal:5432/openma");
    expect(redacted).toContain("https://llm");
    expect(redacted).toContain("\"bucket\":\"mem\"");
    expect(redacted).toContain("\"gid\"");
    expect(redacted).toContain("\"kind\":\"postgres\"");
    // The provider's own namespace is opaque to the control plane and is not echoed.
    expect(redacted).not.toContain("environment");
  });
});
