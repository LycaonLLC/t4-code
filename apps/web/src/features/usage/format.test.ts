// Format helpers are the only layer between the sanitized usage snapshot and
// the panel DOM: these tests pin the exact strings for every rounding and
// threshold branch so copy drift fails loudly.
import { describe, expect, it } from "vite-plus/test";

import {
  ageLabel,
  capacityLabel,
  formatDuration,
  limitDisplayName,
  reportIdentityDetail,
  resetLabel,
  savedResetLabel,
  usageAmountLabel,
} from "./format.ts";
import type { UsageLimit, UsageReport } from "./model.ts";

const NOW = Date.parse("2026-07-19T00:00:00.000Z");

function limit(overrides: {
  readonly label?: string;
  readonly scope?: UsageLimit["scope"];
  readonly window?: UsageLimit["window"];
  readonly amount: UsageLimit["amount"];
}): UsageLimit {
  return {
    id: "l1",
    label: overrides.label ?? "Usage",
    scope: overrides.scope ?? { provider: "test" },
    ...(overrides.window === undefined ? {} : { window: overrides.window }),
    amount: overrides.amount,
  };
}

function report(resetCredits?: UsageReport["resetCredits"]): UsageReport {
  return {
    provider: "test",
    fetchedAt: NOW,
    limits: [],
    identity: {},
    ...(resetCredits === undefined ? {} : { resetCredits }),
  };
}

describe("formatDuration", () => {
  it("labels sub-five-second spans as a few seconds", () => {
    expect(formatDuration(0)).toBe("a few seconds");
    expect(formatDuration(4_000)).toBe("a few seconds");
  });

  it("clamps negative spans to a few seconds", () => {
    expect(formatDuration(-1_000)).toBe("a few seconds");
  });

  it("switches to plural seconds at five seconds", () => {
    expect(formatDuration(5_000)).toBe("5 seconds");
    expect(formatDuration(59_000)).toBe("59 seconds");
  });

  it("rounds to minutes at one minute", () => {
    expect(formatDuration(60_000)).toBe("1 minute");
    expect(formatDuration(90_000)).toBe("2 minutes");
    expect(formatDuration(3_540_000)).toBe("59 minutes");
  });

  it("rounds to hours at one hour", () => {
    expect(formatDuration(3_600_000)).toBe("1 hour");
    expect(formatDuration(5_400_000)).toBe("2 hours");
    expect(formatDuration(86_400_000)).toBe("24 hours");
  });

  it("stays in hours through 47 and rounds to days at 48", () => {
    expect(formatDuration(47 * 3_600_000)).toBe("47 hours");
    expect(formatDuration(48 * 3_600_000)).toBe("2 days");
    expect(formatDuration(5 * 86_400_000)).toBe("5 days");
  });
});

describe("ageLabel", () => {
  it("labels timestamps more than five seconds in the future as upcoming", () => {
    expect(ageLabel(NOW + 10_000, NOW)).toBe("in 10 seconds");
  });

  it("treats anything within five seconds either way as just now", () => {
    expect(ageLabel(NOW + 5_000, NOW)).toBe("just now");
    expect(ageLabel(NOW, NOW)).toBe("just now");
    expect(ageLabel(NOW - 4_999, NOW)).toBe("just now");
  });

  it("labels older timestamps as a past duration", () => {
    expect(ageLabel(NOW - 5_000, NOW)).toBe("5 seconds ago");
    expect(ageLabel(NOW - 90_000, NOW)).toBe("2 minutes ago");
    expect(ageLabel(NOW - 48 * 3_600_000, NOW)).toBe("2 days ago");
  });
});

