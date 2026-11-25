import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const PROTOCOL_VERSION = 2 as const;
const strict = { additionalProperties: false } as const;

export const TaskStateSchema = Type.Union([
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("ready"),
  Type.Literal("stopping"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("stopped"),
  Type.Literal("orphaned"),
]);
export type TaskState = Static<typeof TaskStateSchema>;
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "succeeded",
  "failed",
  "stopped",
  "orphaned",
]);

export const ReadinessSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("output"),
      substring: Type.String({ minLength: 1, maxLength: 4096 }),
      stream: Type.Optional(
        Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("both")]),
      ),
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("http"),
      url: Type.String(),
      expectedStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("tcp"),
      host: Type.String(),
      port: Type.Integer({ minimum: 1, maximum: 65535 }),
    },
    strict,
  ),
]);
export type Readiness = Static<typeof ReadinessSchema>;

export const TaskSpecSchema = Type.Object(
  {
    command: Type.String({ minLength: 1 }),
    args: Type.Optional(Type.Array(Type.String(), { maxItems: 10_000 })),
    cwd: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    service: Type.Optional(Type.Boolean()),
    ownerSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    readiness: Type.Optional(ReadinessSchema),
    readinessTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
    runTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400_000 })),
  },
  strict,
);
export type TaskSpec = Static<typeof TaskSpecSchema>;

