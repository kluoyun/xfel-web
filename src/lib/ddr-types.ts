/*
 * DDR initialization types, from https://xfel.xboot.org/reference/ddr-types
 * cross-checked against the chip adapters in the xfel submodule.
 *
 * chipNames matches the exact `.name` strings reported by
 * xfel_api_get_chip_name().
 */

export interface DdrTypeEntry {
	type: string;
	chipNames: readonly string[];
}

export const DDR_TYPES: readonly DdrTypeEntry[] = [
	{ type: 'd1', chipNames: ['D1/F133'] },
	{ type: 'f133', chipNames: ['D1/F133'] },
	{ type: 'h2', chipNames: ['H2/H3'] },
	{ type: 'h3', chipNames: ['H2/H3'] },
	{ type: 'lpddr4', chipNames: ['H313/H616/T507/T517/H618', 'A523/A527/T527/MR527'] },
	{ type: 'v3s', chipNames: ['V3S/S3'] },
	{ type: 's3', chipNames: ['V3S/S3'] },
	{ type: 'v851', chipNames: ['V851/V853'] },
	{ type: 'v853', chipNames: ['V851/V853'] },
	{ type: 'r528-s3', chipNames: ['R528/T113'] },
	{ type: 't113-s3', chipNames: ['R528/T113'] },
	{ type: 't113-s4', chipNames: ['R528/T113'] },
	{ type: 'r128-s2', chipNames: ['R128'] },
	{ type: 'r128-s3', chipNames: ['R128'] },
	{ type: 'xr875', chipNames: ['R128'] },
	{ type: 't153-m3', chipNames: ['T153'] },
	{ type: 'ddr3', chipNames: ['A40I/R40'] },
	{ type: 'lpddr3', chipNames: ['A40I/R40'] },
	{ type: 'f101-s2', chipNames: ['F101'] },
	{ type: 'f101-s3', chipNames: ['F101'] },
];

/** chips whose ddr controller uses a default config, no type needed */
export const DDR_DEFAULT_CHIPS: readonly string[] = [
	'F1C100S/F1C200S/F1C500S',
	'V821',
	'V831',
];

/**
 * Types matching the given chip name:
 *   - string[]  the chip has dedicated types
 *   - []        the chip uses the default config (no type needed)
 *   - null      the chip is not listed (unknown support)
 */
export function ddrTypesForChip(chipName: string): string[] | null {
	if (DDR_DEFAULT_CHIPS.includes(chipName))
		return [];
	const matched = DDR_TYPES.filter((e) => e.chipNames.includes(chipName)).map((e) => e.type);
	return matched.length > 0 ? matched : null;
}
