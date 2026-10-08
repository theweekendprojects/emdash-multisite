import { createDialect as createInner } from "@emdash-cms/cloudflare/db/d1";
import { makeRuntime } from "../runtime.ts";

type InnerConfig = Parameters<typeof createInner>[0];

// ponytail: D1 Sessions (read replicas, bookmark cookies) are not used; every
// request gets the plain binding. Upgrade path: build the per-site Kysely over
// the inner adapter's session-backed dialect.
export const { createDialect, createRequestScopedDb } = makeRuntime<InnerConfig>(createInner);
