import { dump, load } from "js-yaml";
import { useEffect, useMemo, useReducer } from "react";

import { assistantToolName, normalizePreview } from "../../../lib/assistant/api";
import type { Event } from "../../../lib/events";
import { userMessageText } from "../../../lib/optimistic-user-message";
import { parseAgentConfigText, prepareCodePayload } from "../../../pages/agents/agentFormCodec";

/**
 * Состояние вкладки «Описать агента» (раздел 1.3 плана). Черновик строится из
 * последнего результата `preview_change` с `kind: agent`. Ручная правка YAML
 * живёт здесь же и уходит в контекст следующего сообщения. Агента создаёт
 * консоль обычным `POST /v1/agents`, поэтому здесь есть проверка тела запроса.
 */

export type ConfigFormat = "yaml" | "json";

export interface AgentDraft {
  toolUseId: string;
  yaml: string;
  warnings: string[];
  name: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function resultText(event: Event | undefined): string {
  if (!event) return "";
  return typeof event.content === "string" ? event.content : userMessageText(event.content);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = load(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nameOf(yaml: string): string | null {
  const name = parseObject(yaml)?.name;
  return typeof name === "string" && name ? name : null;
}

/** YAML агента из ответа сервера на `preview_change`, иначе null. */
function draftFromResult(text: string): { yaml: string; warnings: string[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const preview = normalizePreview(raw);
  if (preview.schemaError) return null;
  const op = preview.operations.find((o) => (o.kind === "agent" || o.kind === "agents") && o.afterYaml);
  if (op?.afterYaml) return { yaml: op.afterYaml, warnings: op.warnings };
  if (typeof raw.after_yaml === "string" && raw.after_yaml.trim()) {
    return { yaml: raw.after_yaml, warnings: preview.operations.flatMap((o) => o.warnings) };
  }
  return null;
}

/** Черновики агента из событий сессии, по порядку вызовов `preview_change`. */
export function extractAgentDrafts(events: readonly Event[]): AgentDraft[] {
  const results = new Map<string, Event>();
  for (const e of events) {
    if (e.type === "agent.mcp_tool_result" && typeof e.mcp_tool_use_id === "string") {
      results.set(e.mcp_tool_use_id, e);
    }
  }
  const drafts: AgentDraft[] = [];
  for (const e of events) {
    if (e.type !== "agent.mcp_tool_use" || typeof e.id !== "string") continue;
    if (assistantToolName(typeof e.name === "string" ? e.name : "") !== "preview_change") continue;
    if (!isRecord(e.input) || e.input.kind !== "agent") continue;
    const res = results.get(e.id);
    if (!res || res.is_error === true) continue;
    const found = draftFromResult(resultText(res));
    if (!found) continue;
    drafts.push({ toolUseId: e.id, yaml: found.yaml, warnings: found.warnings, name: nameOf(found.yaml) });
  }
  return drafts;
}

/* ---------- Разница между черновиками ---------- */

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Верхние ключи, которые между двумя YAML поменялись, добавились или исчезли. */
export function changedKeys(before: string, after: string): string[] {
  const a = parseObject(before);
  const b = parseObject(after);
  if (!a || !b) return [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((k) => stable(a[k]) !== stable(b[k]));
}

/* ---------- Состояние ---------- */

export interface DescribeState {
  /** Текущий конфиг агента как YAML. Единственный источник правды. */
  yaml: string | null;
  /** YAML до последнего черновика модели, для подсветки и разницы. */
  previous: string | null;
  changed: string[];
  warnings: string[];
  format: ConfigFormat;
  /** Текст JSON, который не разобрался. Пока он есть, создавать нельзя. */
  jsonDraft: string | null;
  /** Пользователь менял конфиг руками после последнего черновика модели. */
  edited: boolean;
  lastDraftId: string | null;
}

export const initialDescribeState: DescribeState = {
  yaml: null,
  previous: null,
  changed: [],
  warnings: [],
  format: "yaml",
  jsonDraft: null,
  edited: false,
  lastDraftId: null,
};

export type DescribeAction =
  | { type: "draft"; draft: AgentDraft }
  | { type: "edit"; text: string }
  | { type: "field"; key: string; value: string }
  | { type: "format"; format: ConfigFormat }
  | { type: "reset" };

const dumpYaml = (value: unknown) => dump(value, { lineWidth: -1, noRefs: true });

export function describeReducer(state: DescribeState, action: DescribeAction): DescribeState {
  switch (action.type) {
    case "draft": {
      if (action.draft.toolUseId === state.lastDraftId) return state;
      const previous = state.yaml;
      return {
        ...state,
        yaml: action.draft.yaml,
        previous,
        changed: previous === null ? [] : changedKeys(previous, action.draft.yaml),
        warnings: action.draft.warnings,
        jsonDraft: null,
        edited: false,
        lastDraftId: action.draft.toolUseId,
      };
    }
    case "edit": {
      if (state.format === "yaml") return { ...state, yaml: action.text, jsonDraft: null, edited: true };
      try {
        const parsed: unknown = JSON.parse(action.text);
        if (!isRecord(parsed)) throw new Error("not an object");
        return { ...state, yaml: dumpYaml(parsed), jsonDraft: null, edited: true };
      } catch {
        return { ...state, jsonDraft: action.text, edited: true };
      }
    }
    case "field": {
      const obj = state.yaml === null ? {} : parseObject(state.yaml);
      if (!obj) return state;
      const next = { ...obj };
      if (action.value === "") delete next[action.key];
      else next[action.key] = action.value;
      return { ...state, yaml: dumpYaml(next), jsonDraft: null, edited: true };
    }
    case "format": {
      if (action.format === state.format) return state;
      if (action.format === "json" && (state.yaml === null || !parseObject(state.yaml))) return state;
      return { ...state, format: action.format, jsonDraft: null };
    }
    case "reset":
      return initialDescribeState;
  }
}

/** Текст, который показывает панель в выбранном формате. */
export function displayText(state: DescribeState): string {
  if (state.format === "yaml") return state.yaml ?? "";
  if (state.jsonDraft !== null) return state.jsonDraft;
  const obj = state.yaml === null ? null : parseObject(state.yaml);
  return obj ? JSON.stringify(obj, null, 2) : "";
}

export type DraftValidation = { ok: true; payload: Record<string, unknown> } | { ok: false; error: string };

/** Тело `POST /v1/agents` из YAML панели или причина, почему создавать рано. */
export function validateDraft(state: DescribeState): DraftValidation {
  if (state.jsonDraft !== null) return { ok: false, error: "Некорректный JSON: исправьте текст или вернитесь к YAML" };
  if (state.yaml === null || !state.yaml.trim()) return { ok: false, error: "Черновика пока нет" };
  try {
    return { ok: true, payload: prepareCodePayload(parseAgentConfigText(state.yaml, "yaml"), { forUpdate: false }) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Конфигурацию не удалось прочитать" };
  }
}

/** Редактор состояния и подхват новых черновиков из событий сессии. */
export function useDescribeState(events: readonly Event[]) {
  const [state, dispatch] = useReducer(describeReducer, initialDescribeState);
  const drafts = useMemo(() => extractAgentDrafts(events), [events]);
  const latest = drafts[drafts.length - 1] ?? null;
  useEffect(() => {
    if (latest) dispatch({ type: "draft", draft: latest });
  }, [latest]);
  return [state, dispatch] as const;
}
