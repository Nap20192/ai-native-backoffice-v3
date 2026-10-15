import { type JSX, type ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// Tailwind JIT safelist hint — these literal `!max-w-*` strings exist
// here so the bundler picks them up; the Modal component picks one of
// them at runtime via `${"!"}${maxWidth}`. shadcn's <DialogContent>
// bakes `sm:max-w-sm` (24rem) into its base className which would
// otherwise cap every modal at 384 px on desktop; the `!` prefix lifts
// our chosen width over it. Add new entries here if a caller starts
// passing a wider value.
//
// !max-w-sm !max-w-md !max-w-lg !max-w-xl !max-w-2xl !max-w-3xl !max-w-4xl !max-w-5xl

/**
 * Окно DDC (правило 11): любое окно только через Modal. Карточка rounded-2xl
 * по центру экрана под затемнением, шапка `px-6 pt-5 pb-4` с разделителем,
 * тело `px-6 py-5` с собственной прокруткой, подвал `px-6 py-4` на
 * подложке ink-50 с разделителем: «Отмена» (`ghost`) и действие справа,
 * обе 40px. Размеры: sm max-w-sm, md max-w-md, lg max-w-lg (по умолчанию),
 * xl max-w-2xl, 2xl max-w-5xl.
 *
 * Built on shadcn `Dialog` primitives: focus trap, Escape, возврат фокуса и
 * кнопка «Закрыть» (lucide X) приходят из DialogContent. Footer рендерится
 * только если передан, чтобы пустое окно не получило полосу снизу. Тело
 * прокручивается, шапка и подвал остаются на экране.
 */
interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  /** Tailwind max-width class WITHOUT the `!` prefix (e.g. `max-w-lg`,
   *  `max-w-2xl`). Modal applies `!important` internally to beat
   *  shadcn's baked-in `sm:max-w-sm` cap. Default: `max-w-lg`. */
  maxWidth?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Пока идёт действие, окно нельзя закрыть ни крестиком, ни Escape, ни
   *  кликом по затемнению (`closeDisabled` из Modal портала). */
  closeDisabled?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  maxWidth = "max-w-lg",
  children,
  footer,
  closeDisabled = false,
}: ModalProps): JSX.Element {
  // Strip a stray `!` prefix from caller for back-compat, then apply
  // our own — guarantees exactly one `!` is present in the final class.
  const widthClass = `!${maxWidth.replace(/^!/, "")}`;
  // Окно подтверждения без тела: между шапкой и подвалом нет содержимого, и
  // два разделителя подряд давали бы двойную линию.
  const hasBody = children !== null && children !== undefined && children !== false;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !closeDisabled) onClose();
      }}
    >
      <DialogContent
        showCloseButton={!closeDisabled}
        // Без подзаголовка явный aria-describedby={undefined} гасит
        // предупреждение Radix об отсутствующем описании. С подзаголовком
        // свойство не передаём вовсе: иначе undefined перебьёт связь с
        // DialogDescription, и диктор не прочитает описание окна.
        {...(subtitle ? {} : { "aria-describedby": undefined })}
        className={cn("console-modal flex flex-col gap-0 p-0", widthClass)}
      >
        <DialogHeader
          className={cn(
            "gap-1 px-6 pt-5 pr-14 pb-4",
            hasBody && "border-b border-ddc-divider",
          )}
        >
          <DialogTitle
            className="truncate text-lg leading-7 font-semibold text-ddc-heading"
            title={typeof title === "string" ? title : undefined}
          >
            {title}
          </DialogTitle>
          {subtitle && (
            <DialogDescription className="text-sm text-ddc-text-muted">
              {subtitle}
            </DialogDescription>
          )}
        </DialogHeader>

        {hasBody && (
          <div data-console-modal-body className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {children}
          </div>
        )}

        {footer && (
          <DialogFooter className="m-0 gap-2 border-t border-ddc-divider bg-ddc-footer px-6 py-4">
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
