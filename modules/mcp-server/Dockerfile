# ── Stage 1: Monorepo Builder ─────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

# Copy package manifests
COPY package.json package-lock.json* ./
COPY core/package.json ./core/
COPY modules/extractors/package.json ./modules/extractors/
COPY modules/tls-backend/package.json ./modules/tls-backend/
COPY modules/mcp-server/package.json ./modules/mcp-server/

# Install dependencies (hoisted to /app/node_modules)
RUN npm install

# Copy source code and build in dependency order
COPY core/ ./core/
COPY modules/extractors/ ./modules/extractors/
COPY modules/tls-backend/ ./modules/tls-backend/
COPY modules/mcp-server/ ./modules/mcp-server/

RUN npm run build --workspace=core && \
    npm run build --workspace=modules/extractors && \
    npm run build --workspace=modules/tls-backend && \
    npm run build --workspace=modules/mcp-server

# ── Stage 2: Playwright Runtime ───────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.44.0-jammy AS runtime
WORKDIR /app

# Copy root package files & hoisted node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled workspace packages preserving monorepo layout for symlink resolution
COPY --from=builder /app/core/dist                       ./core/dist
COPY --from=builder /app/core/package.json               ./core/package.json
COPY --from=builder /app/modules/extractors/dist         ./modules/extractors/dist
COPY --from=builder /app/modules/extractors/package.json ./modules/extractors/package.json
COPY --from=builder /app/modules/tls-backend/dist        ./modules/tls-backend/dist
COPY --from=builder /app/modules/tls-backend/package.json ./modules/tls-backend/package.json
COPY --from=builder /app/modules/mcp-server/dist         ./modules/mcp-server/dist
COPY --from=builder /app/modules/mcp-server/package.json ./modules/mcp-server/package.json

# Install Chromium system dependencies
RUN npx playwright install chromium

# Data directories and non-root ownership
RUN mkdir -p /data /manifests /scratch && chown -R pwuser:pwuser /app /data /manifests /scratch

EXPOSE 3001
ENV PORT=3001 HOST=0.0.0.0 NODE_ENV=production

USER pwuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "modules/mcp-server/dist/index.js"]
