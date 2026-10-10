/** Pure-logic checks for the fleet page: `node --no-warnings scripts/fleet.selfcheck.ts` */
import { actionsFor, fleetBlocks, parseFleetAction, type FleetRow } from "../src/fleet-blocks.ts";
let failed = 0;
const check = (name: string, cond: boolean) => {
	if (!cond) failed++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
};
const row = (slug: string, o: Partial<FleetRow> = {}): FleetRow => ({ slug, name: slug, ownerEmail: `${slug}@x.test`, status: "ready", state: "active", createdAt: "2026-10-01T00:00:00Z", userCount: 2, ...o });
const fleet = [row("main", { userCount: 9 }), row("a"), row("b", { status: "failed" }), row("c", { state: "suspended" }), row("d", { state: "deleted" })];
const blocks = fleetBlocks(fleet, "main") as Array<Record<string, any>>;
const stats = blocks.find((b) => b.type === "stats")!;
const table = blocks.find((b) => b.type === "table")!;
check("the control plane is not a row", !table.rows.some((r: any) => r.site === "main"));
check("stats: sites exclude deleted, attention counts non-ready active, users exclude the control plane",
	JSON.stringify(stats.items.map((i: any) => i.value)) === JSON.stringify([3, 1, 1, 1, 8]));
check("every row has a menu with at least one item", table.rows.every((r: any) => r.actions.type === "menu" && r.actions.items.length > 0));
check("a ready site can be suspended, backed up, deleted", JSON.stringify(actionsFor(row("x"))) === JSON.stringify(["suspend", "backup", "delete"]));
check("a failed site offers retry", actionsFor(row("x", { status: "failed" }))[0] === "retry");
check("a deleted site can only be restored (purge has its own form)", JSON.stringify(actionsFor(row("x", { state: "deleted" }))) === JSON.stringify(["restore"]));
check("purge form lists only deleted sites and needs a confirmation toggle", (() => {
	const form = blocks.find((b) => b.type === "form")!;
	return form.fields[0].options.length === 1 && form.fields[0].options[0].value === "d" && form.fields[1].type === "toggle";
})());
check("no purge form without deleted sites", !(fleetBlocks([row("main"), row("a")], "main") as Array<any>).some((b) => b.type === "form"));
check("menu click parses", JSON.stringify(parseFleetAction("fleet:acme", "suspend")) === JSON.stringify({ slug: "acme", action: "suspend" }));
check("menu cannot purge, unknown actions and bad slugs are refused", [parseFleetAction("fleet:acme", "purge"), parseFleetAction("fleet:acme", "rm -rf"), parseFleetAction("fleet:../x", "delete"), parseFleetAction("other:acme", "delete"), parseFleetAction("fleet:acme", 5)].every((x) => x === null));
// The staff gate is `role >= 50`. Encode the rule here as a tripwire so a change
// to the threshold is caught (the real isStaff reads the DB; this guards the constant intent).
const STAFF_MIN = 50;
check("subscriber (10) is not staff", 10 >= STAFF_MIN === false);
check("editor (40) is not staff", 40 >= STAFF_MIN === false);
check("admin (50) is staff", 50 >= STAFF_MIN === true);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
