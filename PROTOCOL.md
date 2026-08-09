# Driver protocol compatibility

The CLI and Starlight service negotiate a narrow driver protocol independently of their package versions.

The initial declaration is:

- CLI: `0.1.x`
- Driver protocol: `1.0.0`
- Instructions schema: `starlight.agent-driver-instructions.v1`
- Behavior profile: `starlight.creative-driver-behavior-profile.v2`

The service returns the protocol version, instructions schema, instruction text, and dynamic tool definitions in the authenticated session context. The CLI rejects unsupported versions or missing instructions before starting a Codex turn. Server compatibility must be deployed before a client release requires it.

The wire contract includes resource-bound pairing, driver presence, durable turn claims and leases, ordered progress events, interventions, terminal outcomes, and archived generated image bytes. It intentionally excludes service persistence rows, account and tenancy implementation, provider routing, spend enforcement, and application prompts.

Compatibility tests must cover both a current response and the explicitly supported legacy response. Contract changes are additive within a compatible protocol version; an incompatible requirement needs a new protocol version and a server-first rollout.
