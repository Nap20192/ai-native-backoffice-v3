import type { ComponentType, ReactNode } from "react";
import { InboxIcon, Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { NAV_ICONS } from "./nav-icons";

/**
 * Пустое состояние DDC (раздел 3 docs/ddc-design-system.md).
 *
 * Карточка по центру: плитка 56px `rounded-2xl` тона brand с иконкой 24px,
 * заголовок `text-base font-semibold`, описание `text-sm` приглушённым
 * цветом до 24rem, действия `gap-2`. Показывают его только после первой
 * загрузки, пока данные грузятся, нужен скелетон. Флаг `loading` оставлен
 * для совместимости: он рисует спиннер в плитке вместо иконки.
 *
 * Размеры:
 *   - sm  → компактно, внутри панелей и строк таблицы
 *   - md  → по умолчанию, уровень раздела
 *   - lg  → страница целиком
 */
const SIZE: Record<
  "sm" | "md" | "lg",
  { wrap: string; plate: string; icon: string; gap: string; title: string; body: string }
> = {
  sm: {
    wrap: "px-4 py-8",
    plate: "size-10 rounded-xl",
    icon: "size-5",
    gap: "mb-3",
    title: "text-sm",
    body: "text-xs",
  },
  md: {
    wrap: "px-6 py-12",
    plate: "size-14 rounded-2xl",
    icon: "size-6",
    gap: "mb-4",
    title: "text-base",
    body: "text-sm",
  },
  lg: {
    wrap: "px-8 py-16",
    plate: "size-14 rounded-2xl",
    icon: "size-6",
    gap: "mb-4",
    title: "text-base",
    body: "text-sm",
  },
};

/** Тона плитки (lib/tone.ts портала): по умолчанию brand. */
export type EmptyStateTone = "brand" | "neutral" | "info" | "success" | "warning" | "danger";

const TONE_PLATE: Record<EmptyStateTone, string> = {
  brand: "bg-ddc-tone-brand-bg text-ddc-tone-brand-fg",
  neutral: "bg-ddc-tone-neutral-bg text-ddc-tone-neutral-fg",
  info: "bg-ddc-tone-info-bg text-ddc-tone-info-fg",
  success: "bg-ddc-tone-success-bg text-ddc-tone-success-fg",
  warning: "bg-ddc-tone-warning-bg text-ddc-tone-warning-fg",
  danger: "bg-ddc-tone-danger-bg text-ddc-tone-danger-fg",
};

/** Раздел, чей значок стоит в плитке. Значки те же, что в боковом меню
 *  (`NAV_ICONS`, только lucide-react, правило 2 DDC): раздел выглядит одинаково
 *  в меню и в пустом состоянии. Всё, чего нет в списке, получает значок
 *  «входящие». */
export type EmptyStateKind =
  | "agent"
  | "session"
  | "deployment"
  | "file"
  | "vault"
  | "env"
  | "eval"
  | "skill"
  | "memory"
  | "model_card"
  | "api_key";

const KIND_ICONS: Record<EmptyStateKind, ComponentType<{ className?: string }>> = {
  agent: NAV_ICONS.agents,
  session: NAV_ICONS.sessions,
  deployment: NAV_ICONS.deployments,
  file: NAV_ICONS.files,
  vault: NAV_ICONS.vaults,
  env: NAV_ICONS.environments,
  eval: NAV_ICONS.evals,
  skill: NAV_ICONS.skills,
  memory: NAV_ICONS.memory,
  model_card: NAV_ICONS.modelCards,
  api_key: NAV_ICONS.apiKeys,
};

interface EmptyStateProps {
  title: string;
  /** Body text below the title. Optional. */
  body?: ReactNode;
  /** Action slot (Button, Link, or button-styled anchor). */
  action?: ReactNode;
  size?: keyof typeof SIZE;
  /** Спиннер в плитке вместо иконки. */
  loading?: boolean;
  /** Значок раздела внутри плитки. Без него и без `icon` стоит значок «входящие». */
  kind?: EmptyStateKind;
  /** Свой значок (lucide, 24px). Сильнее `kind`, если заданы оба. */
  icon?: ReactNode;
  /** Тон плитки. По умолчанию brand. */
  tone?: EmptyStateTone;
  className?: string;
}

export function EmptyState({
  title,
  body,
  action,
  size = "md",
  loading,
  kind,
  icon,
  tone = "brand",
  className = "",
}: EmptyStateProps) {
  const s = SIZE[size];
  const KindIcon = kind ? KIND_ICONS[kind] : null;
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-ddc-border bg-ddc-surface text-center shadow-card",
        s.wrap,
        className,
      )}
    >
      <div
        className={cn(
          "inline-flex items-center justify-center",
          s.plate,
          s.gap,
          TONE_PLATE[tone],
        )}
      >
        {loading ? (
          <Loader2Icon role="status" aria-label={title} className={cn("animate-spin", s.icon)} />
        ) : icon ? (
          <span aria-hidden="true" className={cn("inline-flex", s.icon)}>
            {icon}
          </span>
        ) : KindIcon ? (
          <KindIcon className={s.icon} />
        ) : (
          <InboxIcon aria-hidden="true" className={s.icon} />
        )}
      </div>
      <p className={cn("font-semibold text-balance text-ddc-heading", s.title)}>{title}</p>
      {body && (
        <div className={cn("mt-1 max-w-sm text-balance text-ddc-text-muted", s.body)}>
          {body}
        </div>
      )}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
