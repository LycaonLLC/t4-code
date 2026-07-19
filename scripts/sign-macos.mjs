import { sign } from "@electron/osx-sign";

export const OMP_RUNTIME_ENTITLEMENTS = "apps/desktop/build/entitlements.omp-runtime.plist";

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
  await sign({
    ...options,
    optionsForFile: createT4MacOptionsForFile(options.optionsForFile),
  });
}
