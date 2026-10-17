// Allowlist of response fields by object kind (builder-agent.md 2.6). A field
// that is not in the spec never reaches the model, a new API field neither.
// Hidden fields come only from `secret-fields.ts`.

import type { PlatformMcpLibs } from "./ports";
import { isSecretName, SECRET_FIELDS, type SecretField, type SecretFieldKind } from "./secret-fields";

export const MASK = "[скрыто]";

export type ShapeKind =
  | "agent"
  | "session"
  | "deployment"
  | "environment"
  | "skill"
  | "skill_version"
  | "file"
  | "memory_store"
  | "memory"
  | "vault"
  | "credential"
  | "deployment_run"
  | "eval_run"
  | "model_card"
  | "model"
  | "model_option"
  | "session_resource";

/** `true` keeps the value, an object keeps only its keys, `[spec]` is an array of `spec`. */
type Spec = true | { readonly [key: string]: Spec } | readonly [Spec];

const MCP_SERVER: Spec = { type: true, name: true, url: true, command: true, args: true, env: true };
const OMA_AGENT: Spec = {
  harness: true,
  aux_model: true,
  appendable_prompts: true,
  context_management: true,
  model_settings: true,
  enable_general_subagent: true,
};
const RESOURCE: Spec = {
  id: true,
  type: true,
  file_id: true,
  mount_path: true,
  url: true,
  checkout: true,
  memory_store_id: true,
  access: true,
  instructions: true,
  created_at: true,
  updated_at: true,
};

const SPECS: Readonly<Record<ShapeKind, Spec>> = {
  session_resource: { ...RESOURCE, name: true, description: true },
  agent: {
    id: true,
    type: true,
    name: true,
    description: true,
    model: true,
    system: true,
    tools: true,
    skills: true,
    multiagent: true,
    metadata: true,
    version: true,
    created_at: true,
    updated_at: true,
    archived_at: true,
    mcp_servers: [MCP_SERVER],
    _oma: OMA_AGENT,
  },
  session: {
    id: true,
    type: true,
    title: true,
    status: true,
    agent: {
      id: true,
      type: true,
      version: true,
      name: true,
      description: true,
      model: true,
      system: true,
      tools: true,
      skills: true,
      multiagent: true,
      mcp_servers: [MCP_SERVER],
      _oma: OMA_AGENT,
    },
    environment_id: true,
    budget: true,
    metadata: true,
    resources: [RESOURCE],
    vault_ids: true,
    deployment_id: true,
    stats: true,
    usage: true,
    outcome_evaluations: true,
    created_at: true,
    updated_at: true,
    archived_at: true,
  },
  deployment: {
    id: true,
    type: true,
    name: true,
    description: true,
    status: true,
    paused_reason: true,
    agent: true,
    environment_id: true,
    schedule: true,
    initial_events: true,
    resources: [RESOURCE],
    vault_ids: true,
    budget: true,
    metadata: true,
    created_at: true,
    updated_at: true,
    archived_at: true,
  },
  environment: {
    id: true,
    type: true,
    name: true,
    description: true,
    config: true,
    metadata: true,
    scope: true,
    created_at: true,
    updated_at: true,
    archived_at: true,
  },
  skill: {
    id: true,
    type: true,
    display_title: true,
    latest_version: true,
    source: true,
    created_at: true,
    updated_at: true,
  },
  skill_version: {
    id: true,
    type: true,
    skill_id: true,
    version: true,
    name: true,
    description: true,
    directory: true,
    created_at: true,
  },
  file: {
    id: true,
    type: true,
    filename: true,
    mime_type: true,
    size_bytes: true,
    downloadable: true,
    scope: true,
    created_at: true,
  },
  memory_store: {
    id: true,
    type: true,
    name: true,
    description: true,
    metadata: true,
    created_at: true,
    updated_at: true,
    archived_at: true,
  },
  memory: {
    id: true,
    type: true,
    memory_store_id: true,
    memory_version_id: true,
    path: true,
    content_sha256: true,
    content_size_bytes: true,
    created_at: true,
    updated_at: true,
  },
  vault: {
    id: true,
    type: true,
    display_name: true,
    metadata: true,
    created_at: true,
    updated_at: true,
    archived_at: true,
  },
  credential: {
    id: true,
    type: true,
    vault_id: true,
    display_name: true,
    metadata: true,
    created_at: true,
    updated_at: true,
    archived_at: true,
    auth: {
      type: true,
      mcp_server_url: true,
      secret_name: true,
      injection_location: true,
      refresh: {
        client_id: true,
        token_endpoint: true,
        scope: true,
        resource: true,
        token_endpoint_auth: { type: true },
      },
    },
  },
  deployment_run: {
    id: true,
    type: true,
    deployment_id: true,
    session_id: true,
    agent: true,
    error: true,
    trigger_context: true,
    created_at: true,
  },
  eval_run: {
    id: true,
    type: true,
    status: true,
    agent_id: true,
    environment_id: true,
    score: true,
    summary: true,
    error: true,
    created_at: true,
    updated_at: true,
    completed_at: true,
  },
  model_card: {
    id: true,
    model_id: true,
    model: true,
    provider: true,
    base_url: true,
    custom_headers: true,
    pi_config: true,
    is_default: true,
    created_at: true,
    updated_at: true,
    archived_at: true,
  },
  model: { id: true, type: true, display_name: true, created_at: true },
  model_option: { handle: true, label: true, source: true, card_id: true, is_default: true, provider: true, wire_model: true },
};

