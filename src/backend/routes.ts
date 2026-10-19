import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  MAX_STATUS_INTERVAL,
  MIN_STATUS_INTERVAL,
  type HostStatusService,
} from "./status-service.js";

const ADMIN_PERMISSION = "admin.plugins.manage";

/** "1,2,3" to a list of ids; undefined means the caller asked for all. */
export function parseHostIds(value: unknown): number[] | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

export function registerRoutes(
  router: Router,
  ctx: PluginContext,
  service: HostStatusService,
): void {
  /**
   * @openapi
   * /plugin-api/host-status/:
   *   get:
   *     summary: Get host statuses
   *     description: Returns the online or offline status of every host the user can reach. Starts status checks for the user's hosts on the first call and waits briefly for their first results.
   *     tags:
   *       - Host Status
   *     parameters:
   *       - in: query
   *         name: hostIds
   *         required: false
   *         schema:
   *           type: string
   *         description: Comma separated ids. Only these hosts are checked.
   *     responses:
   *       200:
   *         description: A map of host ids to status entries.
   *       401:
   *         description: Not authenticated.
   */
  router.get("/", async (req: Request, res: Response) => {
    const userId = ctx.currentActor();
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const requested = parseHostIds(req.query.hostIds);
    const statuses = await service.statusesFor(userId, requested);
    const reachable = new Set(
      (await ctx.hosts.probeTargets()).map((target) => target.id),
    );
    const result: Record<number, unknown> = {};
    for (const [id, entry] of statuses) {
      if (reachable.has(id) && (!requested || requested.includes(id))) {
        result[id] = entry;
      }
    }
    res.json(result);
  });

  /**
   * @openapi
   * /plugin-api/host-status/refresh:
   *   post:
   *     summary: Restart status checks
   *     description: Re-reads the user's hosts and restarts their status checks.
   *     tags:
   *       - Host Status
   *     responses:
   *       200:
   *         description: Status checks restarted.
   *       401:
   *         description: Not authenticated.
   */
  router.post("/refresh", async (_req: Request, res: Response) => {
    const userId = ctx.currentActor();
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    await service.refresh(userId);
    res.json({ message: "Status checks restarted" });
  });

  /**
   * @openapi
   * /plugin-api/host-status/settings:
   *   get:
   *     summary: Get status check settings
   *     description: Returns the default number of seconds between status checks. Admin only.
   *     tags:
   *       - Host Status
   *     responses:
   *       200:
   *         description: The status check settings.
   *       403:
   *         description: Admin access required.
   */
  router.get("/settings", async (_req: Request, res: Response) => {
    if (!(await ctx.rbac.has(ADMIN_PERMISSION))) {
      return res.status(403).json({ error: "Admin access required" });
    }
    res.json({ statusCheckInterval: await service.getIntervalSeconds() });
  });

  /**
   * @openapi
   * /plugin-api/host-status/settings:
   *   put:
   *     summary: Update status check settings
   *     description: Sets the default number of seconds between status checks and re-times every running check. Admin only.
   *     tags:
   *       - Host Status
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               statusCheckInterval:
   *                 type: integer
   *                 minimum: 5
   *                 maximum: 3600
   *     responses:
   *       200:
   *         description: Settings saved.
   *       400:
   *         description: Invalid interval.
   *       403:
   *         description: Admin access required.
   */
  router.put("/settings", async (req: Request, res: Response) => {
    if (!(await ctx.rbac.has(ADMIN_PERMISSION))) {
      return res.status(403).json({ error: "Admin access required" });
    }
    const seconds = Number(req.body?.statusCheckInterval);
    if (
      !Number.isInteger(seconds) ||
      seconds < MIN_STATUS_INTERVAL ||
      seconds > MAX_STATUS_INTERVAL
    ) {
      return res.status(400).json({
        error: `Status check interval must be ${MIN_STATUS_INTERVAL} to ${MAX_STATUS_INTERVAL} seconds`,
      });
    }
    try {
      await service.setIntervalSeconds(seconds);
      res.json({ statusCheckInterval: seconds });
    } catch (error) {
      ctx.log.error(
        "Failed to save status check settings",
        error instanceof Error ? error : new Error(String(error)),
      );
      res.status(500).json({ error: "Failed to save settings" });
    }
  });
}
