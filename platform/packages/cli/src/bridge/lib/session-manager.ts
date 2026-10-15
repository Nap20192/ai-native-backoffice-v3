/**
 * SessionManager — owns the ACP child processes the daemon is currently
 * running on this machine. Slice-2 minimum: one ACP runtime per session
 * (i.e. one child process per session).
 *
 * Wire protocol (over the daemon ↔ control-plane WS, see daemon.ts):
 *
 *   Server → Daemon
 *     session.start    { session_id, agent_id, cwd?, resume? }
 *     session.prompt   { session_id, turn_id, text }
 *     session.cancel   { session_id, turn_id }
 *     session.dispose  { session_id }
 *
 *   Daemon → Server
 *     session.ready    { session_id, acp_session_id }
 *     session.event    { session_id, turn_id, event }
 *     session.complete { session_id, turn_id }
 *     session.error    { session_id, turn_id?, message }
 *     session.disposed { session_id }
 *
 * Idempotency: session.start is idempotent. If a session is already running
 * for the given session_id, we reply with session.ready immediately and skip
 * the spawn. This lets the harness on the cloud side fire session.start at
 * the top of every turn without keeping its own "first turn" state.
 *
 * OMA-specific:
 *   - On session.start we fetch the bundle (AGENTS.md + skills) from
 *     main and materialize it into the scratch dir before issuing
 *     session/new. A platform `cwd` changes only the ACP process cwd, and
 *     only inside the owner's OMA_BRIDGE_CWD_ROOTS (spawn-guard.ts).
 *   - The OMA `oma_*` PAT is passed to the ACP child as `mcpServers[].
 *     authorization_token` for each remote MCP server in the agent config.
 *     URLs in the bundle are already rewritten to point at OMA's mcp-proxy.
 */

import { spawn as childSpawn } from "node:child_process";
import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import { resolveKnownAgent } from "@open-managed-agents/acp-runtime/registry";
import type {
  AcpRuntime,
  AcpSession,
  SessionOptions,
} from "@open-managed-agents/acp-runtime";
import {
  createManagedAgentsRuntime,
  type ManagedAgentsRuntime,
  type ManagedAgentsRuntimeScheduler,
} from "@open-managed-agents/runtime";
import {
  encodeSessionHostEvent,
  type SessionHostEvent,
  type SessionStartCommand,
} from "@openma/common/session-kernel";
import {
  acpSessionReadyOut,
  removeSessionCwd,
  sessionScratchDirPath,
} from "./session-cwd.js";
import { buildAcpSpawnPlan } from "./spawn-plan.js";

export interface SessionStartParams {
  session_id: string;
  agent_id: string;
  /** Tenant pinning this session at the server. Required since step 3 of
   *  the multi-tenant rollout — the server injects it from
   *  x-harness-tenant on every session.start. Optional in the type to
   *  tolerate degraded v1 servers (would never happen against current
   *  main) — when missing we fall back to the first tenant in the map. */
  tenant_id?: string;
  cwd?: string;
  resume?: { acp_session_id: string };
}

export interface SessionPromptParams {
  session_id: string;
  turn_id: string;
  /** Server-injected (see SessionStartParams.tenant_id). Not load-bearing
   *  here — we just resolve the active session by session_id. Carried in
   *  the type so the daemon receives it without TS noise. */
  tenant_id?: string;
  text: string;
}

export type ManagerOut =
  | {
      type: "session.ready";
      session_id: string;
      tenant_id: string;
      acp_session_id: string;
      bundle_dir?: string;
      fresh?: boolean;
    }
  | { type: "session.event"; session_id: string; tenant_id: string; turn_id: string; event: unknown }
  | { type: "session.complete"; session_id: string; tenant_id: string; turn_id: string }
  | { type: "session.error"; session_id: string; tenant_id?: string; turn_id?: string; message: string }
  | { type: "session.disposed"; session_id: string; tenant_id: string };

export type Sender = (msg: ManagerOut) => void;

