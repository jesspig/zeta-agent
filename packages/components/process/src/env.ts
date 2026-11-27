export const DEFAULT_DENIED_ENV_KEYS: readonly string[] = Object.freeze([
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "AZURE_STORAGE_KEY",
]);

export const MINIMAL_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
]);

export interface FilterProcessEnvOptions {
  readonly allowlist?: readonly string[];
  readonly deny?: readonly string[];
}

export function filterProcessEnv(
  source: Readonly<Record<string, string | undefined>>,
  options: FilterProcessEnvOptions = {},
): Record<string, string> {
  const allow = options.allowlist === undefined
    ? undefined
    : new Set(options.allowlist.map((key) => key.toUpperCase()));
  const deny = new Set(
    [...DEFAULT_DENIED_ENV_KEYS, ...(options.deny ?? [])].map((key) => key.toUpperCase()),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (deny.has(upper)) continue;
    if (allow !== undefined && !allow.has(upper)) continue;
    env[key] = value;
  }
  return env;
}
