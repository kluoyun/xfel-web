/*
 * Minimal ANSI escape sequence renderer for the terminal output.
 *
 * Supports the SGR (CSI ... m) attributes that C code typically emits:
 *   0 reset, 1 bold, 3 italic, 4 underline, 22/23/24 off,
 *   30-37 fg, 90-97 bright fg, 40-47 bg, 100-107 bright bg,
 *   38;5;n / 48;5;n (xterm-256), 38;2;r;g;b / 48;2;... (truecolor),
 *   39/49 default colors.
 * Other CSI sequences (cursor movement, erase, ...) are stripped.
 */

export interface AnsiSpan {
	text: string;
	color?: string;
	background?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
}

/* the base 16 palette: indexes 0-7 = 30-37, 8-15 = 90-97 (dark theme) */
const BASE16 = [
	'#3e3e3e', '#cd3131', '#0dbc79', '#e5e510',
	'#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
	'#666666', '#f14c4c', '#23d18b', '#f5f543',
	'#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

/** xterm-256 palette entry to css color */
function color256(n: number): string {
	if (n < 16)
		return BASE16[n];
	if (n < 232) {
		const t = n - 16;
		const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
		return `rgb(${level(Math.floor(t / 36))}, ${level(Math.floor(t / 6) % 6)}, ${level(t % 6)})`;
	}
	const gray = 8 + (n - 232) * 10;
	return `rgb(${gray}, ${gray}, ${gray})`;
}

const CSI_RE = /\x1b\[([0-9;:]*)([a-zA-Z])/g;

/** parse a line of text with ANSI sequences into styled spans */
export function parseAnsi(text: string): AnsiSpan[] {
	const spans: AnsiSpan[] = [];
	let color: string | undefined;
	let background: string | undefined;
	let bold = false;
	let italic = false;
	let underline = false;
	let buffer = '';

	const flush = () => {
		if (buffer.length > 0)
			spans.push({ text: buffer, color, background, bold, italic, underline });
		buffer = '';
	};

	CSI_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	let index = 0;
	while ((m = CSI_RE.exec(text)) !== null) {
		buffer += text.slice(index, m.index);
		index = m.index + m[0].length;
		if (m[2] !== 'm')
			continue; /* non-SGR escape: stripped */
		flush(); /* the text so far carries the previous style */

		const params = m[1].split(/[;:]/).map((p) => (p === '' ? 0 : parseInt(p, 10)));
		for (let i = 0; i < params.length; i++) {
			const p = params[i];
			if (p === 0) {
				color = background = undefined;
				bold = italic = underline = false;
			} else if (p === 1) {
				bold = true;
			} else if (p === 3) {
				italic = true;
			} else if (p === 4) {
				underline = true;
			} else if (p === 22) {
				bold = false;
			} else if (p === 23) {
				italic = false;
			} else if (p === 24) {
				underline = false;
			} else if (p === 39) {
				color = undefined;
			} else if (p === 49) {
				background = undefined;
			} else if (p >= 30 && p <= 37) {
				color = BASE16[p - 30];
			} else if (p >= 90 && p <= 97) {
				color = BASE16[8 + (p - 90)];
			} else if (p >= 40 && p <= 47) {
				background = BASE16[p - 40];
			} else if (p >= 100 && p <= 107) {
				background = BASE16[8 + (p - 100)];
			} else if (p === 38 || p === 48) {
				const target = p === 38 ? 'fg' : 'bg';
				const mode = params[i + 1];
				if (mode === 5) {
					const c = color256(params[i + 2]);
					if (target === 'fg') color = c; else background = c;
					i += 2;
				} else if (mode === 2) {
					const c = `rgb(${params[i + 2]}, ${params[i + 3]}, ${params[i + 4]})`;
					if (target === 'fg') color = c; else background = c;
					i += 4;
				}
			}
		}
	}
	buffer += text.slice(index);
	flush();
	return spans;
}

/** true when the text contains any ANSI escape sequences */
export function hasAnsi(text: string): boolean {
	return text.includes('\x1b[');
}
