FROM node:22-bookworm-slim
# Dedicated uid/gid: the admin socket (0600) and state files are owned by an id
# no host login user has. flock comes from util-linux (Essential in Debian).
RUN groupadd --system --gid 10870 abp && useradd --system --uid 10870 --gid 10870 --no-create-home --shell /usr/sbin/nologin abp \
    && mkdir -p /var/lib/abp /app /run/abp && chown -R abp:abp /var/lib/abp /app /run/abp
COPY scripts/browser-poc/images/runtime-entrypoint.sh /usr/local/bin/abp-runtime-entrypoint
RUN chmod 755 /usr/local/bin/abp-runtime-entrypoint
USER abp
WORKDIR /app
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/abp-runtime-entrypoint"]
