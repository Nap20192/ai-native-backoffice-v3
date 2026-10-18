import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { normalizePreview } from "./api";
import {
  blockFromDecision,
  blockFromPreview,
  initialCardState,
  reduceCard,
  revertAgentVersion,
  staleText,
} from "./confirm";

const preview = (over: Record<string, unknown> = {}) =>
  normalizePreview({
    tool: "update_agent",
    preview_digest: "d1",
    operations: [{ index: 0, tool: "update_agent", kind: "agent", target_id: "a1", name: "Сводка", class: "edit" }],
    ...over,
  });

describe("blockFromPreview", () => {
  it("чистое предложение не заблокировано", () => {
    expect(blockFromPreview(preview(), "update_agent")).toBeNull();
  });

  it("выключенный ассистент", () => {
    expect(blockFromPreview(preview({ disabled: true }), "update_agent")).toEqual({
      reason: "disabled",
      text: "Ассистент выключен в пространстве",
    });
  });

  it("ошибка схемы показывает текст сервера", () => {
    const b = blockFromPreview(preview({ schema_error: "поле provider не принимается" }), "update_model_card");
    expect(b).toEqual({ reason: "schema", text: "поле provider не принимается" });
  });

  it("известное значение секрета", () => {
    expect(blockFromPreview(preview({ secret: true }), "create_agent")).toEqual({
      reason: "secret",
      text: "В черновике значение секрета пространства. Секрет задаётся только в хранилище секретов",
    });
  });

  it("объект не найден", () => {
    expect(blockFromPreview(preview({ not_found: true }), "update_agent")?.text).toBe("Объект не найден");
  });

  it("send_message вне v1 говорит про первое сообщение", () => {
    const p = normalizePreview({
      operations: [{ index: 0, tool: "send_message", kind: "message", class: "out_of_v1" }],
    });
    expect(blockFromPreview(p, "send_message")).toEqual({
      reason: "class",
      text: "В первой версии ассистент отправляет только первое сообщение в сессию, которую создал сам",
    });
  });

  it("деплоймент вне v1 говорит про паузу", () => {
    const p = normalizePreview({
      operations: [{ index: 0, tool: "update_deployment", kind: "deployment", class: "out_of_v1" }],
    });
    expect(blockFromPreview(p, "update_deployment")?.text).toBe(
      "Деплоймент работает. В первой версии ассистент меняет только деплоймент на паузе",
    );
  });

  it("причина от сервера главнее общей", () => {
    const p = normalizePreview({
      operations: [
        { index: 0, tool: "update_agent", kind: "agent", class: "out_of_v1", out_of_v1_reason: "Свой агент правит человек в консоли" },
      ],
    });
    expect(blockFromPreview(p, "update_agent")?.text).toBe("Свой агент правит человек в консоли");
  });

  it("аргументы не подходят к новому состоянию", () => {
    const b = blockFromPreview(preview({ args_stale: true }), "update_agent");
    expect(b?.reason).toBe("args_stale");
  });
});

