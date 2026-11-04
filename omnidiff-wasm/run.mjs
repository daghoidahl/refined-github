// node run.mjs omnidiff-wasm.wasm < input.json   (Node's built-in WASI, no shim)
import {readFileSync} from 'node:fs';
import {WASI} from 'node:wasi';
const wasi = new WASI({version: 'preview1'});
const {instance} = await WebAssembly.instantiate(readFileSync(process.argv[2]), wasi.getImportObject());
process.exit(wasi.start(instance));
