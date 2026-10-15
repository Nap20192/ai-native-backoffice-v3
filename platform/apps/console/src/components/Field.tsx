import { Input } from "@/components/ui/input";
import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";

import { Label } from "@/components/ui/label";

interface FieldProps {
  /** Visible label text. Rendered as `<Label htmlFor>`. */
  label?: ReactNode;
  /** Helper text below the input. Wired up via `aria-describedby` on the
   *  child so screen readers announce it after the input's name. */
  hint?: ReactNode;
  /** Visible inline error. When set, takes precedence over `hint` and
   *  the child gains `aria-invalid="true"`. */
  error?: ReactNode;
  /** Optional class on the wrapper. */
  className?: string;
  /** Single form control: input / textarea / select / Combobox / Select.
   *  The control is cloned with `id`, `aria-describedby`, and
   *  `aria-invalid` props so callers don't have to thread them. */
  children: ReactNode;
}

/**
 * Form-field wrapper that programmatically associates a label with its
 * input via `htmlFor`/`id`. Replaces the 6 in-file reimplementations
 * across console pages — most of which forgot the `htmlFor`/`id` pair
 * and silently shipped orphan labels (clicking the label didn't focus
 * the input; SR users couldn't pair them).
 *
 * Подпись `.label` DDC: 12px, medium, ink-600, отступ 6px; подсказка и
 * ошибка 12px с отступом 6px (`text-muted` / `text-error`).
 *
 * Usage:
 *   <Field label="Название" hint="Буквы, цифры и дефисы.">
 *     <Input value={name} onChange={...} className={inputCls} />
 *   </Field>
 *
 * The cloning approach lets callsites use any form-control element
 * without a pre-defined wrapper. The control's existing `id`, if any,
 * wins over the generated one, so callers can override.
 *
 * Visual layer leans on shadcn `Label`; everything else (cloneElement
 * threading, hint/error tone) stays here because shadcn doesn't ship
 * an auto-binding form wrapper at this granularity.
 */
export function Field({ label, hint, error, className, children }: FieldProps) {
  const generatedId = useId();
  const child = Children.only(children) as ReactElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }>;

  const inputId = (isValidElement(child) && child.props.id) || generatedId;
  const hintId = hint || error ? `${inputId}-hint` : undefined;

  const childWithProps = isValidElement(child)
    ? cloneElement(child, {
        id: inputId,
        "aria-describedby": hintId ?? child.props["aria-describedby"],
        "aria-invalid": error ? true : child.props["aria-invalid"],
      })
    : child;

  if (!label && !hint && !error) return <>{childWithProps}</>;

  return (
    <div className={className}>
      {label && (
        <Label
          htmlFor={inputId}
          className="mb-1.5 block text-xs leading-4 font-medium text-ddc-label"
        >
          {label}
        </Label>
      )}
      {childWithProps}
      {error ? (
        <p id={hintId} className="mt-1.5 text-xs leading-4 text-ddc-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1.5 text-xs leading-4 text-ddc-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
