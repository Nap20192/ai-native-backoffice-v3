import { describe, expect, it } from "vitest";

import { AGENT_TEMPLATES, BUILDER_TEMPLATE } from "./templates";

describe("шаблон «Конструктор»", () => {
  it("называется «Конструктор» и несёт метку «Управляет платформой»", () => {
    expect(BUILDER_TEMPLATE.name).toBe("Конструктор");
    expect(BUILDER_TEMPLATE.badge).toBe("Управляет платформой");
    expect(BUILDER_TEMPLATE.description).toContain("подтверждает человек");
  });

  it("не входит в обычные шаблоны: заготовка формы ему не подходит", () => {
    expect(AGENT_TEMPLATES.map((t) => t.id)).not.toContain(BUILDER_TEMPLATE.id);
  });
});
