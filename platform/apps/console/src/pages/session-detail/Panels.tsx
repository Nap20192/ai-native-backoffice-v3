import { useCallback, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRightIcon } from "lucide-react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { AgentIcon, EnvIcon, VaultIcon } from "../../components/icons";
import { formatRelativeRu } from "../../components/session/format-ru";
import { shortenId } from "../../lib/format";
import { useManagedApi } from "../../lib/useManagedApi";

/**
 * Чипы агента, окружения и хранилища для шапки и вкладки «Сессия». Чип
 * ведёт на страницу ресурса, при наведении или фокусе открывает карточку с
 * кратким описанием. Боковых панелей с JSON ресурса больше нет.
 */

const CHIP_CLASS =
  "inline-flex h-5 max-w-xs min-w-0 items-center gap-1 rounded-md px-2 text-xs leading-4 text-ddc-tone-ghost-fg ring-1 ring-inset ring-ddc-tone-ghost-ring hover:bg-ddc-surface-muted hover:text-ddc-text";

const CARD_CLASS = "w-64 space-y-2 p-3 text-xs";

const EFFORT_LABEL: Record<string, string> = {
  low: "Низкое усилие",
  medium: "Среднее усилие",
  high: "Высокое усилие",
  xhigh: "Очень высокое усилие",
  max: "Максимальное усилие",
};

const SCOPE_LABEL: Record<string, string> = {
  organization: "Организация",
  account: "Личная",
};

const ENVIRONMENT_TYPE_LABEL: Record<string, string> = {
  cloud: "Облако",
  self_hosted: "Свой сервер",
};

function relativeAge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  return Number.isFinite(at) ? formatRelativeRu(Date.now() - at) : null;
}

function CardHeader({ kind, id, to }: { kind: string; id: string; to: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="eyebrow">{kind}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ddc-text-muted" title={id}>
        {shortenId(id)}
      </span>
      <Link to={to} className="link inline-flex flex-none items-center gap-1 text-xs">
        Открыть
        <ArrowRightIcon className="size-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

function CardRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ddc-text-muted">{label}</span>
      <span className="min-w-0 truncate text-ddc-text">{children}</span>
    </div>
  );
}

// ── Агент ────────────────────────────────────────────────────────────────

export interface AgentCardInfo {
  id: string;
  name: string;
  version?: number | null;
  description?: string | null;
  model?: { id: string; effort?: { type: string } | string | null } | string | null;
}

function modelParts(model: AgentCardInfo["model"]): { id: string | null; effort: string | null } {
  if (!model) return { id: null, effort: null };
  if (typeof model === "string") return { id: model, effort: null };
  const raw = typeof model.effort === "string" ? model.effort : model.effort?.type;
  return { id: model.id, effort: raw ? (EFFORT_LABEL[raw] ?? raw) : null };
}

export function AgentChip({ agent }: { agent: AgentCardInfo }) {
  const managedApi = useManagedApi();
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  // Дата создания лежит только у самого агента, снимок в сессии её не несёт.
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open || requested) return;
      setRequested(true);
      managedApi.agents
        .retrieve(agent.id)
        .then((full) => setCreatedAt(full.created_at ?? null))
        .catch(() => {});
    },
    [agent.id, managedApi, requested],
  );

  const to = `/agents/${agent.id}`;
  const { id: modelId, effort } = modelParts(agent.model);
  const age = relativeAge(createdAt);

  return (
    <HoverCard openDelay={200} closeDelay={100} onOpenChange={onOpenChange}>
      <HoverCardTrigger asChild>
        <Link to={to} className={CHIP_CLASS}>
          <AgentIcon className="size-3.5 flex-none text-ddc-icon-muted" />
          <span className="truncate">{agent.name || shortenId(agent.id)}</span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="start" className={CARD_CLASS}>
        <CardHeader kind="Агент" id={agent.id} to={to} />
        <div className="flex items-center gap-2">
          <AgentIcon className="size-4 flex-none text-ddc-icon-muted" />
          <span className="min-w-0 truncate text-sm font-medium text-ddc-heading">{agent.name}</span>
          {agent.version != null && (
            <span className="inline-flex h-5 flex-none items-center rounded-md bg-ddc-tone-neutral-bg px-1.5 text-2xs font-medium text-ddc-tone-neutral-fg">
              v{agent.version}
            </span>
          )}
        </div>
        {agent.description && (
          <p className="line-clamp-2 text-ddc-text-muted">{agent.description}</p>
        )}
        {(modelId || effort) && (
          <div className="flex items-center gap-2">
            {modelId && <span className="min-w-0 truncate font-mono text-ddc-text">{modelId}</span>}
            {effort && <span className="flex-none text-ddc-text-muted">{effort}</span>}
          </div>
        )}
        {age && <p className="text-ddc-text-muted">Создан {age}</p>}
      </HoverCardContent>
    </HoverCard>
  );
}

// ── Окружение ────────────────────────────────────────────────────────────

export interface EnvironmentCardInfo {
  name?: string;
  scope?: string | null;
  config?: { type?: string } | null;
  created_at?: string | null;
}

export function EnvironmentChip({
  id,
  environment,
}: {
  id: string;
  environment: EnvironmentCardInfo | null;
}) {
  const to = `/environments/${id}`;
  const label = environment?.name || shortenId(id);
  const type = environment?.config?.type;
  const scope = environment?.scope;
  const age = relativeAge(environment?.created_at);

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Link to={to} className={CHIP_CLASS}>
          <EnvIcon className="size-3.5 flex-none text-ddc-icon-muted" />
          <span className="truncate">{label}</span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="start" className={CARD_CLASS}>
        <CardHeader kind="Окружение" id={id} to={to} />
        <div className="flex items-center gap-2">
          <EnvIcon className="size-4 flex-none text-ddc-icon-muted" />
          <span className="min-w-0 truncate text-sm font-medium text-ddc-heading">{label}</span>
        </div>
        {type && <CardRow label="Тип">{ENVIRONMENT_TYPE_LABEL[type] ?? type}</CardRow>}
        {scope && (
          <CardRow label="Область">
            <span className="inline-flex h-5 items-center rounded-md bg-ddc-tone-neutral-bg px-1.5 text-2xs font-medium text-ddc-tone-neutral-fg">
              {SCOPE_LABEL[scope] ?? scope}
            </span>
          </CardRow>
        )}
        {age && <CardRow label="Создано">{age}</CardRow>}
      </HoverCardContent>
    </HoverCard>
  );
}

// ── Хранилище секретов ───────────────────────────────────────────────────

export function VaultChip({
  vault,
  className,
}: {
  vault: { id: string; name?: string };
  className?: string;
}) {
  return (
    <Link to={`/vaults/${vault.id}`} className={cn(CHIP_CLASS, className)} title={vault.name ?? vault.id}>
      <VaultIcon className="size-3.5 flex-none text-ddc-icon-muted" />
      <span className="truncate">{vault.name || shortenId(vault.id)}</span>
    </Link>
  );
}
