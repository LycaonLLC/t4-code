// `sign` is the deprecated callback API and returns before signing finishes.
// electron-builder needs this Promise API so notarization cannot race signing.
import { signAsync } from "@electron/osx-sign";

export const OMP_RUNTIME_ENTITLEMENTS = "apps/desktop/build/entitlements.omp-runtime.plist";
export const macSigner = signAsync;

export function isBundledOmpRuntime(filePath) {
  return /[/\\]Contents[/\\]Resources[/\\]runtime[/\\]omp$/u.test(filePath);
}

export function createT4MacOptionsForFile(baseOptionsForFile) {
  return (filePath) => {
    const base = baseOptionsForFile?.(filePath) ?? {};
    if (!isBundledOmpRuntime(filePath)) return base;
    return { ...base, entitlements: OMP_RUNTIME_ENTITLEMENTS };
  };
}

export function normalizeMacSignOptions(input) {
  if (typeof input?.app === "string") return input;
  if (typeof input?.path === "string" && input.options && typeof input.options === "object") {
    return { ...input.options, app: input.path };
  }
  throw new Error("macOS signing callback did not provide an application path");
}

export default async function signT4MacApp(input) {
  const options = normalizeMacSignOptions(input);
  await macSigner({
    ...options,
    optionsForFile: createT4MacOptionsForFile(options.optionsForFile),
  });
}
