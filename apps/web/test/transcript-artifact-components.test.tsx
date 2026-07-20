import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type {
  TranscriptImageSnapshot,
  TranscriptImageSource,
} from "../src/features/session-runtime/transcript-images.ts";
import {
  artifactDownloadLabel,
  artifactOpensInline,
  TranscriptArtifacts,
} from "../src/features/transcript/TranscriptArtifacts.tsx";
import type { TranscriptArtifactReference } from "../src/features/transcript/artifact-metadata.ts";

function artifact(
  overrides: Partial<TranscriptArtifactReference> = {},
): TranscriptArtifactReference {
  return {
    artifactId: "artifact-1",
    kind: "image",
    mediaType: "image/png",
    disposition: "inline",
    retention: "session",
    source: "artifact",
    ...overrides,
  };
}

function source(snapshot: TranscriptImageSnapshot): TranscriptImageSource {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    retain: () => () => undefined,
    reportDecodeFailure: () => undefined,
    dispose: () => undefined,
  };
}

describe("transcript artifact presentation", () => {
  it("opens only inline image artifacts automatically", () => {
    const inline = artifact();
    const attachment = artifact({ artifactId: "attachment-1", disposition: "attachment" });

    expect(artifactOpensInline(inline)).toBe(true);
    expect(artifactOpensInline(attachment)).toBe(false);

    const markup = renderToStaticMarkup(
      <TranscriptArtifacts
        artifacts={[attachment]}
        issue={null}
        label="Response"
        source={source({
          status: "ready",
          url: "blob:attachment",
          mimeType: "image/png",
          size: 42,
          animated: false,
        })}
      />,
    );

    expect(markup).toContain("Open image");
    expect(markup).not.toContain('src="blob:attachment"');
  });

  it("labels binary downloads as verified only when the descriptor has a digest", () => {
    expect(
      artifactDownloadLabel(artifact({ artifactId: "plain", kind: "binary", disposition: "attachment" })),
    ).toBe("Download artifact");
    expect(
      artifactDownloadLabel(
        artifact({
          artifactId: "verified",
          kind: "binary",
          disposition: "attachment",
          sha256: "a".repeat(64),
        }),
      ),
    ).toBe("Download verified artifact");
  });
});
