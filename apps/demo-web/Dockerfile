# p-x402 public demo (apps/demo-web): agent, seller, facilitator and the page in one service.
# Build from the repository root (the workspace needs every package):
#   fly deploy . --config apps/demo-web/fly.toml --dockerfile apps/demo-web/Dockerfile
FROM oven/bun:1.3.2
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile --production

# Runs as root so it can write SQLite on the mounted volume (/data), which Fly mounts as root.
ENV DEMO_WEB_PORT=8080
EXPOSE 8080
CMD ["bun", "apps/demo-web/src/index.ts"]
