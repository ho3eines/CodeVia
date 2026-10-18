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
#
# `p7zip-full` provides `/usr/bin/7z`, which reads uploaded `.rar` archives
# (PROJECT_IMPORT_7Z_BIN below). Without it the RAR import endpoint would answer
# 503 on a stock image. ZIP import is pure Node and needs nothing extra.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates p7zip-full \
  && rm -rf /var/lib/apt/lists/* \
  && git --version \
  && command -v 7z

# RAR import: pin the binary so a PATH change cannot silently break it. Remove
# this ENV if you prefer the service to probe `7z`/`7zz` on PATH instead.
ENV PROJECT_IMPORT_7Z_BIN=/usr/bin/7z

ENV npm_config_cache=/tmp/.npm
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && rm -rf /tmp/.npm

# ---- Optional: Docker CLI (CLI only, never the daemon) ----
# Project lifecycle commands run in a disposable container, so a deployment that
# executes local/imported project code needs a reachable Docker daemon:
#   * sidecar:     `DOCKER_HOST=tcp://docker:2375` (commented service in
#                  docker-compose.yml)
#   * host socket: mount /var/run/docker.sock — equivalent to host root access,
#                  see the commented option + security warning in compose
# Build with `--build-arg INSTALL_DOCKER_CLI=true` to install just the static
# `docker` client from download.docker.com. The daemon is NOT installed; the
# platform only ever spawns the CLI. Default: off (GitHub-backed projects work
# without Docker at all).
ARG INSTALL_DOCKER_CLI=false
ARG DOCKER_CLI_VERSION=27.3.1
ARG TARGETARCH
RUN set -eu; \
  if [ "$INSTALL_DOCKER_CLI" = "true" ]; then \
    apt-get update; \
    apt-get install -y --no-install-recommends curl; \
    case "${TARGETARCH:-amd64}" in \
      arm64|aarch64) cli_arch=aarch64 ;; \
      *) cli_arch=x86_64 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${cli_arch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker-cli.tgz; \
    tar -xzf /tmp/docker-cli.tgz -C /tmp; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker /tmp/docker-cli.tgz; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*; \
    docker --version; \
  fi

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
# Local/imported Git projects live inside the mounted volume too, so an upload
# or "new local project" survives a redeploy (LOCAL_REPOS_DIR/<owner>/<repo>).
ENV LOCAL_REPOS_DIR=/app/data/repos

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
