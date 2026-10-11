# syntax=docker/dockerfile:1

# ---- build the web app --------------------------------------------------------
FROM node:24.21.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# --ignore-scripts: no dependency install scripts run during the build.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared shared
COPY web web
RUN npm run build

# ---- production dependencies for the server only ------------------------------
FROM node:24.21.0-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace @webdrop/server

# ---- runtime ------------------------------------------------------------------
FROM node:24.21.0-alpine3.24
# Package managers are not needed at runtime; removing them shrinks the attack surface.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app
# Code stays root-owned and read-only; the process runs as the unprivileged "node" user.
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY shared/package.json shared/
COPY shared/src shared/src
COPY server/package.json server/
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "server/src/index.ts"]
