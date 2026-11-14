import { describe, expect, it } from "vitest";
import { checkFrameApp } from "@termix-ssh/plugin-sdk/testing";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";

describe("sandboxed frame", () => {
  it("runs in a frame and registers nothing", async () => {
    const { problems, registrations } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    expect(problems).toEqual([]);
    expect(registrations).toEqual([]);
  });
});
