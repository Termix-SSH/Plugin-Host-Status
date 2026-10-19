/**
 * The host list's status dot.
 *
 * Every host with status checks on gets a TCP connection to its port on a
 * timer. A port that answers is "online", one that does not (twice in a row)
 * is "offline". An open session or a working login also counts as online.
 * Probing never logs in to the host itself: on RADIUS or Duo backed devices a
 * login fires a real 2FA push, every interval. A host behind jump hosts is
 * probed through a chain by core, which does log in to the hops.
 *
 * Polling is demand driven. A user asking for statuses starts polling the
 * hosts they can reach; nothing is probed for a user who never opened the app.
 * The first request waits briefly for those first checks so it is not empty.
 */

import type {
  PluginHostProbeTarget,
  PluginHostStatusEntry,
  PluginHostStatusProvider,
} from "@termix-ssh/plugin-sdk/backend";
import { ConcurrentLimiter } from "./limiter.js";

export const DEFAULT_STATUS_INTERVAL = 30;
export const MIN_STATUS_INTERVAL = 5;
export const MAX_STATUS_INTERVAL = 3600;
/** How long the first request for a user waits for the first checks. */
const FIRST_CHECK_WAIT_MS = 6_000;
/** A status younger than this is fresh enough for check(). */
const FRESH_MS = 30_000;

export type HostStatus = "online" | "offline";

export interface HostStatusPayload {
  hostId: number;
  ownerUserId: string;
  status: HostStatus;
  previous: HostStatus | null;
  /** Anything but offline, the shape automations' trigger already reads. */
  online: boolean;
}

export type StatusTarget = PluginHostProbeTarget;

type PortResolver = (
  hostId: number,
) => number | undefined | Promise<number | undefined>;

export interface HostStatusDeps {
  /** The hosts a user can reach, or the named ones among them. */
  loadTargets: (filter: {
    forUser?: string;
    hostIds?: number[];
  }) => Promise<StatusTarget[]>;
  ping: (host: string, port: number) => Promise<boolean>;
  pingThroughJumpHosts: (
    target: StatusTarget,
    port: number,
  ) => Promise<boolean>;
  hasActiveSession: (hostId: number) => boolean;
  /** Calls the listener when a session opens or closes. */
  onSession: (
    listener: (hostId: number, online: boolean) => void,
  ) => () => void;
  onHostUpdated: (
    listener: (hostId: number, userId?: string) => void,
  ) => () => void;
  onHostDeleted: (listener: (hostId: number) => void) => () => void;
  readInterval: () => Promise<number>;
  writeInterval: (seconds: number) => Promise<void>;
  globalInterval: () => number;
  emit: (payload: HostStatusPayload) => void;
  warn: (message: string, error?: unknown) => void;
  /** Pause before a failed ping is tried again. */
  retryDelayMs?: number;
}

interface Polled {
  target: StatusTarget;
  timer?: NodeJS.Timeout;
}

export function normalizeInterval(value: unknown): number {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= MIN_STATUS_INTERVAL
    ? Math.min(seconds, MAX_STATUS_INTERVAL)
    : DEFAULT_STATUS_INTERVAL;
}

