import { useState } from "react";
import { MoreHorizontalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { AssistantSettings } from "../../lib/assistant/api";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * Выключатель ассистента в пространстве (раздел 3.7 плана). Меню видят только
 * те, кому сервер разрешил менять (`can_change`: владелец и администратор).
 * Выключение спрашивает подтверждение, включение нет.
 */
export function AssistantSwitch({
  settings,
  onChange,
}: {
  settings: AssistantSettings | null;
  onChange: (enabled: boolean) => Promise<void>;
}) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!settings?.canChange) return null;

  async function apply(enabled: boolean) {
    setBusy(true);
    try {
      await onChange(enabled);
    } finally {
      setBusy(false);
      setAsk(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Меню ассистента" title="Меню ассистента">
            <MoreHorizontalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              if (settings.enabled) setAsk(true);
              else void apply(true);
            }}
          >
            {settings.enabled ? "Выключить ассистента в пространстве" : "Включить ассистента"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={ask}
        title="Выключить ассистента?"
        message="Инструменты ассистента в пространстве начнут отвечать отказом. Идущий ход дойдёт до конца. Включить его снова может владелец или администратор."
        confirmLabel="Выключить"
        destructive
        busy={busy}
        onConfirm={() => void apply(false)}
        onCancel={() => setAsk(false)}
      />
    </>
  );
}
