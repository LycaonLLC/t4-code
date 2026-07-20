import { describe, expect, it } from "vite-plus/test";

import { AttentionNotificationState } from "./attention-notification-state";

describe("AttentionNotificationState", () => {
  it("seeds the current inbox, emits only new keys, and allows resolved keys to return", () => {
    const state = new AttentionNotificationState();

    expect(state.update([{ key: "existing" }])).toEqual([]);
    expect(state.update([{ key: "existing" }, { key: "new" }])).toEqual([{ key: "new" }]);
    expect(state.update([{ key: "new" }])).toEqual([]);
    expect(state.update([{ key: "existing" }, { key: "new" }])).toEqual([{ key: "existing" }]);
  });

  it("forgets one host when reset before seeding another", () => {
    const state = new AttentionNotificationState();
    state.update([{ key: "host-a" }]);
    state.reset();

    expect(state.update([{ key: "host-b" }])).toEqual([]);
    expect(state.update([{ key: "host-b" }, { key: "host-b-next" }])).toEqual([{ key: "host-b-next" }]);
  });
});
