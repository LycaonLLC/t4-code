import { describe, expect, it } from "vite-plus/test";

import { companionSetupLink } from "../src/features/targets/phone-setup.ts";

describe("companion phone setup link", () => {
  it("encodes the stable Tailnet origin for one-time native app setup", () => {
    expect(companionSetupLink("https://mac.example.ts.net:8445")).toBe(
      "t4companion://?address=https%3A%2F%2Fmac.example.ts.net%3A8445",
    );
  });

  it("includes a non-default profile and rejects unsafe host URLs", () => {
    expect(companionSetupLink("https://mac.example.ts.net", "work")).toBe(
      "t4companion://?address=https%3A%2F%2Fmac.example.ts.net&profile=work",
    );
    expect(() => companionSetupLink("http://mac.example.ts.net")).toThrow(/root HTTPS/u);
    expect(() => companionSetupLink("https://mac.example.ts.net/private")).toThrow(/root HTTPS/u);
  });
});
