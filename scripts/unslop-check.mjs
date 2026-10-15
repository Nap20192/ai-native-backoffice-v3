#!/usr/bin/env node
// unslop-ignore-file: список запрещённых оборотов живёт здесь.
// Проверка текста по правилам скилла unslop (.claude/skills/unslop/SKILL.md).
// Ловит только то, что видно без суждения: тире, кривые кавычки, слова-маркеры,
// пустые обороты, эмодзи в заголовках, Title Case, жирные метки с двоеточием.
//
//   node scripts/unslop-check.mjs <файл>...   проверить файлы целиком
//   node scripts/unslop-check.mjs --staged    добавленные строки индекса git (pre-commit)
//   node scripts/unslop-check.mjs --diff      добавленные строки рабочей копии
//   node scripts/unslop-check.mjs --hook      PostToolUse Claude Code: JSON на stdin
//
// Строку пропускает метка unslop-ignore, файл целиком — unslop-ignore-file.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROSE = /\.(md|mdx|txt)$/i;
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|sh|json|ya?ml|html|css)$/i;
const SKIP_PATH = /(^|\/)(node_modules|dist|\.audit|\.verify-evidence|data|data-preview|coverage)\/|(^|\/)\.(claude|agents)\/skills\/unslop\/|pnpm-lock\.yaml$|package-lock\.json$/;
const CYRILLIC = /[А-Яа-яЁё]/;

const WORDS_EN = [
  [7, /\b(delve[sd]?|delving|crucial|pivotal|tapestry|testament|underscor(e|es|ed|ing)|showcas(e|es|ed|ing)|fostering|garner(s|ed)?|interplay|intricate|vibrant|enduring)\b/i],
  [7, /(^|[.!?]\s+)Additionally,/],
  [8, /\b(serves as|stands as|boasts)\b/i],
  [26, /\b(north star|flywheel|nexus|locus|paradigm|bedrock|gold-plating)\b/i],
  [31, /\b(leverag(e|es|ed|ing)|utiliz(e|es|ed|ing|ation)|facilitat(e|es|ed|ing)|numerous|in the event that|robust|seamless(ly)?)\b/i],
  [20, /\b(I hope this helps|Let me know if|Certainly!|Of course!)/i],
  [22, /\b(Great question|You're absolutely right)\b/i],
  [23, /\b(in order to|due to the fact that|it is important to note)\b/i],
];

const WORDS_RU = [
  [8, /(^|[^А-Яа-яЁё])явля(ется|ются|лся|лась|лось|лись|ющ[а-яё]+)(?![А-Яа-яЁё])/i],
  [9, /не просто [^.!?\n]{1,80}?, а /i],
  [20, /надеюсь, это (поможет|было полезно)|обращайтесь, если|дайте знать, если/i],
  [22, /отличный вопрос|вы (абсолютно|совершенно) правы/i],
  [23, /(важно|стоит|следует|необходимо|нужно) отметить|в заключение|в рамках данн|давайте разбер[её]мся|осуществля/i],
  [31, /\bданн(ый|ая|ое|ого|ой|ом)\s+(документ|раздел|план|файл|скрипт|модуль|подход|случа)/i],
];

const HINT = {
  7: "слово-маркер ИИ: замените простым словом",
  8: "вычурное «является / serves as»: скажите «это», «есть» или перестройте фразу",
  9: "«не просто X, а Y»: скажите мысль прямо",
  13: "тире: замените точкой или запятой (без тире, скобок и дефиса вместо тире)",
  16: "жирная метка с двоеточием в пункте: перепишите прозой или закончите метку точкой",
  17: "заголовок в Title Case: пишите с заглавной только первое слово",
  18: "эмодзи в заголовке или пункте списка: уберите",
  19: "кривые кавычки: используйте «ёлочки» или прямые \"",
  20: "фраза чат-бота: уберите",
  22: "угодливый тон: отвечайте прямо",
  23: "пустой оборот: удалите или скажите короче",
  26: "абстрактная метафора: назовите конкретную вещь",
  31: "вычурное слово: замените простым (use, help, many)",
};

function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}

function checkLine(raw, { prose }) {
  if (raw.includes("unslop-ignore")) return [];
  if (!prose && !CYRILLIC.test(raw)) return [];
  const line = stripInlineCode(raw);
  const found = new Set();
  if (/[—–]/.test(line)) found.add(13);
  if (prose && /\S \- \S/.test(line.replace(/^\s*[-*+]\s/, ""))) found.add(13);
  if (/[“”„‘’]/.test(line)) found.add(19);
  for (const [rule, re] of WORDS_EN) if (re.test(line)) found.add(rule);
  for (const [rule, re] of WORDS_RU) if (re.test(line)) found.add(rule);
  if (prose) {
    if (/^\s*(#{1,6}|[-*+]|\d+\.)\s+.*\p{Extended_Pictographic}/u.test(line)) found.add(18);
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading && isTitleCase(heading[1])) found.add(17);
    if (/^\s*[-*+]\s+\*\*[^*]+:\*\*/.test(line)) found.add(16);
  }
  return [...found].sort((a, b) => a - b);
}

const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "via", "with"]);

