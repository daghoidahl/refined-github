// The omnidiff diff engine (https://github.com/ivankovic/omnidiff, AGPL-3.0-only), compiled to
// WebAssembly as `assets/omnidiff.wasm`. The sources of that build are in `omnidiff-wasm/`.
// Runs in the background worker: Chrome refuses to compile wasm in content scripts
// (a bare `CompileError` from `instantiateStreaming`), whatever the manifest's CSP says.
import {ConsoleStdout, WASI} from '@bjorn3/browser_wasi_shim';

export type Operation = 'Identical' | 'Insert' | 'Delete' | 'Update' | 'Move';

/** Rows are 0-based; columns are byte offsets within the row. The destination is the matching range on the other side. */
export type RangeMatch = {
	operation: Operation;
	startRow: number;
	startColumn: number;
	endRow: number;
	endColumn: number;
};

export type FileDiff = {
	language: string;
	/** False when the file has no grammar and omnidiff fell back to its line diff */
	structural: boolean;
	before: RangeMatch[];
	after: RangeMatch[];
};

type RawDiff = {
	language: string;
	structural: boolean;
	before: Array<[Operation, number[]]>;
	after: Array<[Operation, number[]]>;
};

/* eslint-disable @typescript-eslint/naming-convention -- Names fixed by wasm and WASI */
type Exports = {
	memory: WebAssembly.Memory;
	_initialize: () => void;
	omnidiff_alloc: (length: number) => number;
	omnidiff_free: (pointer: number, length: number) => void;
	omnidiff_diff: (pointer: number, length: number) => number;
};
/* eslint-enable @typescript-eslint/naming-convention */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function load(): Promise<Exports> {
	const wasi = new WASI([], [], [
		new ConsoleStdout(() => undefined), // Stdin is never read
		new ConsoleStdout(bytes => {
			console.log(decoder.decode(bytes));
		}),
		new ConsoleStdout(bytes => {
			console.error('omnidiff:', decoder.decode(bytes));
		}),
	]);
	const {instance} = await WebAssembly.instantiateStreaming(
		fetch(chrome.runtime.getURL('assets/omnidiff.wasm')),
		// eslint-disable-next-line @typescript-eslint/naming-convention -- Name fixed by WASI
		{wasi_snapshot_preview1: wasi.wasiImport},
	) as unknown as {instance: {exports: Exports}};
	wasi.initialize(instance);
	return instance.exports;
}

let engine: Promise<Exports> | undefined;

function parseRanges(ranges: Array<[Operation, number[]]>): RangeMatch[] {
	return ranges.map(([operation, [startRow, startColumn, endRow, endColumn]]) => ({
		operation,
		startRow,
		startColumn,
		endRow,
		endColumn,
	}));
}

export type DiffRequest = {before: string; after: string; path: string};

/** Diffs two versions of a file. `path` only picks the grammar by its extension. */
export async function diffWithEngine({before, after, path}: DiffRequest): Promise<FileDiff> {
	engine ??= load();
	const exports = await engine;

	const input = encoder.encode(JSON.stringify({before, after, path}));
	const inputPointer = exports.omnidiff_alloc(input.length);
	new Uint8Array(exports.memory.buffer).set(input, inputPointer);

	const resultPointer = exports.omnidiff_diff(inputPointer, input.length);
	const length = new DataView(exports.memory.buffer).getUint32(resultPointer, true);
	const output = decoder.decode(new Uint8Array(exports.memory.buffer, resultPointer + 4, length));
	exports.omnidiff_free(resultPointer, 4 + length);

	const raw = JSON.parse(output) as RawDiff;
	return {
		language: raw.language,
		structural: raw.structural,
		before: parseRanges(raw.before),
		after: parseRanges(raw.after),
	};
}
