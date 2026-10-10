/**
 * A platform-wide cap on how many sites are provisioned at the same time. One D1 database does one write at a time and a site
 * clone writes ~370 objects, so a burst of sign-ups made every other site slow (measured: page reads p95 0.6 s to 3.2 s while 12
 * sites were created at once). A slot is a control-plane `options` row holding its expiry; one INSERT ... SELECT takes a slot only
 * while fewer than `max` unexpired rows exist, and D1 runs statements one at a time, so the cap is exact. A crashed holder frees
 * its slot when the row expires.
 * ponytail: expired rows of crashed holders stay until their site is provisioned again (they are ignored, not counted).
 */
import { sql } from "kysely";
import { runAsSite } from "./dialect.ts";
import { controlDb } from "./registry.ts";
import { SLOT_PREFIX, SLOT_TTL_MS } from "./rules.ts";
import { scopeState } from "./scope.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Take a slot for `slug`, waiting up to `waitMs`. False when none came free in time. */
export async function acquireSlot(slug: string, max: number, waitMs: number): Promise<boolean> {
	const db = controlDb();
	const deadline = Date.now() + waitMs;
	for (;;) {
		const now = Date.now();
		const r = await runAsSite(scopeState().primary, () =>
			sql`INSERT INTO options (name, value)
				SELECT ${SLOT_PREFIX + slug}, ${String(now + SLOT_TTL_MS)}
				WHERE (SELECT COUNT(*) FROM options WHERE name LIKE ${`${SLOT_PREFIX}%`} AND CAST(value AS INTEGER) > ${now}) < ${max}
				ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(db),
		);
		if (Number(r.numAffectedRows ?? 0) > 0) return true;
		if (Date.now() >= deadline) return false;
		await sleep(500);
	}
}

export async function releaseSlot(slug: string): Promise<void> {
	const db = controlDb();
	await runAsSite(scopeState().primary, () => sql`DELETE FROM options WHERE name = ${SLOT_PREFIX + slug}`.execute(db));
}
