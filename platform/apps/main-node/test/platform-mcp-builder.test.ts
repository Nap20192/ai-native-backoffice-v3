// BC1: шаблон агента-ассистента, комплект установки и тексты K/ (docs/plans/builder-agent.md, 1.5, 2.3, 3.2, 4).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { getToolPermission } from "@open-managed-agents/agent/harness/tools";
import { agentCreateBodySchema } from "../../../packages/managed-agents-api/src/contracts/agents";
import { environmentCreateBodySchema } from "../../../packages/managed-agents-api/src/contracts/environments";
import {
  BUILDER_ALWAYS_ALLOW_TOOLS,
  BUILDER_DRAFT_TOOLS,
  BUILDER_TEMPLATE_VERSION,
  PLATFORM_MCP_SERVER_NAME,
  assistantDir,
  buildBuilderAgentConfig,
  buildBuilderDraftTools,
  buildBuilderEnvironmentConfig,
  readBuilderPrompt,
} from "../src/lib/platform-mcp/builder-template";
import { buildBuilderBundleRoutes } from "../src/lib/platform-mcp/builder-bundle";

const MCP_URL = "http://127.0.0.1:8788/v1/oma/platform-mcp";

// Список 2.3 плана. Когда BS1 положит tool-table.ts, тест сверяет шаблон с таблицей.
const READ_TOOLS = ["help", "search_docs", "search_config", "list", "get", "read_content", "get_session_events", "get_trajectory", "request_secret", "get_dependencies"];
const DRAFT_TOOLS = ["preview_change"];
const WRITE_TOOLS = [
  "create_agent", "create_environment", "create_skill", "upload_file", "create_memory_store", "create_deployment", "create_session",
  "write_memory",
  "update_agent", "restore_agent_version", "update_environment", "create_skill_version", "update_memory_store", "update_deployment",
  "update_model_card", "send_message",
  "update_session", "add_session_resource", "pause_deployment", "unpause_deployment", "run_deployment", "unarchive_object",
  "apply_changes",
];
// Класс «опасное» из crud.md 3.1: своя группа в диалоге шаблона.
const DANGER_TOOLS = ["archive_object", "delete_object"];
const ALL_TOOLS = [...READ_TOOLS, ...DRAFT_TOOLS, ...WRITE_TOOLS, ...DANGER_TOOLS];

