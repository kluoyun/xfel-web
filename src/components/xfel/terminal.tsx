/*
 * The fake terminal, Linux-console style: the console IS the input. A
 * blinking block cursor sits on the prompt line (overwrite mode, hollow
 * when unfocused), Tab completes commands / subcommands / ddr types and
 * both "version" and "xfel version" execute. Only C program stdout and
 * echoed commands live here - app notifications use toasts, never this
 * view.
 */

import { Fragment, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Terminal as TerminalIcon } from 'lucide-react';
import { ddrTypesForChip } from '@/lib/ddr-types';
import { parseAnsi, hasAnsi } from '@/lib/ansi';
import type { TerminalBuffer } from '@/lib/terminal-buffer';

interface TerminalProps {
	term: TerminalBuffer;
	connected: boolean;
	busy: boolean;
	chipName: string | null;
	onSubmit: (cmdline: string) => void;
}

/** tab completion for the text before the caret; returns the completed
 * text and, when ambiguous, the candidate list to print */
function completionFor(before: string, chipName: string | null): { completed: string; list?: string[] } | null {
	const m = /(\S*)$/.exec(before);
	const last = m ? m[1] : '';
	const head = before.slice(0, before.length - last.length);
	const tokens = before.trim().split(/\s+/).filter(Boolean);
	/* an optional leading "xfel" is not part of the command sequence */
	const seq = tokens[0]?.toLowerCase() === 'xfel' ? tokens.slice(1) : tokens;

	let pool: string[] = [];
	if (seq.length === 0) {
		/* completing the first word: only the xfel prefix executes */
		pool = ['xfel'];
	} else if (seq[0] === 'spinor' || seq[0] === 'spinand') {
		pool = seq[0] === 'spinor'
			? ['erase', 'read', 'write']
			: ['erase', 'read', 'write', 'splwrite'];
	} else if (seq[0] === 'ddr') {
		const types = chipName ? ddrTypesForChip(chipName) : null;
		pool = types ?? [];
	}
	if (pool.length === 0)
		return null;

	const candidates = pool.filter((c) => c.startsWith(last) && c !== last);
	if (candidates.length === 0)
		return null;

	if (candidates.length === 1)
		return { completed: head + candidates[0] + ' ' };

	/* ambiguous: complete the longest common prefix, print the rest */
	let lcp = candidates[0];
	for (const c of candidates)
		while (!c.startsWith(lcp))
			lcp = lcp.slice(0, -1);
	if (lcp.length > last.length)
		return { completed: head + lcp };

	return { completed: before, list: candidates };
}

/** renders a line (or live fragment) with its ansi styling applied */
function AnsiText({ text }: { text: string }) {
	if (!hasAnsi(text))
		return <>{text}</>;
	const spans = parseAnsi(text);
	return (
		<>
			{spans.map((sp, i) => (
				<span
					key={i}
					style={{
						color: sp.color,
						background: sp.background,
						fontWeight: sp.bold ? 700 : undefined,
						fontStyle: sp.italic ? 'italic' : undefined,
						textDecoration: sp.underline ? 'underline' : undefined,
					}}
				>
					{sp.text}
				</span>
			))}
		</>
	);
}

