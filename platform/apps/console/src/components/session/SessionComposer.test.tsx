import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionComposer } from "./SessionComposer";

describe("<SessionComposer />", () => {
  it("leaves the shared chat shell in charge of composer geometry", () => {
    render(
      <SessionComposer
        interrupting={false}
        onError={vi.fn()}
        onStop={vi.fn()}
        onSubmit={vi.fn()}
        running={false}
        sending={false}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Сообщение" }).closest("[data-chat-column]"))
      .toBeNull();
  });

  it("submits an idle draft from the single primary action", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(
      <SessionComposer
        interrupting={false}
        onError={vi.fn()}
        onStop={vi.fn()}
        onSubmit={onSubmit}
        running={false}
        sending={false}
      />,
    );

    const action = screen.getByRole("button", { name: "Отправить сообщение" });
    expect(action).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "Сообщение" }), "hello");
    expect(action).toBeEnabled();
    await user.click(action);

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ text: "hello" }),
        expect.anything(),
      ),
    );
  });

  it("keeps send semantics while a running session has a draft", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onStop = vi.fn();

    render(
      <SessionComposer
        interrupting={false}
        onError={vi.fn()}
        onStop={onStop}
        onSubmit={onSubmit}
        running
        sending={false}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Сообщение" }), "next");
    await user.click(screen.getByRole("button", { name: "Поставить сообщение в очередь" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onStop).not.toHaveBeenCalled();
  });

  it("turns the same action slot into stop when a running draft is empty", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();

    render(
      <SessionComposer
        interrupting={false}
        onError={vi.fn()}
        onStop={onStop}
        onSubmit={vi.fn()}
        running
        sending={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Отправить сообщение" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Остановить ответ" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("preserves the original image file when submitting an attachment", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:composer-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <SessionComposer
        interrupting={false}
        onError={vi.fn()}
        onStop={vi.fn()}
        onSubmit={onSubmit}
        running={false}
        sending={false}
      />,
    );

    const image = new File(["pixels"], "cat.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Загрузить файлы"), image);
    await user.click(screen.getByRole("button", { name: "Отправить сообщение" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const message = onSubmit.mock.calls[0]?.[0] as {
      files: Array<{ file?: File }>;
    };
    expect(message.files[0]?.file).toBe(image);
  });
});
