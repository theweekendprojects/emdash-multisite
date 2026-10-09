import type { SitesConfig } from "./sites.ts";
// Set at build time by withSites(), carried in the config baked into the Worker.
// @ts-ignore - virtual module provided by EmDash's integration
import emdashConfig from "virtual:emdash/config";

interface WithSites {
	database?: { config?: { sites?: SitesConfig } };
}

/** The multisite config of this build, or undefined when the database is not wrapped. */
export function sitesConfig(): SitesConfig | undefined {
	return (emdashConfig as WithSites).database?.config?.sites;
}