describe("usageAmountLabel", () => {
  it("combines used-of-limit with the resolved percent", () => {
    const label = usageAmountLabel(
      limit({ amount: { used: 250_000, limit: 1_000_000, unit: "tokens" } }),
    );
    expect(label).toBe("250K of 1M tokens · 25.0% used");
  });

  it("suffixes request and minute units", () => {
    expect(
      usageAmountLabel(limit({ amount: { used: 3, limit: 5, unit: "requests" } })),
    ).toBe("3 of 5 requests · 60.0% used");
    expect(usageAmountLabel(limit({ amount: { remaining: 512, unit: "minutes" } }))).toBe(
      "512 min left",
    );
  });

  it("formats USD amounts with two decimals", () => {
    expect(
      usageAmountLabel(limit({ amount: { used: 12.5, limit: 50, unit: "usd" } })),
    ).toBe("$12.50 of $50.00 · 25.0% used");
  });

  it("formats bytes at the GiB/MiB/KiB/B thresholds", () => {
    expect(
      usageAmountLabel(limit({ amount: { remaining: 1_073_741_824, unit: "bytes" } })),
    ).toBe("1 GiB left");
    expect(
      usageAmountLabel(limit({ amount: { remaining: 1_073_741_823, unit: "bytes" } })),
    ).toBe("1,024 MiB left");
    expect(
      usageAmountLabel(limit({ amount: { remaining: 1_048_576, unit: "bytes" } })),
    ).toBe("1 MiB left");
    expect(
      usageAmountLabel(limit({ amount: { remaining: 1_048_575, unit: "bytes" } })),
    ).toBe("1,024 KiB left");
    expect(usageAmountLabel(limit({ amount: { remaining: 1_024, unit: "bytes" } }))).toBe(
      "1 KiB left",
    );
    expect(usageAmountLabel(limit({ amount: { remaining: 1_023, unit: "bytes" } }))).toBe(
      "1,023 B left",
    );
  });

  it("renders fraction-only amounts without absolute values", () => {
    expect(usageAmountLabel(limit({ amount: { used: 80, unit: "percent" } }))).toBe(
      "80.0% used",
    );
    expect(
      usageAmountLabel(limit({ amount: { remainingFraction: 0.25, unit: "unknown" } })),
    ).toBe("75.0% used");
  });

  it("uses two decimals below one percent and one decimal at or above", () => {
    expect(
      usageAmountLabel(limit({ amount: { usedFraction: 0.009, unit: "unknown" } })),
    ).toBe("0.90% used");
    expect(
      usageAmountLabel(limit({ amount: { usedFraction: 0.01, unit: "unknown" } })),
    ).toBe("1.0% used");
    expect(
      usageAmountLabel(limit({ amount: { usedFraction: 0.999, unit: "unknown" } })),
    ).toBe("99.9% used");
  });

  it("falls back to a placeholder when nothing is reported", () => {
    expect(usageAmountLabel(limit({ amount: { unit: "unknown" } }))).toBe(
      "No amount reported",
    );
    expect(usageAmountLabel(limit({ amount: { unit: "percent" } }))).toBe(
      "No amount reported",
    );
  });
});

describe("limitDisplayName", () => {
  it("returns the bare label without tier or window", () => {
    expect(limitDisplayName(limit({ amount: { unit: "unknown" } }))).toBe("Usage");
  });

  it("appends the tier when the label does not mention it", () => {
    expect(
      limitDisplayName(
        limit({ scope: { provider: "test", tier: "Pro" }, amount: { unit: "unknown" } }),
      ),
    ).toBe("Usage (Pro)");
  });

  it("deduplicates a tier the label already names, case-insensitively", () => {
    expect(
      limitDisplayName(
        limit({
          label: "Pro plan",
          scope: { provider: "test", tier: "pro" },
          amount: { unit: "unknown" },
        }),
      ),
    ).toBe("Pro plan");
  });

  it("appends the window label and suppresses the generic quota window", () => {
    expect(
      limitDisplayName(
        limit({
          window: { id: "w1", label: "5h" },
          amount: { unit: "unknown" },
        }),
      ),
    ).toBe("Usage (5h)");
    expect(
      limitDisplayName(
        limit({
          window: { id: "w1", label: "Quota Window" },
          amount: { unit: "unknown" },
        }),
      ),
    ).toBe("Usage");
  });

  it("deduplicates a window the label already names", () => {
    expect(
      limitDisplayName(
        limit({
          label: "Daily limit",
          window: { id: "w1", label: "daily" },
          amount: { unit: "unknown" },
        }),
      ),
    ).toBe("Daily limit");
  });

  it("falls back to the scope window id when the window is absent", () => {
    expect(
      limitDisplayName(
        limit({
          scope: { provider: "test", windowId: "weekly" },
          amount: { unit: "unknown" },
        }),
      ),
    ).toBe("Usage (weekly)");
  });

  it("stacks tier and window suffixes", () => {
    expect(
      limitDisplayName(
        limit({
          scope: { provider: "test", tier: "Pro" },
          window: { id: "w1", label: "5h" },
          amount: { unit: "unknown" },
        }),
      ),
    ).toBe("Usage (Pro) (5h)");
  });
});

