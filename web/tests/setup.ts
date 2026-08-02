/**
 * Global setup for `bun test`.
 *
 * `bunfig.toml` preloads this file. A hook in a preloaded file runs once for
 * the whole run: `beforeAll` before the first test file, and `afterAll` after
 * the last one.
 *
 * One browser and one stub server serve every test file. An earlier version
 * started and stopped them for each file, and the stub then stopped answering
 * after a few files.
 */

import { afterAll, beforeAll } from "bun:test";
import { start, stop } from "./harness";

beforeAll(start);
afterAll(stop);
