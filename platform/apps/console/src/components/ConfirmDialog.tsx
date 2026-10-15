import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

import { Modal } from "./Modal";

interface ConfirmDialogProps {
  open: boolean;
  /** Вопрос, например «Удалить навык?». */
  title: string;
  /** Пояснение под вопросом. Его читает диктор, поэтому оно лежит в описании
   *  окна. Для удаления: «Действие нельзя отменить.» */
  message?: ReactNode;
  /** Подпись действия. По умолчанию «Подтвердить». */
  confirmLabel?: string;
  /** Подпись отмены. По умолчанию «Отмена». */
  cancelLabel?: string;
  /** Опасное действие: кнопка красная (`btn-danger`), иначе фирменная. */
  destructive?: boolean;
  /** Действие выполняется: обе кнопки заблокированы, окно не закрывается. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Подтверждение DDC (правило 11): единственный способ спросить пользователя
 * перед необратимым действием, `window.confirm` запрещён. Окно размера sm,
 * подвал из двух кнопок по 40px: «Отмена» (`ghost`) слева и действие справа.
 * Пока идёт действие, на кнопке действия спиннер вместо иконки, подпись
 * остаётся, а закрыть окно нельзя.
 *
 *   <ConfirmDialog
 *     open={askDelete}
 *     title="Удалить навык?"
 *     message="Действие нельзя отменить."
 *     confirmLabel="Удалить"
 *     destructive
 *     busy={deleting}
 *     onConfirm={deleteSkill}
 *     onCancel={() => setAskDelete(false)}
 *   />
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Подтвердить",
  cancelLabel = "Отмена",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      subtitle={message}
      maxWidth="max-w-sm"
      closeDisabled={busy}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {null}
    </Modal>
  );
}
