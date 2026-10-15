import { InfoIcon } from "lucide-react";
import { useId } from "react";

import { PlainButton } from "@/components/ui/plain-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Значок «i» с подсказкой. Подсказка открывается после паузы 700 мс, текст
 * лежит и в скрытом описании кнопки, поэтому скринридер читает его сразу, а
 * не только при наведении. `subject` входит в доступное имя кнопки.
 */
export function InfoHint({
  subject,
  children,
  className,
}: {
  /** О чём подсказка: «Токены на входе». */
  subject: string;
  /** Текст подсказки. */
  children: string;
  className?: string;
}) {
  const descriptionId = useId();
  return (
    <TooltipProvider delayDuration={700}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PlainButton
            aria-label={`Пояснение: ${subject}`}
            aria-describedby={descriptionId}
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-ddc-icon-muted hover:text-ddc-text",
              className,
            )}
          >
            <InfoIcon className="size-3.5" aria-hidden="true" />
          </PlainButton>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-pretty">
          {children}
        </TooltipContent>
      </Tooltip>
      <span id={descriptionId} className="sr-only">
        {children}
      </span>
    </TooltipProvider>
  );
}
