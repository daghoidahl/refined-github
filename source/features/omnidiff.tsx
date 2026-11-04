import './omnidiff.css';

import {onAbort} from 'abort-utils';
import * as pageDetect from 'github-url-detection';
import {$$, closestElement, closestElementOptional} from 'select-dom';

import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import {getConversationNumber, getRepo} from '../github-helpers/index.js';
import diffFile, {type FileDiff, type Operation, type RangeMatch} from '../helpers/omnidiff.js';
import observe from '../helpers/selector-observer.js';

// Ponytail: the engine runs on the main thread; a worker when files this big matter
const maxFileBytes = 300_000;

type Side = 'before' | 'after';

const highlightNames = ['deletion', 'addition', 'move'] as const;
const highlights = Object.fromEntries(
	highlightNames.map(name => [name, new Highlight()]),
) as Record<typeof highlightNames[number], Highlight>;

/** Undefined for text omnidiff found unchanged: it keeps its syntax colors, like in omnidiff's own viewer */
function highlightFor(operation: Operation, side: Side): Highlight | undefined {
	switch (operation) {
		case 'Identical': {
			return undefined;
		}

		case 'Move': {
			return highlights.move;
		}

		case 'Insert':
		case 'Delete':
		case 'Update': {
			return side === 'before' ? highlights.deletion : highlights.addition;
		}
	}
}

/** The pull request's diff is merge base → head, which is what `/files` shows */
async function getShas(): Promise<{base: string; head: string}> {
	const pr = await api.v3(`pulls/${getConversationNumber()!}`);
	const compare = await api.v3(`compare/${pr.base.sha}...${pr.head.sha}`);
	return {base: compare.merge_base_commit.sha, head: pr.head.sha};
}

type Versions = FileDiff & {beforeText: string; afterText: string};

const shas = new Map<string, Promise<{base: string; head: string}>>();
const fileDiffs = new Map<string, Promise<Versions | undefined>>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function fetchFile(sha: string, path: string): Promise<string | undefined> {
	const response = await fetch(`/${getRepo()!.nameWithOwner}/raw/${sha}/${path}`);
	if (response.status === 404) {
		return undefined; // Added or deleted file: GitHub's whole-file paint is already right
	}

	if (!response.ok) {
		throw new Error(`omnidiff: ${response.status} fetching ${path} at ${sha}`);
	}

	const text = await response.text();
	return text.length <= maxFileBytes ? text : undefined;
}

async function getVersions(path: string): Promise<Versions | undefined> {
	const key = location.pathname.split('/').slice(0, 5).join('/');
	shas.set(key, shas.get(key) ?? getShas());
	const {base, head} = await shas.get(key)!;

	const fileKey = `${base}..${head}:${path}`;
	fileDiffs.set(
		fileKey,
		fileDiffs.get(fileKey) ?? (async () => {
			const [beforeText, afterText] = await Promise.all([fetchFile(base, path), fetchFile(head, path)]);
			if (beforeText === undefined || afterText === undefined) {
				return undefined;
			}

			return {...await diffFile(beforeText, afterText, path), beforeText, afterText};
		})(),
	);
	// Undefined for added, deleted and too large files
	return fileDiffs.get(fileKey)!;
}

/** The character offset in `line` of byte offset `column` */
function charOffset(line: string, column: number): number {
	return decoder.decode(encoder.encode(line).subarray(0, column)).length;
}

/** The ranges of a 0-based `row`, clipped to that row, as [operation, startChar, endChar] */
function rangesOnRow(ranges: RangeMatch[], row: number, line: string): Array<[Operation, number, number]> {
	const result: Array<[Operation, number, number]> = [];
	for (const range of ranges) {
		if (range.startRow > row || range.endRow < row) {
			continue;
		}

		const start = range.startRow === row ? charOffset(line, range.startColumn) : 0;
		const end = range.endRow === row ? charOffset(line, range.endColumn) : line.length;
		if (end > start) {
			result.push([range.operation, start, end]);
		}
	}

	return result;
}

/** A DOM range over characters `start`..`end` of `element`'s text, or undefined when the text is shorter */
function domRange(element: HTMLElement, start: number, end: number): Range | undefined {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	const range = new Range();
	let offset = 0;
	let startFound = false;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const {length} = node.textContent!;
		if (!startFound && start <= offset + length) {
			range.setStart(node, start - offset);
			startFound = true;
		}

		if (startFound && end <= offset + length) {
			range.setEnd(node, end - offset);
			return range;
		}

		offset += length;
	}

	return undefined;
}

