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
import { beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";
import { clientState, server, waitFor, waitForConnected, withClient } from "./harness";

beforeEach(() => {
  server().reset();
});

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

/*
 * The line height field of the record.
 *
 * The field holds a multiplier of 1.0 to 2.0, on a step of 0.1. A cookie
 * that carries no value, a faulty value, or a value out of the range must
 * restore 1.0. Each test writes one cookie, reloads, and reads the state.
 */

/** Write `record` to the one cookie, reload, and wait for the socket. */
async function reloadWithRecord(page: Page, record: Record<string, unknown>): Promise<void> {
  await page.evaluate((text: string) => {
    document.cookie = `pirate.prefs=${text}; path=/; max-age=31536000; samesite=lax`;
  }, encodeURIComponent(JSON.stringify(record)));
  await page.reload();
  await waitForConnected(page);
}

/*
 * `fontSize` 16 is the control of each test below. The default is 14, so a
 * state that holds 16 proves that the client read this cookie. Without that
 * control, a `lineHeight` of 1.0 can also come from a cookie that the client
 * ignored.
 */

test("a stored line height on the step loads as it is", async () => {
  await withClient(async (page) => {
    await reloadWithRecord(page, { fontSize: 16, lineHeight: 1.5 });
    const state = await clientState(page);
    expect(state.fontSize).toBe(16);
    expect(state.lineHeight).toBe(1.5);
    expect(((await page.textContent("#line-height-value")) ?? "").trim()).toBe("1.5");
  });
});

test("a cookie with no line height restores 1.0", async () => {
  await withClient(async (page) => {
    await reloadWithRecord(page, { fontSize: 16 });
    const state = await clientState(page);
    expect(state.fontSize).toBe(16);
    expect(state.lineHeight).toBe(1.0);
  });
});

test("a faulty line height restores 1.0", async () => {
  await withClient(async (page) => {
    for (const faulty of ["1.5", null, {}, Number.NaN]) {
      await reloadWithRecord(page, { fontSize: 16, lineHeight: faulty });
      const state = await clientState(page);
      expect(state.fontSize).toBe(16);
      expect(state.lineHeight).toBe(1.0);
    }
  });
});

test("a line height out of the range restores 1.0", async () => {
  await withClient(async (page) => {
    for (const value of [0.9, 0, -1, 2.1, 5, 1e9]) {
      await reloadWithRecord(page, { fontSize: 16, lineHeight: value });
      const state = await clientState(page);
      expect(state.fontSize).toBe(16);
      expect(state.lineHeight).toBe(1.0);
      expect(((await page.textContent("#line-height-value")) ?? "").trim()).toBe("1.0");
    }
  });
});

test("the line height goes to the one cookie, and the menu shows no fault", async () => {
  await withClient(async (page) => {
    await page.click("#line-height-increase");
    await waitFor(
      () => clientState(page).then((s) => s.lineHeight),
      (value) => value === 1.1,
      "the line height after one press",
    );

    const cookies = await page.context().cookies();
    expect(cookies.map((cookie) => cookie.name)).toEqual(["pirate.prefs"]);
    const record = JSON.parse(decodeURIComponent(cookies[0].value)) as { lineHeight: number };
    expect(record.lineHeight).toBe(1.1);
    expect(await noteText(page)).toBe("");
  });
});

/*
 * The whole-number fields, against the step argument of `readNumber`.
 *
 * `fontSize` and `repeatRate` call `readNumber` with four arguments, so both
 * take the default step of 1. This test pins the rounding of both fields at
 * the half, at the two limits, and outside the range. It passes at the
 * parent commit and at this commit, because the step argument changes the
 * behavior of neither caller.
 */
test("the font size and the repeat rate keep their whole-number rounding", async () => {
  const cases: { stored: Record<string, number>; fontSize: number; repeatRate: number }[] = [
    // A half rounds up.
    { stored: { fontSize: 15.5, repeatRate: 11.5 }, fontSize: 16, repeatRate: 12 },
    // Less than a half rounds down.
    { stored: { fontSize: 15.4, repeatRate: 11.4 }, fontSize: 15, repeatRate: 11 },
    // A value under the low limit rounds into the range.
    { stored: { fontSize: 7.6, repeatRate: 1.6 }, fontSize: 8, repeatRate: 2 },
    // A value over the high limit rounds into the range.
    { stored: { fontSize: 32.4, repeatRate: 30.4 }, fontSize: 32, repeatRate: 30 },
    // A rounded value outside the range takes the default: 14 and 10.
    { stored: { fontSize: 32.6, repeatRate: 30.6 }, fontSize: 14, repeatRate: 10 },
    { stored: { fontSize: 7.4, repeatRate: 1.4 }, fontSize: 14, repeatRate: 10 },
  ];

  await withClient(async (page) => {
    for (const item of cases) {
      await reloadWithRecord(page, item.stored);
      const state = await clientState(page);
      expect({ fontSize: state.fontSize, repeatRate: state.repeatRate }).toEqual({
        fontSize: item.fontSize,
        repeatRate: item.repeatRate,
      });
    }
  });
});
