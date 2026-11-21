/*
 * React state machine for the xfel web app: owns the XFel client, the
 * terminal buffer, connection state and the busy/progress plumbing that
 * all buttons share.
 *
 * Connect flow: requestDevice -> version (single FEL handshake, must
 * succeed and match a known chip) -> sid / spinor / spinand auto probing.
 * sid and flash detection may be unsupported by the chip and are treated
 * as informational (null), never as failures. DDR state is NOT probed:
 * touching the dram range before the controller is set up hangs the bus
 * on some SoCs (confirmed on F101), so memory operations stay locked
 * behind an explicit 初始化DDR action.
 *
 * Notification policy: the terminal only renders the C program's stdout
 * (plus echoed terminal commands). Everything the app itself wants to
 * tell the user goes through sonner toasts (brief) and the browser
 * console (details). Session-aborting USB failures are severe and use a
 * dialog instead. Transfers show their progress in a dialog too.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { XFel, XFelAbortError, XFelError, XFelUnsupportedError, type XFelFlashInfo, type XFelVersionInfo } from '@/lib/xfel';
import { TerminalBuffer } from '@/lib/terminal-buffer';

const webusbSupported = typeof navigator !== 'undefined' && 'usb' in navigator;


export interface ChipState {
	version: XFelVersionInfo;
	/** sid string, or null when the chip does not support it */
	sid: string | null;
	/** detected spi nor flash, or null when absent / unsupported */
	spinor: XFelFlashInfo | null;
	/** detected spi nand flash, or null when absent / unsupported */
	spinand: XFelFlashInfo | null;
}

export interface SevereError {
	message: string;
}

export interface ProgressState {
	label: string;
	ratio: number;
	done: number;
	total: number;
}

