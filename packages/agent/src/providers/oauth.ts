export interface OAuthCredentials {
  readonly token: string;
  readonly expiresAt?: number;
}

export interface TokenExchangeArgs {
  readonly code: string;
  readonly redirectUri?: string;
}

export interface OAuthProviderInit {
  readonly id: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly exchange: (args: TokenExchangeArgs) => Promise<OAuthCredentials>;
}

export interface OAuthProvider {
  readonly id: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  buildAuthorizeUrl(state: string, redirectUri: string): Promise<string>;
  exchange(args: TokenExchangeArgs): Promise<OAuthCredentials>;
}

/** 构造 OAuth provider 抽象：exchanger 由具体实现注入（演示 provider 用 dummy token）。 */
export function createOAuthProvider(init: OAuthProviderInit): OAuthProvider {
  if (init.id.length === 0 || init.authorizeUrl.length === 0 || init.tokenUrl.length === 0) {
    throw new Error("OAUTH_PROVIDER_INVALID: id/authorizeUrl/tokenUrl 必填");
  }
  return {
    id: init.id,
    authorizeUrl: init.authorizeUrl,
    tokenUrl: init.tokenUrl,
    clientId: init.clientId,
    scopes: [...init.scopes],
    async buildAuthorizeUrl(state: string, redirectUri: string): Promise<string> {
      const url = new URL(init.authorizeUrl);
      url.searchParams.set("client_id", init.clientId);
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", redirectUri);
      if (init.scopes.length > 0) url.searchParams.set("scope", init.scopes.join(" "));
      url.searchParams.set("response_type", "code");
      return url.toString();
    },
    exchange: init.exchange,
  };
}

export interface LoginArgs extends TokenExchangeArgs {}

export interface OAuthManager {
  login(providerId: string, args: LoginArgs): Promise<OAuthCredentials>;
  logout(providerId: string): void;
  check(providerId: string): boolean;
  get(providerId: string): OAuthCredentials | undefined;
  credentials(): readonly { readonly provider: string; readonly credentials: OAuthCredentials }[];
}

/** 凭据仅保存在内存 Map，不写环境变量、不落盘。 */
export function createOAuthManager(providers: readonly OAuthProvider[]): OAuthManager {
  const byId = new Map<string, OAuthProvider>(providers.map((provider) => [provider.id, provider]));
  const store = new Map<string, OAuthCredentials>();

  function valid(providerId: string): boolean {
    const creds = store.get(providerId);
    if (creds === undefined) return false;
    if (creds.expiresAt !== undefined && creds.expiresAt <= Date.now()) {
      store.delete(providerId);
      return false;
    }
    return creds.token.length > 0;
  }

  return {
    async login(providerId: string, args: LoginArgs): Promise<OAuthCredentials> {
      const provider = byId.get(providerId);
      if (provider === undefined) {
        throw new Error(`UNKNOWN_OAUTH_PROVIDER: ${providerId}（可用：${[...byId.keys()].join(", ")}）`);
      }
      const credentials = await provider.exchange(args);
      if (credentials.token.length === 0) throw new Error("OAUTH_EMPTY_TOKEN");
      store.set(providerId, credentials);
      return credentials;
    },
    logout(providerId: string): void {
      store.delete(providerId);
    },
    check(providerId: string): boolean {
      return valid(providerId);
    },
    get(providerId: string): OAuthCredentials | undefined {
      return valid(providerId) ? store.get(providerId) : undefined;
    },
    credentials(): readonly { readonly provider: string; readonly credentials: OAuthCredentials }[] {
      return [...store.entries()]
        .filter(([id]) => valid(id))
        .map(([provider, credentials]) => ({ provider, credentials }));
    },
  };
}

/** 演示 provider：用任意 code 换取内存中的 dummy token，适用于测试与本地演示。 */
export function createDemoOAuthProvider(): OAuthProvider {
  return createOAuthProvider({
    id: "demo",
    authorizeUrl: "https://auth.example.test/authorize",
    tokenUrl: "https://auth.example.test/token",
    clientId: "demo-client",
    scopes: ["model:read"],
    exchange: async ({ code }) => ({ token: ["dummy", "token", "for", code].join("-"), expiresAt: Date.now() + 60_000 }),
  });
}
