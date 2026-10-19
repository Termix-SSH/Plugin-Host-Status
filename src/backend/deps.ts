import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  DEFAULT_STATUS_INTERVAL,
  normalizeInterval,
  type HostStatusDeps,
  type HostStatusPayload,
} from "./status-service.js";

const PROBE_TIMEOUT_MS = 5000;

/** Wires the service to core through ctx. */
export function createStatusDeps(ctx: PluginContext): {
  deps: HostStatusDeps;
  setInterval: (seconds: number) => void;
} {
  let interval = DEFAULT_STATUS_INTERVAL;

  const deps: HostStatusDeps = {
    loadTargets: async ({ forUser, hostIds }) => {
      const load = () =>
        ctx.hosts.probeTargets(hostIds ? { hostIds } : undefined);
      return forUser ? ctx.asUser(forUser, load) : load();
    },
    ping: (host, port) =>
      ctx.network.tcpProbe(host, port, { timeoutMs: PROBE_TIMEOUT_MS }),
    // Background checks run as the host's owner, who may always connect to it.
    pingThroughJumpHosts: (target, port) =>
      ctx.asUser(target.ownerUserId, () =>
        ctx.ssh.probe(target.id, { port, timeoutMs: PROBE_TIMEOUT_MS }),
      ),
    hasActiveSession: (hostId) => ctx.hosts.sessionActive(hostId),
    onSession: (listener) =>
      ctx.events.on("host.session.status", (payload) => {
        const { hostId, online } = payload as {
          hostId?: number;
          online?: boolean;
        };
        if (typeof hostId === "number") listener(hostId, Boolean(online));
      }),
    onHostUpdated: (listener) =>
      ctx.events.on("host.updated", (payload) => {
        const { hostId, userId } = payload as {
          hostId?: number;
          userId?: string;
        };
        if (typeof hostId === "number") listener(hostId, userId);
      }),
    onHostDeleted: (listener) =>
      ctx.events.on("host.deleted", (payload) => {
        const { hostId } = payload as { hostId?: number };
        if (typeof hostId === "number") listener(hostId);
      }),
    readInterval: async () =>
      (await ctx.settings.get<number>("intervalSeconds")) ?? interval,
    writeInterval: async (seconds) => {
      interval = normalizeInterval(seconds);
      await ctx.settings.set("intervalSeconds", interval);
    },
    globalInterval: () => interval,
    emit: (payload: HostStatusPayload) =>
      ctx.events.emit("host.status", payload),
    warn: (message, error) =>
      ctx.log.warn(
        error instanceof Error ? `${message}: ${error.message}` : message,
      ),
  };

  return {
    deps,
    setInterval: (seconds) => {
      interval = seconds;
    },
  };
}
