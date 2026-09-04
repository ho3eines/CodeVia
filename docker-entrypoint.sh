#!/bin/sh
set -eu

# CodeVia container entrypoint.
#
# Why this exists: Railway (and Docker bind/named volumes) mount the volume
# AFTER the image is built, and the mount is always root-owned. The app runs as
# an unprivileged user and SQLite has to create <DATABASE_PATH>{,-wal,-shm} in
# that directory, so the mount must be prepared before Node starts.
#
# The entrypoint therefore:
#   1. prepares the data directory while still root (mkdir + chown), and
#   2. drops to the image's unprivileged user before exec'ing the app.
#
# Everything here is best-effort on purpose: a volume that cannot be prepared
# must produce a readable message, because the platform restart policy otherwise
# loops "Mounting volume…" -> "fatal startup error" with nothing to act on.

# Resolve the data directory from DATABASE_PATH so it always matches what the
# app actually opens (set in the Dockerfile / Railway variables).
DATA_DIR="${DATA_DIR:-/app/data}"
if [ -n "${DATABASE_PATH:-}" ]; then
  candidate=$(dirname "$DATABASE_PATH")
  # Ignore bare filenames (dirname -> ".") and stay away from "/".
  if [ -n "$candidate" ] && [ "$candidate" != "/" ] && [ "$candidate" != "." ]; then
    DATA_DIR="$candidate"
  fi
fi

APP_USER="${CODEVIA_USER:-codevia}"
# Look the user up in /etc/passwd rather than via getent: the flag is present in
# slim images today but must never turn a missing tool into a startup failure.
if [ -n "$APP_USER" ] && ! grep -q "^${APP_USER}:" /etc/passwd 2>/dev/null; then
  # The image may have been overridden/rebuilt without that user; never die on it.
  APP_USER=""
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true

  if [ -n "$APP_USER" ]; then
    # Preferred: hand the mount to the unprivileged app user. As root, chown is
    # enough regardless of the current mode (and -R covers files an earlier boot
    # left behind on the volume).
    chown -R "$APP_USER" "$DATA_DIR" 2>/dev/null || \
      echo "[entrypoint] warning: could not chown $DATA_DIR to $APP_USER" >&2
  fi

  if [ ! -w "$DATA_DIR" ]; then
    # root and chown both failed: widen the mode rather than crash-looping.
    if chmod 0777 "$DATA_DIR" 2>/dev/null; then
      echo "[entrypoint] $DATA_DIR refused chown; opened it to 0777 so SQLite can write" >&2
    else
      echo "[entrypoint] FATAL: $DATA_DIR cannot be made writable." >&2
      echo "[entrypoint]   Railway: Service -> Settings -> Storage must mount the volume at" >&2
      echo "[entrypoint]   $DATA_DIR, and DATABASE_PATH must point inside it (e.g. $DATA_DIR/codevia.db)." >&2
      exit 1
    fi
  fi

  if [ -n "$APP_USER" ]; then
    # setpriv keeps argv intact (no shell re-splitting) — preferred, and
    # util-linux is an Essential package so it exists in the slim image.
    if command -v setpriv >/dev/null 2>&1; then
      exec setpriv --reuid "$APP_USER" --regid "$(id -g "$APP_USER")" --clear-groups "$@"
    fi
    # Fallback. `su -c CMD user` runs CMD in the outer shell (the user is never
    # used) and `su user ARGS` treats ARGS as the login shell name; both silently
    # do the wrong thing. Quote the command into a single -c string instead.
    # Safe here because the start command is a fixed, trusted constant
    # (node dist/index.js), never operator input.
    cmd="exec"
    for a in "$@"; do
      cmd="$cmd '$(printf %s "$a" | sed "s/'/'\\\\''/g")'"
    done
    exec su -s /bin/sh -c "$cmd" "$APP_USER"
  fi

  exec "$@"
else
  # Already unprivileged (a platform that ignores USER dropped us lower, or a
  # read-only-rootfs setup). Verify storage ourselves and say what is wrong
  # instead of letting SQLite fail with an opaque "unable to open database file".
  if [ ! -w "$DATA_DIR" ]; then
    echo "[entrypoint] FATAL: $DATA_DIR is not writable by uid $(id -u)." >&2
    echo "[entrypoint]   The container started non-root, so the root-owned Railway volume" >&2
    echo "[entrypoint]   mount could not be prepared at boot. Either let the image run as root" >&2
    echo "[entrypoint]   (the entrypoint fixes ownership and drops privileges itself), or chown" >&2
    echo "[entrypoint]   $DATA_DIR to uid $(id -u) on the volume." >&2
    exit 1
  fi
fi

exec "$@"
