/**
 * The menu, the keybindings, and the layout guard.
 *
 * Three properties matter here. The menu must never change the box of the
 * terminal, because a change of the box gives a second resize frame for one
 * window size. A matched chord must never reach ghostty-web, because a chord
 * that reaches it gives a second path to the socket. The stored state must
 * come back after a reload, because the cookie is the whole store.
 */

import { beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  clientState,
  framesWithTag,
  idle,
  menuState,
  server,
  size,
  waitFor,
  waitForConnected,
  withClient,
} from "./harness";

beforeEach(() => {
  server().reset();
});

/** The text of one chord button. */
async function chordText(page: Page, id: string): Promise<string> {
  return ((await page.textContent(`#key-${id}`)) ?? "").trim();
}

/** The text of the one note line of the menu. */
async function noteText(page: Page): Promise<string> {
  return ((await page.textContent("#menu-note")) ?? "").trim();
}

/** One group of the menu body: its heading and the labels of its rows. */
interface MenuGroup {
  heading: string;
  rows: string[];
}

/**
 * The groups of the menu body, in the order of the screen.
 *
 * `loose` counts the rows that sit in `#menu-body` outside every group. Such
 * a row reads as a member of the group above it, so the count must be zero.
 */
async function menuGroups(page: Page): Promise<{ groups: MenuGroup[]; loose: number }> {
  return page.evaluate(() => {
    const body = document.getElementById("menu-body")!;
    const groups: { heading: string; rows: string[] }[] = [];
    let loose = 0;
    for (const child of Array.from(body.children)) {
      if (child.classList.contains("menu-row")) {
        loose += 1;
        continue;
      }
      if (!child.classList.contains("menu-group")) {
        continue;
      }
      groups.push({
        heading: (child.querySelector(".menu-heading")?.textContent ?? "").trim(),
        rows: Array.from(child.querySelectorAll(":scope > .menu-row")).map((row) =>
          (row.querySelector(".menu-label")?.textContent ?? "").trim(),
        ),
      });
    }
    return { groups, loose };
  });
}

/** The heading of the group that holds the control `id`. */
async function headingOf(page: Page, id: string): Promise<string> {
  return page.evaluate((selector: string) => {
    const control = document.querySelector(selector);
    const group = control?.closest(".menu-group");
    return (group?.querySelector(".menu-heading")?.textContent ?? "").trim();
  }, `#${id}`);
}

test("the menu opens, collapses, and hides", async () => {
  await withClient(async (page) => {
    expect(await menuState(page)).toBe("open");
    expect(await page.isVisible("#menu-body")).toBe(true);
    expect(((await page.textContent("#menu-toggle")) ?? "").trim()).toBe("−");

    await page.click("#menu-toggle");
    expect(await menuState(page)).toBe("collapsed");
    expect(await page.isVisible("#menu-body")).toBe(false);
    expect(await page.isVisible("#menu-status")).toBe(true);
    expect(((await page.textContent("#menu-toggle")) ?? "").trim()).toBe("+");

    await page.click("#menu-toggle");
    expect(await menuState(page)).toBe("open");
    expect(await page.isVisible("#menu-body")).toBe(true);
    expect((await clientState(page)).menu).toBe("open");
  });
});

