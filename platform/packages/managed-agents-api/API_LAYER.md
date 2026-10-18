# Managed Agents API layer

This package is the new public HTTP adapter for Open Managed Agents. Its wire
contract is the API generated into `@anthropic-ai/sdk@0.120.0`; the old OMA
route and DTO implementations are not a compatibility source.

## Fixed decisions

- The public paths remain `/v1/*`. `client.beta` and `?beta=true` select beta
  behavior; they do not introduce a `/v2` path.
- Each resource has an independent application port. The root port only
  composes resource ports. The application core owns every Port in
  `managed-agents-application/src/ports`; files under this package's `ports/`
  are compatibility re-exports and may not declare boundary types.
- Port definitions contain plain application data only. They may not import the
  Anthropic SDK, Hono, Zod, or wire-contract modules, and they may not use
  `any` or `unknown`. Glob-based boundary tests scan the application-owned
  Port files and the API compatibility surface, so a new Port cannot silently
  bypass the rule.
- The application package may never import this API package. HTTP depends on
  the inbound use-case Port; persistence and runtime adapters implement
  outbound Ports owned by the same inner application package.
- Port property declarations use application-native camelCase. snake_case
  properties are rejected by the boundary test; protocol discriminator values
  such as `session.thread_status_idle` remain unchanged because they are domain
  values, not DTO field names.
- Wire names stop at mappers. HTTP `mcp_servers`, `next_page`, and `version`
  become application `mcpServers`, `nextCursor`, and `expectedVersion`.
- Expected business outcomes are discriminated unions. Absence, validation,
  and optimistic conflicts are not encoded as `null` or inferred from thrown
  exceptions.
- Requests are validated before a port runs. Port output is mapped and
  validated again before it is emitted.
- Tenant and workspace scope are resolved after upstream authentication, once
  per request. Every route adapter accepts either a Port or the shared
  `ApplicationPortResolver<Port>`; `buildManagedAgentsApi` accepts the same
  source shape for every resource through a mapped composition type. Resolver
  functions belong to the HTTP adapter and never become part of an application
  Port. A source-level architecture test rejects any route that bypasses the
  current Hono context when resolving its Port.
- Managed Agents endpoints require their SDK beta header. Other beta surfaces
  retain their own header (`files-api-2025-04-14`, `skills-2025-10-02`, or
  `agent-memory-2026-07-22`) instead of sharing one global gate.
- Errors use the Anthropic envelope and status pairing:
  `invalid_request_error`/400, `not_found_error`/404,
  `conflict_error`/409, and `api_error`/500.
- Cursor ports use semantic names (`pageSize`, `cursor`). HTTP responses use
  the SDK-specific envelope and field names.
- Streaming endpoints are separate ports returning an API-neutral event
  stream. SSE framing belongs to the HTTP adapter.
- A route adapter receives only the Port it calls. Session CRUD and session
  events are separate adapters mounted at the same `/v1/sessions` prefix;
  neither receives the other's capability.
- OMA-only fields and endpoints live outside this package and never appear as
  optional extensions on Managed Agents DTOs.

## Layer shape

```text
@anthropic-ai/sdk request
  -> Hono route + beta gate
  -> strict wire schema
  -> explicit wire-to-application mapper
  -> resource application port
  -> explicit application-to-wire mapper
  -> strict egress schema
  -> Anthropic response / error / stream
```

The SDK is permitted in `contracts/`, `mappers/`, and contract tests. It is
forbidden in application Ports, domain, runtime, and persistence layers.

## Endpoint build order

Every endpoint is added outside-in: an official SDK contract test must fail on
the missing behavior before the route is implemented.

1. Agents: create, retrieve, update, list, archive, versions.list. Completed.
2. Sessions: create, retrieve, update, list, delete, archive, events, resources,
   threads and thread events (including both streaming endpoints). Completed.
3. Environments and self-hosted work. Completed.
4. Vaults and credentials. Completed.
5. Files, skills and skill versions, and memory stores/memories/versions, each
   with its own beta header. Completed.
