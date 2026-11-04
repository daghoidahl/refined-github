# omnidiff-wasm

The build behind `source/omnidiff.wasm`, used by the `omnidiff` feature (`source/features/omnidiff.tsx`
through `source/helpers/omnidiff.ts`).

omnidiff's diff engine (https://github.com/ivankovic/omnidiff, AGPL-3.0-only) compiled to
WebAssembly. Two builds come out of one crate: `omnidiff_wasm.wasm`, a WASI reactor whose C ABI
(`omnidiff_alloc`, `omnidiff_diff`, `omnidiff_free`, documented in `src/lib.rs`) the extension calls,
and `omnidiff-wasm.wasm`, a stdin/stdout command for the terminal. Both take two versions of a file
and give back the ranges omnidiff would paint (Identical / Update / Insert / Delete / Move), per side.

    node run-reactor.mjs target/wasm32-wasip1/release/omnidiff_wasm.wasm < test.json
    node run.mjs target/wasm32-wasip1/release/omnidiff-wasm.wasm < test.json

Input `{"before", "after", "path"}`; the path only picks the grammar by extension. Output
`{"language", "before": [[op, sr, sc, er, ec, dr, dc, der, dec], ...], "after": [...]}` with
source range then destination range; columns are byte offsets in the row.

## Build

1. `git clone https://github.com/ivankovic/omnidiff ../omnidiff-src` (tested at commit 54c504b)
   and `git -C ../omnidiff-src apply $PWD/omnidiff-wasm-support.patch`.
2. `rustup target add wasm32-wasip1` and `pip install ziglang`.
3. `./build.sh`, then copy `target/wasm32-wasip1/release/omnidiff_wasm.wasm` to `source/omnidiff.wasm`.
   Result: 38 MB wasm (3.6 MB gzipped), 23 grammars.

## What the patch does and why

- `tree-sitter-vim` becomes an optional feature (on by default, off for wasm). Its 4.5 MB
  `parser.c` needs more than 14 GB RAM to compile for wasm32 with clang 18 or zig's clang, at any
  optimisation level. So the wasm build has no Vimscript.
- `build_sides` and `run_tasks` run in order on wasm: there are no threads there.

## Known limits

- `zigcc-wasi.sh` strips `-g` and `--target=`: debug info also blows the memory, and zig spells the
  target `wasm32-wasi`.
- `.cargo/config.toml` links a 256 MB shadow stack (what omnidiff's TUI gives its diff thread; a
  590 KB Rust file overflowed 64 MB). `run.mjs` uses Node's `node:wasi`, which segfaults when the
  wasm memory grows after start; `run-reactor.mjs` uses the browser shim and has no such limit.
- Timings in Node: 125 KB Java 0.5 s, 590 KB Rust 8 s, 900 KB JSON 17 s. The feature skips files
  over 300 KB and runs the engine on the main thread.
