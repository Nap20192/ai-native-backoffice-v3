import { ChevronDownIcon, DownloadIcon, RotateCcwIcon } from "lucide-react";
import { forwardRef, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * Кнопка-фильтр: подпись приглушённым цветом, значение основным, шеврон
 * справа. Высота 32 px. Ею пользуются все фильтры панели, а само меню каждый
 * фильтр рисует сам.
 */
export const FilterButton = forwardRef<
  HTMLButtonElement,
  { label: string; value?: string; className?: string } & Omit<ComponentProps<"button">, "children">
>(function FilterButton({ label, value, className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="xs"
      aria-label={value ? `${label}: ${value}` : label}
      className={cn("max-w-full min-w-0 gap-1.5", className)}
      {...props}
    >
      <span className="shrink-0 text-ddc-text-muted">{value ? `${label}:` : label}</span>
      {value && <span className="min-w-0 truncate font-medium text-ddc-text">{value}</span>}
      <ChevronDownIcon className="size-3.5 text-ddc-icon-muted" aria-hidden="true" />
    </Button>
  );
});

/** Тонкий вертикальный разделитель между фильтрами и группировкой. */
export function FilterDivider() {
  return <span role="separator" aria-orientation="vertical" className="hidden h-6 w-px bg-ddc-divider sm:block" />;
}

/**
 * Панель фильтров: ряды кнопок по 32 px с переносом на узком экране. После
 * последнего фильтра «Сбросить», когда что-то отличается от умолчаний.
 * Справа выгрузка в CSV, если она есть, и свободный слот для подписи. У
 * «Кэширования» и «Лимитов» панель липкая.
 */
export function FilterBar({
  children,
  showReset,
  onReset,
  onExport,
  exporting = false,
  sticky = false,
  trailing,
}: {
  children: ReactNode;
  showReset: boolean;
  onReset: () => void;
  onExport?: () => void;
  exporting?: boolean;
  sticky?: boolean;
  trailing?: ReactNode;
}) {
  // Фон и линия появляются, когда панель прилипла: на самом верху страницы
  // плоский цвет выделялся бы на фоне оболочки с её пятнами. Метка стоит над
  // верхним краем панели и уходит из видимой области, когда панель прилипает.
  // Зазор в 1 px нужен: касание края наблюдатель считает пересечением.
  const markerRef = useRef<HTMLSpanElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const marker = markerRef.current;
    if (!sticky || !marker || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), {
      threshold: 0,
    });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [sticky]);

  return (
    <div
      className={cn(
        "min-w-0",
        sticky && "sticky top-0 z-20 -mt-3 py-3",
        sticky && stuck && "border-b border-ddc-divider bg-ddc-shell",
      )}
    >
      {sticky && <span ref={markerRef} aria-hidden="true" className="absolute inset-x-0 -top-[2px] h-px" />}
      <div
        role="group"
        aria-label="Фильтры"
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2"
      >
        {children}
        {showReset && (
          <Button type="button" variant="ghost" size="xs" onClick={onReset}>
            <RotateCcwIcon aria-hidden="true" />
            Сбросить
          </Button>
        )}
        {(onExport || trailing) && (
          <div className="ml-auto flex min-w-0 items-center gap-3">
            {trailing}
            {onExport && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Скачать CSV"
                title="Скачать CSV"
                disabled={exporting}
                aria-busy={exporting || undefined}
                onClick={onExport}
              >
                {exporting ? <Spinner className="size-4" aria-label="Готовим файл" /> : <DownloadIcon />}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
