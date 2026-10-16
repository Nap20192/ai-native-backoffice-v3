// GET /v1/oma/platform-mcp/builder-bundle (docs/plans/builder-agent.md, 1.5).
// Комплект установки: окружение «Ассистент» и агент. Ставит их консоль обычным API
// по кнопке пользователя, ассистент этот маршрут не вызывает.
import { Hono, type Context } from "hono";
import {
  BUILDER_ALWAYS_ALLOW_TOOLS,
  BUILDER_WRITE_TOOLS,
  buildBuilderAgentConfig,
  buildBuilderDraftTools,
  buildBuilderEnvironmentConfig,
} from "./builder-template.js";

export interface BuilderBundleRoutesDeps {
  /** PLATFORM_MCP_URL из конфигурации main-node. */
  platformMcpUrl: string;
}

type Variables = { tenant_id?: string };

const MAX_MODEL_LENGTH = 256;

const READ_TOOLS = BUILDER_ALWAYS_ALLOW_TOOLS.filter((name) => name !== "preview_change");

const TOOL_GROUPS = [
  { id: "read", title: "Чтение и поиск", confirm: false, tools: READ_TOOLS },
  { id: "draft", title: "Черновик", confirm: false, tools: ["preview_change"] },
  { id: "write", title: "Создание и правка", confirm: true, tools: [...BUILDER_WRITE_TOOLS] },
];

export function buildBuilderBundleRoutes(deps: BuilderBundleRoutesDeps): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/", (c) => {
    if (!workspaceOf(c)) return c.json({ error: "Нужен вход в рабочее пространство", field: null }, 401);
    const model = c.req.query("model");
    if (model !== undefined && (model.trim().length === 0 || model.length > MAX_MODEL_LENGTH)) {
      return c.json({ error: `model: имя карточки модели от 1 до ${MAX_MODEL_LENGTH} знаков`, field: "model" }, 400);
    }
    return c.json(
      {
        type: "builder_bundle",
        needs_model: model === undefined,
        environment: buildBuilderEnvironmentConfig(),
        agent: buildBuilderAgentConfig({ platformMcpUrl: deps.platformMcpUrl, ...(model === undefined ? {} : { model }) }),
        draft_tools: buildBuilderDraftTools(),
        tool_groups: TOOL_GROUPS,
      },
      200,
    );
  });

  return app;
}

function workspaceOf(c: Context): string | null {
  const workspaceId = (c.var as Variables).tenant_id;
  return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : null;
}
