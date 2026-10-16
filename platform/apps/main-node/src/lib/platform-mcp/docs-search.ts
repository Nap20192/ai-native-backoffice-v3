export interface DocsSection {
  document: string;
  heading: string;
  content: string;
}

/** Builds a request-independent index from documents the caller loads at startup. */
export function buildDocsIndex(documents: readonly { name: string; content: string }[]): DocsSection[] {
  const sections: DocsSection[] = [];
  for (const document of documents) {
    const lines = document.content.split(/\r?\n/);
    let heading = "";
    let body: string[] = [];
    let fence: string | undefined;
    const flush = () => {
      const content = body.join("\n").trim();
      if (content || heading) sections.push({ document: document.name, heading, content });
      body = [];
    };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1]!;
        else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = undefined;
        body.push(line);
        continue;
      }
      if (!fence) {
        const atx = line.match(/^ {0,3}#{1,6}(?:\s+(.*?)\s*|\s*)$/);
        const setext = line.trim() && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1] ?? "");
        if (atx || setext) {
          flush();
          heading = atx ? (atx[1] ?? "").replace(/\s+#+\s*$/, "") : line.trim();
          if (setext) index++;
          continue;
        }
      }
      body.push(line);
    }
    flush();
  }
  return sections;
}

export function searchDocs(index: readonly DocsSection[], query: string, limit = 5): DocsSection[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("limit must be a nonnegative integer");
  const needle = query.trim().toLowerCase();
  if (!needle || limit === 0) return [];
  return index.filter((section) => `${section.heading}\n${section.content}`.toLowerCase().includes(needle)).slice(0, limit);
}
