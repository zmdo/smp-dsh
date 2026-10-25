#!/bin/sh
set -eu
node /app/docker/render-profile.mjs
exec dsh web --no-open --host 0.0.0.0 --port 9090
