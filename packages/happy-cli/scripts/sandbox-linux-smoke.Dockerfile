FROM node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7
RUN apt-get update -qq && apt-get install -y -qq bubblewrap socat ripgrep python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --prefix /test --no-audit --no-fund tsx@4.20.6
RUN mkdir -p /work /run/abp /etc/abp /var/lib/abp /synthetic-happy /synthetic-claude /synthetic-home /tmp/happy-session-synthetic \
    && chown node:node /work /run/abp /etc/abp /var/lib/abp /synthetic-happy /synthetic-claude /synthetic-home /tmp/happy-session-synthetic
USER node
WORKDIR /w/packages/happy-cli
ENV HOME=/synthetic-home HAPPY_HOME_DIR=/synthetic-happy HAPPY_SANDBOX_LINUX_SMOKE=1
CMD ["/bin/sh", "scripts/sandbox-linux-smoke.sh"]
