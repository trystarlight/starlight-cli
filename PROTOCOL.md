# Driver protocol compatibility

The CLI and Starlight service negotiate a narrow driver protocol independently of their package versions.

The initial declaration is:

- CLI: `0.1.x`
- Driver protocol: `1.0.0`
- Instructions schema: `starlight.agent-driver-instructions.v1`
- Behavior profile: `starlight.creative-driver-behavior-profile.v2`

The service returns the protocol version, instructions schema, instruction text, server-owned working set, and dynamic tool definitions in the authenticated session context. The CLI rejects unsupported versions, missing instructions, unsupported schema keywords, and malformed catalogue or session-media projections before starting a Codex turn. Before dispatch, every dynamic invocation is validated against the exact JSON Schema supplied for that authenticated tool. Validation failures preserve actionable field paths and do not create provider work.

For live video and talking-avatar work, discovery and proposal are two internal model steps in the same Starlight turn. The first step searches admitted models, retrieves exact provider schemas, and asks the service for an opaque expiring schema binding. The service then supplies one ephemeral proposal tool whose endpoint IDs and fingerprints are constants and whose `providerInput` branches are the selected live schemas. The CLI registers that definition losslessly for an input-free internal continuation, validates the resulting call against it, and adds only the service-supplied binding arguments. Preparing a binding creates no Starlight operation and starts no provider dispatch.

Media failures use `starlight.agent-media-tool-failure.v1`. The CLI preserves its phase, code, field path, operation and dispatch flags, correction semantics, stop instruction, next event sequence, and correlation ID. An unknown non-success response remains a platform failure; it is never relabeled as invalid tool arguments. A `mustStop` failure prevents later media calls in that driver turn.

The wire contract includes resource-bound pairing, driver presence, durable turn claims and leases, ordered progress events, interventions, terminal outcomes, archived generated image bytes, opaque server-owned working-state projections, the session-media index, alternatives, adjustments, schema bindings, and exact durable operation receipts. These projections are transported without client-side provider routing or schema reinterpretation. The contract intentionally excludes service persistence rows, account and tenancy implementation, provider routing, spend enforcement, and application prompts.

Media results are truthful receipt projections. An accepted result must contain the declared durable operations; clarification and invalid results create none. Generated image upload admission uses `sha256:<64 lowercase hex>` content identities. The service remains responsible for route admission, policy, spend, execution, artifact projection, and user-facing media rendering.

Compatibility tests must cover both a current response and the explicitly supported legacy response. The published `fixtures/media-tool-reattachment.v1.json` fixture is byte-identical to the platform fixture and protects live-schema transport, exact binding, typed failure, and durable accepted-result parsing across repositories. Contract changes are additive within a compatible protocol version; an incompatible requirement needs a new protocol version and a server-first rollout.
