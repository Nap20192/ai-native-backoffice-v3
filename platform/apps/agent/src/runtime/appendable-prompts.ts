// Built-in registry of "appendable prompts": small, named blocks of text
// the platform exposes for agent authors to opt into. They append to the
// system prompt at session start, after `agent.system` and before memory /
// skill additions.
//
// Why this exists: text tied to one tool provider doesn't belong in the
// agent's generic `system` field (agents are reused across providers), and
// the platform shouldn't inject it on every session either, because the
// agent author may not want it. This registry is the middle ground: the
// platform ships the text, the agent config opts in by id.
//
// The registry is empty: its only entry described the Linear tools, which
// left with the Linear integration (docs/plans/cleanup.md, 5.1). Unknown ids
// resolve to nothing.
//
// To add a new entry: append to the registry below. Keep entries short and
// self-contained; they are concatenated verbatim.

export interface AppendablePrompt {
  id: string;
  name: string;
  description: string;
  content: string;
}

const REGISTRY: Record<string, AppendablePrompt> = {};

export function resolveAppendablePrompts(ids: readonly string[]): AppendablePrompt[] {
  const seen = new Set<string>();
  const out: AppendablePrompt[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    // Own keys only: ids such as "constructor" must not hit Object.prototype.
    if (Object.prototype.hasOwnProperty.call(REGISTRY, id)) out.push(REGISTRY[id]!);
  }
  return out;
}

export function listAppendablePrompts(): AppendablePrompt[] {
  return Object.values(REGISTRY);
}
