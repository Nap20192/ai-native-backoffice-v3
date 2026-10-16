import { Link } from "react-router";

import { Button } from "@/components/ui/button";

/**
 * Агент ассистента общий для пространства, его промпт мог поменять другой
 * участник (раздел 3.1 плана). Если с прошлого разговора версия выросла, над
 * полем строка «Ассистента изменили: версия 3 стала 4» со ссылкой на разницу.
 */

export function versionChange(seen: number | null, current: number): { from: number; to: number } | null {
  if (seen === null || current <= seen) return null;
  return { from: seen, to: current };
}

export function VersionNotice({
  agentId,
  from,
  to,
  onDismiss,
}: {
  agentId: string;
  from: number;
  to: number;
  onDismiss: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 border-t border-ddc-border bg-ddc-tone-warning-bg px-3 py-1.5 text-xs text-ddc-tone-warning-fg"
      role="status"
    >
      <span className="min-w-0 flex-1">{`Ассистента изменили: версия ${from} стала ${to}`}</span>
      <Link
        to={`/agents/${encodeURIComponent(agentId)}?version=${to}&tab=versions`}
        className="shrink-0 underline underline-offset-2"
      >
        Что изменилось
      </Link>
      <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
        Скрыть
      </Button>
    </div>
  );
}
