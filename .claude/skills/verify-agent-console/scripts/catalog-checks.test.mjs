// Тесты чистых функций проверок каталога образов (catalog-checks.mjs).
// Запуск: node --test .claude/skills/verify-agent-console/scripts/catalog-checks.test.mjs
// Сервер, VM и браузер не нужны: каталог образов собирается во временной папке.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CATALOG_IMAGE_KEYS,
  OFFICE_IMAGE_KEY,
  catalogImageFacts,
  officeToolsCommand,
  officeToolsFacts,
  officeToolsProblems,
  pngProblems,
  renderCommand,
  renderFacts,
  renderFileName,
  renderProblems,
} from "./catalog-checks.mjs";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

function imageDirFixture(layouts) {
  const dir = mkdtempSync(join(tmpdir(), "vac-catalog-"));
  for (const { ociDir, indexDigest, fileDigest } of layouts) {
    mkdirSync(join(dir, ociDir), { recursive: true });
    if (indexDigest !== undefined) {
      writeFileSync(join(dir, ociDir, "index.json"), JSON.stringify({
        schemaVersion: 2,
        manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: indexDigest }],
      }));
    }
    if (fileDigest !== undefined) writeFileSync(join(dir, `${ociDir}.digest`), `${fileDigest}\n`);
  }
  return dir;
}

const catalogFile = {
  default_image: "legacy",
  images: {
    workplace: { label: "Рабочее место агента", oci_dir: "workplace-2026.10.1" },
    "workplace-office": { label: "Рабочее место с LibreOffice", oci_dir: "workplace-office-2026.10.1" },
  },
};

function response(overrides = {}) {
  return {
    enabled: true,
    default_image: "legacy",
    images: [
      { key: "workplace", built: true, reason: null, image_digest: DIGEST_A },
      { key: "workplace-office", built: true, reason: null, image_digest: DIGEST_B },
      ...(overrides.extra ?? []),
    ].map((image) => ({ ...image, ...(overrides[image.key] ?? {}) })),
    ...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
  };
}

