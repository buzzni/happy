FROM debian:bookworm-slim

RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
        chromium ca-certificates novnc procps python3 tini websockify x11vnc xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /usr/sbin/nologin browser \
    && mkdir -p /opt/happy/extension /opt/happy/bin /home/browser/profile \
    && chown -R 1000:1000 /home/browser

COPY packages/happy-browser-extension/ /opt/happy/extension/
COPY packages/happy-cli/browser-session-image/entrypoint.sh /opt/happy/bin/entrypoint.sh
COPY packages/happy-cli/browser-session-image/native-host.py /opt/happy/bin/native-host.py
COPY packages/happy-cli/browser-session-image/healthcheck.sh /opt/happy/bin/healthcheck.sh

RUN chmod 0555 /opt/happy/bin/entrypoint.sh /opt/happy/bin/native-host.py /opt/happy/bin/healthcheck.sh \
    && mkdir -p /etc/chromium/native-messaging-hosts \
    && printf '%s\n' \
      '{"name":"ai.saycode.happy_browser","description":"Scoped Happy browser pairing","path":"/opt/happy/bin/native-host.py","type":"stdio","allowed_origins":["chrome-extension://emaponnolfbhnoaabgiebjmbdlmoifke/"]}' \
      > /etc/chromium/native-messaging-hosts/ai.saycode.happy_browser.json

USER 1000:1000
EXPOSE 6080
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=12 CMD ["/opt/happy/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/happy/bin/entrypoint.sh"]