6. Deployments and deployment runs, user profiles, tunnels and tunnel
   certificates, and dreams. Completed.

The pinned SDK's `beta.messages` and `beta.models` resources are the base
Anthropic API rather than Managed Agents application resources. `beta.webhooks`
only exposes local signature unwrapping and sends no HTTP request. They are
therefore outside this adapter's resource-port inventory.

## Completed Agent surface

| SDK operation | Method and path | Application port method |
| --- | --- | --- |
| `agents.create` | `POST /v1/agents` | `createAgent` |
| `agents.retrieve` | `GET /v1/agents/:agent_id` | `retrieveAgent` |
| `agents.update` | `POST /v1/agents/:agent_id` | `updateAgent` |
| `agents.list` | `GET /v1/agents` | `listAgents` |
| `agents.archive` | `POST /v1/agents/:agent_id/archive` | `archiveAgent` |
| `agents.versions.list` | `GET /v1/agents/:agent_id/versions` | `listAgentVersions` |

### Multiagent block

The `multiagent` field of an Agent takes the CMA type `multiagent_20261001`
next to `coordinator` on create and update, and the Agent reads it back.
Here the Agent wire leaves SDK 0.120: SDK 0.120 and 0.129 know only
`coordinator` (owner decision 3 of `docs/plans/multiagent.md`, section 3.2).
The wire type is our own (`AgentMultiagentBody` in `contracts/agents.ts`),
declared like `_oma` of an agent. The `coordinator` form stays as the SDK has
it.

- The block holds three settings. `subagents` and `workflows` are
  `{type: "enabled", inline_agents, predefined_agents}` or
  `{type: "disabled"}`. `advisor` is `{type: "enabled", model}` or
  `{type: "disabled"}`.
- A setting or field left out or sent as null takes its default: `subagents`
  and `workflows` enabled with `inline_agents: {type: "enabled"}` and an
  empty list, `advisor` disabled. The Agent reads the block back with every
  default filled in.
- A list entry is an agent id, `{type: "agent", id}`,
  `{type: "agent", id, version}` or `{type: "self"}`. The service pins every
  entry to a version when it saves the block. `self` reads back as the
  Agent's own id and version.
- These answer 400 `invalid_request_error`: more than 20 agents in one list;
  the same agent twice in one list; a listed agent that is missing, archived
  or has its own `multiagent` block; `inline_agents` disabled with an empty
  list; an enabled advisor without `model`; a listed agent named
  `anthropic.advisor` while the advisor is enabled; an own custom tool whose
  name starts with `ant__` while `workflows` is enabled. The last check reads
  the Agent as it stands after the request, so an update that leaves the
  block alone still checks the tools it sends.
- An update follows the CMA edit rules. A `multiagent_20261001` block sent
  to an Agent that has one changes only what it sends: a setting or field
  left out keeps its value, null takes the default, a sent list replaces the
  old one whole, and a setting of another `type` is replaced with its
  defaults. A kept list keeps its pins, and the checks that read the rest of
  the block run on the block as it stands after the update: `inline_agents`
  disabled with an empty list, and an advisor turned on over a kept agent
  named `anthropic.advisor`. Any other update replaces the whole block, so a
  change between `coordinator` and `multiagent_20261001` keeps nothing of
  the old block. A `coordinator` block sent to a `coordinator` Agent replaces
  it whole, as before.
- A Session copies the block when it is created and keeps its type. The
  `agent.multiagent` of a Session is the Agent block with every listed agent
  in full, as `coordinator` lists them: the same fields as a Session thread
  agent, at the pinned version. A pinned agent that is gone fails the create
  as before.
- The turn reads both types through one view (`effectiveMultiagent` in
  `managed-agents-application`). `coordinator` reads as `subagents` without
  inline agents, with `workflows` disabled and the advisor of its roster
  entry. The agents of an enabled `subagents` list are the callable agents
  of the turn. The `workflows` list never is.
