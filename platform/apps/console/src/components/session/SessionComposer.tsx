import { Button } from "@/components/ui/button";
import { useCallback, useState, type CSSProperties, type FormEvent } from "react";
import {
  CornerDownLeftIcon,
  LoaderCircleIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  type PromptInputMessage,
  type PromptInputProps,
} from "../ai-elements/prompt-input";

export interface SessionComposerProps {
  interrupting: boolean;
  onError: NonNullable<PromptInputProps["onError"]>;
  onStop: () => void;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
  running: boolean;
  sending: boolean;
}

/** Кнопки поля ввода 32px вместо 28px общего стиля: цель нажатия не меньше
 *  32px (правило 13 DDC), высоту карточки она не меняет. */
const COMPOSER_VARS = { "--composer-control-height": "32px" } as CSSProperties;

/**
 * Managed-session composer with the same interaction shape as Backchat:
 * one compact card, a 48px writing area, a bottom tool row, and one primary
 * action slot that switches between send/queue and stop.
 */
export function SessionComposer({
  interrupting,
  onError,
  onStop,
  onSubmit,
  running,
  sending,
}: SessionComposerProps) {
  const [draft, setDraft] = useState("");

  const handleSubmit = useCallback(
    async (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => {
      setDraft("");
      await onSubmit(message, event);
    },
    [onSubmit],
  );

  return (
    <PromptInput
      accept="image/*"
      className="session-composer"
      style={COMPOSER_VARS}
      globalDrop
      maxFiles={10}
      maxFileSize={25 * 1024 * 1024}
      multiple
      onError={onError}
      onSubmit={handleSubmit}
    >
      <ComposerAttachmentStrip disabled={sending || interrupting} />
      <PromptInputTextarea
        aria-label="Сообщение"
        className="session-composer-textarea"
        disabled={sending || interrupting}
        onChange={(event) => setDraft(event.currentTarget.value)}
        placeholder="Напишите сообщение…"
        rows={1}
      />
      <PromptInputFooter className="session-composer-footer">
        <PromptInputTools>
          <ComposerAttachButton disabled={sending || interrupting} />
        </PromptInputTools>
        <ComposerPrimaryAction
          draft={draft}
          interrupting={interrupting}
          onStop={onStop}
          running={running}
          sending={sending}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}

function ComposerAttachButton({ disabled }: { disabled: boolean }) {
  const attachments = usePromptInputAttachments();

  return (
    <PromptInputButton
      aria-label="Добавить изображение"
      className="session-composer-control"
      disabled={disabled}
      onClick={() => attachments.openFileDialog()}
      size="icon-sm"
      title="Добавить изображение"
      type="button"
    >
      <PlusIcon aria-hidden="true" className="size-4" />
    </PromptInputButton>
  );
}

function ComposerAttachmentStrip({ disabled }: { disabled: boolean }) {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) return null;

  return (
    <div className="session-composer-attachments" aria-label="Вложения">
      {attachments.files.map((file) => (
        <div className="session-composer-attachment" key={file.id}>
          {file.url ? (
            <img alt="" aria-hidden="true" src={file.url} />
          ) : null}
          <span title={file.filename}>{file.filename ?? "Изображение"}</span>
          {/* Видимая кнопка 20px, зона нажатия расширена до 32px (правило 13). */}
          <Button variant="ghost"
            className="relative after:absolute after:-inset-1.5 after:content-['']"
            aria-label={`Убрать ${file.filename ?? "изображение"}`}
            title="Убрать вложение"
            disabled={disabled}
            onClick={() => attachments.remove(file.id)}
            type="button"
          >
            <XIcon aria-hidden="true" className="size-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function ComposerPrimaryAction({
  draft,
  interrupting,
  onStop,
  running,
  sending,
}: {
  draft: string;
  interrupting: boolean;
  onStop: () => void;
  running: boolean;
  sending: boolean;
}) {
  const attachments = usePromptInputAttachments();
  const canSend = draft.trim().length > 0 || attachments.files.length > 0;
  const stopIsPrimary = running && !canSend;
  const busy = sending || interrupting;
  let label = running ? "Поставить сообщение в очередь" : "Отправить сообщение";
  if (stopIsPrimary) label = "Остановить ответ";
  if (sending) label = running ? "Сообщение ставится в очередь" : "Сообщение отправляется";
  if (interrupting) label = "Ответ останавливается";

  return (
    <PromptInputSubmit
      aria-label={label}
      className="session-composer-control"
      data-session-composer-action="true"
      disabled={busy || (!stopIsPrimary && !canSend)}
      onStop={stopIsPrimary ? onStop : undefined}
      size="icon-sm"
      status={busy ? "submitted" : stopIsPrimary ? "streaming" : undefined}
      title={label}
      variant="ghost"
    >
      {busy ? (
        <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
      ) : stopIsPrimary ? (
        <SquareIcon aria-hidden="true" className="size-3.5" />
      ) : (
        <CornerDownLeftIcon aria-hidden="true" className="size-4" />
      )}
    </PromptInputSubmit>
  );
}
