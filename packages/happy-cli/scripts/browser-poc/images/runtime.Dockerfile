FROM node:22-bookworm-slim
# Dedicated uid/gid: state files are owned by an id no host login user has.
# flock and setpriv come from util-linux (Essential in Debian).
# The harness runs the image as this user. Production starts it as root with
# only SETUID/SETGID (--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID
# --security-opt no-new-privileges) so it can read the root 0600 config and
# bind sockets in the root:abp-session 0750 /run/abp, then drops to ABP_RUNTIME_UID/GID.
RUN groupadd --system --gid 10870 abp && useradd --system --uid 10870 --gid 10870 --no-create-home --shell /usr/sbin/nologin abp \
    && mkdir -p /var/lib/abp /app /run/abp && chown -R abp:abp /var/lib/abp /app /run/abp
COPY scripts/browser-poc/images/runtime-entrypoint.sh /usr/local/bin/abp-runtime-entrypoint
RUN chmod 755 /usr/local/bin/abp-runtime-entrypoint
ENV ABP_RUNTIME_UID=10870 ABP_RUNTIME_GID=10870
USER abp
WORKDIR /app
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/abp-runtime-entrypoint"]
