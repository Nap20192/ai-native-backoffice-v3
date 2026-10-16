import type { PreviewResult } from "../../lib/assistant/api";
import { ProposalShell, type ProposalItem } from "./ProposalCard";

/**
 * Карточка `send_message` (раздел 1.4 плана). Сообщение запускает агента, поэтому
 * его полный текст показан без сворачивания и как обычный текст: разметка в
 * сообщении не исполняется и не форматируется. Пользователь видит ровно то,
 * что получит агент.
 */

function titleOf(preview: PreviewResult | null, input: Record<string, unknown>): string {
  if (!preview) return "Отправить первое сообщение";
  const name =
    preview.message?.sessionTitle ??
    preview.message?.sessionId ??
    (typeof input.session_id === "string" ? input.session_id : null);
  return name ? `Отправить первое сообщение в сессию «${name}»` : "Отправить первое сообщение";
}

export function MessageProposalCard({ item, sessionId }: { item: ProposalItem; sessionId: string }) {
  return (
    <ProposalShell
      item={item}
      sessionId={sessionId}
      title={(preview) => titleOf(preview, item.input)}
      confirmLabel={() => "Отправить"}
    >
      {(preview) => (
        <div className="flex flex-col gap-2 text-xs">
          <dl className="flex flex-col gap-1">
            <div className="grid grid-cols-[7.5rem_1fr] gap-2">
              <dt className="text-ddc-text-muted">Агент</dt>
              <dd className="min-w-0 break-words text-ddc-text">{preview.message?.agentName ?? "не указан"}</dd>
            </div>
            <div className="grid grid-cols-[7.5rem_1fr] gap-2">
              <dt className="text-ddc-text-muted">Окружение</dt>
              <dd className="min-w-0 break-words text-ddc-text">{preview.message?.environmentName ?? "не указано"}</dd>
            </div>
          </dl>
          <pre
            aria-label="Текст сообщения"
            className="max-h-[60vh] overflow-auto rounded-lg border border-ddc-border bg-ddc-surface-muted p-2 font-sans text-xs leading-5 whitespace-pre-wrap break-words text-ddc-text"
          >
            {preview.message?.text ?? ""}
          </pre>
          <p className="text-ddc-text-muted">Агент начнёт работу сразу после отправки</p>
        </div>
      )}
    </ProposalShell>
  );
}