const DOCS = ["platform-builder.md", "writing-skills.md", "system-prompts.md", "outcomes-and-evals.md", "session-review.md", "platform-reference.md"];
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("шаблон ассистента", () => {
  it("проходит схему создания агента и держит состав из 3.2", () => {
    const agent = buildBuilderAgentConfig({ model: "qwen3.6-35b", platformMcpUrl: MCP_URL });
    expect(agentCreateBodySchema.safeParse(agent).success).toBe(true);
    expect(agent.model).toBe("qwen3.6-35b");
    expect(agent.metadata).toEqual({ oma_role: "builder", oma_template_version: String(BUILDER_TEMPLATE_VERSION) });
    expect(BUILDER_TEMPLATE_VERSION).toBe(2);
    expect(agent.system).toBe(readBuilderPrompt());
    expect(agent.mcp_servers).toEqual([{ type: "url", name: PLATFORM_MCP_SERVER_NAME, url: MCP_URL }]);
    expect(agent).not.toHaveProperty("skills");
    expect(agent).not.toHaveProperty("multiagent");
    expect(agent).not.toHaveProperty("_oma");
    expect(agent.tools).toHaveLength(2);
    expect(agent.tools![0]).toEqual({ type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [] });
    expect(agent.tools![1]).toMatchObject({
      type: "mcp_toolset",
      mcp_server_name: "platform",
      default_config: { permission_policy: { type: "always_ask" } },
    });
  });

  it("разрешает без вопроса ровно 11 инструментов чтения и черновика", () => {
    expect(ALL_TOOLS).toHaveLength(36);
    expect(new Set(ALL_TOOLS).size).toBe(36);
    expect([...BUILDER_ALWAYS_ALLOW_TOOLS].sort()).toEqual([...READ_TOOLS, ...DRAFT_TOOLS].sort());
    const agent = buildBuilderAgentConfig({ model: "m", platformMcpUrl: MCP_URL });
    const config = { tools: agent.tools } as Parameters<typeof getToolPermission>[0];
    const allowed = ALL_TOOLS.filter((name) => getToolPermission(config, `mcp__platform__${name}`) === "always_allow");
    expect(allowed.sort()).toEqual([...READ_TOOLS, ...DRAFT_TOOLS].sort());
    for (const name of [...WRITE_TOOLS, ...DANGER_TOOLS]) expect(getToolPermission(config, `mcp__platform__${name}`)).toBe("always_ask");
    expect(getToolPermission(config, "mcp__platform__future_tool")).toBe("always_ask");
  });

  it("набор «черновик» оставляет 4 инструмента и выключенные встроенные", () => {
    expect([...BUILDER_DRAFT_TOOLS].sort()).toEqual(["get", "help", "list", "preview_change"]);
    const tools = buildBuilderDraftTools();
    expect(tools[0]).toEqual({ type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [] });
    expect(tools[1]).toMatchObject({ type: "mcp_toolset", mcp_server_name: "platform", default_config: { enabled: false } });
    const enabled = (tools[1] as { configs: Array<{ name: string; enabled: boolean }> }).configs.filter((c) => c.enabled).map((c) => c.name);
    expect(enabled.sort()).toEqual(["get", "help", "list", "preview_change"]);
    const parsed = agentCreateBodySchema.safeParse({ name: "x", model: "m", tools });
    expect(parsed.success).toBe(true);
  });

  it("окружение «Ассистент»: сеть limited без хостов и с MCP", () => {
    const environment = buildBuilderEnvironmentConfig();
    expect(environmentCreateBodySchema.safeParse(environment).success).toBe(true);
    expect(environment.name).toBe("Ассистент");
    expect(environment.metadata).toEqual({ oma_role: "builder" });
    expect(environment.config).toEqual({
      type: "cloud",
      networking: { type: "limited", allowed_hosts: [], allow_mcp_servers: true, allow_package_managers: false, allow_web_search: false },
    });
  });
});

describe("GET /v1/oma/platform-mcp/builder-bundle", () => {
  function app(tenant: string | null = "ws1") {
    const root = new Hono<{ Variables: { tenant_id?: string } }>();
    root.use("*", async (c, next) => {
      if (tenant) c.set("tenant_id", tenant);
      await next();
    });
    root.route("/v1/oma/platform-mcp/builder-bundle", buildBuilderBundleRoutes({ platformMcpUrl: MCP_URL }));
    return root;
  }

  it("отдаёт окружение, агента с выбранной моделью и группы инструментов", async () => {
    const response = await app().request("/v1/oma/platform-mcp/builder-bundle?model=qwen3.6-35b");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.type).toBe("builder_bundle");
    expect(body.environment).toEqual(buildBuilderEnvironmentConfig());
    expect(body.agent).toEqual(buildBuilderAgentConfig({ model: "qwen3.6-35b", platformMcpUrl: MCP_URL }));
    expect(body.needs_model).toBe(false);
    expect(body.draft_tools).toEqual(buildBuilderDraftTools());
    expect(body.template_version).toBe(BUILDER_TEMPLATE_VERSION);
    expect(body.tool_groups.map((g: { id: string }) => g.id)).toEqual(["read", "draft", "write", "danger"]);
    expect(body.tool_groups.at(-1)).toMatchObject({ title: "Архив и удаление", confirm: true, tools: DANGER_TOOLS });
    const grouped = body.tool_groups.flatMap((g: { tools: string[] }) => g.tools).sort();
    expect(grouped).toEqual([...ALL_TOOLS].sort());
  });

  it("без модели отдаёт агента без поля model", async () => {
    const body = await (await app().request("/v1/oma/platform-mcp/builder-bundle")).json();
    expect(body.needs_model).toBe(true);
    expect(body.agent).not.toHaveProperty("model");
    expect(agentCreateBodySchema.safeParse({ ...body.agent, model: "m" }).success).toBe(true);
  });

  it("требует пространство и проверяет модель", async () => {
    expect((await app(null).request("/v1/oma/platform-mcp/builder-bundle")).status).toBe(401);
    expect((await app().request("/v1/oma/platform-mcp/builder-bundle?model=")).status).toBe(400);
    expect((await app().request(`/v1/oma/platform-mcp/builder-bundle?model=${"m".repeat(300)}`)).status).toBe(400);
  });
});

