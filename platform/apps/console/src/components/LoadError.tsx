import type { ReactNode } from "react";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { EmptyState } from "./EmptyState";

/**
 * Ошибка загрузки страницы или списка (DDC): пустое состояние тона warning с
 * иконкой `AlertTriangle`, русским текстом причины и кнопкой «Повторить» с
 * `RefreshCw`. Страница показывает один такой блок вместо красной выноски,
 * а запрос идёт с `quiet`, чтобы тост не повторял то же сообщение.
 * `extra` добавляет вторую кнопку рядом (например, «К списку»).
 */
export function LoadError({
  title,
  message,
  onRetry,
  retrying,
  retryLabel = "Повторить",
  extra,
  size = "md",
  className,
}: {
  title: string;
  message: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
  extra?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <EmptyState
      tone="warning"
      icon={<AlertTriangleIcon />}
      title={title}
      size={size}
      className={className}
      body={<span role="alert">{message}</span>}
      action={
        onRetry || extra ? (
          <>
            {onRetry && (
              <Button variant="outline" loading={retrying} onClick={onRetry}>
                <RefreshCwIcon />
                {retryLabel}
              </Button>
            )}
            {extra}
          </>
        ) : undefined
      }
    />
  );
}
