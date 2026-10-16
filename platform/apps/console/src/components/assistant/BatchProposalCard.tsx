import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import type { PreviewResult } from "../../lib/assistant/api";
import { OperationBody, ProposalShell, operationTitle, type ProposalItem } from "./ProposalCard";
import { PlainButton } from "@/components/ui/plain-button";

/**
 * Карточка пачки `apply_changes` (раздел 1.4 плана): одна кнопка на все
 * операции. Внутри строка на каждый объект с действием, видом, именем и
 * классом, по клику раскрывается YAML или разница. Заголовок считается по
 * операциям, которые прислал сервер, а не по тексту модели.
 */

/** «1 объект», «2 объекта», «5 объектов». */
export function ruObjects(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} объект`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} объекта`;
  return `${n} объектов`;
}

export function batchTitle(preview: PreviewResult): string {
  const ops = preview.operations;
  if (ops.length === 0) return preview.title ?? "Пачка изменений";
  const verb = ops.every((o) => o.class === "create")
    ? "Создать"
    : ops.every((o) => o.class === "edit")
      ? "Изменить"
      : "Применить";
  return `${verb} ${ruObjects(ops.length)}`;
}

const CLASS_LABEL: Record<string, string> = {
  create: "Создание",
  edit: "Правка",
  out_of_v1: "Вне первой версии",
};

export function BatchProposalCard({ item, sessionId }: { item: ProposalItem; sessionId: string }) {
  const [openRow, setOpenRow] = useState<number | null>(null);
  return (
    <ProposalShell
      item={item}
      sessionId={sessionId}
      title={(preview) => (preview ? batchTitle(preview) : "Пачка изменений")}
    >
      {(preview) => (
        <ul className="flex flex-col divide-y divide-ddc-divider rounded-lg border border-ddc-border" aria-label="Объекты пачки">
          {preview.operations.map((op, i) => {
            const open = openRow === i;
            return (
              <li key={op.index} className="min-w-0">
                <PlainButton
                  type="button"
                  className="flex min-h-8 w-full min-w-0 items-start gap-2 px-2 py-1.5 text-left text-xs hover:bg-ddc-surface-muted"
                  aria-expanded={open}
                  onClick={() => setOpenRow(open ? null : i)}
                >
                  <ChevronRightIcon
                    aria-hidden="true"
                    className={cn("mt-0.5 size-3.5 shrink-0 transition-transform", open && "rotate-90")}
                  />
                  <span className="min-w-0 flex-1 font-medium text-ddc-text">{operationTitle(op)}</span>
                  {op.refNote ? <span className="shrink-0 text-ddc-text-muted">{op.refNote}</span> : null}
                  <span className="assistant-chip shrink-0">{CLASS_LABEL[op.class] ?? op.class}</span>
                </PlainButton>
                {open ? (
                  <div className="px-2 pb-2">
                    <OperationBody op={op} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </ProposalShell>
  );
}