test("every row sits under the heading that governs it", async () => {
  // The grouping guard. `font size` and `key repeat rate` once sat outside
  // every group, between the theme group and the keys group, so the `theme`
  // heading governed them on the screen. The menu then told the operator that
  // the font size is part of the theme. This test reads the headings and the
  // rows out of the DOM, in the order of the screen, and compares the whole
  // structure.
  await withClient(async (page) => {
    const { groups, loose } = await menuGroups(page);
    // eslint-disable-next-line no-console
    console.log(
      `  menu body: ${groups.map((g) => `${g.heading}[${g.rows.join(", ")}]`).join(" ")}`,
    );

    // A row outside every group takes the heading of the group above it.
    expect(loose).toBe(0);

    expect(groups).toEqual([
      { heading: "theme", rows: ["mode", "import"] },
      { heading: "terminal", rows: ["font size", "key repeat rate"] },
      {
        heading: "keys",
        rows: ["show or hide the menu", "increase the font size", "decrease the font size"],
      },
    ]);

    // The same claim from the other end: each control of the DOM contract
    // sits inside the group of its own heading.
    expect(await headingOf(page, "theme-dark")).toBe("theme");
    expect(await headingOf(page, "theme-light")).toBe("theme");
    expect(await headingOf(page, "theme-import")).toBe("theme");
    expect(await headingOf(page, "font-decrease")).toBe("terminal");
    expect(await headingOf(page, "font-value")).toBe("terminal");
    expect(await headingOf(page, "font-increase")).toBe("terminal");
    expect(await headingOf(page, "repeat-decrease")).toBe("terminal");
    expect(await headingOf(page, "repeat-value")).toBe("terminal");
    expect(await headingOf(page, "repeat-increase")).toBe("terminal");
    expect(await headingOf(page, "key-toggleMenu")).toBe("keys");
    expect(await headingOf(page, "key-fontIncrease")).toBe("keys");
    expect(await headingOf(page, "key-fontDecrease")).toBe("keys");

    // The keys group stays last. A chord list is reference material, not a
    // daily control.
    expect(await page.evaluate(() => document.getElementById("menu-body")!.lastElementChild?.id)).toBe(
      "menu-hint",
    );
    expect(
      await page.evaluate(() => {
        const groupElements = Array.from(document.querySelectorAll("#menu-body > .menu-group"));
        return groupElements[groupElements.length - 1]?.id;
      }),
    ).toBe("menu-keys");
  });
});

test("the hotkey takes the menu off the screen and brings it back", async () => {
  await withClient(async (page) => {
    await page.focus("#terminal");
    await page.keyboard.press("Alt+h");
    await waitFor(() => menuState(page), (state) => state === "hidden", "the hidden menu");
    expect(await page.isVisible("#menu")).toBe(false);

    await page.keyboard.press("Alt+h");
    await waitFor(() => menuState(page), (state) => state === "open", "the menu again");
    expect(await page.isVisible("#menu")).toBe(true);
  });
});

test("the hotkey sends no input frame", async () => {
  // The double-send guard. The registry stops the event in the capture phase,
  // so ghostty-web never encodes it and the client sends no bytes.
  const stub = server();

  await withClient(async (page) => {
    await page.focus("#terminal");

    // One plain key first. It proves that this page does send input frames,
    // so the count below can fall to zero for a real reason.
    const before = framesWithTag(stub.received, 0x00).length;
    await page.keyboard.press("x");
    await waitFor(
      async () => framesWithTag(stub.received, 0x00).length,
      (count) => count === before + 1,
      "the input frame of the plain key",
    );
    const baseline = framesWithTag(stub.received, 0x00).length;

    await page.keyboard.press("Alt+h");
    await waitFor(() => menuState(page), (state) => state === "hidden", "the hidden menu");
    await idle(300);

    const after = framesWithTag(stub.received, 0x00).length;
    // eslint-disable-next-line no-console
    console.log(`  alt+h: input frames ${baseline} → ${after}`);
    expect(after).toBe(baseline);
  });
});

test("a rebound chord takes effect, and the old chord does nothing", async () => {
  await withClient(async (page) => {
    expect(await chordText(page, "toggleMenu")).toBe("alt+h");

    await page.click("#key-toggleMenu");
    expect(await page.getAttribute("#key-toggleMenu", "data-capture")).toBe("on");
    await page.keyboard.press("Alt+j");
    await waitFor(
      () => chordText(page, "toggleMenu"),
      (text) => text === "alt+j",
      "the new chord on the button",
    );
    // The chord comes from `KeyboardEvent.code`, so the stored form is the
    // code and not the character.
    expect((await clientState(page)).keys.toggleMenu).toBe("alt+keyj");

    // The old chord is free now, so the menu must stay where it is.
    await page.keyboard.press("Alt+h");
    await idle(200);
    expect(await menuState(page)).toBe("open");

    await page.keyboard.press("Alt+j");
    await waitFor(() => menuState(page), (state) => state === "hidden", "the new chord");
    await page.keyboard.press("Alt+j");
    await waitFor(() => menuState(page), (state) => state === "open", "the menu again");
  });
});

