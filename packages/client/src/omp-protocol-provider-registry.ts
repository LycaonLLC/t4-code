import { OMP_SERVER_EVENT_KINDS } from "@t4-code/protocol";
import { ompAppV1ProtocolProvider } from "./omp-app-v1-protocol-provider.ts";
import type { OmpProtocolProvider } from "./omp-protocol-provider.ts";

const knownServerEventKinds: ReadonlySet<string> = new Set(OMP_SERVER_EVENT_KINDS);

function registryKey(value: string, label: string): string {
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (value.length === 0 || value.length > 128 || hasControlCharacter) {
    throw new Error(`invalid protocol provider ${label}`);
  }
  return value;
}

function validateProvider(provider: OmpProtocolProvider): OmpProtocolProvider {
  registryKey(provider.id, "id");
  registryKey(provider.protocolVersion, "version");
  if (!Array.isArray(provider.serverEventKinds) || provider.serverEventKinds.length === 0) {
    throw new Error(`protocol provider ${provider.id} must declare server event kinds`);
  }
  const eventKinds = new Set<string>();
  for (const kind of provider.serverEventKinds) {
    registryKey(kind, "server event kind");
    if (!knownServerEventKinds.has(kind)) {
      throw new Error(`unknown protocol provider server event kind: ${kind}`);
    }
    if (eventKinds.has(kind)) {
      throw new Error(`duplicate protocol provider server event kind: ${kind}`);
    }
    eventKinds.add(kind);
  }
  return provider;
}

/** Immutable lookup table for concrete protocol adapters. */
export class OmpProtocolProviderRegistry {
  readonly providers: readonly OmpProtocolProvider[];
  readonly defaultProviderId: string;
  private readonly byId: ReadonlyMap<string, OmpProtocolProvider>;
  private readonly byVersion: ReadonlyMap<string, OmpProtocolProvider>;

  constructor(providers: readonly OmpProtocolProvider[], defaultProviderId = providers[0]?.id) {
    if (providers.length === 0 || defaultProviderId === undefined) {
      throw new Error("at least one protocol provider is required");
    }
    const byId = new Map<string, OmpProtocolProvider>();
    const byVersion = new Map<string, OmpProtocolProvider>();
    for (const candidate of providers) {
      const provider = validateProvider(candidate);
      const id = registryKey(provider.id, "id");
      const version = registryKey(provider.protocolVersion, "version");
      if (byId.has(id)) throw new Error(`duplicate protocol provider id: ${id}`);
      if (byVersion.has(version)) throw new Error(`duplicate protocol version: ${version}`);
      byId.set(id, provider);
      byVersion.set(version, provider);
    }
    const selectedDefault = registryKey(defaultProviderId, "default id");
    if (!byId.has(selectedDefault)) throw new Error(`unknown default protocol provider: ${selectedDefault}`);
    this.providers = Object.freeze([...providers]);
    this.defaultProviderId = selectedDefault;
    this.byId = byId;
    this.byVersion = byVersion;
    Object.freeze(this);
  }

  getById(id: string): OmpProtocolProvider | undefined {
    return this.byId.get(id);
  }

  getByProtocolVersion(version: string): OmpProtocolProvider | undefined {
    return this.byVersion.get(version);
  }

  requireById(id = this.defaultProviderId): OmpProtocolProvider {
    const provider = this.getById(id);
    if (provider === undefined) throw new Error(`unknown protocol provider: ${id}`);
    return provider;
  }
}

export const defaultOmpProtocolProviderRegistry = new OmpProtocolProviderRegistry([
  ompAppV1ProtocolProvider,
]);

export function resolveOmpProtocolProvider(options: {
  readonly protocolProvider?: OmpProtocolProvider;
  readonly protocolProviderId?: string;
  readonly protocolProviderRegistry?: OmpProtocolProviderRegistry;
}): OmpProtocolProvider {
  if (options.protocolProvider !== undefined) {
    if (options.protocolProviderId !== undefined || options.protocolProviderRegistry !== undefined) {
      throw new Error("direct protocol provider cannot be combined with registry selection");
    }
    return validateProvider(options.protocolProvider);
  }
  const registry = options.protocolProviderRegistry ?? defaultOmpProtocolProviderRegistry;
  return registry.requireById(options.protocolProviderId);
}
