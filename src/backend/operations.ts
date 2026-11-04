import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import type { HostStatusService } from "./status-service.js";

function requireHost(context: PluginOperationContext): number {
  if (context.hostId === undefined) throw new Error("This needs a host");
  return context.hostId;
}

/** Reachability as an action, so it shows as a tile and rules can use it. */
export function registerOperations(
  ctx: PluginContext,
  service: HostStatusService,
): void {
  if (typeof ctx.operations?.register !== "function") return;

  ctx.operations.register("host-status.check", {
    run: async (_input, context) => {
      const entry = await service.check(requireHost(context));
      if (!entry) {
        return {
          summary: "Status checks are off for this host",
          data: { value: null, status: "unknown", label: "Not checked" },
        };
      }
      const online = entry.status === "online";
      const label = online ? "Online" : "Offline";
      return {
        summary: label,
        data: {
          value: entry.status,
          status: online ? "ok" : "fail",
          label,
          lastChecked: entry.lastChecked,
        },
      };
    },
  });
}
