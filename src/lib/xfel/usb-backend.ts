/*
 * WebUSB backend for the xfel wasm build.
 *
 * An instance of this class must be assigned to Module.xfelUsb right
 * after the emscripten module is created; the C adapter layer
 * (adapter/libusb_webusb.c) routes all libusb calls to it:
 *
 *   libusb_init / get_device_list  ->  refresh / deviceCount / deviceId
 *   libusb_open / claim_interface  ->  open()
 *   libusb_get_device_descriptor   ->  deviceDescriptor()
 *   libusb_get_active_config_descriptor -> configDescriptor()
 *   libusb_bulk_transfer           ->  bulkOut() / bulkIn()
 *
 * The WebUSB API exposes parsed descriptors only, so the raw descriptor
 * bytes expected by the C side are rebuilt here from the parsed
 * structures. All methods resolve instead of rejecting: failures are
 * reported with negative libusb-style error codes, so a rejected
 * promise can never leave the asyncified wasm suspended forever.
 */

export const FEL_VID = 0x1f3a;
export const FEL_PID = 0xefe8;

/* libusb-style error codes, mirrored from adapter/libusb.h */
export const LIBUSB_ERROR_TIMEOUT = -7;
export const LIBUSB_ERROR_PIPE = -9;
export const LIBUSB_ERROR_OTHER = -99;

export type BulkResult = number; /* bytes transferred or negative error */

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`USB transfer timeout (${ms}ms)`)), ms);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

export class XfelUsbBackend {
	readonly usb: USB;
	/* per-transfer timeout, mirrors libusb's 10000ms in fel.c */
	timeoutMs = 10000;

	private devices = new Map<number, USBDevice>();
	private idByDevice = new Map<USBDevice, number>();
	private claimed = new Set<number>();
	private nextId = 1;

	/** called when one of the tracked FEL devices disappears */
	onDeviceDisconnected?: () => void;

	constructor(usb: USB) {
		if (!usb) throw new Error('WebUSB is not available in this browser (Chrome/Edge required, served from a secure context)');
		this.usb = usb;
		/* the mock used by the node tests has no event support */
		usb.addEventListener?.('disconnect', (ev: USBConnectionEvent) => {
			for(const [id, device] of [...this.devices]) {
				if (device !== ev.device)
					continue;
				this.devices.delete(id);
				this.claimed.delete(id);
				this.onDeviceDisconnected?.();
			}
		});
	}

	/**
	 * Ask the user to pick the FEL device. Must be called from a user
	 * gesture (button click). The device is also added to the device
	 * list so the next command finds it without another refresh.
	 */
	async requestDevice(): Promise<USBDevice | null> {
		let device: USBDevice;
		try {
			device = await this.usb.requestDevice({ filters: [{ vendorId: FEL_VID, productId: FEL_PID }] });
		} catch {
			return null; /* user cancelled or no device */
		}
		const id = this.remember(device);
		this.devices.set(id, device);
		return device;
	}

	/**
	 * Rescan the devices granted by the user (navigator.usb.getDevices()).
	 * Called by libusb_init() before every xfel command.
	 */
	async refresh(): Promise<boolean> {
		try {
			const granted = await this.usb.getDevices();
			const fel = granted.filter((d) => d.vendorId === FEL_VID && d.productId === FEL_PID);
			this.devices.clear();
			for(const device of fel)
				this.devices.set(this.remember(device), device);
			return true;
		} catch {
			return false;
		}
	}

	deviceCount(): number {
		return this.devices.size;
	}

	deviceId(index: number): number {
		const ids = [...this.devices.keys()];
		return index >= 0 && index < ids.length ? ids[index] : 0;
	}

	getDevice(id: number): USBDevice | undefined {
		return this.devices.get(id);
	}

