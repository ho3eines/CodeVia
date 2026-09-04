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

# Non-root user for safety.
RUN groupadd -r codevia && useradd -r -g codevia codevia \
  && mkdir -p /app/data && chown -R codevia:codevia /app
USER codevia

# Install only production dependencies in the runtime image.
COPY --from=build --chown=codevia:codevia /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev

# Reference the compiled output + static UI.
COPY --from=build --chown=codevia:codevia /app/dist ./dist
COPY --from=build --chown=codevia:codevia /app/public ./public

EXPOSE 8080
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/codevia.db

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