function isTitleCase(text) {
  if (CYRILLIC.test(text)) return false;
  const words = text.replace(/[^A-Za-z\s-]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const rest = words.slice(1).filter((w) => !SMALL.has(w.toLowerCase()) && w.length > 2);
  if (rest.length < 2) return false;
  return rest.every((w) => /^[A-Z]/.test(w));
}

export function checkText(text, path, firstLine = 1) {
  if (/unslop-ignore-file/.test(text.split("\n", 3).join("\n"))) return [];
  const prose = PROSE.test(path);
  if (!prose && !CODE.test(path)) return [];
  const out = [];
  let fenced = false;
  text.split("\n").forEach((raw, i) => {
    if (prose && /^\s*(```|~~~)/.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    for (const rule of checkLine(raw, { prose })) {
      out.push({ path, line: firstLine + i, rule, hint: HINT[rule], text: raw.trim().slice(0, 160) });
    }
  });
  return out;
}

export function addedLinesFromDiff(diff) {
  const out = [];
  let path = null;
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).replace(/^b\//, "");
      path = p === "/dev/null" || SKIP_PATH.test(p) || !(PROSE.test(p) || CODE.test(p)) ? null : p;
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (!path) continue;
    if (raw.startsWith("+")) { out.push({ path, line: next, text: raw.slice(1) }); next += 1; }
    else if (raw.startsWith(" ")) next += 1;
  }
  return out;
}

function checkAdded(lines, root) {
  const out = [];
  const fenceState = new Map();
  const ignoredFiles = new Set();
  for (const { path, line, text } of lines) {
    if (ignoredFiles.has(path)) continue;
    if (!fenceState.has(path)) {
      const abs = resolve(root, path);
      const head = existsSync(abs) ? readFileSync(abs, "utf8").split("\n", 3).join("\n") : "";
      if (/unslop-ignore-file/.test(head)) { ignoredFiles.add(path); continue; }
      fenceState.set(path, insideFenceMap(abs, path));
    }
    if (fenceState.get(path).has(line)) continue;
    const prose = PROSE.test(path);
    for (const rule of checkLine(text, { prose })) out.push({ path, line, rule, hint: HINT[rule], text: text.trim().slice(0, 160) });
  }
  return out;
}

function insideFenceMap(abs, path) {
  const inside = new Set();
  if (!PROSE.test(path) || !existsSync(abs)) return inside;
  let fenced = false;
  readFileSync(abs, "utf8").split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; inside.add(i + 1); return; }
    if (fenced) inside.add(i + 1);
  });
  return inside;
}

function report(violations) {
  return violations.map((v) => `${v.path}:${v.line}: [unslop ${v.rule}] ${v.hint}\n    ${v.text}`).join("\n");
}

function gitRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function hookMode() {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const ti = input.tool_input ?? {};
  const file = ti.file_path ?? ti.notebook_path;
  if (!file) return 0;
  const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const rel = relative(root, file);
  if (rel.startsWith("..") || SKIP_PATH.test(rel) || !existsSync(file)) return 0;
  const whole = readFileSync(file, "utf8");
  const pieces = ti.content !== undefined ? [ti.content]
    : ti.new_string !== undefined ? [ti.new_string]
    : Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string ?? "") : [];
  const violations = [];
  for (const piece of pieces) {
    if (!piece) continue;
    const at = whole.indexOf(piece);
    const first = at < 0 ? 1 : whole.slice(0, at).split("\n").length;
    const fence = insideFenceMap(file, rel);
    for (const v of checkText(piece, rel, first)) if (!fence.has(v.line) || at < 0) violations.push(v);
  }
  if (/unslop-ignore-file/.test(whole.split("\n", 3).join("\n"))) return 0;
  if (violations.length === 0) return 0;
  process.stderr.write(`Текст нарушает правила unslop (.claude/skills/unslop/SKILL.md). Исправьте эти строки:\n${report(violations)}\n`);
  return 2;
}

function main(argv) {
  if (argv[0] === "--hook") return hookMode();
  if (argv[0] === "--staged" || argv[0] === "--diff") {
    const root = gitRoot();
    const args = argv[0] === "--staged" ? ["diff", "--cached", "-U0", "--no-color"] : ["diff", "-U0", "--no-color"];
    const diff = execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const violations = checkAdded(addedLinesFromDiff(diff), root);
    if (violations.length === 0) return 0;
    process.stderr.write(`unslop: ${violations.length} нарушений в добавленных строках (правила .claude/skills/unslop/SKILL.md):\n${report(violations)}\nСтрока с меткой unslop-ignore пропускается.\n`);
    return 1;
  }
  let total = 0;
  for (const file of argv) {
    if (SKIP_PATH.test(file)) continue;
    const v = checkText(readFileSync(file, "utf8"), file);
    total += v.length;
    if (v.length) process.stdout.write(report(v) + "\n");
  }
  return total === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
