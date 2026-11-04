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

const highlightNames = ['same', 'deletion', 'addition', 'move'] as const;
const highlights = Object.fromEntries(
	highlightNames.map(name => [name, new Highlight()]),
) as Record<typeof highlightNames[number], Highlight>;

function highlightFor(operation: Operation, side: Side): Highlight {
	switch (operation) {
		case 'Identical': {
			return highlights.same;
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
	const versions = await fileDiffs.get(fileKey)!;
	// Undefined for added, deleted and too large files
	return versions?.language === 'Unknown' ? undefined : versions;
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
	const cell = closestElement([
		'.blob-code-deletion', // Left side, both views
		'.blob-code-addition', // Right side, both views
	], code);
	const side: Side = cell.classList.contains('blob-code-deletion') ? 'before' : 'after';
	const row = closestElement('tr, .diff-line-row', cell);
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

function filePathOf(code: HTMLElement): string | undefined {
	// Legacy view
	const legacy = closestElementOptional('[data-tagsearch-path]', code);
	if (legacy) {
		return legacy.getAttribute('data-tagsearch-path')!;
	}

	// React view: the header shows "old  new" for renames; the new name is what the head has
	const container = closestElementOptional('div[id^="diff-"]', code);
	if (!container) {
		return undefined;
	}

	const nameElement = $$([
		'[class*="file-name"] span:not(.sr-only)', // React PR files
		'[class*="file-name"] code', // React PR files, newer header
	], container).at(-1);
	if (!nameElement) {
		return undefined;
	}

	const name = nameElement.textContent.trim().replaceAll('‎', '').split('  ').at(-1)!;
	return name === '' ? undefined : name;
}

async function paint(code: HTMLElement): Promise<void> {
	const line = lineNumberOf(code);
	const path = filePathOf(code);
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
		const range = domRange(code, start, end);
		if (range) {
			highlightFor(operation, line.side).add(range);
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
			':is(.blob-code-addition, .blob-code-deletion) .blob-code-inner', // Legacy view
			':is(.blob-code-addition, .blob-code-deletion) .diff-text-inner', // React view
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
