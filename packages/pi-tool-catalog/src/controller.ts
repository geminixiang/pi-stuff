import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  buildDescriptors,
  canActivateAutomatically,
  CATALOG_TOOL_NAMES,
  type CatalogPaths,
  type LoadedCatalog,
  loadCatalog,
  searchDescriptors,
  type ToolDescriptor,
} from "./catalog.js";

export interface ToolRuntime {
  getAllTools(): ToolInfo[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface ActivationResult {
  activated: string[];
  blocked: string[];
  missing: string[];
}

export class CatalogController {
  readonly runtime: ToolRuntime;
  readonly paths: CatalogPaths;
  loaded: LoadedCatalog = {
    config: {},
    sources: new Map(),
    projectConfigured: new Set(),
    warnings: [],
  };
  private readonly deferredOwnership = new Set<string>();
  private readonly activatedOwnership = new Set<string>();

  constructor(runtime: ToolRuntime, paths: CatalogPaths) {
    this.runtime = runtime;
    this.paths = paths;
  }

  descriptors(): ToolDescriptor[] {
    return buildDescriptors(
      this.runtime.getAllTools(),
      this.loaded,
      new Set(this.runtime.getActiveTools()),
    );
  }

  async reload(projectTrusted = false): Promise<string[]> {
    this.loaded = await loadCatalog(this.paths, projectTrusted);
    const configuredDeferred = new Set(
      this.descriptors()
        .filter((descriptor) => descriptor.deferred && descriptor.source !== "derived")
        .map((descriptor) => descriptor.name),
    );
    const newlyDeferred = [...configuredDeferred].filter(
      (name) => !this.deferredOwnership.has(name),
    );

    // Read immediately before writing so unrelated runtime mutations are preserved. A tool
    // already under our deferred ownership is not removed again: another extension may have
    // deliberately enabled it since our previous mutation.
    this.mutateActive((active) => {
      for (const name of newlyDeferred) active.delete(name);
    });

    for (const name of this.deferredOwnership) {
      if (!configuredDeferred.has(name)) {
        this.deferredOwnership.delete(name);
        this.activatedOwnership.delete(name);
      }
    }
    for (const name of configuredDeferred) this.deferredOwnership.add(name);
    return this.loaded.warnings;
  }

  search(query: string, limit: number): ToolDescriptor[] {
    return searchDescriptors(this.descriptors(), query, limit);
  }

  activate(names: string[], automatic: boolean): ActivationResult {
    const descriptors = new Map(
      this.descriptors().map((descriptor) => [descriptor.name, descriptor]),
    );
    const result: ActivationResult = { activated: [], blocked: [], missing: [] };
    const toActivate: string[] = [];
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (!descriptor) result.missing.push(name);
      else if (
        !this.deferredOwnership.has(name) ||
        descriptor.source === "derived" ||
        (automatic && !canActivateAutomatically(descriptor))
      ) {
        result.blocked.push(name);
      } else {
        toActivate.push(name);
        result.activated.push(name);
      }
    }
    this.mutateActive((active) => {
      for (const name of toActivate) active.add(name);
    });
    for (const name of toActivate) this.activatedOwnership.add(name);
    return result;
  }

  deactivate(names: string[]): ActivationResult {
    const available = new Set(this.runtime.getAllTools().map((tool) => tool.name));
    const result: ActivationResult = { activated: [], blocked: [], missing: [] };
    const toDeactivate: string[] = [];
    for (const name of names) {
      if (!available.has(name)) result.missing.push(name);
      else if (CATALOG_TOOL_NAMES.has(name) || !this.activatedOwnership.has(name)) {
        result.blocked.push(name);
      } else {
        toDeactivate.push(name);
      }
    }
    this.mutateActive((active) => {
      for (const name of toDeactivate) active.delete(name);
    });
    for (const name of toDeactivate) this.activatedOwnership.delete(name);
    return result;
  }

  private mutateActive(mutate: (active: Set<string>) => void): void {
    const active = new Set(this.runtime.getActiveTools());
    mutate(active);
    for (const name of CATALOG_TOOL_NAMES) active.add(name);
    this.runtime.setActiveTools([...active]);
  }
}
