/**
 * The broker and apps code against src/queries.ts without running an indexer, so check
 * every query here: it must parse, every selected field must exist on the entity it is
 * selected from (relations via `<field>_id` or a nested selection), and every where /
 * order_by key must be a real column. A typo would otherwise surface as a runtime
 * GraphQL error in the broker's leaderboard path.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Kind,
  buildSchema,
  getNamedType,
  isObjectType,
  parse,
  type GraphQLObjectType,
  type ObjectValueNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql";
import { describe, expect, it } from "vitest";
import * as Q from "../src/queries.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const schema = buildSchema(
  [
    "scalar BigInt",
    "scalar BigDecimal",
    "directive @derivedFrom(field: String!) on FIELD_DEFINITION",
    "directive @index on FIELD_DEFINITION",
    readFileSync(`${root}schema.graphql`, "utf8"),
    "type Query { _unused: Boolean }",
  ].join("\n"),
);

function entity(name: string): GraphQLObjectType {
  const type = schema.getType(name);
  if (!type || !isObjectType(type)) throw new Error(`no entity ${name}`);
  return type;
}

/** Scalar column, `<relation>_id` column, or relation/derived field. */
function resolveField(type: GraphQLObjectType, name: string) {
  const fields = type.getFields();
  if (fields[name]) return { column: fields[name], nested: getNamedType(fields[name].type) };
  if (name.endsWith("_id")) {
    const relation = fields[name.slice(0, -3)];
    if (relation && isObjectType(getNamedType(relation.type))) return { column: relation, nested: undefined };
  }
  return undefined;
}

const OPERATORS = new Set(["_eq", "_neq", "_gt", "_gte", "_lt", "_lte", "_in", "_nin", "_is_null"]);

function checkFilter(type: GraphQLObjectType, value: ValueNode, path: string, errors: string[]): void {
  const objects: ObjectValueNode[] =
    value.kind === Kind.LIST ? value.values.filter((v): v is ObjectValueNode => v.kind === Kind.OBJECT) : value.kind === Kind.OBJECT ? [value] : [];
  for (const obj of objects) {
    for (const f of obj.fields) {
      const key = f.name.value;
      if (key === "_and" || key === "_or" || key === "_not" || OPERATORS.has(key)) continue;
      if (!resolveField(type, key)) errors.push(`${path}: unknown filter/order column ${type.name}.${key}`);
    }
  }
}

function checkSelection(type: GraphQLObjectType, set: SelectionSetNode, path: string, errors: string[]): void {
  for (const sel of set.selections) {
    if (sel.kind !== Kind.FIELD) continue;
    const name = sel.name.value;
    const resolved = resolveField(type, name);
    if (!resolved) {
      errors.push(`${path}: ${type.name}.${name} does not exist`);
      continue;
    }
    for (const arg of sel.arguments ?? []) {
      if (arg.name.value === "where" || arg.name.value === "order_by") {
        const target = resolved.nested && isObjectType(resolved.nested) ? resolved.nested : type;
        checkFilter(target, arg.value, `${path}.${name}(${arg.name.value})`, errors);
      }
    }
    const nested = resolved.nested;
    if (sel.selectionSet) {
      if (!nested || !isObjectType(nested)) errors.push(`${path}: ${type.name}.${name} is a scalar`);
      else checkSelection(nested, sel.selectionSet, `${path}.${name}`, errors);
    } else if (nested && isObjectType(nested)) {
      errors.push(`${path}: ${type.name}.${name} needs a selection`);
    }
  }
}

function validate(query: string): string[] {
  const doc = parse(query);
  const errors: string[] = [];
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) continue;
      const rootName = sel.name.value.replace(/_by_pk$/, "");
      const type = entity(rootName);
      for (const arg of sel.arguments ?? []) {
        if (arg.name.value === "where" || arg.name.value === "order_by") checkFilter(type, arg.value, rootName, errors);
      }
      if (sel.selectionSet) checkSelection(type, sel.selectionSet, rootName, errors);
    }
  }
  return errors;
}

