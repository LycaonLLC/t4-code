import { rankFileRefs } from "../features/composer/file-refs.ts";
import { scoreQueryMatch } from "../features/composer/match.ts";
import type { ProjectGroup } from "../lib/session-tree.ts";
import { PANE_FAMILIES } from "../state/workspace-store.ts";
import type {
  ActionDefinition,
  ActionInvocation,
  ActionPresentation,
  ActionSessionSurface,
  QuickOpenGroup,
  QuickOpenItem,
  QuickOpenProvider,
  QuickOpenProviderContext,
} from "./types.ts";

const DEFAULT_RECENT_LIMIT = 5;
const SESSION_RESULT_LIMIT = 40;
const FILE_RESULT_LIMIT = 8;

const GROUP_ORDER: Readonly<Record<QuickOpenGroup, number>> = {
  recent: 0,
  files: 1,
  workspace: 2,
  navigate: 3,
  app: 4,
};

const SURFACE_IDS: readonly ActionSessionSurface[] = PANE_FAMILIES;

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function textScore(value: string, query: string, base = 0): number | null {
  return scoreQueryMatch(value.toLowerCase(), query, {
    exactBase: base,
    prefixBase: base + 4,
    boundaryBase: base + 12,
    includesBase: base + 24,
    fuzzyBase: base + 120,
  });
}

