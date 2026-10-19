import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostStatusService,
  normalizeInterval,
  type StatusTarget,
} from "../../src/backend/status-service.js";

function target(id: number, extra: Partial<StatusTarget> = {}): StatusTarget {
  return {
    id,
    ownerUserId: "owner",
    ip: `10.0.0.${id}`,
    port: 22,
    connectionType: "ssh",
    jumpHosts: [],
    statusCheckEnabled: true,
    statusCheckInterval: null,
    ...extra,
  };
}

type Listener<A extends unknown[]> = (...args: A) => void;

function bus<A extends unknown[]>() {
  const listeners = new Set<Listener<A>>();
  return {
    on: (listener: Listener<A>) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (...args: A) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

/** What each user can reach, as ctx.hosts.probeTargets would answer. */
function setup(
  targets: StatusTarget[],
  reachable = true,
  visible: Record<string, number[]> = {},
) {
  const emitted: unknown[] = [];
  const sessions = new Set<number>();
  const sessionBus = bus<[number, boolean]>();
  const updatedBus = bus<[number, string | undefined]>();
  const deletedBus = bus<[number]>();
  const ping = vi.fn(async (_host: string, _port: number) => reachable);
  const pingThroughJumpHosts = vi.fn(async () => reachable);
  const loadTargets = vi.fn(
    async (filter: { forUser?: string; hostIds?: number[] }) =>
      targets.filter(
        (t) =>
          (!filter.forUser ||
            t.ownerUserId === filter.forUser ||
            visible[filter.forUser]?.includes(t.id)) &&
          (!filter.hostIds || filter.hostIds.includes(t.id)),
      ),
  );
  const service = new HostStatusService({
    loadTargets,
    ping,
    pingThroughJumpHosts,
    hasActiveSession: (id) => sessions.has(id),
    onSession: sessionBus.on,
    onHostUpdated: (listener) => updatedBus.on(listener),
    onHostDeleted: (listener) => deletedBus.on(listener),
    readInterval: async () => 60,
    writeInterval: async () => {},
    globalInterval: () => 60,
    emit: (payload) => emitted.push(payload),
    warn: () => {},
    retryDelayMs: 0,
  });
  const openSession = (id: number) => {
    sessions.add(id);
    sessionBus.emit(id, true);
    return () => {
      sessions.delete(id);
      sessionBus.emit(id, false);
    };
  };
  return {
    service,
    emitted,
    ping,
    pingThroughJumpHosts,
    loadTargets,
    openSession,
    deleted: deletedBus,
    updated: updatedBus,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let active: HostStatusService | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  active?.stop();
  active = null;
  vi.useRealTimers();
});

describe("HostStatusService", () => {
  it.each([{ jumpHosts: [] }, { jumpHosts: [{ hostId: 9 }] }])(
    "skips probes while a session is open, including jump hosts: %j",
    async ({ jumpHosts }) => {
      const { service, ping, pingThroughJumpHosts, openSession } = setup([
        target(7, { jumpHosts }),
      ]);
      active = service;
      const close = openSession(7);
      try {
        await service.statusesFor("owner", null);
        await flush();
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();
        expect(service.get(7)?.status).toBe("online");
        expect(ping).not.toHaveBeenCalled();
        expect(pingThroughJumpHosts).not.toHaveBeenCalled();
        close();
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();
        expect(
          jumpHosts.length ? pingThroughJumpHosts : ping,
        ).toHaveBeenCalledOnce();
      } finally {
        close();
      }
    },
  );

  it("starts a user's own hosts and reports them online", async () => {
    const { service, emitted, ping } = setup([target(1), target(2)]);
    active = service;

    await service.statusesFor("owner", null);
    await flush();

    expect(ping).toHaveBeenCalledWith("10.0.0.1", 22);
    expect(service.get(1)?.status).toBe("online");
    expect(emitted).toContainEqual({
      hostId: 1,
      ownerUserId: "owner",
      status: "online",
      previous: null,
      online: true,
    });
  });

  it("checks a host shared with the user before its owner ever asks", async () => {
    const { service, ping } = setup([target(5)], true, { recipient: [5] });
    active = service;

    await service.statusesFor("recipient", null);
    await flush();

    expect(ping).toHaveBeenCalledWith("10.0.0.5", 22);
    expect(service.get(5)?.status).toBe("online");
  });

  it("only starts the shared hosts a desktop request names", async () => {
    const { service, ping } = setup([target(5), target(6)], true, {
      recipient: [5, 6],
    });
    active = service;

    await service.statusesFor("recipient", [6]);
    await flush();

    expect(ping).toHaveBeenCalledWith("10.0.0.6", 22);
    expect(ping).not.toHaveBeenCalledWith("10.0.0.5", 22);
  });

  it("does not stop a shared host the recipient did not name", async () => {
    const { service } = setup([target(5)], true, { recipient: [5] });
    active = service;
    await service.statusesFor("owner", null);
    await flush();

    await service.statusesFor("recipient", [6]);
    expect(service.get(5)?.status).toBe("online");
  });

  it("reports offline for a host that does not answer", async () => {
    const { service } = setup([target(1)], false);
    active = service;
    await service.statusesFor("owner", null);
    await flush();
    expect(service.get(1)?.status).toBe("offline");
  });

  it("never checks a host with status checks off", async () => {
    const { service, ping } = setup([target(1, { statusCheckEnabled: false })]);
    active = service;
    await service.statusesFor("owner", null);
    await flush();
    expect(ping).not.toHaveBeenCalled();
    expect(service.get(1)).toBeNull();
  });

  it("goes through the jump hosts when a host has them", async () => {
    const { service, ping, pingThroughJumpHosts } = setup([
      target(1, { jumpHosts: [{ hostId: 9 }] }),
    ]);
    active = service;
    await service.statusesFor("owner", null);
    await flush();
    expect(ping).not.toHaveBeenCalled();
    expect(pingThroughJumpHosts).toHaveBeenCalledOnce();
  });

  it("asks a registered plugin for a protocol's port", async () => {
    const { service, ping } = setup([target(1, { connectionType: "rdp" })]);
    active = service;
    service.registerPort("rdp", async () => 3390);
    await service.statusesFor("owner", null);
    await flush();
    expect(ping).toHaveBeenCalledWith("10.0.0.1", 3390);
  });

  it("falls back to the host's port when no plugin knows the protocol", async () => {
    const { service, ping } = setup([
      target(1, { connectionType: "rdp", port: 3389 }),
    ]);
    active = service;
    await service.statusesFor("owner", null);
    await flush();
    expect(ping).toHaveBeenCalledWith("10.0.0.1", 3389);
  });

  it("ignores a failed login and counts a working one as online", async () => {
    const { service, emitted } = setup([target(1)]);
    active = service;
    await service.statusesFor("owner", null);

    const before = emitted.length;
    service.reportLogin(1, { ok: false });
    expect(service.get(1)?.status).toBe("online");
    expect(emitted).toHaveLength(before);
  });

  it("marks a host online when a terminal session opens", async () => {
    const { service, openSession } = setup([target(1)], false);
    active = service;
    service.start();
    await service.statusesFor("owner", null);
    expect(service.get(1)?.status).toBe("offline");

    const release = openSession(1);
    expect(service.get(1)?.status).toBe("online");
    release();
  });

  it("tries a failed ping again before reporting offline", async () => {
    const { service, ping } = setup([target(1)]);
    active = service;
    ping.mockResolvedValueOnce(false);
    await service.statusesFor("owner", null);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(service.get(1)?.status).toBe("online");
  });

  it("answers the first request with the first checks done", async () => {
    const { service } = setup([target(1), target(2)]);
    active = service;
    const statuses = await service.statusesFor("owner", null);
    expect(statuses.get(1)?.status).toBe("online");
    expect(statuses.get(2)?.status).toBe("online");
  });

  it("only checks the requested hosts on the desktop app", async () => {
    const { service, ping } = setup([target(1), target(2)]);
    active = service;
    await service.statusesFor("owner", [2]);
    await flush();
    expect(ping).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledWith("10.0.0.2", 22);
  });

  it("checks again on its interval", async () => {
    const { service, ping } = setup([target(1, { statusCheckInterval: 10 })]);
    active = service;
    await service.statusesFor("owner", null);
    await flush();
    expect(ping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(15_000);
    await flush();
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("checks a host on demand unless the last result is fresh", async () => {
    const { service, ping } = setup([target(1)]);
    active = service;
    expect(await service.check(1)).toMatchObject({ status: "online" });
    expect(await service.check(1)).toMatchObject({ status: "online" });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("forgets a deleted host", async () => {
    const { service, deleted } = setup([target(1)]);
    active = service;
    service.start();
    await service.statusesFor("owner", null);
    await flush();

    deleted.emit(1);
    expect(service.get(1)).toBeNull();
  });

  it("starts checking a host again after it is updated", async () => {
    const { service, ping, updated } = setup([target(1)]);
    active = service;
    service.start();
    await service.statusesFor("owner", null);
    await flush();
    expect(ping).toHaveBeenCalledTimes(1);

    updated.emit(1, "owner");
    await flush();
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("stops all timers and listeners on stop", async () => {
    const { service, ping, deleted } = setup([target(1)]);
    service.start();
    await service.statusesFor("owner", null);
    await flush();
    service.stop();

    await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(ping).toHaveBeenCalledTimes(1);
    deleted.emit(1);
    expect(service.get(1)?.status).toBe("online");
  });

  it("never logs in to check a host", async () => {
    // The only transports are the two ping functions: nothing here can
    // authenticate, so a RADIUS or Duo backed host gets no 2FA push.
    const { service, ping, pingThroughJumpHosts } = setup([target(1)]);
    active = service;
    await service.statusesFor("owner", null);
    await flush();
    expect(ping.mock.calls[0]).toEqual(["10.0.0.1", 22]);
    expect(pingThroughJumpHosts).not.toHaveBeenCalled();
  });

  it("restarts a user's checks on refresh", async () => {
    const { service, ping } = setup([target(1)]);
    active = service;
    await service.statusesFor("owner", null);
    await flush();
    await service.refresh("owner");
    await flush();
    expect(ping).toHaveBeenCalledTimes(2);
  });
});

describe("normalizeInterval", () => {
  it.each([
    [30, 30],
    [5, 5],
    [4, 30],
    [3600, 3600],
    [99999, 3600],
    [12.5, 30],
    ["abc", 30],
    [undefined, 30],
  ])("%s becomes %s", (value, expected) => {
    expect(normalizeInterval(value)).toBe(expected);
  });
});
