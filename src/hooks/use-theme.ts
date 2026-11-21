/*
 * Theme state: 'dark' | 'light' | 'system', persisted in localStorage.
 * The class toggle on <html> also happens in an inline script in
 * index.html, before react renders, to avoid a theme flash.
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light' | 'system';

const THEME_KEY = 'xfel-theme';

export function getStoredTheme(): Theme {
	try {
		const t = localStorage.getItem(THEME_KEY);
		if (t === 'dark' || t === 'light' || t === 'system')
			return t;
	} catch {
		/* localStorage unavailable */
	}
	return 'dark';
}

export function resolveTheme(theme: Theme): 'dark' | 'light' {
	if (theme !== 'system')
		return theme;
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** toggle the dark class and remember the choice, returns the resolved one */
export function applyTheme(theme: Theme): 'dark' | 'light' {
	const resolved = resolveTheme(theme);
	document.documentElement.classList.toggle('dark', resolved === 'dark');
	try {
		localStorage.setItem(THEME_KEY, theme);
	} catch {
		/* ignore */
	}
	return resolved;
}

export function useTheme() {
	const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());
	const [resolved, setResolved] = useState<'dark' | 'light'>(() => resolveTheme(getStoredTheme()));

	const setTheme = useCallback((t: Theme) => {
		setThemeState(t);
		setResolved(applyTheme(t));
	}, []);

	useEffect(() => {
		setResolved(applyTheme(theme));
		/* follow the system theme while in system mode */
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = () => {
			if (getStoredTheme() === 'system')
				setResolved(applyTheme('system'));
		};
		media.addEventListener?.('change', onChange);
		return () => media.removeEventListener?.('change', onChange);
	}, []);

	return { theme, resolved, setTheme };
}
