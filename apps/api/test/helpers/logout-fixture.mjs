import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { createDemoData } from "../../dist/demo/dataset.js";
import { JsonSecurityCoordinator } from "../../dist/infrastructure/json/security.js";
import { createJsonSessions } from "../../dist/infrastructure/json/sessions.js";
import { createPostgresSessions } from "../../dist/infrastructure/postgres-sessions.js";
import { createJsonAuthentication } from "../../dist/infrastructure/json/authentication.js";
import { createPostgresAuthentication } from "../../dist/infrastructure/postgres-authentication.js";
import { createJsonAudit } from "../../dist/infrastructure/json/audit.js";
import { createPostgresAudit } from "../../dist/infrastructure/postgres-audit.js";
import { createVerifiedLogin } from "../../dist/services/login.js";
import { createSessions } from "../../dist/services/sessions.js";
import {
  hashPassword,
  verifyPassword,
} from "../../dist/infrastructure/passwords.js";
import { parseSessionConfiguration } from "../../dist/infrastructure/session-config.js";
import { createAccessTokens } from "../../dist/infrastructure/access-tokens.js";
import { sessionProofs } from "../../dist/infrastructure/session-crypto.js";
import { createAudit } from "../../dist/services/audit.js";
import {
  loadMigrations,
  runMigrations,
} from "../../dist/infrastructure/migrations.js";

export const oldPassword = " TemporarySynthetic123! ";
let hash;
export const barrier = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
export async function logoutFixture(t, provider = "json") {
  const directory = await fs.mkdtemp(join(tmpdir(), "b2b29-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const data = createDemoData(),
    passwordHash = await (hash ??= hashPassword(oldPassword));
  data.users = data.users.map((row, n) => ({
    ...row,
    email: `password${n}@example.test`,
    passwordHash,
    mustChangePassword: true,
  }));
  const clock = { value: Date.now() },
    now = () => clock.value;
  const f = {
    provider,
    directory,
    data,
    clock,
    now,
    passwordHash,
    beforeAudit: async () => {},

    failPublication: false,
  };
  let auditRepository;
  if (provider === "json") {
    const security = new JsonSecurityCoordinator(directory);
    f.security = security;
    for (const [name, rows] of Object.entries(data))
      await security.store.replace(name, rows);
    f.authentication = createJsonAuthentication(security.store);

    const io = {
      ...fs,
      rename: async (...args) => {
        if (f.failPublication) throw new Error("PRIVATE_CLEANUP_FAILURE");
        return fs.rename(...args);
      },
    };
    f.sessions = createJsonSessions(security, now, io);
    auditRepository = createJsonAudit(directory);
    f.user = async (index = 0) => (await security.store.read("users"))[index];
    f.setUser = (patch, index = 0) =>
      security.run(async () => {
        const rows = await security.store.read("users");
        rows[index] = { ...rows[index], ...patch };
        await security.store.replace("users", rows);
      });
    f.rows = async () =>
      JSON.parse(
        await fs.readFile(join(directory, "user_sessions.json"), "utf8"),
      );
  } else {
    const admin = new Client({
      connectionString: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
    });
    await admin.connect();
    const schema = "b2b_logout_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await runMigrations(
      admin,
      await loadMigrations(new URL("../../migrations/", import.meta.url)),
    );
    const pool = new Pool({
      connectionString: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 8,
      query_timeout: 5000,
      statement_timeout: 5000,
    });
    f.pool = pool;
    f.admin = admin;
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    for (const row of data.companies)
      await admin.query(
        "INSERT INTO companies(id,legal_name,trade_name,status) VALUES($1,$2,$3,$4)",
        [row.id, row.legalName, row.tradeName, row.status],
      );
    for (const row of data.users)
      await admin.query(
        "INSERT INTO users(id,company_id,email,password_hash,display_name,role,status,must_change_password) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          row.id,
          row.companyId,
          row.email,
          row.passwordHash,
          row.displayName,
          row.role,
          row.status,
          row.mustChangePassword,
        ],
      );
    f.authentication = createPostgresAuthentication(pool);
    f.sessions = createPostgresSessions(pool, now);
    auditRepository = createPostgresAudit(pool);
    f.user = async (index = 0) =>
      (
        await pool.query(
          'SELECT id,password_hash AS "passwordHash",must_change_password AS "mustChangePassword",status FROM users WHERE id=$1',
          [data.users[index].id],
        )
      ).rows[0];
    f.setUser = async (patch, index = 0) => {
      const columns = {
        mustChangePassword: "must_change_password",
        status: "status",
      };
      for (const [key, value] of Object.entries(patch)) {
        if (!columns[key]) throw new Error("Unsupported fixture update");
        await pool.query(`UPDATE users SET ${columns[key]}=$1 WHERE id=$2`, [
          value,
          data.users[index].id,
        ]);
      }
    };
    f.rows = async () =>
      (
        await pool.query(
          'SELECT id,user_id AS "userId",revoked_at AS "revokedAt",refresh_token_hash AS "refreshTokenHash" FROM user_sessions',
        )
      ).rows;
  }
  const audit = createAudit(
    auditRepository,
    randomUUID,
    () => new Date(clock.value),
  );
  f.record = async (input) => {
    await f.beforeAudit(input);
    return audit.record(input);
  };
  f.config = parseSessionConfiguration({
    AUTH_JWT_ISSUER: "password-test",
    AUTH_JWT_AUDIENCE: "password-test",
    AUTH_JWT_ACTIVE_KID: "synthetic",
    AUTH_JWT_KEYS: JSON.stringify({
      synthetic: Buffer.alloc(32, 23).toString("base64url"),
    }),
  });
  f.auth = createSessions(
    f.sessions,
    createVerifiedLogin(f.authentication, verifyPassword, f.record),
    f.record,
    f.config,
    createAccessTokens(f.config, now),
    sessionProofs,
  );
  f.login = (index = 0, password = oldPassword) =>
    f.auth.login({ email: data.users[index].email, password }, randomUUID());
  return f;
}
