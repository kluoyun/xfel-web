/*
 * Theme switch button: cycles dark -> light -> system. The icon shows
 * the current mode; the title explains what the next click does.
 */

import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Theme } from '@/hooks/use-theme';

const ORDER: Theme[] = ['dark', 'light', 'system'];
const ICONS: Record<Theme, typeof Moon> = { dark: Moon, light: Sun, system: Monitor };
const LABELS: Record<Theme, string> = { dark: '深色', light: '浅色', system: '跟随系统' };

export function ThemeToggle({ theme, setTheme }: {
	theme: Theme;
	setTheme: (t: Theme) => void;
}) {
	const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
	const Icon = ICONS[theme];

	return (
		<Button
			variant="ghost"
			size="icon"
			className="size-8 text-muted-foreground"
			title={`主题：${LABELS[theme]}（点击切换为${LABELS[next]}）`}
			onClick={() => setTheme(next)}
		>
			<Icon className="size-4" />
		</Button>
	);
}
