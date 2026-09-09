FROM node:22.19.0-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY config ./config
COPY src ./src

RUN mkdir -p /runtime/dsh-home /runtime/logs /runtime/workspace /site \
    && chmod 700 /runtime/dsh-home /runtime/logs /runtime/workspace

ENV NODE_ENV=production \
    FC_HOST=0.0.0.0 \
    FC_PORT=8787 \
    FC_SITE_ROOT=/site \
    FC_RUNTIME_ROOT=/runtime \
    FC_MODEL=deepseek-v4-flash \
    DSH_TELEMETRY_MODE=DISABLED

EXPOSE 8787
CMD ["node", "src/server.js"]
