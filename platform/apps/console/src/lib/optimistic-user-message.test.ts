import { describe, expect, it } from "vitest";

import {
  OptimisticUserMessages,
  attachmentOnlyText,
  createOptimisticUserEvent,
  userMessageText,
} from "./optimistic-user-message";

describe("userMessageText", () => {
  it("склеивает текстовые блоки и пропускает остальные", () => {
    expect(
      userMessageText([
        { type: "text", text: "привет" },
        { type: "image", text: "" },
        { type: "text", text: "мир" },
      ]),
    ).toBe("привет\nмир");
  });

  it("принимает строку и пустое содержимое", () => {
    expect(userMessageText("текст")).toBe("текст");
    expect(userMessageText(undefined)).toBe("");
  });
});

describe("attachmentOnlyText", () => {
  it("называет вложения так же, как консоль подписывает отправку без текста", () => {
    expect(attachmentOnlyText(1)).toBe("Прикреплено изображение.");
    expect(attachmentOnlyText(3)).toBe("Прикреплены изображения.");
  });
});

describe("createOptimisticUserEvent", () => {
  it("строит user.message с локальным id и временем прихода", () => {
    expect(createOptimisticUserEvent("local-user-1", "привет", "2026-10-15T14:00:00.000Z")).toEqual({
      type: "user.message",
      id: "local-user-1",
      content: [{ type: "text", text: "привет" }],
      ts: "2026-10-15T14:00:00.000Z",
    });
  });
});

describe("OptimisticUserMessages", () => {
  it("выдаёт уникальные локальные id", () => {
    const messages = new OptimisticUserMessages();
    expect(messages.add("а")).not.toBe(messages.add("а"));
  });

  describe("claimForEvent: пришёл user.message сервера", () => {
    it("забирает самую раннюю неподтверждённую запись с тем же текстом", () => {
      const messages = new OptimisticUserMessages();
      const first = messages.add("повтори");
      const second = messages.add("повтори");

      expect(messages.claimForEvent("s1", "повтори")).toBe(first);
      expect(messages.claimForEvent("s2", "повтори")).toBe(second);
      expect(messages.claimForEvent("s3", "повтори")).toBeUndefined();
    });

    it("запись, принятую сервером под другим id, по тексту не забирает", () => {
      const messages = new OptimisticUserMessages();
      const local = messages.add("повтори");
      messages.accept(local, "s1");

      expect(messages.claimForEvent("s2", "повтори")).toBeUndefined();
      expect(messages.size).toBe(1);
    });

    it("запись, принятую сервером, забирает по id, даже если текст другой", () => {
      const messages = new OptimisticUserMessages();
      const local = messages.add("Прикреплено изображение.");
      messages.accept(local, "s1");

      expect(messages.claimForEvent("s1", "")).toBe(local);
      expect(messages.size).toBe(0);
    });

    it("не трогает записи с другим текстом", () => {
      const messages = new OptimisticUserMessages();
      messages.add("раз");

      expect(messages.claimForEvent("s1", "два")).toBeUndefined();
      expect(messages.size).toBe(1);
    });
  });

  describe("claimForPending: сервер взял реплику в очередь", () => {
    it("забирает запись по id события очереди", () => {
      const messages = new OptimisticUserMessages();
      const local = messages.add("раз");
      messages.accept(local, "evt-1");

      expect(messages.claimForPending("evt-1", "другой текст")).toBe(local);
    });

    it("без совпадения по id ищет по тексту и среди принятых записей", () => {
      const messages = new OptimisticUserMessages();
      const local = messages.add("раз");
      messages.accept(local, "s1");

      expect(messages.claimForPending("evt-1", "раз")).toBe(local);
      expect(messages.size).toBe(0);
    });
  });

  it("accept сообщает, есть ли ещё запись", () => {
    const messages = new OptimisticUserMessages();
    const local = messages.add("раз");

    expect(messages.accept(local, "s1")).toBe(true);
    messages.release(local);
    expect(messages.accept(local, "s1")).toBe(false);
  });

  it("release снимает запись и сообщает, была ли она", () => {
    const messages = new OptimisticUserMessages();
    const id = messages.add("раз");

    expect(messages.release(id)).toBe(true);
    expect(messages.release(id)).toBe(false);
    expect(messages.size).toBe(0);
  });

  it("clear забывает все записи", () => {
    const messages = new OptimisticUserMessages();
    messages.add("раз");
    messages.add("два");
    messages.clear();

    expect(messages.size).toBe(0);
    expect(messages.claimForEvent("s1", "раз")).toBeUndefined();
  });
});
