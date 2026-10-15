"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ChatConversation,
  ChatConversationContent,
  ChatConversationScrollButton,
} from "@openma/common/chat-ui";
import type { UIMessage } from "ai";
import { DownloadIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";

export type ConversationProps = ComponentProps<typeof ChatConversation>;

export const Conversation = ChatConversation;

export type ConversationContentProps = ComponentProps<
  typeof ChatConversationContent
>;

export const ConversationContent = ChatConversationContent;

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "Сообщений пока нет",
  description = "Начните диалог, и сообщения появятся здесь",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-ddc-icon-muted">{icon}</div>}
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-ddc-heading">{title}</h3>
          {description && (
            <p className="text-sm text-ddc-text-muted">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  children,
  ...props
}: ConversationScrollButtonProps) => {
  return (
    <ChatConversationScrollButton
      className={className}
      icon={children}
      renderButton={({ onClick, className: sharedClassName, icon }) => (
        <Button
          aria-label="Прокрутить вниз"
          title="Прокрутить вниз"
          className={sharedClassName}
          onClick={onClick}
          size="icon"
          type="button"
          variant="outline"
          {...props}
        >
          {icon}
        </Button>
      )}
    />
  );
};

const getMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

export type ConversationDownloadProps = Omit<
  ComponentProps<typeof Button>,
  "onClick"
> & {
  messages: UIMessage[];
  filename?: string;
  formatMessage?: (message: UIMessage, index: number) => string;
};

const ROLE_LABEL: Record<UIMessage["role"], string> = {
  user: "Пользователь",
  assistant: "Агент",
  system: "Система",
};

const defaultFormatMessage = (message: UIMessage): string => {
  const roleLabel =
    ROLE_LABEL[message.role] ??
    message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return `**${roleLabel}:** ${getMessageText(message)}`;
};

export const messagesToMarkdown = (
  messages: UIMessage[],
  formatMessage: (
    message: UIMessage,
    index: number
  ) => string = defaultFormatMessage
): string => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n");

export const ConversationDownload = ({
  messages,
  filename = "conversation.md",
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage);
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [messages, filename, formatMessage]);

  return (
    <Button
      className={cn(
        "absolute top-4 right-4",
        className
      )}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      aria-label="Скачать разговор"
      title="Скачать разговор"
      {...props}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  );
};
