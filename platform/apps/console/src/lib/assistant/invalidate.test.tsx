import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ThreadItem } from "./events";
import { listPathsFor, matchesListPath, useInvalidateOnApplied } from "./invalidate";

type Proposal = Extract<ThreadItem, { kind: "proposal" }>;

function applied(id: string, kind: string, objectId: string | null = null): Proposal {
  return {
    kind: "proposal",
    id,
    tool: `create_${kind}`,
    input: {},
    phase: "applied",
    applied: [{ tool: `create_${kind}`, kind, id: objectId, name: null, version: null, action: "create" }],
  };
}

describe("listPathsFor", () => {
  it("называет списки консоли по виду созданного объекта", () => {
    expect(listPathsFor([applied("t1", "agent")])).toEqual(["/v1/agents"]);
    expect(listPathsFor([applied("t1", "environment"), applied("t2", "skill"), applied("t3", "session")])).toEqual([
      "/v1/environments",
      "/v1/skills",
      "/v1/sessions",
    ]);
    expect(listPathsFor([applied("t1", "memory"), applied("t2", "memory_store")])).toEqual(["/v1/memory_stores"]);
    expect(listPathsFor([applied("t1", "message")])).toEqual(["/v1/sessions"]);
  });

  it("путь списка совпадает с путём объекта, но не с соседним", () => {
    expect(matchesListPath("/v1/agents", ["/v1/agents"])).toBe(true);
    expect(matchesListPath("/v1/agents/agent_1", ["/v1/agents"])).toBe(true);
    expect(matchesListPath("/v1/agents?limit=20", ["/v1/agents"])).toBe(true);
    expect(matchesListPath("/v1/agents_extra", ["/v1/agents"])).toBe(false);
    expect(matchesListPath(42, ["/v1/agents"])).toBe(false);
  });
});

describe("useInvalidateOnApplied", () => {
  function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, spy, wrapper };
  }

  it("после применённой записи обновляет список агентов один раз", () => {
    const { spy, wrapper } = setup();
    const pending: Proposal = { ...applied("t1", "agent"), phase: "sent", applied: undefined };
    const { rerender } = renderHook(({ thread }) => useInvalidateOnApplied(thread), {
      wrapper,
      initialProps: { thread: [pending] as ThreadItem[] },
    });
    expect(spy).not.toHaveBeenCalled();
    rerender({ thread: [applied("t1", "agent", "agent_1")] });
    expect(spy).toHaveBeenCalledTimes(1);
    const predicate = spy.mock.calls[0][0]!.predicate!;
    expect(predicate({ queryKey: ["/v1/agents", "infinite"] } as never)).toBe(true);
    expect(predicate({ queryKey: ["/v1/environments"] } as never)).toBe(false);
    rerender({ thread: [applied("t1", "agent", "agent_1")] });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("отклонённая и упавшая запись списки не трогают", () => {
    const { spy, wrapper } = setup();
    const denied: Proposal = { ...applied("t1", "agent"), phase: "denied", applied: undefined };
    const failed: Proposal = { ...applied("t2", "agent"), phase: "failed", applied: undefined };
    renderHook(() => useInvalidateOnApplied([denied, failed]), { wrapper });
    expect(spy).not.toHaveBeenCalled();
  });

  it("без QueryClientProvider ничего не ломает", () => {
    expect(() => renderHook(() => useInvalidateOnApplied([applied("t1", "agent")]))).not.toThrow();
  });
});
