// Подставные ответы GET /v1/oma/sandbox-catalog для тестов консоли.
// Составы образов сняты с манифестов, которые собрал platform/sandbox-images/build.sh:
// workplace-2026.10.1, workplace-office-2026.10.1 и legacy (node:22-bookworm).
// Из списка dpkg оставлены пакеты, которые показывает консоль, и четыре посторонних.

import type { SandboxCatalog } from "../lib/sandbox-catalog";

export const WORKPLACE_DIGEST = "sha256:3fdbc27b71b4ac4ed2b4a86d1604a44648a5cacb7a12e6e2214214c2b4cc1f42";
export const OFFICE_DIGEST = "sha256:032d84d3db6ad8875bdd5de07e73f053068324865308f6353dee25d639f18fc3";
export const LEGACY_DIGEST = "sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8";

const PIP_LIBRARIES: Array<[string, string]> = [
  ["anyio", "4.6.2.post1"],
  ["beautifulsoup4", "4.12.3"],
  ["certifi", "2024.8.30"],
  ["cffi", "1.17.1"],
  ["chardet", "5.2.0"],
  ["charset-normalizer", "3.4.0"],
  ["contourpy", "1.3.0"],
  ["cryptography", "43.0.3"],
  ["cycler", "0.12.1"],
  ["et_xmlfile", "2.0.0"],
  ["fonttools", "4.55.0"],
  ["h11", "0.16.0"],
  ["httpcore", "1.0.9"],
  ["httpx", "0.27.2"],
  ["idna", "3.10"],
  ["kiwisolver", "1.4.7"],
  ["lxml", "5.3.0"],
  ["matplotlib", "3.9.2"],
  ["mercurial", "6.3.2"],
  ["numpy", "1.26.4"],
  ["openpyxl", "3.1.5"],
  ["packaging", "24.2"],
  ["pandas", "2.2.3"],
  ["pdfminer.six", "20231228"],
  ["pdfplumber", "0.11.4"],
  ["pillow", "11.0.0"],
  ["pip", "24.3.1"],
  ["pycparser", "2.22"],
  ["pyparsing", "3.2.0"],
  ["pypdf", "5.1.0"],
  ["pypdfium2", "4.30.0"],
  ["python-dateutil", "2.9.0.post0"],
  ["python-docx", "1.1.2"],
  ["python-pptx", "1.0.2"],
  ["pytz", "2024.2"],
  ["reportlab", "4.2.5"],
  ["requests", "2.32.3"],
  ["setuptools", "75.6.0"],
  ["six", "1.16.0"],
  ["sniffio", "1.3.1"],
  ["soupsieve", "2.6"],
  ["typing_extensions", "4.12.2"],
  ["tzdata", "2024.2"],
  ["urllib3", "2.2.3"],
  ["wheel", "0.45.1"],
  ["XlsxWriter", "3.2.0"],
];

