// Search and text filters over cleaned text only (builder-agent.md 2.6, «Без
// подсказки по секрету»). The server first passes every object through the
// allowlist and the scanner, then looks for the query. A prefix of a secret
// finds nothing, because the secret is already `[скрыто]`.

import { unzipSync } from "fflate";
import { z } from "zod";
import { ROUTES } from "../route-rules";
import { cleanObject, scanValue } from "../response-shape";
import { encodeId, RouteError, type CallContext, type ToolDef, type ToolOutput } from "./common";
import type { ListKind } from "./read";
import { decodeCursor, encodeCursor, findSkillFile, fitItems, pageOf } from "./read";

/** How many newest objects of a kind the server reads for a search. */
export const SEARCH_WINDOW = 200;

export const TEXT_FILTER_ROWS: Readonly<Record<string, { filter: string; mode: "prefix" | "substring"; text(item: any): string }>> = {
  memories: { filter: "path_prefix", mode: "prefix", text: (item) => String(item?.path ?? "") },
};

/** Up to `SEARCH_WINDOW` newest raw objects of a list route. */
export async function readWindow(ctx: CallContext, path: string): Promise<any[] | null> {
  const items: any[] = [];
  let next: { param: string; value: string } | null = null;
  while (items.length < SEARCH_WINDOW) {
    const search = new URLSearchParams({ limit: "100" });
    if (next) search.set(next.param, next.value);
    const response = await ctx.api.get(`${path}?${search}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new RouteError(response);
    const page = pageOf(response.json);
    items.push(...page.items);
    if (!page.next) break;
    next = page.next;
  }
  return items.slice(0, SEARCH_WINDOW);
}

export async function filteredList(
  ctx: CallContext,
  kindName: string,
  kind: ListKind,
  filter: Record<string, unknown>,
  limit: number,
  cursorValue: string | undefined,
): Promise<ToolOutput> {
  const row = TEXT_FILTER_ROWS[kindName];
  const needle = String(filter[row.filter]);
  const cursor = decodeCursor(cursorValue);
  if (cursor === null) return { text: "Курсор не разбирается. Начни список без cursor", isError: true, prescanned: true };
  const raw = await readWindow(ctx, kind.path(filter));
  if (raw === null) return { text: "Объект-родитель не найден", isError: true, prescanned: true };
  const cleaned = raw.map((item) => cleanObject(kind.shape, item, ctx.known, ctx.libs).value);
  const lower = needle.toLowerCase();
  const matched = cleaned.filter((item) => {
    const text = row.text(item);
    return row.mode === "prefix" ? text.startsWith(needle) : text.toLowerCase().includes(lower);
  });
  const slice = matched.slice(cursor.s, cursor.s + limit);
  const count = fitItems(slice);
  const nextOffset = cursor.s + count;
  const more = nextOffset < matched.length;
  return {
    text: JSON.stringify({
      kind: kindName,
      data: slice.slice(0, count),
      truncated: more,
      ...(more
        ? { next_call: { tool: "list", arguments: { kind: kindName, filter, limit, cursor: encodeCursor({ s: nextOffset }) } } }
        : {}),
    }),
    // Matching ran on cleaned text; the echoed filter stays as the model sent it.
    prescanned: true,
  };
}

const SEARCH_KINDS = ["agents", "skills", "memories", "environments"] as const;
const MASK = "[скрыто]";
type SearchKind = (typeof SEARCH_KINDS)[number];

interface Candidate {
  kind: SearchKind;
  id: string;
  name: string;
  text: string;
}

async function candidates(ctx: CallContext, kind: SearchKind): Promise<Candidate[]> {
  const scan = (text: string) => ctx.libs.scan(text, ctx.known).text;
  if (kind === "agents") {
    const items = (await readWindow(ctx, "/v1/agents")) ?? [];
    return items.map((raw) => {
      const agent = cleanObject("agent", raw, ctx.known, ctx.libs).value as any;
      return { kind, id: agent.id, name: agent.name ?? "", text: [agent.name, agent.description, agent.system].filter(Boolean).join("\n") };
    });
  }
  if (kind === "environments") {
    const items = (await readWindow(ctx, "/v1/environments")) ?? [];
    return items.map((raw) => {
      const env = cleanObject("environment", raw, ctx.known, ctx.libs).value as any;
      return {
        kind,
        id: env.id,
        name: env.name ?? "",
        text: [env.name, env.description, env.config?.packages ? JSON.stringify(env.config.packages) : ""].filter(Boolean).join("\n"),
      };
    });
  }
  if (kind === "skills") {
    const items = (await readWindow(ctx, "/v1/skills")) ?? [];
    const out: Candidate[] = [];
    for (const raw of items) {
      const skill = cleanObject("skill", raw, ctx.known, ctx.libs).value as any;
      let body = "";
      if (raw?.latest_version) {
        const content = await ctx.api.get(`/v1/skills/${encodeId(raw.id)}/versions/${encodeId(String(raw.latest_version))}/content`);
        if (content.ok) {
          try {
            const file = findSkillFile(unzipSync(content.bytes), "SKILL.md");
            if (file) body = new TextDecoder().decode(file);
          } catch {
            body = "";
          }
        }
      }
      out.push({ kind, id: skill.id, name: skill.display_title ?? "", text: [skill.display_title, scan(body)].filter(Boolean).join("\n") });
    }
    return out;
  }
  const stores = (await readWindow(ctx, "/v1/memory_stores")) ?? [];
  const out: Candidate[] = [];
  for (const store of stores) {
    const memories = (await readWindow(ctx, `/v1/memory_stores/${encodeId(store.id)}/memories`)) ?? [];
    for (const raw of memories) {
      const memory = cleanObject("memory", raw, ctx.known, ctx.libs).value as any;
      out.push({ kind, id: memory.id, name: memory.path ?? "", text: memory.path ?? "" });
    }
  }
  return out;
}

function matchLine(text: string, lower: string): string | null {
  for (const line of text.split("\n")) {
    const at = line.toLowerCase().indexOf(lower);
    if (at >= 0) return line.slice(Math.max(0, at - 80), at + lower.length + 80);
  }
  return null;
}

const searchConfigArgs = z
  .object({
    query: z.string().min(1).max(200),
    kinds: z.array(z.enum(SEARCH_KINDS)).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const searchConfigTool: ToolDef<z.infer<typeof searchConfigArgs>> = {
  name: "search_config",
  group: "read",
  description: "Поиск подстроки по агентам, навыкам, путям памяти и окружениям. Ищет по очищенному тексту.",
  args: searchConfigArgs,
  routes: [ROUTES.agents, ROUTES.environments, ROUTES.skills, ROUTES.skillContent, ROUTES.memoryStores, ROUTES.memories],
  precondition: null,
  async run(ctx, args) {
    const lower = args.query.toLowerCase();
    const found: { kind: string; id: string; name: string; line: string }[] = [];
    for (const kind of args.kinds ?? SEARCH_KINDS) {
      for (const candidate of await candidates(ctx, kind)) {
        const line = matchLine(candidate.text, lower);
        if (line !== null) found.push({ kind: candidate.kind, id: candidate.id, name: candidate.name, line });
      }
    }
    const limit = args.limit ?? 20;
    const slice = found.slice(0, limit);
    const count = fitItems(slice);
    const shown = slice.slice(0, count);
    // Lines come from cleaned text: every [скрыто] in them is a value the scanner hid.
    const maskedCount = shown.reduce((sum, item) => sum + item.line.split(MASK).length - 1, 0);
    return { text: JSON.stringify({ query: args.query, results: shown, truncated: found.length > count }), maskedCount, prescanned: true };
  },
};

const searchDocsArgs = z
  .object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() })
  .strict();

export const searchDocsTool: ToolDef<z.infer<typeof searchDocsArgs>> = {
  name: "search_docs",
  group: "read",
  description: "Поиск по документации ассистента. Ответ это разделы с заголовком и именем документа.",
  args: searchDocsArgs,
  routes: [],
  precondition: null,
  async run(ctx, args) {
    const results = ctx.libs.searchDocs(args.query, args.limit ?? 5);
    const count = fitItems(results);
    const scanned = scanValue(results.slice(0, count), ctx.known, ctx.libs).value;
    return { text: JSON.stringify({ query: args.query, results: scanned, truncated: count < results.length }), prescanned: true };
  },
};
