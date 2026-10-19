import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createStatusDeps } from "./deps.js";
import { HostStatusService, normalizeInterval } from "./status-service.js";
import { registerRoutes } from "./routes.js";

export async function activate(ctx: PluginContext) {
  const { deps, setInterval } = createStatusDeps(ctx);
  setInterval(normalizeInterval(await ctx.settings.get("intervalSeconds")));

  const service = new HostStatusService(deps);
  ctx.hosts.status.provide(service);

  // Changing the setting in the admin screen re-times running checks.
  ctx.settings.onChange("intervalSeconds", (value) => {
    setInterval(normalizeInterval(value));
    service.retimeAll();
  });

  registerRoutes(ctx.http.router<Router>(), ctx, service);
  ctx.log.info("Host status provider mounted at /plugin-api/host-status");
}

export async function deactivate() {
  // The provider and its timers are removed through ctx by core.
}
