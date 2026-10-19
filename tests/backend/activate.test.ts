import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginHostProbeTarget } from "@termix-ssh/plugin-sdk/backend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { parseHostIds } from "../../src/backend/routes.js";

const manifest = manifestJson as unknown as PluginManifest;

function probeTarget(
  id: number,
  extra: Partial<PluginHostProbeTarget> = {},
): PluginHostProbeTarget {
  return {
    id,
    ownerUserId: "user-1",
    ip: `10.0.0.${id}`,
    port: 22,
    connectionType: "ssh",
    jumpHosts: [],
    statusCheckEnabled: true,
    statusCheckInterval: null,
    ...extra,
  };
}

let mock: MockPluginContext;
let server: http.Server;
let port: number;
let router: Router;

async function boot(options: {
  permissions?: string[];
  capabilities?: string[];
  targets?: PluginHostProbeTarget[];
  reachable?: (target: string | number, port?: number) => boolean;
}) {
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: options.capabilities ?? manifest.capabilities,
    router: () => (router = express.Router()),
    permissions: options.permissions ?? [],
    probeTargets: options.targets ?? [],
    reachable: options.reachable ?? (() => true),
  });
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    mock.setActor("user-1");
    next();
  });
  app.use((req, res, next) => router(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
}

afterEach(async () => {
  mock?.hostStatusProviders.forEach((provider) => provider.stop());
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

const call = (path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json" },
  });

describe("activate", () => {
  it("becomes the host status provider", async () => {
    await boot({});
    expect(mock.hostStatusProviders).toHaveLength(1);
  });

  it("fails closed without the provide capability", async () => {
    await expect(
      boot({
        capabilities: manifest.capabilities.filter(
          (capability) => capability !== "hosts:status-provide",
        ),
      }),
    ).rejects.toThrow(/hosts:status-provide/);
  });

  it("declares only what it uses", () => {
    expect([...manifest.capabilities].sort()).toEqual(
      [
        "events:core",
        "hosts:read",
        "hosts:status-provide",
        "network:probe",
        "network:serve",
        "ssh:connect",
        "users:impersonate",
      ].sort(),
    );
  });
});

describe("routes", () => {
  beforeEach(() => {
    mock = undefined as never;
  });

  it("returns statuses for the hosts the user can reach", async () => {
    await boot({ targets: [probeTarget(1), probeTarget(2)] });
    const res = await call("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, { status: string }>;
    expect(body[1].status).toBe("online");
    expect(body[2].status).toBe("online");
  });

  it("reports offline for an unreachable host", async () => {
    await boot({
      targets: [probeTarget(1)],
      reachable: () => false,
    });
    const body = (await (await call("/")).json()) as Record<
      string,
      { status: string }
    >;
    expect(body[1].status).toBe("offline");
  }, 15_000);

  it("limits the answer to the requested ids", async () => {
    await boot({ targets: [probeTarget(1), probeTarget(2)] });
    const body = (await (await call("/?hostIds=2")).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body)).toEqual(["2"]);
  });

  it("restarts checks on refresh", async () => {
    await boot({ targets: [probeTarget(1)] });
    const res = await call("/refresh", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("keeps the interval settings to admins", async () => {
    await boot({});
    expect((await call("/settings")).status).toBe(403);
    expect(
      (
        await call("/settings", {
          method: "PUT",
          body: JSON.stringify({ statusCheckInterval: 60 }),
        })
      ).status,
    ).toBe(403);
  });

  it("reads and saves the interval for an admin", async () => {
    await boot({ permissions: ["admin.plugins.manage"] });
    expect(await (await call("/settings")).json()).toEqual({
      statusCheckInterval: 30,
    });
    const saved = await call("/settings", {
      method: "PUT",
      body: JSON.stringify({ statusCheckInterval: 90 }),
    });
    expect(saved.status).toBe(200);
    expect(await mock.ctx.settings.get("intervalSeconds")).toBe(90);
    expect(await (await call("/settings")).json()).toEqual({
      statusCheckInterval: 90,
    });
  });

  it.each([4, 3601, 1.5, "abc"])(
    "refuses the interval %s",
    async (statusCheckInterval) => {
      await boot({ permissions: ["admin.plugins.manage"] });
      const res = await call("/settings", {
        method: "PUT",
        body: JSON.stringify({ statusCheckInterval }),
      });
      expect(res.status).toBe(400);
    },
  );
});

describe("parseHostIds", () => {
  it("treats a missing value as all hosts", () => {
    expect(parseHostIds(undefined)).toBeNull();
  });

  it("keeps only positive integers", () => {
    expect(parseHostIds("1,2,x,-3,0,4")).toEqual([1, 2, 4]);
    expect(parseHostIds(["1"])).toEqual([]);
  });
});
