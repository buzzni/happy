# Native reservation runtime

The host keeps the existing Happy chat and its credentials. Only Claude/Codex and project commands enter the kernel boundary. This is Core execution infrastructure; it does not create or fork a chat.

## Prepare an immutable image

The package includes `reservation-runtime/profile.json`, its Dockerfile and `scripts/build-reservation-runtime-image.mjs`. The release artifact guard requires all three. The profile pins the official Node base digest and npm SHA-512 integrity for Claude 2.1.143 and Codex 0.153.0, for Linux arm64 and amd64. The Docker recipe preserves Codex's adjacent resources.

On the target Docker engine, explicitly cache the exact `baseImage` declared in the profile. Then run:

```sh
node scripts/build-reservation-runtime-image.mjs --output /absolute/new/output-directory
```

The builder verifies primary npm archive identities and integrity before extraction, builds with network disabled and no implicit pull, and checks all three CLI versions in a non-root, read-only, network-free container. It never pushes an image. The output `runtime-image.json` records the complete image ID, profile/Dockerfile/archive hashes and versions. Use the ID on the same Docker engine:

```sh
HAPPY_NATIVE_RESERVATION_IMAGE=sha256:<complete-image-id> happy daemon start
```

This machine configuration is separate from the consumed `HAPPY_RESERVATION_*` per-turn bootstrap secrets. Those secrets remain non-inheritable. A successful immutable image probe enables reservation capability/codec negotiation; a failure must not enable or fall back to a legacy worker. Windows remains unsupported by this adapter. The local macOS arm64 build is not amd64 or Windows acceptance.

## Package and server compatibility

Build the wire and CLI from the exact source/lock, run `prepare-publish-package.cjs`, pack the prepared directory and run `guard-publish-artifact.cjs <tarball> --install-smoke`. Never pack the workspace source for publication. Official publishing remains GitHub Actions only under AGENTS.md and `docs/happy-cli-release.md`.

The standalone server currently uses Prisma 6.19.2. Pin `pglite-prisma-adapter` 0.6.1 and its driver-adapter-utils 6.19.2 override together. Adapter 0.7.2 requires Prisma 7.1+ and returns incompatible byte arrays to the Prisma 6 Rust boundary. A locally patched node_modules copy is not a release input. Existing PGlite reservation/message tests reproduce this boundary using real SQL; keep type checks and those tests passing.

## Local verification and rollback

Use an isolated app root, user data, Happy home and PGlite directory. The runtime result must show the prepared CLI version, actual daemon version and native capability from a real server read. Do not copy the real account/credential files. Local standalone retains the existing cloud-only Chat reservation management policy; successful daemon/image advertisement is not a scheduled provider-turn acceptance.

Run the actual kernel tests against the built image and inspect Electron recordings. Leave live provider, GitHub, messenger and Windows acceptance explicitly separate. Do not run GitHub review/fix QA when the user has excluded it. Rollback stops only the isolated runtime and removes no production reservations or pending lease journal. Do not relabel a dirty or unpublished candidate as the official Desktop pin.
