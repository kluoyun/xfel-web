/*
 * High-level TypeScript API for xfel in the browser.
 *
 * Two invocation paths into the same wasm module:
 *
 *  1. Direct C API (default): every typed method below calls an exported
 *     xfel_api_* function (adapter/xfel_api.c) through ccall(). The
 *     adapter keeps a persistent xfel context, so the FEL handshake runs
 *     once per session instead of once per command, results come back as
 *     real return values, and binary data moves through the wasm heap
 *     without any string parsing or MEMFS round trip.
 *
 *  2. Command line passthrough: run() feeds a command line to the
 *     unchanged main() via xfel_run(), exactly like the native CLI. Used
 *     by terminal-style frontends and for commands without a direct
 *     binding (xfel extra ...).
 *
 * Calls are serialized internally, so concurrent usage is safe. The
 * progress of bulk transfers is reported through onProgress (fed by the
 * wasm progress adapter) and all console output through onLog.
 */

import type { XFelModule, XfelModuleOptions } from './emscripten-types';
import { XfelUsbBackend, FEL_VID, FEL_PID } from './usb-backend';
import { loadXFelModuleFactory } from './emscripten-loader';

const ABORTED_MESSAGE = '会话已中断（USB 传输失败），请重新连接设备后再试';

export interface XFelVersionInfo {
	magic: string;
	id: number;
	chip: string;
	dflag: number;
	dlength: number;
	scratchpad: number;
}

export interface XFelFlashInfo {
	name: string;
	capacity: number;
}

export interface XFelOptions {
	/** Custom USB implementation, defaults to navigator.usb */
	usb?: USB;
	/** Raw stdout hook (including carriage-return progress output) */
	onLog?: (text: string) => void;
	/** Transfer progress: ratio in [0, 1] plus the transferred byte counts */
	onProgress?: (ratio: number, done: number, total: number) => void;
	/** Fired when the connected FEL device disappears from the system */
	onDeviceDisconnected?: () => void;
}

export class XFelError extends Error {
	output: string[];

	constructor(message: string, output: string[] = []) {
		super(message);
		this.name = 'XFelError';
		this.output = output;
	}
}

/**
 * Thrown when the connected chip does not support an operation (jtag,
 * sid, ddr, reset, ...). The UI treats this as an informational hint
 * instead of a failure.
 */
export class XFelUnsupportedError extends XFelError {}

/**
 * Thrown when the C side aborted the session via exit() after a fatal
 * USB transfer error - a severe condition the UI should surface with a
 * dialog instead of a toast.
 */
export class XFelAbortError extends XFelError {}

function isExitStatus(e: unknown): boolean {
	return !!e && typeof e === 'object' && 'status' in (e as Record<string, unknown>) && !(e instanceof Error);
}

export class XFel {
	readonly backend: XfelUsbBackend;
	private mod: XFelModule;
	private sink: ((text: string) => void) | null = null;
	private chain: Promise<unknown> = Promise.resolve();
	/** set when the C side aborted the session via exit() after a fatal
	 * transfer error; every operation then fails fast until a fresh
	 * session is created (reconnect instantiates a new module) */
	private aborted = false;
	/** Raw stdout hook (including carriage-return progress output) */
	onLog?: (text: string) => void;
	/** Transfer progress: ratio in [0, 1] plus the transferred byte counts */
	onProgress?: (ratio: number, done: number, total: number) => void;

	private constructor(mod: XFelModule, backend: XfelUsbBackend) {
		this.mod = mod;
		this.backend = backend;
	}

	/**
	 * Instantiate the wasm module. No USB device is requested yet, so
	 * this does not need a user gesture.
	 */
	static async create(options: XFelOptions = {}): Promise<XFel> {
		const usb = options.usb ?? (typeof navigator !== 'undefined' ? navigator.usb : undefined);
		if (!usb)
			throw new XFelError('WebUSB is not available in this browser (Chrome/Edge required, served from a secure context)');
		const backend = new XfelUsbBackend(usb);

		const modOptions: XfelModuleOptions = {};
		const xfelRef: { xfel?: XFel } = {};
		modOptions.print = (text: string) => {
			xfelRef.xfel?.emit(text);
			options.onLog?.(text);
		};
		modOptions.printErr = modOptions.print;
		modOptions.onProgress = (ratio: number, done: number, total: number) => {
			xfelRef.xfel?.onProgress?.(ratio, done, total);
			options.onProgress?.(ratio, done, total);
		};

		backend.onDeviceDisconnected = () => options.onDeviceDisconnected?.();
		const mod = await (await loadXFelModuleFactory())(modOptions);
		mod.xfelUsb = backend;
		const xfel = new XFel(mod, backend);
		xfelRef.xfel = xfel;
		return xfel;
	}

