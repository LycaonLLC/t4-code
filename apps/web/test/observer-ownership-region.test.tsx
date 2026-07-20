// Ownership region contract for an observed session. Reproduces the
// packaged-proof failure — the follower's transcript field alternating
// live/snapshot every poll while the owner's app saves — and pins the fix:
// one persistent read-only region whose rendered markup is byte-identical
// on every tick, no writable affordance ever appears, and the only motion
// the banner may show is the record-arrival pulse keyed on durable entry
// progression (disabled under reduced motion).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  presentSessionControl,
  type ObserverTranscript,
} from "../src/features/session-runtime/session-observer.ts";
import {
  createRecordArrivalPulseController,
  RECORD_ARRIVAL_PULSE_MS,
  SessionControlBanner,
  type RecordArrivalPulseController,
} from "../src/features/transcript/SessionMain.tsx";

const sessionMainSource = readFileSync(
  join(import.meta.dirname, "../src/features/transcript/SessionMain.tsx"),
  "utf8",
);

function observerBannerMarkup(transcript: ObserverTranscript, pulse = false): string {
  const presentation = presentSessionControl({ mode: "observer", lockStatus: "live", transcript });
  return renderToStaticMarkup(
    <SessionControlBanner mode="observer" presentation={presentation} pulse={pulse} />,
  );
}

describe("observer ownership region under freshness churn", () => {
  it("renders byte-identical markup while live/snapshot alternates at 250ms for 20 seconds", () => {
    const baseline = observerBannerMarkup("live");
    for (let tick = 0; tick * 250 < 20_000; tick += 1) {
      const transcript = tick % 2 === 0 ? ("live" as const) : ("snapshot" as const);
      const markup = observerBannerMarkup(transcript);
      // Byte-identical markup on every tick: same element types in the same
      // positions with the same attributes, so React reconciles the region
      // in place — nothing to unmount, remount, or flash.
      expect(markup, `tick ${tick} (${transcript})`).toBe(baseline);
    }
  });

  it("keeps a stable region identity: role=status with a constant mode marker", () => {
    for (const transcript of ["live", "snapshot"] as const) {
      const markup = observerBannerMarkup(transcript);
      expect(markup).toContain('role="status"');
      expect(markup).toContain('data-session-control-banner="observer"');
      expect(markup).toContain("Active in another app");
      expect(markup).toContain(
        "Following saved output, not a token-by-token stream. Finished steps appear here as the other app saves them. To continue here, run /continue-in-t4 in the other app — or just exit it.",
      );
    }
  });

  it("never renders a writable affordance in any state or pulse phase", () => {
    for (const pulse of [false, true]) {
      for (const transcript of ["live", "snapshot"] as const) {
        const markup = observerBannerMarkup(transcript, pulse);
        for (const affordance of ["<button", "<input", "<textarea", "<select", "<a ", "href=", "contenteditable", "onclick"]) {
          expect(markup.toLowerCase(), `${transcript} pulse=${pulse}`).not.toContain(affordance);
        }
      }
    }
  });

  it("pulses only via the opacity of an always-mounted decorative dot", () => {
    const quiet = observerBannerMarkup("live", false);
    const pulsing = observerBannerMarkup("live", true);
    // The dot slot exists in both phases (aria-hidden, no layout shift);
    // the pulse changes opacity only, never copy or structure.
    expect(quiet).toContain('aria-hidden="true"');
    expect(pulsing).toContain('aria-hidden="true"');
    expect(quiet).toContain("opacity-0");
    expect(pulsing).not.toContain("opacity-0");
    expect(quiet.replace(/class="[^"]*"/g, "")).toBe(pulsing.replace(/class="[^"]*"/g, ""));
  });
});

describe("record-arrival pulse wiring in SessionMain", () => {
  it("keys the pulse on durable entry progression, never poll state", () => {
    // The hook receives only the projection's durable entries; transcript
    // live/snapshot and lock freshness have no path into it.
    expect(sessionMainSource).toContain(
      "const observerPulse = useRecordArrivalPulse(\n    sessionControl?.mode === \"observer\",\n    projection.entries,\n  );",
    );
    expect(sessionMainSource).toContain(
      "advanceRecordArrival(baseline, entries)",
    );
    const pulseCode = sessionMainSource
      .slice(
        sessionMainSource.indexOf("export function createRecordArrivalPulseController"),
        sessionMainSource.indexOf("export function SessionControlBanner"),
      )
      // Code only: prose comments may name the churn they defend against.
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(pulseCode.length).toBeGreaterThan(0);
    expect(pulseCode).not.toMatch(/transcript|lockStatus|bannerBusy|setInterval/);
  });

  it("disables the pulse under reduced motion", () => {
    const pulseCode = sessionMainSource.slice(
      sessionMainSource.indexOf("export function createRecordArrivalPulseController"),
      sessionMainSource.indexOf("export function SessionControlBanner"),
    );
    expect(pulseCode).toContain("const reducedMotion = useReducedMotion();");
    expect(pulseCode).toContain("if (!active || reducedMotion) {");
    expect(pulseCode).toContain("return pulsing && active && !reducedMotion;");
  });

  it("mounts the banner un-keyed so freshness churn cannot remount it", () => {
    const usage = sessionMainSource.slice(
      sessionMainSource.indexOf("<SessionControlBanner"),
      sessionMainSource.indexOf("/>", sessionMainSource.indexOf("<SessionControlBanner")),
    );
    expect(usage.length).toBeGreaterThan(0);
    expect(usage).not.toContain("key=");
  });
});

