# ── Stage 1: Monorepo Builder ─────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

# 1. Copy package files
COPY package.json ./
COPY core/package.json ./core/
COPY modules/serp-discovery/package.json ./modules/serp-discovery/
COPY modules/mcp-server/package.json ./modules/mcp-server/

# 2. Install all dependencies (hoisted to /app/node_modules)
RUN npm install

# 3. Copy source code and build
COPY . .
RUN npm run build --workspaces --if-present

# ── Stage 2: Playwright Runtime ───────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.44.0-jammy AS runtime
WORKDIR /app

# Copy the built MCP server
COPY --from=builder /app/modules/mcp-server/dist ./dist

# Copy the HOISTED node_modules from the root
COPY --from=builder /app/node_modules ./node_modules

# Install Chromium system dependencies
RUN npx playwright install chromium

EXPOSE 3001
ENV PORT=3001 NODE_ENV=production

CMD ["node", "dist/index.js"]
