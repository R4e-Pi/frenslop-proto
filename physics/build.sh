#!/usr/bin/env bash
# Builds physics/physics_server against Box3D v0.1.0 (Erin Catto, MIT).
#   npm run build:physics                      # clones Box3D v0.1.0 into physics/vendor/box3d
#   BOX3D_DIR=~/box3d npm run build:physics    # reuse an existing checkout (e.g. box3d-net-demo's)
set -euo pipefail
cd "$(dirname "$0")"

BOX3D_DIR="${BOX3D_DIR:-vendor/box3d}"
BOX3D_REF="v0.1.0"

if [ ! -f "$BOX3D_DIR/include/box3d/box3d.h" ]; then
  echo "• cloning Box3D $BOX3D_REF into $BOX3D_DIR"
  git clone --quiet --depth 1 --branch "$BOX3D_REF" https://github.com/erincatto/box3d.git "$BOX3D_DIR"
else
  echo "• using Box3D at $BOX3D_DIR ($(git -C "$BOX3D_DIR" describe --tags 2>/dev/null || echo 'unknown version'))"
fi

LIB="$BOX3D_DIR/build-frenslop/src/libbox3d.a"
if [ ! -f "$LIB" ]; then
  echo "• building libbox3d (release, no samples/tests) — a few minutes on a Pi 5"
  cmake -S "$BOX3D_DIR" -B "$BOX3D_DIR/build-frenslop" -DCMAKE_BUILD_TYPE=Release \
    -DBOX3D_SAMPLES=OFF -DBOX3D_UNIT_TESTS=OFF -DBOX3D_BENCHMARKS=OFF -DBOX3D_VALIDATE=OFF > /dev/null
  cmake --build "$BOX3D_DIR/build-frenslop" -j"$(nproc)" > /dev/null
fi

echo "• compiling physics_server"
cc -O2 -std=gnu17 -Wall -Wextra -Wno-unused-parameter \
  -I"$BOX3D_DIR/include" physics_server.c "$LIB" -lm -lpthread -o physics_server
echo "✓ physics/physics_server ready ($(./physics_server < /dev/null && echo ok))"
