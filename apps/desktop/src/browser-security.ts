import { app } from "electron";
import type { BrowserProfile } from "@t4-code/protocol/browser-ipc";
import type { BrowserWindow, Certificate, Event, Session, WebContents } from "electron";
import type { BrowserAuthController, BrowserAuthControllerOptions } from "./browser-auth.ts";
import { createBrowserAuthController } from "./browser-auth.ts";
import { createBrowserProxyController, type BrowserProxyResult, type BrowserSystemProxySettings } from "./browser-proxy.ts";

const MAX_TEXT_BYTES = 8_192;
const MAX_GRANT_LIFETIME_MS = 10 * 60_000;
type BrowserCancelableEvent = { readonly preventDefault: () => void };
type PermissionRequestDetails = { readonly requestingUrl?: string; readonly isMainFrame?: boolean };
type PermissionRequestHandler = (contents: WebContents, permission: string, callback: (allowed: boolean) => void, details?: PermissionRequestDetails) => void;
const ALLOWED_NAVIGATION_SCHEMES = new Set(["http:", "https:"]);

export type PopupRequest = {
  readonly url: string;
  readonly frameName: string;
  readonly disposition: string;
  readonly referrer: string;
};

export type DownloadRequest = { readonly url: string; readonly filename: string };
export type PermissionRequest = { readonly permission: string; readonly origin: string; readonly isMainFrame: boolean; readonly webContents: WebContents };
export type CertificateRequest = { readonly url: string; readonly scheme: string; readonly host: string; readonly port: number; readonly fingerprint: string; readonly method: "GET" | "HEAD"; readonly error: string; readonly isMainFrame: boolean };

export interface BrowserCertificateGrant {
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly method: "GET" | "HEAD";
}

export interface BrowserSurfaceSecurityOptions {
  readonly webContents: WebContents;
  readonly session: Session;
  readonly profile: BrowserProfile;
  readonly window?: BrowserWindow;
  readonly onPopup?: (request: PopupRequest) => boolean;
  readonly onDownload?: (request: DownloadRequest) => boolean;
  readonly onPermissionPrompt?: (request: PermissionRequest) => boolean;
  readonly onCertificateError?: (request: CertificateRequest) => boolean;
  readonly auth?: BrowserAuthControllerOptions;
}

export interface BrowserSurfaceSecurityController {
  readonly auth: BrowserAuthController | null;
  dispose(): void;
  clearTrustGrants(): void;
  grantCertificate(grant: Omit<BrowserCertificateGrant, "expiresAt"> & { readonly expiresAt?: number }): boolean;
  setProfile(profile: BrowserProfile): void;
  configureProxy(settings: BrowserSystemProxySettings): Promise<BrowserProxyResult>;
}

interface SessionPermissionState {
  readonly policies: Map<WebContents, PermissionRequestHandler>;
  readonly requestHandler: PermissionRequestHandler;
}

const sessionPermissionStates = new WeakMap<Session, SessionPermissionState>();

function registerSessionPermissionPolicy(session: Session, webContents: WebContents, policy: PermissionRequestHandler): () => void {
  let state = sessionPermissionStates.get(session);
  if (!state) {
    const policies = new Map<WebContents, PermissionRequestHandler>();
    const requestHandler: PermissionRequestHandler = (contents, permission, callback, details) => {
      const currentPolicy = policies.get(contents);
      if (!currentPolicy) {
        callback(false);
        return;
      }
      currentPolicy(contents, permission, callback, details);
    };
    state = { policies, requestHandler };
    sessionPermissionStates.set(session, state);
    session.setPermissionRequestHandler(requestHandler);
    session.setPermissionCheckHandler(() => false);
  }
  state.policies.set(webContents, policy);

  return (): void => {
    if (state.policies.get(webContents) !== policy) return;
    state.policies.delete(webContents);
    if (state.policies.size > 0) return;
    sessionPermissionStates.delete(session);
    session.setPermissionRequestHandler(null);
    session.setPermissionCheckHandler(null);
  };
}