describe("blockFromDecision", () => {
  const p = preview();
  it("secret, disabled, not_found, not_pending, forbidden", () => {
    expect(blockFromDecision({ ok: false, reason: "secret", status: 409, message: "" }, p, "create_agent")?.reason).toBe("secret");
    expect(blockFromDecision({ ok: false, reason: "disabled", status: 409, message: "" }, p, "create_agent")?.text).toBe("Ассистент выключен в пространстве");
    expect(blockFromDecision({ ok: false, reason: "not_found", status: 404, message: "" }, p, "update_agent")?.text).toBe("Объект не найден");
    expect(blockFromDecision({ ok: false, reason: "not_pending", status: 409, message: "" }, p, "update_agent")?.text).toBe("Вызов уже не ждёт подтверждения");
    expect(blockFromDecision({ ok: false, reason: "forbidden", status: 403, message: "" }, p, "update_agent")?.text).toBe("Подтвердить может только тот, кто начал разговор");
  });
  it("class берёт текст по инструменту", () => {
    const b = blockFromDecision({ ok: false, reason: "class", status: 409, message: "" }, p, "send_message");
    expect(b?.text).toContain("только первое сообщение");
  });
  it("class берёт причину сервера по новому состоянию, а не текст по инструменту", () => {
    // Карточка собрана, пока деплоймент был на паузе; его отправили в архив, сервер ответил 409 class.
    const card = normalizePreview({
      tool: "update_deployment",
      preview_digest: "d1",
      operations: [{ index: 0, tool: "update_deployment", kind: "deployment", target_id: "depl_1", class: "edit" }],
    });
    const reason = "Объект в архиве. В первой версии ассистент его не меняет";
    const b = blockFromDecision(
      { ok: false, reason: "class", status: 409, message: "Конфликт", serverReason: reason },
      card,
      "update_deployment",
    );
    expect(b).toEqual({ reason: "class", text: reason });
  });
  it("409 class без причины сервера: свой текст карточки, а не общая фраза консоли", () => {
    const card = normalizePreview({
      tool: "update_deployment",
      preview_digest: "d1",
      operations: [{ index: 0, tool: "update_deployment", kind: "deployment", target_id: "depl_1", class: "edit" }],
    });
    const b = blockFromDecision(
      { ok: false, reason: "class", status: 409, message: "Конфликт", serverReason: "" },
      card,
      "update_deployment",
    );
    expect(b).toEqual({ reason: "class", text: "Деплоймент работает. В первой версии ассистент меняет только деплоймент на паузе" });
  });
  it("stale и other не блокируют", () => {
    expect(blockFromDecision({ ok: false, reason: "stale", status: 409, message: "" }, p, "update_agent")).toBeNull();
    expect(blockFromDecision({ ok: false, reason: "other", status: 500, message: "" }, p, "update_agent")).toBeNull();
  });
});

describe("staleText", () => {
  it("называет вид объекта", () => {
    expect(staleText(preview())).toBe("Агент изменился после предложения");
    expect(
      staleText(normalizePreview({ operations: [{ index: 0, tool: "update_environment", kind: "environment", class: "edit" }] })),
    ).toBe("Окружение изменилось после предложения");
  });
  it("для пачки говорит об объектах", () => {
    const p = normalizePreview({
      operations: [
        { index: 0, tool: "create_skill", kind: "skill", class: "create" },
        { index: 1, tool: "update_agent", kind: "agent", class: "edit" },
      ],
    });
    expect(staleText(p)).toBe("Объекты изменились после предложения");
  });
  it("без вида: общая фраза", () => {
    expect(staleText(null)).toBe("Объект изменился после предложения");
  });
});

