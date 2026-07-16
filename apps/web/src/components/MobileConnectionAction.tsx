import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  IconButton,
  Spinner,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@t4-code/ui";
import { ArrowLeft, Cable, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import {
  nativeMobilePlatform,
  readStoredMobileBackendDirectory,
  removeNativeMobileBackend,
  selectStoredMobileBackend,
  writeStoredMobileBackend,
} from "../platform/native-mobile.ts";
import { TailnetAddressForm } from "./MobileConnectionScreen.tsx";

type ManagerView = { kind: "hosts" } | { kind: "add" } | { kind: "remove"; origin: string };

/**
 * Switch the active host without removing any saved host or credential.
 * Reloads only after the selection reports success.
 */
export function performHostSwitch(
  origin: string,
  io: { readonly select: (origin: string) => void; readonly reload: () => void },
): string | null {
  try {
    io.select(origin);
  } catch (cause) {
    return cause instanceof Error ? cause.message : "T4 Code could not switch hosts.";
  }
  io.reload();
  return null;
}

/**
 * Remove one saved host. Reloads only after its directory entry and scoped
 * credential removal both report success.
 */
export async function performHostRemoval(
  origin: string,
  io: { readonly remove: (origin: string) => Promise<void>; readonly reload: () => void },
): Promise<string | null> {
  try {
    await io.remove(origin);
  } catch (cause) {
    return cause instanceof Error ? cause.message : "T4 Code could not remove that host.";
  }
  io.reload();
  return null;
}

/**
 * Saved-host manager for the phone build. Opening, browsing, and cancelling
 * never mutate storage: switching only re-points the active host, adding only
 * writes after a successful probe, and removing requires an explicit
 * host-specific confirmation.
 */
export function MobileConnectionAction() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ManagerView>({ kind: "hosts" });
  const [busy, setBusy] = useState<"switch" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const addCancellation = useRef<AbortController | null>(null);
  const cancelAddProbe = () => {
    addCancellation.current?.abort();
    addCancellation.current = null;
  };
  const beginAdd = () => {
    cancelAddProbe();
    addCancellation.current = new AbortController();
    setError(null);
    setView({ kind: "add" });
  };
  const openManager = () => {
    cancelAddProbe();
    setView({ kind: "hosts" });
    setBusy(null);
    setError(null);
    setOpen(true);
  };
  if (nativeMobilePlatform() === null) return null;

  let directory = null;
  try {
    directory = readStoredMobileBackendDirectory();
  } catch {
    // The setup screen will repair invalid storage on the next launch.
  }
  const backends = directory?.backends ?? [];
  const activeOrigin = directory?.activeOrigin ?? null;
  const addCancelSignal = addCancellation.current?.signal;
  const removing =
    view.kind === "remove"
      ? (backends.find((backend) => backend.origin === view.origin) ?? null)
      : null;

  const switchToHost = (origin: string) => {
    if (busy !== null) return;
    setBusy("switch");
    setError(null);
    const failure = performHostSwitch(origin, {
      reload: () => window.location.reload(),
      select: selectStoredMobileBackend,
    });
    if (failure !== null) {
      setError(failure);
      setBusy(null);
    }
  };

  const removeHost = (origin: string) => {
    if (busy !== null) return;
    setBusy("remove");
    setError(null);
    void performHostRemoval(origin, {
      reload: () => window.location.reload(),
      remove: removeNativeMobileBackend,
    }).then((failure) => {
      if (failure !== null) {
        setError(failure);
        setBusy(null);
      }
    });
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) cancelAddProbe();
        setOpen(next);
        if (next) {
          setView({ kind: "hosts" });
          setBusy(null);
          setError(null);
        }
      }}
      open={open}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <IconButton
              aria-label="T4 hosts"
              className="size-11 sm:size-7"
              onClick={openManager}
              size="icon-sm"
            >
              <Cable />
            </IconButton>
          }
        />
        <TooltipPopup side="bottom">T4 hosts</TooltipPopup>
      </Tooltip>
      <DialogPopup>
        {view.kind === "hosts" && (
          <>
            <DialogHeader>
              <DialogTitle>T4 hosts</DialogTitle>
              <DialogDescription>
                This phone keeps a saved address and pairing credential for each host. Switching
                hosts removes nothing.
              </DialogDescription>
            </DialogHeader>
            {backends.length === 0 ? (
              <p className="rounded-md bg-secondary px-3 py-2 text-muted-foreground text-sm">
                No saved hosts yet. Add the address shown by the T4 gateway on your computer.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {backends.map((backend) => {
                  const current = backend.origin === activeOrigin;
                  return (
                    <li
                      className="flex min-h-11 items-center gap-1.5 rounded-md border border-border py-1 pr-1 pl-3"
                      key={backend.origin}
                    >
                      <span className="flex min-w-0 flex-1 flex-col py-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium text-sm">{backend.label}</span>
                          {current && <Badge variant="outline">Current</Badge>}
                        </span>
                        <span className="truncate font-mono text-muted-foreground text-xs">
                          {backend.origin}
                        </span>
                      </span>
                      {!current && (
                        <Button
                          className="min-h-11 sm:min-h-8"
                          disabled={busy !== null}
                          onClick={() => switchToHost(backend.origin)}
                          size="sm"
                          variant="outline"
                        >
                          {busy === "switch" && <Spinner />}
                          {busy === "switch" ? "Switching…" : "Switch"}
                        </Button>
                      )}
                      <IconButton
                        aria-label={`Remove ${backend.label}`}
                        className="size-11 sm:size-8"
                        disabled={busy !== null}
                        onClick={() => {
                          setError(null);
                          setView({ kind: "remove", origin: backend.origin });
                        }}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Trash2 />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            )}
            {error !== null && (
              <p className="text-destructive-foreground text-sm" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <DialogClose render={<Button disabled={busy !== null} size="sm" variant="ghost" />}>
                Done
              </DialogClose>
              <Button
                disabled={busy !== null}
                onClick={beginAdd}
                size="sm"
                variant="outline"
              >
                <Plus aria-hidden="true" />
                Add host
              </Button>
            </DialogFooter>
          </>
        )}
        {view.kind === "add" && addCancelSignal !== undefined && (
          <>
            <DialogHeader>
              <DialogTitle>Add a T4 host</DialogTitle>
              <DialogDescription>
                T4 Code checks the address before saving it. Your current host stays saved either
                way.
              </DialogDescription>
            </DialogHeader>
            <TailnetAddressForm
              cancelSignal={addCancelSignal}
              save={writeStoredMobileBackend}
              submitLabel="Check and add"
            />
            <DialogFooter>
              <Button
                onClick={() => {
                  cancelAddProbe();
                  setError(null);
                  setView({ kind: "hosts" });
                }}
                size="sm"
                variant="ghost"
              >
                <ArrowLeft aria-hidden="true" />
                Back to hosts
              </Button>
            </DialogFooter>
          </>
        )}
        {view.kind === "remove" && (
          <>
            <DialogHeader>
              <DialogTitle>Remove {removing?.label ?? "this host"}?</DialogTitle>
              <DialogDescription>
                Removing deletes only this host's saved address and pairing credential from this
                phone. Your computer and its sessions are not touched.
              </DialogDescription>
            </DialogHeader>
            <p className="break-all rounded-md bg-secondary px-3 py-2 font-mono text-sm">
              {removing?.origin ?? view.origin}
            </p>
            {error !== null && (
              <p className="text-destructive-foreground text-sm" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                disabled={busy !== null}
                onClick={() => {
                  setError(null);
                  setView({ kind: "hosts" });
                }}
                size="sm"
                variant="ghost"
              >
                Keep host
              </Button>
              <Button
                disabled={busy !== null || removing === null}
                onClick={() => removeHost(view.origin)}
                size="sm"
                variant="destructive"
              >
                {busy === "remove" && <Spinner />}
                {busy === "remove" ? "Removing…" : "Remove host"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
