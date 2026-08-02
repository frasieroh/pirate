/**
 * The preference store: the theme-name clamp, and the fault line.
 *
 * `src/prefs.ts` keeps the whole record in one cookie, under
 * `COOKIE_LIMIT_BYTES`. The one field with no natural length bound is the
 * theme name, which comes from a file name that the operator chose. These
 * tests measure the clamp on that field, and the line that the menu shows
 * when a write to the cookie still fails for another reason.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { clientState, server, waitFor, waitForConnected, withClient } from "./harness";

/** The absolute path of one fixture file. */
function fixturePath(name: string): string {
  return `${import.meta.dir}/fixtures/${name}`;
}

/** The computed value of one custom property, on the root element. */
function cssVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

/** The text of the one note line of the menu. */
async function noteText(page: Page): Promise<string> {
  return ((await page.textContent("#menu-note")) ?? "").trim();
}

test("an over-long theme name is clamped, and the record still persists across a reload", async () => {
  // Before the fix, an emoji-heavy file name pushed the encoded record past
  // the cookie limit. The write was then rejected, silently, and every
  // later preference change failed to persist with it, because one cookie
  // holds the whole record.
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    // 80 codepoints of one emoji. `encodeURIComponent` expands each one to
    // twelve encoded characters, so this name alone would cost about 960
    // encoded bytes, unclamped: enough to push the whole record past the
    // 3800-byte limit.
    const longName = "🎨".repeat(80);
    await page.setInputFiles("#theme-import", {
      name: `${longName}.itermcolors`,
      mimeType: "text/plain",
      buffer: readFileSync(fixturePath("atom-one-light.itermcolors")),
    });

    await waitFor(
      () => clientState(page).then((s) => s.themeName),
      (name) => name.length > 0,
      "the imported theme name",
    );

    const state = await clientState(page);
    // `Array.from` splits a string by codepoint, so this count matches the
    // clamp in `src/prefs.ts`, not a count of UTF-16 code units.
    expect(Array.from(state.themeName).length).toBeLessThanOrEqual(32);
    expect(longName.startsWith(state.themeName)).toBe(true);
    // A clamped name still fits, so the write reached the cookie, and the
    // menu shows no fault.
    expect(await noteText(page)).toBe("");
    expect(await cssVar(page, "--pirate-bg")).toBe("#f9f9f9");

    await page.reload();
    await waitForConnected(page);

    const afterReload = await clientState(page);
    expect(afterReload.themeName).toBe(state.themeName);
    expect(await cssVar(page, "--pirate-bg")).toBe("#f9f9f9");
    // One cookie holds the whole record. A rejected write would have kept
    // the theme in memory only, and the reload above would have lost it.
    const cookies = await page.context().cookies();
    expect(cookies.map((cookie) => cookie.name)).toEqual(["pirate.prefs"]);
  });
});

test("if a write to the cookie is still rejected, the menu shows the line", async () => {
  // The theme-name clamp closes the one field that a file name can make
  // unbounded. This test proves the fault line still reaches the operator
  // for another cause: a rebind reads its chord from `KeyboardEvent.code`,
  // a plain string with no length check of its own. The capture below
  // stands in for a malformed input event; the point is the store's own
  // reaction to an oversized record, not this particular cause.
  //
  // This also proves the fix for the live half of the defect: the fault
  // happens well after `initMenu` already ran with no fault, so only the
  // subscription that `src/menu.ts` registers there can show this line.
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    expect(await noteText(page)).toBe("");

    await page.click("#key-toggleMenu");
    expect(await page.getAttribute("#key-toggleMenu", "data-capture")).toBe("on");

    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "K".repeat(3000),
          altKey: true,
          bubbles: true,
        }),
      );
    });

    await waitFor(() => noteText(page), (text) => text.length > 0, "the fault line");
    expect(await noteText(page)).toContain("cookie");
  });
});
