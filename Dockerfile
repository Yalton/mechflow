# Builds every package and runs the local server, which serves the web app
# and reads and writes the YAML models mounted at /app/models.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/files/package.json packages/files/
COPY packages/mcp/package.json packages/mcp/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm -r build
# Keep only runtime dependencies for the final image.
RUN rm -rf node_modules packages/*/node_modules \
    && pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
COPY models /app/models
EXPOSE 3000
# Bind all interfaces so the published port reaches the server; the server
# itself defaults to loopback when run outside a container.
CMD ["node", "packages/server/dist/bin.js", "--host", "0.0.0.0", "--port", "3000", "--models", "/app/models"]
