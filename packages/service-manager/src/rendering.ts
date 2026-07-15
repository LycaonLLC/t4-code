import {
  ServiceValidationError,
  type ServiceSpec,
} from "./contracts.ts";

const MAX_PATH = 4096;
const MAX_ARG = 2048;
const MAX_ARGS = 128;
const MAX_PROFILE = 32;
const SAFE_ENV_KEYS: Record<string, true> = { OMP_LOG_LEVEL: true, OMP_PROFILE: true };
const SECRET_KEY = /(token|secret|password|credential|authorization|api[_-]?key|private[_-]?key)/i;

function invalid(message: string): never {
  throw new ServiceValidationError(message);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateText(value: string, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    hasControlCharacter(value) ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    invalid(`Invalid ${label}.`);
  }
  return value;
}

export function validateAbsolutePath(value: string, label: string): string {
  validateText(value, label, MAX_PATH);
  if (!value.startsWith("/") || value.includes("\0"))
    invalid(`Invalid ${label}: absolute path required.`);
  return value;
}

function validateProfile(value: string): string {
  validateText(value, "profile id", MAX_PROFILE);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value)) invalid("Invalid profile id.");
  return value;
}

export function validateSpec(spec: ServiceSpec): ServiceSpec {
  const profileId = validateProfile(spec.profileId);
  const executable = validateAbsolutePath(spec.executable, "executable");
  if (!Array.isArray(spec.argv) || spec.argv.length > MAX_ARGS) invalid("Invalid argv.");
  const argv = spec.argv.map((value, index) => validateText(value, `argv[${index}]`, MAX_ARG));
  const executableName = executable.slice(executable.lastIndexOf("/") + 1);
  if (executableName === "omp") {
    if (argv.length !== 2 || argv[0] !== "appserver" || argv[1] !== "serve")
      invalid("Unsupported omp appserver argv.");
  } else if (executableName === "ompd") {
    if (argv.length !== 0) invalid("Unsupported ompd argv.");
  } else {
    invalid("Executable must be omp or ompd.");
  }
  const logsDirectory = validateAbsolutePath(spec.logsDirectory, "logs directory");
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.environment ?? {})) {
    validateText(key, "environment key", 128);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || SECRET_KEY.test(key) || SAFE_ENV_KEYS[key] !== true)
      invalid("Environment key is not permitted.");
    environment[key] = validateText(value, `environment value for ${key}`, MAX_ARG);
  }
  return { profileId, executable, argv, logsDirectory, environment };
}

export function quoteSystemd(value: string, max = MAX_ARG): string {
  validateText(value, "systemd argument", max);
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`").replaceAll("%", "%%")}"`;
}

export function escapeXml(value: string): string {
  validateText(value, "plist value", MAX_ARG);
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellFreeExec(spec: ServiceSpec): string {
  return [spec.executable, ...spec.argv].map((value) => quoteSystemd(value)).join(" ");
}

function systemdFilePath(path: string): string {
  return /[\s"'\\$`%]/.test(path) ? quoteSystemd(path, MAX_PATH) : path;
}

export function renderSystemd(spec: ServiceSpec, _label: string): string {
  const env = Object.entries(spec.environment ?? {})
    .map(([key, value]) => `Environment=${quoteSystemd(`${key}=${value}`)}`)
    .join("\n");
  return [
    "[Unit]",
    `Description=Oh My Pi appserver (${spec.profileId})`,
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${shellFreeExec(spec)}`,
    // The appserver owns independent session workers. If the kernel kills one
    // runaway worker under memory pressure, keep the broker (and unrelated
    // sessions) alive instead of treating the child OOM as a unit failure.
    // This is isolation, not a memory limit: workers retain the full host
    // environment and available memory.
    "OOMPolicy=continue",
    "Restart=on-failure",
    "UMask=0077",
    `StandardOutput=append:${systemdFilePath(`${spec.logsDirectory}/appserver.log`)}`,
    `StandardError=append:${systemdFilePath(`${spec.logsDirectory}/appserver.error.log`)}`,
    ...(env ? [env] : []),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderPlist(spec: ServiceSpec, label: string): string {
  const args = [spec.executable, ...spec.argv]
    .map((arg) => `      <string>${escapeXml(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(spec.environment ?? {})
    .flatMap(([key, value]) => [
      `      <key>${escapeXml(key)}</key>`,
      `      <string>${escapeXml(value)}</string>`,
    ])
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    `    <key>Label</key><string>${escapeXml(label)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    args,
    "    </array>",
    "    <key>RunAtLoad</key><true/>",
    "    <key>KeepAlive</key>",
    "    <dict><key>SuccessfulExit</key><false/></dict>",
    "    <key>Umask</key><integer>63</integer>",
    `    <key>StandardOutPath</key><string>${escapeXml(spec.logsDirectory)}/appserver.log</string>`,
    `    <key>StandardErrorPath</key><string>${escapeXml(spec.logsDirectory)}/appserver.error.log</string>`,
    ...(envEntries
      ? ["    <key>EnvironmentVariables</key>", "    <dict>", envEntries, "    </dict>"]
      : []),
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

function redactControlCharacters(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    result += code <= 0x1f || code === 0x7f ? " " : value[index];
  }
  return result;
}

export function sanitizeDiagnostic(value: string): string {
  const bounded = value
    .replaceAll(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replaceAll(
      /([A-Za-z0-9_-]*(?:token|secret|password|credential|authorization|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
  return redactControlCharacters(bounded).trim().slice(0, 512);
}
