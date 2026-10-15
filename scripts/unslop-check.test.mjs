// unslop-ignore-file: тест намеренно содержит запрещённые обороты.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkText, addedLinesFromDiff } from "./unslop-check.mjs";

const rules = (text, path = "doc.md") => checkText(text, path).map((v) => v.rule);

test("длинное и среднее тире в прозе", () => {
  assert.deepEqual(rules("Сервер — это процесс."), [13]);
  assert.deepEqual(rules("Диапазон 1–3."), [13]);
});

test("дефис вместо тире между словами", () => {
  assert.deepEqual(rules("Сервер - это процесс."), [13]);
  assert.deepEqual(rules("- пункт списка"), []);
  assert.deepEqual(rules("claude-sonnet-4-6 и pre-commit"), []);
});

test("кривые кавычки, ёлочки разрешены", () => {
  assert.deepEqual(rules("Он сказал “да”."), [19]);
  assert.deepEqual(rules("Кнопка «Создать»."), []);
});

test("слова-маркеры ИИ по-английски", () => {
  assert.deepEqual(rules("We leverage a robust approach."), [31]);
  assert.deepEqual(rules("Let us delve into it."), [7]);
  assert.deepEqual(rules("It is crucial."), [7]);
});

test("русские канцелярские и пустые обороты", () => {
  assert.deepEqual(rules("Важно отметить, что сервер работает."), [23]);
  assert.deepEqual(rules("Модуль является частью ядра."), [8]);
  assert.deepEqual(rules("Это не просто сервер, а платформа."), [9]);
  assert.deepEqual(rules("Надеюсь, это поможет!"), [20]);
  assert.deepEqual(rules("Отличный вопрос! Вот ответ."), [22]);
});

test("код и фрагменты кода в markdown не проверяются", () => {
  assert.deepEqual(rules("Флаг `a — b` и текст."), []);
  assert.deepEqual(rules("```\nx — y\n```\nТекст."), []);
});

test("в коде проверяются только строки с кириллицей", () => {
  assert.deepEqual(rules("// upstream note — keep", "a.ts"), []);
  assert.deepEqual(rules('const t = "Агент — готов";', "a.tsx"), [13]);
});

test("эмодзи в заголовках и пунктах списка", () => {
  assert.deepEqual(rules("## 🚀 Запуск"), [18]);
  assert.deepEqual(rules("- ✅ готово"), [18]);
});

test("заголовки в Title Case", () => {
  assert.deepEqual(rules("## How To Run The Server"), [17]);
  assert.deepEqual(rules("## How to run the server"), []);
});

test("пункт с жирной меткой и двоеточием", () => {
  assert.deepEqual(rules("- **Скорость:** скорость выросла."), [16]);
  assert.deepEqual(rules("- **Схема в TypeScript.** Таблицы в одном файле."), []);
});

test("строка с меткой unslop-ignore пропускается", () => {
  assert.deepEqual(rules("Сервер — процесс. <!-- unslop-ignore -->"), []);
});

test("номер строки указывает на нарушение", () => {
  const v = checkText("Первая строка.\nВторая — с тире.", "doc.md");
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
});

test("копии скилла unslop для Claude и Codex не проверяются", () => {
  const diff = [".claude", ".agents"].flatMap((dir) => [
    `diff --git a/${dir}/skills/unslop/SKILL.md b/${dir}/skills/unslop/SKILL.md`,
    `+++ b/${dir}/skills/unslop/SKILL.md`,
    "@@ -0,0 +1 @@",
    "+Avoid crucial and delve.",
  ]).join("\n");
  assert.deepEqual(addedLinesFromDiff(diff), []);
});

test("из diff берутся только добавленные строки нужных файлов", () => {
  const diff = [
    "diff --git a/docs/a.md b/docs/a.md",
    "+++ b/docs/a.md",
    "@@ -1,0 +5,2 @@",
    "+Новая — строка.",
    "+Вторая строка.",
    "diff --git a/img.png b/img.png",
    "+++ b/img.png",
    "@@ -0,0 +1 @@",
    "+бинарь — нет",
  ].join("\n");
  const got = addedLinesFromDiff(diff);
  assert.deepEqual(got, [
    { path: "docs/a.md", line: 5, text: "Новая — строка." },
    { path: "docs/a.md", line: 6, text: "Вторая строка." },
  ]);
});
