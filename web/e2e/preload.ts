/**
 * The preload of `bun test`, for both suites.
 *
 * The unit suite needs one browser and one stub server. `web/tests/setup.ts`
 * starts both. The e2e suite starts its own real server, so it sets
 * `PIRATE_E2E` and this file leaves the stub alone.
 */

// The empty export makes this file a module, which the top-level await needs.
export {};

if (process.env.PIRATE_E2E !== "1") {
  await import("../tests/setup");
}
