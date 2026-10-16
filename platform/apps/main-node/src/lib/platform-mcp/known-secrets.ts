// Known secrets of a workspace (builder-agent.md 2.6). The set is the values
// of every field labelled `secret` in `secret-fields.ts`. It is built anew
// for every `tools/call` and `preview` answer: there is no cache, so a value
// written a moment ago (key rotation, vault edit, background OAuth refresh)
// is masked in the very next answer. Values stay in process memory and never
// reach the log, the answer or the console.
//
// The sources read the stores directly, archived objects included, and hand
// back objects in the API shape that `secret-fields.ts` paths describe.

import type { KnownSecrets } from "./ports";
import { SECRET_FIELDS, isSecretName, type SecretFieldKind } from "./secret-fields";
import { redactUrl } from "./url-redact";

export interface KnownSecretSources {
  /** Every version of every agent, archived agents too. */
  agentVersions(workspaceId: string): Promise<Iterable<unknown>>;
  /** Every session with its agent config and resources, archived ones too. */
  sessions(workspaceId: string): Promise<Iterable<unknown>>;
  /** Every deployment, archived ones too. */
  deployments(workspaceId: string): Promise<Iterable<unknown>>;
  /** Every credential of every vault, with `auth` decrypted in memory. */
  credentials(workspaceId: string): Promise<Iterable<unknown>>;
  /** Every model card with its decrypted `api_key` and `custom_headers`. */
  modelCards(workspaceId: string): Promise<Iterable<unknown>>;
  tunnels(workspaceId: string): Promise<Iterable<unknown>>;
}

/** Which source holds the objects of each kind of `secret-fields.ts`. */
export const KNOWN_SECRET_SOURCE_OF: Readonly<Record<SecretFieldKind, keyof KnownSecretSources>> = {
  agent: "agentVersions",
  session: "sessions",
  deployment: "deployments",
  credential: "credentials",
  model_card: "modelCards",
  tunnel: "tunnels",
};

type Step = { type: "key"; key: string } | { type: "items" } | { type: "map"; secretOnly: boolean };

interface ParsedPath {
  steps: Step[];
  url: boolean;
}

function parsePath(path: string): ParsedPath {
  const url = path.endsWith("#url");
  const body = url ? path.slice(0, -"#url".length) : path;
  const steps: Step[] = [];
  for (const part of body.split(".")) {
    const match = /^([^[{]*)((?:\[\]|\{\*\}|\{secret\})*)$/.exec(part);
    if (!match) throw new Error(`Bad secret field path: ${path}`);
    if (match[1]) steps.push({ type: "key", key: match[1] });
    for (const suffix of match[2]?.match(/\[\]|\{\*\}|\{secret\}/g) ?? []) {
      steps.push(suffix === "[]" ? { type: "items" } : { type: "map", secretOnly: suffix === "{secret}" });
    }
  }
  return { steps, url };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(values: unknown[], step: Step): unknown[] {
  const next: unknown[] = [];
  for (const value of values) {
    if (step.type === "key") {
      if (isRecord(value) && step.key in value) next.push(value[step.key]);
    } else if (step.type === "items") {
      if (Array.isArray(value)) next.push(...value);
    } else if (isRecord(value)) {
      for (const [name, item] of Object.entries(value)) if (!step.secretOnly || isSecretName(name)) next.push(item);
    }
  }
  return next;
}

const SECRET_PATHS: readonly { kind: SecretFieldKind; parsed: ParsedPath }[] = SECRET_FIELDS.filter(
  (field) => field.label === "secret",
).map((field) => ({ kind: field.kind, parsed: parsePath(field.path) }));

/** Values of every `secret` field of one object of a kind. */
export function secretValuesOf(kind: SecretFieldKind, object: unknown): string[] {
  const found: string[] = [];
  for (const { parsed } of SECRET_PATHS.filter((entry) => entry.kind === kind)) {
    let values: unknown[] = [object];
    for (const step of parsed.steps) values = walk(values, step);
    for (const value of values) {
      if (typeof value !== "string" || value === "") continue;
      if (parsed.url) found.push(...redactUrl(value).secrets);
      else found.push(value);
    }
  }
  return found;
}

export function createKnownSecrets(sources: KnownSecretSources): KnownSecrets {
  return {
    async collect(workspaceId) {
      const kinds = Object.keys(KNOWN_SECRET_SOURCE_OF) as SecretFieldKind[];
      const batches = await Promise.all(
        kinds.map(async (kind) => ({ kind, objects: await sources[KNOWN_SECRET_SOURCE_OF[kind]](workspaceId) })),
      );
      const set = new Set<string>();
      for (const { kind, objects } of batches) {
        for (const object of objects) for (const value of secretValuesOf(kind, object)) if (value !== "") set.add(value);
      }
      return [...set];
    },
  };
}