	/**
	 * Instantiate and open a FEL device with one handshake. MUST be
	 * called from a user gesture (a button click handler), because
	 * navigator.usb.requestDevice() requires one.
	 */
	static async connect(options: XFelOptions = {}): Promise<XFel> {
		const xfel = await XFel.create(options);
		const device = await xfel.backend.requestDevice();
		if (!device)
			throw new XFelError('No FEL device selected (or WebUSB request was cancelled)');
		await xfel.version(); /* runs the single fel_init handshake */
		return xfel;
	}

	/**
	 * True when a granted FEL device is available.
	 */
	get connected(): boolean {
		return this.backend.deviceCount() > 0;
	}

	/** Product id of the FEL device protocol (0xefe8). */
	static get PID(): number { return FEL_PID; }
	/** Vendor id of Allwinner FEL devices (0x1f3a). */
	static get VID(): number { return FEL_VID; }

	/**
	 * Release the underlying USB device and drop the wasm session. The
	 * XFel instance can reconnect afterwards with connectDevice().
	 */
	async disconnect(): Promise<void> {
		this.aborted = false;
		await this.job(async () => {
			await this.ccallRaw('xfel_api_close', null, [], []);
		});
		await this.backend.disconnect();
	}

	/**
	 * Request a FEL device on an already created instance. Must be
	 * called from a user gesture.
	 */
	async connectDevice(): Promise<boolean> {
		return (await this.backend.requestDevice()) !== null;
	}

	/*
	 * chip information
	 */
	async version(): Promise<XFelVersionInfo> {
		return this.job(async () => {
			await this.ensureOpen();
			const chip = await this.readString('xfel_api_get_chip_name', 64);
			const magic = await this.readString('xfel_api_get_magic', 16);
			const id = await this.ccallRaw('xfel_api_get_id', 'number', [], []);
			const dflag = await this.ccallRaw('xfel_api_get_dflag', 'number', [], []);
			const dlength = await this.ccallRaw('xfel_api_get_dlength', 'number', [], []);
			const scratchpad = await this.ccallRaw('xfel_api_get_scratchpad', 'number', [], []);
			return { magic, id, chip, dflag, dlength, scratchpad };
		});
	}

	async sid(): Promise<string> {
		return this.job(async () => {
			await this.ensureOpen();
			const buf = this.alloc(256);
			try {
				const ok = await this.ccallRaw('xfel_api_sid', 'number', ['number', 'number'], [buf, 256]);
				if (!ok)
					throw new XFelUnsupportedError('该芯片不支持 sid 命令');
				return this.mod.UTF8ToString(buf).trim();
			} finally {
				this.mod._free(buf);
			}
		});
	}

	/*
	 * memory access
	 */
	async read32(address: number): Promise<number> {
		return this.job(async () => {
			await this.ensureOpen();
			const ptr = this.alloc(4);
			try {
				const ok = await this.ccallRaw('xfel_api_read32', 'number', ['number', 'number'], [address >>> 0, ptr]);
				if (!ok)
					throw new XFelError(`该芯片不支持 read32（地址 ${hex32(address)}，芯片钩子缺失）`);
				return this.mod.HEAPU32[ptr >>> 2] >>> 0;
			} finally {
				this.mod._free(ptr);
			}
		});
	}

	async write32(address: number, value: number): Promise<void> {
		await this.job(async () => {
			await this.ensureOpen();
			const ok = await this.ccallRaw('xfel_api_write32', 'number', ['number', 'number'], [address >>> 0, value >>> 0]);
			if (!ok)
				throw new XFelError(`该芯片不支持 write32（地址 ${hex32(address)}，芯片钩子缺失）`);
		});
	}

