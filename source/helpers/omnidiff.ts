import {messageRuntime} from 'webext-msg';

import type {DiffRequest, FileDiff} from './omnidiff-engine.js';

export type {FileDiff, Operation, RangeMatch} from './omnidiff-engine.js';

/** Diffs two versions of a file in the background worker, where wasm may run. `path` only picks the grammar. */
export default async function diffFile(before: string, after: string, path: string): Promise<FileDiff> {
	const request: DiffRequest = {before, after, path};
	return messageRuntime({omnidiff: request});
}
