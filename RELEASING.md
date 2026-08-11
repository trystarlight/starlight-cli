# Releasing

The CLI has its own SemVer. A release requires an exact reviewed source commit, green macOS CI, protocol compatibility proof, a clean package-content audit, and explicit release authorization.

Before creating an immutable `vX.Y.Z` tag:

1. Verify clean install, pairing, foreground and LaunchAgent operation, reboot/reconnect, upgrade, revocation, and uninstall on supported macOS versions.
2. Run `pnpm verify` and inspect the generated package file list.
3. Confirm the hosted service accepts this driver protocol and version floor.
4. Review every commit since the previous tag and confirm the package version.

The `release.yml` workflow uses npm trusted publishing with GitHub Actions OIDC and provenance. It pins Node 22.14 and npm 11.5.1, the minimum versions accepted by npm trusted publishing. Configure the npm package to trust this repository and workflow filename; do not add an npm token to repository secrets. Tags are immutable and public history is never rewritten.

The first publication is a one-time bootstrap exception because npm trusted publishing can only be configured after the package exists. Publish the reviewed release tarball manually with provenance disabled, then configure `trystarlight/starlight-cli` and `.github/workflows/release.yml` as the trusted publisher. The first tag validates the exact source and skips the registry write when that immutable version already exists. All subsequent new versions must publish through the immutable-tag workflow above.