	async exec(address: number): Promise<void> {
		await this.job(async () => {
			await this.ensureOpen();
			await this.ccallRaw('xfel_api_exec', 'number', ['number'], [address >>> 0]);
		});
	}

	async reset(): Promise<void> {
		await this.job(async () => {
			await this.ensureOpen();
			const ok = await this.ccallRaw('xfel_api_reset', 'number', [], []);
			if (!ok)
				throw new XFelUnsupportedError('该芯片不支持 reset 命令');
		});
	}

	async jtag(): Promise<void> {
		await this.job(async () => {
			await this.ensureOpen();
			const ok = await this.ccallRaw('xfel_api_jtag', 'number', [], []);
			if (!ok)
				throw new XFelUnsupportedError('该芯片不支持 jtag 命令');
		});
	}

	async ddr(type?: string): Promise<void> {
		await this.job(async () => {
			await this.ensureOpen();
			const ok = await this.ccallRaw('xfel_api_ddr', 'number', ['string'], [type ?? '']);
			if (!ok)
				throw new XFelUnsupportedError('该芯片不支持 DDR 初始化或初始化失败');
		});
	}

	/**
	 * Dump memory in hex format, returns the console output.
	 */
	async hexdump(address: number, length: number): Promise<string> {
		return this.job(async () => {
			await this.ensureOpen();
			const lines = await this.capture(async () => {
				await this.ccallRaw('xfel_api_hexdump', 'number', ['number', 'number'], [address >>> 0, length >>> 0]);
			});
			return lines.join('\n');
		});
	}

	/**
	 * Read memory into a Uint8Array (transferred over the wasm heap).
	 */
	async read(address: number, length: number): Promise<Uint8Array> {
		return this.job(async () => {
			await this.ensureOpen();
			const ptr = this.alloc(length);
			try {
				const ok = await this.ccallRaw('xfel_api_read', 'number', ['number', 'number', 'number'], [address >>> 0, ptr, length >>> 0]);
				if (!ok)
					throw new XFelError(`Failed to read ${length} bytes at ${hex32(address)}`);
				return this.mod.HEAPU8.slice(ptr, ptr + length);
			} finally {
				this.mod._free(ptr);
			}
		});
	}

	/**
	 * Write binary data to memory (transferred over the wasm heap).
	 */
	async write(address: number, data: ArrayBuffer | Uint8Array): Promise<void> {
		await this.job(async () => {
			await this.ensureOpen();
			const ptr = this.copyIn(data);
			try {
				const ok = await this.ccallRaw('xfel_api_write', 'number', ['number', 'number', 'number'], [address >>> 0, ptr, byteLength(data)]);
				if (!ok)
					throw new XFelError(`Failed to write ${byteLength(data)} bytes at ${hex32(address)}`);
			} finally {
				this.mod._free(ptr);
			}
		});
	}

	/*
	 * spi nor flash
	 */
	async spinorDetect(): Promise<XFelFlashInfo | null> {
		return this.job(async () => {
			await this.ensureOpen();
			return this.detectFlash('xfel_api_spinor_detect');
		});
	}

	async spinorErase(address: number, length: number): Promise<void> {
		await this.flashVoid('xfel_api_spinor_erase', address, length, 'spinor erase');
	}

	async spinorRead(address: number, length: number): Promise<Uint8Array> {
		return this.flashRead('xfel_api_spinor_read', address, length, 'spinor read');
	}

	async spinorWrite(address: number, data: ArrayBuffer | Uint8Array): Promise<void> {
		await this.flashWrite('xfel_api_spinor_write', address, data, 'spinor write');
	}

	/*
	 * spi nand flash
	 */
	async spinandDetect(): Promise<XFelFlashInfo | null> {
		return this.job(async () => {
			await this.ensureOpen();
			return this.detectFlash('xfel_api_spinand_detect');
		});
	}

	async spinandErase(address: number, length: number): Promise<void> {
		await this.flashVoid('xfel_api_spinand_erase', address, length, 'spinand erase');
	}

	async spinandRead(address: number, length: number): Promise<Uint8Array> {
		return this.flashRead('xfel_api_spinand_read', address, length, 'spinand read');
	}

	async spinandWrite(address: number, data: ArrayBuffer | Uint8Array): Promise<void> {
		await this.flashWrite('xfel_api_spinand_write', address, data, 'spinand write');
	}

