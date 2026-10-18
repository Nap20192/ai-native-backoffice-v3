import { describe, expect, it } from "vitest";

import type { Event } from "./events";
import { lastSessionStop, raisedSessionLimits, readSessionLimits } from "./session-limits";

const idle = (id: string, reason?: string): Event => ({
  type: "session.status_idle",
  id,
  ...(reason ? { stop_reason: { type: reason } } : {}),
});

describe("lastSessionStop", () => {
  it("берёт последний session.status_idle и его причину", () => {
    const events: Event[] = [
      { type: "session.status_running", id: "r1" },
      idle("i1", "end_turn"),
      { type: "user.message", id: "u2" },
      { type: "session.status_running", id: "r2" },
      { type: "session.thread_status_idle", id: "t1", stop_reason: { type: "end_turn" } },
      idle("i2", "budget_reached"),
      { type: "session.usage", id: "x" },
    ];

    expect(lastSessionStop(events)).toEqual({ eventId: "i2", reason: "budget_reached" });
  });

  it("ход после остановки снимает её", () => {
    expect(lastSessionStop([idle("i1", "budget_reached"), { type: "session.status_running", id: "r2" }])).toBeNull();
    expect(lastSessionStop([idle("i1", "budget_reached"), { type: "session.status_rescheduled", id: "s" }])).toBeNull();
  });

  it("остановка потока субагента не считается остановкой сессии", () => {
    expect(
      lastSessionStop([{ type: "session.thread_status_idle", id: "t1", stop_reason: { type: "budget_reached" } }]),
    ).toBeNull();
  });

  it("без причины остановки причина null", () => {
    expect(lastSessionStop([idle("i1")])).toEqual({ eventId: "i1", reason: null });
  });
});

describe("readSessionLimits", () => {
  it("читает предел и израсходованное, строки BIGINT тоже", () => {
    expect(
      readSessionLimits({
        _oma: { limits: { max_tokens: "2000000", max_child_turns: 20, used_tokens: 15, used_child_turns: "0" } },
      }),
    ).toEqual({ maxTokens: 2_000_000, maxChildTurns: 20, usedTokens: 15, usedChildTurns: 0 });
  });

  it("без _oma.limits или с битым полем отдаёт null", () => {
    expect(readSessionLimits({ id: "sesn_1" })).toBeNull();
    expect(readSessionLimits(null)).toBeNull();
    expect(
      readSessionLimits({ _oma: { limits: { max_tokens: 10, max_child_turns: 20, used_tokens: -1, used_child_turns: 0 } } }),
    ).toBeNull();
  });
});

describe("raisedSessionLimits", () => {
  it("удваивает оба предела", () => {
    expect(raisedSessionLimits({ maxTokens: 2_000_000, maxChildTurns: 20, usedTokens: 2_000_015, usedChildTurns: 4 })).toEqual({
      _oma: { limits: { max_tokens: 4_000_030, max_child_turns: 40 } },
    });
  });

  it("предел ниже израсходованного удваивает израсходованное: сервер примет только больше него", () => {
    // max 1, used 15: удвоенный предел 2 сервер отклонил бы 400.
    const body = raisedSessionLimits({ maxTokens: 1, maxChildTurns: 20, usedTokens: 15, usedChildTurns: 20 });
    expect(body._oma.limits).toEqual({ max_tokens: 30, max_child_turns: 40 });
    expect(body._oma.limits.max_tokens).toBeGreaterThan(15);
  });
});
