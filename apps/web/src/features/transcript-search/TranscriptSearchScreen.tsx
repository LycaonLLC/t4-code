import {
  Badge,
  Button,
  cn,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Spinner,
} from "@t4-code/ui";
import {
  Archive,
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleAlert,
  CloudOff,
  Search,
  Server,
  UserRound,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";

import type {
  HistoricTranscriptContext,
  TranscriptHostSearchState,
  TranscriptRole,
  TranscriptSearchFilters,
  TranscriptSearchResponse,
  TranscriptSearchResult,
} from "./model.ts";
import {
  plainTextHighlightSegments,
  transcriptSearchCanRun,
  transcriptSearchIsPartial,
} from "./model.ts";

export type TranscriptSearchPhase = "idle" | "searching" | "complete" | "error";

export type HistoricContextState =
  | null
  | {
      readonly result: TranscriptSearchResult;
      readonly phase: "loading" | "ready" | "error";
      readonly context?: HistoricTranscriptContext;
      readonly error?: string;
    };

export interface TranscriptSearchScreenProps {
  readonly query: string;
  readonly filters: TranscriptSearchFilters;
  readonly projects: readonly { readonly id: string; readonly label: string }[];
  readonly phase: TranscriptSearchPhase;
  readonly response: TranscriptSearchResponse | null;
  readonly error: string | undefined;
  readonly historicContext: HistoricContextState;
  readonly onQueryChange: (query: string) => void;
  readonly onFiltersChange: (filters: TranscriptSearchFilters) => void;
  readonly onSubmit: () => void;
  readonly onOpenResult: (result: TranscriptSearchResult) => void;
  readonly onCloseHistoricContext: () => void;
  readonly onOpenLiveTail: (result: TranscriptSearchResult) => void;
  readonly onLoadMoreHost: ((hostId: string) => void) | undefined;
  readonly loadingMoreHostId: string | null;
  readonly loadMoreError: string | undefined;
}

function roleLabel(role: TranscriptRole): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Assistant";
  return "Summary";
}

function RoleIcon({ role }: { readonly role: TranscriptRole }) {
  if (role === "user") return <UserRound aria-hidden="true" className="size-3.5" />;
  return <Bot aria-hidden="true" className="size-3.5" />;
}

function resultTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function HighlightedPlainText({ text, query }: { readonly text: string; readonly query: string }) {
  return (
    <>
      {plainTextHighlightSegments(text, query).map((segment, index) =>
        segment.highlighted ? (
          <mark
            className="rounded-sm bg-status-plan/20 px-0.5 text-inherit dark:bg-status-plan/25"
            key={`${index}:${segment.text}`}
          >
            {segment.text}
          </mark>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}

const HOST_PRESENTATION: Readonly<
  Record<TranscriptHostSearchState, { readonly label: string; readonly icon: ReactNode; readonly tone: string }>
> = {
  searched: {
    label: "Searched",
    icon: <CheckCircle2 aria-hidden="true" className="size-3.5" />,
    tone: "text-status-done",
  },
  offline: {
    label: "Offline",
    icon: <CloudOff aria-hidden="true" className="size-3.5" />,
    tone: "text-muted-foreground",
  },
  unsupported: {
    label: "Needs update",
    icon: <CircleAlert aria-hidden="true" className="size-3.5" />,
    tone: "text-status-plan",
  },
  indexing: {
    label: "Indexing",
    icon: <Spinner aria-hidden="true" className="size-3.5" />,
    tone: "text-status-plan",
  },
  error: {
    label: "Failed",
    icon: <CircleAlert aria-hidden="true" className="size-3.5" />,
    tone: "text-status-error",
  },
};

function HostStatusList({
  response,
  onLoadMoreHost,
  loadingMoreHostId,
}: {
  readonly response: TranscriptSearchResponse;
  readonly onLoadMoreHost: ((hostId: string) => void) | undefined;
  readonly loadingMoreHostId: string | null;
}) {
  return (
    <section aria-labelledby="transcript-search-hosts" className="rounded-lg border border-border bg-card">
      <h2 className="sr-only" id="transcript-search-hosts">
        Host search status
      </h2>
      <ul className="divide-y divide-border">
        {response.hosts.map((host) => {
          const presentation = HOST_PRESENTATION[host.state];
          return (
            <li className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs" key={host.hostId}>
              <Server aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span className="font-medium text-foreground">{host.hostLabel}</span>
              <span className={cn("inline-flex items-center gap-1", presentation.tone)}>
                {presentation.icon}
                {presentation.label}
              </span>
              {host.resultCount !== undefined && (
                <span className="text-muted-foreground">
                  {host.resultCount} {host.resultCount === 1 ? "result" : "results"}
                </span>
              )}
              {host.message !== undefined && (
                <span className="basis-full ps-[1.375rem] text-muted-foreground">{host.message}</span>
              )}
              {host.hasMore && onLoadMoreHost !== undefined && (
                <Button
                  className="ms-auto min-h-11 sm:min-h-0"
                  disabled={loadingMoreHostId !== null}
                  onClick={() => onLoadMoreHost(host.hostId)}
                  size="xs"
                  variant="outline"
                >
                  {loadingMoreHostId === host.hostId && <Spinner className="size-3.5" />}
                  Load more from {host.hostLabel}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SearchResults({
  response,
  query,
  onOpenResult,
}: {
  readonly response: TranscriptSearchResponse;
  readonly query: string;
  readonly onOpenResult: (result: TranscriptSearchResult) => void;
}) {
  if (response.results.length === 0) {
    const incomplete = transcriptSearchIsPartial(response);
    return (
      <Empty className="min-h-64 rounded-lg border border-border border-dashed">
        <EmptyMedia variant="icon">
          <Search />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{incomplete ? "No results from the hosts that answered" : "No transcript matches"}</EmptyTitle>
          <EmptyDescription>
            {incomplete
              ? "Some hosts were not searched. Reconnect or update them, then try again."
              : "Try fewer words or broaden the project, role, and archive filters."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <section aria-labelledby="transcript-search-results">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="font-heading font-semibold text-sm" id="transcript-search-results">
          {response.results.length} {response.results.length === 1 ? "match" : "matches"}
        </h2>
        {response.truncated && <Badge variant="outline">More may exist</Badge>}
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {response.results.map((result) => (
          <li key={result.key}>
            <button
              className="flex min-h-28 w-full flex-col gap-2 px-4 py-3 text-start outline-none transition-colors hover:bg-secondary/70 focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => onOpenResult(result)}
              type="button"
            >
              <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <RoleIcon role={result.role} />
                  {roleLabel(result.role)}
                </span>
                <span className="text-muted-foreground">{result.projectLabel}</span>
                <span aria-hidden="true" className="text-muted-foreground">·</span>
                <span className="min-w-0 truncate text-muted-foreground">{result.sessionTitle}</span>
                {result.archived && (
                  <Badge className="gap-1" variant="outline">
                    <Archive aria-hidden="true" className="size-3" />
                    Archived
                  </Badge>
                )}
                <span className="ms-auto shrink-0 text-muted-foreground">{resultTime(result.occurredAt)}</span>
              </span>
              <span className="line-clamp-3 text-foreground text-sm leading-6">
                <HighlightedPlainText query={query} text={result.snippet} />
              </span>
              <span className="text-muted-foreground text-xs">{result.hostLabel} · Open older context</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HistoricContext({
  state,
  onClose,
  onOpenLiveTail,
}: {
  readonly state: Exclude<HistoricContextState, null>;
  readonly onClose: () => void;
  readonly onOpenLiveTail: (result: TranscriptSearchResult) => void;
}) {
  const { result } = state;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <main className="mx-auto flex max-w-4xl flex-col gap-4 pt-4 pr-[max(1rem,var(--app-safe-area-right))] pb-[calc(1rem+var(--app-safe-area-bottom))] pl-[max(1rem,var(--app-safe-area-left))]">
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-status-plan/35 bg-status-plan/8 px-4 py-3">
          <Archive aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-plan" />
          <div className="min-w-0 flex-1">
            <h2 className="font-medium text-sm">Viewing older transcript context</h2>
            <p className="mt-1 text-muted-foreground text-xs leading-5">
              This is a read-only window around the matched message. Your live session stays separate and keeps receiving new output.
            </p>
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <Button className="min-h-11 sm:min-h-0" onClick={onClose} size="xs" variant="outline">
              <ArrowLeft />
              Back to results
            </Button>
            <Button className="min-h-11 sm:min-h-0" onClick={() => onOpenLiveTail(result)} size="xs">
              Open live tail
            </Button>
          </div>
        </div>
        <div>
          <p className="font-medium text-sm">{result.sessionTitle}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            {result.projectLabel} · {result.hostLabel}
          </p>
        </div>
        {state.phase === "loading" && (
          <div aria-live="polite" className="flex min-h-64 items-center justify-center gap-2 text-muted-foreground text-sm" role="status">
            <Spinner className="size-4" />
            Loading the surrounding messages…
          </div>
        )}
        {state.phase === "error" && (
          <Empty className="min-h-64 rounded-lg border border-border border-dashed">
            <EmptyMedia variant="icon"><CircleAlert /></EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Older context could not load</EmptyTitle>
              <EmptyDescription>{state.error ?? "The host did not return this transcript window."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {state.phase === "ready" && state.context !== undefined && (
          <ol className="flex flex-col gap-2" start={1}>
            {state.context.hasBefore && (
              <li className="py-1 text-center text-muted-foreground text-xs">Earlier messages are available on the host</li>
            )}
            {state.context.rows.map((row, index) => (
              <li
                className={cn(
                  "rounded-lg border bg-card px-4 py-3",
                  index === state.context?.anchorIndex ? "border-status-plan/60 ring-1 ring-status-plan/20" : "border-border",
                )}
                key={row.entryId}
              >
                <div className="mb-2 flex items-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 font-medium"><RoleIcon role={row.role} />{roleLabel(row.role)}</span>
                  <span className="text-muted-foreground">{resultTime(row.occurredAt)}</span>
                  {index === state.context?.anchorIndex && <Badge variant="outline">Search match</Badge>}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6">{row.text}</p>
              </li>
            ))}
            {state.context.hasAfter && (
              <li className="py-1 text-center text-muted-foreground text-xs">Later messages are available on the host</li>
            )}
          </ol>
        )}
      </main>
    </div>
  );
}

export function TranscriptSearchScreen(props: TranscriptSearchScreenProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (transcriptSearchCanRun(props.query)) props.onSubmit();
  };
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-border border-b px-4 py-2">
        <Search aria-hidden="true" className="size-4 text-muted-foreground" />
        <h1 className="font-heading font-semibold text-base">Transcript search</h1>
        <span className="ms-auto hidden text-muted-foreground text-xs sm:inline">Queries and snippets stay in memory</span>
      </header>
      {props.historicContext !== null ? (
        <HistoricContext state={props.historicContext} onClose={props.onCloseHistoricContext} onOpenLiveTail={props.onOpenLiveTail} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <main className="mx-auto flex max-w-4xl flex-col gap-4 pt-4 pr-[max(1rem,var(--app-safe-area-right))] pb-[calc(1rem+var(--app-safe-area-bottom))] pl-[max(1rem,var(--app-safe-area-left))]">
            <form className="flex flex-col gap-3" onSubmit={submit}>
              <div className="flex gap-2">
                <label className="min-w-0 flex-1" htmlFor="transcript-search-query">
                  <span className="sr-only">Search prior transcript discussions</span>
                  <input
                    autoComplete="off"
                    autoFocus
                    className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    id="transcript-search-query"
                    onChange={(event) => props.onQueryChange(event.target.value)}
                    placeholder="Find a decision, error, file name, or code discussion"
                    spellCheck={false}
                    type="search"
                    value={props.query}
                  />
                </label>
                <Button className="h-11" disabled={!transcriptSearchCanRun(props.query) || props.phase === "searching"} type="submit">
                  {props.phase === "searching" ? <Spinner /> : <Search />}
                  <span className="hidden sm:inline">Search</span>
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-muted-foreground text-xs">
                  Project
                  <select
                    className="h-10 rounded-md border border-input bg-background px-2 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onChange={(event) => props.onFiltersChange({ ...props.filters, projectId: event.target.value === "" ? null : event.target.value })}
                    value={props.filters.projectId ?? ""}
                  >
                    <option value="">All projects</option>
                    {props.projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-muted-foreground text-xs">
                  Speaker
                  <select
                    className="h-10 rounded-md border border-input bg-background px-2 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onChange={(event) => props.onFiltersChange({ ...props.filters, role: event.target.value as TranscriptSearchFilters["role"] })}
                    value={props.filters.role}
                  >
                    <option value="all">Anyone</option>
                    <option value="user">You</option>
                    <option value="assistant">Assistant</option>
                    <option value="system">Summary</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-muted-foreground text-xs">
                  Sessions
                  <select
                    className="h-10 rounded-md border border-input bg-background px-2 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onChange={(event) => props.onFiltersChange({ ...props.filters, archived: event.target.value as TranscriptSearchFilters["archived"] })}
                    value={props.filters.archived}
                  >
                    <option value="all">Current and archived</option>
                    <option value="current">Current only</option>
                    <option value="archived">Archived only</option>
                  </select>
                </label>
              </div>
            </form>
            {props.phase === "idle" && (
              <Empty className="min-h-64 rounded-lg border border-border border-dashed">
                <EmptyMedia variant="icon"><Search /></EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>Find a past decision without finding the session first</EmptyTitle>
                  <EmptyDescription>Search message text across connected hosts. Results include archived sessions by default.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {props.phase === "searching" && props.response === null && (
              <div aria-live="polite" className="flex min-h-64 items-center justify-center gap-2 text-muted-foreground text-sm" role="status">
                <Spinner className="size-4" />
                Asking each connected host…
              </div>
            )}
            {props.phase === "error" && (
              <Empty className="min-h-64 rounded-lg border border-border border-dashed">
                <EmptyMedia variant="icon"><CircleAlert /></EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>Search could not start</EmptyTitle>
                  <EmptyDescription>{props.error ?? "Try again after the host connection recovers."}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {props.response !== null && (
              <>
                <HostStatusList
                  loadingMoreHostId={props.loadingMoreHostId}
                  onLoadMoreHost={props.onLoadMoreHost}
                  response={props.response}
                />
                {props.loadMoreError !== undefined && (
                  <p aria-live="polite" className="rounded-lg border border-status-error/30 bg-status-error/8 px-3 py-2 text-status-error text-xs" role="status">
                    {props.loadMoreError}
                  </p>
                )}
                <SearchResults onOpenResult={props.onOpenResult} query={props.query} response={props.response} />
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
