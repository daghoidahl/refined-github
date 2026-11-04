#!/bin/sh
# Builds omnidiff-wasm.wasm (wasm32-wasip1). Needs: rustup target wasm32-wasip1, and
# `pip install ziglang` (zig bundles wasi-libc; no wasi-sdk download needed).
# ../omnidiff-src must be an omnidiff checkout (tested at 54c504b) with omnidiff-wasm-support.patch applied.
set -e
cd "$(dirname "$0")"
CC_wasm32_wasip1=$PWD/zigcc-wasi.sh AR_wasm32_wasip1=$PWD/zigar.sh \
  cargo build -j2 --release --target wasm32-wasip1
ls -la target/wasm32-wasip1/release/omnidiff-wasm.wasm
