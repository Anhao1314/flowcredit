FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

ARG FLOWCREDIT_RELEASE_VERSION=external-alpha-v0.2.2
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="FlowCredit Agent Sidecar" \
      org.opencontainers.image.version="${FLOWCREDIT_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.description="FlowCredit External Alpha risk intelligence API"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY contracts ./contracts
COPY scripts ./scripts
COPY --chown=node:node core ./core
COPY src ./src

RUN mkdir -p /runtime/logs /runtime/workspace /site \
    && chown -R node:node /runtime /site \
    && chmod 700 /runtime/logs /runtime/workspace

ENV NODE_ENV=production \
    FLOWCREDIT_RELEASE_VERSION=${FLOWCREDIT_RELEASE_VERSION} \
    FC_SITE_ROOT=/site \
    FC_RUNTIME_ROOT=/runtime \
    FC_MODEL=deepseek-v4-flash

EXPOSE 8787
USER node
CMD ["node", "src/server.js"]
