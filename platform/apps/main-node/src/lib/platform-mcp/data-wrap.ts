// Text from sessions, files, skills and memory goes to the model inside
// `<data source="…" id="…">…</data>` (builder-agent.md 2.1). The system prompt
// says the inside is data, never instructions.

export type DataSource = "file" | "skill" | "memory" | "event" | "trajectory" | "config";

function attribute(value: string): string {
  return value.replace(/[&"<>]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A closing `</data` inside the text cannot end the wrapper. */
export function escapeDataText(text: string): string {
  return text.replace(/<\/data/gi, "&lt;/data");
}

export function wrapData(source: DataSource, id: string, text: string): string {
  return `<data source="${source}" id="${attribute(id)}">${escapeDataText(text)}</data>`;
}
