/*
 * Tests for the terminal output buffer (src/lib/terminal-buffer.ts),
 * which renders emscripten's stdout chunks in the UI terminal.
 * Chunk shapes mirror what emscripten actually delivers:
 *   - C lines arrive as one chunk ending with '\r' (flushed on '\n')
 *   - progress lines start with '\r' (flushed by fflush, no '\n')
 */

import assert from 'node:assert/strict';
import { TerminalBuffer } from './.build/terminal-buffer.mjs';

let passed = 0;
async function check(name, fn) {
	await fn();
	passed++;
	console.log(`  ok - ${name}`);
}

await check('boot line renders immediately', () => {
	const t = new TerminalBuffer();
	t.printLine('请将设备进入 FEL 模式后，点击右上角「连接设备」。');
	assert.match([...t.getLines(), t.getLive()].join('\n'), /请将设备进入 FEL 模式后/);
});

await check('version output line ending with CR renders immediately', () => {
	const t = new TerminalBuffer();
	t.print('AWUSB ID=0x00162300(A10) dflag=0x00 dlength=0x00 scratchpad=0x00008000\r');
	assert.match([...t.getLines(), t.getLive()].join('\n'), /AWUSB ID=0x00162300\(A10\)/);
});

await check('consecutive stdout lines all render (hexdump case)', () => {
	const t = new TerminalBuffer();
	t.print('45000000: 00 07 0e 15 1c 23 2a 31 38 3f 46 4d 54 5b 62 69  .....#*18?FMT[bi\r');
	t.print('45000010: 70 77 7e 85 8c 93 9a a1 a8 af b6 bd c4 cb d2 d9  pw~.............\r');
	const text = [...t.getLines(), t.getLive()].join('\n');
	assert.match(text, /45000000: 00 07 0e 15/);
	assert.match(text, /45000010: 70 77 7e 85/);
});

await check('progress redraws collapse into a single live line', () => {
	const t = new TerminalBuffer();
	t.print('\r 12% [======                                              ] 1.2 MB/s, ETA 00:05        \r');
	assert.match(t.getLive(), / 12% \[/);
	t.print('\r 87% [=====================================             ] 1.4 MB/s, ETA 00:01        \r');
	assert.match(t.getLive(), / 87% \[/);
	assert.doesNotMatch(t.getLive(), / 12% \[/);
	t.print('\r');
	assert.equal(t.getLive(), '');
});

await check('history is capped', () => {
	const t = new TerminalBuffer();
	for(let i = 0; i < 3000; i++)
		t.print(`line ${i}\r`);
	assert.equal(t.getLines().length, 800);
	assert.match([...t.getLines(), t.getLive()].join('\n'), /line 2999/);
});

await check('revision advances and listeners are notified', () => {
	const t = new TerminalBuffer();
	const before = t.getRevision();
	let notified = 0;
	const unsubscribe = t.subscribe(() => notified++);
	t.print('hello\r');
	assert.equal(t.getRevision(), before + 1);
	assert.equal(notified, 1);
	unsubscribe();
	t.print('world\r');
	assert.equal(notified, 1);
});

console.log(`\nAll ${passed} terminal-buffer tests passed.`);