function withDir(layouts, fn) {
  const dir = imageDirFixture(layouts);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const goodLayouts = [
  { ociDir: "workplace-2026.10.1", indexDigest: DIGEST_A, fileDigest: DIGEST_A },
  { ociDir: "workplace-office-2026.10.1", indexDigest: DIGEST_B, fileDigest: DIGEST_B },
];

test("ключи образов: workplace и workplace-office", () => {
  assert.deepEqual(CATALOG_IMAGE_KEYS, ["workplace", "workplace-office"]);
  assert.equal(OFFICE_IMAGE_KEY, "workplace-office");
});

test("каталог включён, образы собраны, дайджесты API, index.json и .digest совпадают", () => {
  withDir(goodLayouts, (imageDir) => {
    const facts = catalogImageFacts({ response: response(), catalogFile, imageDir });
    assert.deepEqual(facts.problems, []);
    assert.deepEqual(facts.images.map((i) => [i.key, i.apiDigest, i.indexDigest, i.fileDigest]), [
      ["workplace", DIGEST_A, DIGEST_A, DIGEST_A],
      ["workplace-office", DIGEST_B, DIGEST_B, DIGEST_B],
    ]);
  });
});

test("enabled=false даёт проблему с enabled=false", () => {
  withDir(goodLayouts, (imageDir) => {
    const facts = catalogImageFacts({ response: response({ enabled: false }), catalogFile, imageDir });
    assert.equal(facts.problems.length > 0, true);
    assert.match(facts.problems[0], /enabled=false/);
  });
});

test("ответ сервера без каталога (только образ default): нет workplace и workplace-office", () => {
  withDir(goodLayouts, (imageDir) => {
    const serverDefault = { enabled: false, default_image: "default", images: [{ key: "default", built: true, image_digest: null }] };
    const facts = catalogImageFacts({ response: serverDefault, catalogFile, imageDir });
    assert.match(facts.problems.join("; "), /enabled=false/);
    assert.match(facts.problems.join("; "), /workplace: нет в ответе/);
    assert.match(facts.problems.join("; "), /workplace-office: нет в ответе/);
  });
});

test("образ не собран: проблема с причиной сервера", () => {
  withDir(goodLayouts, (imageDir) => {
    const facts = catalogImageFacts({
      response: response({ "workplace-office": { built: false, reason: "Каталог образа изменён после сборки" } }),
      catalogFile,
      imageDir,
    });
    assert.equal(facts.problems.length, 1);
    assert.match(facts.problems[0], /workplace-office: built=false, Каталог образа изменён после сборки/);
  });
});

test("дайджест API не совпал с index.json", () => {
  withDir(goodLayouts, (imageDir) => {
    const facts = catalogImageFacts({ response: response({ workplace: { image_digest: DIGEST_C } }), catalogFile, imageDir });
    assert.equal(facts.problems.length, 1);
    assert.match(facts.problems[0], /^workplace: дайджест API sha256:cccccccccccc ≠ index\.json sha256:aaaaaaaaaaaa/);
  });
});

test("файла .digest нет: это не проблема, fileDigest = null", () => {
  const layouts = [goodLayouts[0], { ociDir: "workplace-office-2026.10.1", indexDigest: DIGEST_B }];
  withDir(layouts, (imageDir) => {
    const facts = catalogImageFacts({ response: response(), catalogFile, imageDir });
    assert.deepEqual(facts.problems, []);
    assert.equal(facts.images[1].fileDigest, null);
  });
});

test("файл .digest не совпал с index.json", () => {
  const layouts = [goodLayouts[0], { ociDir: "workplace-office-2026.10.1", indexDigest: DIGEST_B, fileDigest: DIGEST_C }];
  withDir(layouts, (imageDir) => {
    const facts = catalogImageFacts({ response: response(), catalogFile, imageDir });
    assert.equal(facts.problems.length, 1);
    assert.match(facts.problems[0], /^workplace-office: файл workplace-office-2026\.10\.1\.digest sha256:cccccccccccc ≠ index\.json sha256:bbbbbbbbbbbb/);
  });
});

test("нет index.json или oci_dir в catalog.json", () => {
  const layouts = [goodLayouts[0], { ociDir: "workplace-office-2026.10.1" }];
  withDir(layouts, (imageDir) => {
    const facts = catalogImageFacts({ response: response(), catalogFile, imageDir });
    assert.match(facts.problems.join("; "), /workplace-office: нет index\.json с дайджестом/);
    const noDir = catalogImageFacts({
      response: response(),
      catalogFile: { images: { ...catalogFile.images, workplace: { label: "x" } } },
      imageDir,
    });
    assert.match(noDir.problems.join("; "), /workplace: в catalog\.json нет oci_dir/);
  });
});

test("команды одной строкой (фейковая модель берёт строку «Команда:») и начинаются с VERIFY_OK_<n>", () => {
  for (const command of [officeToolsCommand("ab12cd34"), renderCommand("ab12cd34")]) {
    assert.equal(command.includes("\n"), false);
    assert.equal(command.startsWith("echo VERIFY_OK_ab12cd34;"), true);
  }
  assert.match(officeToolsCommand("n1"), /soffice --version/);
  assert.match(officeToolsCommand("n1"), /pdftoppm -v/);
  assert.match(officeToolsCommand("n1"), /python --version/);
  const render = renderCommand("n1");
  assert.match(render, /soffice -env:UserInstallation=file:\/\/\S+ --headless --convert-to pdf/);
  assert.match(render, /pdftoppm -png -r 50 -singlefile/);
  assert.match(render, new RegExp(`/mnt/session/outputs/${renderFileName("n1").replace(/\./g, "\\.")}`));
  assert.equal(renderFileName("n1"), "verify-render-n1.png");
});

const OFFICE_OK = [
  "VERIFY_OK_n1",
  "kernel=6.12.44",
  "LibreOffice 7.4.7.2 40(Build:2)",
  "rc_soffice=0",
  "pdftoppm version 22.12.0",
  "Copyright 2005-2022 The Poppler Developers - http://poppler.freedesktop.org",
  "rc_pdftoppm=0",
  "Python 3.11.2",
  "rc_python=0",
  "rc_python_libs=0",
].join("\n");

test("вывод инструментов офиса: версии и коды 0 без проблем", () => {
  const facts = officeToolsFacts(OFFICE_OK);
  assert.equal(facts.kernel, "6.12.44");
  assert.deepEqual(facts.tools.map((t) => [t.name, t.rc, t.version]), [
    ["soffice", 0, "LibreOffice 7.4.7.2"],
    ["pdftoppm", 0, "pdftoppm version 22.12.0"],
    ["python", 0, "Python 3.11.2"],
    ["python_libs", 0, null],
  ]);
  assert.deepEqual(officeToolsProblems(facts), []);
});

test("нет pdftoppm (код 127) и нет строки кода python: две проблемы", () => {
  const text = OFFICE_OK
    .replace("pdftoppm version 22.12.0", "bash: line 1: pdftoppm: command not found")
    .replace("rc_pdftoppm=0", "rc_pdftoppm=127")
    .replace("rc_python=0\n", "");
  const problems = officeToolsProblems(officeToolsFacts(text));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /pdftoppm: код 127/);
  assert.match(problems[1], /python: нет строки rc_python/);
});

test("код 0, но нет версии soffice: проблема", () => {
  const problems = officeToolsProblems(officeToolsFacts(OFFICE_OK.replace("LibreOffice 7.4.7.2 40(Build:2)\n", "")));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /soffice: код 0, но нет строки версии/);
});

test("рендер: все шаги и размер PNG", () => {
  const text = "VERIFY_OK_n1\nstep_pptx=ok\nconvert /tmp/x/deck.pptx -> /tmp/x/deck.pdf using filter : impress_pdf_Export\nstep_pdf=ok\nstep_png=ok\nstep_copy=ok\npng_bytes=12345";
  const facts = renderFacts(text);
  assert.deepEqual(facts, { steps: { pptx: true, pdf: true, png: true, copy: true }, pngBytes: 12345 });
  assert.deepEqual(renderProblems(facts), []);
});

test("рендер: soffice не дал PDF, проблема называет первый несделанный шаг", () => {
  const problems = renderProblems(renderFacts("VERIFY_OK_n1\nstep_pptx=ok\nError: source file could not be loaded"));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /soffice --convert-to pdf/);
});

test("рендер: PNG нулевого размера", () => {
  const problems = renderProblems(renderFacts("step_pptx=ok\nstep_pdf=ok\nstep_png=ok\nstep_copy=ok\npng_bytes=0"));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /png_bytes=0/);
});

test("PNG: сигнатура и непустое тело", () => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(pngProblems(Buffer.concat([signature, Buffer.from("IHDR....")])), []);
  assert.match(pngProblems(Buffer.alloc(0)).join("; "), /пустой/);
  assert.match(pngProblems(Buffer.from("%PDF-1.7 not a png")).join("; "), /сигнатура/);
  assert.match(pngProblems(signature).join("; "), /только сигнатура/);
});
