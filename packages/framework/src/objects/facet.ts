import type { Contract } from "./contract";
import type { AdmissionContext, AdmissionPolicy, ObjectOrigin, ObjectPrincipal } from "./admission";
import type { Reference } from "./reference";

/** factory 产物：value 为对象成员，dispose 为该 attempt 的撤销逆操作。 */
export interface ObjectFactoryResult<T> {
  readonly value: T;
  readonly dispose?: () => void | Promise<void>;
}

export type ObjectFactoryResultLike<T> = T | ObjectFactoryResult<T>;

/** setup 内 self：对象通过它声明依赖（缺依赖即 park），且每次取依赖都重新过准入。 */
export interface FacetSelf {
  get<T>(contract: Contract<any, any>, params?: unknown, context?: AdmissionContext): Promise<Reference<T>>;
  readonly principal?: ObjectPrincipal;
}

export type ObjectFactory<P, T> = (
  params: P,
  self: FacetSelf,
  context: AdmissionContext
) => ObjectFactoryResultLike<T> | Promise<ObjectFactoryResultLike<T>>;

export interface ServeOptions<P> {
  readonly id?: string;
  /** 服务要求的 realm（T-13）：调用 realm 不符即 denied。 */
  readonly realm?: symbol;
  /** 服务要求的 principal（仅 userId/spaceId 形状，不强绑 realm）。 */
  readonly principal?: Pick<ObjectPrincipal, "userId" | "spaceId">;
  /** 允许的来源（T-14 origin 同构）；未声明表示不限制。 */
  readonly origins?: readonly ObjectOrigin[];
  /** 额外准入策略，只能收紧默认 fail-closed 判定。 */
  readonly admission?: AdmissionPolicy;
  /** 依赖契约：未就绪时对象 park（loading），就绪后自动重试。 */
  readonly requires?: readonly Contract<any, any>[];
  /** 代码代次标识；reload 时变化才触发该对象重启。缺省用 factory 引用身份。 */
  readonly digest?: string;
  readonly version?: string;
}

/** setup 内 host：只做声明，同步执行，不产生资源。 */
export interface FacetHost<P extends ObjectPrincipal = ObjectPrincipal> {
  serve<T>(contract: Contract<any, any>, factory: ObjectFactory<any, T>, options?: ServeOptions<any>): void;
  references<T>(contract: Contract<any, any>): readonly Reference<T>[];
}

export interface Facet<P extends ObjectPrincipal = ObjectPrincipal> {
  readonly setup: (host: FacetHost<P>, self: FacetSelf) => void;
  readonly name?: string;
}

export interface FacetOptions {
  readonly name?: string;
}

/** facet 的 setup 只声明 serve/依赖，同步无副作用；常驻状态在 factory 产物里。 */
export function defineFacet<P extends ObjectPrincipal = ObjectPrincipal>(
  setup: (host: FacetHost<P>, self: FacetSelf) => void,
  options: FacetOptions = {}
): Facet<P> {
  if (typeof setup !== "function") throw new Error("INVALID_FACET_SETUP");
  return Object.freeze({ setup, ...(options.name === undefined ? {} : { name: options.name }) });
}

export function isFactoryResult<T>(value: unknown): value is ObjectFactoryResult<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, "value")
  );
}
