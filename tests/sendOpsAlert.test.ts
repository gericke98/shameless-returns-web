import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `sendOpsAlert` decides whether an outbox row is delivered, so "accepted" has
// to mean accepted: HTTP 2xx with ErrorCode 0. Anything else stays pending.

const post = vi.fn();
vi.mock("axios", () => ({ default: { post: (...args: unknown[]) => post(...args) } }));

beforeEach(() => {
  post.mockReset();
  process.env.POSTMARK_SERVER_TOKEN = "token";
});
afterEach(() => {
  delete process.env.POSTMARK_SERVER_TOKEN;
});

describe("sendOpsAlert", () => {
  it("is ok on a 200 with ErrorCode 0", async () => {
    post.mockResolvedValue({ status: 200, data: { ErrorCode: 0, MessageID: "m1" } });
    const { sendOpsAlert } = await import("@/lib/server/opsAlert");

    await expect(sendOpsAlert("s", "b")).resolves.toEqual({ ok: true });
  });

  it("is not ok on a 2xx carrying a non-zero ErrorCode", async () => {
    post.mockResolvedValue({ status: 200, data: { ErrorCode: 406, Message: "Inactive recipient" } });
    const { sendOpsAlert } = await import("@/lib/server/opsAlert");

    const result = await sendOpsAlert("s", "b");

    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    expect(!result.ok && result.error).toContain("406");
  });

  it("is not ok, and does not throw, when Postmark errors", async () => {
    post.mockRejectedValue(Object.assign(new Error("x"), { response: { data: { ErrorCode: 500, Message: "down" } } }));
    const { sendOpsAlert } = await import("@/lib/server/opsAlert");

    const result = await sendOpsAlert("s", "b");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("down");
  });

  it("is a typed not-configured failure when no token is configured, and sends nothing", async () => {
    delete process.env.POSTMARK_SERVER_TOKEN;
    const { sendOpsAlert } = await import("@/lib/server/opsAlert");

    const result = await sendOpsAlert("s", "b");

    expect(result).toEqual({
      ok: false,
      reason: "not-configured",
      error: expect.stringContaining("Postmark not configured in this environment"),
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("alertOps without Postmark says so instead of returning in silence", async () => {
    delete process.env.POSTMARK_SERVER_TOKEN;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { alertOps } = await import("@/lib/server/opsAlert");

    await expect(alertOps("s", "b")).resolves.toBeUndefined();

    expect(post).not.toHaveBeenCalled();
    expect(errors.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("not-configured");
    errors.mockRestore();
  });

  it("alertOps keeps its contract: resolves, never throws, on failure", async () => {
    post.mockRejectedValue(new Error("timeout"));
    const { alertOps } = await import("@/lib/server/opsAlert");

    await expect(alertOps("s", "b")).resolves.toBeUndefined();
  });
});
