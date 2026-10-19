// The session.error text for a sandbox that could not boot its VM
// (docs/plans/environment-programs.md, slice П5). The console shows it to
// the user as is, so every environment error reads in Russian.

import { describe, expect, it } from "vitest";

import { SandboxEnvironmentError } from "@open-managed-agents/sandbox";

import { sessionErrorMessage } from "../src/lib/sandbox-environment-failure";

describe("sessionErrorMessage", () => {
  it("explains in Russian an image that changed on disk after the catalog checked it", () => {
    const error = new SandboxEnvironmentError(
      "image_changed_on_disk",
      'sandbox image "workplace-office-2026.10.1" changed on disk after the catalog checked it: index.json ' +
      `points to sha256:${"ab".repeat(32)}, the catalog verified sha256:${"cd".repeat(32)}. ` +
      "The VM was not created (image_changed_on_disk).",
    );
    expect(sessionErrorMessage(error)).toBe(
      "Образ окружения «workplace-office-2026.10.1» изменился на диске после проверки каталога, " +
      "поэтому машина не запустилась. Пересоберите каталог образов и перезапустите сервер.",
    );
  });

  it("keeps the Russian text of an image the catalog does not have", () => {
    const error = new SandboxEnvironmentError("image_unavailable", "Образ песочницы «x» не найден в каталоге образов");
    expect(sessionErrorMessage(error)).toBe("Образ песочницы «x» не найден в каталоге образов");
  });

  it("passes any other error through", () => {
    expect(sessionErrorMessage(new Error("boom"))).toBe("boom");
    expect(sessionErrorMessage("plain")).toBe("plain");
  });
});
