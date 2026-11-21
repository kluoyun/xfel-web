/*
 * A pure JavaScript mock Allwinner FEL device.
 *
 * It implements the same JavaScript backend contract as the WebUSB
 * backend (glue/src/usb-backend.ts), so the wasm build can be tested
 * end-to-end in node without real hardware. The FEL wire protocol is
 * reproduced from fel.c:
 *
 *   - bulk OUT, 32 bytes: "AWUC" request header { magic[8], length,
 *     unknown1, request(u16), length2, pad[10] }
 *   - request 0x12 (write): followed by one bulk OUT of `length` bytes,
 *     answered with 13 bytes "AWUS" + padding on bulk IN
 *   - request 0x11 (read): answered with `length` bytes of data followed
 *     by 13 bytes "AWUS" on bulk IN
 *   - FEL requests (16 bytes, request/address/length/pad): 0x001 version,
 *     0x101 write, 0x102 exec, 0x103 read
 */

export const FEL_VID = 0x1f3a;
export const FEL_PID = 0xefe8;

const USB_REQUEST_WRITE = 0x12;
const USB_REQUEST_READ = 0x11;

const FEL_REQUEST_VERSION = 0x001;
const FEL_REQUEST_WRITE = 0x101;
const FEL_REQUEST_EXEC = 0x102;
const FEL_REQUEST_READ = 0x103;

export class MockFelDevice {
	constructor(chipId) {
		this.chipId = chipId;
		this.mem = new Map();
		this.opened = false;
		this.frames = 0;
		this.reset();
	}

	reset() {
		this.expectingPayload = 0;
		this.pendingDataLen = 0;
		this.expectAwus = false;
		this.felOp = null;
	}

	/* paged memory emulation */
	memWrite(addr, data) {
		for(let i = 0; i < data.length; i++)
			this.mem.set(addr + i, data[i]);
	}

	memRead(addr, len) {
		const out = new Uint8Array(len);
		for(let i = 0; i < len; i++)
			out[i] = this.mem.has(addr + i) ? this.mem.get(addr + i) : 0;
		return out;
	}

	deviceDescriptor() {
		const d = new Uint8Array(18);
		const v = new DataView(d.buffer);
		d[0] = 0x12;              /* bLength */
		d[1] = 0x01;              /* bDescriptorType: device */
		v.setUint16(2, 0x0200, true);
		d[4] = 0x00;              /* bDeviceClass */
		d[5] = 0x00;              /* bDeviceSubClass */
		d[6] = 0x00;              /* bDeviceProtocol */
		d[7] = 0x40;              /* bMaxPacketSize0 */
		v.setUint16(8, FEL_VID, true);
		v.setUint16(10, FEL_PID, true);
		v.setUint16(12, 0x0100, true);
		d[14] = 0x01; d[15] = 0x02; d[16] = 0x03;
		d[17] = 0x01;             /* bNumConfigurations */
		return d;
	}

	configDescriptor() {
		return new Uint8Array([
			/* config descriptor */
			0x09, 0x02, 0x20, 0x00, 0x01, 0x01, 0x00, 0xc0, 0x00,
			/* interface descriptor, vendor class, 2 endpoints */
			0x09, 0x04, 0x00, 0x00, 0x02, 0xff, 0x00, 0x00, 0x00,
			/* bulk OUT endpoint 0x01 */
			0x07, 0x05, 0x01, 0x02, 0x00, 0x02, 0x00,
			/* bulk IN endpoint 0x81 */
			0x07, 0x05, 0x81, 0x02, 0x00, 0x02, 0x00,
		]);
	}

	versionResponse() {
		const d = new Uint8Array(32);
		const v = new DataView(d.buffer);
		d.set(new TextEncoder().encode('AWUSB'), 0);
		v.setUint32(8, this.chipId, true);       /* id */
		v.setUint32(12, 0x00010001, true);       /* firmware */
		v.setUint16(16, 2, true);                /* protocol */
		d[18] = 0;                               /* dflag */
		d[19] = 0;                               /* dlength */
		v.setUint32(20, 0x00008000, true);       /* scratchpad */
		return d;
	}

