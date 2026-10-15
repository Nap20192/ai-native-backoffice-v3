import { describe, expect, it } from "vitest";

import { formatDate, formatDateTime } from "./date-format";
import { formatDate as formatKnowledgeDate, formatDateTime as formatKnowledgeDateTime } from "../components/knowledge-format";
import { formatDateTimeRu } from "../components/session/format-ru";
import { formatDateTime as formatAgentDateTime } from "../pages/agents/format";
import { formatDateTime as formatPageDateTime } from "../pages/ru-format";

describe("one date format for the whole console", () => {
  const moment = new Date(2026, 9, 15, 17, 45);

  it("writes dd.MM.yyyy and dd.MM.yyyy HH:mm without a comma", () => {
    expect(formatDate(moment)).toBe("15.10.2026");
    expect(formatDateTime(moment)).toBe("15.10.2026 17:45");
  });

  it("is the same string in every section module", () => {
    const expected = "15.10.2026 17:45";
    expect(formatKnowledgeDateTime(moment)).toBe(expected);
    expect(formatDateTimeRu(moment)).toBe(expected);
    expect(formatAgentDateTime(moment)).toBe(expected);
    expect(formatPageDateTime(moment)).toBe(expected);
    expect(formatKnowledgeDate(moment)).toBe("15.10.2026");
  });

  it("uses the caller's placeholder for empty or broken values", () => {
    expect(formatDate(null, "-")).toBe("-");
    expect(formatDateTime("not a date")).toBe("–");
  });
});
