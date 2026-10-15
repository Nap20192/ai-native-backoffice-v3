import type { ReactNode } from "react";

/**
 * Стандартная обёртка страницы DDC (`.page`): поле 24px, от md 32px. Слот
 * `header` стоит внутри поля, над содержимым: это `PageHeader` с заголовком,
 * описанием и действиями на фоне страницы. Так заголовок у всех страниц
 * записей стоит в одном месте, а колонка свойств начинается под ним.
 *
 * Для страниц с собственной раскладкой (чат сессии) обёртка не нужна.
 */
interface PageProps {
  children: ReactNode;
  /** Шапка страницы: `<PageHeader />`. */
  header?: ReactNode;
  className?: string;
  layout?: "single" | "rail";
  rail?: ReactNode;
}

export function Page({
  header,
  children,
  className = "",
  layout = "single",
  rail,
}: PageProps) {
  return (
    <div className="console-detail-page">
      {header}
      <div
        className={`console-detail-layout console-detail-layout--${layout} ${className}`.trim()}
        data-detail-layout={layout}
        data-testid="detail-layout"
      >
        <div className="console-detail-body" data-detail-slot="body" data-testid="detail-body">
          {children}
        </div>
        {layout === "rail" && (
          <aside className="console-detail-rail" data-detail-slot="rail" data-testid="detail-rail">
            {rail}
          </aside>
        )}
      </div>
    </div>
  );
}
