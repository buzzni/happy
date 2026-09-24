FROM node:22-bookworm-slim
RUN mkdir -p /var/lib/abp /app && chown -R node:node /var/lib/abp /app
USER node
WORKDIR /app
EXPOSE 8787
CMD ["node", "/app/runtime.mjs"]