const FONT_LINES: string[] = [
  "Liberation Serif\t/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf",
  "PT Mono\t/usr/share/fonts/truetype/paratype/PTM55F.ttf",
  "Liberation Sans\t/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
  "PT Serif\t/usr/share/fonts/truetype/paratype/PTF75F.ttf",
  "PT Serif Caption\t/usr/share/fonts/truetype/paratype/PTZ55F.ttf",
  "Liberation Sans\t/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
  "DejaVu Sans\t/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "Carlito\t/usr/share/fonts/truetype/crosextra/Carlito-Italic.ttf",
  "PT Sans Caption\t/usr/share/fonts/truetype/paratype/PTC55F.ttf",
  "Liberation Mono\t/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf",
  "PT Serif Caption\t/usr/share/fonts/truetype/paratype/PTZ56F.ttf",
  "PT Sans\t/usr/share/fonts/truetype/paratype/PTS56F.ttf",
  "Liberation Mono\t/usr/share/fonts/truetype/liberation2/LiberationMono-Bold.ttf",
  "PT Sans\t/usr/share/fonts/truetype/paratype/PTS75F.ttf",
  "PT Serif\t/usr/share/fonts/truetype/paratype/PTF55F.ttf",
  "Carlito\t/usr/share/fonts/truetype/crosextra/Carlito-BoldItalic.ttf",
  "PT Sans\t/usr/share/fonts/truetype/paratype/PTS55F.ttf",
  "Liberation Mono\t/usr/share/fonts/truetype/liberation2/LiberationMono-Italic.ttf",
  "PT Mono\t/usr/share/fonts/truetype/paratype/PTM75F.ttf",
  "PT Sans Caption\t/usr/share/fonts/truetype/paratype/PTC75F.ttf",
  "Liberation Serif\t/usr/share/fonts/truetype/liberation2/LiberationSerif-Bold.ttf",
  "PT Serif\t/usr/share/fonts/truetype/paratype/PTF76F.ttf",
  "DejaVu Sans\t/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "PT Serif\t/usr/share/fonts/truetype/paratype/PTF56F.ttf",
  "Liberation Serif\t/usr/share/fonts/truetype/liberation2/LiberationSerif-Italic.ttf",
  "DejaVu Sans Mono\t/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
  "DejaVu Serif\t/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
  "DejaVu Serif\t/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "Carlito\t/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf",
  "Liberation Mono\t/usr/share/fonts/truetype/liberation2/LiberationMono-BoldItalic.ttf",
  "Liberation Sans\t/usr/share/fonts/truetype/liberation2/LiberationSans-BoldItalic.ttf",
  "PT Sans Narrow\t/usr/share/fonts/truetype/paratype/PTN57F.ttf",
  "PT Sans\t/usr/share/fonts/truetype/paratype/PTS76F.ttf",
  "DejaVu Sans Mono\t/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  "Liberation Sans\t/usr/share/fonts/truetype/liberation2/LiberationSans-Italic.ttf",
  "PT Sans Narrow\t/usr/share/fonts/truetype/paratype/PTN77F.ttf",
  "Carlito\t/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf",
  "Liberation Serif\t/usr/share/fonts/truetype/liberation2/LiberationSerif-BoldItalic.ttf",
];

const LEGACY_FONT_LINES: string[] = [
  "DejaVu Sans\t/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "DejaVu Sans\t/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "DejaVu Sans Mono\t/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
  "DejaVu Serif\t/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
  "DejaVu Serif\t/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "DejaVu Sans Mono\t/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
];

const DPKG_WORKPLACE: Array<[string, string]> = [
  ["adduser", "3.134"],
  ["apt", "2.6.1"],
  ["libc6", "2.36-9+deb12u14"],
  ["zlib1g", "1:1.2.13.dfsg-1"],
  ["git", "1:2.39.5-0+deb12u3"],
  ["curl", "7.88.1-10+deb12u15"],
  ["wget", "1.21.3-1+deb12u1"],
  ["jq", "1.6-2.1+deb12u2"],
  ["ripgrep", "13.0.0-4+b2"],
  ["poppler-utils", "22.12.0-2+deb12u3"],
  ["tesseract-ocr", "5.3.0-2"],
  ["tesseract-ocr-rus", "1:4.1.0-2"],
  ["tesseract-ocr-eng", "1:4.1.0-2"],
  ["fontconfig", "2.14.1-4"],
  ["file", "1:5.44-3"],
  ["procps", "2:4.0.2-3"],
  ["unzip", "6.0-28+deb12u1"],
  ["make", "4.3-4.1"],
  ["gcc", "4:12.2.0-3"],
  ["g++", "4:12.2.0-3"],
  ["bash", "5.2.15-2+b13"],
  ["python3", "3.11.2-1+b1"],
];

