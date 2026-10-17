// Platform instructions for an ACP client in the sandbox
// (docs/plans/environments.md, 4.4). The text is the whole session system
// prompt: the agent's prompt, platform guidance and reminders such as the
// "Environment" block. Each client gets it through the channel it reads,
// set by `instructions` in known-agents.ts. The harness prepares it for
// every process it starts, so a resumed session gets the current text.

import { resolveAcpInstructionsDelivery } from "@open-managed-agents/acp-runtime/known-agents";

export const ACP_INSTRUCTIONS_START = "<!-- openma:instructions:start -->";
export const ACP_INSTRUCTIONS_END = "<!-- openma:instructions:end -->";

/** The sandbox calls a file delivery needs. */
export interface AcpInstructionsSandbox {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<unknown>;
  exec(command: string): Promise<string>;
}

/** What run() sends with the process it is about to start. */
export interface AcpInstructionsPlan {
  /** `_meta` for session/new, session/resume and session/load. */
  sessionRequestMeta?: Record<string, unknown>;
  /** Text to put before the first prompt of the new process. */
  promptPrefix: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A section runs from a start marker to the nearest end marker, with no
// other start marker inside. A stray marker in the owner's text is kept.
const SECTION = new RegExp(
  `${escapeRegExp(ACP_INSTRUCTIONS_START)}(?:(?!${escapeRegExp(ACP_INSTRUCTIONS_START)})[\\s\\S])*?${escapeRegExp(ACP_INSTRUCTIONS_END)}\\n?`,
  "g",
);

/** The text to deliver. Marker strings inside it are dropped, so the
 *  section always ends at the platform's own end marker. */
export function acpInstructionsText(systemPrompt: string): string {
  return systemPrompt
    .replaceAll(ACP_INSTRUCTIONS_START, "")
    .replaceAll(ACP_INSTRUCTIONS_END, "")
    .trim();
}

/**
 * The file with the platform section put in place of the old one, or added
 * after the owner's text. Text outside the markers stays as it was. Extra
 * platform sections are removed. Null means the file needs no write.
 */
export function upsertAcpInstructionsSection(existing: string | null, text: string): string | null {
  const section = `${ACP_INSTRUCTIONS_START}\n${text}\n${ACP_INSTRUCTIONS_END}\n`;
  const current = existing ?? "";
  let found = false;
  const replaced = current.replace(SECTION, () => {
    if (found) return "";
    found = true;
    return section;
  });
  const next = found
    ? replaced
    : current.length === 0
      ? section
      : `${current}${current.endsWith("\n") ? "" : "\n"}\n${section}`;
  return next === existing ? null : next;
}

/** The first prompt of a new process carries the instructions in front. */
export function acpInstructionsPrefix(text: string): string {
  return `<openma-platform-instructions>\n${text}\n</openma-platform-instructions>\n\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Commands run in /workspace, so a workspace path goes relative. */
function shellPath(path: string): string {
  return path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path;
}

function joinPath(directory: string, file: string): string {
  return `${directory.replace(/\/+$/, "")}/${file}`;
}

/** The file's text, null when it does not exist, undefined when it is unknown. */
async function readExisting(sandbox: AcpInstructionsSandbox, path: string): Promise<string | null | undefined> {
  try {
    return await sandbox.readFile(path);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return null;
  }
  // Adapters report a missing file differently. Ask the sandbox, and never
  // write over a file that exists but could not be read.
  try {
    const answer = await sandbox.exec(
      `if [ -e ${shellQuote(shellPath(path))} ]; then printf present; else printf missing; fi`,
    );
    return answer.trim() === "missing" ? null : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prepare the instructions for a process that is about to start: write the
 * client's file, or return the `_meta` or the prompt prefix to send. An
 * empty system prompt sends nothing. When the file cannot be updated
 * safely, the instructions go in front of the first prompt instead.
 */
export async function prepareAcpInstructions(input: {
  sandbox: AcpInstructionsSandbox;
  agent: { id?: string; command: string };
  cwd: string;
  systemPrompt: string;
}): Promise<AcpInstructionsPlan> {
  const text = acpInstructionsText(input.systemPrompt);
  if (!text) return { promptPrefix: "" };
  const delivery = resolveAcpInstructionsDelivery(input.agent);
  if (delivery.kind === "meta") {
    return { sessionRequestMeta: { systemPrompt: { append: text } }, promptPrefix: "" };
  }
  if (delivery.kind === "file") {
    const path = joinPath(input.cwd, delivery.path);
    const existing = await readExisting(input.sandbox, path);
    if (existing !== undefined) {
      const next = upsertAcpInstructionsSection(existing, text);
      if (next !== null) await input.sandbox.writeFile(path, next);
      return { promptPrefix: "" };
    }
  }
  return { promptPrefix: acpInstructionsPrefix(text) };
}
