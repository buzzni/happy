ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY claude/ /opt/reservation/claude/
COPY codex/ /opt/reservation/codex/
RUN find /opt/reservation -maxdepth 5 -type f -name claude -exec install -m 0555 '{}' /usr/local/bin/claude ';' \
 && find /opt/reservation/codex -type f -path '*/bin/codex' -exec chmod 0555 '{}' ';' -exec ln -s '{}' /usr/local/bin/codex ';' \
 && find /opt/reservation/codex -type f -path '*/codex-path/rg' -exec install -m 0555 '{}' /usr/local/bin/rg ';' \
 && test -x /usr/local/bin/claude && test -x /usr/local/bin/codex \
 && git --version
USER 65534:65534
WORKDIR /tmp
ENTRYPOINT []
CMD ["node", "--version"]