const DPKG_OFFICE: Array<[string, string]> = [
  ["adduser", "3.134"],
  ["apt", "2.6.1"],
  ["libc6", "2.36-9+deb12u14"],
  ["zlib1g", "1:1.2.13.dfsg-1"],
  ["git", "1:2.39.5-0+deb12u3"],
  ["curl", "7.88.1-10+deb12u15"],
  ["wget", "1.21.3-1+deb12u1"],
  ["jq", "1.6-2.1+deb12u2"],
  ["ripgrep", "13.0.0-4+b2"],
  ["poppler-utils", "22.12.0-2+deb12u3"],
  ["tesseract-ocr", "5.3.0-2"],
  ["tesseract-ocr-rus", "1:4.1.0-2"],
  ["tesseract-ocr-eng", "1:4.1.0-2"],
  ["fontconfig", "2.14.1-4"],
  ["file", "1:5.44-3"],
  ["procps", "2:4.0.2-3"],
  ["unzip", "6.0-28+deb12u1"],
  ["make", "4.3-4.1"],
  ["gcc", "4:12.2.0-3"],
  ["g++", "4:12.2.0-3"],
  ["bash", "5.2.15-2+b13"],
  ["python3", "3.11.2-1+b1"],
  ["libreoffice-core-nogui", "4:7.4.7-1+deb12u14"],
  ["libreoffice-writer-nogui", "4:7.4.7-1+deb12u14"],
  ["libreoffice-calc-nogui", "4:7.4.7-1+deb12u14"],
  ["libreoffice-impress-nogui", "4:7.4.7-1+deb12u14"],
  ["python3-uno", "4:7.4.7-1+deb12u14"],
];

const DPKG_LEGACY: Array<[string, string]> = [
  ["adduser", "3.134"],
  ["apt", "2.6.1"],
  ["libc6", "2.36-9+deb12u14"],
  ["zlib1g", "1:1.2.13.dfsg-1"],
  ["git", "1:2.39.5-0+deb12u3"],
  ["curl", "7.88.1-10+deb12u15"],
  ["wget", "1.21.3-1+deb12u1"],
  ["fontconfig", "2.14.1-4"],
  ["file", "1:5.44-3"],
  ["procps", "2:4.0.2-3"],
  ["unzip", "6.0-28+deb12u1"],
  ["make", "4.3-4.1"],
  ["gcc", "4:12.2.0-3"],
  ["g++", "4:12.2.0-3"],
  ["bash", "5.2.15-2+b13"],
  ["python3", "3.11.2-1+b1"],
];

function dpkgRows(rows: Array<[string, string]>) {
  return rows.map(([name, version]) => ({ name, version }));
}

const OS = {
  pretty_name: "Debian GNU/Linux 12 (bookworm)",
  name: "Debian GNU/Linux",
  version_id: "12",
  version: "12 (bookworm)",
  version_codename: "bookworm",
  id: "debian",
};

/** Манифест образа «Рабочее место агента». */
export function workplaceManifest(): Record<string, unknown> {
  return {
    schema_version: 1,
    image_digest: WORKPLACE_DIGEST,
    os: OS,
    architecture: "x86_64",
    user: "root",
    shell: "/bin/bash",
    venv: "/opt/venv",
    python_version: "3.11.2",
    node_version: "v22.23.3",
    package_managers: ["apt-get", "npm", "pip", "uv"],
    pip: PIP_LIBRARIES.map(([name, version]) => ({ name, version })),
    dpkg: dpkgRows(DPKG_WORKPLACE),
    npm: {"corepack": {"version": "0.36.0", "overridden": false}, "npm": {"version": "10.9.9", "overridden": false}},
    fonts: FONT_LINES,
    uv_version: "uv 0.9.4",
    libreoffice_version: null,
  };
}

/** Манифест образа «Рабочее место с LibreOffice»: то же, что у «Рабочего места», плюс LibreOffice. */
export function officeManifest(): Record<string, unknown> {
  return {
    ...workplaceManifest(),
    image_digest: OFFICE_DIGEST,
    dpkg: dpkgRows(DPKG_OFFICE),
    libreoffice_version: "LibreOffice 7.4.7.2 40(Build:2)",
  };
}

