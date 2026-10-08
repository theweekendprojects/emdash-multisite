import { AsyncLocalStorage } from "node:async_hooks";
import type {
	CompiledQuery,
	DatabaseConnection,
	Dialect,
	Driver,
	QueryResult,
	TransactionSettings,
} from "kysely";
import { rewriteParams, rewriteSql, suffixFor, translateRows } from "./rewrite.ts";

// On globalThis so duplicated bundle chunks share one store.
const SITE_STORE = Symbol.for("emdash-multisite:site-store");
const siteStore = ((globalThis as Record<symbol, unknown>)[SITE_STORE] ??= new AsyncLocalStorage<string>()) as AsyncLocalStorage<string>;

/**
 * Run `fn` as `site`. Used by provisioning, cron and anything else that runs
 * outside a request (requests get their site baked into a per-site Kysely).
 */
export const runAsSite = <T>(site: string, fn: () => T): T => siteStore.run(site, fn);
export const currentSite = (): string | undefined => siteStore.getStore();

/**
 * Wrap `inner` so every query is rewritten for the site `getSite()` returns.
 *
 * All wrapped dialects built from the same `inner` share ONE inner driver:
 * SQLite has a single connection, and its mutex lives in the driver, so
 * per-site drivers would let one site's transaction swallow another's queries.
 */
export function siteDialect(inner: Dialect, getSite: () => string, primary: string): Dialect {
	const shared = sharedDriver(inner);
	return {
		createAdapter: () => scopeBatch(inner.createAdapter(), getSite, primary),
		createQueryCompiler: () => inner.createQueryCompiler(),
		createIntrospector: (db) => inner.createIntrospector(db),
		createDriver: (): Driver => ({
			init: () => shared.init(),
			// ponytail: no-op; the shared inner driver outlives any one site's Kysely.
			destroy: async () => {},
			acquireConnection: async () => scoped(await shared.driver.acquireConnection(), getSite, primary),
			beginTransaction: (c: DatabaseConnection, s: TransactionSettings) =>
				shared.driver.beginTransaction(unscoped(c), s),
			commitTransaction: (c) => shared.driver.commitTransaction(unscoped(c)),
			rollbackTransaction: (c) => shared.driver.rollbackTransaction(unscoped(c)),
			releaseConnection: (c) => shared.driver.releaseConnection(unscoped(c)),
		}),
	};
}

/**
 * D1 has no transactions, so EmDash calls `adapter.executeAtomicBatch(queries)`
 * (content writes, block types, ...). That path never touches a connection, so
 * the per-connection rewrite above is skipped and the writes land in the
 * PRIMARY site's tables. Wrap it with the same rewrite.
 */
function scopeBatch<A extends object>(adapter: A, getSite: () => string, primary: string): A {
	const batch = (adapter as { executeAtomicBatch?: (qs: CompiledQuery[]) => Promise<QueryResult<unknown>[]> })
		.executeAtomicBatch;
	if (typeof batch !== "function") return adapter;
	(adapter as { executeAtomicBatch: typeof batch }).executeAtomicBatch = async (qs) => {
		const suffix = suffixFor(getSite(), primary);
		if (!suffix) return batch.call(adapter, qs);
		const results = await batch.call(
			adapter,
			qs.map((q) => ({ ...q, sql: rewriteSql(q.sql, suffix), parameters: rewriteParams(q.sql, q.parameters, suffix) })),
		);
		return results.map((r, i) => ({ ...r, rows: translateRows(qs[i]!.sql, r.rows as never, suffix) }));
	};
	return adapter;
}
const sharedByInner = new WeakMap<Dialect, { driver: Driver; init: () => Promise<void> }>();
function sharedDriver(inner: Dialect) {
	let s = sharedByInner.get(inner);
	if (!s) {
		const driver = inner.createDriver();
		let started: Promise<void> | undefined;
		s = { driver, init: () => (started ??= driver.init()) };
		sharedByInner.set(inner, s);
	}
	return s;
}

const REAL = Symbol("realConnection");
type Scoped = DatabaseConnection & { [REAL]: DatabaseConnection };
const unscoped = (c: DatabaseConnection): DatabaseConnection => (c as Scoped)[REAL] ?? c;

function scoped(real: DatabaseConnection, getSite: () => string, primary: string): DatabaseConnection {
	const conn: Scoped = {
		[REAL]: real,
		async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
			const suffix = suffixFor(getSite(), primary);
			if (!suffix) return real.executeQuery<R>(q);
			const result = await real.executeQuery<R>({
				...q,
				sql: rewriteSql(q.sql, suffix),
				parameters: rewriteParams(q.sql, q.parameters, suffix),
			});
			return { ...result, rows: translateRows(q.sql, result.rows, suffix) };
		},
		streamQuery<R>(q: CompiledQuery, chunkSize: number) {
			const suffix = suffixFor(getSite(), primary);
			return real.streamQuery<R>(
				suffix ? { ...q, sql: rewriteSql(q.sql, suffix), parameters: rewriteParams(q.sql, q.parameters, suffix) } : q,
				chunkSize,
			);
		},
	};
	return conn;
}
