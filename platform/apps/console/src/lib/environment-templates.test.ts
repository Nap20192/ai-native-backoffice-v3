import { describe, expect, it } from "vitest";

import {
  catalogWithUnbuiltOffice,
  sandboxCatalogFixture,
} from "../test/sandbox-catalog-fixture";
import {
  catalogTemplates,
  describeNetworking,
  describePackages,
  EMPTY_TEMPLATE_ID,
  fallbackTemplates,
  pickTemplate,
  templateLabel,
  templatesFor,
} from "./environment-templates";

const LIMITED = {
  type: "limited" as const,
  allow_mcp_servers: true,
  allow_package_managers: true,
  allow_web_search: false,
  allowed_hosts: [],
};

describe("шаблоны из кода (сервер без каталога образов)", () => {
  it("оставляют «Пустое» и «Документы» как до каталога", () => {
    const templates = fallbackTemplates();

    expect(templates.map((template) => [template.id, template.label])).toEqual([
      ["empty", "Пустое"],
      ["documents", "Документы"],
    ]);
    expect(templates.every((template) => template.available)).toBe(true);
  });

  it("«Пустое» создаёт окружение без сети, образа и пакетов", () => {
    const empty = fallbackTemplates()[0]!;

    expect(empty.id).toBe(EMPTY_TEMPLATE_ID);
    expect(empty.fields).toEqual({ config: { type: "cloud" } });
    expect(empty.fields.metadata).toBeUndefined();
  });

  it("«Документы» ставит apt и pip пакеты и пишет метку шаблона", () => {
    const documents = fallbackTemplates()[1]!;

    expect(documents.fields).toEqual({
      config: {
        type: "cloud",
        packages: {
          type: "packages",
          apt: ["python3-pip", "fonts-dejavu-core"],
          pip: ["python-docx", "openpyxl", "python-pptx", "pypdf", "reportlab", "pdfplumber"],
        },
      },
      metadata: { oma_template: "documents" },
    });
    expect(documents.details.packages).toBe(
      "apt: python3-pip, fonts-dejavu-core; pip: python-docx, openpyxl, python-pptx, pypdf, reportlab, pdfplumber",
    );
  });

  it("не придумывают образ и чипы, пока каталога нет", () => {
    for (const template of fallbackTemplates()) {
      expect(template.imageLabel).toBeNull();
      expect(template.details.image).toBeNull();
    }
  });

  it("каждый вызов отдаёт свои массивы, правка не портит шаблон", () => {
    const first = fallbackTemplates()[1]!;
    first.fields.config.packages?.apt.push("лишний");

    expect(fallbackTemplates()[1]!.fields.config.packages?.apt).toEqual([
      "python3-pip",
      "fonts-dejavu-core",
    ]);
  });
});

describe("шаблоны из каталога сервера", () => {
  it("ставят «Пустое» первым, затем шаблоны каталога в его порядке", () => {
    const templates = catalogTemplates(sandboxCatalogFixture());

    expect(templates.map((template) => template.id)).toEqual([
      "empty",
      "basic",
      "documents",
      "data",
      "web",
    ]);
    expect(templates.map((template) => template.label)).toEqual([
      "Пустое",
      "Базовое",
      "Документы и офис",
      "Данные",
      "Веб",
    ]);
  });

  it("«Пустое» остаётся прежним: без образа, сети и пакетов", () => {
    const empty = catalogTemplates(sandboxCatalogFixture())[0]!;

    expect(empty.fields).toEqual({ config: { type: "cloud" } });
    expect(empty.details).toEqual({
      image: "По умолчанию: Node 22, прежний образ",
      network: "Без ограничений",
      packages: null,
    });
  });

  it("отдаёт в запрос создания config и metadata шаблона как пришли с сервера", () => {
    const catalog = sandboxCatalogFixture();
    const data = catalogTemplates(catalog).find((template) => template.id === "data")!;

    expect(data.fields).toEqual({
      config: catalog.templates[2]!.config,
      metadata: { oma_template: "data" },
    });
    expect(data.fields.config).not.toBe(catalog.templates[2]!.config);
  });

  it("ставит на карточку чипы образа и сети", () => {
    const byId = new Map(catalogTemplates(sandboxCatalogFixture()).map((template) => [template.id, template]));

    expect(byId.get("basic")).toMatchObject({
      imageLabel: "Рабочее место агента",
      networkLabel: "Ограниченный",
    });
    expect(byId.get("documents")).toMatchObject({ imageLabel: "LibreOffice", networkLabel: "Ограниченный" });
    expect(byId.get("web")).toMatchObject({
      imageLabel: "Рабочее место агента",
      networkLabel: "Без ограничений",
    });
  });

  it("пишет в сводку полное название образа, сеть и пакеты", () => {
    const byId = new Map(catalogTemplates(sandboxCatalogFixture()).map((template) => [template.id, template]));

    expect(byId.get("documents")?.details).toEqual({
      image: "Рабочее место с LibreOffice",
      network: "Ограниченный: менеджеры пакетов и MCP-серверы",
      packages: null,
    });
    expect(byId.get("data")?.details.packages).toBe("pip: duckdb, pyarrow, scipy");
    expect(byId.get("web")?.details).toEqual({
      image: "Рабочее место агента",
      network: "Без ограничений",
      packages: "pip: markdownify, feedparser",
    });
  });

  it("берёт назначение шаблона из каталога, а без него из текста консоли", () => {
    const catalog = sandboxCatalogFixture();
    catalog.templates[0] = { ...catalog.templates[0]!, description: "Свой текст оператора" };
    catalog.templates.push({ ...catalog.templates[3]!, id: "custom", label: "Своё", description: null });

    const byId = new Map(catalogTemplates(catalog).map((template) => [template.id, template]));

    expect(byId.get("basic")?.hint).toBe("Свой текст оператора");
    expect(byId.get("documents")?.hint).toBe(
      "Презентации, Word, Excel и PDF. Конвертация и проверка результата картинкой.",
    );
    expect(byId.get("custom")?.hint).toBe("");
  });

  it("выключает шаблон, у которого образ не собран, и называет причину", () => {
    const byId = new Map(catalogTemplates(catalogWithUnbuiltOffice()).map((template) => [template.id, template]));

    expect(byId.get("documents")).toMatchObject({
      available: false,
      unavailableReason: "Образ не собран",
    });
    expect(byId.get("basic")).toMatchObject({ available: true, unavailableReason: null });
    expect(byId.get("empty")?.available).toBe(true);
  });

  it("показывает чип с названием образа, если состава у образа нет", () => {
    const documents = catalogTemplates(catalogWithUnbuiltOffice()).find((template) => template.id === "documents")!;

    expect(documents.imageLabel).toBe("Рабочее место с LibreOffice");
  });

  it("называет образ по ключу, если шаблон ссылается на образ, которого в каталоге нет", () => {
    const catalog = sandboxCatalogFixture();
    catalog.images = catalog.images.filter((image) => image.key !== "workplace");

    const basic = catalogTemplates(catalog).find((template) => template.id === "basic")!;

    expect(basic.imageLabel).toBe("workplace");
    expect(basic.details.image).toBe("workplace");
  });

  it("берёт каталог без шаблонов: остаётся одно «Пустое»", () => {
    const catalog = { ...sandboxCatalogFixture(), templates: [] };

    expect(catalogTemplates(catalog).map((template) => template.id)).toEqual(["empty"]);
  });
});

