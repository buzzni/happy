# Linux host for the work machine migration rehearsal (workMachineRehearsal.integration.test.ts).
# Work machine execution is Linux-only, so a macOS checkout runs the rehearsal here.
FROM node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7
RUN npm install -g --no-audit --no-fund pnpm@10.11.0 @anthropic-ai/claude-code@2.1.143 @openai/codex@0.130.0 \
    && mkdir -p /work && chown node:node /work
USER node
WORKDIR /work
