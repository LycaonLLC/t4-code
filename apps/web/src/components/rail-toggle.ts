export interface RailToggleState {
  readonly overlaid: boolean;
  readonly overlayOpen: boolean;
  readonly collapsed: boolean;
}

export interface RailTogglePresentation {
  readonly expanded: boolean;
  readonly label: "Show session list" | "Hide session list";
}

/**
 * The titlebar button describes the surface the user can actually see.
 * On narrow screens the sheet owns visibility; the persisted desktop
 * collapse preference is deliberately ignored until the rail docks again.
 */
export function resolveRailTogglePresentation(state: RailToggleState): RailTogglePresentation {
  const expanded = state.overlaid ? state.overlayOpen : !state.collapsed;
  return {
    expanded,
    label: expanded ? "Hide session list" : "Show session list",
  };
}