export function Terminal({ term, connected, busy, chipName, onSubmit }: TerminalProps) {
	const scrollRef = useRef<HTMLPreElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const historyRef = useRef<string[]>([]);
	const historyIndexRef = useRef(-1);
	const [value, setValue] = useState('');
	const [caret, setCaret] = useState(0);
	const [focused, setFocused] = useState(false);

	/* track stdout revisions: fresh output always auto-scrolls, while idle
	 * renders only re-pin when already near the bottom so history browsing
	 * is never yanked away. the previous near-bottom-only guard made the
	 * auto-scroll never engage from a non-bottom position. */
	const currentRevision = term.getRevision();
	const prevRevisionRef = useRef(currentRevision);

	useEffect(() => {
		const hasNewOutput = prevRevisionRef.current !== currentRevision;
		prevRevisionRef.current = currentRevision;
		if (!hasNewOutput)
			return; /* renders from other parts of the app must never scroll */
		requestAnimationFrame(() => {
			const el = scrollRef.current;
			if (!el)
				return;
			/* fresh output: pin the terminal to the very bottom and keep
			 * its end within the viewport (the terminal sits at the end of
			 * a long page; internal scrolling alone cannot fix a row
			 * clipped by the window edge) */
			el.scrollTop = el.scrollHeight;
			if (el.getBoundingClientRect().bottom > window.innerHeight)
				el.scrollIntoView({ block: 'nearest' });
		});
	});

	/* the bundled web font finishes loading asynchronously and reflows the
	 * terminal (no react render happens then), which must be re-scrolled */
	useEffect(() => {
		if (!document.fonts)
			return;
		document.fonts.ready.then(() => {
			const el = scrollRef.current;
			if (el && el.scrollHeight - el.clientHeight - el.scrollTop < 48)
				el.scrollTop = el.scrollHeight;
		}).catch(() => undefined);
	}, []);

	/* grab keyboard focus once, when the connection is established -
	 * busy-state changes must not steal focus from other inputs */
	useEffect(() => {
		if (connected)
			inputRef.current?.focus({ preventScroll: true });
	}, [connected]);

	const submit = () => {
		const raw = value.trim();
		if (busy)
			return;
		setValue('');
		setCaret(0);
		if (!raw) {
			/* empty enter: the prompt line becomes part of the output and
			 * a fresh prompt follows immediately, like a real shell */
			term.printLine('xfel> ');
			return;
		}
		historyRef.current.push(raw);
		historyIndexRef.current = historyRef.current.length;
		onSubmit(raw);
	};

	const recall = (step: -1 | 1) => {
		const history = historyRef.current;
		if (history.length === 0)
			return;
		historyIndexRef.current = Math.min(history.length, Math.max(0, historyIndexRef.current + step));
		setValue(historyIndexRef.current < history.length ? history[historyIndexRef.current] : '');
		setCaret(historyIndexRef.current < history.length ? history[historyIndexRef.current].length : 0);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.nativeEvent.isComposing)
			return;
		if (e.key === 'Enter') {
			e.preventDefault();
			submit();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			recall(-1);
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			recall(1);
		} else if (e.key === 'Tab') {
			e.preventDefault();
			const before = value.slice(0, caret);
			const after = value.slice(caret);
			const r = completionFor(before, chipName);
			if (!r)
				return;
			if (r.list)
				term.printLine(r.list.join('    '));
			setValue(r.completed + after);
			setCaret(r.completed.length);
		}
	};

	const lines = term.getLines();
	const live = term.getLive();
	const showPrompt = connected && !busy;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
					<TerminalIcon className="size-4 text-terminal-green" />
					终端
				</CardTitle>
			</CardHeader>
			<CardContent className="relative">
				<pre
					ref={scrollRef}
					className="xfel-console relative h-72 overflow-auto rounded-md border border-border bg-background px-3 pt-3 cursor-text"
					onClick={() => {
						/* releasing a drag fires click: only take focus when the
						 * user was not selecting text, or the selection is lost */
						const selection = document.getSelection?.();
						if (selection && selection.toString().length > 0)
							return;
						inputRef.current?.focus({ preventScroll: true });
					}}
				>
					{lines.map((line, i) => (
						<Fragment key={i}>
							{line.startsWith('xfel> ') ? (
								<span className="text-terminal-green">xfel&gt;&nbsp;</span>
							) : null}
							<AnsiText text={line.startsWith('xfel> ') ? line.slice(6) : line} />
							{i < lines.length - 1 ? '\n' : null}
						</Fragment>
					))}
					{lines.length > 0 ? '\n' : null}
					{live && (
						<>
							<AnsiText text={live} />
							{'\n'}
						</>
					)}
					{showPrompt && (
						<>
							<span className="text-terminal-green select-none">xfel&gt;&nbsp;</span>
							<span className="whitespace-pre">{value.slice(0, caret)}</span>
							<span className={'xfel-cursor' + (focused ? '' : ' xfel-cursor-idle')}>
								{value[caret] ?? ' '}
							</span>
							<span className="whitespace-pre">{value.slice(caret + 1)}</span>
						</>
					)}
					<span className="block h-3" aria-hidden />
				</pre>
				<input
					ref={inputRef}
					value={value}
					disabled={!connected}
					className="xfel-hidden-input"
					autoComplete="off"
					autoCapitalize="off"
					spellCheck={false}
					onChange={(e) => { setValue(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
					onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
					onKeyDown={handleKeyDown}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
				/>
			</CardContent>
		</Card>
	);
}
