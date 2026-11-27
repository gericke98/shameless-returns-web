import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A self-return email links to this deployment's portal. Without the app's
// URL that link would be "" — a broken email — so it is not sent, and says why.

const post = vi.fn();
vi.mock("axios", () => ({ default: { post: (...args: unknown[]) => post(...args) } }));

const saved = { ...process.env };
beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ status: 200, data: { ErrorCode: 0 } });
  process.env.POSTMARK_SERVER_TOKEN = "token";
  process.env.NEXT_PUBLIC_APP_URL = "https://returns.test";
});
afterEach(() => {
  process.env = { ...saved };
});

describe("self-return emails", () => {
  it("are sent with the portal URL when it is configured", async () => {
    const { sendSelfReturnInstructions } = await import("@/lib/server/selfReturnEmails");

    expect(await sendSelfReturnInstructions("c@example.com", "Ana", "es", "123")).toBe(200);
    expect(JSON.stringify(post.mock.calls[0][1])).toContain("https://returns.test");
  });

  it("refuse, logged and reported as failed, without the app URL — never a link to nowhere", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { sendSelfReturnInstructions, sendSelfReturnReminder, sendSelfTrackingRejected } = await import(
        "@/lib/server/selfReturnEmails"
      );

      expect(await sendSelfReturnInstructions("c@example.com", "Ana", "es", "123")).toBe(500);
      expect(await sendSelfReturnReminder("c@example.com", "Ana", "es", "123")).toBe(500);
      expect(await sendSelfTrackingRejected("c@example.com", "Ana", "es", "123", "PQ1")).toBe(500);
      expect(post).not.toHaveBeenCalled();
      expect(errors.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("missing NEXT_PUBLIC_APP_URL");
    } finally {
      errors.mockRestore();
    }
  });
});
