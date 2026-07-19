import osxSign from "@electron/osx-sign";

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

export default async function signT4MacApp(options) {
  const sign = osxSign.sign ?? osxSign;
  await sign({
    ...options,
    optionsForFile: createT4MacOptionsForFile(options.optionsForFile),
  });
}
