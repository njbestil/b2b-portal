import { isIP } from "node:net";

export type Service = "api" | "mock-erp";
export type RuntimeMode = "development" | "test" | "production";

export interface ServerEnvironment {
  readonly nodeEnv: RuntimeMode;
  readonly host: string;
  readonly port: number;
}

export class EnvironmentConfigurationError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid environment configuration:\n- ${problems.join("\n- ")}`);
    this.name = "EnvironmentConfigurationError";
  }
}

export function parseServerEnvironment(
  service: Service,
  environment: Readonly<Record<string, string | undefined>>,
): ServerEnvironment {
  const prefix = service === "api" ? "API" : "MOCK_ERP";
  const problems: string[] = [];

  function required(key: string): string {
    const value = environment[key];
    if (value === undefined || value.trim() === "") {
      problems.push(`${key} is required`);
      return "";
    }
    return value;
  }

  const nodeEnv = required("NODE_ENV");
  const host = required(`${prefix}_HOST`);
  const portText = required(`${prefix}_PORT`);

  if (
    nodeEnv &&
    nodeEnv !== "development" &&
    nodeEnv !== "test" &&
    nodeEnv !== "production"
  ) {
    problems.push("NODE_ENV must be development, test, or production");
  }

  if (host && host !== "localhost" && isIP(host) === 0) {
    problems.push(`${prefix}_HOST must be an IP address or localhost`);
  }

  const port = Number(portText);
  if (
    portText &&
    (/\D/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    problems.push(`${prefix}_PORT must be an integer between 1 and 65535`);
  }

  if (problems.length > 0) {
    throw new EnvironmentConfigurationError(problems);
  }

  return { nodeEnv: nodeEnv as RuntimeMode, host, port };
}

export interface PostgresEnvironment {
  readonly connectionString: string;
  readonly max: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly query_timeout: number;
  readonly statement_timeout: number;
}

/** API-only storage selection settings, with diagnostics limited to names/rules. */
export function parseStorageEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const text = environment.JSON_DATA_DIR;
  const jsonDataDir =
    text === undefined || text.trim() === "" ? undefined : text;
  const timeout = environment.STORAGE_STARTUP_TIMEOUT_MS ?? "1000";
  const startupTimeoutMs = Number(timeout);
  const problems: string[] = [];
  if (
    jsonDataDir &&
    (jsonDataDir !== jsonDataDir.trim() ||
      [...jsonDataDir].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  )
    problems.push(
      "JSON_DATA_DIR must be a path without surrounding whitespace or control characters",
    );
  if (
    !/^\d+$/.test(timeout) ||
    !Number.isInteger(startupTimeoutMs) ||
    startupTimeoutMs < 1 ||
    startupTimeoutMs > 60_000
  )
    problems.push(
      "STORAGE_STARTUP_TIMEOUT_MS must be an integer between 1 and 60000",
    );
  if (problems.length) throw new EnvironmentConfigurationError(problems);
  return { jsonDataDir, startupTimeoutMs };
}

export interface ErpEnvironment {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

/** Backend-only outbound adapter settings; never accepted from HTTP callers. */
export function parseErpEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ErpEnvironment | undefined {
  const text = environment.ERP_BASE_URL;
  if (text === undefined || text.trim() === "") return undefined;
  const problems: string[] = [];
  let baseUrl = "";
  try {
    const url = new URL(text);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      text !== text.trim()
    )
      throw new Error();
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    baseUrl = url.toString();
  } catch {
    problems.push(
      "ERP_BASE_URL must be an HTTP(S) base URL without credentials, query or fragment",
    );
  }
  const timeoutText = environment.ERP_TIMEOUT_MS ?? "1000";
  const timeoutMs = Number(timeoutText);
  if (
    !/^\d+$/.test(timeoutText) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    problems.push("ERP_TIMEOUT_MS must be an integer between 1 and 60000");
  }
  if (problems.length) throw new EnvironmentConfigurationError(problems);
  return { baseUrl, timeoutMs };
}

/** API-only optional configuration. Diagnostics never contain setting values. */
export function parsePostgresEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): PostgresEnvironment | undefined {
  const connectionString = environment.DATABASE_URL;
  if (connectionString === undefined || connectionString.trim() === "") {
    return undefined;
  }
  const problems: string[] = [];
  try {
    const url = new URL(connectionString);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2 ||
      [
        "query_timeout",
        "statement_timeout",
        "connectionTimeoutMillis",
        "options",
      ].some((key) => url.searchParams.has(key)) ||
      connectionString !== connectionString.trim()
    ) {
      throw new Error();
    }
  } catch {
    problems.push(
      "DATABASE_URL must be a PostgreSQL URL with a host and database; configure timeouts only through PG_* settings",
    );
  }
  function integer(key: string, fallback: number, maximum: number): number {
    const text = environment[key];
    if (text === undefined) return fallback;
    const value = Number(text);
    if (
      !/^\d+$/.test(text) ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > maximum
    ) {
      problems.push(`${key} must be an integer between 1 and ${maximum}`);
    }
    return value;
  }
  const max = integer("PG_POOL_MAX", 10, 100);
  const connectionTimeoutMillis = integer(
    "PG_CONNECTION_TIMEOUT_MS",
    1000,
    60_000,
  );
  const idleTimeoutMillis = integer("PG_IDLE_TIMEOUT_MS", 10_000, 600_000);
  const queryTimeout = integer("PG_QUERY_TIMEOUT_MS", 5000, 60_000);
  if (problems.length) throw new EnvironmentConfigurationError(problems);
  return {
    connectionString,
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    query_timeout: queryTimeout,
    statement_timeout: queryTimeout,
  };
}
