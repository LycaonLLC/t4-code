export const DEFAULT_PROFILE_ID = "default";

const MAX_URL_LENGTH = 2_048;
const MAX_PROFILE_ID_LENGTH = 64;

export interface CompanionHost {
  readonly version: 1;
  readonly endpointKey: string;
  readonly origin: string;
  readonly profileId: string;
  readonly wsUrl: string;
  readonly label: string;
  readonly deviceId: string;
  readonly deviceToken?: string;
}

function normalizeProfileId(value?: string): string {
  const profile = value?.trim() || DEFAULT_PROFILE_ID;
  if (
    profile.length > MAX_PROFILE_ID_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)
  ) {
    throw new Error("Use letters, numbers, dots, dashes, or underscores for the profile ID.");
  }
  return profile;
}

function deviceId(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `t4-companion-${Date.now().toString(36)}-${random}`;
}

export function parseCompanionHost(
  value: string,
  profileValue?: string,
  existing?: Pick<CompanionHost, "endpointKey" | "deviceId" | "deviceToken">,
): CompanionHost {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("Enter the HTTPS address shown by T4 Code on your computer.");
  if (trimmed.length > MAX_URL_LENGTH) throw new Error("That address is too long.");

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter a valid HTTPS Tailnet address.");
  }
  if (url.protocol !== "https:") throw new Error("Use the HTTPS address, not HTTP.");
  if (url.username !== "" || url.password !== "") throw new Error("The address cannot include credentials.");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Enter the host address only, without a path, query, or fragment.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "ts.net" || !hostname.endsWith(".ts.net")) {
    throw new Error("Use the full Tailscale hostname ending in .ts.net.");
  }

  const profileId = normalizeProfileId(profileValue);
  const endpointKey = `${url.origin}#profile=${profileId}`;
  const websocket = new URL(url.origin);
  websocket.protocol = "wss:";
  websocket.pathname =
    profileId === DEFAULT_PROFILE_ID
      ? "/v1/ws"
      : `/v1/profiles/${encodeURIComponent(profileId)}/ws`;

  return Object.freeze({
    version: 1,
    endpointKey,
    origin: url.origin,
    profileId,
    wsUrl: websocket.toString(),
    label: `T4 on ${hostname.slice(0, hostname.indexOf("."))}`,
    deviceId: existing?.deviceId ?? deviceId(),
    ...(existing?.endpointKey !== endpointKey || existing.deviceToken === undefined
      ? {}
      : { deviceToken: existing.deviceToken }),
  });
}
