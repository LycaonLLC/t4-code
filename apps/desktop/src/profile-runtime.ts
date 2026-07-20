import type {
  LocalProfile,
  LocalProfileAddRequest,
  LocalProfileUpdateRequest,
  ServiceAvailabilityIssue,
  ServiceInspection,
} from "@t4-code/protocol/desktop-ipc";
import type { ServiceManager } from "@t4-code/service-manager";
import {
  LocalProfileRegistry,
  localTargetId,
  type LocalProfileRecord,
} from "./local-profiles.ts";

type ProfileAction = "start" | "stop" | "restart";

export interface ProfileTargetRuntime {
  connect(targetId: string): Promise<"connecting" | "connected">;
  disconnect(targetId: string): Promise<void>;
}

export interface LocalProfileRuntimeOptions {
  readonly registry: LocalProfileRegistry;
  readonly targets: ProfileTargetRuntime;
  readonly acquireServiceManager: (profileId: string) => Promise<ServiceManager | undefined>;
  readonly releaseServiceManager?: (profileId: string) => void;
  readonly getServiceAvailabilityIssue?: (
    profileId: string,
  ) => ServiceAvailabilityIssue | undefined;
}

function unavailableInspection(issue?: ServiceAvailabilityIssue): ServiceInspection {
  return {
    definition: "missing",
    service: "unknown",
    diagnostics: "",
    issue: issue ?? {
      code: "service_unavailable",
      message: "The local T4 host is unavailable. Check the OMP installation and try again.",
    },
  };
}

function publicProfile(record: LocalProfileRecord, service: ServiceInspection): LocalProfile {
  return Object.freeze({
    profileId: record.profileId,
    label: record.label,
    targetId: localTargetId(record.profileId),
    autoStart: record.autoStart,
    isDefault: record.profileId === "default",
    service: Object.freeze({ ...service }),
  });
}

export class LocalProfileRuntime {
  private readonly registry: LocalProfileRegistry;
  private readonly targets: ProfileTargetRuntime;
  private readonly acquireManager: LocalProfileRuntimeOptions["acquireServiceManager"];
  private readonly releaseManager: NonNullable<LocalProfileRuntimeOptions["releaseServiceManager"]>;
  private readonly availabilityIssue: NonNullable<LocalProfileRuntimeOptions["getServiceAvailabilityIssue"]>;
  private readonly queues = new Map<string, { tail: Promise<void> }>();

  constructor(options: LocalProfileRuntimeOptions) {
    this.registry = options.registry;
    this.targets = options.targets;
    this.acquireManager = options.acquireServiceManager;
    this.releaseManager = options.releaseServiceManager ?? (() => undefined);
    this.availabilityIssue = options.getServiceAvailabilityIssue ?? (() => undefined);
  }

  async list(): Promise<readonly LocalProfile[]> {
    const records = await this.registry.list();
    return Promise.all(records.map((record) => this.inspectRecord(record)));
  }

  add(input: LocalProfileAddRequest["profile"]): Promise<LocalProfile> {
    return this.enqueue(input.profileId, async () => {
      const record = await this.registry.add(input);
      return this.inspectRecord(record);
    });
  }

  update(input: LocalProfileUpdateRequest): Promise<LocalProfile> {
    return this.enqueue(input.profileId, async () => {
      const record = await this.registry.update(input.profileId, input.changes);
      return this.inspectRecord(record);
    });
  }

  status(profileId: string): Promise<LocalProfile> {
    return this.enqueue(profileId, async () => this.inspectRecord(await this.registry.get(profileId)));
  }

  action(profileId: string, action: ProfileAction): Promise<LocalProfile> {
    return this.enqueue(profileId, async () => {
      const record = await this.registry.get(profileId);
      const manager = await this.requireManager(profileId);
      if (action === "stop") {
        await this.targets.disconnect(localTargetId(profileId));
        const before = await manager.inspect();
        if (["running", "starting", "failed"].includes(before.service)) await manager.stop();
      } else {
        const before = await manager.inspect();
        if (before.definition !== "current") {
          // Installation is also a repair transaction and starts the service.
          await manager.install();
        } else if (action === "restart") {
          await manager.restart();
        } else if (before.service !== "running") {
          await manager.start();
        }
        const inspection = await manager.inspect();
        if (inspection.service === "running") {
          await this.targets.connect(localTargetId(profileId));
        }
        return publicProfile(record, inspection);
      }
      return publicProfile(record, await manager.inspect());
    });
  }

  remove(profileId: string): Promise<void> {
    return this.enqueue(profileId, async () => {
      await this.registry.get(profileId);
      if (profileId === "default") throw new Error("default profile is immutable");
      await this.targets.disconnect(localTargetId(profileId));
      const manager = await this.acquireManager(profileId);
      if (manager !== undefined) {
        const inspection = await manager.inspect();
        if (
          inspection.definition !== "missing" ||
          ["running", "starting", "failed"].includes(inspection.service)
        ) await manager.uninstall();
      }
      await this.registry.remove(profileId);
      this.releaseManager(profileId);
    });
  }

  /** Start and connect opt-in profiles; each profile remains failure-isolated. */
  async startAutomaticProfiles(onError?: (profileId: string, error: unknown) => void): Promise<void> {
    const profiles = await this.registry.list();
    await Promise.all(profiles.filter(
      (profile) => profile.autoStart && profile.profileId !== "default",
    ).map(async (profile) => {
      try {
        await this.action(profile.profileId, "start");
      } catch (error) {
        onError?.(profile.profileId, error);
      }
    }));
  }

  private async inspectRecord(record: LocalProfileRecord): Promise<LocalProfile> {
    const manager = await this.acquireManager(record.profileId);
    if (manager === undefined)
      return publicProfile(record, unavailableInspection(this.availabilityIssue(record.profileId)));
    try {
      return publicProfile(record, await manager.inspect());
    } catch {
      return publicProfile(record, unavailableInspection(this.availabilityIssue(record.profileId)));
    }
  }

  private async requireManager(profileId: string): Promise<ServiceManager> {
    const manager = await this.acquireManager(profileId);
    if (manager === undefined) {
      throw new Error(
        this.availabilityIssue(profileId)?.message ?? "The local T4 host is unavailable.",
      );
    }
    return manager;
  }

  private enqueue<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(profileId);
    if (queue === undefined) {
      queue = { tail: Promise.resolve() };
      this.queues.set(profileId, queue);
    }
    const result = queue.tail.then(operation, operation);
    queue.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