- Not yet: the turn runs neither workflows nor inline agents. `workflows` is
  stored and copied only (owner decision 4), and `inline_agents` waits for
  step 5 of the plan.

## Completed top-level Session surface

| SDK operation | Method and path | Application port method |
| --- | --- | --- |
| `sessions.create` | `POST /v1/sessions` | `createSession` |
| `sessions.retrieve` | `GET /v1/sessions/:session_id` | `retrieveSession` |
| `sessions.update` | `POST /v1/sessions/:session_id` | `updateSession` |
| `sessions.list` | `GET /v1/sessions` | `listSessions` |
| `sessions.delete` | `DELETE /v1/sessions/:session_id` | `deleteSession` |
| `sessions.archive` | `POST /v1/sessions/:session_id/archive` | `archiveSession` |

Session list uses the SDK's bidirectional page envelope (`next_page` and
`prev_page`). Array filters follow Stainless query serialization; for example,
`statuses` arrives as repeated `statuses[]` query keys.

Nested session event ports must model the complete discriminated event union in
application-native names. Passing SDK event objects or untyped JSON through a
port is explicitly not an acceptable shortcut.

## Completed nested Session surface

| SDK operation | Method and path | Application port method |
| --- | --- | --- |
| `sessions.events.list` | `GET /v1/sessions/:session_id/events` | `listSessionEvents` |
| `sessions.events.send` | `POST /v1/sessions/:session_id/events` | `sendSessionEvents` |
| `sessions.events.stream` | `GET /v1/sessions/:session_id/events/stream` | `streamSessionEvents` |
| `sessions.resources.list` | `GET /v1/sessions/:session_id/resources` | `listSessionResources` |
| `sessions.resources.add` | `POST /v1/sessions/:session_id/resources` | `addSessionFileResource` |
| `sessions.resources.retrieve` | `GET /v1/sessions/:session_id/resources/:resource_id` | `retrieveSessionResource` |
| `sessions.resources.update` | `POST /v1/sessions/:session_id/resources/:resource_id` | `updateSessionResource` |
| `sessions.resources.delete` | `DELETE /v1/sessions/:session_id/resources/:resource_id` | `deleteSessionResource` |
| `sessions.threads.list` | `GET /v1/sessions/:session_id/threads` | `listSessionThreads` |
| `sessions.threads.retrieve` | `GET /v1/sessions/:session_id/threads/:thread_id` | `retrieveSessionThread` |
| `sessions.threads.archive` | `POST /v1/sessions/:session_id/threads/:thread_id/archive` | `archiveSessionThread` |
| `sessions.threads.events.list` | `GET /v1/sessions/:session_id/threads/:thread_id/events` | `listSessionThreadEvents` |
| `sessions.threads.events.stream` | `GET /v1/sessions/:session_id/threads/:thread_id/stream` | `streamSessionThreadEvents` |

Session and thread stream ports expose `AsyncIterable<StreamSessionEvent>`.
Only the HTTP adapter knows about SSE framing and the required `event:` line.
Event history covers the SDK's complete 35-variant union; `event_start` and
`event_delta` are stream-only additions and never appear in history pages.

Contract tests call the real SDK against the in-process Hono adapter without
rewriting paths. This catches method, URL, beta header, query serialization,
pagination envelope, response shape, and SDK error-class drift.

### Thread of a call answer

`user.tool_confirmation` and `user.custom_tool_result` accept an optional
`session_thread_id` on send. Here the events send wire leaves SDK 0.120. The
field is not an OMA invention: CMA routes an answer to a subagent thread by it
and records it on the event, but the SDK has it on the recorded event only.
The wire type is our own (`OpenMaSendableEventParams` in
`contracts/session-event-inputs.ts`), declared like `_oma` of an agent. SDK
0.129 still lacks the field (owner decision 3 of `docs/plans/multiagent.md`).

- The field must name the thread of the call. A call in another thread, or a
  call this Session does not have, answers 400 `invalid_request_error`.
