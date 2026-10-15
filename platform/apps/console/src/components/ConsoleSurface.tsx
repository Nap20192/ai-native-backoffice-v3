import type { ComponentType, ReactNode } from "react";
import { PlainButton } from "@/components/ui/plain-button";

import { cn } from "@/lib/utils";

import { Skeleton } from "./Skeleton";

interface DashboardLayoutProps {
  intro: ReactNode;
  kpis: ReactNode;
  secondary?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Сводка (плотные данные, раздел 4 DDC): заголовок, ряд KPI
 * `grid-cols-2 gap-4 lg:grid-cols-4`, необязательный ряд малых плиток и
 * сетка панелей. Ритм между блоками 24px, сетки 16px. Слоты помечены
 * `data-dashboard-slot`, их порядок держит тест.
 */
export function DashboardLayout({ intro, kpis, secondary, children, className }: DashboardLayoutProps) {
  return (
    <div className={cn("console-dashboard-layout", className)} data-testid="dashboard-layout">
      <div className="console-dashboard-intro" data-dashboard-slot="intro">
        {intro}
      </div>
      <div
        className="grid grid-cols-2 gap-4 lg:grid-cols-4"
        data-dashboard-slot="kpis"
        data-testid="dashboard-primary-kpis"
      >
        {kpis}
      </div>
      {secondary && (
        <div className="min-w-0" data-dashboard-slot="secondary">
          {secondary}
        </div>
      )}
      <div
        className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]"
        data-dashboard-slot="activity"
      >
        {children}
      </div>
    </div>
  );
}

interface ConsolePanelProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/** Панель-список в карточке: шапка `px-5 py-4` с разделителем, заголовок
 *  секции `section-title`, действие справа. */
export function ConsolePanel({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
}: ConsolePanelProps) {
  return (
    <section className={cn("card min-w-0 overflow-hidden", className)}>
      <header className="flex items-center justify-between gap-3 border-b border-ddc-divider px-5 py-4">
        <div className="min-w-0">
          <h2 className="section-title">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {action && <div className="flex-none">{action}</div>}
      </header>
      <div className={cn("min-w-0", contentClassName)}>{children}</div>
    </section>
  );
}

interface KpiCardProps {
  label: string;
  value: number | string | undefined;
  onClick: () => void;
  /** Значок раздела (lucide) в плитке 40px тона brand. */
  icon?: ComponentType<{ className?: string }>;
  /** Данные ещё грузятся: вместо значения скелетон. */
  loading?: boolean;
  /** Малая плитка в одну строку: подпись слева, значение справа. */
  compact?: boolean;
}

/** Плитка-ссылка KPI (`kpi card-link`): значок и значение 24px bold. Нет
 *  данных: приглушённый прочерк. */
export function KpiCard({ label, value, onClick, icon: Icon, loading, compact }: KpiCardProps) {
  const hasValue = value !== undefined && value !== null;
  const displayValue = hasValue ? value : "–";
  const valueNode = loading ? (
    <Skeleton className={compact ? "h-5 w-10" : "h-8 w-16"} />
  ) : (
    <span className={cn("kpi-value block", !hasValue && "text-ddc-placeholder")}>{displayValue}</span>
  );

  if (compact) {
    return (
      <PlainButton
        type="button"
        className="kpi kpi-compact card-link w-full justify-between gap-3 text-left"
        aria-label={`${label}: ${displayValue}`}
        aria-busy={loading || undefined}
        onClick={onClick}
      >
        <span className="kpi-label min-w-0 truncate" title={label}>
          {label}
        </span>
        <span className="flex-none">{valueNode}</span>
      </PlainButton>
    );
  }

  return (
    <PlainButton
      type="button"
      className="kpi card-link w-full text-left"
      aria-label={`${label}: ${displayValue}`}
      aria-busy={loading || undefined}
      onClick={onClick}
    >
      {Icon && (
        <span className="kpi-icon bg-ddc-tone-brand-bg text-ddc-tone-brand-fg" aria-hidden="true">
          <Icon />
        </span>
      )}
      <span className="mt-auto block min-w-0">
        {valueNode}
        <span className="kpi-label block truncate" title={label}>
          {label}
        </span>
      </span>
    </PlainButton>
  );
}