/** Kinds whose hidden fields come from `secret-fields.ts`. */
const SECRET_KIND: Partial<Record<ShapeKind, SecretFieldKind>> = {
  agent: "agent",
  session: "session",
  deployment: "deployment",
  model_card: "model_card",
  credential: "credential",
};

type Step = { type: "key"; key: string } | { type: "items" } | { type: "map"; secretOnly: boolean };

function parsePath(path: string): { steps: Step[]; url: boolean } {
  const url = path.endsWith("#url");
  const body = url ? path.slice(0, -4) : path;
  const steps: Step[] = [];
  for (const part of body.split(".")) {
    const match = /^([^[{]*)((?:\[\]|\{\*\}|\{secret\})*)$/.exec(part);
    if (!match) throw new Error(`bad secret field path ${path}`);
    if (match[1]) steps.push({ type: "key", key: match[1] });
    for (const suffix of match[2].match(/\[\]|\{\*\}|\{secret\}/g) ?? []) {
      if (suffix === "[]") steps.push({ type: "items" });
      else steps.push({ type: "map", secretOnly: suffix === "{secret}" });
    }
  }
  return { steps, url };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hide(node: unknown, steps: Step[], index: number, field: SecretField, url: boolean, libs: PlatformMcpLibs): void {
  const step = steps[index];
  const last = index === steps.length - 1;
  if (step.type === "items") {
    if (!Array.isArray(node)) return;
    for (const item of node) hide(item, steps, index + 1, field, url, libs);
    return;
  }
  if (!isRecord(node)) return;
  if (step.type === "map") {
    for (const key of Object.keys(node)) {
      if (step.secretOnly && !isSecretName(key)) continue;
      if (last) node[key] = MASK;
      else hide(node[key], steps, index + 1, field, url, libs);
    }
    return;
  }
  if (!(step.key in node)) return;
  if (!last) {
    hide(node[step.key], steps, index + 1, field, url, libs);
    return;
  }
  const value = node[step.key];
  if (url) {
    if (typeof value === "string") node[step.key] = libs.redactUrl(value).url;
    return;
  }
  delete node[step.key];
}

function pick(value: unknown, spec: Spec): unknown {
  if (spec === true || value === null || value === undefined) return value;
  if (Array.isArray(spec)) {
    return Array.isArray(value) ? value.map((item) => pick(item, (spec as readonly [Spec])[0])) : value;
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(spec as Record<string, Spec>)) {
    if (key in value && value[key] !== undefined) out[key] = pick(value[key], child);
  }
  return out;
}

/** Hidden field paths of a kind, straight from `secret-fields.ts`. */
export function hiddenPaths(kind: ShapeKind): string[] {
  const secretKind = SECRET_KIND[kind];
  return secretKind ? SECRET_FIELDS.filter((field) => field.kind === secretKind).map((field) => field.path) : [];
}

/** The object as the model may see it: hidden fields first, then the allowlist. */
export function shapeResponse(kind: ShapeKind, raw: unknown, libs: PlatformMcpLibs): unknown {
  const copy = raw === undefined ? undefined : JSON.parse(JSON.stringify(raw));
  const secretKind = SECRET_KIND[kind];
  if (secretKind) {
    for (const field of SECRET_FIELDS) {
      if (field.kind !== secretKind) continue;
      const { steps, url } = parsePath(field.path);
      hide(copy, steps, 0, field, url, libs);
    }
  }
  return pick(copy, SPECS[kind]);
}

/** Runs the scanner over every string of a value. */
export function scanValue(
  value: unknown,
  known: readonly string[],
  libs: PlatformMcpLibs,
): { value: unknown; count: number } {
  let count = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const scanned = libs.scan(node, known);
      count += scanned.count;
      return scanned.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const scannedKey = libs.scan(key, known);
        count += scannedKey.count;
        out[scannedKey.text] = walk(child);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value), count };
}

/** Allowlist, then the scanner. */
export function cleanObject(
  kind: ShapeKind,
  raw: unknown,
  known: readonly string[],
  libs: PlatformMcpLibs,
): { value: unknown; count: number } {
  return scanValue(shapeResponse(kind, raw, libs), known, libs);
}