	/**
	 * Open and claim interface 0, idempotent across commands because
	 * the wasm build keeps the device open for the whole session.
	 */
	async open(id: number): Promise<boolean> {
		const device = this.devices.get(id);
		if (!device)
			return false;
		try {
			if (!device.opened)
				await device.open();
			if (!device.configuration)
				await device.selectConfiguration(1);
			if (!this.claimed.has(id)) {
				await device.claimInterface(0);
				this.claimed.add(id);
			}
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Release the device for real (XFel.disconnect()).
	 */
	async disconnect(id?: number): Promise<void> {
		for(const key of [...this.claimed]) {
			if (id !== undefined && key !== id)
				continue;
			const device = this.devices.get(key);
			this.claimed.delete(key);
			if (device && device.opened) {
				try { await device.close(); } catch { /* ignore */ }
			}
		}
	}

	/**
	 * Standard 18-byte device descriptor rebuilt from the parsed device.
	 */
	deviceDescriptor(id: number): Uint8Array {
		const d = new Uint8Array(18);
		const device = this.devices.get(id);
		if (!device)
			return d;
		const v = new DataView(d.buffer);
		d[0] = 0x12;              /* bLength */
		d[1] = 0x01;              /* bDescriptorType: device */
		v.setUint16(2, (device.usbVersionMajor << 8) | device.usbVersionMinor, true);
		d[4] = device.deviceClass;
		d[5] = device.deviceSubclass;
		d[6] = device.deviceProtocol;
		d[7] = 0x40;              /* bMaxPacketSize0, not exposed by WebUSB */
		v.setUint16(8, device.vendorId, true);
		v.setUint16(10, device.productId, true);
		v.setUint16(12, (device.deviceVersionMajor << 8) | device.deviceVersionMinor, true);
		d[14] = 0;                /* iManufacturer */
		d[15] = 0;                /* iProduct */
		d[16] = 0;                /* iSerialNumber */
		d[17] = device.configurations.length;
		return d;
	}

	/**
	 * Raw configuration descriptor blob rebuilt from the parsed
	 * configuration, walking interfaces/altsettings/endpoints.
	 */
	configDescriptor(id: number): Uint8Array {
		const device = this.devices.get(id);
		const config = device?.configuration;
		if (!config)
			return new Uint8Array(0);

		let total = 9;
		for(const iface of config.interfaces) {
			for(const alt of iface.alternates)
				total += 9 + alt.endpoints.length * 7;
		}

		const d = new Uint8Array(total);
		const v = new DataView(d.buffer);
		d[0] = 9;                 /* bLength */
		d[1] = 0x02;              /* bDescriptorType: configuration */
		v.setUint16(2, total, true);
		d[4] = config.interfaces.length;
		d[5] = config.configurationValue;
		d[6] = 0;                 /* iConfiguration */
		d[7] = 0x80;              /* bmAttributes: bus powered */
		d[8] = 50;                /* bMaxPower: 100mA */

		const transferTypes: Record<string, number> = { control: 0, isochronous: 1, bulk: 2, interrupt: 3 };
		let off = 9;
		for(const iface of config.interfaces) {
			for(const alt of iface.alternates) {
				d[off] = 9;         /* bLength */
				d[off + 1] = 0x04;  /* bDescriptorType: interface */
				d[off + 2] = iface.interfaceNumber;
				d[off + 3] = alt.alternateSetting;
				d[off + 4] = alt.endpoints.length;
				d[off + 5] = alt.interfaceClass;
				d[off + 6] = alt.interfaceSubclass;
				d[off + 7] = alt.interfaceProtocol;
				d[off + 8] = 0;     /* iInterface */
				off += 9;
				for(const ep of alt.endpoints) {
					d[off] = 7;         /* bLength */
					d[off + 1] = 0x05;  /* bDescriptorType: endpoint */
					d[off + 2] = ep.endpointNumber | (ep.direction === 'in' ? 0x80 : 0x00);
					d[off + 3] = transferTypes[ep.type] ?? 0;
					v.setUint16(off + 4, ep.packetSize, true);
					d[off + 6] = 0;     /* bInterval */
					off += 7;
				}
			}
		}
		return d;
	}

	async bulkOut(id: number, endpointAddress: number, data: Uint8Array<ArrayBuffer>, timeout: number = this.timeoutMs): Promise<BulkResult> {
		const device = this.devices.get(id);
		if (!device || !device.opened)
			return LIBUSB_ERROR_OTHER;
		try {
			const result = await withTimeout(device.transferOut(endpointAddress & 0x7f, data), timeout);
			return result.bytesWritten;
		} catch (e) {
			return e instanceof Error && e.message.includes('timeout') ? LIBUSB_ERROR_TIMEOUT : LIBUSB_ERROR_OTHER;
		}
	}

	async bulkIn(id: number, endpointAddress: number, length: number, timeout: number = this.timeoutMs): Promise<Uint8Array | null> {
		const device = this.devices.get(id);
		if (!device || !device.opened)
			return null;
		try {
			const result = await withTimeout(device.transferIn(endpointAddress & 0x7f, length), timeout);
			if (result.status === 'stall')
				return null; /* mapped to LIBUSB_ERROR_PIPE by the C shim */
			if (!result.data)
				return new Uint8Array(0);
			return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
		} catch (e) {
			return null;
		}
	}

	private remember(device: USBDevice): number {
		let id = this.idByDevice.get(device);
		if (id === undefined) {
			id = this.nextId++;
			this.idByDevice.set(device, id);
		}
		return id;
	}
}
