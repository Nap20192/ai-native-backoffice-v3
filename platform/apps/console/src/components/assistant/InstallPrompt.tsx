import { useState } from "react";
import { SparklesIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import type { ModelChoice } from "../../lib/assistant/install";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Первый Ctrl I в пространстве без ассистента (раздел 1.2 плана): выбор модели
 * и кнопка «Установить». Установка та же, что у шаблона «Конструктор», её делает
 * консоль от имени пользователя.
 */
export function InstallPrompt({
  models,
  busy,
  error,
  onInstall,
}: {
  models: ModelChoice[];
  busy: boolean;
  error: string | null;
  onInstall: (model: string | null) => void;
}) {
  const [model, setModel] = useState("");
  return (
    <section className="flex flex-col items-start gap-3 px-3 py-6">
      <SparklesIcon aria-hidden="true" className="size-6 text-(--assistant-accent)" />
      <h3 className="text-base font-semibold text-ddc-heading">Ассистента здесь ещё нет</h3>
      <p className="text-sm text-ddc-text-muted">
        Ассистент настраивает платформу вместе с вами: создаёт агентов, окружения и навыки, а записи делает только по вашей кнопке.
        Установка создаёт окружение «Ассистент» и одноимённого агента.
      </p>
      <Label className="flex w-full flex-col gap-1 text-xs font-medium text-ddc-label">
        Модель
        <NativeSelect
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={busy}
          className="h-9 w-full rounded-xl border border-ddc-border-strong bg-ddc-outline-bg px-2 text-sm font-normal text-ddc-text"
        >
          <option value="">Из шаблона</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </NativeSelect>
      </Label>
      {error ? (
        <p className="text-xs font-medium text-ddc-danger-text" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="button" disabled={busy} onClick={() => onInstall(model || null)}>
        {busy ? (
          <>
            <Spinner className="size-4" />
            Устанавливаю
          </>
        ) : (
          "Установить"
        )}
      </Button>
    </section>
  );
}