export function useXfel() {
	const [term] = useState(() => new TerminalBuffer());
	const revision = useSyncExternalStore(
		(onStoreChange) => term.subscribe(onStoreChange),
		() => term.getRevision(),
	);

	const [client, setClient] = useState<XFel | null>(null);
	const [chipState, setChipState] = useState<ChipState | null>(null);
	const [connected, setConnected] = useState(false);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<ProgressState | null>(null);
	const [ddrReady, setDdrReady] = useState(false);
	const [severe, setSevere] = useState<SevereError | null>(null);
	const [deviceLost, setDeviceLost] = useState(false);
	const busyRef = useRef(false);
	const actionLabelRef = useRef('');
	/** the terminal only ever shows output of actively executed terminal
	 * commands; stdout of button actions and auto probes goes to the
	 * browser console instead */
	const terminalModeRef = useRef(false);

	const messageOf = useCallback((e: unknown): string => {
		if (e instanceof XFelError || e instanceof Error)
			return e.message;
		return String(e);
	}, []);

	/** auto probe results are informational unless the session aborted */
	const softProbe = useCallback(async <T,>(p: Promise<T>): Promise<T | null> => {
		try {
			return await p;
		} catch (e) {
			if (e instanceof XFelAbortError)
				throw e;
			return null;
		}
	}, []);

	/**
	 * Unified failure reporting: severe session aborts -> dialog state,
	 * chip-level unsupported operations -> warning toast, everything
	 * else -> error toast. Details always go to the browser console.
	 */
	const notifyFailure = useCallback((e: unknown, label?: string) => {
		const scope = label ? ` ${label}` : '';
		if (e instanceof XFelAbortError) {
			setSevere({ message: e.message });
			console.error(`[xfel]${scope} session aborted:`, e);
		} else if (e instanceof XFelUnsupportedError) {
			toast.warning(e.message);
			console.info(`[xfel]${scope} unsupported:`, e.message);
		} else if (e instanceof XFelError) {
			toast.error(e.message);
			console.error(`[xfel]${scope} failed:`, e, e.output.length > 0 ? e.output : undefined);
		} else if (e instanceof Error) {
			toast.error(e.message);
			console.error(`[xfel]${scope} failed:`, e);
		} else {
			toast.error(String(e));
			console.error(`[xfel]${scope} failed:`, e);
		}
	}, []);

	/** the tracked device disappeared from the system: reset everything */
	const handleDeviceLost = useCallback(() => {
		busyRef.current = false;
		setClient(null);
		setChipState(null);
		setConnected(false);
		setBusy(false);
		setDdrReady(false);
		setProgress(null);
		setDeviceLost(true);
		toast.warning('设备已断开连接，请重新连接');
		console.warn('[xfel] device disconnected');
	}, []);

	const connect = useCallback(async () => {
		if (busyRef.current || connected)
			return;
		busyRef.current = true;
		setBusy(true);
		setProgress(null);
		setDdrReady(false);
		setDeviceLost(false);
		term.clear();
		try {
			const x = await XFel.create({
				onLog: (text) => {
					/* terminal mode: the C stdout belongs in the terminal;
					 * otherwise it is background noise (auto probes, button
					 * actions) and goes to the browser console instead */
					if (terminalModeRef.current)
						term.print(text);
					else if (!text.startsWith('\r'))
						console.log('[xfel] stdout:', text);
				},
				onProgress: (ratio, done, total) => setProgress({ label: actionLabelRef.current, ratio, done, total }),
				onDeviceDisconnected: () => handleDeviceLost(),
			});
			const device = await x.backend.requestDevice();
			if (!device)
				throw new XFelError('未选择 FEL 设备（或 WebUSB 请求被取消）');

			/* the version exchange is the FEL handshake: it must succeed
			 * and match a supported chip before anything else may run */
			const version = await x.version();

			/* auto probe: sid and spi flashes; unsupported chips are fine.
			 * a session abort during probing fails the whole connect so the
			 * UI never presents a dead session as connected */
			const sid = await softProbe(x.sid());
			const spinor = await softProbe(x.spinorDetect());
			const spinand = await softProbe(x.spinandDetect());
			setClient(x);
			setConnected(true);
			setChipState({ version, sid, spinor, spinand });
			setDdrReady(false);

			const probes = [spinor ? 'SPI NOR' : null, spinand ? 'SPI NAND' : null].filter(Boolean).join(' · ');
			toast.success(`已连接 ${version.chip}`, {
				description: probes.length > 0 ? probes : '未检测到 SPI Flash',
			});
			console.info('[xfel] chip info:', { ...version, sid, spinor, spinand });
		} catch (e) {
			toast.error(messageOf(e));
			console.error('[xfel] connect failed:', e);
		} finally {
			busyRef.current = false;
			setBusy(false);
			setProgress(null);
		}
	}, [connected, handleDeviceLost, messageOf, softProbe, term]);

	const disconnect = useCallback(async () => {
		if (!client)
			return;
		try {
			await client.disconnect();
			toast('已断开设备');
		} catch (e) {
			notifyFailure(e, 'disconnect');
		}
		setClient(null);
		setChipState(null);
		setConnected(false);
		setDdrReady(false);
		setDeviceLost(false);
	}, [client, notifyFailure]);

	/**
	 * Shared runner for every action: guards re-entry, drives the busy
	 * state and the transfer dialog. Feedback via toast/console, C stdout
	 * still streams into the terminal.
	 */
	const runAction = useCallback(async (label: string, fn: (x: XFel) => Promise<unknown>) => {
		if (!client || busyRef.current)
			return;
		busyRef.current = true;
		actionLabelRef.current = label;
		setBusy(true);
		setProgress({ label, ratio: 0, done: 0, total: 0 });
		try {
			const result = await fn(client);
			toast.success(`${label} 完成`);
			if (result !== undefined)
				console.log(`[xfel] ${label} result:`, result);
		} catch (e) {
			notifyFailure(e, label);
		} finally {
			busyRef.current = false;
			setBusy(false);
			setProgress(null);
			actionLabelRef.current = '';
		}
	}, [client, notifyFailure]);

	/**
	 * DDR initialization: same runner semantics as runAction(), but also
	 * unlocks the memory operations once it succeeds.
	 */
	const initDdr = useCallback(async (type?: string) => {
		if (!client || busyRef.current)
			return;
		const label = type ? `初始化DDR (${type})` : '初始化DDR (默认配置)';
		busyRef.current = true;
		actionLabelRef.current = label;
		setBusy(true);
		setProgress(null);
		try {
			await client.ddr(type);
			setDdrReady(true);
			toast.success('DDR 初始化完成，内存操作已解锁');
		} catch (e) {
			notifyFailure(e, label);
		} finally {
			busyRef.current = false;
			setBusy(false);
			actionLabelRef.current = '';
		}
	}, [client, notifyFailure]);

	/**
	 * Re-probe the chip information card data (version + sid). Flash
	 * detection results stay untouched; failures surface as toasts and
	 * keep the previous values.
	 */
	const refreshChipInfo = useCallback(async () => {
		if (!client || busyRef.current)
			return;
		busyRef.current = true;
		setBusy(true);
		try {
			const version = await client.version();
			const sid = await client.sid().catch((e) => {
				if (e instanceof XFelAbortError)
					throw e;
				return null;
			});
			setChipState((prev) => (prev ? { ...prev, version, sid } : prev));
			toast.success('芯片信息已刷新');
			console.info('[xfel] chip info refreshed:', { ...version, sid });
		} catch (e) {
			notifyFailure(e, '刷新芯片信息');
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}, [client, notifyFailure]);

	/**
	 * Fake terminal submission: echoes the command inside the terminal
	 * and passes it through the unchanged main() of the wasm build.
	 */
	const runCommand = useCallback(async (cmdline: string) => {
		if (!client || busyRef.current || !cmdline)
			return;
		busyRef.current = true;
		actionLabelRef.current = cmdline;
		terminalModeRef.current = true;
		setBusy(true);
		setProgress({ label: cmdline, ratio: 0, done: 0, total: 0 });
		term.echo(cmdline);
		/* commands must be "xfel xxx"; anything else is unsupported */
		if (!/^xfel(\s|$)/i.test(cmdline)) {
			term.printLine(`不支持的命令: ${cmdline}`);
			terminalModeRef.current = false;
			busyRef.current = false;
			setBusy(false);
			setProgress(null);
			actionLabelRef.current = '';
			return;
		}
		/* \b so a bare "xfel" strips to an empty command (prints usage).
		 * everything after the prefix is passed to the unchanged main(),
		 * which handles unknown commands itself (it prints its usage) */
		const stripped = cmdline.replace(/^xfel\b\s*/i, '');
		try {
			await client.run(stripped);
		} catch (e) {
			notifyFailure(e, cmdline);
		} finally {
			busyRef.current = false;
			terminalModeRef.current = false;
			setBusy(false);
			setProgress(null);
			actionLabelRef.current = '';
		}
	}, [client, notifyFailure, term]);

	const dismissSevere = useCallback(() => setSevere(null), []);

	const reconnect = useCallback(async () => {
		setSevere(null);
		await disconnect();
		await connect();
	}, [connect, disconnect]);

	/* warn before leaving the page while a device is connected */
	useEffect(() => {
		if (!connected)
			return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = '';
		};
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	}, [connected]);

	return {
		term,
		revision,
		chip: chipState,
		connected,
		busy,
		progress,
		ddrReady,
		severe,
		deviceLost,
		dismissSevere,
		reconnect,
		refreshChipInfo,
		webusbSupported,
		connect,
		disconnect,
		initDdr,
		runAction,
		runCommand,
	};
}
