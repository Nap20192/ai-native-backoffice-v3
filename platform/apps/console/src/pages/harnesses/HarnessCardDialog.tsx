import { useEffect, useId, useState } from "react";
import { CircleAlertIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { Field } from "../../components/Field";
import { Modal } from "../../components/Modal";
import {
  HarnessCardsApiError,
  useCreateHarnessCard,
  useUpdateHarnessCard,
  type CardProtocol,
  type HarnessCard,
} from "../../lib/harness-cards-api";
import {
  CARD_PROTOCOL_OPTIONS,
  EMPTY_CARD_FORM,
  DEFAULT_CWD,
  cardToForm,
  draftToForm,
  fieldForServerError,
  formToInput,
  formToPatch,
  validateCardForm,
  type CardFormField,
  type HarnessCardForm,
} from "./harness-card-form";

interface HarnessCardDialogProps {
  open: boolean;
  /** Карточка для правки. `null`: окно создаёт новую. */
  card: HarnessCard | null;
  /** Черновик ассистента для новой карточки. Для правки не используется. */
  draft?: unknown;
  onClose: () => void;
}

type FieldErrors = Partial<Record<CardFormField, string>>;

/** Подпись поля `.label` портала DDC: 12px, medium, отступ 6px. */
const LABEL_CLS = "mb-1.5 block text-xs leading-4 font-medium text-ddc-label";

const MONO_AREA = "resize-y font-mono text-xs leading-5";

/**
 * Окно «Новый harness» и «Harness «X»» (раздел 6.7 контракта
 * docs/plans/models-harness.md). Карточка описывает ACP-агента, который
 * запускается в VM окружения: команду, аргументы, пакеты, протоколы модели и
 * имена переменных. Значений переменных и ключей в ней нет. При правке ID
 * только для чтения. Ошибку сервера окно показывает у поля из `field`, а
 * ошибку без поля над кнопками.
 */
export function HarnessCardDialog({ open, card, draft, onClose }: HarnessCardDialogProps) {
  const isEdit = card !== null;
  const create = useCreateHarnessCard();
  const update = useUpdateHarnessCard();
  const saving = create.isPending || update.isPending;

  const startForm = () => (card ? cardToForm(card) : draft ? draftToForm(draft) : EMPTY_CARD_FORM);
  const [form, setForm] = useState<HarnessCardForm>(startForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");

  const protocolsLabelId = useId();
  const protocolsErrorId = useId();
  const packagesHintId = useId();

  // При каждом открытии окно начинает с карточки или с пустой формы.
  useEffect(() => {
    if (!open) return;
    setForm(startForm());
    setErrors({});
    setFormError("");
    create.reset();
    update.reset();
    // Сбрасываем по открытию и смене карточки; мутации стабильны по смыслу.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, card?.id, draft]);

  const edit = (patch: Partial<HarnessCardForm>, field: CardFormField) => {
    setForm((current) => ({ ...current, ...patch }));
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
    setFormError("");
  };

  const toggleProtocol = (protocol: CardProtocol, checked: boolean) => {
    const protocols = checked
      ? [...form.protocols, protocol]
      : form.protocols.filter((value) => value !== protocol);
    edit({ protocols }, "protocols");
  };

  const submit = async () => {
    const problem = validateCardForm(form, isEdit ? "edit" : "create");
    if (problem) {
      setErrors({ [problem.field]: problem.message });
      setFormError("");
      return;
    }
    setErrors({});
    setFormError("");
    try {
      if (card) {
        await update.mutateAsync({ id: card.id, patch: formToPatch(form) });
        toast.success("Harness сохранён");
      } else {
        await create.mutateAsync(formToInput(form));
        toast.success("Harness создан");
      }
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось сохранить harness";
      const field = error instanceof HarnessCardsApiError ? fieldForServerError(error.field) : null;
      if (field) setErrors({ [field]: message });
      else setFormError(message);
    }
  };

  const title = card ? `Harness «${card.name}»` : "Новый harness";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      maxWidth="max-w-xl"
      closeDisabled={saving}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="button" onClick={() => void submit()} loading={saving}>
            {isEdit ? "Сохранить" : "Создать"}
          </Button>
        </>
      }
    >
      <form autoComplete="off" onSubmit={(event) => event.preventDefault()} className="space-y-4">
        {formError && (
          <div role="alert" className="callout-danger">
            <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
            <span className="min-w-0 break-words">{formError}</span>
          </div>
        )}
        <Field label="Название" error={errors.name}>
          <Input
            id="harness-card-name"
            value={form.name}
            onChange={(event) => edit({ name: event.target.value }, "name")}
            placeholder="Aider через ACP"
            aria-required="true"
          />
        </Field>
        <Field
          label="ID"
          error={errors.harnessId}
          hint={
            errors.harnessId ? undefined : "Латиница, цифры и дефис. Так harness записывается в агента"
          }
        >
          <Input
            id="harness-card-id"
            value={form.harnessId}
            onChange={(event) => edit({ harnessId: event.target.value }, "harnessId")}
            readOnly={isEdit}
            aria-required={isEdit ? undefined : "true"}
            className="font-mono"
            placeholder="aider-local"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Команда"
          error={errors.command}
          hint="Имя программы в VM или абсолютный путь. Программа говорит по ACP через stdin и stdout"
        >
          <Input
            id="harness-card-command"
            value={form.command}
            onChange={(event) => edit({ command: event.target.value }, "command")}
            aria-required="true"
            className="font-mono"
            placeholder="aider-acp"
            spellCheck={false}
          />
        </Field>
        <Field label="Аргументы" error={errors.args} hint="По одному в строке.">
          <Textarea
            id="harness-card-args"
            value={form.argsText}
            onChange={(event) => edit({ argsText: event.target.value }, "args")}
            rows={3}
            className={MONO_AREA}
            spellCheck={false}
          />
        </Field>
        <Field label="Рабочая папка" error={errors.cwd}>
          <Input
            id="harness-card-cwd"
            value={form.cwd}
            onChange={(event) => edit({ cwd: event.target.value }, "cwd")}
            className="font-mono"
            placeholder={DEFAULT_CWD}
            spellCheck={false}
          />
        </Field>
        <div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Пакеты npm" error={errors.npm}>
              <Textarea
                id="harness-card-npm"
                value={form.npmText}
                onChange={(event) => edit({ npmText: event.target.value }, "npm")}
                rows={3}
                className={MONO_AREA}
                aria-describedby={packagesHintId}
                placeholder={"@scope/pkg@1.2.3\nother-pkg@4.5.6"}
                spellCheck={false}
              />
            </Field>
            <Field label="Пакеты pip" error={errors.pip}>
              <Textarea
                id="harness-card-pip"
                value={form.pipText}
                onChange={(event) => edit({ pipText: event.target.value }, "pip")}
                rows={3}
                className={MONO_AREA}
                aria-describedby={packagesHintId}
                placeholder={"aider-chat==0.86.1\nother-pkg==2.0"}
                spellCheck={false}
              />
            </Field>
          </div>
          <p id={packagesHintId} className="mt-1.5 text-xs leading-4 text-ddc-text-muted">
            Harness сам ничего не ставит. Добавьте эти пакеты в окружение сессии
          </p>
        </div>
        <div
          role="group"
          aria-labelledby={protocolsLabelId}
          aria-describedby={errors.protocols ? protocolsErrorId : undefined}
        >
          <span id={protocolsLabelId} className={LABEL_CLS}>
            Протоколы модели
          </span>
          <div className="space-y-2">
            {CARD_PROTOCOL_OPTIONS.map((option) => (
              <Label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 text-sm leading-5 font-normal text-ddc-text"
              >
                <Checkbox
                  checked={form.protocols.includes(option.value)}
                  onCheckedChange={(checked) => toggleProtocol(option.value, checked === true)}
                />
                {option.label}
              </Label>
            ))}
          </div>
          {errors.protocols && (
            <p id={protocolsErrorId} className="mt-1.5 text-xs leading-4 text-ddc-danger-text">
              {errors.protocols}
            </p>
          )}
        </div>
        <Field
          label="Переменные окружения"
          error={errors.env}
          hint="Только имена. Значения задаются в агенте. Ключи сюда не кладите: модель подключается через прокси сервера"
        >
          <Textarea
            id="harness-card-env"
            value={form.envText}
            onChange={(event) => edit({ envText: event.target.value }, "env")}
            rows={3}
            className={MONO_AREA}
            placeholder="AIDER_AUTO_COMMITS"
            spellCheck={false}
          />
        </Field>
        <div>
          <span className={LABEL_CLS}>Статус</span>
          <Badge variant="neutral">Не проверено</Badge>
        </div>
      </form>
    </Modal>
  );
}