test("a chord without a modifier is refused, and so is a chord in use", async () => {
  await withClient(async (page) => {
    await page.click("#key-fontIncrease");
    await page.keyboard.press("k");
    await waitFor(() => noteText(page), (text) => text.length > 0, "the reason line");
    expect(await noteText(page)).toContain("Alt");
    expect(await chordText(page, "fontIncrease")).toBe("alt+=");
    expect(await page.getAttribute("#key-fontIncrease", "data-capture")).toBe(null);

    // `alt+keyh` belongs to `toggleMenu`. Two bindings cannot hold one chord.
    await page.click("#key-fontIncrease");
    await page.keyboard.press("Alt+h");
    await waitFor(() => noteText(page), (text) => text.includes("Another"), "the reason line");
    expect(await chordText(page, "fontIncrease")).toBe("alt+=");
    expect((await clientState(page)).keys.fontIncrease).toBe("alt+equal");
    // The refused chord went to no binding, so the menu did not move.
    expect(await menuState(page)).toBe("open");

    // The Escape key cancels the capture and leaves the binding as it was.
    await page.click("#key-fontDecrease");
    expect(await page.getAttribute("#key-fontDecrease", "data-capture")).toBe("on");
    await page.keyboard.press("Escape");
    await waitFor(
      () => chordText(page, "fontDecrease"),
      (text) => text === "alt+-",
      "the chord after the cancel",
    );
    expect(await page.getAttribute("#key-fontDecrease", "data-capture")).toBe(null);
  });
});

test("the menu state and the chords come back after a reload", async () => {
  await withClient(async (page) => {
    await page.click("#key-fontDecrease");
    await page.keyboard.press("Alt+j");
    await waitFor(
      () => chordText(page, "fontDecrease"),
      (text) => text === "alt+j",
      "the new chord",
    );
    await page.click("#menu-toggle");
    expect(await menuState(page)).toBe("collapsed");

    await page.reload();
    await waitForConnected(page);

    expect(await menuState(page)).toBe("collapsed");
    expect(await chordText(page, "fontDecrease")).toBe("alt+j");
    const state = await clientState(page);
    expect(state.menu).toBe("collapsed");
    expect(state.keys.fontDecrease).toBe("alt+keyj");
    // One cookie holds the whole record, and the store writes no other cookie.
    const cookies = await page.context().cookies();
    expect(cookies.map((cookie) => cookie.name)).toEqual(["pirate.prefs"]);
  });
});

test("the store keeps no token, in any form", async () => {
  await withClient(async (page) => {
    // A page that changes nothing writes nothing. One change makes the store
    // write, and the write must reach one cookie and nothing else.
    expect((await page.context().cookies()).length).toBe(0);
    await page.click("#menu-toggle");
    await waitFor(() => menuState(page), (state) => state === "collapsed", "the change");

    const cookies = await page.context().cookies();
    expect(cookies.map((cookie) => cookie.name)).toEqual(["pirate.prefs"]);
    const stored = await page.evaluate(() => ({
      cookie: document.cookie,
      local: localStorage.length,
      session: sessionStorage.length,
    }));
    expect(stored.local).toBe(0);
    expect(stored.session).toBe(0);
    expect(stored.cookie.toLowerCase()).not.toContain("token");
    expect(stored.cookie).toContain("pirate.prefs=");
  });
});

test("the menu changes no box, so it gives no resize frame", async () => {
  // The layout guard. The menu is `position: fixed`. A menu in the flex flow
  // of `body` would change the height of the terminal, the fit would run, and
  // the client would send a resize frame for a change that no window made.
  const stub = server();

  await withClient(async (page) => {
    await waitFor(
      async () => framesWithTag(stub.received, 0x01).length,
      (count) => count >= 1,
      "the first resize frame",
    );
    const debounce = (await clientState(page)).resizeDebounceMs;
    const before = framesWithTag(stub.received, 0x01).length;
    const first = await size(page);

    await page.click("#menu-toggle");
    expect(await menuState(page)).toBe("collapsed");
    await page.click("#menu-toggle");
    expect(await menuState(page)).toBe("open");
    await page.keyboard.press("Alt+h");
    await waitFor(() => menuState(page), (state) => state === "hidden", "the hidden menu");
    await page.keyboard.press("Alt+h");
    await waitFor(() => menuState(page), (state) => state === "open", "the menu again");

    // Wait longer than the debounce, so that a late fit would be counted.
    await idle(debounce + 400);

    const after = framesWithTag(stub.received, 0x01).length;
    const second = await size(page);
    // eslint-disable-next-line no-console
    console.log(
      `  four menu changes: resize frames ${before} → ${after}, ` +
        `terminal ${first.cols}x${first.rows} → ${second.cols}x${second.rows}`,
    );
    expect(after).toBe(before);
    expect(second).toEqual(first);
  });
});
