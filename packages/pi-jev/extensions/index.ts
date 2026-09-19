import {
  createBuiltinJevModels,
  JevAuthError,
  type JevModels,
  type Question,
} from "@geminixiang/jev";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/** Preference order: cheapest/most direct backends first, ambient fallbacks last. */
const PROVIDER_ORDER = ["typesafe", "openrouter", "vercel", "cloudflare"] as const;

// state, instructions, and criteria descriptions all accept text or JSON
// structure per the Jev API; `Type.Any` keeps that open while the object root
// stays provider-safe.
const entrySchema = Type.Any({
  description: "Text, or a JSON object or array. Jev reads structure, so labelled keys help.",
});

const questionSchema = Type.Object({
  type: Type.Union([Type.Literal("boolean"), Type.Literal("choice"), Type.Literal("score")], {
    description:
      "boolean: yes/no, answered as a probability 0-1. choice: pick one option from a set; answered with a probability per option and (where the backend reports it) a confidence. score: place the state on an ordered rubric; answered with a score (fractional between levels), a probability per level, and (where reported) a confidence.",
  }),
  instructions: entrySchema,
  criteria: Type.Optional(
    Type.Any({
      description:
        'choice (required): object mapping option id -> description (string, JSON, or null when the id is self-explanatory). score (required): array of level descriptions, lowest first. boolean (optional): {"true": description of yes, "false": description of no}.',
    }),
  ),
});

const jevSchema = Type.Object({
  label: Type.String({ description: "Brief description of the judgment (shown to user)" }),
  state: entrySchema,
  questions: Type.Record(Type.String(), questionSchema, {
    description:
      "Questions keyed by id. Every question is evaluated independently against the same state in one request.",
    minProperties: 1,
  }),
  provider: Type.Optional(
    Type.String({
      description:
        "Force a specific backend (typesafe | openrouter | vercel | cloudflare). Omit to use the first configured one.",
    }),
  ),
});

type QuestionArg = Static<typeof questionSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toJevQuestion(id: string, question: QuestionArg): Question {
  const instructions = question.instructions as Question["instructions"];
  if (question.type === "boolean") {
    if (question.criteria === undefined) return { type: "noul", instructions };
    if (!isRecord(question.criteria)) {
      throw new Error(`Question "${id}" (boolean) criteria must be {"true": …, "false": …}`);
    }
    return {
      type: "noul",
      instructions,
      criteria: question.criteria as {
        true?: Question["instructions"];
        false?: Question["instructions"];
      },
    };
  }
  if (question.type === "choice") {
    if (!isRecord(question.criteria) || Object.keys(question.criteria).length < 2) {
      throw new Error(
        `Question "${id}" (choice) criteria must be an object with at least two options`,
      );
    }
    return { type: "choice", instructions, criteria: question.criteria } as Question;
  }
  if (!Array.isArray(question.criteria) || question.criteria.length < 2) {
    throw new Error(
      `Question "${id}" (score) criteria must be an array of at least two levels, lowest first`,
    );
  }
  const [first, second, ...rest] = question.criteria;
  return { type: "score", instructions, criteria: [first, second, ...rest] };
}

/** First provider with a resolvable credential, in `PROVIDER_ORDER`; throws if none. */
export async function resolveModel(models: JevModels, requested: string | undefined) {
  const order = requested ? [requested] : PROVIDER_ORDER;
  for (const providerId of order) {
    const model = models.getModel(providerId, "jev-latest");
    if (!model) continue;
    if (await models.getAuth(model)) return model;
  }
  const tried = requested ? [requested] : [...PROVIDER_ORDER];
  throw new JevAuthError(
    tried.join(","),
    `No configured Jev backend among [${tried.join(", ")}]. Set one of: TYPESAFE_API_KEY, OPENROUTER_API_KEY, AI_GATEWAY_API_KEY (or VERCEL_API_KEY), CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.`,
  );
}

export default function jevExtension(pi: ExtensionAPI) {
  const models = createBuiltinJevModels();

  pi.registerTool({
    name: "jev",
    label: "jev",
    description: [
      "Ask Jev, a fast calibrated decision model, typed questions about a state. Jev never generates text; it returns probabilities.",
      "state: the material to judge — text, or a JSON object/array (prefer labelled keys). questions: any number of boolean / choice / score questions, all evaluated against that state in one request.",
      "Use it for classification, detection, scoring, ranking, routing, extraction over known candidates, and verification — anywhere you would otherwise judge by eye.",
      "Ask narrow, atomic questions and batch them: to rank N items, ask one score question per item (not one choice over orderings); to verify a summary, ask one boolean per claim.",
      "choice and score answers carry a confidence where the backend reports it; below 0.5 Jev is unsure between options, so say so instead of presenting the top option as settled.",
    ].join(" "),
    promptSnippet: "Ask Jev calibrated boolean/choice/score questions about any state.",
    promptGuidelines: [
      "Use jev when you need to classify, filter, rank, route, or verify something with a calibrated probability instead of a guess.",
      "Never pre-judge items yourself and ask jev to confirm; ask jev the narrow question directly.",
    ],
    parameters: jevSchema,
    executionMode: "parallel",
    async execute(_toolCallId, args, signal) {
      const questions: Record<string, Question> = {};
      for (const [id, question] of Object.entries(args.questions)) {
        questions[id] = toJevQuestion(id, question);
      }
      const model = await resolveModel(models, args.provider);
      const result = await models.evaluate(model, { state: args.state, questions }, { signal });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                answers: result.answers,
                provider: result.provider,
                model: result.model,
                usage: result.usage,
              },
              null,
              2,
            ),
          },
        ],
        details: undefined,
      };
    },
  });
}
