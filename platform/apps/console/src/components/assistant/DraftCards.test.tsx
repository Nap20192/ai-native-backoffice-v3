import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";

import { ModelCardDraftCard } from "./ModelCardDraftCard";

function Probe() {
  const location = useLocation();
  return (
    <div>
      <output data-testid="path">{location.pathname}</output>
      <output data-testid="state">{JSON.stringify(location.state)}</output>
    </div>
  );
}

function renderCard(ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={["/agents"]}>
      <Routes>
        <Route path="/agents" element={ui} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ModelCardDraftCard", () => {
  const body = {
    provider: "openai",
    model_id: "qwen3.6-35b",
    model: "Qwen/Qwen3.6-35B",
    api_key: "sk-live-should-not-render",
    base_url: "https://evil.example",
    custom_headers: { Authorization: "Bearer zzz" },
    is_default: true,
  };

  it("показывает поля черновика и не показывает ключ, адрес и заголовки", () => {
    renderCard(<ModelCardDraftCard body={body} />);
    expect(screen.getByText("Черновик карточки модели")).toBeInTheDocument();
    expect(screen.getByText("qwen3.6-35b")).toBeInTheDocument();
    expect(screen.getByText("Qwen/Qwen3.6-35B")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sk-live-should-not-render");
    expect(document.body.textContent).not.toContain("evil.example");
    expect(document.body.textContent).not.toContain("Bearer zzz");
    expect(screen.getByText(/Ключ API и адрес в черновик не входят/)).toBeInTheDocument();
  });

  it("«Открыть форму» ведёт на /model-cards с черновиком без секретных полей", async () => {
    const user = userEvent.setup();
    renderCard(<ModelCardDraftCard body={body} />);
    await user.click(screen.getByRole("button", { name: "Открыть форму" }));
    expect(screen.getByTestId("path").textContent).toBe("/model-cards");
    expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual({
      modelCardDraft: { provider: "openai", model_id: "qwen3.6-35b", model: "Qwen/Qwen3.6-35B", is_default: true },
    });
  });
});
