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
#
# NOTE: npm runs package.json's `prepare` script even under --omit=dev, and
# husky is a devDependency — so `prepare` MUST tolerate a missing husky
# binary ("husky || true", husky's documented workaround). Without it this
# stage dies with `sh: 1: husky: not found` (exit 127). Do not "clean up"
# that `|| true` in package.json.
# `git` powers the read-only repository mirror: bare clones read through git
# *plumbing* (ls-tree / cat-file / grep) so repository evidence comes from disk
# instead of the GitHub API. node:22-slim ships without git, and without it the
# mirror reports "git not installed" and every read silently falls back to the
# API — correct, but slow on large repositories. ca-certificates is needed for
# the HTTPS clone. No repository code is ever executed from the mirror.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git --version

ENV npm_config_cache=/tmp/.npm
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && rm -rf /tmp/.npm

# Reference the compiled output + static UI.
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

# Non-root user for safety — created AFTER npm ci so the install runs as root.
# The entrypoint starts as root long enough to initialize a mounted volume, then
# drops back to this user before launching Node.
RUN groupadd -r codevia && useradd -r -g codevia -d /app codevia \
  && mkdir -p /app/data && chown -R codevia:codevia /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh
ENV HOME=/app

# Declare the entrypoint. Without this, nothing in the image ever runs
# docker-entrypoint.sh: `docker run` would start CMD directly and a PaaS
# start command would replace it — so the root-owned volume mount at /app/data
# never gets prepared and SQLite dies with "unable to open database file".
# ENTRYPOINT is inherited by the platform's "start command" (which only
# replaces CMD), so the volume fix-up runs on every boot path.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 8080
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/codevia.db
# Read-only repository mirrors live next to the database (inside the mounted
# volume, so they survive restarts). Set REPO_MIRROR_ENABLED=false to turn the
# mirror off entirely — reads then always go through the GitHub API.
ENV REPO_MIRROR_DIR=/app/data/mirrors

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