describe("reduceCard", () => {
  it("загрузка → готово", () => {
    let s = initialCardState();
    expect(s.phase).toBe("loading");
    s = reduceCard(s, { type: "previewLoaded", preview: preview(), tool: "update_agent" });
    expect(s.phase).toBe("ready");
    expect(s.preview?.digest).toBe("d1");
    expect(s.block).toBeNull();
  });

  it("предложение с блокировкой остаётся готовым, но с причиной", () => {
    let s = reduceCard(initialCardState(), { type: "previewLoaded", preview: preview({ disabled: true }), tool: "update_agent" });
    expect(s.block?.reason).toBe("disabled");
  });

  it("сбой preview", () => {
    const s = reduceCard(initialCardState(), { type: "previewFailed", status: 404 });
    expect(s.phase).toBe("error");
    expect(s.block?.text).toBe("Объект не найден");
    const s2 = reduceCard(initialCardState(), { type: "previewFailed", status: 500 });
    expect(s2.block).toBeNull();
    expect(s2.notice).toBe("Не удалось получить предложение. Нажмите «Обновить»");
  });

  it("клик → отправлено → решено", () => {
    let s = reduceCard(initialCardState(), { type: "previewLoaded", preview: preview(), tool: "update_agent" });
    s = reduceCard(s, { type: "decisionStart", result: "allow" });
    expect(s.phase).toBe("confirming");
    s = reduceCard(s, { type: "decisionOk", result: "allow" });
    expect(s.phase).toBe("sent");
    let d = reduceCard(
      reduceCard(initialCardState(), { type: "previewLoaded", preview: preview(), tool: "update_agent" }),
      { type: "decisionOk", result: "deny" },
    );
    expect(d.phase).toBe("denied");
  });

  it("409 stale: новая разница и пометка", () => {
    let s = reduceCard(initialCardState(), { type: "previewLoaded", preview: preview(), tool: "update_agent" });
    s = reduceCard(s, { type: "decisionStart", result: "allow" });
    s = reduceCard(s, {
      type: "decisionFailed",
      outcome: { ok: false, reason: "stale", status: 409, message: "" },
      tool: "update_agent",
    });
    expect(s.phase).toBe("ready");
    expect(s.stale).toBe(true);
    expect(s.notice).toBe("Агент изменился после предложения");
    // новая карточка снимает пометку только после загрузки нового preview
    s = reduceCard(s, { type: "previewLoaded", preview: preview({ preview_digest: "d2" }), tool: "update_agent", keepStale: true });
    expect(s.preview?.digest).toBe("d2");
    expect(s.stale).toBe(true);
    s = reduceCard(s, { type: "previewLoaded", preview: preview({ preview_digest: "d3" }), tool: "update_agent" });
    expect(s.stale).toBe(false);
  });

  it("409 class и secret выключают кнопку", () => {
    let s = reduceCard(initialCardState(), { type: "previewLoaded", preview: preview(), tool: "send_message" });
    s = reduceCard(s, {
      type: "decisionFailed",
      outcome: { ok: false, reason: "class", status: 409, message: "" },
      tool: "send_message",
    });
    expect(s.block?.reason).toBe("class");
    expect(s.phase).toBe("ready");
  });

  it("прочий сбой: уведомление, карточка остаётся рабочей", () => {
    let s = reduceCard(initialCardState(), { type: "previewLoaded", preview: preview(), tool: "update_agent" });
    s = reduceCard(s, {
      type: "decisionFailed",
      outcome: { ok: false, reason: "other", status: 500, message: "" },
      tool: "update_agent",
    });
    expect(s.phase).toBe("ready");
    expect(s.block).toBeNull();
    expect(s.notice).toBe("Не удалось отправить решение. Повторите");
  });
});

describe("revertAgentVersion", () => {
  it("читает старую версию и пишет её поля поверх текущей", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (!init?.method) {
        return { id: "a1", name: "Сводка", description: "d", system: "старый", model: { id: "m" }, tools: [{ type: "x" }], mcp_servers: [], skills: [], version: 3 };
      }
      return { id: "a1", version: 5 };
    });
    const out = await revertAgentVersion(api, { agentId: "a1", toVersion: 3, currentVersion: 4 });
    expect(out.version).toBe(5);
    expect(calls[0].path).toBe("/v1/agents/a1?version=3");
    expect(calls[1].path).toBe("/v1/agents/a1");
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body).toMatchObject({ name: "Сводка", system: "старый", version: 4 });
    expect(body.id).toBeUndefined();
    expect(body.created_at).toBeUndefined();
  });

  it("ошибка записи уходит вызывающему", async () => {
    const api = vi.fn(async (_p: string, init?: RequestInit) => {
      if (init?.method) throw new ApiError({ status: 409, code: "", message: "конфликт" });
      return { name: "x", version: 3 };
    });
    await expect(revertAgentVersion(api, { agentId: "a", toVersion: 3, currentVersion: 4 })).rejects.toThrow();
  });
});
