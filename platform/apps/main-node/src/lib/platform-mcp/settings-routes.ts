// `GET` and `POST /v1/oma/platform-mcp/settings` (builder-agent.md 3.7).
// Any member reads the switch. Only `owner` or `admin` from `membership`
// changes it. The route is not in the tool table, so the assistant never
// switches itself on; its token gets 403 here as well.

import { Hono, type Context } from "hono";
import type { MembershipRoles, SettingsStore } from "./settings-store";

export interface SettingsRoutesDeps {
  settings: SettingsStore;
  roles: MembershipRoles;
}

type Vars = { Variables: { tenant_id: string; user_id?: string; auth_credential?: unknown } };

const NOT_ALLOWED = "Включать и выключать ассистента может владелец или администратор пространства";

function isPlatformToken(c: Context<Vars>): boolean {
  const credential = c.get("auth_credential") as { type?: unknown } | undefined;
  return credential?.type === "platform_mcp_actor";
}

function forbidden(c: Context<Vars>, message: string) {
  return c.json({ error: { type: "forbidden", message } }, 403);
}

export function buildSettingsRoutes(deps: SettingsRoutesDeps): Hono<Vars> {
  const app = new Hono<Vars>();

  async function canChange(c: Context<Vars>): Promise<boolean> {
    const userId = c.get("user_id");
    if (!userId) return false;
    const role = await deps.roles.roleOf(c.get("tenant_id"), userId);
    return role === "owner" || role === "admin";
  }

  async function view(c: Context<Vars>) {
    const current = await deps.settings.get(c.get("tenant_id"));
    return {
      enabled: current?.enabled ?? true,
      updated_by: current?.updatedBy ?? null,
      updated_at: current?.updatedAt ?? null,
      can_change: await canChange(c),
    };
  }

  app.get("/", async (c) => {
    if (isPlatformToken(c)) return forbidden(c, "Ассистенту этот маршрут закрыт");
    return c.json(await view(c));
  });

  app.post("/", async (c) => {
    if (isPlatformToken(c)) return forbidden(c, "Ассистенту этот маршрут закрыт");
    const userId = c.get("user_id");
    if (!userId || !(await canChange(c))) return forbidden(c, NOT_ALLOWED);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: "invalid_request", message: "Тело должно быть JSON" } }, 400);
    }
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") {
      return c.json({ error: { type: "invalid_request", message: "Поле enabled должно быть true или false" } }, 400);
    }
    await deps.settings.set(c.get("tenant_id"), enabled, userId);
    return c.json(await view(c));
  });

  return app;
}
