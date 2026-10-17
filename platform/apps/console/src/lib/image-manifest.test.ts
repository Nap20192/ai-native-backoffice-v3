import { describe, expect, it } from "vitest";

import { legacyManifest, officeManifest, workplaceManifest } from "../test/sandbox-catalog-fixture";
import {
  contentsSummary,
  describeImageManifest,
  describeResources,
  installHint,
  upstreamVersion,
} from "./image-manifest";

describe("describeImageManifest", () => {
  it("описывает образ «Рабочее место агента» по манифесту сборки", () => {
    const contents = describeImageManifest(workplaceManifest());

    expect(contents).not.toBeNull();
    expect(contents?.system).toBe("Debian GNU/Linux 12 (bookworm), x86_64");
    expect(contents?.user).toBe("root");
    expect(contents?.shell).toBe("bash");
    expect(contents?.packageManagers).toEqual(["apt", "npm", "pip", "uv"]);
    expect(contents?.python).toMatchObject({ version: "3.11.2", venv: "/opt/venv", hasPip: true, uv: "0.9.4" });
    expect(contents?.node).toEqual({ version: "22.23.3", npm: "10.9.9" });
  });

  it("собирает библиотеки Python по алфавиту без учёта регистра", () => {
    const libraries = describeImageManifest(workplaceManifest())?.python.libraries ?? [];
    const names = libraries.map((library) => library.name);

    expect(libraries).toHaveLength(46);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
    expect(libraries).toContainEqual({ name: "python-pptx", version: "1.0.2" });
    expect(libraries).toContainEqual({ name: "XlsxWriter", version: "3.2.0" });
  });

  it("выбирает из списка dpkg только известные утилиты и даёт им версию без эпохи и ревизии Debian", () => {
    const utilities = describeImageManifest(workplaceManifest())?.utilities ?? [];
    const byLabel = new Map(utilities.map((utility) => [utility.label, utility.version]));

    expect(byLabel.get("git")).toBe("2.39.5");
    expect(byLabel.get("jq")).toBe("1.6");
    expect(byLabel.get("ripgrep")).toBe("13.0.0");
    expect(byLabel.get("poppler (pdftotext, pdftoppm)")).toBe("22.12.0");
    expect(byLabel.get("tesseract (eng, rus)")).toBe("5.3.0");
    expect(byLabel.get("gcc и g++")).toBe("12.2.0");
    // Посторонние пакеты Debian в список не попадают.
    expect(utilities.some((utility) => /adduser|libc6|zlib1g/.test(utility.label))).toBe(false);
    // LibreOffice в этом образе нет.
    expect(utilities.some((utility) => utility.label.startsWith("LibreOffice"))).toBe(false);
  });

  it("ставит LibreOffice первым в образе с офисом", () => {
    const utilities = describeImageManifest(officeManifest())?.utilities ?? [];

    expect(utilities[0]).toEqual({ label: "LibreOffice (soffice)", version: "7.4.7" });
  });

  it("даёт шрифты с кириллицей без повторов и по алфавиту", () => {
    const fonts = describeImageManifest(workplaceManifest())?.fonts ?? [];

    expect(fonts).toEqual([
      "Carlito",
      "DejaVu Sans",
      "DejaVu Sans Mono",
      "DejaVu Serif",
      "Liberation Mono",
      "Liberation Sans",
      "Liberation Serif",
      "PT Mono",
      "PT Sans",
      "PT Sans Caption",
      "PT Sans Narrow",
      "PT Serif",
      "PT Serif Caption",
    ]);
  });

  it("сортирует библиотеки, даже если манифест их перемешал", () => {
    const contents = describeImageManifest({
      pip: [
        { name: "zeta", version: "1" },
        { name: "Alpha", version: "2" },
        { name: "beta", version: "3" },
        { name: "beta", version: "3" },
      ],
    });

    expect(contents?.python.libraries.map((library) => library.name)).toEqual(["Alpha", "beta", "zeta"]);
  });

  it("берёт первое имя семейства, когда fc-list отдал несколько через запятую", () => {
    const contents = describeImageManifest({
      fonts: ["DejaVu Sans,DejaVu Sans Condensed\t/usr/share/fonts/dejavu/DejaVuSans.ttf"],
    });

    expect(contents?.fonts).toEqual(["DejaVu Sans"]);
  });

  it("показывает у прежнего образа Python без pip и без библиотек", () => {
    const contents = describeImageManifest(legacyManifest());

    expect(contents?.python).toMatchObject({ version: "3.11.2", venv: null, hasPip: false, uv: null });
    expect(contents?.python.libraries).toEqual([]);
    expect(contents?.packageManagers).toEqual(["apt", "npm"]);
    expect(contents?.utilities.map((utility) => utility.label)).toEqual([
      "git",
      "curl",
      "wget",
      "fontconfig",
      "file",
      "unzip",
      "procps",
      "make",
      "gcc и g++",
    ]);
    expect(contents?.fonts).toEqual(["DejaVu Sans", "DejaVu Sans Mono", "DejaVu Serif"]);
  });

  it("не падает на неполном манифесте и отдаёт пустые части", () => {
    const contents = describeImageManifest({ schema_version: 1 });

    expect(contents).toMatchObject({
      system: null,
      user: null,
      shell: null,
      packageManagers: [],
      node: null,
      utilities: [],
      fonts: [],
    });
    expect(contents?.python).toMatchObject({ version: null, venv: null, hasPip: false, libraries: [] });
  });

  it("пропускает записи неверного вида в pip, dpkg и шрифтах", () => {
    const contents = describeImageManifest({
      pip: [{ name: "ok", version: "1" }, { name: 3 }, "строка", null, { version: "2" }],
      dpkg: [{ name: "git", version: "1:2.39.5-0" }, { name: 7 }, null],
      fonts: ["Carlito\t/x.ttf", 5, null, ""],
    });

    expect(contents?.python.libraries).toEqual([{ name: "ok", version: "1" }]);
    expect(contents?.utilities).toEqual([{ label: "git", version: "2.39.5" }]);
    expect(contents?.fonts).toEqual(["Carlito"]);
  });

  it.each([null, undefined, "строка", 7, []])("возвращает null для %j", (value) => {
    expect(describeImageManifest(value)).toBeNull();
  });
});

