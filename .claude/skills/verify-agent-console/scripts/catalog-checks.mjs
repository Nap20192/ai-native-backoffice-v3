// Проверки каталога образов песочницы для journey-env-to-agent.mjs (шаг «образы каталога»):
//   env.catalog_enabled: сервер читает каталог, образы workplace и workplace-office собраны,
//     а дайджест из GET /v1/oma/sandbox-catalog равен index.json каталога образа на диске
//     и файлу <oci_dir>.digest рядом (если он есть);
//   env.office_tools: команда для VM на workplace-office и разбор её вывода;
//   env.render: pptx от python-pptx → soffice → PDF → pdftoppm → PNG, разбор вывода и проверка PNG.
// Здесь только чистые функции: сервер, VM и браузер не нужны, их проверяет catalog-checks.test.mjs.
// Команды одной строкой: фейковая модель берёт команду из строки «Команда: …» промпта.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CATALOG_IMAGE_KEYS = ["workplace", "workplace-office"];
export const OFFICE_IMAGE_KEY = "workplace-office";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** sha256:0123456789ab… для текста проверки. */
export const shortDigest = (digest) => (typeof digest === "string" ? digest.slice(0, 19) : String(digest));

/** Дайджест манифеста из index.json каталога OCI (первая запись, как readOciIndexDigest сервера) или null. */
export function readIndexDigest(dir) {
  try {
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    const digest = index?.manifests?.[0]?.digest;
    return typeof digest === "string" && DIGEST.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

/**
 * Сверка каталога: ответ сервера (response), разобранный catalog.json (catalogFile) и папка образов
 * (imageDir) на диске. Возвращает проблемы (пустой список: проверка прошла) и факты по каждому образу.
 */
export function catalogImageFacts({ response, catalogFile, imageDir, keys = CATALOG_IMAGE_KEYS }) {
  const problems = [];
  if (response?.enabled !== true) {
    problems.push(`enabled=${response?.enabled}: сервер не читает каталог образов (SANDBOX_IMAGE_CATALOG и SANDBOX_IMAGE_DIR в окружении сервера задаёт launch.sh)`);
  }
  const images = keys.map((key) => {
    const fact = { key, built: null, reason: null, apiDigest: null, ociDir: null, indexDigest: null, fileDigest: null };
    const image = (response?.images ?? []).find((i) => i?.key === key);
    if (!image) {
      problems.push(`${key}: нет в ответе GET /v1/oma/sandbox-catalog`);
      return fact;
    }
    fact.built = image.built;
    fact.reason = image.reason ?? null;
    fact.apiDigest = image.image_digest ?? null;
    if (image.built !== true) problems.push(`${key}: built=${image.built}, ${image.reason ?? "причины нет"}`);
    const ociDir = catalogFile?.images?.[key]?.oci_dir;
    if (typeof ociDir !== "string" || ociDir === "") {
      problems.push(`${key}: в catalog.json нет oci_dir`);
      return fact;
    }
    fact.ociDir = ociDir;
    fact.indexDigest = readIndexDigest(join(imageDir, ociDir));
    if (fact.indexDigest === null) {
      problems.push(`${key}: нет index.json с дайджестом в ${join(imageDir, ociDir)}`);
      return fact;
    }
    if (fact.apiDigest !== fact.indexDigest) {
      problems.push(`${key}: дайджест API ${shortDigest(fact.apiDigest)} ≠ index.json ${shortDigest(fact.indexDigest)}`);
    }
    const digestFile = join(imageDir, `${ociDir}.digest`);
    if (existsSync(digestFile)) {
      fact.fileDigest = readFileSync(digestFile, "utf8").trim();
      if (fact.fileDigest !== fact.indexDigest) {
        problems.push(`${key}: файл ${ociDir}.digest ${shortDigest(fact.fileDigest)} ≠ index.json ${shortDigest(fact.indexDigest)}`);
      }
    }
    return fact;
  });
  return { problems, images };
}

// ------------------------------------------------------------ инструменты офиса ---
// Код выхода каждой программы идёт своей строкой rc_<имя>=N: текст версии pdftoppm пишет в stderr,
// и по одному тексту не отличить «нет программы» от «версия не напечатана».
const OFFICE_TOOLS = [
  { name: "soffice", version: /LibreOffice \d+(?:\.\d+)+/ },
  { name: "pdftoppm", version: /pdftoppm version \d+(?:\.\d+)+/ },
  { name: "python", version: /Python 3(?:\.\d+)+/ },
  { name: "python_libs", version: null },
];

export function officeToolsCommand(n) {
  return [
    `echo VERIFY_OK_${n}`,
    "echo kernel=$(uname -r)",
    "soffice --version 2>&1", "echo rc_soffice=$?",
    "pdftoppm -v 2>&1", "echo rc_pdftoppm=$?",
    "python --version 2>&1", "echo rc_python=$?",
    "python -c 'import docx, openpyxl, pptx' 2>&1", "echo rc_python_libs=$?",
  ].join("; ");
}

export function officeToolsFacts(text) {
  const out = String(text ?? "");
  return {
    kernel: out.match(/kernel=(\S+)/)?.[1] ?? null,
    tools: OFFICE_TOOLS.map(({ name, version }) => {
      const rc = out.match(new RegExp(`^rc_${name}=(\\d+)\\s*$`, "m"))?.[1];
      return { name, rc: rc === undefined ? null : Number(rc), version: version ? out.match(version)?.[0] ?? null : null };
    }),
  };
}

export function officeToolsProblems(facts) {
  const problems = [];
  for (const tool of facts.tools) {
    const spec = OFFICE_TOOLS.find((t) => t.name === tool.name);
    if (tool.rc === null) problems.push(`${tool.name}: нет строки rc_${tool.name}, команда не дошла до конца`);
    else if (tool.rc !== 0) problems.push(`${tool.name}: код ${tool.rc}`);
    else if (spec?.version && !tool.version) problems.push(`${tool.name}: код 0, но нет строки версии`);
  }
  return problems;
}

// ------------------------------------------------------------------- рендер ---
export const renderFileName = (n) => `verify-render-${n}.png`;

/**
 * Слайд 16:9 (12192000 × 6858000 EMU) с заголовком, soffice без общего профиля
 * (-env:UserInstallation, как selftest/render-ru.py образа), pdftoppm в один PNG
 * (-singlefile: имя без номера страницы) и копия PNG в /mnt/session/outputs.
 * soffice --convert-to иногда выходит с кодом 0 без PDF, поэтому каждый шаг проверяет файл (test -s).
 */
export function renderCommand(n) {
  const d = `/tmp/verify-render-${n}`;
  const out = `/mnt/session/outputs/${renderFileName(n)}`;
  const py = [
    "from pptx import Presentation",
    "from pptx.util import Emu",
    "p = Presentation()",
    "p.slide_width = Emu(12192000)",
    "p.slide_height = Emu(6858000)",
    "s = p.slides.add_slide(p.slide_layouts[5])",
    `s.shapes.title.text = 'VERIFY ${n}'`,
    `p.save('${d}/deck.pptx')`,
  ].join("; ");
  return [
    `echo VERIFY_OK_${n}`,
    `mkdir -p ${d} /mnt/session/outputs && python -c "${py}" && test -s ${d}/deck.pptx && echo step_pptx=ok`
      + ` && soffice -env:UserInstallation=file://${d}/lo --headless --convert-to pdf --outdir ${d} ${d}/deck.pptx 2>&1 && test -s ${d}/deck.pdf && echo step_pdf=ok`
      + ` && pdftoppm -png -r 50 -singlefile ${d}/deck.pdf ${d}/slide 2>&1 && test -s ${d}/slide.png && echo step_png=ok`
      + ` && cp ${d}/slide.png ${out} && echo step_copy=ok && echo png_bytes=$(stat -c %s ${d}/slide.png)`,
  ].join("; ");
}

const RENDER_STEPS = [
  ["pptx", "python-pptx не записал deck.pptx"],
  ["pdf", "soffice --convert-to pdf не дал PDF"],
  ["png", "pdftoppm -png не дал PNG"],
  ["copy", "PNG не скопирован в /mnt/session/outputs"],
];

export function renderFacts(text) {
  const out = String(text ?? "");
  const bytes = out.match(/^png_bytes=(\d+)\s*$/m)?.[1];
  return {
    steps: Object.fromEntries(RENDER_STEPS.map(([step]) => [step, new RegExp(`^step_${step}=ok\\s*$`, "m").test(out)])),
    pngBytes: bytes === undefined ? null : Number(bytes),
  };
}

export function renderProblems(facts) {
  const missing = RENDER_STEPS.find(([step]) => !facts.steps[step]);
  if (missing) return [`шаг ${missing[0]}: ${missing[1]}`];
  if (!(facts.pngBytes > 0)) return [`png_bytes=${facts.pngBytes}: PNG пустой`];
  return [];
}

export function pngProblems(buffer) {
  if (!buffer || buffer.length === 0) return ["файл пустой"];
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return [`сигнатура не PNG: ${buffer.subarray(0, 8).toString("hex")}`];
  }
  if (buffer.length <= PNG_SIGNATURE.length) return ["в файле только сигнатура PNG"];
  return [];
}
