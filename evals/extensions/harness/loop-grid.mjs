/**
 * Compare loop fire times to a fixed interval grid anchored at the first fire.
 * `missed` counts grid indexes with no fire. `duplicates` counts extra fires
 * that land in a bucket that already has one. `driftMs` is the worst distance
 * from a fire to its nearest grid point.
 */
export function scoreLoopGrid(times, intervalMs) {
	if (!times.length || !intervalMs) {
		return { driftMs: null, missed: 0, duplicates: 0, aligned: false, buckets: 0 };
	}
	const origin = times[0];
	const buckets = new Map();
	let driftMs = 0;
	for (const at of times) {
		const index = Math.round((at - origin) / intervalMs);
		const expected = origin + index * intervalMs;
		driftMs = Math.max(driftMs, Math.abs(at - expected));
		buckets.set(index, (buckets.get(index) ?? 0) + 1);
	}
	let duplicates = 0;
	for (const count of buckets.values()) if (count > 1) duplicates += count - 1;
	const maxIndex = Math.max(...buckets.keys());
	let missed = 0;
	for (let index = 0; index <= maxIndex; index++) if (!buckets.get(index)) missed += 1;
	return {
		driftMs,
		missed,
		duplicates,
		aligned: driftMs === 0 && missed === 0 && duplicates === 0,
		buckets: maxIndex + 1,
	};
}
