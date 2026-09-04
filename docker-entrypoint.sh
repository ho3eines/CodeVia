#!/bin/sh
set -eu

# Railway volumes are mounted after the image is created and are owned by root.
# Prepare the mount before dropping privileges so SQLite can create its database,
# WAL and journal files there.
DATA_DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R codevia:codevia "$DATA_DIR"

  # Keep the application non-root in the normal image, while still allowing a
  # root-owned Railway volume to be initialized on first boot.
  exec su -s /bin/sh codevia -c 'exec "$@"' -- "$@"
fi

# Also works when a platform explicitly runs the image as the non-root user.
exec "$@"
