import { renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { modelCardRevision, useModelCardActions } from "./model-cards-api";
import { server } from "../mocks/server";

describe("useModelCardActions", () => {
  it("archives with If-Match", async () => {
    let seen: string | null = null;
    server.use(
      http.post("*/v1/oma/model_cards/mc_1/archive", ({ request }) => {
        seen = request.headers.get("if-match");
        return HttpResponse.json({ id: "mc_1", archived_at: "2026-10-16T00:00:00.000Z" });
      }),
    );
    const { result } = renderHook(() => useModelCardActions());
    const card = await result.current.archive({ id: "mc_1", ifMatch: "2026-10-16T10:00:00.000Z" });
    expect(card.id).toBe("mc_1");
    expect(seen).toBe("2026-10-16T10:00:00.000Z");
  });

  it("restores an archived card", async () => {
    server.use(
      http.post("*/v1/oma/model_cards/mc_1/unarchive", () => HttpResponse.json({ id: "mc_1" })),
    );
    const { result } = renderHook(() => useModelCardActions());
    await expect(result.current.unarchive({ id: "mc_1" })).resolves.toMatchObject({ id: "mc_1" });
  });

  it("deletes with DELETE and carries the 409 list", async () => {
    const dependencies = {
      blocking: [{ kind: "agent", id: "agent_1", name: "Бот", status: null, note: null }],
      affected: [],
      truncated: false,
    };
    server.use(
      http.delete("*/v1/oma/model_cards/mc_1", () =>
        HttpResponse.json(
          { type: "error", error: { type: "dependency_conflict_error", message: "x", dependencies } },
          { status: 409 },
        ),
      ),
    );
    const { result } = renderHook(() => useModelCardActions());
    const error = await result.current.remove({ id: "mc_1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).dependencies).toEqual(dependencies);
  });

  it("takes updated_at, then created_at as the revision", () => {
    expect(modelCardRevision({ created_at: "a", updated_at: "b" })).toBe("b");
    expect(modelCardRevision({ created_at: "a" })).toBe("a");
  });
});
