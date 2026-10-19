import { BatchProposalCard } from "./BatchProposalCard";
import { MessageProposalCard } from "./MessageProposalCard";
import { ProposalCard, type ProposalItem } from "./ProposalCard";
import { SessionProposalCard } from "./SessionProposalCard";

/**
 * Карточка предложения для вызова записи сервера `platform`. Какая карточка,
 * решает инструмент вызова. Карточку рисуют лента ассистента и блок
 * подтверждений на странице любой сессии. Preview и решение идут в
 * `/v1/oma/platform-mcp/*` с id той сессии, где ждёт вызов.
 */
export function PlatformProposal({ item, sessionId }: { item: ProposalItem; sessionId: string }) {
  switch (item.tool) {
    case "apply_changes":
      return <BatchProposalCard item={item} sessionId={sessionId} />;
    case "create_session":
      return <SessionProposalCard item={item} sessionId={sessionId} />;
    case "send_message":
      return <MessageProposalCard item={item} sessionId={sessionId} />;
    default:
      return <ProposalCard item={item} sessionId={sessionId} />;
  }
}
