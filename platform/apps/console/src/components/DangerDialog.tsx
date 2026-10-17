import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import {
  EMPTY_DEPENDENCY_REPORT,
  type DependencyOperation,
  type DependencyReport,
} from "../lib/dependencies";
import { useDependencyReport, type DependencyTarget } from "../lib/useDependencyReport";
import { DependencyList } from "./DependencyList";
import { Modal } from "./Modal";

export interface DangerRunOptions {
  /** Значение `If-Match` или `undefined`, когда ревизии нет. */
  ifMatch?: string;
}

interface DangerDialogProps {
  open: boolean;
  operation: DependencyOperation;
  /** Объект, у которого читаются зависимости. `null` пока окно закрыто. */
  target: DependencyTarget | null;
  /** Вопрос окна, например «Удалить окружение?». */
  title: string;
  /** Что случится с объектом. Строка про возврат из архива или про необратимость добавляется окном. */
  message?: string;
  confirmLabel?: string;
  /** Известная ревизия для `If-Match`: версия агента, `updated_at` карточки. */
  ifMatch?: string;
  /** Адрес, с которого окно читает `ETag` объекта, когда ревизии нет в данных. */
  etagPath?: string;
  /** Выполняет архив или удаление и бросает ошибку при неудаче. */
  run: (options: DangerRunOptions) => Promise<unknown>;
  /** Вызывается после успеха, окно закрывает страница. */
  onDone: () => void;
  onClose: () => void;
}

/**
 * Окно архива и удаления со списками зависимостей (docs/plans/crud.md, 4.2).
 * При открытии читает GET /v1/oma/dependencies. Блокирующие зависимости
 * выключают кнопку. Ответ 409 `dependency_conflict_error` показывает тот же
 * список, ответ 412 просит обновить страницу. Запрос уходит с `If-Match`.
 */
export function DangerDialog({
  open,
  operation,
  target,
  title,
  message,
  confirmLabel,
  ifMatch,
  etagPath,
  run,
  onDone,
  onClose,
}: DangerDialogProps) {
  const state = useDependencyReport(open ? target : null, operation, etagPath);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<DependencyReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setConflict(null);
      setFailure(null);
    }
  }, [open]);

  const report = conflict ?? state.report ?? EMPTY_DEPENDENCY_REPORT;
  const blocked = report.blocking.length > 0;
  const isDelete = operation === "delete";
  const note = isDelete ? "Это нельзя отменить." : "Можно вернуть из архива.";
  const label = confirmLabel ?? (isDelete ? "Удалить" : "В архив");

  const hasBody =
    state.loading ||
    (state.failed && conflict === null) ||
    blocked ||
    report.affected.length > 0 ||
    failure !== null;

  const confirm = async () => {
    setBusy(true);
    setFailure(null);
    const revision = ifMatch ?? state.etag ?? undefined;
    try {
      await run(revision ? { ifMatch: revision } : {});
      onDone();
    } catch (error) {
      const { dependencies, status } = error as { dependencies?: DependencyReport; status?: number };
      if (dependencies) {
        setConflict(dependencies);
      } else if (status === 412) {
        setFailure("Объект изменили, обновите страницу.");
      } else if (error instanceof Error) {
        setFailure(error.message);
      } else {
        setFailure("Не удалось выполнить действие.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={message ? `${message} ${note}` : note}
      maxWidth="max-w-md"
      closeDisabled={busy}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void confirm()}
            loading={busy}
            disabled={blocked || state.loading}
          >
            {label}
          </Button>
        </>
      }
    >
      {hasBody ? (
      <div className="flex flex-col gap-3">
        {state.loading ? (
          <p className="text-sm text-ddc-text-muted">Проверяем, что связано с объектом…</p>
        ) : null}
        {state.failed && conflict === null ? (
          <p className="text-sm text-ddc-text-muted">
            Не удалось проверить зависимости заранее. Сервер проверит их при выполнении.
          </p>
        ) : null}
        <DependencyList report={report} />
        {blocked ? (
          <p role="alert" className="text-sm text-ddc-tone-danger-fg">
            {isDelete ? "Удаление" : "Архив"} недоступно, пока есть зависимости из списка «Мешает».
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="text-sm text-ddc-tone-danger-fg">
            {failure}
          </p>
        ) : null}
      </div>
      ) : null}
    </Modal>
  );
}