export interface TaskRecord {
  id: string;
  spec: TaskSpec;
  state: TaskState;
  pid?: number;
  processIdentity?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  terminationReason?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A task as reported to clients. `ports` is observed live rather than stored, since what a
 * process is listening on changes independently of its durable record.
 */
export interface TaskView extends TaskRecord {
  ports?: number[];
}

export interface TaskEvent {
  version: typeof PROTOCOL_VERSION;
  sequence: number;
  timestamp: string;
  taskId: string;
  type: "created" | "state" | "ready" | "output" | "terminal";
  data: Record<string, unknown>;
}

const allowed: Record<TaskState, ReadonlySet<TaskState>> = {
  starting: new Set(["running", "ready", "stopping", "succeeded", "failed", "stopped", "orphaned"]),
  running: new Set(["ready", "stopping", "succeeded", "failed", "stopped", "orphaned"]),
  ready: new Set(["stopping", "succeeded", "failed", "stopped", "orphaned"]),
  stopping: new Set(["succeeded", "failed", "stopped", "orphaned"]),
  succeeded: new Set(),
  failed: new Set(),
  stopped: new Set(),
  orphaned: new Set(),
};
export function assertTransition(from: TaskState, to: TaskState): void {
  if (!allowed[from].has(to)) throw new Error(`Invalid task transition: ${from} -> ${to}`);
}

interface ObjectSchema {
  properties?: Record<string, unknown>;
  additionalProperties?: boolean;
}

/** Property names present in `value` that the schema does not declare. */
function unexpectedKeys(schema: ObjectSchema, value: unknown): string[] {
  if (!schema.properties || !value || typeof value !== "object" || Array.isArray(value)) return [];
  const known = new Set(Object.keys(schema.properties));
  return Object.keys(value).filter((key) => !known.has(key));
}

/**
 * Explains why `value` failed `schema`.
 *
 * TypeBox reports an `additionalProperties` violation as a bare "must not have additional
 * properties" with no path and no value, which leaves a caller — especially an agent
 * composing a request — with no way to tell which property was rejected. So the offending
 * names are computed and the accepted ones listed alongside them.
 */
function explain(schema: ObjectSchema, value: unknown, nested?: [string, ObjectSchema]): string {
  const unexpected = unexpectedKeys(schema, value);
  const [field, inner] = nested ?? [];
  const innerValue =
    field && value && typeof value === "object"
      ? (value as Record<string, unknown>)[field]
      : undefined;
  const innerUnexpected = inner ? unexpectedKeys(inner, innerValue) : [];
  const parts: string[] = [];
  if (unexpected.length)
    parts.push(
      `unexpected ${unexpected.length > 1 ? "properties" : "property"} ${unexpected.map((k) => `"${k}"`).join(", ")}; accepted: ${Object.keys(schema.properties ?? {}).join(", ")}`,
    );
  if (innerUnexpected.length)
    parts.push(
      `unexpected ${innerUnexpected.length > 1 ? "properties" : "property"} ${innerUnexpected.map((k) => `"${field}.${k}"`).join(", ")}; accepted: ${Object.keys(
        inner!.properties ?? {},
      )
        .map((k) => `${field}.${k}`)
        .join(", ")}`,
    );
  return parts.join("; ");
}

export function parseTaskSpec(value: unknown): TaskSpec {
  if (!Value.Check(TaskSpecSchema, value)) {
    const detail = explain(TaskSpecSchema as ObjectSchema, value);
    const first = Value.Errors(TaskSpecSchema, value)[0];
    throw new Error(
      `Invalid task spec${detail ? `: ${detail}` : first ? `: ${first.message}` : ""}`,
    );
  }
  return value;
}

const envelope = {
  version: Type.Literal(PROTOCOL_VERSION),
  id: Type.String({ minLength: 1, maxLength: 256 }),
};
const taskId = Type.String({ minLength: 1, maxLength: 256 });
const timeout = Type.Integer({ minimum: 1, maximum: 3_600_000 });
const RequestSchema = Type.Union([
  Type.Object({ ...envelope, method: Type.Literal("ping") }, strict),
  Type.Object({ ...envelope, method: Type.Literal("start"), params: TaskSpecSchema }, strict),
  Type.Object({ ...envelope, method: Type.Literal("list") }, strict),
  Type.Object(
    { ...envelope, method: Type.Literal("get"), params: Type.Object({ taskId }, strict) },
    strict,
  ),
  Type.Object(
    {
      ...envelope,
      method: Type.Literal("output"),
      params: Type.Object(
        {
          taskId,
          stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr")])),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_048_576 })),
          tail: Type.Optional(Type.Boolean()),
        },
        strict,
      ),
    },
    strict,
  ),
  Type.Object(
    {
      ...envelope,
      method: Type.Literal("wait"),
      params: Type.Object({ taskId, timeoutMs: Type.Optional(timeout) }, strict),
    },
    strict,
  ),
  Type.Object(
    {
      ...envelope,
      method: Type.Literal("stop"),
      params: Type.Object({ taskId, timeoutMs: Type.Optional(timeout) }, strict),
    },
    strict,
  ),
  Type.Object(
    {
      ...envelope,
      method: Type.Literal("stopOwner"),
      params: Type.Object(
        {
          ownerSessionId: Type.String({ minLength: 1, maxLength: 256 }),
          timeoutMs: Type.Optional(timeout),
        },
        strict,
      ),
    },
    strict,
  ),
  Type.Object(
    {
      ...envelope,
      method: Type.Literal("events"),
      params: Type.Object(
        {
          cursor: Type.String({ minLength: 1, maxLength: 256 }),
          after: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        },
        strict,
      ),
    },
    strict,
  ),
  Type.Object(
    {
      ...envelope,
      method: Type.Literal("ack"),
      params: Type.Object(
        {
          cursor: Type.String({ minLength: 1, maxLength: 256 }),
          sequence: Type.Integer({ minimum: 0 }),
        },
        strict,
      ),
    },
    strict,
  ),
]);
export type Request = Static<typeof RequestSchema>;
export type Response =
  | { version: typeof PROTOCOL_VERSION; id: string; ok: true; result: unknown }
  | { version: typeof PROTOCOL_VERSION; id: string; ok: false; error: string };

export function parseRequest(value: unknown): Request {
  if (!Value.Check(RequestSchema, value)) {
    const method =
      value && typeof value === "object" ? (value as Record<string, unknown>).method : undefined;
    if (
      typeof method === "string" &&
      ![
        "ping",
        "start",
        "list",
        "get",
        "output",
        "wait",
        "stop",
        "stopOwner",
        "events",
        "ack",
      ].includes(method)
    )
      throw new Error(`Unknown method: ${method}`);
    // Locate the branch this request was aiming at so the failure can name a property
    // rather than reporting the union's generic rejection.
    const branch = (RequestSchema.anyOf as ObjectSchema[] | undefined)?.find(
      (candidate) =>
        (candidate.properties?.method as { const?: unknown } | undefined)?.const === method,
    );
    const detail = branch
      ? explain(branch, value, ["params", branch.properties?.params as ObjectSchema])
      : "";
    const first = Value.Errors(RequestSchema, value)[0];
    throw new Error(`Invalid request${detail ? `: ${detail}` : first ? `: ${first.message}` : ""}`);
  }
  return value;
}

export function isRequest(value: unknown): value is Request {
  return Value.Check(RequestSchema, value);
}
