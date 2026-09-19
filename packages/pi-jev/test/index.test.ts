import assert from "node:assert/strict";
import test from "node:test";
import {
  createJevModels,
  createJevProvider,
  JevAuthError,
  type JevProvider,
} from "@geminixiang/jev";
import { resolveModel, toJevQuestion } from "../extensions/index.ts";

test("toJevQuestion: boolean without criteria", () => {
  const q = toJevQuestion("q", { type: "boolean", instructions: "is it urgent?" });
  assert.deepEqual(q, { type: "noul", instructions: "is it urgent?" });
});

test("toJevQuestion: boolean with criteria", () => {
  const q = toJevQuestion("q", {
    type: "boolean",
    instructions: "urgent?",
    criteria: { true: "yes", false: "no" },
  });
  assert.deepEqual(q, {
    type: "noul",
    instructions: "urgent?",
    criteria: { true: "yes", false: "no" },
  });
});

test("toJevQuestion: boolean rejects non-object criteria", () => {
  assert.throws(
    () => toJevQuestion("q", { type: "boolean", instructions: "?", criteria: ["nope"] as never }),
    /criteria must be \{"true": …, "false": …\}/,
  );
});

test("toJevQuestion: choice needs at least two options", () => {
  assert.throws(
    () => toJevQuestion("q", { type: "choice", instructions: "?", criteria: { only: null } }),
    /at least two options/,
  );
  const q = toJevQuestion("q", {
    type: "choice",
    instructions: "team?",
    criteria: { billing: "money", tech: "bugs" },
  });
  assert.deepEqual(q, {
    type: "choice",
    instructions: "team?",
    criteria: { billing: "money", tech: "bugs" },
  });
});

test("toJevQuestion: score needs at least two levels, lowest first", () => {
  assert.throws(
    () => toJevQuestion("q", { type: "score", instructions: "?", criteria: ["only"] }),
    /at least two levels/,
  );
  const q = toJevQuestion("q", {
    type: "score",
    instructions: "severity",
    criteria: ["low", "mid", "high"],
  });
  assert.deepEqual(q, {
    type: "score",
    instructions: "severity",
    criteria: ["low", "mid", "high"],
  });
});

function fakeProvider(id: string, configured: boolean): JevProvider {
  return createJevProvider({
    id,
    auth: {
      apiKey: {
        name: id,
        resolve: async () => (configured ? { auth: { apiKey: "k" } } : undefined),
      },
    },
    models: [
      {
        id: "jev-latest",
        name: id,
        api: "fake",
        provider: id,
        baseUrl: "http://x",
        slug: "jev-latest",
        cost: { input: 0, output: 0 },
      },
    ],
    api: {
      api: "fake",
      evaluate: async () => ({
        provider: id,
        model: "jev-latest",
        answers: {},
        usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
        raw: null,
      }),
    },
  });
}

test("resolveModel: picks the first configured provider in preference order", async () => {
  const models = createJevModels();
  models.setProvider(fakeProvider("typesafe", false));
  models.setProvider(fakeProvider("openrouter", true));
  models.setProvider(fakeProvider("vercel", true));
  const model = await resolveModel(models, undefined);
  assert.equal(model.provider, "openrouter");
});

test("resolveModel: honors an explicit provider override", async () => {
  const models = createJevModels();
  models.setProvider(fakeProvider("typesafe", true));
  models.setProvider(fakeProvider("vercel", true));
  const model = await resolveModel(models, "vercel");
  assert.equal(model.provider, "vercel");
});

test("resolveModel: throws JevAuthError naming the missing backends", async () => {
  const models = createJevModels();
  models.setProvider(fakeProvider("typesafe", false));
  await assert.rejects(resolveModel(models, undefined), (error: unknown) => {
    assert.ok(error instanceof JevAuthError);
    assert.match((error as Error).message, /TYPESAFE_API_KEY/);
    return true;
  });
});
