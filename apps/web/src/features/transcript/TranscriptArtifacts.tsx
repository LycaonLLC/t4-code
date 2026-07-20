import { Button, cn } from "@t4-code/ui";
import {
  CircleAlert,
  Download,
  FileCode2,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Package,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { TranscriptImageSource } from "../session-runtime/transcript-images.ts";
import type { TranscriptArtifactReference } from "./artifact-metadata.ts";

function labelFor(artifact: TranscriptArtifactReference): string {
  return artifact.name ?? `${artifact.kind} artifact`;
}

function ArtifactCard({
  artifact,
  source,
}: {
  readonly artifact: TranscriptArtifactReference;
  readonly source: TranscriptImageSource;
}) {
  const [open, setOpen] = useState(artifact.kind === "image");
  const [text, setText] = useState<string | null>(null);
  const snapshot = useSyncExternalStore(
    (listener) => source.subscribe(artifact, listener),
    () => source.getSnapshot(artifact),
    () => source.getSnapshot(artifact),
  );

  useEffect(() => {
    if (!open) return;
    return source.retain(artifact);
  }, [artifact, open, source]);

  useEffect(() => {
    if (
      !open ||
      (artifact.kind !== "text" && artifact.kind !== "patch") ||
      snapshot.status !== "ready"
    ) {
      setText(null);
      return;
    }
    let cancelled = false;
    void fetch(snapshot.url)
      .then((response) => response.text())
      .then((value) => {
        if (!cancelled) setText(value.slice(0, 32 * 1024));
      })
      .catch(() => {
        if (!cancelled) setText("This artifact could not be displayed.");
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.kind, open, snapshot]);

  const Icon =
    artifact.kind === "image"
      ? ImageIcon
      : artifact.kind === "binary"
        ? Package
        : artifact.kind === "patch"
          ? FileCode2
          : FileText;
  return (
    <article
      className="min-w-0 rounded-md border border-border/60 bg-muted/30 p-2"
      aria-label={labelFor(artifact)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{labelFor(artifact)}</span>
        <span className="shrink-0 text-muted-foreground text-xs">{artifact.kind}</span>
      </div>
      {artifact.kind === "image" && snapshot.status === "ready" && (
        <img
          className="mt-2 max-h-52 max-w-full rounded object-contain"
          src={snapshot.url}
          alt={labelFor(artifact)}
          onError={() => source.reportDecodeFailure(artifact)}
        />
      )}
      {snapshot.status === "loading" && open && (
        <p className="mt-2 flex items-center gap-1 text-muted-foreground text-xs" role="status">
          <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
          Loading artifact…
        </p>
      )}
      {snapshot.status === "unavailable" && (
        <p className="mt-2 text-muted-foreground text-xs" role="note">
          {snapshot.reason}
        </p>
      )}
      {snapshot.status === "error" && (
        <p className="mt-2 flex gap-1 text-destructive text-xs" role="alert">
          <CircleAlert aria-hidden="true" className="size-3 shrink-0" />
          {snapshot.reason}
        </p>
      )}
      {(artifact.kind === "text" || artifact.kind === "patch") && (
        <>
          <Button
            className="mt-2 min-h-8"
            size="sm"
            variant="outline"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
          >
            {open ? "Close preview" : "Open preview"}
          </Button>
          {open && text !== null && (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-xs">
              {text}
            </pre>
          )}
        </>
      )}
      {artifact.kind === "binary" && (
        <Button className="mt-2 min-h-8" size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Download aria-hidden="true" className="mr-1 size-3" />
          Prepare download
        </Button>
      )}
      {artifact.kind === "binary" && open && snapshot.status === "ready" && (
        <a
          className="mt-2 inline-flex min-h-8 items-center rounded border border-input px-2 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          href={snapshot.url}
          download={artifact.name ?? "artifact"}
        >
          Download verified artifact
        </a>
      )}
    </article>
  );
}

export function TranscriptArtifacts({
  artifacts,
  issue,
  label,
  source,
  className,
}: {
  readonly artifacts: readonly TranscriptArtifactReference[];
  readonly issue: string | null;
  readonly label: string;
  readonly source: TranscriptImageSource;
  readonly className?: string | undefined;
}) {
  if (artifacts.length === 0 && issue === null) return null;
  return (
    <section
      className={cn("mt-2 grid max-w-full grid-cols-1 gap-2 sm:grid-cols-2", className)}
      aria-label={`${label} artifacts`}
    >
      {issue !== null && (
        <p
          className="rounded border border-destructive/30 p-2 text-destructive text-xs"
          role="alert"
        >
          {issue}
        </p>
      )}
      {artifacts.map((artifact) => (
        <ArtifactCard artifact={artifact} source={source} key={artifact.artifactId} />
      ))}
    </section>
  );
}
