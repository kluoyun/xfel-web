/*
 * Operation cards for memory and spi flashes. The spi flash cards are
 * rendered conditionally from the auto-detection result of the connect
 * flow - chips without a detected flash simply show no card.
 *
 * Layout: every operation is its own bordered group with a title, the
 * action buttons on the right and labeled input fields underneath, so
 * each field is self-describing.
 *
 * Button states follow field validity: every action button starts
 * disabled and unlocks once the fields it depends on hold valid values
 * (file writes additionally require a chosen file).
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { motion } from 'motion/react';
import { Download, Eraser, HardDrive, MemoryStick, Upload, Wand2 } from 'lucide-react';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ddrTypesForChip } from '@/lib/ddr-types';
import { formatBytes } from '@/lib/format';
import type { XFelFlashInfo } from '@/lib/xfel';
import type { XFel } from '@/lib/xfel';

interface CardActions {
	connected: boolean;
	busy: boolean;
	onAction: (label: string, fn: (x: XFel) => Promise<unknown>) => void;
}

function parseNum(text: string, fallback = 0): number {
	const trimmed = text.trim();
	if (!trimmed)
		return fallback;
	const value = parseInt(trimmed, 0);
	return Number.isNaN(value) ? fallback : value;
}

/** a field holds a valid number when it is non-empty and fully numeric
 * (decimal, or hex/octal/binary with prefix) */
function isValidNum(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed)
		return false;
	return Number.isFinite(Number(trimmed));
}

function download(data: Uint8Array, name: string): void {
	const url = URL.createObjectURL(new Blob([new Uint8Array(data)]));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
	toast.success(`已下载 ${name} (${data.byteLength} 字节)`);
	console.log('[xfel] download:', name, `${data.byteLength} bytes`);
}

/*
 * a labeled numeric input field; non-empty but invalid content gets the
 * destructive ring, valid content looks neutral
 */
function Field({ label, value, onChange, placeholder }: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
}) {
	const invalid = value.trim() !== '' && !isValidNum(value);
	return (
		<label className="flex min-w-0 items-center gap-2">
			<span className="w-9 shrink-0 text-right text-xs text-muted-foreground">{label}</span>
			<Input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				aria-invalid={invalid}
				className="h-8 min-w-0 flex-1 font-mono"
				autoComplete="off"
				spellCheck={false}
			/>
		</label>
	);
}

/* a bordered group: title on the left, action buttons on the right,
 * labeled fields underneath */
function OpGroup({ title, actions, children }: {
	title: string;
	actions: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-2 rounded-lg border border-border/70 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="text-xs font-medium text-muted-foreground">{title}</span>
				<div className="flex flex-wrap gap-2">{actions}</div>
			</div>
			{children}
		</div>
	);
}

/* labeled file picker, laid out exactly like the other fields: the
 * leading caption on the left and an equally sized box showing the
 * chosen filename with a small picker icon on the right (vertically
 * centered). The native file input is visually hidden; the label opens
 * it, so clicking anywhere in the box works. */
function FileField({ file, onChange }: {
	file: File | null;
	onChange: (f: File | null) => void;
}) {
	return (
		<label className="group flex min-w-0 cursor-pointer items-center gap-2">
			<span className="w-9 shrink-0 text-right text-xs text-muted-foreground">文件</span>
			<div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-transparent px-2 shadow-xs transition-colors group-focus-within:outline-none group-focus-within:ring-[3px] group-focus-within:ring-ring/50">
				<input
					type="file"
					className="sr-only"
					onChange={(e) => onChange(e.target.files && e.target.files.length > 0 ? e.target.files[0] : null)}
				/>
				<span className={'min-w-0 flex-1 truncate font-mono text-xs ' + (file ? 'text-foreground' : 'text-muted-foreground/60')}>
					{file ? file.name : '未选择文件'}
				</span>
				<span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-secondary text-foreground transition-colors group-hover:bg-accent">
					<Upload className="size-3.5" />
				</span>
			</div>
		</label>
	);
}

