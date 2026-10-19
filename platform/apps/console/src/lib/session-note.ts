/**
 * Notes of a session turn come from the server as raw English lines. A denied
 * MCP connection is the common one a person can fix, so it gets a Russian
 * explanation; the raw line stays as a detail for support.
 */
const MCP_DENIED = /^MCP setup failed for "([^"]+)" \(([^)\s]+)\):.*\bHTTP (401|403)\b/;

export interface SessionNote {
  text: string;
  detail?: string;
}

export function explainSessionNote(note: string): SessionNote {
  const match = MCP_DENIED.exec(note);
  if (!match) return { text: note };
  const [, server, url, status] = match;
  return {
    text:
      `MCP-сервер «${server}» отказал в доступе (${status}), его инструменты в этом ходе недоступны. ` +
      `Добавьте токен этого сервера в хранилище секретов для адреса ${url} и подключите хранилище к сессии.`,
    detail: note,
  };
}
