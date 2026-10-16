import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";

import { useAssistantApi } from "../../lib/assistant/api";
import { contextChipLabel, type PageContext } from "../../lib/assistant/page-context";
import { PlainButton } from "@/components/ui/plain-button";

/** Адрес запроса имени объекта страницы. Списки и прочие страницы имён не ищут. */
function nameEndpoint(ctx: PageContext): string | null {
  const id = ctx.params.id;
  if (!id) return null;
  const enc = encodeURIComponent(id);
  switch (ctx.kind) {
    case "agent":
      return `/v1/agents/${enc}`;
    case "session":
      return `/v1/sessions/${enc}`;
    case "environment":
      return `/v1/environments/${enc}`;
    case "memory_store":
      return `/v1/memory_stores/${enc}`;
    case "vault":
      return `/v1/vaults/${enc}`;
    default:
      return null;
  }
}

function useContextName(ctx: PageContext): { name: string | null; version: number | null } {
  const api = useAssistantApi();
  const endpoint = nameEndpoint(ctx);
  const [state, setState] = useState<{ key: string; name: string | null; version: number | null } | null>(null);

  useEffect(() => {
    if (!endpoint) return;
    let alive = true;
    api(endpoint, { quiet: true })
      .then((raw) => {
        if (!alive) return;
        const r = (raw ?? {}) as Record<string, unknown>;
        const name = [r.name, r.title, r.display_name].find((v): v is string => typeof v === "string" && v !== "");
        setState({ key: endpoint, name: name ?? null, version: typeof r.version === "number" ? r.version : null });
      })
      .catch(() => {
        if (alive) setState({ key: endpoint, name: null, version: null });
      });
    return () => {
      alive = false;
    };
  }, [api, endpoint]);

  return state && state.key === endpoint ? state : { name: null, version: null };
}

/** Подпись контекста с именем объекта страницы, например «Агент «Сводка PR», версия 3». */
export function useContextLabel(ctx: PageContext): string {
  return contextChipLabel(ctx, useContextName(ctx));
}

/**
 * Чип контекста над полем ввода. Крестик убирает контекст из следующих
 * сообщений. Подпись можно передать готовой, чтобы не искать имя второй раз.
 */
export function ContextChip({
  ctx,
  onRemove,
  label,
}: {
  ctx: PageContext;
  onRemove: () => void;
  label?: string;
}) {
  return label === undefined ? (
    <FetchedChip ctx={ctx} onRemove={onRemove} />
  ) : (
    <ChipView label={label} onRemove={onRemove} />
  );
}

function FetchedChip({ ctx, onRemove }: { ctx: PageContext; onRemove: () => void }) {
  return <ChipView label={useContextLabel(ctx)} onRemove={onRemove} />;
}

function ChipView({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="assistant-context-chip inline-flex max-w-full items-center gap-1 rounded-lg bg-ddc-surface-sunken py-0.5 pr-0.5 pl-2 text-xs text-ddc-text">
      <span className="min-w-0 truncate">{label}</span>
      <PlainButton
        type="button"
        aria-label="Убрать контекст"
        onClick={onRemove}
        className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ddc-text-muted after:absolute after:-inset-1 after:content-[''] hover:bg-ddc-ghost-hover"
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </PlainButton>
    </span>
  );
}