- Without the field the service takes the thread from the call and records it.
  An answer to a primary call carries no thread, the same as before.
- Until step 3 of the plan, both answers execute in the primary lane whatever
  thread they name (`sessionExecutionEventBatches`).

### Session limits

`GET /v1/sessions/:session_id` adds `_oma.limits` to the Session, and the
create and update bodies take it. Here the Session resource and both bodies
leave SDK 0.120: CMA counts a budget in cents, and this platform counts tokens
and subagent turns instead (owner decision 6 of `docs/plans/multiagent.md`,
section 3.Б). The fields are declared like `_oma` of an agent, in
`contracts/sessions.ts`.

- `max_tokens` and `max_child_turns` are the limits. Create sets them with
  `_oma: {limits: {max_tokens, max_child_turns}}`. A value left out takes the
  server default `OMA_SESSION_MAX_TOKENS` or `OMA_SESSION_MAX_CHILD_TURNS`.
- `used_tokens` is the input and output of every model request of every
  thread: main thread, subagents, advisor and outcome grader. Cache tokens are
  not counted.
- `used_child_turns` counts the turns of subagent threads. The advisor thread
  is not counted.
- Retrieve and update carry the field. Create, list and archive do not.
- A limit is a whole number from 1 up. A limit cannot be removed.
- Before each model request the server reads the tokens. At the limit the
  turn stops: the stopped threads write `session.thread_status_idle`, then
  come `session.usage` and `session.status_idle` with `budget_reached`. A
  started request runs to its end, so the count may pass the limit by up to
  one request per thread. A subagent turn over `max_child_turns` does not
  start, and the Session stops the same way.
- A Session stands at its limit when its last turn stopped on
  `budget_reached` or `requires_action` and the work reaches a limit. Then
  `user.message` and `user.define_outcome` answer 400
  `invalid_request_error`. `user.tool_confirmation`, `user.tool_result`,
  `user.custom_tool_result` and `user.interrupt` are accepted. A turn that
  passed the limit with its last request and ended on `end_turn` still takes
  a message: that turn stops before its first request with `budget_reached`.
- `POST /v1/sessions/:session_id` with `_oma.limits` raises the limits. Each
  given value must be above the work counted, otherwise the update answers
  400 and changes nothing. An update of the limits alone leaves the Session
  document and its revision as they are.
- After a raise, a Session whose last turn stopped on `budget_reached` and
  that is now under its token limit goes on with that turn, without a new
  message. Two raises queue one continuation. A raise on any other Session
  only changes the limits.
- Not yet: the agent default `_oma.session_limits`, the copy of the limits
  into a Deployment Session, and the continuation of subagent threads that
  stopped at the limit. The coordinator reads that the subagent stopped, as a
  tool result or as a message from its thread, and decides on its next
  request. A
  self-hosted environment gets the 400 and the raise, but no continuation.
  MySQL has no counter, so nothing stops there.

## Completed Environment surface

| SDK operation | Method and path | Application port method |
| --- | --- | --- |
| `environments.create` | `POST /v1/environments` | `createEnvironment` |
| `environments.retrieve` | `GET /v1/environments/:environment_id` | `retrieveEnvironment` |
| `environments.update` | `POST /v1/environments/:environment_id` | `updateEnvironment` |
| `environments.list` | `GET /v1/environments` | `listEnvironments` |
| `environments.delete` | `DELETE /v1/environments/:environment_id` | `deleteEnvironment` |
| `environments.archive` | `POST /v1/environments/:environment_id/archive` | `archiveEnvironment` |
| `environments.work.list` | `GET /v1/environments/:environment_id/work` | `listEnvironmentWork` |
| `environments.work.retrieve` | `GET /v1/environments/:environment_id/work/:work_id` | `retrieveEnvironmentWork` |
| `environments.work.update` | `POST /v1/environments/:environment_id/work/:work_id` | `updateEnvironmentWork` |
| `environments.work.ack` | `POST /v1/environments/:environment_id/work/:work_id/ack` | `acknowledgeEnvironmentWork` |
| `environments.work.heartbeat` | `POST /v1/environments/:environment_id/work/:work_id/heartbeat` | `heartbeatEnvironmentWork` |
| `environments.work.poll` | `GET /v1/environments/:environment_id/work/poll` | `pollEnvironmentWork` |
| `environments.work.stats` | `GET /v1/environments/:environment_id/work/stats` | `getEnvironmentWorkQueueStats` |
| `environments.work.stop` | `POST /v1/environments/:environment_id/work/:work_id/stop` | `stopEnvironmentWork` |

