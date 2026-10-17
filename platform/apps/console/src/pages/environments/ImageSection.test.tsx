import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  catalogWithUnbuiltOffice,
  LEGACY_DIGEST,
  OFFICE_DIGEST,
  sandboxCatalogFixture,
  WORKPLACE_DIGEST,
} from "../../test/sandbox-catalog-fixture";
import { ImageSection } from "./ImageSection";

beforeAll(() => {
  // Radix Select трогает API, которых в jsdom нет.
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

type Props = React.ComponentProps<typeof ImageSection>;

function show(props: Partial<Props> = {}) {
  const onChange = vi.fn();
  const view = render(
    <ImageSection
      catalog={sandboxCatalogFixture()}
      value="workplace"
      onChange={onChange}
      networking={{ type: "unrestricted" }}
      {...props}
    />,
  );
  return { onChange, ...view };
}

describe("ImageSection", () => {
  it("рисует раздел «Образ» с выбранным образом из каталога", () => {
    show();

    expect(screen.getByRole("heading", { level: 2, name: "Образ" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Образ" })).toHaveTextContent("Рабочее место агента");
  });

  it("показывает рядом короткий дайджест, полный лежит в подсказке", () => {
    show();

    const digest = screen.getByText("sha256:3fdbc2…");
    expect(digest).toHaveAttribute("title", WORKPLACE_DIGEST);
    expect(digest).toHaveClass("font-mono");
  });

  it("копирует полный дайджест кнопкой рядом", async () => {
    const user = userEvent.setup();
    show();

    await user.click(screen.getByRole("button", { name: "Копировать дайджест" }));

    expect(await navigator.clipboard.readText()).toBe(WORKPLACE_DIGEST);
  });

  it("пишет, сколько ресурсов получит песочница", () => {
    show();

    expect(screen.getByText("Ресурсы песочницы: 2 CPU, 1 ГиБ памяти, диск 6 ГБ.")).toBeInTheDocument();
  });

  it("даёт подсказку про самостоятельную установку через pip и закрепление в «Пакетах»", () => {
    show();

    expect(
      screen.getByText(
        "Агент может сам ставить пакеты через pip. Они живут только в этой сессии. " +
          "Чтобы закрепить пакет, добавьте его в раздел «Пакеты».",
      ),
    ).toBeInTheDocument();
  });

  it("меняет подсказку, когда сеть окружения закрыта для реестров", () => {
    show({ networking: { type: "limited", allow_package_managers: false } });

    expect(screen.getByText(/закрывает реестры пакетов/)).toBeInTheDocument();
    expect(screen.queryByText(/через pip/)).not.toBeInTheDocument();
  });

  it("прячет состав образа, пока его не раскроют", async () => {
    const user = userEvent.setup();
    show();

    const toggle = screen.getByRole("button", { name: "Что есть в образе" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Python 3.11.2, 46 библиотек");
    expect(screen.queryByText("python-pptx")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("python-pptx")).toBeInTheDocument();
  });

  it("раскрывает состав группами: система, Python, Node, утилиты, шрифты", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: /Что есть в образе/ }));

    const group = (name: string) => screen.getByRole("group", { name });

    const system = group("Система");
    expect(within(system).getByText("Debian GNU/Linux 12 (bookworm), x86_64")).toBeInTheDocument();
    expect(within(system).getByText("Пользователь root, оболочка bash")).toBeInTheDocument();
    expect(within(system).getByText("Менеджеры пакетов: apt, npm, pip, uv")).toBeInTheDocument();

    const python = group("Python и библиотеки");
    expect(within(python).getByText("Python 3.11.2, виртуальное окружение /opt/venv")).toBeInTheDocument();
    expect(within(python).getByText("python-pptx").closest("li")).toHaveTextContent("python-pptx 1.0.2");
    expect(within(python).getByText("pandas").closest("li")).toHaveTextContent("pandas 2.2.3");
    expect(within(python).getAllByRole("listitem")).toHaveLength(46);

    const node = group("Node");
    expect(within(node).getByText("Node 22.23.3, npm 10.9.9")).toBeInTheDocument();

    const utilities = group("Утилиты");
    expect(within(utilities).getByText("jq").closest("li")).toHaveTextContent("jq 1.6");
    expect(within(utilities).queryByText(/LibreOffice/)).not.toBeInTheDocument();

    const fonts = group("Шрифты с кириллицей");
    expect(within(fonts).getByText("Carlito")).toBeInTheDocument();
    expect(within(fonts).getByText("PT Sans Narrow")).toBeInTheDocument();
  });

  it("у образа с LibreOffice показывает его среди утилит", async () => {
    const user = userEvent.setup();
    show({ value: "workplace-office" });
    await user.click(screen.getByRole("button", { name: /Что есть в образе/ }));

    const utilities = screen.getByRole("group", { name: "Утилиты" });
    expect(within(utilities).getByText("LibreOffice (soffice)").closest("li")).toHaveTextContent(
      "LibreOffice (soffice) 7.4.7",
    );
    expect(screen.getByText("sha256:032d84…")).toHaveAttribute("title", OFFICE_DIGEST);
  });

  it("меняет образ по выбору в списке", async () => {
    const user = userEvent.setup();
    const { onChange } = show();

    await user.click(screen.getByRole("combobox", { name: "Образ" }));
    await user.click(await screen.findByRole("option", { name: "Рабочее место с LibreOffice" }));

    expect(onChange).toHaveBeenCalledWith("workplace-office");
  });

  it("предлагает образ по умолчанию и отдаёт для него null", async () => {
    const user = userEvent.setup();
    const { onChange } = show();

    await user.click(screen.getByRole("combobox", { name: "Образ" }));
    await user.click(await screen.findByRole("option", { name: "По умолчанию: Node 22, прежний образ" }));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("у окружения без образа показывает образ по умолчанию и его дайджест", () => {
    show({ value: null });

    expect(screen.getByRole("combobox", { name: "Образ" })).toHaveTextContent(
      "По умолчанию: Node 22, прежний образ",
    );
    expect(screen.getByText("sha256:0e5f90…")).toHaveAttribute("title", LEGACY_DIGEST);
    expect(screen.getByText("Ресурсы песочницы: 1 CPU, 512 МиБ памяти, диск 4 ГБ.")).toBeInTheDocument();
  });

  it("у прежнего образа предупреждает, что в нём нет pip", () => {
    show({ value: "legacy" });

    expect(screen.getByText(/В этом образе нет pip/)).toBeInTheDocument();
    expect(screen.queryByText(/через pip\./)).not.toBeInTheDocument();
  });

  it("не даёт выбрать образ, который не собран", async () => {
    const user = userEvent.setup();
    const { onChange } = show({ catalog: catalogWithUnbuiltOffice() });

    await user.click(screen.getByRole("combobox", { name: "Образ" }));
    const option = await screen.findByRole("option", { name: "Рабочее место с LibreOffice (не собран)" });
    expect(option).toHaveAttribute("aria-disabled", "true");
    await user.click(option);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("предупреждает, когда выбранный образ не собран, и называет причину", () => {
    show({ catalog: catalogWithUnbuiltOffice(), value: "workplace-office" });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Образ не собран: Каталог образа workplace-office-2026.10.1 не найден.");
    expect(alert).toHaveTextContent("Сессии на нём не запустятся.");
    expect(screen.queryByText(/sha256:/)).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Образ" })).toHaveTextContent(
      "Рабочее место с LibreOffice",
    );
  });

  it("предупреждает про образ, которого нет в каталоге сервера, но оставляет его в списке", () => {
    show({ value: "ghost" });

    expect(screen.getByRole("combobox", { name: "Образ" })).toHaveTextContent("ghost (нет в каталоге)");
    expect(screen.getByRole("alert")).toHaveTextContent("Образа «ghost» нет в каталоге сервера.");
  });

  it("не рисует ничего без каталога, если у окружения образ по умолчанию", () => {
    const { container } = show({ catalog: null, value: null });

    expect(container).toBeEmptyDOMElement();
  });

  it("без каталога показывает заданный образ и обещает не менять его", () => {
    show({ catalog: null, value: "workplace" });

    expect(screen.getByRole("heading", { level: 2, name: "Образ" })).toBeInTheDocument();
    expect(screen.getByText("workplace")).toBeInTheDocument();
    expect(screen.getByText(/Каталог образов сервера недоступен/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("пока каталог грузится, показывает заглушку", () => {
    show({ catalog: null, loading: true });

    expect(screen.getByRole("status")).toHaveTextContent("Загружаем образы");
    expect(screen.getByRole("heading", { level: 2, name: "Образ" })).toBeInTheDocument();
  });

  it("выключает список, пока окружение сохраняется", () => {
    show({ disabled: true });

    expect(screen.getByRole("combobox", { name: "Образ" })).toBeDisabled();
  });

  it("пишет, что состав образа не описан, когда манифеста нет", async () => {
    const user = userEvent.setup();
    const catalog = sandboxCatalogFixture();
    catalog.images = catalog.images.map((image) => (image.key === "workplace" ? { ...image, manifest: null } : image));
    show({ catalog });

    await user.click(screen.getByRole("button", { name: /Что есть в образе/ }));

    expect(screen.getByText("У образа нет манифеста, поэтому состав неизвестен.")).toBeInTheDocument();
  });
});