	awus() {
		const d = new Uint8Array(13);
		d.set(new TextEncoder().encode('AWUS'), 0);
		return d;
	}

	bulkOut(addr, data) {
		if(this.expectingPayload > 0)
		{
			if(data.length !== this.expectingPayload)
				throw new Error(`mock: payload size mismatch, expected ${this.expectingPayload}, got ${data.length}`);
			this.expectingPayload = 0;
			this.handlePayload(data);
			this.expectAwus = true;
			return data.length;
		}

		if(data.length !== 32 || data[0] !== 0x41 || data[1] !== 0x57 || data[2] !== 0x55 || data[3] !== 0x43)
			throw new Error('mock: bad AWUC request header');
		const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const length = v.getUint32(8, true);
		const request = v.getUint16(16, true);
		this.frames++;
		if(request === USB_REQUEST_WRITE)
		{
			this.expectingPayload = length;
		}
		else if(request === USB_REQUEST_READ)
		{
			this.pendingDataLen = length;
		}
		else
		{
			throw new Error(`mock: unexpected usb request 0x${request.toString(16)}`);
		}
		return data.length;
	}

	handlePayload(data) {
		if(data.length === 16)
		{
			const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
			const request = v.getUint32(0, true);
			if([FEL_REQUEST_VERSION, FEL_REQUEST_WRITE, FEL_REQUEST_EXEC, FEL_REQUEST_READ].includes(request))
			{
				this.felOp = {
					request,
					address: v.getUint32(4, true),
					length: v.getUint32(8, true),
				};
				return;
			}
		}
		if(this.felOp && this.felOp.request === FEL_REQUEST_WRITE)
		{
			if(data.length !== this.felOp.length)
				throw new Error(`mock: write size mismatch, expected ${this.felOp.length}, got ${data.length}`);
			this.memWrite(this.felOp.address, data);
			this.felOp = null;
			return;
		}
		throw new Error('mock: unexpected write payload');
	}

	readData(len) {
		const op = this.felOp;
		if(op && op.request === FEL_REQUEST_VERSION && len === 32)
			return this.versionResponse();
		if(op && op.request === FEL_REQUEST_READ)
			return this.memRead(op.address, len);
		return new Uint8Array(len);
	}

	bulkIn(addr, len) {
		if(this.expectAwus)
		{
			this.expectAwus = false;
			return this.awus();
		}
		if(this.pendingDataLen > 0)
		{
			if(len !== this.pendingDataLen)
				throw new Error(`mock: read size mismatch, expected ${this.pendingDataLen}, got ${len}`);
			this.pendingDataLen = 0;
			const d = this.readData(len);
			this.expectAwus = true;
			return d;
		}
		throw new Error('mock: unexpected bulk in');
	}
}

/*
 * The backend object attached to Module.xfelUsb. Same contract as
 * XfelUsbBackend in the typescript glue layer.
 */
export class MockFelBackend {
	constructor(chipId = 0x00162300) {
		this.device = new MockFelDevice(chipId);
		this.id = 1;
	}

	async refresh() {
		return true;
	}

	deviceCount() {
		return 1;
	}

	deviceId(index) {
		return this.id;
	}

	async open(id) {
		this.device.opened = true;
		return true;
	}

	async close(id) {
		this.device.opened = false;
	}

	async disconnect(id) {
		this.device.opened = false;
	}

	deviceDescriptor(id) {
		return this.device.deviceDescriptor();
	}

	configDescriptor(id) {
		return this.device.configDescriptor();
	}

	async bulkOut(id, ep, data, timeout) {
		return this.device.bulkOut(ep, data);
	}

	async bulkIn(id, ep, len, timeout) {
		return this.device.bulkIn(ep, len);
	}
}