function bestScore(
  query: string,
  fields: readonly { value: string; base: number }[],
): number | null {
  let best: number | null = null;
  for (const field of fields) {
    const score = textScore(field.value, query, field.base);
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
}

function actionItem(
  invocation: ActionInvocation,
  presentation: ActionPresentation,
  provider: "actions" | "transcript-fallback",
  score: number,
): QuickOpenItem {
  return {
    key:
      provider === "transcript-fallback"
        ? "action:transcript-search-query"
        : `action:${invocation.id}${
            invocation.id === "surface.toggle" ? `:${invocation.args.surfaceId}` : ""
          }`,
    kind: provider === "transcript-fallback" ? "transcript-fallback" : "action",
    provider,
    group: presentation.group,
    title: presentation.label,
    subtitle: presentation.description,
    invocation,
    availability: presentation.availability,
    status: presentation.icon === null ? null : { kind: "icon", icon: presentation.icon },
    score,
  };
}

function actionInvocations(context: QuickOpenProviderContext): readonly ActionInvocation[] {
  const activeSessionId = context.registry.environment.workspace.getState().activeSessionId;
  const surfaceInvocations: ActionInvocation[] =
    activeSessionId === null
      ? []
      : SURFACE_IDS.map((surfaceId) => ({
          id: "surface.toggle" as const,
          args: { sessionId: activeSessionId, surfaceId },
        }));
  return [
    ...surfaceInvocations,
    { id: "terminal.toggle", args: undefined },
    { id: "focus.toggle", args: undefined },
    { id: "rail.toggle", args: undefined },
    { id: "inbox.open", args: undefined },
    { id: "transcript-search.open", args: { query: "" } },
    { id: "agents.open", args: undefined },
    { id: "settings.open", args: undefined },
    { id: "hosts.open", args: undefined },
    { id: "usage.open", args: undefined },
    { id: "theme.toggle", args: undefined },
  ];
}

export const actionsProvider: QuickOpenProvider = {
  id: "actions",
  search: (rawQuery, context) => {
    const query = normalizeQuery(rawQuery);
    const items: QuickOpenItem[] = [];
    for (const [index, invocation] of actionInvocations(context).entries()) {
      const definition = context.registry.definition(invocation.id) as ActionDefinition<
        typeof invocation.id
      >;
      if (!definition.surfaces.includes("quick-open")) continue;
      const presentation = context.registry.present(invocation);
      if (presentation.availability.status === "hidden") continue;
      const score =
        query === ""
          ? index
          : bestScore(query, [
              { value: presentation.label, base: 0 },
              { value: presentation.description, base: 40 },
              { value: definition.keywords?.join(" ") ?? "", base: 60 },
            ]);
      if (score !== null) items.push(actionItem(invocation, presentation, "actions", score));
    }
    return items;
  },
};

interface SessionCandidate {
  readonly group: ProjectGroup;
  readonly rowIndex: number;
  readonly groupIndex: number;
}

function sessionCandidates(groups: readonly ProjectGroup[]): SessionCandidate[] {
  return groups.flatMap((group, groupIndex) =>
    group.sessions.map((_row, rowIndex) => ({ group, groupIndex, rowIndex })),
  );
}

export const sessionsProvider: QuickOpenProvider = {
  id: "sessions",
  search: (rawQuery, context) => {
    const query = normalizeQuery(rawQuery);
    const candidates = sessionCandidates(context.groups);
    const items: QuickOpenItem[] = [];
    for (const candidate of candidates) {
      const row = candidate.group.sessions[candidate.rowIndex];
      if (row === undefined) continue;
      const subtitle = `${candidate.group.project.name} · ${row.session.model}`;
      const originalOrder = candidate.groupIndex * 10_000 + candidate.rowIndex;
      const score =
        query === ""
          ? originalOrder
          : bestScore(query, [
              { value: row.session.title, base: 0 },
              { value: candidate.group.displayName, base: 28 },
              { value: candidate.group.project.name, base: 32 },
              { value: candidate.group.host.name, base: 40 },
              { value: row.session.model, base: 60 },
            ]);
      if (score === null) continue;
      const invocation: ActionInvocation<"session.open"> = {
        id: "session.open",
        args: { sessionId: row.session.id },
      };
      const availability = context.registry.present(invocation).availability;
      if (availability.status === "hidden") continue;
      items.push({
        key: `session:${row.session.id}`,
        kind: "session",
        provider: "sessions",
        group: "recent",
        title: row.session.title,
        subtitle,
        invocation,
        availability,
        status:
          row.session.status === null ? null : { kind: "session", status: row.session.status },
        score,
      });
    }
    items.sort((left, right) => left.score - right.score || left.key.localeCompare(right.key));
    return items.slice(0, query === "" ? DEFAULT_RECENT_LIMIT : SESSION_RESULT_LIMIT);
  },
};

export const loadedFilesProvider: QuickOpenProvider = {
  id: "loaded-files",
  search: (rawQuery, context) => {
    const query = normalizeQuery(rawQuery);
    const sessionId = context.registry.environment.workspace.getState().activeSessionId;
    if (query === "" || sessionId === null) return [];
    return rankFileRefs(
      context.activeSessionFiles.filter((entry) => !entry.isDir),
      query,
      FILE_RESULT_LIMIT,
    ).map((entry, index): QuickOpenItem => {
      const invocation: ActionInvocation<"file.open"> = {
        id: "file.open",
        args: { sessionId, path: entry.path },
      };
      return {
        key: `file:${sessionId}:${entry.path}`,
        kind: "file",
        provider: "loaded-files",
        group: "files",
        title: entry.path,
        subtitle: "Current session · loaded file",
        invocation,
        availability: context.registry.present(invocation).availability,
        status: { kind: "icon", icon: "files" },
        score: index,
        indexScope: "loaded",
      };
    });
  },
};

export const transcriptFallbackProvider: QuickOpenProvider = {
  id: "transcript-fallback",
  search: (rawQuery, context) => {
    const query = rawQuery.trim();
    if (query.length < 2) return [];
    const invocation: ActionInvocation<"transcript-search.open"> = {
      id: "transcript-search.open",
      args: { query },
    };
    const presentation = context.registry.present(invocation);
    return [
      actionItem(
        invocation,
        {
          ...presentation,
          label: "View all transcript results",
          description: `Search for “${query}”`,
        },
        "transcript-fallback",
        Number.MAX_SAFE_INTEGER,
      ),
    ];
  },
};

export const QUICK_OPEN_PROVIDERS: readonly QuickOpenProvider[] = Object.freeze([
  sessionsProvider,
  loadedFilesProvider,
  actionsProvider,
  transcriptFallbackProvider,
]);

/** Query every provider, deduplicate by stable key, then restore group order. */
export function buildQuickOpenItems(
  query: string,
  context: QuickOpenProviderContext,
  providers: readonly QuickOpenProvider[] = QUICK_OPEN_PROVIDERS,
): QuickOpenItem[] {
  const deduplicated = new Map<string, QuickOpenItem>();
  for (const provider of providers) {
    for (const item of provider.search(query, context)) {
      if (!deduplicated.has(item.key)) deduplicated.set(item.key, item);
    }
  }
  return [...deduplicated.values()].sort(
    (left, right) =>
      GROUP_ORDER[left.group] - GROUP_ORDER[right.group] ||
      left.score - right.score ||
      left.key.localeCompare(right.key),
  );
}
