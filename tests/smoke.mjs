/*
 * End-to-end smoke test for the wasm build, running in node with a
 * mock FEL device (no real hardware needed). It exercises the whole
 * stack: command line tokenization -> main() -> libusb shim ->
 * EM_ASYNC_JS bridge -> mock device, plus MEMFS file plumbing and the
 * progress reporting hook.
 *
 * Usage: make test
 */

import assert from 'node:assert/strict';
import { MockFelBackend } from './mock-fel.mjs';
import createXFelModule from '../build/xfel-node.js';

const stdout = [];
const stderr = [];
const progress = [];

const Module = await createXFelModule({
	print: (t) => stdout.push(t),
	printErr: (t) => stderr.push(t),
});

Module.onProgress = (ratio) => progress.push(ratio);
Module.xfelUsb = new MockFelBackend();

async function run(cmd) {
	stdout.length = 0;
	stderr.length = 0;
	/* ccall() marshals the string argument and returns a promise for the
	 * asyncified xfel_run() */
	const rc = await Module.ccall('xfel_run', 'number', ['string'], [cmd]);
	return { rc, out: stdout.join('\n'), err: stderr.join('\n') };
}

let passed = 0;
function check(name, fn) {
	return async () => {
		await fn();
		passed++;
		console.log(`  ok - ${name}`);
	};
}

const tests = [
	check('version command reports the chip id and name', async () => {
		const { rc, out } = await run('version');
		assert.equal(rc, 0, `exit code ${rc}, stderr: ${out}`);
		assert.match(out, /ID=0x00162300\(A10\)/);
		assert.match(out, /scratchpad=0x00008000/);
	}),

	check('read32 command returns the emulated register value', async () => {
		const { rc, out } = await run('read32 0x00000000');
		assert.equal(rc, 0);
		assert.match(out, /0x00000000/);
	}),

	check('commands can be executed repeatedly (session reuse)', async () => {
		const { rc, out } = await run('version');
		assert.equal(rc, 0);
		assert.match(out, /ID=0x00162300\(A10\)/);
	}),

	check('write command stores bytes into the emulated memory', async () => {
		const data = new Uint8Array(1000);
		for(let i = 0; i < data.length; i++)
			data[i] = i & 0xff;
		Module.FS.writeFile('/in.bin', data);
		const { rc, out } = await run('write 0x45000000 /in.bin');
		assert.equal(rc, 0, `exit code ${rc}, output: ${out}`);
		const mem = Module.xfelUsb.device.memRead(0x45000000, data.length);
		assert.deepEqual([...mem], [...data]);
	}),

	check('read command fetches bytes back through MEMFS', async () => {
		const { rc, out } = await run('read 0x45000000 1000 /out.bin');
		assert.equal(rc, 0, `exit code ${rc}, output: ${out}`);
		const got = Module.FS.readFile('/out.bin');
		const mem = Module.xfelUsb.device.memRead(0x45000000, 1000);
		assert.deepEqual([...got], [...mem]);
	}),

	check('progress hook is fed during transfers', async () => {
		assert.ok(progress.length > 0, 'Module.onProgress was never called');
		assert.equal(progress[progress.length - 1], 1.0);
	}),

	check('mock device framing sanity', async () => {
		assert.ok(Module.xfelUsb.device.frames > 0);
	}),
];

for(const t of tests)
	await t();

console.log(`\nAll ${passed} smoke tests passed.`);
process.exit(0);
