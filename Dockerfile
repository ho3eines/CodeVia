# ---------- Stage 1: build ----------
FROM node:22-slim AS build
WORKDIR /app

# Install dependencies first (caching-friendly).
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript + copy the static UI into dist/.
COPY tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npx tsc -p tsconfig.build.json && node scripts/copy-static.mjs

# ---------- Stage 2: production ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Install only production dependencies in the runtime image (as root, so npm
# has a writable cache), then clean the cache to keep the image small.
# npm_config_cache is pinned to /tmp so npm never touches a home directory.
ENV npm_config_cache=/tmp/.npm
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && rm -rf /tmp/.npm

# Reference the compiled output + static UI.
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

# Non-root user for safety — created AFTER npm ci so the install runs as root.
# HOME points at /app so anything npm/node writes at runtime stays writable.
RUN groupadd -r codevia && useradd -r -g codevia -d /app codevia \
  && mkdir -p /app/data && chown -R codevia:codevia /app
ENV HOME=/app
USER codevia

EXPOSE 8080
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/codevia.db

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
