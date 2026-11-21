/*
 * End-to-end test of the built TypeScript glue layer (glue/build/xfel.js),
 * running in node against a WebUSB-API-shaped mock device backed by
 * MockFelDevice. This exercises the browser-side stack that the real page
 * uses: the direct C API (persistent session, heap transfers, return
 * values), the command line passthrough (fake terminal), stdout parsing,
 * progress reporting and error handling — everything except the real
 * WebUSB DOM.
 *
 * Requires `make ts` (npm build) and `make node` first — now: `make test-glue` bundles it automatically.
 */

import assert from 'node:assert/strict';
import { MockFelDevice } from './mock-fel.mjs';
import { XFel, XFelError, XFelUnsupportedError, XFelAbortError, FEL_VID, FEL_PID } from './.build/glue.mjs';

class MockUsbDevice {
	constructor(chipId) {
		this.fel = new MockFelDevice(chipId);
		this.vendorId = FEL_VID;
		this.productId = FEL_PID;
		this.usbVersionMajor = 2;
		this.usbVersionMinor = 0;
		this.usbVersionSubminor = 0;
		this.deviceClass = 0;
		this.deviceSubclass = 0;
		this.deviceProtocol = 0;
		this.deviceVersionMajor = 1;
		this.deviceVersionMinor = 0;
		this.deviceVersionSubminor = 0;
		this.configurations = [{
			configurationValue: 1,
			interfaces: [{
				interfaceNumber: 0,
				alternates: [{
					alternateSetting: 0,
					interfaceClass: 0xff,
					interfaceSubclass: 0,
					interfaceProtocol: 0,
					endpoints: [
						{ endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 512 },
						{ endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 512 },
					],
				}],
			}],
		}];
		this.configuration = this.configurations[0];
		this.opened = false;
	}

	async open() { this.opened = true; }
	async close() { this.opened = false; }
	async selectConfiguration() {}
	async claimInterface() {}

	async transferOut(endpointNumber, data) {
		this.fel.bulkOut(0x01 | 0x00, data);
		return { bytesWritten: data.byteLength, status: 'ok' };
	}

	async transferIn(endpointNumber, length) {
		const d = this.fel.bulkIn(0x80 | endpointNumber, length);
		return { status: 'ok', data: new DataView(d.buffer, d.byteOffset, d.byteLength) };
	}
}

class MockUsb {
	constructor(chipId) {
		this.device = new MockUsbDevice(chipId);
	}
	async getDevices() { return [this.device]; }
	async requestDevice() { return this.device; }
}

let passed = 0;
async function check(name, fn) {
	await fn();
	passed++;
	console.log(`  ok - ${name}`);
}

const logs = [];
const progress = [];
const usb = new MockUsb(0x00162300);

const xfel = await XFel.create({
	usb,
	onLog: (t) => logs.push(t),
	onProgress: (r) => progress.push(r),
});

await check('connect requests and opens the FEL device', async () => {
	const device = await usb.requestDevice();
	assert.equal(device.vendorId, FEL_VID);
	assert.equal(device.productId, FEL_PID);
	assert.ok(await xfel.connectDevice());
	assert.equal(xfel.connected, true);
});

await check('version() reads the persistent session in one handshake', async () => {
	const v = await xfel.version();
	assert.equal(v.magic, 'AWUSB');
	assert.equal(v.id, 0x00162300);
	assert.equal(v.chip, 'A10');
	assert.equal(v.scratchpad, 0x00008000);
});

await check('repeated version() calls reuse the session (no re-handshake)', async () => {
	const before = Module_frameCount();
	await xfel.version();
	await xfel.version();
	const delta = Module_frameCount() - before;
	/* fel_init() version exchange happens once at open; subsequent calls
	 * must not run any AWUC frame again */
	assert.equal(delta, 0, `expected no new usb frames, got ${delta}`);
});

function Module_frameCount() {
	return xfel.backend.getDevice(1).fel.frames;
}

await check('read32()/write32() return real values through the heap', async () => {
	await xfel.write32(0x02000000, 0xdeadbeef);
	assert.equal(await xfel.read32(0x02000000), 0xdeadbeef);
	assert.equal(xfel.backend.getDevice(1).fel.memRead(0x02000000, 1)[0], 0xef);
});

await check('read()/write() move binary data over the wasm heap (no MEMFS)', async () => {
	const data = new Uint8Array(1000);
	for(let i = 0; i < data.length; i++)
		data[i] = (i * 7) & 0xff;
	await xfel.write(0x45000000, data);
	assert.equal(xfel.backend.getDevice(1).fel.memRead(0x45000000, 1)[0], data[0]);
	const back = await xfel.read(0x45000000, data.length);
	assert.deepEqual([...back], [...data]);
	assert.equal(xfel.backend.getDevice(1).fel.memRead(0x45000000, data.length).length, data.length);
});

await check('hexdump() formats through the C side and captures stdout', async () => {
	const text = await xfel.hexdump(0x45000000, 32);
	assert.match(text, /45000000: 00 07 0e 15/);
});

await check('progress hook fires during bulk transfers', async () => {
	assert.ok(progress.length > 0);
	assert.equal(progress[progress.length - 1], 1.0);
});

await check('run() passes raw command lines through (fake terminal)', async () => {
	const text = await xfel.run('version');
	assert.match(text, /ID=0x00162300\(A10\)/);
});

await check('spinorDetect() reports a missing flash as null', async () => {
	assert.equal(await xfel.spinorDetect(), null);
});

await check('unsupported sid() throws the structured unsupported error', async () => {
	await assert.rejects(() => xfel.sid(), XFelUnsupportedError);
});

await check('unsupported jtag() and ddr() are soft failures too', async () => {
	await assert.rejects(() => xfel.jtag(), XFelUnsupportedError);
	await assert.rejects(() => xfel.ddr(), XFelUnsupportedError);
});

await check('a failing usb transfer aborts the session; a fresh instance recovers', async () => {
	const backend = xfel.backend;
	const device = backend.getDevice(1);
	const original = device.transferIn.bind(device);

	/* make the next bulk in transfer fail like a stalled endpoint */
	device.transferIn = async () => { throw new Error('mock: stalled'); };

	/* fel.c prints "usb bulk recv error" and calls exit(-1) */
	await assert.rejects(() => xfel.read32(0x1000), XFelAbortError);

	device.transferIn = original;
	device.fel.reset();

	/* the aborted instance fails fast instead of pretending to work */
	await assert.rejects(() => xfel.read32(0x0), XFelAbortError);
	await assert.rejects(() => xfel.run('version'), XFelAbortError);

	/* reconnect creates a fresh session which recovers */
	const x2 = await XFel.create({ usb, onLog: () => {}, onProgress: () => {} });
	await x2.connectDevice();
	const v = await x2.version();
	assert.equal(v.chip, 'A10');
});

await check('stdout streamed through onLog', async () => {
	assert.ok(logs.some((t) => t.includes('A10')));
});

console.log(`\nAll ${passed} glue tests passed.`);
process.exit(0);