describe("upstreamVersion", () => {
  it.each([
    ["1:2.39.5-0+deb12u3", "2.39.5"],
    ["1.6-2.1+deb12u2", "1.6"],
    ["7.88.1-10+deb12u15", "7.88.1"],
    ["4:12.2.0-3", "12.2.0"],
    ["4.3-4.1", "4.3"],
    ["2.14.1-4", "2.14.1"],
    ["1.2.3", "1.2.3"],
  ])("%s даёт %s", (debian, expected) => {
    expect(upstreamVersion(debian)).toBe(expected);
  });
});

describe("contentsSummary", () => {
  it("называет Python и число библиотек", () => {
    const contents = describeImageManifest(workplaceManifest());
    expect(contents && contentsSummary(contents)).toBe("Python 3.11.2, 46 библиотек");
  });

  it("склоняет число библиотек", () => {
    const one = describeImageManifest({ python_version: "3.12.0", pip: [{ name: "a", version: "1" }] });
    const two = describeImageManifest({
      python_version: "3.12.0",
      pip: [
        { name: "a", version: "1" },
        { name: "b", version: "1" },
      ],
    });
    expect(one && contentsSummary(one)).toBe("Python 3.12.0, 1 библиотека");
    expect(two && contentsSummary(two)).toBe("Python 3.12.0, 2 библиотеки");
  });

  it("у образа без библиотек пишет про одну версию Python", () => {
    const contents = describeImageManifest(legacyManifest());
    expect(contents && contentsSummary(contents)).toBe("Python 3.11.2 без pip");
  });

  it("у пустого манифеста отдаёт пустую строку", () => {
    const contents = describeImageManifest({});
    expect(contents && contentsSummary(contents)).toBe("");
  });
});

describe("describeResources", () => {
  it("пишет процессоры, память и диск", () => {
    expect(describeResources({ disk_gb: 6, memory_mib: 1024, cpus: 2 })).toBe(
      "2 CPU, 1 ГиБ памяти, диск 6 ГБ",
    );
  });

  it("считает память меньше гибибайта в мебибайтах", () => {
    expect(describeResources({ disk_gb: 4, memory_mib: 512, cpus: 1 })).toBe(
      "1 CPU, 512 МиБ памяти, диск 4 ГБ",
    );
  });

  it("пропускает то, чего каталог не задал", () => {
    expect(describeResources({ disk_gb: null, memory_mib: 2048, cpus: null })).toBe("2 ГиБ памяти");
    expect(describeResources({ disk_gb: null, memory_mib: null, cpus: null })).toBeNull();
  });
});

describe("installHint", () => {
  const open = { type: "unrestricted" as const };
  const registries = { type: "limited" as const, allow_package_managers: true };
  const closed = { type: "limited" as const, allow_package_managers: false };

  it("говорит про pip и закрепление пакета в разделе «Пакеты»", () => {
    const hint = installHint(describeImageManifest(workplaceManifest()), open);

    expect(hint).toBe(
      "Агент может сам ставить пакеты через pip. Они живут только в этой сессии. " +
        "Чтобы закрепить пакет, добавьте его в раздел «Пакеты».",
    );
  });

  it("считает, что ограниченная сеть с менеджерами пакетов тоже пускает к реестрам", () => {
    expect(installHint(describeImageManifest(workplaceManifest()), registries)).toContain(
      "через pip",
    );
  });

  it("предупреждает, что при закрытых реестрах агент ничего не поставит, и говорит, как их открыть", () => {
    const hint = installHint(describeImageManifest(workplaceManifest()), closed);

    expect(hint).toBe(
      "Сеть окружения закрывает реестры пакетов, поэтому агент не сможет ставить пакеты сам. " +
        "Чтобы открыть их, включите доступ менеджерам пакетов в разделе «Сеть».",
    );
    expect(hint).not.toContain("через pip");
  });

  it("говорит про apt и npm, когда в образе нет pip", () => {
    const hint = installHint(describeImageManifest(legacyManifest()), open);

    expect(hint).toContain("В этом образе нет pip");
    expect(hint).toContain("через apt и npm");
    expect(hint).toContain("раздел «Пакеты»");
  });

  it("не называет менеджер, когда состава образа нет", () => {
    const hint = installHint(null, open);

    expect(hint).toContain("Агент может сам ставить пакеты");
    expect(hint).not.toContain("через pip");
    expect(hint).toContain("раздел «Пакеты»");
  });
});
