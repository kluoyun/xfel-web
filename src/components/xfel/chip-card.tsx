/*
 * Chip information card: auto-probed after connecting (no version
 * button). Shows ID/name, dflag, dlength, scratchpad and SID, plus the
 * jtag / reset actions and a refresh button. sid, jtag and reset may be
 * unsupported by the chip - the glue layer throws XFelUnsupportedError
 * for those, rendered as hints, never as errors. DDR initialization
 * lives in the memory card (it unlocks the memory operations there).
 */

import { Cpu, RefreshCw, RotateCcw, Zap } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ChipState } from '@/hooks/use-xfel';
import type { XFel } from '@/lib/xfel';

function hex(value: number, width: number): string {
	return '0x' + (value >>> 0).toString(16).padStart(width, '0');
}

function InfoRow({ label, value, mono = true }: { label: string; value: React.ReactNode; mono?: boolean }) {
	return (
		<div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 last:border-0">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className={mono ? 'font-mono text-sm' : 'text-sm'}>{value}</span>
		</div>
	);
}

export function ChipBadge({ chipState, connected }: { chipState: ChipState | null; connected: boolean }) {
	if (!connected)
		return <Badge variant="outline" className="text-muted-foreground">未连接</Badge>;
	if (!chipState)
		return <Badge className="bg-terminal-green/20 text-terminal-green border-terminal-green/40">FEL 设备已连接</Badge>;
	return (
		<Badge className="bg-terminal-green/20 text-terminal-green border-terminal-green/40 font-mono">
			{chipState.version.chip} (ID={hex(chipState.version.id, 8)})
		</Badge>
	);
}

export function ChipCard({
	chipState,
	busy,
	onAction,
	onRefresh,
}: {
	chipState: ChipState | null;
	busy: boolean;
	onAction: (label: string, fn: (x: XFel) => Promise<unknown>) => void;
	onRefresh: () => void;
}) {
	if (!chipState)
		return null;

	return (
		<Card className="h-full">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-sm">
					<Cpu className="size-4 text-terminal-green" />
					芯片信息
					<Button
						variant="ghost"
						size="icon"
						className="ml-auto size-7 text-muted-foreground"
						disabled={busy}
						onClick={onRefresh}
						title="刷新信息"
					>
						<RefreshCw className={busy ? 'size-4 animate-spin' : 'size-4'} />
					</Button>
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<div>
					<InfoRow label="ID" value={<>
						<span className="text-terminal-green">{hex(chipState.version.id, 8)}</span>
						<span className="ml-2 text-muted-foreground">({chipState.version.chip})</span>
					</>} />
					<InfoRow label="dflag" value={hex(chipState.version.dflag, 2)} />
					<InfoRow label="dlength" value={hex(chipState.version.dlength, 2)} />
					<InfoRow label="scratchpad" value={hex(chipState.version.scratchpad, 8)} />
					<InfoRow label="SID" value={
						chipState.sid !== null
							? <span className="break-all">{chipState.sid}</span>
							: <span className="text-muted-foreground">该芯片不支持</span>
					} />
				</div>

				<div className="flex flex-wrap gap-2">
					<Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('启用JTAG', (x) => x.jtag())}>
						<Zap className="size-4" />
						启用JTAG
					</Button>
					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button size="sm" variant="destructive" disabled={busy}>
								<RotateCcw className="size-4" />
								重启
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>确认重启设备？</AlertDialogTitle>
								<AlertDialogDescription>
									将通过看门狗复位 {chipState.version.chip}。重启后设备会退出 FEL 模式，
									需要重新进入 FEL 并重新连接才能继续操作。
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>取消</AlertDialogCancel>
								<AlertDialogAction onClick={() => onAction('重启(看门狗复位)', (x) => x.reset())}>
									确认重启
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			</CardContent>
		</Card>
	);
}
