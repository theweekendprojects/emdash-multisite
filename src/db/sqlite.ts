import { createDialect as createInner } from "emdash/db/sqlite";
import { makeRuntime } from "../runtime.ts";

type InnerConfig = Parameters<typeof createInner>[0];

export const { createDialect, createRequestScopedDb } = makeRuntime<InnerConfig>(createInner);
