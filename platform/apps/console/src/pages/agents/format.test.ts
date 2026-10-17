import { describe, expect, it } from "vitest";

import { formatDate, formatDateTime, speedLabel, toolLabel } from "./format";

describe("agents/format", () => {
  it("writes a date as dd.MM.yyyy with leading zeros", () => {
    expect(formatDate(new Date(2026, 0, 5, 7, 3))).toBe("05.01.2026");
    expect(formatDate(new Date(2026, 9, 15, 23, 59))).toBe("15.10.2026");
  });

  it("writes date and time as dd.MM.yyyy HH:mm in local time", () => {
    expect(formatDateTime(new Date(2026, 0, 5, 7, 3))).toBe("05.01.2026 07:03");
    expect(formatDateTime(new Date(2026, 9, 15, 23, 59))).toBe("15.10.2026 23:59");
  });

  it("accepts ISO strings and epoch milliseconds", () => {
    const date = new Date(2026, 7, 31, 10, 0);
    expect(formatDateTime(date.toISOString())).toBe("31.08.2026 10:00");
    expect(formatDate(date.getTime())).toBe("31.08.2026");
  });

  it("returns a plain hyphen for empty or broken values", () => {
    expect(formatDate(undefined)).toBe("-");
    expect(formatDate(null)).toBe("-");
    expect(formatDate("")).toBe("-");
    expect(formatDateTime("not a date")).toBe("-");
  });

  it("names the model speed in Russian and keeps unknown values", () => {
    expect(speedLabel(undefined)).toBe("стандартная");
    expect(speedLabel("standard")).toBe("стандартная");
    expect(speedLabel("fast")).toBe("быстрая");
    expect(speedLabel("turbo")).toBe("turbo");
  });

  it("names the tools of an agent in Russian and keeps unknown types", () => {
    expect(toolLabel({ type: "agent_toolset_20260401" })).toBe("Базовый набор инструментов");
    expect(toolLabel({ type: "custom", name: "lookup" })).toBe("Свой: lookup");
    expect(toolLabel({ type: "mcp_toolset", mcp_server_name: "documentolog" })).toBe(
      "MCP: documentolog",
    );
    expect(toolLabel({ type: "mcp_toolset" })).toBe("MCP-сервер");
    expect(toolLabel({ type: "future_toolset" })).toBe("future_toolset");
  });

  it("помечает MCP-сервер, который вызывается без подтверждения (план cma-wave-1, 3.1)", () => {
    const allow = { permission_policy: { type: "always_allow" } };
    const ask = { permission_policy: { type: "always_ask" } };
    expect(toolLabel({ type: "mcp_toolset", mcp_server_name: "iiko", default_config: allow })).toBe(
      "MCP: iiko, без подтверждения",
    );
    expect(toolLabel({ type: "mcp_toolset", mcp_server_name: "iiko", default_config: ask })).toBe(
      "MCP: iiko",
    );
    expect(toolLabel({ type: "mcp_toolset", mcp_server_name: "iiko" })).toBe("MCP: iiko");
  });
});