describe("тексты ассистента K/", () => {
  it("промпт задаёт правила v1 и называет инструменты из 2.3", () => {
    const prompt = readBuilderPrompt();
    expect(prompt.length).toBeGreaterThan(2000);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(16_000);
    for (const name of ["apply_changes", "preview_change", "create_session", "send_message", "search_docs", "request_secret", "help"]) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain("<data");
    expect(prompt).toContain("<page_context>");
    // повторная запись: сверка с уже созданным и handle модели вместо id карточки
    expect(prompt).toContain("Перед новой записью сверься с тем, что уже создано в этом разговоре");
    expect(prompt).toContain("Не создавай повторно объект с тем же именем");
    expect(prompt).toContain("`card_id`");
    // имена в обратных кавычках вида snake_case, похожие на инструмент, должны быть из списка
    const mentioned = [...prompt.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!);
    const known = new Set([...ALL_TOOLS, "oma_role", "oma_created_via", "oma_assistant_session", "page_context", "always_ask", "always_allow", "agent_toolset_20260401", "user_message", "expected_version", "expected_revision", "mount_path", "file_id", "environment_id", "session_id", "tool_use_id", "model_usage", "session_usage", "initial_events", "allow_mcp_servers", "max_iterations", "needs_revision", "path_prefix", "memory_store_id", "agent_id", "skill_id", "deployment_id", "model_card_id", "display_title", "web_fetch", "web_search", "allowed_hosts", "card_id"]);
    for (const name of mentioned) expect(known, name).toContain(name);
  });

  it("документы для search_docs на месте, с разделами и без чужих команд", () => {
    const docsDir = `${assistantDir()}/docs`;
    expect(readdirSync(docsDir).filter((f) => f.endsWith(".md")).sort()).toEqual([...DOCS].sort());
    for (const doc of DOCS) {
      const text = readFileSync(`${docsDir}/${doc}`, "utf8");
      expect(text.startsWith("# "), doc).toBe(true);
      expect((text.match(/^## /gm) ?? []).length, doc).toBeGreaterThanOrEqual(3);
      expect(text, doc).not.toMatch(/\boma (agents|sessions|envs|models|keys|skills)\b/);
      expect(text, doc).not.toMatch(/claude-(opus|sonnet|haiku)/);
      expect(text, doc).not.toMatch(/resume_deployment|archive_vault|delete_vault|interrupt_session/);
    }
    const builder = readFileSync(`${docsDir}/platform-builder.md`, "utf8");
    for (const name of ["create_session", "send_message", "apply_changes"]) expect(builder).toContain(name);
    const reference = readFileSync(`${docsDir}/platform-reference.md`, "utf8");
    for (const word of ["Файлы", "outcome", "рубрик"]) expect(reference).toContain(word);
  });

  it("лицензии источников лежат рядом и названы в THIRD_PARTY_NOTICES.md", () => {
    const notices = readFileSync(`${assistantDir()}/THIRD_PARTY_NOTICES.md`, "utf8");
    const licenseFiles = [...notices.matchAll(/`(licenses\/[^`]+)`/g)].map((m) => m[1]!);
    expect(licenseFiles.length).toBeGreaterThanOrEqual(2);
    for (const file of licenseFiles) expect(existsSync(`${assistantDir()}/${file}`), file).toBe(true);
    for (const name of ["OpenMA", "skill-creator", "Apache"]) expect(notices).toContain(name);
  });

  it("промпт, документы и уведомления проходят unslop-check", () => {
    const files = ["prompt.md", "THIRD_PARTY_NOTICES.md", ...DOCS.map((d) => `docs/${d}`)].map((f) => `${assistantDir()}/${f}`);
    const run = () => execFileSync(process.execPath, [`${repoRoot}scripts/unslop-check.mjs`, ...files], { cwd: repoRoot, encoding: "utf8" });
    expect(run).not.toThrow();
  });
});
