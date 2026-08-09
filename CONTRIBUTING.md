# Contributing

Use Node.js 22.13 or newer and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Changes should keep the CLI macOS-only, preserve Keychain custody, avoid printing credentials, and keep stdout stable for JSON consumers. Do not add provider SDKs, hosted account logic, long-lived publishing tokens, or plaintext credential fallbacks.

Open an issue before changing the driver protocol or command exit codes. Pull requests should include focused tests and pass the package-content audit.
