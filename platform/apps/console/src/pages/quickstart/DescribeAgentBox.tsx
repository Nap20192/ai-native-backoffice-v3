import { useState, type KeyboardEvent } from "react";
import { SparklesIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/**
 * Поле «Что хотите построить?» быстрого старта (раздел 1.3 плана builder-agent).
 * Поле шириной 768 px с примером обычной фразой и серая кнопка «Сгенерировать»,
 * пока текста нет. Дальше работает `DescribeAgent`: поле лишь собирает текст.
 */

const EXAMPLE =
  "Например: агент, который раз в день собирает новые заявки из файла и пишет сводку";

export function DescribeAgentBox({
  onSubmit,
  defaultValue = "",
  className,
}: {
  onSubmit: (prompt: string) => void;
  defaultValue?: string;
  className?: string;
}) {
  const [text, setText] = useState(defaultValue);
  const ready = text.trim().length > 0;

  function submit() {
    if (!ready) return;
    onSubmit(text.trim());
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className={cn("flex w-full max-w-[768px] flex-col gap-2", className)}>
      <Label htmlFor="describe-agent-box" className="text-sm font-semibold text-ddc-heading">
        Что хотите построить?
      </Label>
      <Textarea
        id="describe-agent-box"
        rows={4}
        value={text}
        placeholder={EXAMPLE}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div>
        <Button type="button" disabled={!ready} onClick={submit}>
          <SparklesIcon aria-hidden="true" />
          Сгенерировать
        </Button>
      </div>
    </div>
  );
}
