import { describe, expect, it } from "vitest";
import { createFakePlatform, MEMBER } from "./helpers/platform-mcp-fake";

function setup() {
  const fake = createFakePlatform();
  fake.setupAssistant();
  return fake;
}

describe("platform MCP preview and confirm routes", () => {
  it("shows the card to every member and the buttons only to the owner", async () => {
    const fake = setup();
    const env = fake.addEnvironment({ name: "Песочница", description: "Старое" });
    const toolUseId = fake.propose("update_environment", { environment_id: env.id, changes: { description: "Новое" } });
    const owner = await fake.preview(toolUseId);
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ disabled: false, class: "update", can_confirm: true, pending: true, tool: "update_environment" });
    expect(owner.body.preview_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(owner.body.before_yaml).toContain("description: Старое");
    expect(owner.body.after_yaml).toContain("description: Новое");
    expect(owner.body.diff).toContain("+ description: Новое");
    const member = await fake.preview(toolUseId, MEMBER);
    expect(member.body).toMatchObject({ can_confirm: false, owner_name: "Анна" });
    expect(member.body.preview_digest).toBe(owner.body.preview_digest);
    const refused = await fake.confirm(toolUseId, { user: MEMBER, digest: owner.body.preview_digest });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe("Подтвердить может только Анна");
  });

  it("a deny from the card writes a denied row into the action log and calls no route", async () => {
    const fake = setup();
    const store = fake.addStore({ name: "Память" });
    const toolUseId = fake.propose("update_memory_store", { memory_store_id: store.id, name: "Новое" });
    const routeWrites = () => fake.writes().filter((call) => !call.path.endsWith("/events")).length;
    const before = routeWrites();
    const denied = await fake.confirm(toolUseId, { result: "deny", denyMessage: "не надо" });
    expect(denied.status).toBe(200);
    expect(routeWrites()).toBe(before);
    expect(fake.actionRows.filter((row) => row.toolUseId === toolUseId)).toEqual([
      expect.objectContaining({ tool: "update_memory_store", result: "denied", opIndex: 0, userId: "user_owner", errorMessage: "не надо" }),
    ]);
  });

  it("answers in the order not_pending, disabled, 404, class, secret, stale", async () => {
    const fake = setup();
    const store = fake.addStore({ name: "Память" });
    const done = fake.propose("update_memory_store", { memory_store_id: store.id, name: "Новое" });
    expect((await fake.confirm(done)).status).toBe(200);
    expect((await fake.confirm(done)).body.error.type).toBe("not_pending");

    const pending = fake.propose("update_memory_store", { memory_store_id: store.id, name: "Ещё" });
    const digest = (await fake.preview(pending)).body.preview_digest;
    fake.setEnabled(false);
    // The owner still sees the buttons: the card blocks «Применить» by `disabled` (1.4).
    expect((await fake.preview(pending)).body).toMatchObject({ disabled: true, can_confirm: true });
    const disabled = await fake.confirm(pending, { digest });
    expect([disabled.status, disabled.body.error.type]).toEqual([409, "disabled"]);
    fake.setEnabled(true);

    const missing = fake.propose("update_memory_store", { memory_store_id: "memstore_none", name: "x" });
    const notFound = await fake.confirm(missing);
    expect([notFound.status, notFound.body.error.type]).toEqual([404, "not_found"]);

    const archived = fake.addDeployment({ status: "paused", archived_at: "2026-10-01T00:00:00.000Z" });
    const unpaused = fake.propose("update_deployment", { deployment_id: archived.id, changes: { name: "x" } });
    const preview = await fake.preview(unpaused);
    expect(preview.body).toMatchObject({ class: "out_of_v1", reason: "Объект в архиве. В первой версии ассистент его не меняет" });
    const cls = await fake.confirm(unpaused);
    expect([cls.status, cls.body.error.type]).toEqual([409, "class"]);

    fake.known.push("long-secret-value-123");
    const secret = fake.propose("update_memory_store", { memory_store_id: store.id, description: "токен long-secret-value-123" });
    const secretPreview = await fake.preview(secret);
    expect(secretPreview.body.secret_in_args).toBe(true);
    expect(secretPreview.body.warnings).toContain("В черновике значение секрета пространства. Секрет задаётся только в хранилище секретов");
    expect(JSON.stringify(secretPreview.body)).not.toContain("long-secret-value-123");
    const secretConfirm = await fake.confirm(secret);
    expect([secretConfirm.status, secretConfirm.body.error.type]).toEqual([409, "secret"]);
    fake.known.push("abc");
    const short = fake.propose("update_memory_store", { memory_store_id: store.id, description: "abc" });
    expect((await fake.confirm(short)).status).toBe(200);

    const stale = fake.propose("update_memory_store", { memory_store_id: store.id, name: "Через минуту" });
    const old = (await fake.preview(stale)).body.preview_digest;
    fake.store(store.id).rev++;
    const staleConfirm = await fake.confirm(stale, { digest: old });
    expect([staleConfirm.status, staleConfirm.body.error.type]).toEqual([409, "stale"]);
    expect(staleConfirm.body.preview.preview_digest).not.toBe(old);
    expect((await fake.confirm(stale, { digest: staleConfirm.body.preview.preview_digest })).status).toBe(200);
  });

  it("refuses stale arguments and a schema error", async () => {
    const fake = setup();
    const agent = fake.addAgent({ name: "Сводка" });
    const stale = fake.propose("update_agent", { agent_id: agent.id, expected_version: 5, changes: { system: "x" } });
    expect((await fake.preview(stale)).body.args_stale).toBe(true);
    expect((await fake.confirm(stale)).body.error.type).toBe("stale");
    const card = fake.addModelCard({ id: "mc_1" });
    const address = fake.propose("update_model_card", { model_card_id: card.id, changes: { base_url: "http://evil.example" } });
    const preview = await fake.preview(address);
    expect(preview.body.schema_error).toContain("base_url");
    expect(preview.body.schema_error).not.toContain("evil.example");
    expect((await fake.confirm(address)).body.error.type).toBe("schema");
    expect(fake.writes().filter((call) => call.path.startsWith("/v1/oma/model_cards"))).toHaveLength(0);
  });

  it("refuses a session with a wrong tool set", async () => {
    const fake = setup();
    const store = fake.addStore({ name: "Память" });
    const toolUseId = fake.propose("update_memory_store", { memory_store_id: store.id, name: "x" });
    fake.setToolCheck({ ok: false, message: "В сессии ассистента есть встроенные инструменты" });
    expect((await fake.preview(toolUseId)).status).toBe(403);
    expect((await fake.confirm(toolUseId, { digest: "x" })).status).toBe(403);
  });

  it("deletes the row when the confirmation event fails and keeps the event id otherwise", async () => {
    const fake = setup();
    const store = fake.addStore({ name: "Память" });
    const toolUseId = fake.propose("update_memory_store", { memory_store_id: store.id, name: "x" });
    const realFetch = fake.deps.innerFetch;
    fake.hooks.afterConfirm = () => {
      fake.deps.innerFetch = async () => new Response("{}", { status: 500 });
    };
    const failed = await fake.confirm(toolUseId);
    fake.deps.innerFetch = realFetch;
    fake.hooks.afterConfirm = undefined;
    expect(failed.status).toBe(502);
    expect(fake.confirmationRows).toHaveLength(0);
    const ok = await fake.confirm(toolUseId);
    expect(ok.status).toBe(200);
    const event = fake.events("sesn_assistant").at(-1)!;
    expect(event).toMatchObject({ type: "user.tool_confirmation", result: "allow", tool_use_id: toolUseId });
    expect(fake.confirmationRows[0]).toMatchObject({ eventId: event.id, opClasses: ["update"], targetRevisions: ['"1"'] });
  });
});