function MemoryCard({ connected, busy, ddrReady, initDdr, chipName, onAction }: CardActions & {
	ddrReady: boolean;
	initDdr: (type?: string) => void;
	chipName: string | null;
}) {
	const [memAddr, setMemAddr] = useState('');
	const [memVal, setMemVal] = useState('');
	const [dumpAddr, setDumpAddr] = useState('0x0');
	const [dumpLen, setDumpLen] = useState('0x40');
	const [writeAddr, setWriteAddr] = useState('0x40000000');
	const [writeFile, setWriteFile] = useState<File | null>(null);
	const [ddrOpen, setDdrOpen] = useState(false);
	const disabled = !connected || busy;
	const chipTypes = chipName ? ddrTypesForChip(chipName) : null;

	/* validity-driven button states */
	const regAddrOk = isValidNum(memAddr);
	const regValOk = isValidNum(memVal);
	const dumpOk = isValidNum(dumpAddr) && isValidNum(dumpLen);
	const writeOk = isValidNum(writeAddr) && writeFile !== null;

	const startDdr = () => {
		/* listed chips pick one of their own types; default-config chips
		 * ([]) and unlisted chips (null) initialize directly */
		if (chipTypes !== null && chipTypes.length > 0) {
			setDdrOpen(true);
			return;
		}
		initDdr();
	};

	const runDdr = (type: string) => {
		setDdrOpen(false);
		initDdr(type);
	};

	return (
		<Card className="h-full">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-sm">
					<MemoryStick className="size-4 text-terminal-green" />
					内存读写
				</CardTitle>
				<CardDescription>
					read32 / write32 / dump / hexdump / write{!ddrReady ? '（需先初始化 DDR）' : ''}
				</CardDescription>
			</CardHeader>
			<CardContent className={ddrReady ? 'space-y-3' : 'flex min-h-44 flex-col items-center justify-center gap-3'}>
				{!ddrReady ? (
					<Button onClick={startDdr} disabled={!connected || busy} className="min-w-44">
						<Wand2 className="size-4" />
						初始化DDR
					</Button>
				) : (
					<>
						<OpGroup
							title="寄存器"
							actions={<>
								<Button size="sm" disabled={disabled || !regAddrOk} onClick={() => onAction('read32', (x) => x.read32(parseNum(memAddr)))}>read32</Button>
								<Button size="sm" disabled={disabled || !(regAddrOk && regValOk)} onClick={() => onAction('write32', (x) => x.write32(parseNum(memAddr), parseNum(memVal)))}>write32</Button>
								<Button size="sm" variant="destructive" disabled={disabled || !regAddrOk} onClick={() => onAction('exec', (x) => x.exec(parseNum(memAddr)))}>exec</Button>
							</>}
						>
							<div className="grid gap-2 sm:grid-cols-2">
								<Field label="地址" value={memAddr} onChange={setMemAddr} placeholder="0x00000000" />
								<Field label="值" value={memVal} onChange={setMemVal} placeholder="0x00000000" />
							</div>
						</OpGroup>

						<OpGroup
							title="内存区域"
							actions={<>
								<Button size="sm" variant="outline" disabled={disabled || !dumpOk} onClick={() => onAction('hexdump', (x) => x.hexdump(parseNum(dumpAddr), parseNum(dumpLen, 0x40)))}>hexdump</Button>
								<Button size="sm" variant="outline" disabled={disabled || !dumpOk} onClick={() => onAction('dump(下载)', async (x) => {
									const data = await x.read(parseNum(dumpAddr), parseNum(dumpLen, 0x40));
									download(data, 'xfel-dump.bin');
								})}>
									<Download className="size-4" />
									读取下载
								</Button>
							</>}
						>
							<div className="grid gap-2 sm:grid-cols-2">
								<Field label="地址" value={dumpAddr} onChange={setDumpAddr} placeholder="0x00000000" />
								<Field label="长度" value={dumpLen} onChange={setDumpLen} placeholder="0x40" />
							</div>
						</OpGroup>

						<OpGroup
							title="写入文件"
							actions={
								<Button size="sm" disabled={disabled || !writeOk} onClick={() => onAction('write(内存)', async (x) => {
									if (!writeFile)
										return;
									await x.write(parseNum(writeAddr), new Uint8Array(await writeFile.arrayBuffer()));
								})}>
									<Upload className="size-4" />
									写入
								</Button>
							}
						>
						<Field label="地址" value={writeAddr} onChange={setWriteAddr} placeholder="0x40000000" />
						<FileField file={writeFile} onChange={setWriteFile} />
						</OpGroup>
					</>
				)}
			</CardContent>

			<Dialog open={ddrOpen} onOpenChange={setDdrOpen}>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>选择 DDR 初始化类型</DialogTitle>
						<DialogDescription>当前芯片 {chipName} 适配的类型</DialogDescription>
					</DialogHeader>
					<div className="space-y-1">
						{(chipTypes ?? []).map((t) => (
							<button
								key={t}
								disabled={busy}
								onClick={() => runDdr(t)}
								className="flex w-full items-center rounded-md px-3 py-2 text-left font-mono text-sm hover:bg-accent disabled:opacity-50"
							>
								{t}
							</button>
						))}
					</div>
					<p className="text-xs text-muted-foreground">
						类型定义见{' '}
						<a className="underline" href="https://xfel.xboot.org/reference/ddr-types" target="_blank" rel="noreferrer">
							xfel.xboot.org/reference/ddr-types
						</a>
					</p>
				</DialogContent>
			</Dialog>
		</Card>
	);
}

interface FlashCardProps extends CardActions {
	flash: XFelFlashInfo;
	kind: 'spinor' | 'spinand';
}

