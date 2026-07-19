const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// T4's shared protocol packages publish TypeScript source while using the
// standards-friendly `.js` import spelling expected after compilation. Metro
// does not map those relative imports back to `.ts` by default, so retry the
// same request without the output extension when the importer is TypeScript.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isTypeScriptImporter = /\.[cm]?tsx?$/.test(context.originModulePath);
  const isRelativeJavaScriptImport = moduleName.startsWith(".") && moduleName.endsWith(".js");

  if (isTypeScriptImporter && isRelativeJavaScriptImport) {
    return context.resolveRequest(context, moduleName.slice(0, -3), platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
