import { Client } from "pg";
import type { PostgresEnvironment } from "@b2b-portal/config/server";
import type { AuthenticationRepository } from "../repositories/authentication.js";
import type { AccessTokens } from "../repositories/sessions.js";
import { SessionError } from "../services/session-state.js";
import { demoAccounts, DemoAccountsError, demoTarget } from "./accounts.js";
import { inspectJsonDemo } from "./accounts-json.js";
import { inspectPostgresDemo } from "./accounts-postgres.js";

export async function inspectDemoStore(
  target: string,
  postgres: PostgresEnvironment | undefined,
  jsonDirectory: string,
) {
  if (!demoTarget(target)) throw new DemoAccountsError();
  if (!postgres) return inspectJsonDemo(jsonDirectory, target);
  const url = new URL(postgres.connectionString);
  if (decodeURIComponent(url.pathname.slice(1)) !== target)
    throw new DemoAccountsError();
  const client = new Client({
    ...postgres,
    application_name: "b2b-portal-demo-accounts-check",
  });
  client.on("error", () => {});
  try {
    await client.connect();
    await inspectPostgresDemo(client, target);
  } catch {
    throw new DemoAccountsError();
  } finally {
    await client.end().catch(() => {});
  }
}
/** Only the explicitly provisioned email/ID pairs are demo identities. Ordinary
 * fixtures/users with different emails retain existing authentication behavior. */
export function protectDemoAuthentication(
  repository: AuthenticationRepository,
  enabled: boolean,
): AuthenticationRepository {
  return {
    async findByEmail(email) {
      const user = await repository.findByEmail(email);
      if (
        !enabled &&
        user &&
        demoAccounts.some((row) => row.id === user.id && row.email === email)
      )
        return null;
      return user;
    },
  };
}
/** Runtime opt-out also denies already-issued demo access and refresh results. */
export function protectDemoTokens(
  tokens: AccessTokens,
  repository: AuthenticationRepository,
  enabled: boolean,
): AccessTokens {
  async function check(userId: string) {
    if (enabled) return;
    const account = demoAccounts.find((row) => row.id === userId);
    if (account && (await repository.findByEmail(account.email))?.id === userId)
      throw new SessionError("invalid_proof");
  }
  return {
    async issue(userId, sessionId, expiresAt) {
      await check(userId);
      return tokens.issue(userId, sessionId, expiresAt);
    },
    async verify(token) {
      const value = await tokens.verify(token);
      await check(value.userId);
      return value;
    },
  };
}
