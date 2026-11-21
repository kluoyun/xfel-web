/** human readable byte count, e.g. "1.50 MB" */
export function formatBytes(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while(value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 2)} ${units[unit]}`;
}
