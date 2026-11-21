/*
 * Terminal-style output buffer shared by the whole UI.
 *
 * emscripten's stdout callback fires on '\n', so every C line arrives as
 * one chunk that ends with '\r' (the CR of CRLF) and never contains '\n'.
 * Progress output is different: it starts with '\r' and is flushed by
 * fflush() without any '\n'. So a chunk starting with '\r' is a redraw of
 * the current line, anything else is a complete line to append.
 */

const MAX_LINES = 800;

export class TerminalBuffer {
	private lines: string[] = [];
	private live = '';
	private version = 0;
	private listeners = new Set<() => void>();

	print(text: string): void {
		if (text.startsWith('\r')) {
			/* progress redraw, keep only the newest segment */
			const body = text.endsWith('\r') ? text.slice(1, -1) : text.slice(1);
			this.live = body.slice(body.lastIndexOf('\r') + 1);
		} else {
			const body = text.endsWith('\r') ? text.slice(0, -1) : text;
			if (body.length > 0) {
				this.lines.push(body);
				if (this.lines.length > MAX_LINES)
					this.lines.shift();
			}
			this.live = '';
		}
		this.version++;
		this.notify();
	}

	printLine(text: string): void {
		this.print(text + '\r');
	}


	/** echo a submitted terminal command, like a real shell would */
	echo(cmdline: string): void {
		this.print(`xfel> ${cmdline}\r`);
	}

	clear(): void {
		this.lines = [];
		this.live = '';
		this.version++;
		this.notify();
	}

	getLines(): readonly string[] {
		return this.lines;
	}

	getLive(): string {
		return this.live;
	}

	/** monotonically increasing revision, for useSyncExternalStore */
	getRevision(): number {
		return this.version;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for(const listener of this.listeners)
			listener();
	}
}
