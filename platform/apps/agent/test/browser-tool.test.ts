// Our Node server passes no BrowserHarness to buildTools (docs/plans/cleanup.md,
// 3.3). An agent that opted in to browser must not see browser_* tools or a
// hint about them. No /v1 agent can carry browser, so the build sends no event.
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, SessionEvent } from "@open-managed-agents/shared";
import { buildTools } from "../src/harness/tools";

const disabled = { type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [] };
const agent = (names: string[]): AgentConfig =>
  ({ tools: [{ ...disabled, configs: names.map((name) => ({ name, enabled: true })) }] }) as unknown as AgentConfig;

describe("browser tool without a BrowserHarness", () => {
  it("offers no browser tool and no browser hint to an agent that opted in", async () => {
    const events: SessionEvent[] = [];
    const tools = await buildTools(agent(["browser", "web_fetch"]), {} as any, {
      broadcastEvent: (event) => events.push(event),
    });
    expect(Object.keys(tools)).toEqual(["web_fetch"]);
    expect(events).toEqual([]);
    expect(tools.web_fetch.description).not.toContain("browser");
  });

  it("hints no browser for an agent without it", async () => {
    const tools = await buildTools(agent(["web_fetch"]), {} as any);
    expect(tools.web_fetch.description).not.toContain("browser");
  });

  it("builds without a broadcaster, as the legacy Node path does", async () => {
    const tools = await buildTools(agent(["browser"]), {} as any);
    expect(Object.keys(tools)).toEqual([]);
  });

  it("keeps browser tools and the web_fetch hint when a harness is passed", async () => {
    const launch = vi.fn();
    const events: SessionEvent[] = [];
    const tools = await buildTools(agent(["browser", "web_fetch"]), {} as any, {
      browser: { launch } as any,
      broadcastEvent: (event) => events.push(event),
    });
    expect(Object.keys(tools)).toContain("browser_navigate");
    expect(tools.web_fetch.description).toContain("browser_*");
    expect(events).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });
});
