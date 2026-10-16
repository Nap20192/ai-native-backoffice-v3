import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpIcon, HistoryIcon, SparklesIcon, SquarePenIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { usePhoneLayout } from "@/hooks/use-phone-layout";

import { useAssistant } from "./AssistantProvider";
import { AssistantSwitch } from "./AssistantSwitch";
import { AssistantThread } from "./AssistantThread";
import { ChangesTab } from "./ChangesTab";
import { ContextChip, useContextLabel } from "./ContextChip";
import { InstallPrompt } from "./InstallPrompt";
import { StarterCards } from "./StarterCards";
import { VersionNotice } from "./VersionNotice";
import { PlainButton } from "@/components/ui/plain-button";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Панель ассистента (раздел 1.2 плана). На широком экране это колонка справа
 * около 370 px на всю высоту, место ей отдаёт оболочка. На телефоне панель
 * открывается нижним листом на половину высоты.
 */

type Tab = "chat" | "changes";

function Header({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) {
  const a = useAssistant();
  const [historyOpen, setHistoryOpen] = useState(false);
  const ready = a.status === "ready";
  return (
    <header className="flex flex-col border-b border-ddc-border">
      <div className="flex items-center gap-1 px-3 py-2">
        <SparklesIcon aria-hidden="true" className="size-4 shrink-0 text-(--assistant-accent)" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ddc-heading">Ассистент</h2>
        {ready ? (
          <>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Новый разговор" title="Новый разговор" onClick={a.newConversation}>
              <SquarePenIcon aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="История"
              title="История"
              aria-expanded={historyOpen}
              onClick={() => {
                if (!historyOpen) a.loadHistory();
                setHistoryOpen((v) => !v);
              }}
            >
              <HistoryIcon aria-hidden="true" />
            </Button>
          </>
        ) : null}
        <AssistantSwitch settings={a.settings} onChange={a.setEnabled} />
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Закрыть панель" title="Закрыть панель" onClick={() => a.setOpen(false)}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>

      {historyOpen && ready ? (
        <div className="border-t border-ddc-border px-2 py-1.5" aria-label="Прошлые разговоры">
          {a.historyLoading ? (
            <div className="flex justify-center py-2">
              <Spinner className="size-4" />
            </div>
          ) : a.history.length === 0 ? (
            <p className="px-1 py-1 text-xs text-ddc-text-muted">Прошлых разговоров нет</p>
          ) : (
            <ul className="flex max-h-48 flex-col overflow-auto">
              {a.history.map((chat) => (
                <li key={chat.id}>
                  <PlainButton
                    type="button"
                    className="flex min-h-8 w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-ddc-surface-muted"
                    onClick={() => {
                      a.openChat(chat.id);
                      setHistoryOpen(false);
                      onTab("chat");
                    }}
                  >
                    <span className="min-w-0 truncate text-ddc-text">{chat.title}</span>
                    <span className="shrink-0 text-ddc-text-muted">
                      {chat.createdAt ? new Date(chat.createdAt).toLocaleDateString("ru-RU") : ""}
                    </span>
                  </PlainButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {ready ? (
        <div className="flex items-center gap-2 px-3 pb-2">
          <div role="tablist" aria-label="Разделы панели" className="flex gap-1">
            {(
              [
                ["chat", "Чат"],
                ["changes", "Изменения"],
              ] as const
            ).map(([id, label]) => (
              <PlainButton
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => onTab(id)}
                className={cn(
                  "h-8 rounded-lg px-2.5 text-xs font-medium",
                  tab === id ? "bg-ddc-selected-bg text-ddc-selected-text" : "text-ddc-ghost-text hover:bg-ddc-ghost-hover",
                )}
              >
                {label}
              </PlainButton>
            ))}
          </div>
          <div className="ml-auto flex min-w-0 items-center">
            <NativeSelect
              aria-label="Модель"
              value={a.model ?? ""}
              onChange={(e) => a.setModel(e.target.value || null)}
              className="h-8 max-w-40 truncate rounded-lg border border-ddc-border-strong bg-ddc-outline-bg px-1.5 text-xs text-ddc-text"
              title={a.sessionId ? "Модель применится в новом разговоре" : "Модель разговора"}
            >
              <option value="">Из шаблона</option>
              {a.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      ) : null}
    </header>
  );
}

function Composer({ disabled }: { disabled: boolean }) {
  const a = useAssistant();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const contextLabel = useContextLabel(a.pageContext);

  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  async function submit() {
    const value = text.trim();
    if (!value || disabled || a.sending) return;
    setText("");
    await a.send(value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="assistant-composer flex flex-col gap-1.5 border-t border-ddc-border px-3 py-2">
      {a.sendError ? (
        <p className="text-xs font-medium text-ddc-danger-text" role="alert">
          {a.sendError}
        </p>
      ) : null}
      {!disabled && a.contextEnabled ? (
        <ContextChip ctx={a.pageContext} onRemove={a.removeContext} label={contextLabel} />
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          rows={2}
          aria-label="Сообщение ассистенту"
          placeholder={
            disabled
              ? "Ассистент недоступен"
              : a.contextEnabled
                ? `Спросите про: ${contextLabel}`
                : "Спросите или попросите что-нибудь настроить"
          }
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-10 flex-1"
        />
        <Button
          type="button"
          size="icon-sm"
          aria-label="Отправить"
          title="Отправить"
          disabled={disabled || a.sending || !text.trim()}
          onClick={() => void submit()}
        >
          <ArrowUpIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function Body() {
  const a = useAssistant();
  const [tab, setTab] = useState<Tab>("chat");
  const disabled = a.status !== "ready";

  let content;
  if (a.status === "idle" || a.status === "loading") {
    content = (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  } else if (a.status === "error") {
    content = (
      <div className="flex flex-col items-start gap-3 px-3 py-6">
        <p className="text-sm text-ddc-danger-text">Не удалось загрузить ассистента</p>
        <Button type="button" variant="outline" size="sm" onClick={a.reload}>
          Повторить
        </Button>
      </div>
    );
  } else if (a.status === "not_installed") {
    content = <InstallPrompt models={a.models} busy={a.installing} error={a.installError} onInstall={(m) => void a.install(m)} />;
  } else if (a.status === "disabled") {
    // Лента разговора остаётся видна: ждущие карточки сами пишут, что ассистент выключен.
    content = (
      <>
        <p className="px-3 py-6 text-sm text-ddc-text-muted">
          Ассистент выключен. Включить его может владелец или администратор пространства
        </p>
        {a.sessionId && a.thread.length > 0 ? (
          <AssistantThread items={a.thread} sessionId={a.sessionId} running={false} />
        ) : null}
      </>
    );
  } else if (tab === "changes") {
    content = <ChangesTab sessionId={a.sessionId} />;
  } else if (!a.sessionId || a.thread.length === 0) {
    content = (
      <StarterCards
        kind={a.pageContext.kind}
        disabled={a.sending}
        onPick={(prompt) => void a.send(prompt)}
      />
    );
    if (a.sessionId && a.thread.length === 0 && a.running) {
      content = <AssistantThread items={[]} sessionId={a.sessionId} running />;
    }
  } else {
    content = <AssistantThread items={a.thread} sessionId={a.sessionId} running={a.running} />;
  }

  return (
    <>
      <Header tab={tab} onTab={setTab} />
      <div className="assistant-panel-body">{content}</div>
      {a.status === "ready" && a.versionNotice && a.builder ? (
        <VersionNotice
          agentId={a.builder.agent.id}
          from={a.versionNotice.from}
          to={a.versionNotice.to}
          onDismiss={a.dismissVersionNotice}
        />
      ) : null}
      {tab === "chat" ? <Composer disabled={disabled} /> : null}
    </>
  );
}

export function AssistantPanel() {
  const a = useAssistant();
  const phone = usePhoneLayout();
  if (!a.open) return null;

  if (phone) {
    return (
      <Sheet open onOpenChange={(next) => !next && a.setOpen(false)}>
        <SheetContent side="bottom" showCloseButton={false} className="assistant-sheet">
          <SheetTitle className="sr-only">Ассистент</SheetTitle>
          <SheetDescription className="sr-only">Панель ассистента платформы</SheetDescription>
          <div className="flex min-h-0 flex-1 flex-col">
            <Body />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside className="assistant-panel" aria-label="Ассистент">
      <Body />
    </aside>
  );
}
