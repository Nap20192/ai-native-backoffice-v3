import { useMemo, type ReactNode } from "react";
import { AgentChatView, type AgentChatViewSlots } from "@openma/common/chat-ui";
import { Button } from "@/components/ui/button";
import type { CanonicalChatTurn } from "@openma/common/session-events/managed";
import {
  CanonicalSessionTurn,
  projectCanonicalSessionTurn,
} from "./CanonicalSessionTurn";

export interface ManagedSessionConversationProps {
  afterTurns?: ReactNode;
  beforeComposer?: ReactNode;
  composer: ReactNode;
  empty?: ReactNode;
  sessionId?: string;
  turns: readonly CanonicalChatTurn[];
}

/** Кнопка «вниз» поверх чата: кнопка-иконка DDC с русской подписью вместо
 *  английской «Scroll to bottom» из общего пакета. */
const renderScrollButton: NonNullable<AgentChatViewSlots["renderScrollButton"]> = ({
  onClick,
  className,
  icon,
}) => (
  <Button
    type="button"
    variant="outline"
    size="icon"
    className={className}
    onClick={onClick}
    aria-label="Прокрутить вниз"
    title="Прокрутить вниз"
  >
    {icon}
  </Button>
);

/**
 * Console supplies data and product slots; OpenMA UI owns the transcript,
 * scroll anchoring, shared turn lifecycle, and composer column.
 */
export function ManagedSessionConversation({
  afterTurns,
  beforeComposer,
  composer,
  empty,
  sessionId,
  turns,
}: ManagedSessionConversationProps) {
  const projectedTurns = useMemo(
    () => turns.map(projectCanonicalSessionTurn),
    [turns],
  );
  const sourceTurns = useMemo(
    () => new Map(turns.map((turn) => [turn.id, turn])),
    [turns],
  );

  return (
    <AgentChatView
      className="flex-1 min-h-0"
      phase="active"
      renderTurn={({ turn }) => {
        const source = sourceTurns.get(turn.id);
        return source ? (
          <CanonicalSessionTurn
            projectedTurn={turn}
            sessionId={sessionId}
            turn={source}
          />
        ) : null;
      }}
      sessionId={sessionId}
      slots={{
        composer,
        beforeComposer,
        conversationContentAfter: afterTurns,
        renderScrollButton,
        empty: empty ?? (
          <p className="text-sm text-ddc-text-muted">Отправьте сообщение, чтобы начать сессию.</p>
        ),
      }}
      surface="console"
      turns={projectedTurns}
    />
  );
}
