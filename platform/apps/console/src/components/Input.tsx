import { useState, type InputHTMLAttributes, type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EyeIcon, EyeOffIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { Field } from "./Field";

type CommonProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className"
> & {
  className?: string;
  /** Wrap with a labelled <div> if provided. Saves callsites the
   *  boilerplate of label + helper-text composition. The label is
   *  programmatically associated with the input via `htmlFor`/`id` so
   *  screen readers announce them as a pair and clicking the label
   *  focuses the input. */
  label?: ReactNode;
  hint?: ReactNode;
};

/**
 * Plain text input. Defaults `autoComplete="off"` to prevent the browser
 * from offering saved credentials in non-login contexts (persona names,
 * agent ids, paths…). Add a specific `autoComplete` token (e.g. "email"
 * or "username") at the call site if a real autofill is wanted.
 *
 * Built on shadcn `Input` (40px, DDC `.input`); the 1Password / LastPass
 * opt-out attrs live here so every caller gets them automatically.
 */
export function TextInput({
  className,
  label,
  hint,
  autoComplete,
  ...rest
}: CommonProps) {
  const input = (
    <Input
      type="text"
      autoComplete={autoComplete ?? "off"}
      data-1p-ignore
      data-lpignore="true"
      className={className}
      {...rest}
    />
  );
  if (!label && !hint) return input;
  return (
    <Field label={label} hint={hint}>
      {input}
    </Field>
  );
}

/**
 * Secret input — for API keys, tokens, signing secrets, client secrets,
 * webhook secrets, anything sensitive. Renders masked by default with a
 * right-side eye toggle so the user can verify the paste landed in the
 * right field (Stripe / Vercel / GitHub PAT pattern). Always sets
 * `autoComplete="new-password"` (the only reliable way to disable
 * Chrome's saved-password autofill — `off` is ignored on type=password)
 * plus 1Password / LastPass opt-out attrs.
 *
 * Use this in any "paste a credential" UI — never `<Input type="password">`
 * directly, otherwise the browser autofills the user's iCloud/Google
 * password into a place it doesn't belong, AND the user has to paste
 * blind into a row of dot-fields.
 */
export function SecretInput({
  className,
  label,
  hint,
  ...rest
}: CommonProps) {
  const [revealed, setRevealed] = useState(false);
  const input = (
    <div className="relative">
      <Input
        type={revealed ? "text" : "password"}
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        className={cn("pr-11", className)}
        {...rest}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setRevealed((r) => !r)}
        className="absolute inset-y-0 right-1.5 my-auto text-ddc-icon-muted hover:text-ddc-text"
        title={revealed ? "Скрыть" : "Показать"}
        aria-label={revealed ? "Скрыть секрет" : "Показать секрет"}
      >
        {revealed ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
    </div>
  );
  if (!label && !hint) return input;
  return (
    <Field label={label} hint={hint}>
      {input}
    </Field>
  );
}
