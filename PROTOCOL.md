# Driver protocol compatibility

The CLI and Starlight service negotiate a narrow driver protocol independently of their package versions.

The initial declaration is:

- CLI: `0.1.x`
- Driver protocol: `1.0.0`
- Instructions schema: `starlight.agent-driver-instructions.v1`
- Behavior profile: `starlight.creative-driver-behavior-profile.v2`

The service returns the protocol version, instructions schema, instruction text, server-owned working set, and dynamic tool definitions in the authenticated session context. The CLI rejects unsupported versions, missing instructions, unsupported schema keywords, and malformed catalogue or session-media projections before starting a Codex turn. Before dispatch, every dynamic invocation is validated against the exact JSON Schema supplied for that authenticated tool. Validation failures preserve actionable field paths and do not create provider work.

The wire contract includes resource-bound pairing, driver presence, durable turn claims and leases, ordered progress events, interventions, terminal outcomes, archived generated image bytes, the authoritative video catalogue, the session-media index, model selections, alternatives, adjustments, and exact durable operation receipts. These projections are transported without client-side routing or catalogue reinterpretation. The contract intentionally excludes service persistence rows, account and tenancy implementation, provider routing, spend enforcement, and application prompts.

Media results are truthful receipt projections. An accepted result must contain the declared durable operations; clarification and invalid results create none. Generated image upload admission uses `sha256:<64 lowercase hex>` content identities. The service remains responsible for route admission, policy, spend, execution, artifact projection, and user-facing media rendering.

Compatibility tests must cover both a current response and the explicitly supported legacy response. Contract changes are additive within a compatible protocol version; an incompatible requirement needs a new protocol version and a server-first rollout.
