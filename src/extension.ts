import * as vscode from 'vscode';

const SECTION = 'hmmmAutoLinenum';

export interface LineEdit {
	line: number;
	start: number;
	end: number;
	text: string;
}

const JUMPS = /^(jumpn|calln|call|j(eq|ne|gt|lt)zn?|j(eq|ne|gt|lt|ge|le)n)$/i;

export interface Hints {
	numberLine?: number;
	clear?: { line: number; col: number };
}

type Kind = 'code' | 'blank' | 'comment' | 'cleared';

export function computeEdits(lines: string[], hints: Hints = {}): LineEdit[] {
	const parsed = lines.map((text, i) => {
		const m = /^(\s*)(\d*)(\s*)/.exec(text)!;
		const digits = m[2];
		const rest = text.slice(m[0].length);
		let kind: Kind;
		let end = m[0].length;
		if (hints.clear?.line === i && digits && rest === '' && hints.clear.col <= m[1].length + digits.length) {
			kind = 'cleared';
		} else if (hints.numberLine === i && text.trim() === '') {
			kind = 'code';
			end = text.length;
		} else if (rest.startsWith('#')) {
			kind = 'comment';
		} else if (text.trim() === '') {
			kind = 'blank';
		} else {
			kind = 'code';
		}
		return { text, digits, sep: m[3], rest, kind, end };
	});

	const count = parsed.filter(p => p.kind === 'code').length;
	const width = Math.max(2, String(Math.max(count - 1, 0)).length);
	const edits: LineEdit[] = [];
	const seen = new Map<number, number>();
	const moved = new Map<number, number>();
	let n = 0;

	parsed.forEach((p, i) => {
		let prefix: string;
		if (p.kind === 'cleared' || (p.kind === 'comment' && p.digits)) {
			prefix = '';
		} else if (p.kind === 'code') {
			if (p.digits) {
				const old = Number(p.digits);
				seen.set(old, (seen.get(old) ?? 0) + 1);
				moved.set(old, n);
			}
			const num = String(n++).padStart(width, '0');
			prefix = p.digits ? num + (p.sep || (p.rest ? ' ' : '')) : num + ' ';
		} else {
			return;
		}
		if (prefix !== p.text.slice(0, p.end)) {
			edits.push({ line: i, start: 0, end: p.end, text: prefix });
		}
	});

	parsed.forEach((p, i) => {
		if (p.kind !== 'code') {
			return;
		}
		const code = p.rest.split('#')[0];
		const m = /^([A-Za-z]+)\b.*?[\s,](\d+)\s*$/.exec(code);
		if (!m || !JUMPS.test(m[1])) {
			return;
		}
		const old = Number(m[2]);
		const target = seen.get(old) === 1 ? moved.get(old) : undefined;
		if (target === undefined || target === old) {
			return;
		}
		const padded = m[2].length > 1 && m[2].startsWith('0');
		const start = p.end + code.trimEnd().length - m[2].length;
		edits.push({
			line: i,
			start,
			end: start + m[2].length,
			text: padded ? String(target).padStart(width, '0') : String(target),
		});
	});

	return edits;
}

function hintsFor(e: vscode.TextDocumentChangeEvent): Hints {
	if (e.contentChanges.length !== 1) {
		return {};
	}
	const c = e.contentChanges[0];
	const start = c.range.start;
	if (c.rangeLength === 0 && /^\r?\n[ \t]*$/.test(c.text)) {
		const doc = e.document;
		const below = start.line + 1;
		if (doc.lineAt(below).isEmptyOrWhitespace) {
			return { numberLine: below };
		}
		if (start.character === 0 && doc.lineAt(start.line).isEmptyOrWhitespace) {
			return { numberLine: start.line };
		}
	} else if (c.text === '' && c.rangeLength > 0 && start.line === c.range.end.line) {
		return { clear: { line: start.line, col: start.character } };
	}
	return {};
}

function isHmmm(doc: vscode.TextDocument): boolean {
	return doc.uri.scheme !== 'output' && doc.fileName.toLowerCase().endsWith('.hmmm');
}

function isEnabled(): boolean {
	return vscode.workspace.getConfiguration(SECTION).get<boolean>('enabled', true);
}

let busy = false;
const pending = new Map<vscode.TextDocument, { hints: Hints; version: number }>();

async function renumber(doc: vscode.TextDocument, hints: Hints = {}): Promise<void> {
	if (busy) {
		pending.set(doc, { hints, version: doc.version });
		return;
	}
	busy = true;
	try {
		const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text);
		const edits = computeEdits(lines, hints);
		if (edits.length > 0) {
			const ranges = edits.map(e => new vscode.Range(e.line, e.start, e.line, e.end));
			const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
			if (editor) {
				await editor.edit(
					b => edits.forEach((e, k) => b.replace(ranges[k], e.text)),
					{ undoStopBefore: false, undoStopAfter: false }
				);
			} else {
				const we = new vscode.WorkspaceEdit();
				edits.forEach((e, k) => we.replace(doc.uri, ranges[k], e.text));
				await vscode.workspace.applyEdit(we);
			}
		}
	} catch {
		// A concurrent change will already have queued another pass.
	} finally {
		busy = false;
	}

	const next = pending.entries().next().value;
	if (next) {
		const [nextDoc, { hints: nextHints, version }] = next;
		pending.delete(nextDoc);
		await renumber(nextDoc, nextDoc.version === version ? nextHints : {});
	}
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(e => {
			if (!isEnabled() || !isHmmm(e.document) || e.contentChanges.length === 0) {
				return;
			}
			if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) {
				return;
			}
			void renumber(e.document, hintsFor(e));
		}),

		vscode.commands.registerCommand('hmmm-auto-linenum.toggle', async () => {
			const enabled = !isEnabled();
			await vscode.workspace.getConfiguration(SECTION).update('enabled', enabled, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`HMMM auto line numbering ${enabled ? 'enabled' : 'disabled'}.`);
			if (enabled) {
				vscode.window.visibleTextEditors
					.filter(e => isHmmm(e.document))
					.forEach(e => void renumber(e.document));
			}
		})
	);
}

export function deactivate() {}