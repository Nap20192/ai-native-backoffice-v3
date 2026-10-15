const ANSI_SEQUENCE = new RegExp("\\u001b\\[[0-?]*[ -/]*[@-~]", "g");

/** Текст из массива content-блоков, если все блоки текстовые. */
function contentBlocksText(output: unknown): string | null {
  if (!Array.isArray(output) || output.length === 0) return null;
  const parts: string[] = [];
  for (const block of output) {
    if (!block || typeof block !== "object") return null;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type !== "text" || typeof text !== "string") return null;
    parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Вывод инструмента для показа в карточке. Результат bash приходит массивом
 * content-блоков, и людям нужен его текст с переносами строк, а не JSON.
 * Цветовые последовательности ANSI из вывода рантайма убираем: в карточке они
 * видны мусором. Прочие структуры показываем отформатированным JSON.
 */
export function formatToolOutput(output: unknown): string {
  const text = typeof output === "string" ? output : contentBlocksText(output);
  if (text !== null) return text.replace(ANSI_SEQUENCE, "");
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}