describe("templatesFor", () => {
  it("до ответа сервера отдаёт одно «Пустое»", () => {
    expect(templatesFor({ catalog: null, isLoading: true }).map((template) => template.id)).toEqual(["empty"]);
  });

  it("с каталогом берёт шаблоны каталога", () => {
    const templates = templatesFor({ catalog: sandboxCatalogFixture(), isLoading: false });

    expect(templates.map((template) => template.id)).toEqual(["empty", "basic", "documents", "data", "web"]);
  });

  it("без каталога возвращается к шаблонам из кода", () => {
    const templates = templatesFor({ catalog: null, isLoading: false });

    expect(templates.map((template) => template.id)).toEqual(["empty", "documents"]);
  });
});

describe("pickTemplate", () => {
  it("находит шаблон по ключу", () => {
    const templates = catalogTemplates(sandboxCatalogFixture());

    expect(pickTemplate(templates, "data").id).toBe("data");
  });

  it("берёт первый, если нужного шаблона в списке нет", () => {
    const templates = catalogTemplates(sandboxCatalogFixture());

    expect(pickTemplate(templates, "исчез").id).toBe("empty");
  });
});

describe("templateLabel", () => {
  it("берёт название из каталога", () => {
    expect(templateLabel("documents", sandboxCatalogFixture())).toBe("Документы и офис");
  });

  it("без каталога знает шаблоны консоли", () => {
    expect(templateLabel("documents", null)).toBe("Документы");
    expect(templateLabel("basic", null)).toBe("Базовое");
    expect(templateLabel("data", null)).toBe("Данные");
    expect(templateLabel("web", null)).toBe("Веб");
  });

  it("неизвестный шаблон показывает по ключу", () => {
    expect(templateLabel("custom-x", sandboxCatalogFixture())).toBe("custom-x");
  });
});

describe("describeNetworking", () => {
  it("называет сеть без ограничений", () => {
    expect(describeNetworking({ type: "unrestricted" })).toBe("Без ограничений");
  });

  it("перечисляет, что разрешено в ограниченной сети", () => {
    expect(describeNetworking(LIMITED)).toBe("Ограниченный: менеджеры пакетов и MCP-серверы");
  });

  it("считает хосты и веб-поиск", () => {
    expect(
      describeNetworking({
        ...LIMITED,
        allowed_hosts: ["api.example.com", "files.example.com"],
        allow_web_search: true,
      }),
    ).toBe("Ограниченный: менеджеры пакетов, MCP-серверы, 2 хоста и веб-поиск");
  });

  it("склоняет число хостов", () => {
    expect(
      describeNetworking({ ...LIMITED, allow_mcp_servers: false, allow_package_managers: false, allowed_hosts: ["a.example.com"] }),
    ).toBe("Ограниченный: 1 хост");
    expect(
      describeNetworking({
        ...LIMITED,
        allow_mcp_servers: false,
        allow_package_managers: false,
        allowed_hosts: ["a", "b", "c", "d", "e"].map((name) => `${name}.example.com`),
      }),
    ).toBe("Ограниченный: 5 хостов");
  });

  it("говорит прямо, когда ничего не разрешено", () => {
    expect(
      describeNetworking({ ...LIMITED, allow_mcp_servers: false, allow_package_managers: false }),
    ).toBe("Ограниченный: внешние хосты закрыты");
  });
});

describe("describePackages", () => {
  it("перечисляет менеджеры по порядку apt, pip, npm", () => {
    expect(describePackages({ apt: ["figlet"], npm: ["cowsay"], pip: ["rich", "tomli-w"] })).toBe(
      "apt: figlet; pip: rich, tomli-w; npm: cowsay",
    );
  });

  it("отдаёт null, когда пакетов нет", () => {
    expect(describePackages({ apt: [], npm: [], pip: [] })).toBeNull();
    expect(describePackages(undefined)).toBeNull();
  });
});
