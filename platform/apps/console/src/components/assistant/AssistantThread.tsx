import { useEffect, useRef } from "react";
import { CheckIcon, LoaderCircleIcon, SearchIcon, XIcon } from "lucide-react";
import { Link } from "react-router";

import { Spinner } from "@/components/ui/spinner";

import type { ThreadItem } from "../../lib/assistant/events";
import { Markdown } from "../Markdown";
import { BatchProposalCard } from "./BatchProposalCard";
import { MessageProposalCard } from "./MessageProposalCard";
import { ModelCardDraftCard } from "./ModelCardDraftCard";
import { ProposalCard } from "./ProposalCard";
import { SessionProposalCard } from "./SessionProposalCard";

/**
 * Лента панели: реплики, ответы, свёрнутое чтение и карточки предложений
 * (раздел 1.2 плана). Какая карточка, решает инструмент вызова.
 */

/**
 * Картинки из ответа модели не загружаем: адрес картинки мог бы унести данные
 * из разговора на чужой сервер. Разметка картинки становится подписью. Сноски
 * вида `![alt]` ловит уже рендер: лента рисует Markdown без картинок.
 */
export function stripMarkdownImages(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `[${alt}]` : ""))
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_m, alt: string) => (alt ? `[${alt}]` : ""));
}

function ReadRow({ item }: { item: Extract<ThreadItem, { kind: "read" }> }) {
  const Icon = item.status === "running" ? LoaderCircleIcon : item.status === "error" ? XIcon : CheckIcon;
  const label = item.link ? (
    <Link to={item.link} className="text-ddc-link hover:underline">
      {item.label}
    </Link>
  ) : (
    <span>{item.label}</span>
  );
  return (
    <div className="assistant-read flex items-center gap-1.5 px-1 text-xs text-ddc-text-muted" data-status={item.status}>
      <SearchIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Icon aria-hidden="true" className={item.status === "running" ? "size-3.5 shrink-0 animate-spin" : "size-3.5 shrink-0"} />
      {item.status === "error" ? <span className="sr-only">Не вышло</span> : null}
    </div>
  );
}

function Proposal({ item, sessionId }: { item: Extract<ThreadItem, { kind: "proposal" }>; sessionId: string }) {
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

export function AssistantThread({
  items,
  sessionId,
  running,
}: {
  items: ThreadItem[];
  sessionId: string;
  running: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [items.length, running]);

  return (
    <div className="assistant-thread flex min-w-0 flex-col gap-3 px-3 py-3" aria-live="polite">
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.id} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl bg-ddc-surface-sunken px-3 py-2 text-sm leading-5 whitespace-pre-wrap break-words text-ddc-text">
                  {item.text}
                </p>
              </div>
            );
          case "assistant":
            return (
              <div key={item.id} className="min-w-0 text-sm leading-6 text-ddc-text">
                <Markdown images={false}>{stripMarkdownImages(item.text)}</Markdown>
              </div>
            );
          case "read":
            return <ReadRow key={item.id} item={item} />;
          case "proposal":
            return <Proposal key={item.id} item={item} sessionId={sessionId} />;
          case "draft":
            return <ModelCardDraftCard key={item.id} body={item.body} />;
          case "error":
            return (
              <div key={item.id} className="callout-danger" role="alert">
                <span>{`Ошибка: ${item.text}`}</span>
              </div>
            );
        }
      })}
      {running ? (
        <div className="flex items-center gap-2 px-1 text-xs text-ddc-text-muted" role="status" aria-label="Ассистент работает">
          <Spinner className="size-3.5" />
          <span>Ассистент работает</span>
        </div>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
