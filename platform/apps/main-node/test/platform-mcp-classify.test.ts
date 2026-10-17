import { describe, expect, it } from "vitest";
import {
  classifyCreateSession,
  classifyDanger,
  classifyDeploymentEdit,
  classifyDeploymentState,
  classifyEdit,
  classifySendMessage,
  classifyWriteMemory,
  isAssistantAgent,
  REASON_DEPENDENCIES,
  REASON_OWN,
} from "../src/lib/platform-mcp/classify";
import { maxOpClass } from "../src/lib/platform-mcp/ports";

const URL = "http://127.0.0.1:8787/v1/oma/platform-mcp";

describe("platform MCP operation classes", () => {
  it("write_memory is a create on a free path and an edit on a taken one", () => {
    expect(classifyWriteMemory({ pathTaken: false, storeArchived: false }).cls).toBe("create");
    expect(classifyWriteMemory({ pathTaken: true, storeArchived: false }).cls).toBe("update");
    expect(classifyWriteMemory({ pathTaken: false, storeArchived: true }).cls).toBe("out_of_v1");
  });

  it("update_deployment edits a paused deployment and an active one with a warning", () => {
    expect(classifyDeploymentEdit({ status: "paused", archived_at: null })).toEqual({ cls: "update", reason: null, warning: null });
    const active = classifyDeploymentEdit({ status: "active", archived_at: null });
    expect(active.cls).toBe("update");
    expect(active.warning).toBe("Следующий запуск возьмёт новую конфигурацию");
    expect(classifyDeploymentEdit({ status: "paused", archived_at: "2026-10-01T00:00:00Z" }).cls).toBe("out_of_v1");
  });

  it("pause, unpause and run are edits of a deployment out of the archive", () => {
    for (const status of ["paused", "active"]) expect(classifyDeploymentState({ status, archived_at: null }).cls).toBe("update");
    expect(classifyDeploymentState({ status: "paused", archived_at: "2026-10-01T00:00:00Z" }).cls).toBe("out_of_v1");
  });

  it("archive and delete are danger; the assistant's own object and a blocking dependency are out of v1", () => {
    expect(classifyDanger({ ownAssistantTarget: false, blocking: [] })).toEqual({ cls: "danger", reason: null });
    expect(classifyDanger({ ownAssistantTarget: true, blocking: [] })).toEqual({ cls: "out_of_v1", reason: REASON_OWN });
    const blocked = classifyDanger({
      ownAssistantTarget: false,
      blocking: [
        { kind: "deployment", id: "depl_1", name: "Утренний отчёт", status: "active", note: "запуски упадут" },
        { kind: "session", id: "sesn_2", name: null, status: "running", note: null },
      ],
    });
    expect(blocked.cls).toBe("out_of_v1");
    expect(blocked.reason).toBe(`${REASON_DEPENDENCIES}: деплоймент «Утренний отчёт» (depl_1), сессия sesn_2`);
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
    expect(maxOpClass(["update", "danger", "create"])).toBe("danger");
    expect(maxOpClass(["danger", "out_of_v1"])).toBe("out_of_v1");
    expect(maxOpClass([])).toBe("read");
  });
});