	async spinandSplwrite(splitSize: number, address: number, data: ArrayBuffer | Uint8Array): Promise<void> {
		await this.job(async () => {
			await this.ensureOpen();
			const ptr = this.copyIn(data);
			try {
				const ok = await this.ccallRaw('xfel_api_spinand_splwrite', 'number', ['number', 'number', 'number', 'number'], [splitSize >>> 0, address >>> 0, ptr, byteLength(data)]);
				if (!ok)
					throw new XFelError(`Failed to write spi nand flash with split support (spinand splwrite)`);
			} finally {
				this.mod._free(ptr);
			}
		});
	}

	/*
	 * ecdsa256 signature for sha256 of sid
	 */
	async sign(publicKeyHex: string, privateKeyHex: string): Promise<Uint8Array> {
		return this.job(async () => {
			await this.ensureOpen();
			const out = this.alloc(64);
			try {
				const ok = await this.ccallRaw('xfel_api_sign', 'number', ['string', 'string', 'number'], [publicKeyHex, privateKeyHex, out]);
				if (!ok)
					throw new XFelError('Failed to generate the ecdsa256 signature (check the keys and the sid support)');
				return this.mod.HEAPU8.slice(out, out + 64);
			} finally {
				this.mod._free(out);
			}
		});
	}

	/*
	 * command line passthrough (fake terminal)
	 */
	async run(cmdline: string): Promise<string> {
		const lines = await this.command(cmdline);
		return lines.join('\n');
	}

	/*
	 * internals
	 */
	private emit(text: string): void {
		this.sink?.(text);
	}

	/*
	 * internals
	 */	/**
	 * Serialize all operations: only one job touches the device at a time.
	 */
	private job<T>(fn: () => Promise<T>): Promise<T> {
		if (this.aborted)
			return Promise.reject(new XFelAbortError(ABORTED_MESSAGE));
		const result = this.chain.then(fn, fn);
		this.chain = result.then(() => undefined, () => undefined);
		return result;
	}

	private ccallRaw<T = number>(ident: string, returnType: string | null, argTypes: string[], args: unknown[]): Promise<T> {
		/* ccall() awaits asyncified functions and returns their real result */
		const run = () => this.mod.ccall(ident, returnType ?? 'number', argTypes, args) as Promise<T> | T;
		return Promise.resolve(run()).then((v) => {
			/* when the C side exit()s mid-operation, emscripten swallows the
			 * ExitStatus during the asyncify rewind and the export resolves
			 * with undefined - that is a session abort, not a real result
			 * (every exported api here returns int; only close is void) */
			if (v === undefined && ident !== 'xfel_api_close') {
				this.aborted = true;
				throw new XFelAbortError(ABORTED_MESSAGE);
			}
			return v;
		}, (e) => {
			if (isExitStatus(e)) {
				this.aborted = true;
				throw new XFelAbortError(`USB 传输失败，会话已中断 (exit status ${(e as { status: number }).status})`);
			}
			throw e;
		}) as Promise<T>;
	}

	/**
	 * Open the persistent session inside a running job (never queue here,
	 * that would deadlock the chain).
	 */
	private async ensureOpen(): Promise<void> {
		const ok = await this.ccallRaw('xfel_api_open', 'number', [], []);
		if (!ok)
			throw new XFelError('No FEL device found (is the device in FEL mode?)');
	}

	private alloc(bytes: number): number {
		const ptr = this.mod._malloc(Math.max(1, bytes));
		if (!ptr)
			throw new XFelError(`Out of wasm memory (${bytes} bytes)`);
		return ptr;
	}

	private copyIn(data: ArrayBuffer | Uint8Array): number {
		const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
		const ptr = this.alloc(bytes.byteLength);
		this.mod.HEAPU8.set(bytes, ptr);
		return ptr;
	}

	private async readString(ident: string, size: number): Promise<string> {
		const buf = this.alloc(size);
		try {
			const ok = await this.ccallRaw(ident, 'number', ['number', 'number'], [buf, size]);
			if (!ok)
				throw new XFelError(`Failed to read a string from ${ident}`);
			return this.mod.UTF8ToString(buf);
		} finally {
			this.mod._free(buf);
		}
	}

