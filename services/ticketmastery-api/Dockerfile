# syntax=docker/dockerfile:1

# --- build: compile TypeScript with the full dependency set ---------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- prod-deps: runtime dependencies only ---------------------------------------------------------
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- runtime ----------------------------------------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
# Files stay root-owned (read-only for the app); the process runs as the unprivileged `node` user.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
USER node
EXPOSE 3000
# Liveness only (no DB). ECS ignores Docker HEALTHCHECK unless the task definition sets healthCheck;
# the ALB target group checks /health (with DB) separately.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/health/live" || exit 1
CMD ["node", "dist/server.js"]