`EnvironmentsApplicationPort` and `EnvironmentWorkApplicationPort` are
separate. Fixed work paths such as `poll` and `stats` are registered before the
dynamic work identifier path.

## Completed Vault surface

| SDK operation | Method and path | Application port method |
| --- | --- | --- |
| `vaults.create` | `POST /v1/vaults` | `createVault` |
| `vaults.retrieve` | `GET /v1/vaults/:vault_id` | `retrieveVault` |
| `vaults.update` | `POST /v1/vaults/:vault_id` | `updateVault` |
| `vaults.list` | `GET /v1/vaults` | `listVaults` |
| `vaults.delete` | `DELETE /v1/vaults/:vault_id` | `deleteVault` |
| `vaults.archive` | `POST /v1/vaults/:vault_id/archive` | `archiveVault` |
| `vaults.credentials.create` | `POST /v1/vaults/:vault_id/credentials` | `createCredential` |
| `vaults.credentials.retrieve` | `GET /v1/vaults/:vault_id/credentials/:credential_id` | `retrieveCredential` |
| `vaults.credentials.update` | `POST /v1/vaults/:vault_id/credentials/:credential_id` | `updateCredential` |
| `vaults.credentials.list` | `GET /v1/vaults/:vault_id/credentials` | `listCredentials` |
| `vaults.credentials.delete` | `DELETE /v1/vaults/:vault_id/credentials/:credential_id` | `deleteCredential` |
| `vaults.credentials.archive` | `POST /v1/vaults/:vault_id/credentials/:credential_id/archive` | `archiveCredential` |
| `vaults.credentials.mcpOAuthValidate` | `POST /v1/vaults/:vault_id/credentials/:credential_id/mcp_oauth_validate` | `validateCredential` |

Credentials use their own port. All three authentication variants and their
nested networking, injection, OAuth refresh, and validation variants are
explicit application types. The wire validation status `unknown` maps to the
application value `indeterminate` at the adapter edge.

## Completed Files surface

| SDK operation | Method and path | Application port method |
| --- | --- | --- |
| `files.list` | `GET /v1/files` | `listFiles` |
| `files.retrieveMetadata` | `GET /v1/files/:file_id` | `retrieveFileMetadata` |
| `files.upload` | `POST /v1/files` | `uploadFile` |
| `files.download` | `GET /v1/files/:file_id/content` | `downloadFile` |
| `files.delete` | `DELETE /v1/files/:file_id` | `deleteFile` |

Files use the independent `files-api-2025-04-14` gate. Multipart and HTTP
binary response types terminate in the adapter; the application port exchanges
file metadata and `Uint8Array` content only.

## Completed Skills surface

| SDK operation | Method and path | Application port method |
| --- | --- | --- |
| `skills.create` | `POST /v1/skills` | `createSkill` |
| `skills.retrieve` | `GET /v1/skills/:skill_id` | `retrieveSkill` |
| `skills.list` | `GET /v1/skills` | `listSkills` |
| `skills.delete` | `DELETE /v1/skills/:skill_id` | `deleteSkill` |
| `skills.versions.create` | `POST /v1/skills/:skill_id/versions` | `createSkillVersion` |
| `skills.versions.retrieve` | `GET /v1/skills/:skill_id/versions/:version` | `retrieveSkillVersion` |
| `skills.versions.list` | `GET /v1/skills/:skill_id/versions` | `listSkillVersions` |
| `skills.versions.download` | `GET /v1/skills/:skill_id/versions/:version/content` | `downloadSkillVersion` |
| `skills.versions.delete` | `DELETE /v1/skills/:skill_id/versions/:version` | `deleteSkillVersion` |

