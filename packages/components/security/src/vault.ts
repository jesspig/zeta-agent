export interface SecretBinding {
  readonly scheme: string;
  readonly host: string;
  readonly path?: string;
  readonly methods?: readonly string[];
}

export interface Placeholder {
  readonly name: string;
  readonly token: string;
}

export interface IssueInput {
  readonly name: string;
  readonly binding: SecretBinding;
}

export interface CredentialVault {
  readonly issued: readonly Placeholder[];
  issue(input: IssueInput): Placeholder;
  bindingOf(placeholder: Placeholder): SecretBinding | undefined;
}

export interface BoundaryRequest {
  readonly url: string;
  readonly method: string;
}

export type SecretBroker = (binding: SecretBinding) => Record<string, string>;

export function createCredentialVault(): CredentialVault {
  const issued: Placeholder[] = [];
  const bindings = new Map<string, SecretBinding>();
  // token 绑定签发实例，避免不同 vault 的序号 token 碰撞导致跨实例解析。
  const instanceId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    get issued(): readonly Placeholder[] {
      return issued;
    },
    issue(input: IssueInput): Placeholder {
      if (input.name.length === 0) throw new Error("INVALID_CREDENTIAL_NAME");
      if (input.binding.scheme.length === 0 || input.binding.host.length === 0) {
        throw new Error("INVALID_CREDENTIAL_BINDING");
      }
      const placeholder: Placeholder = {
        name: input.name,
        token: `__zeta_secret_${instanceId}_${issued.length}__`,
      };
      issued.push(placeholder);
      bindings.set(placeholder.token, input.binding);
      return placeholder;
    },
    bindingOf(placeholder: Placeholder): SecretBinding | undefined {
      return bindings.get(placeholder.token);
    },
  };
}

export function resolveAtBoundary(
  vault: CredentialVault,
  placeholder: Placeholder,
  request: BoundaryRequest,
  broker: SecretBroker
): Record<string, string> {
  const binding = vault.bindingOf(placeholder);
  if (!binding) throw new Error("UNKNOWN_PLACEHOLDER");

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error("INVALID_BOUNDARY_URL");
  }

  if (url.protocol !== `${binding.scheme}:` || url.host !== binding.host) {
    throw new Error("CREDENTIAL_BINDING_MISMATCH");
  }
  if (binding.path && !url.pathname.startsWith(binding.path)) {
    throw new Error("CREDENTIAL_BINDING_MISMATCH");
  }
  if (binding.methods && !binding.methods.includes(request.method)) {
    throw new Error("CREDENTIAL_BINDING_MISMATCH");
  }

  return broker(binding);
}
