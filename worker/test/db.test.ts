import { describe, expect, it } from "vitest";
import { sanitizeDatabaseError } from "../src/db";

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
