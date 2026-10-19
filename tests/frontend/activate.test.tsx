import { afterEach, describe, expect, it } from "vitest";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

describe(`${manifest.id} activate`, () => {
  it("activates without adding screens", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual([]);
    expect(rendered.registered.railItems()).toEqual([]);
  });

  it("has a label and description for every setting", () => {
    for (const field of manifest.contributes?.settings?.admin ?? []) {
      const key = field.labelKey.replace(/^settings\./, "");
      expect(key.length).toBeGreaterThan(0);
      expect(locales.settings.admin.intervalSeconds.label).toBeTruthy();
      expect(locales.settings.admin.intervalSeconds.description).toBeTruthy();
    }
  });
});
