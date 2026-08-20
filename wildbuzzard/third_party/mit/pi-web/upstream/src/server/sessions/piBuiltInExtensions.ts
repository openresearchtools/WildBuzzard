import type { CreateAgentSessionServicesOptions } from "@earendil-works/pi-coding-agent";

type ResourceLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;
export type PiBuiltInExtensionFactories = NonNullable<ResourceLoaderOptions["extensionFactories"]>;

interface PiBuiltInExtensionsModule {
  builtInExtensions: PiBuiltInExtensionFactories;
}

export const PI_BUILT_IN_NATIVE_PROVIDER_IDS = new Set(["llama.cpp"]);

let builtInExtensionsPromise: Promise<PiBuiltInExtensionFactories> | undefined;

export function loadPiBuiltInExtensions(): Promise<PiBuiltInExtensionFactories> {
  builtInExtensionsPromise ??= importPiBuiltInExtensions();
  return builtInExtensionsPromise;
}

async function importPiBuiltInExtensions(): Promise<PiBuiltInExtensionFactories> {
  const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const moduleUrl = new URL("./extensions/index.js", packageEntry);
  const module: unknown = await import(moduleUrl.href);
  if (!isPiBuiltInExtensionsModule(module)) throw new Error("Pi did not expose its built-in extensions");
  return module.builtInExtensions;
}

function isPiBuiltInExtensionsModule(value: unknown): value is PiBuiltInExtensionsModule {
  return typeof value === "object"
    && value !== null
    && "builtInExtensions" in value
    && Array.isArray(value.builtInExtensions);
}