function lineNumberOf(code: HTMLElement): {side: Side; number: number} | undefined {
	// React view: the cell carries the line number; the type is on the `code` element
	const reactCell = closestElementOptional('td.diff-text-cell[data-line-number]', code);
	if (reactCell) {
		const type = closestElement('code.diff-text', code);
		const number = Number(reactCell.getAttribute('data-line-number'));
		return number > 0 ? {side: type.classList.contains('deletion') ? 'before' : 'after', number} : undefined;
	}

	// Legacy view
	const cell = closestElement([
		'.blob-code-deletion', // Left side
		'.blob-code-addition', // Right side
	], code);
	const side: Side = cell.classList.contains('blob-code-deletion') ? 'before' : 'after';
	const row = closestElement('tr', cell);
	const numbers = $$('[data-line-number]', row);
	const splitSide = cell.getAttribute('data-split-side');
	const numberCell = splitSide
		? numbers.find(element => element.getAttribute('data-split-side') === splitSide)
		: (side === 'before' ? numbers[0] : numbers.at(-1));
	if (!numberCell) {
		return undefined;
	}

	const number = Number(numberCell.getAttribute('data-line-number'));
	return number > 0 ? {side, number} : undefined;
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** GitHub anchors each file as `diff-` + SHA-256 of its path, so the PR's file list maps anchors back to paths */
async function getPathsByAnchor(): Promise<Map<string, string>> {
	const paths = new Map<string, string>();
	for await (const page of api.v3paginated(`pulls/${getConversationNumber()!}/files?per_page=100`)) {
		for (const {filename} of page as unknown as Array<{filename: string}>) {
			// eslint-disable-next-line no-await-in-loop -- Sequential by design, the digests are instant
			paths.set(await sha256(filename), filename);
		}
	}

	return paths;
}

const pathsByAnchor = new Map<string, Promise<Map<string, string>>>();

async function filePathOf(code: HTMLElement): Promise<string | undefined> {
	// Legacy view
	const legacy = closestElementOptional('[data-tagsearch-path]', code);
	if (legacy) {
		return legacy.getAttribute('data-tagsearch-path')!;
	}

	// React view
	const anchored = closestElementOptional('[data-line-anchor^="diff-"]', code);
	if (!anchored) {
		return undefined;
	}

	const hash = anchored.getAttribute('data-line-anchor')!.slice('diff-'.length, 'diff-'.length + 64);
	const key = location.pathname.split('/').slice(0, 5).join('/');
	pathsByAnchor.set(key, pathsByAnchor.get(key) ?? getPathsByAnchor());
	const paths = await pathsByAnchor.get(key)!;
	return paths.get(hash);
}

async function paint(code: HTMLElement): Promise<void> {
	const line = lineNumberOf(code);
	const path = await filePathOf(code);
	if (!line || !path) {
		return;
	}

	const versions = await getVersions(path);
	if (!versions || !code.isConnected) {
		return;
	}

	const row = line.number - 1;
	const text = (line.side === 'before' ? versions.beforeText : versions.afterText).split('\n')[row];
	if (text === undefined || code.textContent.replace(/\n$/, '') !== text) {
		return; // The cell shows something else than the fetched line; better unpainted than wrong
	}

	for (const [operation, start, end] of rangesOnRow(versions[line.side], row, text)) {
		const highlight = highlightFor(operation, line.side);
		const range = highlight && domRange(code, start, end);
		if (range) {
			highlight.add(range);
		}
	}

	code.classList.add('rgh-omnidiff');
}

function init(signal: AbortSignal): void {
	for (const name of highlightNames) {
		CSS.highlights.set(`rgh-omnidiff-${name}`, highlights[name]);
	}

	observe(
		[
			'code.diff-text.deletion .diff-text-inner', // React view, left side
			'code.diff-text.addition .diff-text-inner', // React view, right side
			':is(.blob-code-addition, .blob-code-deletion) .blob-code-inner', // Legacy view
		],
		paint,
		{signal},
	);
	onAbort(signal, () => {
		for (const highlight of Object.values(highlights)) {
			highlight.clear();
		}
	});
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isPRFiles,
	],
	exclude: [
		pageDetect.isPRFile404,
		pageDetect.isPRCommit, // Base and head of a single commit are not the PR's
	],
	init,
});

/*

Test URLs:

- https://github.com/refined-github/sandbox/pull/18/files

*/
