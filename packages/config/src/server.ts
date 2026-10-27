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