const queries: Record<string, string> = {
  LEADERBOARD_QUERY: Q.LEADERBOARD_QUERY,
  LEADERBOARD_BY_RATING_QUERY: Q.LEADERBOARD_BY_RATING_QUERY,
  RECENT_JOBS_QUERY: Q.RECENT_JOBS_QUERY,
  RECENT_RATINGS_QUERY: Q.RECENT_RATINGS_QUERY,
  NETWORK_STATS_QUERY: Q.NETWORK_STATS_QUERY,
  PROVIDER_BY_ID_QUERY: Q.PROVIDER_BY_ID_QUERY,
  AGENT_FEEDBACK_QUERY: Q.AGENT_FEEDBACK_QUERY,
  BUYER_JOBS_QUERY: Q.BUYER_JOBS_QUERY,
  OFFERS_BY_ADAPTER_QUERY: Q.OFFERS_BY_ADAPTER_QUERY,
  JOB_BY_ID_QUERY: Q.JOB_BY_ID_QUERY,
  agentFeedbackByKindQuery: Q.agentFeedbackByKindQuery("XORV_VERIFIED"),
};

describe("queries match schema.graphql", () => {
  for (const [name, query] of Object.entries(queries)) {
    it(name, () => {
      expect(validate(query)).toEqual([]);
    });
  }

  it("the validator catches a typo", () => {
    expect(validate("query { Provider { id earnedUSDC agent { nope } } }")).toEqual([
      "Provider: Provider.earnedUSDC does not exist",
      "Provider.agent: Agent.nope does not exist",
    ]);
  });

  it("exports the five named queries with the documented variables", () => {
    const variables = (query: string) => {
      const op = parse(query).definitions[0];
      if (op?.kind !== Kind.OPERATION_DEFINITION) throw new Error("not an operation");
      return { name: op.name?.value, vars: (op.variableDefinitions ?? []).map((v) => v.variable.name.value) };
    };
    expect(Object.fromEntries(Object.entries(Q.QUERIES).map(([key, query]) => [key, variables(query)]))).toEqual({
      leaderboard: { name: "Leaderboard", vars: ["limit"] },
      recentJobs: { name: "RecentJobs", vars: ["limit"] },
      networkStats: { name: "NetworkStats", vars: ["days"] },
      providerById: { name: "ProviderById", vars: ["id", "jobs", "days"] },
      agentFeedback: { name: "AgentFeedback", vars: ["agentId", "limit"] },
    });
  });

  it("splits an agent's feedback by kind, with every kind covered", () => {
    const kinds = [...Q.AGENT_FEEDBACK_QUERY.matchAll(/kind: \{ _eq: "(\w+)" \}/g)].map((m) => m[1]);
    expect(kinds.sort()).toEqual([...Q.FEEDBACK_KINDS].sort());
  });

  it("rejects an unknown feedback kind", () => {
    expect(() => Q.agentFeedbackByKindQuery("SPAM" as Q.FeedbackKind)).toThrow(/unknown feedback kind/);
  });
});

describe("queryIndexer", () => {
  const url = "http://indexer.test/v1/graphql";
  const reply = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("posts the query and returns data", async () => {
    let sent: { query: string; variables: unknown } | undefined;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: { Job: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const data = await Q.queryIndexer<Q.RecentJobsResult>(url, Q.RECENT_JOBS_QUERY, { limit: 5 }, { fetch: fake });
    expect(data.Job).toEqual([]);
    expect(sent?.variables).toEqual({ limit: 5 });
  });

  it("surfaces GraphQL and HTTP errors as IndexerQueryError", async () => {
    await expect(
      Q.queryIndexer(url, "query { x }", {}, { fetch: reply(200, { errors: [{ message: "field not found" }] }) }),
    ).rejects.toThrow(/field not found/);
    await expect(Q.queryIndexer(url, "query { x }", {}, { fetch: reply(503, {}) })).rejects.toMatchObject({
      name: "IndexerQueryError",
      status: 503,
    });
  });

  it("parses numeric columns whether Hasura stringifies them or not", () => {
    expect(Q.toBigInt("123456789012345678901234567890")).toBe(123456789012345678901234567890n);
    expect(Q.toBigInt(2500000)).toBe(2500000n);
    expect(Q.toBigInt(null)).toBe(0n);
    expect(Q.toNumber("0.75")).toBe(0.75);
    expect(Q.toNumber(90)).toBe(90);
    expect(Q.indexerAddress("0xAbC")).toBe("0xabc");
  });
});