export class HostStatusService implements PluginHostStatusProvider {
  private readonly polled = new Map<number, Polled>();
  private readonly store = new Map<number, PluginHostStatusEntry>();
  private readonly owners = new Map<number, string>();
  private readonly inFlight = new Map<number, Promise<void>>();
  private readonly startedUsers = new Set<string>();
  private readonly portResolvers = new Map<string, Set<PortResolver>>();
  private readonly limiter = new ConcurrentLimiter(20);
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly deps: HostStatusDeps) {}

  /** Subscribes to the core events the status depends on. */
  start(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers = [
      this.deps.onSession((hostId, online) => {
        if (online) this.reportLogin(hostId, { ok: true });
      }),
      this.deps.onHostUpdated((hostId, userId) => {
        void this.reload(hostId, userId);
      }),
      this.deps.onHostDeleted((hostId) => this.forget(hostId)),
    ];
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    for (const hostId of [...this.polled.keys()]) this.stopPolling(hostId);
    this.startedUsers.clear();
  }

  get(hostId: number): PluginHostStatusEntry | null {
    return this.store.get(hostId) ?? null;
  }

  /**
   * Statuses for a user's request. With hostIds, polling is brought in line
   * with exactly those hosts (the desktop app sends only the hosts that live
   * on this backend). Without, the user's hosts are started once.
   */
  async statusesFor(
    userId: string,
    requestedHostIds: number[] | null,
  ): Promise<Map<number, PluginHostStatusEntry>> {
    const started: Promise<void>[] = [];
    if (requestedHostIds !== null) {
      await this.reconcile(userId, new Set(requestedHostIds), started);
    } else if (!this.startedUsers.has(userId)) {
      await this.startUser(userId, started);
    }
    if (started.length > 0) await this.waitFor(started);
    return this.store;
  }

  /** Drops every timer for a user's hosts and starts them again. */
  async refresh(userId: string): Promise<void> {
    const targets = await this.deps.loadTargets({ forUser: userId });
    for (const target of targets) this.stopPolling(target.id);
    for (const target of targets) this.startPolling(target);
    this.startedUsers.add(userId);
  }

  async getIntervalSeconds(): Promise<number> {
    return normalizeInterval(await this.deps.readInterval());
  }

  async setIntervalSeconds(seconds: number): Promise<void> {
    await this.deps.writeInterval(seconds);
    this.retimeAll();
  }

  /** Re-times every polled host, after the global interval changed. */
  retimeAll(): void {
    for (const { target } of [...this.polled.values()]) {
      this.startPolling(target, false);
    }
  }

  /** Checks now unless the last result is fresh. */
  async check(hostId: number): Promise<PluginHostStatusEntry | null> {
    const current = this.store.get(hostId);
    if (current && Date.now() - Date.parse(current.lastChecked) < FRESH_MS) {
      return current;
    }
    const target =
      this.polled.get(hostId)?.target ??
      (await this.deps.loadTargets({ hostIds: [hostId] }))[0];
    if (!target || !target.statusCheckEnabled) return current ?? null;
    await this.probe(target);
    return this.store.get(hostId) ?? null;
  }

  /**
   * A working login proves the host is up. A failed one says nothing about
   * reachability (a wrong password, another user's login), so it is ignored.
   */
  reportLogin(hostId: number, outcome: { ok: boolean }): void {
    if (outcome.ok) this.set(hostId, { status: "online" });
  }

  registerPort(connectionType: string, resolve: PortResolver): () => void {
    let set = this.portResolvers.get(connectionType);
    if (!set) {
      set = new Set();
      this.portResolvers.set(connectionType, set);
    }
    set.add(resolve);
    return () => {
      set!.delete(resolve);
      if (set!.size === 0) this.portResolvers.delete(connectionType);
    };
  }

  private async waitFor(started: Promise<void>[]): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(started),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FIRST_CHECK_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private track(started: Promise<void>[], target: StatusTarget): void {
    const probe = this.startPolling(target);
    if (probe) started.push(probe);
  }

  private async startUser(
    userId: string,
    started: Promise<void>[],
  ): Promise<void> {
    this.startedUsers.add(userId);
    const targets = await this.deps.loadTargets({ forUser: userId });
    for (const target of targets) {
      if (!this.polled.has(target.id)) this.track(started, target);
    }
  }

  private async reconcile(
    userId: string,
    allowed: Set<number>,
    started: Promise<void>[],
  ): Promise<void> {
    const targets = await this.deps.loadTargets({ forUser: userId });
    for (const target of targets) {
      if (!allowed.has(target.id)) {
        // Only the owner's request stops a host; a shared one is not theirs.
        if (target.ownerUserId === userId) {
          this.stopPolling(target.id);
          this.store.delete(target.id);
        }
        continue;
      }
      if (!this.polled.has(target.id)) this.track(started, target);
    }
  }

  private async reload(hostId: number, userId?: string): Promise<void> {
    try {
      const [target] = await this.deps.loadTargets({
        forUser: userId,
        hostIds: [hostId],
      });
      if (!target) {
        this.forget(hostId);
        return;
      }
      if (
        this.polled.has(hostId) ||
        this.startedUsers.has(target.ownerUserId)
      ) {
        this.startPolling(target);
      }
    } catch (error) {
      this.deps.warn("Could not reload host for status checks", error);
    }
  }

  private forget(hostId: number): void {
    this.stopPolling(hostId);
    this.store.delete(hostId);
    this.owners.delete(hostId);
  }

  private intervalMs(target: StatusTarget): number {
    const seconds = target.statusCheckInterval ?? this.deps.globalInterval();
    const intervalMs = Math.max(MIN_STATUS_INTERVAL, seconds) * 1000;
    // Spread hosts so a fleet does not fire on the same second.
    const spread = Math.min(intervalMs * 0.2, 15_000);
    return (
      intervalMs + ((target.id * 1103515245) % Math.max(1, Math.floor(spread)))
    );
  }

  /** Returns the first probe when one was started. */
  private startPolling(
    target: StatusTarget,
    probeNow = true,
  ): Promise<void> | undefined {
    this.stopPolling(target.id);
    this.owners.set(target.id, target.ownerUserId);
    if (!target.statusCheckEnabled) {
      this.store.delete(target.id);
      return undefined;
    }
    const polled: Polled = { target };
    this.polled.set(target.id, polled);
    const first = probeNow ? this.probe(target) : undefined;
    polled.timer = setInterval(() => {
      const latest = this.polled.get(target.id);
      if (latest) void this.probe(latest.target);
    }, this.intervalMs(target));
    polled.timer.unref?.();
    return first;
  }

  private stopPolling(hostId: number): void {
    const polled = this.polled.get(hostId);
    if (polled?.timer) clearInterval(polled.timer);
    this.polled.delete(hostId);
  }

  private probe(target: StatusTarget): Promise<void> {
    const running = this.inFlight.get(target.id);
    if (running) return running;
    const job = this.limiter
      .run(() => this.probeNow(target))
      .catch((error) => {
        this.deps.warn(`Status check failed for host ${target.id}`, error);
      })
      .finally(() => this.inFlight.delete(target.id));
    this.inFlight.set(target.id, job);
    return job;
  }

  private async portFor(target: StatusTarget): Promise<number> {
    if (target.connectionType !== "ssh") {
      for (const resolve of this.portResolvers.get(target.connectionType) ??
        []) {
        try {
          const port = await resolve(target.id);
          if (Number.isInteger(port) && port! > 0) return port!;
        } catch {
          // fall through to the next resolver
        }
      }
    }
    return target.port;
  }

  private async pingOnce(target: StatusTarget): Promise<boolean> {
    try {
      if (this.deps.hasActiveSession(target.id)) return true;
      const port = await this.portFor(target);
      return target.jumpHosts.length > 0
        ? await this.deps.pingThroughJumpHosts(target, port)
        : await this.deps.ping(target.ip, port);
    } catch {
      return false;
    }
  }

  private async probeNow(target: StatusTarget): Promise<void> {
    this.owners.set(target.id, target.ownerUserId);
    let reachable = await this.pingOnce(target);
    if (!reachable) {
      // One lost packet should not flip the dot.
      const delay = this.deps.retryDelayMs ?? 1000;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      reachable = await this.pingOnce(target);
    }
    this.set(target.id, { status: reachable ? "online" : "offline" });
  }

  private set(
    hostId: number,
    entry: Omit<PluginHostStatusEntry, "lastChecked">,
  ): void {
    const previous = (this.store.get(hostId)?.status ??
      null) as HostStatus | null;
    const next: PluginHostStatusEntry = {
      ...entry,
      lastChecked: new Date().toISOString(),
    };
    this.store.set(hostId, next);
    if (previous === next.status) return;
    const ownerUserId = this.owners.get(hostId);
    if (!ownerUserId) return;
    this.deps.emit({
      hostId,
      ownerUserId,
      status: next.status as HostStatus,
      previous,
      online: next.status === "online",
    });
  }
}
