import { describe, expect, it } from "vitest";
import {
  classifyCreateSession,
  classifyDeploymentEdit,
  classifyEdit,
  classifySendMessage,
  classifyWriteMemory,
  isAssistantAgent,
} from "../src/lib/platform-mcp/classify";
import { maxOpClass } from "../src/lib/platform-mcp/ports";

const URL = "http://127.0.0.1:8787/v1/oma/platform-mcp";

describe("platform MCP operation classes", () => {
  it("write_memory is a create on a free path and an edit on a taken one", () => {
    expect(classifyWriteMemory({ pathTaken: false, storeArchived: false }).cls).toBe("create");
    expect(classifyWriteMemory({ pathTaken: true, storeArchived: false }).cls).toBe("update");
    expect(classifyWriteMemory({ pathTaken: false, storeArchived: true }).cls).toBe("out_of_v1");
  });

  it("update_deployment edits only a paused deployment", () => {
    expect(classifyDeploymentEdit({ status: "paused", archived_at: null }).cls).toBe("update");
    const active = classifyDeploymentEdit({ status: "active", archived_at: null });
    expect(active.cls).toBe("out_of_v1");
    expect(active.reason).toContain("Деплоймент работает");
    expect(classifyDeploymentEdit({ status: "paused", archived_at: "2026-10-01T00:00:00Z" }).cls).toBe("out_of_v1");
  });

  it("an archived object and the assistant's own agent or environment are out of v1", () => {
    expect(classifyEdit({ archived: false, ownAssistantTarget: false }).cls).toBe("update");
    expect(classifyEdit({ archived: true, ownAssistantTarget: false }).cls).toBe("out_of_v1");
    expect(classifyEdit({ archived: false, ownAssistantTarget: true }).cls).toBe("out_of_v1");
  });

  it("create_session refuses the assistant agent and archived objects", () => {
    const assistant = { mcp_servers: [{ type: "url", name: "platform", url: `${URL}/` }] };
    expect(isAssistantAgent(assistant, URL)).toBe(true);
    expect(isAssistantAgent({ mcp_servers: [{ type: "url", url: "https://other.example.com/mcp" }] }, URL)).toBe(false);
    expect(classifyCreateSession({ agentIsAssistant: true, agentArchived: false, environmentArchived: false }).cls).toBe("out_of_v1");
    expect(classifyCreateSession({ agentIsAssistant: false, agentArchived: true, environmentArchived: false }).cls).toBe("out_of_v1");
    expect(classifyCreateSession({ agentIsAssistant: false, agentArchived: false, environmentArchived: true }).cls).toBe("out_of_v1");
    expect(classifyCreateSession({ agentIsAssistant: false, agentArchived: false, environmentArchived: false }).cls).toBe("create");
  });

  it("send_message is an edit only for the first message into an idle session of this conversation", () => {
    const ok = { createdByThisConversation: true, status: "idle", archived: false, userMessages: 0 };
    expect(classifySendMessage(ok).cls).toBe("update");
    for (const change of [
      { createdByThisConversation: false },
      { status: "running" },
      { archived: true },
      { userMessages: 1 },
    ]) {
      const result = classifySendMessage({ ...ok, ...change });
      expect(result.cls).toBe("out_of_v1");
      expect(result.reason).toBe("В первой версии ассистент отправляет только первое сообщение в сессию, которую создал сам");
    }
  });

  it("a batch takes the highest class", () => {
    expect(maxOpClass(["create", "update", "create"])).toBe("update");
    expect(maxOpClass(["create", "out_of_v1"])).toBe("out_of_v1");
    expect(maxOpClass([])).toBe("read");
  });
});
