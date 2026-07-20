import type { ProxyConfig, Session } from "electron";

const MAX_TEXT_BYTES = 2_048;
const MAX_BYPASS = 64;
const LOOPBACK_BYPASS: string[] = ["<local>", "localhost", "127.0.0.1", "[::1]", "*.local"];
const METADATA_BYPASS: string[] = ["169.254.169.254", "metadata.google.internal", "metadata.google", "100.100.100.200"];

export type BrowserProxyMode = "direct" | "fixed" | "pac" | "wpad" | "system" | "split";

export interface BrowserSystemProxySettings {
  readonly mode?: BrowserProxyMode | string;
  readonly type?: BrowserProxyMode | string;
  readonly proxy?: string;
  readonly http?: string;
  readonly https?: string;
  readonly socks?: string;
  readonly ftp?: string;
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly bypass?: readonly string[];
  readonly noProxy?: readonly string[];
  readonly pacUrl?: string;
  readonly pacScript?: string;
  readonly wpad?: boolean;
  readonly autoDetect?: boolean;
}

export interface BrowserProxyMapping {
  readonly ok: true;
  readonly config: ProxyConfig;
}

export interface BrowserProxyUnsupported {
  readonly ok: false;
  readonly code: "not_supported";
  readonly message: string;
}

export type BrowserProxyResult = BrowserProxyMapping | BrowserProxyUnsupported;

export interface BrowserProxyController {
  configure(settings: BrowserSystemProxySettings): Promise<BrowserProxyResult>;
  dispose(): Promise<void>;
}

function bounded(value: unknown, max = MAX_TEXT_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= max;
}

function unsupported(message: string): BrowserProxyUnsupported {
  return { ok: false, code: "not_supported", message };
}

function endpoint(value: unknown): { readonly scheme: string; readonly authority: string } | null {
  if (!bounded(value)) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (!["http:", "https:", "socks4:", "socks5:", "socks5h:"].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || !parsed.hostname) return null;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol.startsWith("socks") ? 1080 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { scheme: parsed.protocol.slice(0, -1), authority: `${parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname}:${port}` };
}

function normalizedBypass(value: readonly string[] | undefined): string {
  const rows = [...LOOPBACK_BYPASS, ...METADATA_BYPASS];
  if (value) {
    if (value.length > MAX_BYPASS) throw new Error("proxy bypass list is too large");
    for (const item of value) {
      if (!bounded(item, 512) || /[;\r\n]/u.test(item)) throw new Error("proxy bypass entry is invalid");
      rows.push(item.trim());
    }
  }
  return [...new Set(rows)].join(",");
}

/** Maps only a single fixed proxy endpoint to Electron's representable rules. */
export function mapBrowserSystemProxy(settings: BrowserSystemProxySettings): BrowserProxyResult {
  if (settings === null || typeof settings !== "object") return unsupported("proxy settings are invalid");
  const rawMode = settings.mode ?? settings.type;
  const mode = typeof rawMode === "string" ? rawMode.toLowerCase() : undefined;
  if (settings.wpad === true || settings.autoDetect === true || mode === "pac" || mode === "wpad" || mode === "auto_detect" || mode === "pac_script" || bounded(settings.pacUrl) || bounded(settings.pacScript)) {
    return unsupported("PAC and WPAD proxy configuration is not supported");
  }
  if (mode === "system") return unsupported("system proxy delegation is not supported");
  if (mode === "split") return unsupported("split proxy configuration is not supported");
  if (mode !== undefined && mode !== "direct" && mode !== "fixed" && mode !== "fixed_servers") return unsupported("proxy mode is not supported");

  let bypass: string;
  try { bypass = normalizedBypass(settings.bypass ?? settings.noProxy); } catch { return unsupported("proxy bypass settings are invalid"); }
  const values = [settings.proxy, settings.http, settings.https, settings.socks, settings.ftp, settings.httpProxy, settings.httpsProxy].filter((value): value is string => value !== undefined);
  if (values.some((value) => !bounded(value))) return unsupported("proxy endpoint is invalid");
  const endpoints = values.map(endpoint);
  if (endpoints.some((value) => value === null)) return unsupported("proxy endpoint is not representable");
  const unique = new Map(endpoints.map((value) => [value!.scheme + "|" + value!.authority, value!]));
  if (unique.size > 1) return unsupported("split proxy routes are not supported");
  const selected = unique.values().next().value;
  if (!selected || mode === "direct" || values.length === 0) return { ok: true, config: { mode: "direct", proxyBypassRules: bypass } };
  const rule = selected.scheme.startsWith("socks")
    ? `socks=${selected.authority}`
    : settings.proxy
      ? `http=${selected.authority};https=${selected.authority};socks=${selected.authority}`
      : settings.socks
        ? `socks=${selected.authority}`
        : settings.https || settings.httpsProxy
          ? `https=${selected.authority}`
          : `http=${selected.authority}`;
  return { ok: true, config: { mode: "fixed_servers", proxyRules: rule, proxyBypassRules: bypass } };
}

export function createBrowserProxyController(targetSession: Session): BrowserProxyController {
  let disposed = false;
  let generation = 0;
  return {
    async configure(settings): Promise<BrowserProxyResult> {
      if (disposed) return unsupported("proxy controller is disposed");
      const mapped = mapBrowserSystemProxy(settings);
      if (!mapped.ok) return mapped;
      const current = ++generation;
      try {
        await targetSession.setProxy(mapped.config);
        if (current !== generation || disposed) return unsupported("proxy configuration was superseded");
        await targetSession.closeAllConnections();
        return mapped;
      } catch {
        return unsupported("proxy configuration could not be applied");
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      generation++;
      try { await targetSession.setProxy({ mode: "direct", proxyBypassRules: [...LOOPBACK_BYPASS, ...METADATA_BYPASS].join(",") }); } catch { /* teardown is best effort */ }
    },
  };
}

export const mapSystemProxy = mapBrowserSystemProxy;