interface ActiveSession {
  acp: AcpSession;
  acpSessionId: string;
  /** Tenant this session was pinned to at session.start. Used to look up
   *  the right `oma_*` key for the spawned ACP child's MCP headers and
   *  to stamp `tenant_id` on every outbound session-scoped message. */
  tenantId: string;
  turns: Map<string, AbortController>;
}

export interface SessionManagerEnv {
  /** OMA server URL, e.g. https://app.openma.dev. Used to fetch session
   *  bundle and as the base for mcp-proxy URLs we send into mcpServers. */
  apiUrl: string;
  /** Runtime token (`sk_machine_*`) — daemon's bearer for /agents/runtime/*
   *  endpoints. The bundle fetch authenticates with this. */
  runtimeToken: string;
}

export interface SessionManagerRuntimeScope {
  id: string;
  agentApiKey: string;
}

export interface SessionManagerPreparationInput {
  command: SessionStartCommand;
  scope: SessionManagerRuntimeScope;
  environment: SessionManagerEnv;
}

export interface SessionManagerRuntimeDependencies {
  acpRuntime: AcpRuntime;
  prepareSession(input: SessionManagerPreparationInput): Promise<SessionOptions>;
  releaseSession?(sessionId: string): Promise<void>;
  /** Test/platform clock for bounded cancel and drain waits. */
  runtimeScheduler?: ManagedAgentsRuntimeScheduler;
  /** Grace before an ACP child that ignores session/cancel is disposed.
   * Production defaults to 2s; platforms may tune it explicitly. */
  cancelGraceMs?: number;
}

export class SessionManager {
  #send: Sender;
  #spawner = new NodeSpawner();
  #runtime = createAcpRuntime({ type: "local", spawner: this.#spawner });
  #sessions = new Map<string, ActiveSession>();
  #env: SessionManagerEnv = { apiUrl: "", runtimeToken: "" };
  /**
   * Per-tenant `oma_*` keys, keyed by tenant_id. Populated by the daemon
   * at startup from CredentialsV2.tenants and refreshed on SIGHUP after
   * `oma bridge refresh` rotates them server-side. Empty until the
   * daemon calls `setTenantKeys()`.
   */
  #tenantKeys = new Map<string, string>();
  #managedRuntime: ManagedAgentsRuntime | undefined;
  #runtimeDependencies: SessionManagerRuntimeDependencies | undefined;
  #runtimeScopes = new Map<string, SessionManagerRuntimeScope>();
  /** Set by `drain()` to refuse new session.start while in-flight turns
   *  finish. Existing sessions keep accepting prompts so a user mid-turn
   *  doesn't hit "session not ready" mid-stream just because the daemon
   *  is on its way out. */
  #draining = false;
  /** Sessions awaiting their first session.ready on the managed runtime path. */
  #freshSpawnPending = new Set<string>();

