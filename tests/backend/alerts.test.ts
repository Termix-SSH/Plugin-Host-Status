import { describe, expect, it } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { sendStatusAlert } from "../../src/backend/alerts.js";

function fake(setting?: boolean) {
  const sent: Array<Record<string, unknown>> = [];
  const ctx = {
    settings: { get: async () => setting },
    asUser: async (_u: string, fn: () => unknown) => fn(),
    hosts: { get: async () => ({ name: "web" }) },
    notify: {
      send: async (n: Record<string, unknown>) => {
        sent.push(n);
      },
    },
  } as unknown as PluginContext;
  return { ctx, sent };
}

const down = {
  hostId: 3,
  ownerUserId: "u1",
  status: "offline" as const,
  previous: "online" as const,
  online: false,
};

describe("host status alerts", () => {
  it("alerts the owner when a host goes down and when it is back", async () => {
    const { ctx, sent } = fake();
    await sendStatusAlert(ctx, down);
    await sendStatusAlert(ctx, {
      ...down,
      status: "online",
      previous: "offline",
      online: true,
    });
    expect(sent.map((n) => n.category)).toEqual([
      "host-status.offline",
      "host-status.online",
    ]);
    expect(sent[0]).toMatchObject({
      title: "web is offline",
      audience: { userId: "u1" },
    });
  });

  it("stays quiet on the first reading and when turned off", async () => {
    const first = fake();
    await sendStatusAlert(first.ctx, { ...down, previous: null });
    const off = fake(false);
    await sendStatusAlert(off.ctx, down);
    expect(first.sent).toHaveLength(0);
    expect(off.sent).toHaveLength(0);
  });
});
