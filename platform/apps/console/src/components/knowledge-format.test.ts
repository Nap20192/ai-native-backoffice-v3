import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatSkillVersion,
  plural,
} from "./knowledge-format";

describe("knowledge-format", () => {
  it("пишет дату как дд.мм.гггг", () => {
    expect(formatDate(new Date(2026, 9, 15, 12, 30))).toBe("15.10.2026");
  });

  it("пишет дату со временем как дд.мм.гггг чч:мм, без запятой", () => {
    expect(formatDateTime(new Date(2026, 9, 15, 12, 30))).toBe("15.10.2026 12:30");
  });

  it("для пустой и неверной даты ставит прочерк", () => {
    expect(formatDate(undefined)).toBe("–");
    expect(formatDate("")).toBe("–");
    expect(formatDateTime("не дата")).toBe("–");
  });

  it("пишет размер по-русски", () => {
    expect(formatBytes(512)).toBe("512 Б");
    expect(formatBytes(1536)).toBe("1,5 КБ");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2,0 МБ");
  });

  it("склоняет числительные", () => {
    const word = (n: number) => plural(n, "навык", "навыка", "навыков");
    expect([1, 2, 5, 11, 12, 21, 22, 25, 101, 111].map(word)).toEqual([
      "навык",
      "навыка",
      "навыков",
      "навыков",
      "навыков",
      "навык",
      "навыка",
      "навыков",
      "навык",
      "навыков",
    ]);
  });

  it("показывает версию навыка датой, а не 16-значным числом", () => {
    const created = new Date(2026, 9, 15, 17, 45);
    expect(formatSkillVersion(String(created.getTime() * 1000))).toBe("15.10.2026 17:45");
    expect(formatSkillVersion(String(created.getTime()))).toBe("15.10.2026 17:45");
    expect(formatSkillVersion("3")).toBe("v3");
    expect(formatSkillVersion("latest")).toBe("latest");
    expect(formatSkillVersion(undefined)).toBe("–");
  });
});
