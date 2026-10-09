/**
 * Run a clone on D1: read a template site's schema, then rebuild it under the new
 * site id in ONE batch (one transaction, one round trip). Goes straight to the D1
 * binding, not through the per-site dialect: the statements already carry the
 * physical `$<site>` names.
 *
 * ponytail: D1 only (the Node/SQLite host falls back to migrate-and-seed), and one
 * batch, so a template whose clone outgrows D1's batch limits needs chunking.
 */
import { clonePlan, type MasterRow } from "./clone.ts";
import { d1Binding } from "./config.ts";
import { platformEnv } from "./platform-env.ts";
import { templateId } from "./rules.ts";

export interface D1Statement {
	bind(...v: unknown[]): D1Statement;
	all<T = unknown>(): Promise<{ results: T[] }>;
}
export interface D1 {
	prepare(sql: string): D1Statement;
	batch(statements: D1Statement[]): Promise<Array<{ results: unknown[] }>>;
}

export const d1 = async (): Promise<D1 | undefined> => {
	const binding = d1Binding();
	return binding ? ((await platformEnv())?.[binding] as D1 | undefined) : undefined;
};

/**
 * True when the theme's template is complete. The `multisite:theme` option is the
 * last thing `buildTemplate` writes, so a template killed half way does not count.
 */
export async function hasTemplate(theme: string): Promise<boolean> {
	const db = await d1();
	if (!db) return false;
	const table = `options$${templateId(theme)}`;
	const q = (sql: string, ...v: unknown[]) => db.prepare(sql).bind(...v).all();
	if (!(await q("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table)).results.length) return false;
	return (await q(`SELECT 1 FROM "${table}" WHERE name = 'multisite:theme'`)).results.length > 0;
}

/**
 * Create `to` as a copy of the theme's template. Returns false when there is no
 * template (caller falls back to migrating and seeding). Atomic: on failure
 * nothing of `to` exists, so a retry starts clean.
 */
export async function cloneTemplate(theme: string, to: string): Promise<boolean> {
	const db = await d1();
	if (!db || !(await hasTemplate(theme))) return false;
	const from = templateId(theme);
	const { results } = await db.prepare("SELECT type, name, sql FROM sqlite_master WHERE instr(name, ?) > 0").bind(`$${from}`).all<MasterRow>();
	const plan = clonePlan(results, from, to);
	// Foreign keys are checked at commit, so copy order between tables does not matter.
	const statements = ["PRAGMA defer_foreign_keys = ON", ...plan.schema, ...plan.copy, ...plan.triggers];
	await db.batch(statements.map((s) => db.prepare(s)));
	return true;
}
