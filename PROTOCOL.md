# Driver protocol compatibility

The CLI and Starlight service negotiate a narrow driver protocol independently of their package versions.

The initial declaration is:

- CLI: `0.8.x`
- Driver protocol: `1.0.0`
- Instructions schema: `starlight.agent-driver-instructions.v1`
- Behavior profile: `starlight.creative-driver-behavior-profile.v2`

The service returns the protocol version, instructions schema, instruction text, server-owned working set, and dynamic tool definitions in the authenticated session context. The CLI rejects unsupported versions, missing instructions, unsupported schema keywords, and malformed catalogue or session-media projections before starting a Codex turn. Before dispatch, every dynamic invocation is validated against the exact JSON Schema supplied for that authenticated tool. Validation failures preserve actionable field paths and do not create provider work.

Live provider discovery stays server-owned. The model searches admitted endpoints, navigates bounded input, output, or OpenAPI schema nodes through RFC 6901 pointers and Unicode-code-point cursors, and prepares an opaque `starlight.media-schema-binding.v2` containing only endpoint and fingerprint identities. The stable `starlight_propose_media_execution` tool remains available in that same Codex turn. It requires an idempotency key; the service validates the complete live provider schema before creating a durable operation or starting provider work. The CLI never receives provider credentials and does not turn endpoint-specific schemas into canonical tools.

App Server tool arguments are limited to 32,000 UTF-8 bytes. Complete tool results through 128,000 UTF-8 bytes are returned losslessly; larger results fail closed with a measured `starlight.dynamic-tool-result-transport.v1` response and no result prefix. Discovery reads are limited to 64,000 UTF-8 bytes and other JSON responses to 4 MiB. Malformed or oversized reads are platform failures. A malformed successful mutation is outcome-ambiguous and must not be retried automatically.

The wire contract includes resource-bound pairing, driver presence, durable turn claims and leases, ordered progress events, interventions, terminal outcomes, archived generated image bytes, bounded provider-schema navigation, opaque schema bindings, the session-media index, model selections, alternatives, adjustments, and exact durable operation receipts. These projections are transported without client-side routing, schema reinterpretation, or request simplification. The contract intentionally excludes service persistence rows, account and tenancy implementation, provider credentials, provider routing, spend enforcement, and application prompts.

Media results are truthful receipt projections. An accepted result must contain the declared durable operations; clarification and invalid results create none. Generated image upload admission uses `sha256:<64 lowercase hex>` content identities. The service remains responsible for route admission, policy, spend, execution, artifact projection, and user-facing media rendering.

The published `fixtures/media-proposal-compatibility.v1.json` fixture is byte-identical to the platform compatibility fixture and protects discovery, navigation, binding v2, stable proposal, typed failure, and accepted-result transport. Compatibility tests must also cover both a current response and the explicitly supported legacy response. Contract changes are additive within a compatible protocol version; an incompatible requirement needs a new protocol version and a server-first rollout.
