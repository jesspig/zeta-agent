export interface LaunchRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly detached?: boolean;
  readonly timeoutMs?: number;
  readonly killSignal?: NodeJS.Signals;
  readonly stdio?: {
    readonly stdin?: "pipe" | "ignore";
    readonly stdout?: "pipe" | "ignore";
    readonly stderr?: "pipe" | "ignore";
  };
}

export interface LaunchedProcess {
  readonly pid: number | undefined;
  readonly stdin: { write(data: string): void; end(): void; readonly destroyed?: boolean };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> | null;
  readonly exited: Promise<number | null>;
  kill(): void;
  cancel?(): Promise<void>;
}

export interface ProcessLauncher {
  readonly name?: string;
  readonly confinement?: "none" | "partial" | "full";
  launch(request: LaunchRequest): LaunchedProcess;
}
