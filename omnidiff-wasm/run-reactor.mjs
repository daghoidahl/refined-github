// node run-reactor.mjs omnidiff_wasm.wasm < input.json — the browser's call path, via the same WASI shim
import {ConsoleStdout, WASI} from '/home/user/refined-github/node_modules/@bjorn3/browser_wasi_shim/dist/index.js';
import {readFileSync} from 'node:fs';
const wasi = new WASI([], [], [
	new ConsoleStdout(() => undefined),
	new ConsoleStdout(b => process.stdout.write(b)),
	new ConsoleStdout(b => process.stderr.write(b)),
]);
const {instance} = await WebAssembly.instantiate(readFileSync(process.argv[2]), {
	wasi_snapshot_preview1: wasi.wasiImport,
});
wasi.initialize(instance);
const e = instance.exports;
const input = new TextEncoder().encode(readFileSync(0, 'utf8'));
const p = e.omnidiff_alloc(input.length);
new Uint8Array(e.memory.buffer).set(input, p);
const r = e.omnidiff_diff(p, input.length);
const n = new DataView(e.memory.buffer).getUint32(r, true);
console.log(new TextDecoder().decode(new Uint8Array(e.memory.buffer, r + 4, n)));
e.omnidiff_free(r, 4 + n);