	/**
	 * Run a C function while collecting its stdout, returns the lines.
	 */
	private async capture(fn: () => Promise<void>): Promise<string[]> {
		const lines: string[] = [];
		this.sink = (text) => {
			const stripped = text.replace(/\r/g, '');
			if (stripped.length > 0)
				lines.push(stripped);
		};
		try {
			await fn();
			return lines;
		} finally {
			this.sink = null;
		}
	}

	private async detectFlash(ident: string): Promise<XFelFlashInfo | null> {
		const name = this.alloc(128);
		const capacity = this.alloc(8);
		try {
			const ok = await this.ccallRaw(ident, 'number', ['number', 'number', 'number'], [name, 128, capacity]);
			if (!ok)
				return null;
			const lo = this.mod.HEAPU32[capacity >>> 2];
			const hi = this.mod.HEAPU32[(capacity >>> 2) + 1];
			return {
				name: this.mod.UTF8ToString(name),
				capacity: lo + hi * 4294967296,
			};
		} finally {
			this.mod._free(name);
			this.mod._free(capacity);
		}
	}

	private async flashVoid(ident: string, address: number, length: number, what: string): Promise<void> {
		await this.job(async () => {
			await this.ensureOpen();
			const ok = await this.ccallRaw(ident, 'number', ['number', 'number'], [address >>> 0, length >>> 0]);
			if (!ok)
				throw new XFelError(`Failed to ${what} (address ${hex32(address)}, length ${length})`);
		});
	}

	private async flashRead(ident: string, address: number, length: number, what: string): Promise<Uint8Array> {
		return this.job(async () => {
			await this.ensureOpen();
			const ptr = this.alloc(length);
			try {
				const ok = await this.ccallRaw(ident, 'number', ['number', 'number', 'number'], [address >>> 0, ptr, length >>> 0]);
				if (!ok)
					throw new XFelError(`Failed to ${what} (address ${hex32(address)}, length ${length})`);
				return this.mod.HEAPU8.slice(ptr, ptr + length);
			} finally {
				this.mod._free(ptr);
			}
		});
	}

	private async flashWrite(ident: string, address: number, data: ArrayBuffer | Uint8Array, what: string): Promise<void> {
		await this.job(async () => {
			await this.ensureOpen();
			const ptr = this.copyIn(data);
			try {
				const ok = await this.ccallRaw(ident, 'number', ['number', 'number', 'number'], [address >>> 0, ptr, byteLength(data)]);
				if (!ok)
					throw new XFelError(`Failed to ${what} (address ${hex32(address)}, length ${byteLength(data)})`);
			} finally {
				this.mod._free(ptr);
			}
		});
	}

	/**
	 * Command line passthrough: tokenizes the string and runs the
	 * unchanged main() from main.c. Returns the collected stdout.
	 */
	private async command(cmdline: string): Promise<string[]> {
		if (this.aborted)
			throw new XFelAbortError(ABORTED_MESSAGE);
		const run = async (): Promise<string[]> => {
			const lines: string[] = [];
			this.sink = (text) => {
				const parts = text.split('\r');
				for(const part of parts) {
					const trimmed = part.replace(/\r/g, '');
					if (trimmed.length > 0)
						lines.push(trimmed);
				}
			};
			try {
				const rc = await this.mod.ccall('xfel_run', 'number', ['string'], [cmdline]);
				if (rc !== 0) {
					const joined = lines.join('\n');
					throw new XFelError(`Command failed: '${cmdline}' (exit code ${rc})${joined ? ': ' + joined : ''}`, lines);
				}
				return lines;
			} catch (e) {
				if (isExitStatus(e)) {
					this.aborted = true;
					throw new XFelAbortError(`USB 传输失败，会话已中断 (exit status ${(e as { status: number }).status})`, lines);
				}
				throw e;
			} finally {
				this.sink = null;
			}
		};
		const result = this.chain.then(run, run);
		this.chain = result.then(() => undefined, () => undefined);
		return result;
	}
}

function byteLength(data: ArrayBuffer | Uint8Array): number {
	return data instanceof Uint8Array ? data.byteLength : data.byteLength;
}

function hex32(value: number): string {
	return '0x' + (value >>> 0).toString(16);
}
