import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { HostStatusPayload } from "./status-service.js";

/** Tells the host's owner when it goes down and when it is back. */
export async function sendStatusAlert(
  ctx: PluginContext,
  payload: HostStatusPayload,
): Promise<void> {
  // The first reading after a start has nothing to compare with.
  if (payload.previous === null) return;
  if ((await ctx.settings.get<boolean>("alertOnOffline")) === false) return;
  let name = `#${payload.hostId}`;
  try {
    const host = await ctx.asUser(payload.ownerUserId, () =>
      ctx.hosts.get(payload.hostId),
    );
    if (host?.name) name = host.name;
  } catch {
    // The id is enough.
  }
  await ctx.notify.send({
    title: payload.online ? `${name} is back online` : `${name} is offline`,
    severity: payload.online ? "success" : "critical",
    category: payload.online ? "host-status.online" : "host-status.offline",
    audience: { userId: payload.ownerUserId },
    dedupeKey: `host-status:${payload.hostId}:${payload.status}`,
    context: { hostId: payload.hostId },
  });
}
