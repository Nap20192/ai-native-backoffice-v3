// «Без подсказки по секрету» (builder-agent.md 2.6): no answer without a
// confirmation depends on whether a string of the model matches a secret.

import { describe, expect, it } from "vitest";
import { createFakePlatform } from "./helpers/platform-mcp-fake";

const SECRET = "Zq9#Xw7!Vt3$Lm";
const RANDOM = "ЭЖЭЖЭЖЭЖЭЖЭЖЭЖ";

function setup() {
  const fake = createFakePlatform();
  fake.setupAssistant();
  fake.known.push(SECRET);
  fake.addAgent({ name: "Сводка", system: `Ключ ${SECRET} внутри промпта` });
  fake.addSkill("Навык", { "SKILL.md": `---\nname: s\ndescription: d\n---\nтокен ${SECRET}` });
  const store = fake.addStore({ name: "Память" });
  fake.addMemory(store.id, `/notes/${SECRET}/a.md`, "x");
  fake.addHarnessCard({ id: "hc_1", name: `Карточка ${SECRET}` });
  return { fake, store };
}

async function answer(fake: ReturnType<typeof setup>["fake"], name: string, args: unknown, guess: string) {
  const result = await fake.call(name, args);
  return `${result.isError}|${result.text.split(guess).join("<guess>")}`;
}

describe("platform MCP gives no oracle on secrets", () => {
  it("search_config, list path_prefix and q answer a secret prefix like a random string", async () => {
    const { fake, store } = setup();
    for (const length of [1, 2, 4, 8, SECRET.length]) {
      const prefix = SECRET.slice(0, length);
      const random = RANDOM.slice(0, length);
      expect(await answer(fake, "search_config", { query: prefix }, prefix), `search ${length}`).toBe(await answer(fake, "search_config", { query: random }, random));
      const memoryPrefix = `/notes/${prefix}`;
      const memoryRandom = `/notes/${random}`;
      expect(
        await answer(fake, "list", { kind: "memories", filter: { memory_store_id: store.id, path_prefix: memoryPrefix } }, memoryPrefix),
        `path_prefix ${length}`,
      ).toBe(await answer(fake, "list", { kind: "memories", filter: { memory_store_id: store.id, path_prefix: memoryRandom } }, memoryRandom));
      expect(await answer(fake, "list", { kind: "harness_cards", filter: { q: prefix } }, prefix), `q ${length}`).toBe(
        await answer(fake, "list", { kind: "harness_cards", filter: { q: random } }, random),
      );
    }
  });

  it("preview_change returns the model's arguments as they are, for a right and a wrong guess alike", async () => {
    const { fake } = setup();
    const agent = fake.addAgent({
      name: "С env",
      mcp_servers: [{ type: "stdio", name: "local", command: "/bin/srv", env: { API_TOKEN: SECRET } }],
    });
    const guess = (value: string) =>
      answer(
        fake,
        "preview_change",
        { kind: "agent", id: agent.id, body: { system: `проверка ${value}`, mcp_servers: [{ type: "stdio", name: "local", command: "/bin/srv", env: { API_TOKEN: value } }] } },
        value,
      );
    const right = await guess(SECRET);
    const wrong = await guess(RANDOM);
    expect(right).toBe(wrong);
    const raw = await fake.call("preview_change", { kind: "agent", id: agent.id, body: { system: `проверка ${SECRET}` } });
    expect(JSON.parse(raw.text).after_yaml).toContain(`проверка ${SECRET}`);
    expect(JSON.parse(raw.text).before_yaml).not.toContain(SECRET);
  });

  it("a schema error never repeats the received value", async () => {
    const { fake } = setup();
    const result = await fake.call("get", { kind: "agent", id: "x", version: { nested: SECRET } });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(SECRET);
    const write = await fake.call("update_harness_card", { harness_card_id: "hc_1", changes: { command: SECRET } });
    expect(write.text).not.toContain(SECRET);
  });

  it("never logs a known secret into the action log", async () => {
    const { fake } = setup();
    await fake.call("search_config", { query: SECRET });
    await fake.call("preview_change", { kind: "agent", body: { name: "x", model: "q", system: SECRET } });
    expect(JSON.stringify(fake.actionRows)).not.toContain(SECRET);
  });

  it("reads the known secrets anew on every call", async () => {
    const { fake } = setup();
    const file = fake.addFile("a.txt", new TextEncoder().encode("ротация new-secret-1"));
    const first = await fake.call("read_content", { kind: "file", id: file.id });
    expect(first.text).toContain("new-secret-1");
    const reads = fake.knownReads;
    fake.known.push("new-secret-1");
    const second = await fake.call("read_content", { kind: "file", id: file.id });
    expect(second.text).not.toContain("new-secret-1");
    expect(fake.knownReads).toBe(reads + 1);
  });
});