function FlashCard({ flash, kind, connected, busy, onAction }: FlashCardProps) {
	const [readAddr, setReadAddr] = useState('0x0');
	const [readLen, setReadLen] = useState('0x100');
	const [writeAddr, setWriteAddr] = useState('0x0');
	const [splSplit, setSplSplit] = useState('0x4000');
	const [eraseAddr, setEraseAddr] = useState('0x0');
	const [eraseLen, setEraseLen] = useState('0x10000');
	const [flashFile, setFlashFile] = useState<File | null>(null);
	const disabled = !connected || busy;
	const label = kind === 'spinor' ? 'SPI NOR Flash' : 'SPI NAND Flash';

	const readOk = isValidNum(readAddr) && isValidNum(readLen);
	const writeOk = isValidNum(writeAddr) && flashFile !== null;
	const splOk = writeOk && isValidNum(splSplit);
	const eraseOk = isValidNum(eraseAddr) && isValidNum(eraseLen);

	const readFlash = async (x: XFel) => {
		const data = kind === 'spinor'
			? await x.spinorRead(parseNum(readAddr), parseNum(readLen, 0x100))
			: await x.spinandRead(parseNum(readAddr), parseNum(readLen, 0x100));
		download(data, `${kind}-read.bin`);
	};

	const writeFlash = async (x: XFel) => {
		if (!flashFile)
			return;
		const data = new Uint8Array(await flashFile.arrayBuffer());
		if (kind === 'spinor')
			await x.spinorWrite(parseNum(writeAddr), data);
		else
			await x.spinandWrite(parseNum(writeAddr), data);
	};

	const splWrite = async (x: XFel) => {
		if (!flashFile)
			return;
		const data = new Uint8Array(await flashFile.arrayBuffer());
		await x.spinandSplwrite(parseNum(splSplit, 0x4000), parseNum(writeAddr), data);
	};

	const eraseFlash = async (x: XFel) => {
		if (kind === 'spinor')
			await x.spinorErase(parseNum(eraseAddr), parseNum(eraseLen, 0x10000));
		else
			await x.spinandErase(parseNum(eraseAddr), parseNum(eraseLen, 0x10000));
	};

	return (
		<motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
			<Card className="h-full">
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-sm">
						<HardDrive className="size-4 text-terminal-green" />
						{label}
					</CardTitle>
					<CardDescription className="font-mono">
						{flash.name || '未知型号'} · {formatBytes(flash.capacity)}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					<OpGroup
						title="读取"
						actions={
							<Button size="sm" variant="outline" disabled={disabled || !readOk} onClick={() => onAction(`${kind} 读取下载`, readFlash)}>
								<Download className="size-4" />
								读取下载
							</Button>
						}
					>
						<div className="grid gap-2 sm:grid-cols-2">
							<Field label="地址" value={readAddr} onChange={setReadAddr} placeholder="0x00000000" />
							<Field label="长度" value={readLen} onChange={setReadLen} placeholder="0x100" />
						</div>
					</OpGroup>

					<OpGroup
						title="写入"
						actions={<>
							<Button size="sm" disabled={disabled || !writeOk} onClick={() => onAction(`${kind} 写入`, writeFlash)}>
								<Upload className="size-4" />
								写入
							</Button>
							{kind === 'spinand' && (
								<Button size="sm" variant="outline" disabled={disabled || !splOk} onClick={() => onAction('spinand splwrite', splWrite)}>
									spl写
								</Button>
							)}
						</>}
					>
						<div className={kind === 'spinand' ? 'grid gap-2 sm:grid-cols-2' : 'space-y-2'}>
							<Field label="地址" value={writeAddr} onChange={setWriteAddr} placeholder="0x00000000" />
							{kind === 'spinand' && (
								<Field label="分块" value={splSplit} onChange={setSplSplit} placeholder="0x4000" />
							)}
						</div>
						<FileField file={flashFile} onChange={setFlashFile} />
					</OpGroup>

					<OpGroup
						title="擦除"
						actions={
							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button size="sm" variant="destructive" disabled={disabled || !eraseOk}>
										<Eraser className="size-4" />
										擦除
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>确认擦除 {label}？</AlertDialogTitle>
										<AlertDialogDescription>
											将按当前分组的地址（{eraseAddr}）和长度（{eraseLen}）擦除 {label}，
											被擦除的数据不可恢复。
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>取消</AlertDialogCancel>
										<AlertDialogAction onClick={() => onAction(`${kind} 擦除`, eraseFlash)}>确认擦除</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						}
					>
						<div className="grid gap-2 sm:grid-cols-2">
							<Field label="地址" value={eraseAddr} onChange={setEraseAddr} placeholder="0x00000000" />
							<Field label="长度" value={eraseLen} onChange={setEraseLen} placeholder="0x10000" />
						</div>
					</OpGroup>
				</CardContent>
			</Card>
		</motion.div>
	);
}

export function QuickActions({ connected, busy, ddrReady, initDdr, chipName, onAction, spinor, spinand }: CardActions & {
	ddrReady: boolean;
	initDdr: (type?: string) => void;
	chipName: string | null;
	spinor: XFelFlashInfo | null;
	spinand: XFelFlashInfo | null;
}) {
	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<MemoryCard connected={connected} busy={busy} ddrReady={ddrReady} initDdr={initDdr} chipName={chipName} onAction={onAction} />
			{spinor && (
				<FlashCard flash={spinor} kind="spinor" connected={connected} busy={busy} onAction={onAction} />
			)}
			{spinand && (
				<FlashCard flash={spinand} kind="spinand" connected={connected} busy={busy} onAction={onAction} />
			)}
		</div>
	);
}