// Deterministic lifecycle regressions for the pulse core. `observe` is the
// hook's effect body (one call per committed render); `dispose` is unmount.
describe("record-arrival pulse lifecycle", () => {
  const entries = (...ids: string[]) => ids.map((id) => ({ id }));

  function harness(initial: readonly { readonly id: string }[]) {
    const log: boolean[] = [];
    let pulsing = false;
    const controller: RecordArrivalPulseController = createRecordArrivalPulseController(
      initial,
      (value) => {
        pulsing = value;
        log.push(value);
      },
    );
    return {
      controller,
      log,
      get pulsing() {
        return pulsing;
      },
    };
  }

  it("pulses for exactly the pulse window after a durable arrival", () => {
    vi.useFakeTimers();
    try {
      const h = harness(entries("a"));
      h.controller.observe(true, entries("a", "b"), false);
      expect(h.pulsing).toBe(true);
      vi.advanceTimersByTime(RECORD_ARRIVAL_PULSE_MS - 1);
      expect(h.pulsing).toBe(true);
      vi.advanceTimersByTime(1);
      expect(h.pulsing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives rerenders during the pulse: no-arrival reruns neither end nor extend it", () => {
    // The shipped defect: an effect rerun without an arrival cleared the
    // in-flight timer, leaving the pulse stuck on forever.
    vi.useFakeTimers();
    try {
      const h = harness(entries("a"));
      h.controller.observe(true, entries("a", "b"), false);
      expect(h.pulsing).toBe(true);
      // Freshness churn: fresh entry arrays with identical content, as
      // every poll-driven rerender delivers.
      vi.advanceTimersByTime(400);
      h.controller.observe(true, entries("a", "b"), false);
      vi.advanceTimersByTime(400);
      h.controller.observe(true, entries("a", "b"), false);
      expect(h.pulsing).toBe(true);
      // The window still ends on time, measured from the arrival.
      vi.advanceTimersByTime(RECORD_ARRIVAL_PULSE_MS - 800);
      expect(h.pulsing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a superseded timer from clearing a newer pulse early", () => {
    vi.useFakeTimers();
    try {
      const h = harness(entries("a"));
      h.controller.observe(true, entries("a", "b"), false);
      vi.advanceTimersByTime(800);
      // Second arrival mid-pulse restarts the window.
      h.controller.observe(true, entries("a", "b", "c"), false);
      expect(h.pulsing).toBe(true);
      // Past the first arrival's deadline: the stale timer must not have
      // cut the newer pulse short.
      vi.advanceTimersByTime(RECORD_ARRIVAL_PULSE_MS - 400);
      expect(h.pulsing).toBe(true);
      vi.advanceTimersByTime(400);
      expect(h.pulsing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pulses on retention-cap tail rotation (same length, new tail)", () => {
    vi.useFakeTimers();
    try {
      const h = harness(entries("a", "b", "c"));
      h.controller.observe(true, entries("b", "c", "d"), false);
      expect(h.pulsing).toBe(true);
      vi.advanceTimersByTime(RECORD_ARRIVAL_PULSE_MS);
      expect(h.pulsing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reduced motion settles an active pulse, and toggling back reveals no remainder", () => {
    vi.useFakeTimers();
    try {
      const h = harness(entries("a"));
      h.controller.observe(true, entries("a", "b"), false);
      expect(h.pulsing).toBe(true);
      // Reduced motion flips on mid-pulse: timer and value settle at once.
      h.controller.observe(true, entries("a", "b"), true);
      expect(h.pulsing).toBe(false);
      // Flipping back within the old window shows nothing — the remainder
      // of the old pulse is gone, and an entry that landed while disabled
      // never pulses retroactively.
      h.controller.observe(true, entries("a", "b", "c"), true);
      h.controller.observe(true, entries("a", "b", "c"), false);
      expect(h.pulsing).toBe(false);
      vi.runAllTimers();
      expect(h.pulsing).toBe(false);
      // An arrival under reduced motion never pulses at all.
      h.controller.observe(true, entries("a", "b", "c", "d"), true);
      expect(h.pulsing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deactivation settles an active pulse the same way", () => {
    vi.useFakeTimers();
    try {
      const h = harness(entries("a"));
      h.controller.observe(true, entries("a", "b"), false);
      expect(h.pulsing).toBe(true);
      h.controller.observe(false, entries("a", "b"), false);
      expect(h.pulsing).toBe(false);
      h.controller.observe(true, entries("a", "b"), false);
      expect(h.pulsing).toBe(false);
      vi.runAllTimers();
      expect(h.pulsing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose during a pulse leaves no live timer and no stray callbacks", () => {
    vi.useFakeTimers();
    try {
      const h = harness(entries("a"));
      h.controller.observe(true, entries("a", "b"), false);
      expect(h.pulsing).toBe(true);
      h.controller.dispose();
      expect(h.pulsing).toBe(false);
      const callsAfterDispose = h.log.length;
      vi.runAllTimers();
      expect(h.log.length).toBe(callsAfterDispose);
    } finally {
      vi.useRealTimers();
    }
  });
});
