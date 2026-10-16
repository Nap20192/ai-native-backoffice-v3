import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PlainButton } from "@/components/ui/plain-button";
import { server } from "../../../mocks/server";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { useOutputFileViewer } from "./useOutputFileViewer";

function Harness({ name }: { name: string }) {
  const viewer = useOutputFileViewer("s1");
  return (
    <>
      <PlainButton onClick={() => viewer.openByName(name)}>открыть</PlainButton>
      {viewer.dialog}
    </>
  );
}

function outputs(data: unknown[] | "error") {
  server.use(
    http.get("*/v1/sessions/s1/outputs", () =>
      data === "error"
        ? HttpResponse.json({ error: { type: "api_error", message: "x" } }, { status: 500 })
        : HttpResponse.json({ data, has_more: false }),
    ),
    http.get("*/v1/sessions/s1/outputs/:name", () => new HttpResponse("# Итоги", { headers: { "content-type": "text/markdown" } })),
  );
}

beforeEach(() => {
  toast.error.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

describe("useOutputFileViewer: открыть файл по имени из ответа агента", () => {
  it("файл из списка сессии открывается в окне с размером из списка", async () => {
    outputs([{ filename: "итоги.md", size_bytes: 2_048 }]);
    render(<Harness name="итоги.md" />);

    await userEvent.click(screen.getByRole("button", { name: "открыть" }));

    const dialog = await screen.findByRole("dialog", { name: "итоги.md" });
    expect(dialog).toHaveTextContent("/mnt/session/outputs/итоги.md · 2,0 КБ");
    expect(await screen.findByText("# Итоги")).toBeInTheDocument();
  });

  it("если файла нет среди файлов сессии, говорит об этом и окно не открывает", async () => {
    outputs([{ filename: "другой.pdf", size_bytes: 10 }]);
    render(<Harness name="нет.pdf" />);

    await userEvent.click(screen.getByRole("button", { name: "открыть" }));

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Файл нет.pdf не найден среди файлов сессии. Если агент ещё работает, он появится после хода."),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("если список файлов не загрузился, сообщает об этом", async () => {
    outputs("error");
    render(<Harness name="итоги.md" />);

    await userEvent.click(screen.getByRole("button", { name: "открыть" }));

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("Список файлов сессии не загрузился. Повторите попытку."));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("useOutputFileViewer: ответы приходят не по порядку", () => {
  function Two() {
    const viewer = useOutputFileViewer("s1");
    return (
      <>
        <PlainButton onClick={() => viewer.openByName("a.md")}>открыть a</PlainButton>
        <PlainButton onClick={() => viewer.openByName("b.md")}>открыть b</PlainButton>
        {viewer.dialog}
      </>
    );
  }

  // Первый запрос списка отвечает через 300 мс, остальные сразу.
  function slowFirstList() {
    let calls = 0;
    server.use(
      http.get("*/v1/sessions/s1/outputs", async () => {
        calls += 1;
        if (calls === 1) await delay(300);
        return HttpResponse.json({
          data: [
            { filename: "a.md", size_bytes: 10 },
            { filename: "b.md", size_bytes: 10 },
          ],
          has_more: false,
        });
      }),
      http.get("*/v1/sessions/s1/outputs/:name", () => new HttpResponse("текст", { headers: { "content-type": "text/markdown" } })),
    );
  }

  it("поздний ответ на первую ссылку не подменяет открытый файл", async () => {
    slowFirstList();
    render(<Two />);

    await userEvent.click(screen.getByRole("button", { name: "открыть a" }));
    await userEvent.click(screen.getByRole("button", { name: "открыть b" }));

    expect(await screen.findByRole("dialog", { name: "b.md" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByRole("dialog", { name: "b.md" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "a.md" })).toBeNull();
  });

  it("закрытое окно не открывается снова поздним ответом", async () => {
    slowFirstList();
    render(<Two />);

    await userEvent.click(screen.getByRole("button", { name: "открыть a" }));
    await userEvent.click(screen.getByRole("button", { name: "открыть b" }));
    await screen.findByRole("dialog", { name: "b.md" });
    await userEvent.keyboard("{Escape}");

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