Skills use the independent `skills-2025-10-02` gate. Skills and versions have
separate ports; multipart files and binary archives do not cross either port.

## Completed Agent Memory surface

| SDK resource | Operations | Application port |
| --- | --- | --- |
| `memoryStores` | create, retrieve, update, list, delete, archive | `MemoryStoresApplicationPort` |
| `memoryStores.memories` | create, retrieve, update, list, delete | `MemoriesApplicationPort` |
| `memoryStores.memoryVersions` | retrieve, list, redact | `MemoryVersionsApplicationPort` |

Agent Memory uses the independent `agent-memory-2026-07-22` gate. Projection,
path prefix, timestamp filters, digest preconditions, prefix rollups, and all
four version actor variants are explicitly mapped. Memory-specific 409 errors
retain `memory_precondition_failed_error` and `memory_path_conflict_error` on
the wire.

## Completed Deployment surface

| SDK resource | Operations | Application port |
| --- | --- | --- |
| `deployments` | create, retrieve, update, list, archive, pause, run, unpause | `DeploymentsApplicationPort` |
| `deploymentRuns` | retrieve, list | `DeploymentRunsApplicationPort` |

Deployments use `managed-agents-2026-04-01`. Agent selectors, the three allowed
initial-event variants, resource inputs and resource views, schedules, pause
reasons, run errors, and trigger contexts are explicit application types.
GitHub authorization tokens are accepted only by deployment commands and never
appear in deployment views or responses.

## Completed User Profiles surface

| SDK operation | Method and path | Application port method |
| --- | --- | --- |
| `userProfiles.create` | `POST /v1/user_profiles` | `createUserProfile` |
| `userProfiles.retrieve` | `GET /v1/user_profiles/:user_profile_id` | `retrieveUserProfile` |
| `userProfiles.update` | `POST /v1/user_profiles/:user_profile_id` | `updateUserProfile` |
| `userProfiles.list` | `GET /v1/user_profiles` | `listUserProfiles` |
| `userProfiles.createEnrollmentURL` | `POST /v1/user_profiles/:user_profile_id/enrollment_url` | `createEnrollmentUrl` |

User Profiles use the SDK's current `user-profiles-2026-08-18` gate. Access
type, relationship, and trust grants remain distinct application concepts.

## Completed Tunnels surface

| SDK resource | Operations | Application port |
| --- | --- | --- |
| `tunnels` | create, retrieve, list, archive, revealToken, rotateToken | `TunnelsApplicationPort` |
| `tunnels.certificates` | create, retrieve, list, archive | `TunnelCertificatesApplicationPort` |

Tunnels use `mcp-tunnels-2026-06-22`. Connector tokens have a dedicated view
and response path; they are not fields on a tunnel. CA certificate PEM enters
only the certificate create command, while certificate views expose the
fingerprint and lifecycle metadata.

## Completed Dreams surface

| SDK operation | Method and path | Application port method |
| --- | --- | --- |
| `dreams.create` | `POST /v1/dreams` | `createDream` |
| `dreams.retrieve` | `GET /v1/dreams/:dream_id` | `retrieveDream` |
| `dreams.list` | `GET /v1/dreams` | `listDreams` |
| `dreams.archive` | `POST /v1/dreams/:dream_id/archive` | `archiveDream` |
| `dreams.cancel` | `POST /v1/dreams/:dream_id/cancel` | `cancelDream` |

Dreams use `dreaming-2026-04-21`. String and object model selectors normalize
to an application model input. Request and response model types stay separate
because request `speed` accepts explicit null while response `speed` does not.
