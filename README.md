# Starlight CLI

The Starlight CLI connects your own Codex installation on macOS to your Starlight workspace. It stores the resource-bound pairing credential in macOS Keychain and can keep the driver available through a per-user LaunchAgent.

## Requirements

- macOS
- Node.js 22.13 or newer
- A local Codex installation signed in to your own subscription
- A Starlight account

Linux and Windows are not supported in the initial release. Mutating commands fail explicitly on unsupported operating systems.

## Install and connect

```sh
npm install --global @trystarlight/cli
starlight auth login
```

Open the returned verification URL, approve the connection in Starlight, then run:

```sh
starlight auth complete
starlight driver install --runtime codex
starlight doctor --json --strict
```

Pairing grants this device scoped authority for one Starlight resource and workspace. It does not transfer your Codex subscription to Starlight or give Starlight custody of it.

## Commands

```text
starlight auth login|complete|status|logout
starlight driver install|start|stop|status|update|run
starlight doctor [--json] [--strict]
starlight version [--json]
starlight update [--json]
starlight uninstall [--revoke] [--json]
```

`driver stop` and `uninstall` preserve pairing by default. Use `auth logout` or `uninstall --revoke` to revoke the remote credential before clearing it locally.

Machine-readable commands emit one JSON object, or JSON Lines for `driver run --json`, on stdout. Human-facing errors use stderr. Exit codes are stable: `0` success, `1` failure, `2` attention required, `64` command usage, and `69` unsupported environment.

## Recovery

- Pairing expired or revoked: run `starlight auth logout`, then pair again.
- Driver offline after login or reboot: run `starlight driver status --json`, then `starlight driver start`.
- Driver crashed: run `starlight doctor --json --strict`; the diagnostic contains a safe next command without credentials.
- Upgrade: install the newer package through the same trusted npm channel, then run `starlight driver install --runtime codex` to refresh the LaunchAgent entry.
- Clean removal: run `starlight uninstall --revoke`, then remove the global npm package.

## Trust boundary

The CLI is a thin, user-owned driver. The Starlight service remains responsible for account authorization, workspace isolation, durable sessions and turns, approvals, spend controls, provider routing, validation, and recovery. The driver accepts versioned instructions and tool schemas from the authenticated Starlight service; it does not ship private application prompts or provider credentials.

See [PROTOCOL.md](PROTOCOL.md) for the compatibility contract and [SECURITY.md](SECURITY.md) for reporting and credential handling.
