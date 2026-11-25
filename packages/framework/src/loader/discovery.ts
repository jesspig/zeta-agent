import type { Component } from "@zeta-agent/cordis/types";
import type { Entry } from "@zeta-agent/loader";
import type { HmrUnit } from "./hmr";

/**
 * facet 是单一能力的受控声明；`accepts` 是文档化收窄子类的判定钩子：
 * 返回 false 只是「这个 facet 不适用」，最终仍由 resolve 统一裁决是否 unsupported。
 */
export interface FacetDeclaration {
  readonly kind: "facet";
  readonly name: string;
  readonly component: Component<any>;
  readonly accepts?: (entry: Entry) => boolean;
}

/** package 是一组已声明能力的集合，name 仅用于诊断，不参与键匹配。 */
export interface PackageDeclaration {
  readonly kind: "package";
  readonly name: string;
  readonly components: readonly Component<any>[];
  readonly accepts?: (entry: Entry) => boolean;
}

export type ComponentDeclaration = FacetDeclaration | PackageDeclaration | Component<any>;

export interface ComponentDiscovery {
  resolve(entry: Entry): Component<any>;
  readonly facets: readonly string[];
  readonly packages: readonly string[];
}

function isComponent(value: unknown): value is Component<any> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Component<any>>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    Array.isArray(candidate.inject) &&
    Array.isArray(candidate.provide) &&
    typeof candidate.apply === "function"
  );
}

function rejectUnsupported(value: unknown): never {
  const detail =
    typeof value === "object" && value !== null && "kind" in value
      ? String((value as { kind: unknown }).kind)
      : typeof value;
  throw new Error(`UNSUPPORTED_DISCOVERY_ENTRY: ${detail}`);
}

/**
 * 只接受 facet/package 声明或文档化收窄后的 Component 子类；
 * 无法识别的条目显式抛错，绝不被静默跳过。
 */
export function discoverComponents(declarations: readonly ComponentDeclaration[]): ComponentDiscovery {
  const facets: FacetDeclaration[] = [];
  const packages: PackageDeclaration[] = [];
  for (const declaration of declarations) {
    if (isComponent(declaration)) continue;
    if (typeof declaration !== "object" || declaration === null) rejectUnsupported(declaration);
    if (declaration.kind === "facet") {
      if (!isComponent(declaration.component)) rejectUnsupported(declaration);
      facets.push(declaration);
      continue;
    }
    if (declaration.kind === "package") {
      if (!Array.isArray(declaration.components) || declaration.components.some((item) => !isComponent(item))) {
        rejectUnsupported(declaration);
      }
      packages.push(declaration);
      continue;
    }
    rejectUnsupported(declaration);
  }

  return {
    facets: facets.map((item) => item.name),
    packages: packages.map((item) => item.name),
    resolve(entry) {
      for (const facet of facets) {
        if (facet.name !== entry.name) continue;
        if (facet.accepts !== undefined && !facet.accepts(entry)) continue;
        return facet.component;
      }
      for (const pkg of packages) {
        if (pkg.accepts !== undefined && !pkg.accepts(entry)) continue;
        const match = pkg.components.find((component) => component.name === entry.name);
        if (match !== undefined) return match;
      }
      const bare = declarations.find(
        (item): item is Component<any> => isComponent(item) && item.name === entry.name
      );
      if (bare !== undefined) return bare;
      throw new Error(`UNSUPPORTED_ENTRY: ${entry.name}`);
    },
  };
}

/** HMR 侧的 module 声明：facet 是单模块，package 是多模块集合。 */
export interface ModuleDeclaration {
  readonly id: string;
  readonly entry: string;
  readonly accepts?: readonly string[];
}

export interface FacetModuleSource {
  readonly kind: "facet";
  readonly name: string;
  readonly module: ModuleDeclaration;
  readonly accepts?: (unit: HmrUnit) => boolean;
}

export interface PackageModuleSource {
  readonly kind: "package";
  readonly name: string;
  readonly modules: readonly ModuleDeclaration[];
  readonly accepts?: (unit: HmrUnit) => boolean;
}

export type HmrDiscoverySource = FacetModuleSource | PackageModuleSource | HmrUnit;

function isHmrUnit(value: unknown): value is HmrUnit {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<HmrUnit>;
  return typeof candidate.id === "string" && typeof candidate.entry === "string";
}

/**
 * 发现层统一产出 HMR unit。facet/package 之外的条目必须能被识别为 HmrUnit，
 * 否则显式抛错；不接受「看起来像但少了字段」的静默降级。
 */
export function discoverHmrUnits(sources: readonly HmrDiscoverySource[]): readonly HmrUnit[] {
  const units: HmrUnit[] = [];
  const seen = new Set<string>();
  const push = (unit: HmrUnit): void => {
    if (seen.has(unit.id)) throw new Error(`DUPLICATE_HMR_UNIT: ${unit.id}`);
    seen.add(unit.id);
    units.push(unit);
  };
  for (const source of sources) {
    if (isHmrUnit(source)) {
      push(source);
      continue;
    }
    if (typeof source !== "object" || source === null) rejectUnsupported(source);
    if (source.kind === "facet") {
      if (!isHmrUnit(source.module)) rejectUnsupported(source);
      const unit: HmrUnit = {
        id: source.module.id,
        entry: source.module.entry,
        ...(source.module.accepts === undefined ? {} : { accepts: source.module.accepts }),
      };
      if (source.accepts !== undefined && !source.accepts(unit)) continue;
      push(unit);
      continue;
    }
    if (source.kind === "package") {
      if (!Array.isArray(source.modules) || source.modules.some((item) => !isHmrUnit(item))) {
        rejectUnsupported(source);
      }
      for (const module of source.modules) {
        const unit: HmrUnit = {
          id: module.id,
          entry: module.entry,
          ...(module.accepts === undefined ? {} : { accepts: module.accepts }),
        };
        if (source.accepts !== undefined && !source.accepts(unit)) continue;
        push(unit);
      }
      continue;
    }
    rejectUnsupported(source);
  }
  return units;
}
