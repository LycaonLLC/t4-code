// React face of the read-aloud controller: one app-wide controller bound to
// the resolved shell port, a subscription hook for message rows, and the
// quiet per-message action that sits beside the copy affordance. When the
// shell carries no speech contract the action does not render at all — no
// dead buttons, no explanation demanded from the reader.
import { IconButton, Tooltip, TooltipPopup, TooltipTrigger } from "@t4-code/ui";
import { Square, Volume2 } from "lucide-react";
import { useSyncExternalStore } from "react";

import { rendererPlatform } from "../../state/store-instance.ts";
import {
  createReadAloudController,
  READ_ALOUD_LABEL,
  STOP_READING_LABEL,
  type ReadAloudController,
  type ReadAloudState,
} from "./read-aloud.ts";

let sharedController: ReadAloudController | null = null;

export function getReadAloudController(): ReadAloudController {
  sharedController ??= createReadAloudController(rendererPlatform.shell);
  return sharedController;
}

export function useReadAloud(): { controller: ReadAloudController; state: ReadAloudState } {
  const controller = getReadAloudController();
  const state = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getState(),
    () => controller.getState(),
  );
  return { controller, state };
}

export function ReadAloudButton({
  messageId,
  text,
  speaking,
  onToggle,
}: {
  readonly messageId: string;
  readonly text: string;
  readonly speaking: boolean;
  readonly onToggle: (messageId: string, text: string) => void;
}) {
  const label = speaking ? STOP_READING_LABEL : READ_ALOUD_LABEL;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <IconButton
            aria-label={label}
            aria-pressed={speaking}
            className="size-11 sm:size-6"
            onClick={() => onToggle(messageId, text)}
            size="icon-xs"
          >
            {speaking ? (
              <Square aria-hidden="true" className="text-foreground" />
            ) : (
              <Volume2 aria-hidden="true" />
            )}
          </IconButton>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