function text(value: unknown, max = MAX_TEXT_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= max;
}

function safeUrl(value: string): URL | null {
  if (!text(value)) return null;
  try { return new URL(value); } catch { return null; }
}

function certificateKey(scheme: string, host: string, port: number, fingerprint: string): string {
  return `${scheme.toLowerCase()}|${host.toLowerCase()}|${port}|${fingerprint.toLowerCase().replaceAll(":", "")}`;
}

function certificateData(url: string, certificate: Certificate): { scheme: string; host: string; port: number; fingerprint: string } | null {
  const parsed = safeUrl(url);
  const fingerprint = text(certificate.fingerprint, 512) ? certificate.fingerprint : null;
  if (!parsed || !ALLOWED_NAVIGATION_SCHEMES.has(parsed.protocol) || !parsed.hostname || !fingerprint) return null;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { scheme: parsed.protocol.slice(0, -1), host: parsed.hostname.toLowerCase(), port, fingerprint };
}

function popupRequest(url: string, frameName: string, disposition: string, referrer: string): PopupRequest | null {
  if (!text(url) || typeof frameName !== "string" || new TextEncoder().encode(frameName).byteLength > 512 || typeof disposition !== "string" || new TextEncoder().encode(disposition).byteLength > 128 || typeof referrer !== "string" || new TextEncoder().encode(referrer).byteLength > MAX_TEXT_BYTES) return null;
  return { url, frameName, disposition, referrer };
}

