import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, assertTransition, parseRequest, parseTaskSpec } from "../src/index.ts";

test("accepts lifecycle transitions and rejects terminal transitions", () => {
  assert.doesNotThrow(() => assertTransition("starting", "running"));
  assert.doesNotThrow(() => assertTransition("running", "ready"));
  assert.throws(() => assertTransition("succeeded", "running"), /Invalid task transition/);
});

test("validates task specifications without persisting environment secrets", () => {
  assert.deepEqual(parseTaskSpec({ command: "node", cwd: "/tmp" }), {
    command: "node",
    cwd: "/tmp",
  });
  assert.throws(() => parseTaskSpec({ command: "", cwd: "/tmp" }), /Invalid task spec/);
  assert.throws(
    () => parseTaskSpec({ command: "node", cwd: "/tmp", env: { TOKEN: "secret" } }),
    /Invalid task spec/,
  );
  assert.throws(
    () =>
      parseTaskSpec({ command: "node", cwd: "/tmp", readiness: { type: "output", pattern: ".*" } }),
    /Invalid task spec/,
  );
});

test("names the rejected property so a caller can correct itself", () => {
  // TypeBox reports additionalProperties as a bare message with no path, which left a
  // caller unable to tell which property was at fault.
  assert.throws(
    () => parseTaskSpec({ command: "node", cwd: "/tmp", env: { TOKEN: "secret" } }),
    /unexpected property "env"; accepted: command, args, cwd, name, /,
  );
  assert.throws(
    () => parseTaskSpec({ command: "node", cwd: "/tmp", env: {}, shell: true }),
    /unexpected properties "env", "shell"/,
  );
  // The offending name is qualified with the field it sits under.
  assert.throws(
    () =>
      parseRequest({
        version: PROTOCOL_VERSION,
        id: "1",
        method: "start",
        params: { command: "node", cwd: "/tmp", env: {} },
      }),
    /unexpected property "params\.env"; accepted: params\.command, /,
  );
  assert.throws(
    () =>
      parseRequest({
        version: PROTOCOL_VERSION,
        id: "1",
        method: "output",
        params: { taskId: "t", follow: true },
      }),
    /unexpected property "params\.follow"; accepted: params\.taskId, params\.stream, /,
  );
  assert.throws(
    () => parseRequest({ version: PROTOCOL_VERSION, id: "1", method: "list", extra: 1 }),
    /unexpected property "extra"; accepted: version, id, method/,
  );
  // A value that is merely invalid still reports why, rather than being mislabelled.
  assert.throws(() => parseTaskSpec({ command: "", cwd: "/tmp" }), /fewer than 1 characters/);
});

test("fully validates requests and reports unknown methods", () => {
  assert.equal(parseRequest({ version: PROTOCOL_VERSION, id: "1", method: "ping" }).method, "ping");
  assert.throws(
    () => parseRequest({ version: PROTOCOL_VERSION, id: "1", method: "get", params: {} }),
    /Invalid request/,
  );
  assert.throws(
    () => parseRequest({ version: PROTOCOL_VERSION, id: "1", method: "ping", extra: true }),
    /Invalid request/,
  );
  assert.throws(
    () => parseRequest({ version: PROTOCOL_VERSION, id: "1", method: "explode" }),
    /Unknown method: explode/,
  );
});
