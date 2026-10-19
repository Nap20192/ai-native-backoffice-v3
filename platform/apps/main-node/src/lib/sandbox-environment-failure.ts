// The text of a `session.error` for a sandbox that could not boot its VM
// (docs/plans/environment-programs.md, slice П5). The console shows the
// message to the user as is, so the failed package install reads in
// Russian with the manager, the exit code and the end of the install
// output. The wire type stays `unknown_error`: the error types of the API
// follow Claude Managed Agents. `image_unavailable` already carries a
// Russian message from the catalog (sandbox-environment-image.ts);
// `image_changed_on_disk` comes from the LiteBox adapter in English, so it
// is translated here.

import {
  isSandboxEnvironmentError,
  type SandboxEnvironmentError,
} from "@open-managed-agents/sandbox";

function packagesFailedMessage(error: SandboxEnvironmentError): string {
  const failure = error.packages;
  const facts = [
    failure?.manager ?? null,
    failure?.exitCode === null || failure?.exitCode === undefined ? null : `код ${failure.exitCode}`,
  ].filter((fact): fact is string => fact !== null);
  const head = facts.length > 0
    ? `Пакеты окружения не поставились: ${facts.join(", ")}.`
    : "Пакеты окружения не поставились.";
  const tail = failure?.outputTail.trim() ?? "";
  return `${head} Поправьте список пакетов окружения и отправьте сообщение снова.` +
    (tail.length > 0 ? ` Конец вывода установки:\n${tail}` : "");
}

function imageChangedMessage(error: SandboxEnvironmentError): string {
  const key = /sandbox image "([^"]+)"/.exec(error.message)?.[1];
  const image = key ? `Образ окружения «${key}»` : "Образ окружения";
  return `${image} изменился на диске после проверки каталога, поэтому машина не запустилась. ` +
    "Пересоберите каталог образов и перезапустите сервер.";
}

/** The `message` of a `session.error` for a failed turn or start. */
export function sessionErrorMessage(error: unknown): string {
  if (isSandboxEnvironmentError(error) && error.code === "packages_failed") {
    return packagesFailedMessage(error);
  }
  if (isSandboxEnvironmentError(error) && error.code === "image_changed_on_disk") {
    return imageChangedMessage(error);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The sandbox with its calls watched for a {@link SandboxEnvironmentError}.
 * The caller still gets every result and every rejection as is; synchronous
 * results (`environmentSnapshot`) pass through untouched.
 */
export function watchEnvironmentFailure<T extends object>(
  sandbox: T,
  onFailure: (error: SandboxEnvironmentError) => void,
): T {
  return new Proxy(sandbox, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = (value as (...input: unknown[]) => unknown).apply(target, args);
        if (isThenable(result)) {
          result.then(undefined, (error: unknown) => {
            if (isSandboxEnvironmentError(error)) onFailure(error);
          });
        }
        return result;
      };
    },
  });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}
