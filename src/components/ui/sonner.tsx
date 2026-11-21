/*
 * Sonner toaster, themed for the dark terminal look. Hand-rolled instead
 * of the registry version to avoid the next-themes dependency.
 */

import { Toaster as Sonner, type ToasterProps } from 'sonner';

const Toaster = (props: ToasterProps) => {
	return (
		<Sonner
			theme="dark"
			position="top-center"
			richColors
			closeButton
			className="toaster group"
			style={
				{
					'--normal-bg': 'var(--card)',
					'--normal-text': 'var(--foreground)',
					'--normal-border': 'var(--border)',
				} as React.CSSProperties
			}
			{...props}
		/>
	);
};

export { Toaster };
