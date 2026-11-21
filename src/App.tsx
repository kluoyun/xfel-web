import { motion } from 'motion/react';
import { Usb, Unplug } from 'lucide-react';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { ChipBadge, ChipCard } from '@/components/xfel/chip-card';
import { QuickActions } from '@/components/xfel/quick-actions';
import { Terminal } from '@/components/xfel/terminal';
import { useXfel } from '@/hooks/use-xfel';
import { formatBytes } from '@/lib/format';
import { ThemeToggle } from '@/components/theme-toggle';
import { Toaster } from '@/components/ui/sonner';
import { useTheme } from '@/hooks/use-theme';

/** the github mark, inline: lucide-react no longer ships brand icons */
function GithubMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
			<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.694.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
		</svg>
	);
}

export default function App() {
	const xfel = useXfel();
	const { theme, resolved, setTheme } = useTheme();

	return (
		<div className="flex min-h-screen flex-col">
			<div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
			<header className="mb-6 flex flex-wrap items-center justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-wide">
						xfel<span className="text-terminal-green">-web</span>
					</h1>
					<p className="mt-1 text-xs text-muted-foreground">
						在浏览器中通过 WebUSB 操作 Allwinner FEL 设备
					</p>
				</div>
				<div className="flex items-center gap-3">
					<ThemeToggle theme={theme} setTheme={setTheme} />
					<ChipBadge chipState={xfel.chip} connected={xfel.connected} />
					{!xfel.connected ? (
						<Button
							onClick={() => xfel.connect()}
							disabled={xfel.busy || !xfel.webusbSupported}
							className="min-w-36"
						>
							<Usb className="size-4" />
							{xfel.busy ? '连接中…' : '连接设备'}
						</Button>
					) : (
						<Button variant="outline" onClick={() => xfel.disconnect()} disabled={xfel.busy}>
							<Unplug className="size-4" />
							断开
						</Button>
					)}
				</div>
			</header>

			{!xfel.webusbSupported && (
				<motion.div
					initial={{ opacity: 0, y: -6 }}
					animate={{ opacity: 1, y: 0 }}
					className="mb-4 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					当前浏览器不支持 WebUSB，请使用 Chrome / Edge，并通过 localhost 或 HTTPS 打开本页面。
				</motion.div>
			)}

			{!xfel.connected ? (
				/* not connected yet: a connect prompt instead of any cards */
				<main>
					{xfel.deviceLost && (
						<motion.div
							initial={{ opacity: 0, y: -6 }}
							animate={{ opacity: 1, y: 0 }}
							className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-400"
						>
							设备连接已断开，请重新进入 FEL 模式（如需要）并重新连接设备。
						</motion.div>
					)}
					<motion.div
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border px-6 py-24 text-center"
					>
						<Usb className="size-12 text-muted-foreground/50" />
						<div>
							<p className="text-lg font-medium">未连接设备</p>
							<p className="mt-1 text-sm text-muted-foreground">
								连接后自动查询芯片信息并检测 SPI Flash
							</p>
						</div>
						<ol className="space-y-1 text-left text-xs text-muted-foreground">
							<li>1. 将设备进入 FEL 模式（按住 FEL 键上电或使用已运行 FEL 的引导）</li>
							<li>2. 点击「连接设备」，在浏览器弹窗中选择设备</li>
							<li>3. WebUSB 仅支持 Chrome / Edge，页面需运行在 localhost 或 HTTPS 下</li>
						</ol>
						<Button onClick={() => xfel.connect()} disabled={xfel.busy || !xfel.webusbSupported} className="min-w-36">
							<Usb className="size-4" />
							{xfel.busy ? '连接中…' : '连接设备'}
						</Button>
					</motion.div>
				</main>
			) : (
				<main className="space-y-4">
					<ChipCard
						chipState={xfel.chip}
						busy={xfel.busy}
						onAction={(label, fn) => xfel.runAction(label, fn)}
						onRefresh={() => xfel.refreshChipInfo()}
					/>
					<QuickActions
						connected={xfel.connected}
						busy={xfel.busy}
						ddrReady={xfel.ddrReady}
						initDdr={(type) => xfel.initDdr(type)}
						chipName={xfel.chip?.version.chip ?? null}
						onAction={(label, fn) => xfel.runAction(label, fn)}
						spinor={xfel.chip?.spinor ?? null}
						spinand={xfel.chip?.spinand ?? null}
					/>
					<Terminal
						term={xfel.term}
						connected={xfel.connected}
						busy={xfel.busy}
						chipName={xfel.chip?.version.chip ?? null}
						onSubmit={(cmdline) => xfel.runCommand(cmdline)}
					/>
				</main>
			)}
			</div>

			<footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-4 text-xs text-muted-foreground">
				<span>xfel-web · 浏览器版 Allwinner FEL 工具</span>
				<a
					className="flex items-center gap-1.5 transition-colors hover:text-foreground"
					href="https://github.com/kluoyun/xfel-web"
					target="_blank"
					rel="noreferrer"
				>
					<GithubMark className="size-3.5" />
					kluoyun/xfel-web
				</a>
			</footer>

			{/* transfer progress: a modal dialog with live byte counts;
			 * only shown once the C side reports real transfer sizes */}
			<Dialog open={!!xfel.progress && xfel.progress.total > 0}>
				<DialogContent
					className="max-w-sm [&>button]:hidden"
					onInteractOutside={(e) => e.preventDefault()}
					onEscapeKeyDown={(e) => e.preventDefault()}
				>
					<DialogHeader>
						<DialogTitle className="text-base">{xfel.progress?.label ?? '传输中'}</DialogTitle>
						<DialogDescription>正在传输数据，请保持设备连接，不要关闭页面…</DialogDescription>
					</DialogHeader>
					<Progress value={(xfel.progress?.ratio ?? 0) * 100} className="h-3" />
					<p className="text-center font-mono text-sm">
						{formatBytes(xfel.progress?.done ?? 0)} / {formatBytes(xfel.progress?.total ?? 0)}
						<span className="text-muted-foreground">（{Math.round((xfel.progress?.ratio ?? 0) * 100)}%）</span>
					</p>
				</DialogContent>
			</Dialog>

			<Toaster theme={resolved} />

			{/* severe failures (session aborted by the C side) use a dialog */}
			<AlertDialog open={!!xfel.severe}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>USB 传输失败</AlertDialogTitle>
						<AlertDialogDescription>
							{xfel.severe?.message} 会话已中断，建议重新连接设备后继续；详细信息见浏览器控制台。
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => xfel.dismissSevere()}>关闭</AlertDialogCancel>
						<AlertDialogAction onClick={() => xfel.reconnect()}>重新连接</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