  constructor(send: Sender, runtimeDependencies?: SessionManagerRuntimeDependencies) {
    this.#send = send;
    if (runtimeDependencies) {
      this.#runtimeDependencies = runtimeDependencies;
      this.#managedRuntime = createManagedAgentsRuntime({
        acpRuntime: runtimeDependencies.acpRuntime,
        cancelGraceMs: runtimeDependencies.cancelGraceMs ?? 2_000,
        scheduler: runtimeDependencies.runtimeScheduler,
        sessionPreparation: {
          prepare: (command) => {
            const scope = this.#runtimeScopes.get(command.sessionId);
            if (!scope) {
              throw new Error(`missing runtime scope for session ${command.sessionId}`);
            }
            return runtimeDependencies.prepareSession({
              command,
              scope,
              environment: { ...this.#env },
            });
          },
        },
      });
      this.#attachManagedRuntime();
    }
  }

  #attachManagedRuntime(): void {
    this.#managedRuntime?.attach({
      publish: (event) => this.#publishManagedRuntimeEvent(event),
    });
  }

  #publishManagedRuntimeEvent(event: SessionHostEvent): void {
    const scope = this.#runtimeScopes.get(event.sessionId);
    if (event.type === "session.ready" && this.#freshSpawnPending.delete(event.sessionId)) {
      this.#send(acpSessionReadyOut({
        session_id: event.sessionId,
        tenant_id: scope?.id ?? "",
        acp_session_id: event.acpSessionId,
        scratchDir: sessionScratchDirPath(event.sessionId),
        freshSpawn: true,
      }));
    } else {
      this.#send(encodeSessionHostEvent(event, {
        tenantId: scope?.id,
      }) as ManagerOut);
    }
    if (event.type === "session.disposed") {
      this.#runtimeScopes.delete(event.sessionId);
      this.#freshSpawnPending.delete(event.sessionId);
    }
    if (event.type === "session.error") {
      this.#freshSpawnPending.delete(event.sessionId);
    }
  }

  setSpawnEnv(env: SessionManagerEnv): void {
    this.#env = env;
  }

  /**
   * Replace the in-memory map of tenant_id → `oma_*` PAT. Called once at
   * daemon startup from CredentialsV2.tenants, and again on SIGHUP after
   * the user runs `oma bridge refresh` (so newly-added tenants become
   * sessionable without a daemon restart, and revoked tenants stop being
   * accepted).
   *
   * Existing sessions are NOT torn down — a session pinned to a tenant
   * that was just removed keeps running until the harness disposes it.
   * The lookup is consulted per session.start, not per turn.
   */
  setTenantKeys(tenants: Array<{ id: string; agentApiKey: string }>): void {
    this.#tenantKeys.clear();
    for (const t of tenants) this.#tenantKeys.set(t.id, t.agentApiKey);
  }

  setSender(send: Sender): void {
    this.#send = send;
    this.#attachManagedRuntime();
  }

  has(session_id: string): boolean {
    if (this.#managedRuntime) return this.#managedRuntime.hasSession(session_id);
    return this.#sessions.has(session_id);
  }

  /** Sum of in-flight turns across all sessions. A turn registers itself
   *  in `sess.turns` when `prompt()` starts and removes itself in the
   *  finally block when the ACP child finishes streaming. drain() polls
   *  this to know when it's safe to exit. */
  activeTurnCount(): number {
    if (this.#managedRuntime) return this.#managedRuntime.activeTurnCount();
    let n = 0;
    for (const s of this.#sessions.values()) n += s.turns.size;
    return n;
  }

  sessionCount(): number {
    if (this.#managedRuntime) return this.#managedRuntime.sessionCount();
    return this.#sessions.size;
  }

  /** Re-announce alive sessions to the server (used after WS reconnect). */
  announceAll(): void {
    if (this.#managedRuntime) {
      this.#managedRuntime.announceAll();
      return;
    }
    for (const [session_id, sess] of this.#sessions) {
      this.#send(acpSessionReadyOut({
        session_id,
        tenant_id: sess.tenantId,
        acp_session_id: sess.acpSessionId,
      }));
    }
  }

  async start(p: SessionStartParams): Promise<void> {
    // Refuse new sessions while we're draining for shutdown — the
    // server will see the error, mark the runtime briefly offline, and
    // route the next session.start to whichever daemon comes up next.
    // Existing sessions in this.#sessions keep working until drain
    // either completes them or hits the deadline.
    if (this.#draining) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        turn_id: "",
        message: "daemon draining for restart — retry in a few seconds",
      });
      return;
    }
    // Resolve the per-tenant API key BEFORE the idempotent-replay check
    // so a stale daemon (no key for a freshly-authorized tenant) emits a
    // clean "run oma bridge refresh" error rather than silently re-acking
    // a session that would later spawn with the wrong (or no) credential.
    // Missing tenant_id is a degraded-server signal — fall back to the
    // first tenant in the map and log a warning so it's debuggable.
    let tenantId = p.tenant_id ?? "";
    let tenantKey = tenantId ? this.#tenantKeys.get(tenantId) : undefined;
    if (!tenantId) {
      const fallback = this.#tenantKeys.keys().next();
      if (!fallback.done) {
        tenantId = fallback.value;
        tenantKey = this.#tenantKeys.get(tenantId);
        process.stderr.write(
          `  ! session.start missing tenant_id; falling back to first tenant ${tenantId.slice(0, 8)}…\n`,
        );
      }
    }
    if (!tenantKey) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        tenant_id: p.tenant_id,
        message:
          `Tenant ${p.tenant_id ?? "(unspecified)"} not authorized for this runtime — ` +
          `run 'oma bridge refresh'`,
      });
      return;
    }
    // Diagnostic line — helps operators trace per-session tenant routing
    // in multi-tenant setups. Tenant id is logged for debuggability; the
    // key plaintext is NEVER logged (only its presence is implicit from
    // not erroring out above).
    process.stderr.write(
      `  → tenant-key selected sid=${p.session_id.slice(0, 8)} tenant=${tenantId.slice(0, 14)}\n`,
    );
    if (this.#managedRuntime) {
      if (!this.#managedRuntime.hasSession(p.session_id)) {
        this.#runtimeScopes.set(p.session_id, {
          id: tenantId,
          agentApiKey: tenantKey,
        });
        this.#freshSpawnPending.add(p.session_id);
      }
      await this.#managedRuntime.dispatch({
        type: "session.start",
        sessionId: p.session_id,
        agentId: p.agent_id,
        runtime: "local",
        ...(p.cwd ? { cwd: p.cwd } : {}),
        ...(p.resume?.acp_session_id
          ? { acpSessionId: p.resume.acp_session_id }
          : {}),
      });
      return;
    }
    // Idempotent: if we already have this session, just re-ack ready.
    const existing = this.#sessions.get(p.session_id);
    if (existing) {
      this.#send(acpSessionReadyOut({
        session_id: p.session_id,
        tenant_id: existing.tenantId,
        acp_session_id: existing.acpSessionId,
      }));
      return;
    }

    // Canonicalize: an AgentConfig row may carry a pre-A2 alias (e.g.
    // "claude-code-acp" or "codex-cli"); resolveKnownAgent maps it to
    // the current canonical entry so the rest of the spawn logic stays
    // alias-blind.
    const agent = resolveKnownAgent(p.agent_id);
    if (!agent) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        message: `unknown ACP agent: ${p.agent_id}`,
      });
      return;
    }
    if (agent.id !== p.agent_id) {
      process.stderr.write(
        `  ↪ canonicalized acp_agent_id ${p.agent_id} → ${agent.id} (legacy alias)\n`,
      );
    }

    // Verify the canonical binary is on PATH before spawning. Pre-A2 we
    // also tried a `legacySpec` fallback; that's been removed because it
    // hid the real problem (deprecated wrapper packages have known
    // protocol bugs) and because the daemon's detect() now reports
    // honestly — if an agent isn't on PATH the user shouldn't have been
    // able to pick it in the Console at all. Defense in depth: still
    // surface a clean error here in case detection went stale (e.g.
    // user uninstalled mid-session).
    const onPath = await new Promise<boolean>((resolve) => {
      const probe = process.platform === "win32" ? "where" : "which";
      const p = childSpawn(probe, [agent.spec.command], { stdio: "ignore" });
      p.once("error", () => resolve(false));
      p.once("exit", (code) => resolve(code === 0));
    });
    if (!onPath) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        message:
          `binary not on PATH for ${agent.id}: \`${agent.spec.command}\`` +
          (agent.installHint ? `. Install: ${agent.installHint}` : ""),
      });
      return;
    }

    let plan: Awaited<ReturnType<typeof buildAcpSpawnPlan>>;
    try {
      plan = await buildAcpSpawnPlan({
        sessionId: p.session_id,
        agentId: agent.id,
        agentEnv: agent.spec.env,
        requestedCwd: p.cwd,
        environment: this.#env,
        agentApiKey: tenantKey,
      });
    } catch (e) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        tenant_id: tenantId,
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    try {
      const session = await this.#runtime.start({
        agent: {
          ...agent.spec,
          cwd: plan.cwd,
          env: plan.env,
        },
        mcpServers: plan.mcpServers,
        resumeAcpSessionId: p.resume?.acp_session_id,
      });
      this.#sessions.set(p.session_id, {
        acp: session,
        acpSessionId: session.acpSessionId,
        tenantId,
        turns: new Map(),
      });
      this.#send(acpSessionReadyOut({
        session_id: p.session_id,
        tenant_id: tenantId,
        acp_session_id: session.acpSessionId,
        scratchDir: plan.scratchDir,
        freshSpawn: true,
      }));
    } catch (e) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        tenant_id: tenantId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async prompt(p: SessionPromptParams): Promise<void> {
    if (this.#managedRuntime) {
      await this.#managedRuntime.dispatch({
        type: "session.prompt",
        sessionId: p.session_id,
        turnId: p.turn_id,
        text: p.text,
      });
      return;
    }
    const sess = this.#sessions.get(p.session_id);
    if (!sess) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        tenant_id: p.tenant_id,
        turn_id: p.turn_id,
        message: "no such session",
      });
      return;
    }
    const ctrl = new AbortController();
    sess.turns.set(p.turn_id, ctrl);
    let promptErr: string | null = null;
    try {
      for await (const ev of sess.acp.prompt(p.text, { abortSignal: ctrl.signal })) {
        if (ctrl.signal.aborted) break;
        const t = (ev as { type?: string; error?: string } | null | undefined)?.type;
        // AcpSession yields sentinel events at the end of the stream:
        //   { type: "promptComplete", response }  → ACP returned cleanly
        //   { type: "promptError", error }        → ACP returned a JSON-RPC error
        // The latter often carries the *only* signal that the turn failed
        // (e.g. wrong model id, auth missing) — silently skipping it would
        // make session.complete arrive as if everything worked.
        if (t === "promptComplete") {
          // Preserve the standard ACP PromptResponse (including experimental
          // cache token usage) through the product-neutral relay. The cloud
          // harness consumes this terminal sentinel before session.complete.
          this.#send({
            type: "session.event",
            session_id: p.session_id,
            tenant_id: sess.tenantId,
            turn_id: p.turn_id,
            event: ev,
          });
          continue;
        }
        if (t === "promptError") {
          promptErr = (ev as { error?: string }).error ?? "ACP prompt error (no message)";
          continue;
        }
        this.#send({
          type: "session.event",
          session_id: p.session_id,
          tenant_id: sess.tenantId,
          turn_id: p.turn_id,
          event: ev,
        });
      }
      if (promptErr) {
        this.#send({
          type: "session.error",
          session_id: p.session_id,
          tenant_id: sess.tenantId,
          turn_id: p.turn_id,
          message: promptErr,
        });
      } else {
        this.#send({ type: "session.complete", session_id: p.session_id, tenant_id: sess.tenantId, turn_id: p.turn_id });
      }
    } catch (e) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        tenant_id: sess.tenantId,
        turn_id: p.turn_id,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      sess.turns.delete(p.turn_id);
    }
  }

  cancel(session_id: string, turn_id: string): void {
    if (this.#managedRuntime) {
      void this.#managedRuntime.dispatch({
        type: "session.cancel",
        sessionId: session_id,
        turnId: turn_id,
      });
      return;
    }
    const sess = this.#sessions.get(session_id);
    if (!sess) return;
    sess.turns.get(turn_id)?.abort();
  }

  async dispose(session_id: string): Promise<void> {
    if (this.#managedRuntime) {
      await this.#managedRuntime.dispatch({
        type: "session.dispose",
        sessionId: session_id,
      });
      await (this.#runtimeDependencies?.releaseSession?.(session_id)
        ?? removeSessionCwd(session_id));
      return;
    }
    const sess = this.#sessions.get(session_id);
    // Capture tenantId before #killChild deletes the session entry — the
    // outbound session.disposed must still carry the pin so the server-side
    // tenant validation round-trip passes.
    const tenantId = sess?.tenantId ?? "";
    await this.#killChild(session_id);
    // Drop the spawn cwd — session is dead at the platform; transcripts /
    // AGENTS.md / .claude/skills/ are no longer load-bearing.
    await removeSessionCwd(session_id);
    this.#send({ type: "session.disposed", session_id, tenant_id: tenantId });
  }

  /** Best-effort cleanup on daemon shutdown. KEEPS spawn cwds — sessions are
   *  still live at the platform; the daemon coming back tomorrow needs the
   *  same dirs to spawn fresh ACP children with the same transcripts. */
  async disposeAll(): Promise<void> {
    if (this.#managedRuntime) {
      await this.#managedRuntime.drain({ deadlineMs: 0, abortGraceMs: 0 });
      return;
    }
    const ids = [...this.#sessions.keys()];
    await Promise.all(ids.map((id) => this.#killChild(id)));
  }

  /**
   * Graceful drain for upgrade/restart. Caller (daemon SIGTERM handler)
   * awaits this before exiting so in-flight ACP turns get to finish
   * naturally instead of being SIGTERM'd mid-stream.
   *
   * Recovery model — mirrors the cloud agent's DO-eviction recovery
   * (apps/agent/src/runtime/turn-runtime.ts:268 recoverAgentTurn):
   *
   *   1. Set #draining → start() rejects new sessions; server retries.
   *   2. Poll activeTurnCount every 200ms until either:
   *        - all turns drained naturally (clean session.complete) → break
   *        - deadline elapsed → abort remaining turns. Their prompt()
   *          loops unwind, emit session.error, and the ACP children
   *          checkpoint their conversation state to disk (each ACP
   *          implementation owns its own persistence; e.g. claude-acp
   *          stores into ~/.claude/projects/...).
   *   3. disposeAll() — KEEPS spawn cwds. Same shape as a clean
   *      shutdown.
   *
   * The next time the server sends session.start for any of these ids
   * it includes `resume.acp_session_id`. The new daemon respawns a
   * fresh ACP child in the preserved cwd and calls session/load to
   * restore conversation history (session-manager.ts:311 →
   * session.ts:108). Worst case the user re-prompts the cut-off turn;
   * partial response on their screen is the only artifact.
   *
   * Idempotent: a second call while one is in progress no-ops past the
   * existing drain.
   */
  async drain(deadlineMs: number, opts?: { onProgress?: (active: number, msLeft: number) => void }): Promise<{ initialTurns: number; abortedTurns: number; sessions: number }> {
    if (this.#managedRuntime) {
      return this.#managedRuntime.drain({
        deadlineMs,
        onProgress: opts?.onProgress,
      });
    }
    if (this.#draining) {
      const t0 = Date.now();
      while (this.#sessions.size > 0 && Date.now() - t0 < deadlineMs) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return { initialTurns: 0, abortedTurns: 0, sessions: 0 };
    }
    this.#draining = true;
    const initialTurns = this.activeTurnCount();
    const initialSessions = this.#sessions.size;
    const t0 = Date.now();
    while (this.activeTurnCount() > 0) {
      const elapsed = Date.now() - t0;
      if (elapsed >= deadlineMs) break;
      opts?.onProgress?.(this.activeTurnCount(), deadlineMs - elapsed);
      await new Promise((r) => setTimeout(r, 200));
    }
    // Anything still streaming at deadline: abort the model call. The
    // ACP child sees the cancellation, checkpoints whatever conversation
    // state it tracks to its own on-disk store, and is then disposed by
    // disposeAll below. Recovery happens on the next session.start with
    // resume.acp_session_id (see method-level docstring).
    let aborted = 0;
    for (const sess of this.#sessions.values()) {
      for (const ctrl of sess.turns.values()) {
        ctrl.abort();
        aborted += 1;
      }
    }
    if (aborted > 0) {
      // Brief grace so each ACP child can flush its checkpoint to disk
      // before its stdio gets torn down by dispose. ~2s is generous —
      // claude-acp / codex-acp / opencode all persist on every event,
      // not at end-of-turn, so the on-disk state is already current.
      await new Promise((r) => setTimeout(r, 2000));
    }
    await this.disposeAll();
    return { initialTurns, abortedTurns: aborted, sessions: initialSessions };
  }

  /** Kill the ACP child + drop in-memory state. Does NOT touch the spawn
   *  cwd — caller decides whether the cwd should outlive this. */
  async #killChild(session_id: string): Promise<void> {
    const sess = this.#sessions.get(session_id);
    if (!sess) return;
    for (const ctrl of sess.turns.values()) ctrl.abort();
    await sess.acp.dispose().catch(() => undefined);
    this.#sessions.delete(session_id);
  }
}