describe("resetLabel", () => {
  it("is null without a window reset", () => {
    expect(resetLabel(limit({ amount: { unit: "unknown" } }), NOW)).toBeNull();
    expect(
      resetLabel(
        limit({ window: { id: "w1", label: "5h" }, amount: { unit: "unknown" } }),
        NOW,
      ),
    ).toBeNull();
  });

  it("reports a reset time at or before now as passed", () => {
    const window = { id: "w1", label: "5h", resetsAt: NOW };
    expect(resetLabel(limit({ window, amount: { unit: "unknown" } }), NOW)).toBe(
      "Reset time has passed",
    );
    expect(
      resetLabel(
        limit({
          window: { ...window, resetsAt: NOW - 1_000 },
          amount: { unit: "unknown" },
        }),
        NOW,
      ),
    ).toBe("Reset time has passed");
  });

  it("counts down to a future reset", () => {
    expect(
      resetLabel(
        limit({
          window: { id: "w1", label: "5h", resetsAt: NOW + 3_600_000 },
          amount: { unit: "unknown" },
        }),
        NOW,
      ),
    ).toBe("Resets in 1 hour");
    expect(
      resetLabel(
        limit({
          window: { id: "w1", label: "5h", resetsAt: NOW + 90_000 },
          amount: { unit: "unknown" },
        }),
        NOW,
      ),
    ).toBe("Resets in 2 minutes");
  });
});

describe("capacityLabel", () => {
  it("pluralizes the account count", () => {
    expect(
      capacityLabel({ window: "5h", accounts: 1, usedAccounts: 0, remainingAccounts: 1 }),
    ).toBe("1 of 1 account left");
    expect(
      capacityLabel({ window: "5h", accounts: 3, usedAccounts: 1, remainingAccounts: 2 }),
    ).toBe("2 of 3 accounts left");
    expect(
      capacityLabel({ window: "5h", accounts: 2, usedAccounts: 2, remainingAccounts: 0 }),
    ).toBe("0 of 2 accounts left");
  });
});

describe("savedResetLabel", () => {
  it("is null without available resets", () => {
    expect(savedResetLabel(report(), NOW)).toBeNull();
    expect(savedResetLabel(report({ availableCount: 0 }), NOW)).toBeNull();
  });

  it("pluralizes the saved reset count without credits", () => {
    expect(savedResetLabel(report({ availableCount: 1 }), NOW)).toBe("1 saved reset");
    expect(savedResetLabel(report({ availableCount: 2 }), NOW)).toBe("2 saved resets");
  });

  it("appends the earliest upcoming expiry regardless of credit order", () => {
    const in12h = new Date(NOW + 12 * 3_600_000).toISOString();
    const in24h = new Date(NOW + 24 * 3_600_000).toISOString();
    expect(
      savedResetLabel(
        report({
          availableCount: 2,
          credits: [{ expiresAt: in24h }, { expiresAt: in12h }],
        }),
        NOW,
      ),
    ).toBe("2 saved resets · next expires in 12 hours");
  });

  it("ignores expiries that are past, due now, or unparseable", () => {
    const in12h = new Date(NOW + 12 * 3_600_000).toISOString();
    const past = new Date(NOW - 1_000).toISOString();
    expect(
      savedResetLabel(
        report({
          availableCount: 3,
          credits: [{ expiresAt: "not-a-date" }, { expiresAt: past }, { expiresAt: in12h }],
        }),
        NOW,
      ),
    ).toBe("3 saved resets · next expires in 12 hours");
    expect(
      savedResetLabel(
        report({
          availableCount: 2,
          credits: [{ expiresAt: past }, { expiresAt: new Date(NOW).toISOString() }],
        }),
        NOW,
      ),
    ).toBe("2 saved resets");
  });
});

describe("reportIdentityDetail", () => {
  it("is null without distinguishing identity", () => {
    expect(reportIdentityDetail(report(), "user@example.com")).toBeNull();
  });

  it("lists the organization when it differs from the account label", () => {
    const withOrg = report();
    expect(
      reportIdentityDetail(
        { ...withOrg, identity: { orgName: "Acme" } },
        "user@example.com",
      ),
    ).toBe("Acme");
    expect(
      reportIdentityDetail({ ...withOrg, identity: { orgName: "Acme" } }, "Acme"),
    ).toBeNull();
    expect(
      reportIdentityDetail(
        { ...withOrg, identity: { orgId: "org_123" } },
        "user@example.com",
      ),
    ).toBe("org_123");
  });

  it("combines organization and plan type", () => {
    const withOrg = report();
    expect(
      reportIdentityDetail(
        { ...withOrg, identity: { orgName: "Acme", planType: "Team" } },
        "user@example.com",
      ),
    ).toBe("Acme · Team plan");
    expect(
      reportIdentityDetail(
        { ...withOrg, identity: { planType: "Team" } },
        "user@example.com",
      ),
    ).toBe("Team plan");
  });
});
