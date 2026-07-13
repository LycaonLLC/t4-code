import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RunOptionsMenu } from "../src/features/composer/ComposerControls.tsx";
import { MobileComposerActions } from "../src/features/composer/MobileComposerActions.tsx";

const noop = () => {};

describe("phone composer primary actions", () => {
  it("collapses secondary controls behind a native Run options trigger", () => {
    const markup = renderToStaticMarkup(
      <RunOptionsMenu summary="Default · Medium">
        <button type="button">Model control</button>
      </RunOptionsMenu>,
    );

    expect(markup).toContain("<button");
    expect(markup).toContain("Run options");
    expect(markup).not.toContain("Model control");
  });

  it("keeps stop, queue, and steer in a dedicated three-column control group", () => {
    const markup = renderToStaticMarkup(
      <MobileComposerActions
        canCancel
        cancelDisabledReason={null}
        onCancel={noop}
        onQueue={noop}
        onSubmit={noop}
        primaryBusy={false}
        primaryDisabled={false}
        primaryLabel="Steer"
        queueDisabled={false}
        turnActive
      />,
    );

    expect(markup).toContain('aria-label="Turn controls"');
    expect(markup).toContain(">Stop</button>");
    expect(markup).toContain(">Queue</button>");
    expect(markup).toContain('aria-label="Steer"');
    expect(markup).toContain("grid-cols-[minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1.4fr)]");
    expect([...markup.matchAll(/<button[^>]*min-h-11/g)]).toHaveLength(3);
  });

  it("keeps an unavailable stop focusable and exposes the host reason", () => {
    const markup = renderToStaticMarkup(
      <MobileComposerActions
        canCancel={false}
        cancelDisabledReason="The host is reconnecting"
        onCancel={noop}
        onQueue={noop}
        onSubmit={noop}
        primaryBusy={false}
        primaryDisabled={false}
        primaryLabel="Steer"
        queueDisabled={false}
        turnActive
      />,
    );

    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("aria-describedby=");
    expect(markup).toContain("The host is reconnecting");
  });

  it("renders one full-width Send action while idle", () => {
    const markup = renderToStaticMarkup(
      <MobileComposerActions
        canCancel={false}
        cancelDisabledReason={null}
        onCancel={noop}
        onQueue={noop}
        onSubmit={noop}
        primaryBusy={false}
        primaryDisabled={false}
        primaryLabel="Send"
        queueDisabled
        turnActive={false}
      />,
    );

    expect(markup).toContain('aria-label="Message actions"');
    expect(markup).toContain('aria-label="Send"');
    expect(markup).not.toContain(">Queue</button>");
    expect(markup).not.toContain(">Stop</button>");
  });
});
