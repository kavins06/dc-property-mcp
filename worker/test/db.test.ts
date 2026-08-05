import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callApi,
  chunkSourceRefs,
  collectSourceRefs,
  mergeSourceEvidence,
  sanitizeDatabaseError,
} from "../src/db";
import type { Env } from "../src/types";

const { client, connect, query, end } = vi.hoisted(() => {
  const connect = vi.fn();
  const query = vi.fn();
  const end = vi.fn();
  const client = vi.fn(function MockClient() {
    return { connect, query, end };
  });
  return { client, connect, query, end };
});

vi.mock("pg/lib/client.js", () => ({ default: client }));

const env = { HYPERDRIVE: { connectionString: "postgres://test" } } as Env;

afterEach(() => {
  connect.mockReset();
  query.mockReset();
  end.mockReset();
});

describe("database error boundary", () => {
  it("maps PostgreSQL cancellation to a safe, actionable timeout error", () => {
    const result = sanitizeDatabaseError({
      code: "57014",
      message: "canceling statement due to statement timeout",
      query: "select secret_schema.private_function($1)",
    });

    expect(result).toEqual({
      status: "error",
      error: {
        code: "query_timeout",
        hint: "Try the SSL, or shorten the address to street number, street name, and quadrant.",
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("statement");
    expect(JSON.stringify(result)).not.toContain("secret_schema");
  });

  it("never returns driver, SQL, credential, or host details", () => {
    const result = sanitizeDatabaseError(
      new Error(
        "password authentication failed for postgres at db.example.supabase.co",
      ),
    );

    expect(result.status).toBe("error");
    expect(result.error.code).toBe("database_unavailable");
    expect(JSON.stringify(result)).not.toContain("password");
    expect(JSON.stringify(result)).not.toContain("supabase");
  });
});

describe("source enrichment helpers", () => {
  it("recursively collects first-seen source references", () => {
    expect(
      collectSourceRefs({
        source_refs: ["one", "two", "one", ""],
        nested: [{ value: { source_refs: ["three", "two"] } }],
      }),
    ).toEqual(["one", "two", "three"]);
  });

  it("deduplicates evidence and merges source details by stable route identity", () => {
    const first = { source_ref: "one", value: 1 };
    const duplicate = { value: 99, source_ref: "one" };
    const source = {
      link: "https://example.com",
      title: "Verify",
      covers: ["Assessment"],
      covered_fields: ["assessment.current"],
      source_refs: ["one"],
    };

    expect(
      mergeSourceEvidence([
        { evidence: [first], sources: [source] },
        {
          evidence: [duplicate, { source_ref: "two", value: 2 }],
          sources: [
            {
              title: "Verify",
              link: "https://example.com",
              covers: ["Tax", "Assessment"],
              covered_fields: ["tax.current"],
              source_refs: ["two"],
            },
          ],
        },
      ]),
    ).toEqual({
      provenance: [first, { source_ref: "two", value: 2 }],
      sources: [
        {
          ...source,
          covers: ["Assessment", "Tax"],
          covered_fields: ["assessment.current", "tax.current"],
          source_refs: ["one", "two"],
        },
      ],
    });
  });

  it("batches evidence references in groups of at most 50", () => {
    const refs = Array.from({ length: 101 }, (_, index) => `ref-${index}`);
    expect(chunkSourceRefs(refs)).toEqual([
      refs.slice(0, 50),
      refs.slice(50, 100),
      refs.slice(100),
    ]);
  });
});

describe("source enrichment database boundary", () => {
  it("uses the original session for 50-ref evidence batches", async () => {
    const refs = Array.from({ length: 51 }, (_, index) => `ref-${index}`);
    const payload = { status: "ok", nested: { source_refs: refs } };
    connect.mockResolvedValue(undefined);
    end.mockResolvedValue(undefined);
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ result: payload }] })
      .mockResolvedValueOnce({
        rows: [
          {
            result: {
              status: "ok",
              evidence: [{ source_ref: "ref-0" }],
              sources: [
                {
                  link: "https://one.example",
                  covers: ["Assessment"],
                  source_refs: ["ref-0"],
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            result: {
              status: "ok",
              evidence: [{ source_ref: "ref-50" }],
              sources: [
                {
                  link: "https://one.example",
                  covers: ["Tax"],
                  source_refs: ["ref-50"],
                },
              ],
            },
          },
        ],
      });

    await expect(callApi(env, "get_property_snapshot", [])).resolves.toEqual({
      ...payload,
      provenance: [{ source_ref: "ref-0" }, { source_ref: "ref-50" }],
      sources: [
        {
          link: "https://one.example",
          covers: ["Assessment", "Tax"],
          source_refs: ["ref-0", "ref-50"],
        },
      ],
    });
    expect(client).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[2]?.[1]).toEqual([refs.slice(0, 50)]);
    expect(query.mock.calls[3]?.[1]).toEqual([refs.slice(50)]);
  });

  it.each([
    [
      "get_source_evidence",
      { status: "ok", source_refs: ["ref"], evidence: [], sources: [] },
    ],
    ["get_property_snapshot", { status: "error", error: { code: "x" } }],
    ["get_property_snapshot", { status: "service_unavailable" }],
    ["get_property_snapshot", { status: "invalid_input", source_refs: ["ref"] }],
    ["get_property_snapshot", { status: "ok", source_refs: [] }],
  ])("skips enrichment for %s and non-normal results", async (name, result) => {
    connect.mockResolvedValue(undefined);
    end.mockResolvedValue(undefined);
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ result }] });

    await expect(callApi(env, name, [])).resolves.toEqual(result);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("fails closed when expansion fails or returns a non-ok result", async () => {
    connect.mockResolvedValue(undefined);
    end.mockResolvedValue(undefined);
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ result: { status: "ok", source_refs: ["ref"] } }],
      })
      .mockResolvedValueOnce({
        rows: [{ result: { status: "invalid_input" } }],
      });

    await expect(callApi(env, "get_property_snapshot", [])).resolves.toEqual({
      status: "error",
      error: {
        code: "provenance_unavailable",
        hint: "Source verification is temporarily unavailable. Retry shortly.",
        retryable: true,
      },
    });
  });

  it("fails closed when evidence expansion throws", async () => {
    connect.mockResolvedValue(undefined);
    end.mockResolvedValue(undefined);
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ result: { status: "ok", source_refs: ["ref"] } }],
      })
      .mockRejectedValueOnce(new Error("database detail"));

    await expect(callApi(env, "get_property_snapshot", [])).resolves.toMatchObject({
      status: "error",
      error: { code: "provenance_unavailable" },
    });
  });
});