export function installBrowserSurfaceSecurity(options: BrowserSurfaceSecurityOptions): BrowserSurfaceSecurityController {
  const { webContents, session } = options;
  const grants = new Map<string, BrowserCertificateGrant>();
  const auth = options.auth ? createBrowserAuthController(options.auth) : null;
  const proxy = createBrowserProxyController(session);
  let profile = options.profile;
  let disposed = false;

  const permissionRequest: PermissionRequestHandler = (contents, permission, callback, details) => {
    if (disposed || permission === "openExternal") { callback(false); return; }
    const origin = details?.requestingUrl ?? contents.getURL();
    const parsedOrigin = text(origin) ? safeUrl(origin) : null;
    let allowed = false;
    if (parsedOrigin && ALLOWED_NAVIGATION_SCHEMES.has(parsedOrigin.protocol) && options.onPermissionPrompt) {
      try { allowed = options.onPermissionPrompt({ permission, origin, isMainFrame: details?.isMainFrame === true, webContents: contents }) === true; } catch { allowed = false; }
    }
    callback(allowed);
  };
  const disposePermissionPolicy = registerSessionPermissionPolicy(session, webContents, permissionRequest);

  const downloadHandler = (event: BrowserCancelableEvent, item: Electron.DownloadItem, contents: WebContents): void => {
    if (contents !== webContents) return;
    const url = item.getURL();
    const filename = item.getFilename();
    const parsed = safeUrl(url);
    let allowed = false;
    if (parsed && ALLOWED_NAVIGATION_SCHEMES.has(parsed.protocol) && text(filename, 512) && options.onDownload) {
      try { allowed = options.onDownload({ url, filename }) === true; } catch { allowed = false; }
    }
    if (!allowed) event.preventDefault();
  };
  session.on("will-download", downloadHandler);
  const webviewHandler = (event: BrowserCancelableEvent): void => event.preventDefault();
  webContents.on("will-attach-webview", webviewHandler);
  const navigateHandler = (event: BrowserCancelableEvent, url: string, _isInPlace: boolean, isMainFrame: boolean): void => {
    if (!isMainFrame) return;
    grants.clear();
    const parsed = safeUrl(url);
    if (!parsed || !ALLOWED_NAVIGATION_SCHEMES.has(parsed.protocol)) event.preventDefault();
  };
  webContents.on("will-navigate", navigateHandler);
  const startNavigationHandler = (_event: BrowserCancelableEvent, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame && !isInPlace) grants.clear();
  };
  webContents.on("did-start-navigation", startNavigationHandler);

  const windowOpenHandler = (details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse => {
    const request = popupRequest(details.url, details.frameName, details.disposition, details.referrer.url);
    const parsed = request ? safeUrl(request.url) : null;
    if (!request || !parsed || !ALLOWED_NAVIGATION_SCHEMES.has(parsed.protocol) || !options.onPopup) return { action: "deny" };
    try { void options.onPopup(request); } catch { /* a failed managed popup must not create Electron's child */ }
    return { action: "deny" };
  };
  webContents.setWindowOpenHandler(windowOpenHandler);
  const certificateHandler = (event: BrowserCancelableEvent, url: string, error: string, certificate: Certificate, callback: (isTrusted: boolean) => void, isMainFrame: boolean): void => {
    event.preventDefault();
    const data = certificateData(url, certificate);
    if (!data || !isMainFrame) { callback(false); return; }
    const request: CertificateRequest = { url, ...data, method: "GET", error: text(error, 512) ? error : "certificate-error", isMainFrame };
    const key = certificateKey(data.scheme, data.host, data.port, data.fingerprint);
    const grant = grants.get(key);
    const now = Date.now();
    if (grant && grant.expiresAt > now && (grant.method === "GET" || grant.method === "HEAD")) {
      let approved = !options.onCertificateError;
      if (options.onCertificateError) {
        try { approved = options.onCertificateError(request) === true; } catch { approved = false; }
      }
      if (grant.expiresAt <= now + MAX_GRANT_LIFETIME_MS && approved) { callback(true); return; }
    }
    callback(false);
  };
  webContents.on("certificate-error", certificateHandler);
  const authLoginHandler = (event: Event, contents: WebContents, details: Electron.AuthenticationResponseDetails, authInfo: Electron.AuthInfo, callback: (username?: string, password?: string) => void): void => {
    if (disposed || contents !== webContents) return;
    auth?.handleLogin(event, contents, details, authInfo, callback);
  };
  if (auth) app.on("login", authLoginHandler);

  return {
    auth,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      grants.clear();
      disposePermissionPolicy();
      session.off("will-download", downloadHandler);
      webContents.off("will-attach-webview", webviewHandler);
      webContents.off("will-navigate", navigateHandler);
      webContents.off("did-start-navigation", startNavigationHandler);
      webContents.off("certificate-error", certificateHandler);
      if (auth) app.off("login", authLoginHandler);
      webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      auth?.dispose();
      void proxy.dispose();
    },
    clearTrustGrants(): void { grants.clear(); },
    grantCertificate(grant): boolean {
      if (disposed || !text(grant.scheme, 32) || !text(grant.host, 512) || grant.host.includes("*") || !text(grant.fingerprint, 512) || !/^[a-f0-9:]+$/iu.test(grant.fingerprint) || !Number.isInteger(grant.port) || grant.port < 1 || grant.port > 65_535 || (grant.method !== "GET" && grant.method !== "HEAD")) return false;
      const parsedScheme = grant.scheme.toLowerCase().replace(/:$/u, "");
      if (parsedScheme !== "http" && parsedScheme !== "https") return false;
      const expiry = grant.expiresAt ?? Date.now() + MAX_GRANT_LIFETIME_MS;
      if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + MAX_GRANT_LIFETIME_MS) return false;
      const value: BrowserCertificateGrant = { scheme: parsedScheme, host: grant.host.toLowerCase(), port: grant.port, fingerprint: grant.fingerprint, expiresAt: expiry, method: grant.method };
      grants.set(certificateKey(value.scheme, value.host, value.port, value.fingerprint), value);
      return true;
    },
    setProfile(nextProfile): void {
      if (nextProfile.profileId !== profile.profileId || nextProfile.kind !== profile.kind) grants.clear();
      profile = nextProfile;
    },
    configureProxy(settings): Promise<BrowserProxyResult> { return proxy.configure(settings); },
  };
}

export type { BrowserAuthControllerOptions } from "./browser-auth.ts";
export type { BrowserProxyResult, BrowserSystemProxySettings } from "./browser-proxy.ts";