/** Манифест прежнего образа node:22-bookworm: без pip и venv. */
export function legacyManifest(): Record<string, unknown> {
  return {
    schema_version: 1,
    image_digest: LEGACY_DIGEST,
    os: OS,
    architecture: "x86_64",
    user: "root",
    shell: "/bin/bash",
    venv: null,
    python_version: "3.11.2",
    node_version: "v22.23.3",
    package_managers: ["apt-get", "npm"],
    pip: [],
    dpkg: dpkgRows(DPKG_LEGACY),
    npm: {"corepack": {"version": "0.36.0", "overridden": false}, "npm": {"version": "10.9.9", "overridden": false}},
    fonts: LEGACY_FONT_LINES,
    uv_version: null,
    libreoffice_version: null,
  };
}

const REGISTRIES_ONLY = {
  type: "limited" as const,
  allow_mcp_servers: true,
  allow_package_managers: true,
  allow_web_search: false,
  allowed_hosts: [] as string[],
};

function template(
  id: string,
  label: string,
  image: string,
  networking: SandboxCatalog["templates"][number]["config"]["networking"],
  pip: string[] = [],
): SandboxCatalog["templates"][number] {
  return {
    id,
    label,
    description: null,
    image,
    available: true,
    config: {
      type: "cloud",
      image,
      networking,
      packages: { type: "packages", apt: [], npm: [], pip },
    },
    metadata: { oma_template: id },
  };
}

/** Каталог, как его отдаёт сервер с каталогом из platform/sandbox-images/catalog.json. */
export function sandboxCatalogFixture(): SandboxCatalog {
  return {
    enabled: true,
    default_image: "legacy",
    images: [
      {
        key: "legacy",
        label: "Node 22, прежний образ",
        built: true,
        reason: null,
        image_digest: LEGACY_DIGEST,
        size_bytes: null,
        resources: { disk_gb: 4, memory_mib: 512, cpus: 1 },
        manifest: legacyManifest(),
      },
      {
        key: "workplace",
        label: "Рабочее место агента",
        built: true,
        reason: null,
        image_digest: WORKPLACE_DIGEST,
        size_bytes: 580187508,
        resources: { disk_gb: 6, memory_mib: 1024, cpus: 2 },
        manifest: workplaceManifest(),
      },
      {
        key: "workplace-office",
        label: "Рабочее место с LibreOffice",
        built: true,
        reason: null,
        image_digest: OFFICE_DIGEST,
        size_bytes: 720682069,
        resources: { disk_gb: 8, memory_mib: 2048, cpus: 2 },
        manifest: officeManifest(),
      },
    ],
    templates: [
      template("basic", "Базовое", "workplace", REGISTRIES_ONLY),
      template("documents", "Документы и офис", "workplace-office", REGISTRIES_ONLY),
      template("data", "Данные", "workplace", REGISTRIES_ONLY, ["duckdb", "pyarrow", "scipy"]),
      template("web", "Веб", "workplace", { type: "unrestricted" }, ["markdownify", "feedparser"]),
    ],
  };
}

/** Тот же каталог, но образ с LibreOffice не собран: шаблон «Документы и офис» недоступен. */
export function catalogWithUnbuiltOffice(): SandboxCatalog {
  const catalog = sandboxCatalogFixture();
  return {
    ...catalog,
    images: catalog.images.map((image) =>
      image.key === "workplace-office"
        ? {
            ...image,
            built: false,
            reason: "Каталог образа workplace-office-2026.10.1 не найден",
            image_digest: null,
            size_bytes: null,
            manifest: null,
          }
        : image,
    ),
    templates: catalog.templates.map((item) =>
      item.image === "workplace-office" ? { ...item, available: false } : item,
    ),
  };
}

/** Ответ сервера без SANDBOX_IMAGE_CATALOG: один образ сервера и ни одного шаблона. */
export function disabledCatalogFixture(): SandboxCatalog {
  return {
    enabled: false,
    default_image: "default",
    images: [
      {
        key: "default",
        label: "Образ сервера",
        built: true,
        reason: null,
        image_digest: null,
        size_bytes: null,
        resources: { disk_gb: null, memory_mib: null, cpus: null },
        manifest: null,
      },
    ],
    templates: [],
  };
}
