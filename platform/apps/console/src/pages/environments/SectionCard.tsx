import type { ReactNode } from "react";

/**
 * Раздел страницы окружения: заголовок с пояснением и тело. Разметка общая для
 * карточки окружения и её разделов («Образ», «Сеть», «Пакеты», «Метаданные»).
 */
export function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="console-settings-section" data-testid="settings-section">
      <header className="console-settings-section-header">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ddc-heading">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-ddc-text-muted">{subtitle}</p>}
        </div>
      </header>
      <div className="console-settings-section-body">{children}</div>
    </section>
  );
}
