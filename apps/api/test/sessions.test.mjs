import {
  credentialFingerprint,
  refreshDigest,
  sessionProofs,
} from "../dist/infrastructure/session-crypto.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { SignJWT, decodeJwt } from "jose";
import { createDemoData } from "../dist/demo/dataset.js";
import { createJsonAuthentication } from "../dist/infrastructure/json/authentication.js";
import { createPostgresAuthentication } from "../dist/infrastructure/postgres-authentication.js";
import { JsonSecurityCoordinator } from "../dist/infrastructure/json/security.js";
import { createJsonSessions } from "../dist/infrastructure/json/sessions.js";
import { createPostgresSessions } from "../dist/infrastructure/postgres-sessions.js";
import { withSecurityAccount } from "../dist/infrastructure/postgres-security.js";
import {
  hashPassword,
  verifyPassword,
} from "../dist/infrastructure/passwords.js";
import { createVerifiedLogin, createLogin } from "../dist/services/login.js";
import { createSessions } from "../dist/services/sessions.js";
import {
  SessionError,
  requireNormalAccess,
} from "../dist/services/session-state.js";
import { createAccessTokens } from "../dist/infrastructure/access-tokens.js";
import { parseSessionConfiguration } from "../dist/infrastructure/session-config.js";
import { createAudit } from "../dist/services/audit.js";
import { createJsonAudit } from "../dist/infrastructure/json/audit.js";
import { createPostgresAudit } from "../dist/infrastructure/postgres-audit.js";
import {
  loadMigrations,
  runMigrations,
} from "../dist/infrastructure/migrations.js";
import { createApp } from "../dist/app.js";
import { accessBearer } from "../dist/session-route.js";
import { seedJson } from "../dist/demo/seed.js";
import { createJsonCatalogCache } from "../dist/infrastructure/json/catalog-cache.js";

const password = " Synthetic session password 2030! ";

test("refresh HTTP has bounded in-flight capacity, releases slots and rate limits failed/valid attempts", async (t) => {
  const allEntered = deferred(),
    release = deferred();
  let entered = 0;
  const service = {
    refresh: async () => {
      entered++;
      if (entered === 8) allEntered.resolve();
      await release.promise;
      return { outcome: "synthetic" };
    },
  };
  const url = await serve(
    t,
    createApp({ sessions: service, logger: () => {} }),
  );
  const pending = Array.from({ length: 8 }, () =>
    post(url + "/api/v1/auth/refresh", { refreshToken: "synthetic" }),
  );
  await allEntered.promise;
  assert.equal(
    (await post(url + "/api/v1/auth/refresh", { refreshToken: "synthetic" }))
      .status,
    503,
  );
  release.resolve();
  assert.ok(
    (await Promise.all(pending)).every((response) => response.status === 200),
  );
  for (let n = 9; n < 30; n++)
    assert.equal(
      (await post(url + "/api/v1/auth/refresh", { refreshToken: "synthetic" }))
        .status,
      200,
    );
  assert.equal(
    (await post(url + "/api/v1/auth/refresh", { refreshToken: "synthetic" }))
      .status,
    429,
  );
});

test(
  "SQL admission rechecks company association after waits and treats ambiguous COMMIT as unavailable without restoring state",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL, timeout: 30000 },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      service = f.service(),
      result = await service.login(f.body(), randomUUID());
    const blocker = await f.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        f.data.users[0].id,
      ]);
      f.userLockAttempt = deferred();
      const pending = service.authenticateAccess(result.accessToken);
      await f.userLockAttempt.promise;
      await blocker.query(
        "UPDATE users SET role='CUSTOMER_ADMIN',company_id=$1 WHERE id=$2",
        [f.data.companies[0].id, f.data.users[0].id],
      );
      await blocker.query("COMMIT");
      await assert.rejects(pending, invalid);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const ambiguous = {
      query: f.pool.query.bind(f.pool),
      connect: async () => {
        const client = await f.pool.connect();
        return {
          on: client.on.bind(client),
          off: client.off.bind(client),
          release: (discard) => client.release(discard),
          query: async (...args) => {
            const result = await client.query(...args);
            if (args[0] === "COMMIT")
              throw new Error("PRIVATE_AMBIGUOUS_COMMIT");
            return result;
          },
        };
      },
    };
    const repository = createPostgresSessions(ambiguous, f.now),
      id = randomUUID(),
      digest = refreshDigest("ambiguous synthetic");
    await assert.rejects(
      repository.create(
        { userId: f.data.users[0].id, passwordHash: f.hash },
        id,
        digest,
        100,
      ),
      unavailable,
    );
    const persisted = (await f.rows()).find((row) => row.id === id);
    assert.equal(persisted.refreshTokenHash, digest);
    assert.equal(persisted.revokedAt, null);
    assert.ok(await f.repository.admit(id, f.data.users[0].id));
  },
);

let hashPromise;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const invalid = (e) => e instanceof SessionError && e.code === "invalid_proof";
const unavailable = (e) =>
  e instanceof SessionError && e.code === "unavailable";
const config = (extra = {}) =>
  parseSessionConfiguration({
    AUTH_JWT_ISSUER: "synthetic-b2b",
    AUTH_JWT_AUDIENCE: "synthetic-portal",
    AUTH_JWT_ACTIVE_KID: "test",
    AUTH_JWT_KEYS: JSON.stringify({
      test: Buffer.alloc(32, 7).toString("base64url"),
    }),
    ...extra,
  });
async function fixture(t, provider = "json", legacy = false) {
  const directory = await fs.mkdtemp(join(tmpdir(), "b2b28-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const security = new JsonSecurityCoordinator(directory),
    data = createDemoData();
  const hash = await (hashPromise ??= hashPassword(password));
  data.users = data.users.map((u, n) => ({
    ...u,
    email: `session${n}@example.test`,
    passwordHash: hash,
    mustChangePassword: true,
  }));
  const clock = { value: Date.parse("2026-10-31T12:00:00.000Z") };
  const f = {
    provider,
    directory,
    security,
    data,
    hash,
    clock,
    now: () => clock.value,
    config: config(),
    beforeAudit: async () => {},
    failRename: false,
  };
  let authentication, auditRepository;
  if (provider === "json") {
    for (const [name, rows] of Object.entries(data))
      await security.store.replace(name, rows);
    const io = {
      ...fs,
      rename: async (...args) => {
        if (f.failRename) throw new Error("PRIVATE_WRITE_FAILURE");
        return fs.rename(...args);
      },
    };
    f.repository = createJsonSessions(security, f.now, io);
    authentication = createJsonAuthentication(security.store);
    auditRepository = createJsonAudit(directory);
    f.setUser = (patch, index = 0) =>
      security.run(async () => {
        const rows = await security.store.read("users");
        rows[index] = { ...rows[index], ...patch };
        await security.store.replace("users", rows);
      });
    f.setCompany = (status) =>
      security.run(async () => {
        const rows = await security.store.read("companies");
        rows[0] = { ...rows[0], status };
        await security.store.replace("companies", rows);
      });
    f.rows = async () => {
      try {
        return JSON.parse(
          await fs.readFile(join(directory, "user_sessions.json"), "utf8"),
        );
      } catch (e) {
        if (e.code === "ENOENT") return [];
        throw e;
      }
    };
    f.patchSession = (id, patch) =>
      security.run(async () => {
        const rows = await f.rows();
        rows[rows.findIndex((r) => r.id === id)] = {
          ...rows.find((r) => r.id === id),
          ...patch,
        };
        await fs.writeFile(
          join(directory, "user_sessions.json"),
          JSON.stringify(rows),
        );
      });
    f.readAudit = async () =>
      JSON.parse(await fs.readFile(join(directory, "audit_logs.json"), "utf8"));
    f.hold = async () => {
      const entered = deferred(),
        release = deferred();
      const held = security.run(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      return async () => {
        release.resolve();
        await held;
      };
    };
  } else {
    const admin = new Client({
      connectionString: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
    });
    await admin.connect();
    const schema = "b2b_sessions_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    const migrations = await loadMigrations(
      new URL("../migrations/", import.meta.url),
    );
    await runMigrations(
      admin,
      legacy ? migrations.filter((m) => m.version < 4) : migrations,
    );
    const pool = new Pool({
      connectionString: process.env.B2B_TEST_MIGRATIONS_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 8,
      query_timeout: 5000,
      statement_timeout: 5000,
    });
    f.admin = admin;
    f.pool = pool;
    f.migrations = migrations;
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    for (const c of data.companies)
      await admin.query(
        "INSERT INTO companies(id,legal_name,trade_name,status) VALUES($1,$2,$3,$4)",
        [c.id, c.legalName, c.tradeName, c.status],
      );
    for (const u of data.users)
      await admin.query(
        "INSERT INTO users(id,company_id,email,password_hash,display_name,role,status,must_change_password) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          u.id,
          u.companyId,
          u.email,
          u.passwordHash,
          u.displayName,
          u.role,
          u.status,
          u.mustChangePassword,
        ],
      );
    const instrumented = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: (discard) => client.release(discard),
          on: client.on.bind(client),
          off: client.off.bind(client),
          query: (...args) => {
            const result = client.query(...args);
            if (
              typeof args[0] === "string" &&
              args[0].includes("FROM users WHERE id=$1 FOR UPDATE")
            )
              f.userLockAttempt?.resolve();
            return result;
          },
        };
      },
    };
    f.repository = createPostgresSessions(instrumented, f.now);
    authentication = createPostgresAuthentication(pool);
    auditRepository = createPostgresAudit(pool);
    f.setUser = (patch, index = 0) =>
      withSecurityAccount(pool, data.users[index].id, async (client) => {
        const columns = {
          passwordHash: "password_hash",
          mustChangePassword: "must_change_password",
          status: "status",
          role: "role",
          companyId: "company_id",
        };
        for (const [key, value] of Object.entries(patch)) {
          assert.ok(columns[key]);
          await client.query(
            `UPDATE users SET ${columns[key]}=$1 WHERE id=$2`,
            [value, data.users[index].id],
          );
        }
      });
    f.setCompany = (status) =>
      pool.query("UPDATE companies SET status=$1 WHERE id=$2", [
        status,
        data.companies[0].id,
      ]);
    f.rows = async () =>
      (
        await pool.query(
          'SELECT id,user_id AS "userId",refresh_token_hash AS "refreshTokenHash",credential_fingerprint AS "credentialFingerprint",created_at AS "createdAt",expires_at AS "expiresAt",revoked_at AS "revokedAt" FROM user_sessions ORDER BY id',
        )
      ).rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        revokedAt: r.revokedAt?.toISOString() ?? null,
      }));
    f.patchSession = (id, patch) =>
      pool.query(
        "UPDATE user_sessions SET credential_fingerprint=$1 WHERE id=$2",
        [patch.credentialFingerprint, id],
      );
    f.readAudit = async () =>
      (await pool.query("SELECT * FROM audit_logs ORDER BY created_at,id"))
        .rows;
    f.hold = async () => {
      const client = await pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        data.users[0].id,
      ]);
      f.userLockAttempt = deferred();
      return async () => {
        await client.query("COMMIT");
        client.release();
      };
    };
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
  f.verify = createVerifiedLogin(authentication, verifyPassword, f.record);
  f.credentialLogin = createLogin(authentication, verifyPassword, f.record);
  f.tokens = createAccessTokens(f.config, f.now);
  f.service = () =>
    createSessions(
      f.repository,
      f.verify,
      f.record,
      f.config,
      f.tokens,
      sessionProofs,
    );
  f.body = (index = 0) => ({ email: data.users[index].email, password });
  return f;
}
async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return "http://127.0.0.1:" + server.address().port;
}
const post = (url, body, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("session configuration has no implicit key and rejects partial/weak/noncanonical settings without values", () => {
  assert.equal(parseSessionConfiguration({}), undefined);
  for (const extra of [
    { AUTH_JWT_KEYS: "PRIVATE_NOT_JSON" },
    { AUTH_JWT_KEYS: JSON.stringify({ test: "short" }) },
    { AUTH_JWT_ACTIVE_KID: "unknown" },
    { AUTH_ACCESS_TTL_SECONDS: "901" },
    { AUTH_REFRESH_TTL_SECONDS: "604801" },
  ]) {
    assert.throws(
      () => config(extra),
      (e) =>
        !e.message.includes("PRIVATE_NOT_JSON") &&
        !e.message.includes("short") &&
        !e.message.includes("unknown"),
    );
  }
  assert.equal(config().accessSeconds, 900);
  assert.equal(config().refreshSeconds, 604800);
});
test("JWT validation pins algorithm/type/issuer/audience/local key, bounds time/claims and rotates keys", async () => {
  let time = Date.parse("2026-10-31T12:00:00Z");
  const cfg = config(),
    tokens = createAccessTokens(cfg, () => time),
    user = randomUUID(),
    sid = randomUUID();
  const issued = await tokens.issue(
    user,
    sid,
    new Date(time + 2000).toISOString(),
  );
  assert.equal(issued.expiresIn, 2);
  assert.equal((await tokens.verify(issued.token)).userId, user);
  const iat = Math.floor(time / 1000);
  const payload = {
    iss: cfg.issuer,
    aud: cfg.audience,
    sub: user,
    sid,
    iat,
    exp: iat + 900,
  };
  for (const [claims, header] of [
    [{ ...payload, iss: "other" }, {}],
    [{ ...payload, aud: "other" }, {}],
    [{ ...payload, iat: iat + 31, exp: iat + 900 }, {}],
    [{ ...payload, exp: iat + 901 }, {}],
    [{ ...payload, exp: iat }, {}],
    [{ ...payload, role: "INTERNAL_ADMIN" }, {}],
    [payload, { typ: "refresh+jwt" }],
    [payload, { kid: "untrusted" }],
    [payload, { alg: "HS384" }],
    [{ ...payload, exp: iat - 31, iat: iat - 900 }, {}],
  ]) {
    const token = await new SignJWT(claims)
      .setProtectedHeader({
        alg: "HS256",
        typ: "b2b-access+jwt",
        kid: "test",
        ...header,
      })
      .sign(cfg.keys.get("test"));
    await assert.rejects(tokens.verify(token), invalid);
  }
  for (const token of ["bad", "a.b.c", "x".repeat(4097), issued.token + "x"])
    await assert.rejects(tokens.verify(token), invalid);
  const retained = {
    ...cfg,
    activeKeyId: "next",
    keys: new Map([...cfg.keys, ["next", Buffer.alloc(32, 8)]]),
  };
  assert.equal(
    (await createAccessTokens(retained, () => time).verify(issued.token))
      .sessionId,
    sid,
  );
  await assert.rejects(
    createAccessTokens(
      { ...retained, keys: new Map([["next", Buffer.alloc(32, 8)]]) },
      () => time,
    ).verify(issued.token),
    invalid,
  );
  await assert.rejects(
    tokens.issue(user, sid, new Date(time + 500).toISOString()),
    invalid,
  );
  let clockReads = 0;
  const late = createAccessTokens(cfg, () =>
    clockReads++ === 0 ? time : time + 1000,
  );
  await assert.rejects(
    late.issue(user, sid, new Date(time + 1000).toISOString()),
    invalid,
  );
  assert.equal(
    accessBearer(["Authorization", "bearer " + issued.token]),
    issued.token,
  );
  assert.throws(
    () =>
      accessBearer(["Authorization", "Bearer x", "authorization", "Bearer y"]),
    invalid,
  );
  assert.throws(
    () => accessBearer(["Authorization", "Bearer x, Bearer y"]),
    invalid,
  );
});

for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
    timeout: 30000,
  };
  test(
    provider +
      ": issued credentials stay private; live role/account/company state and first-login restrictions apply",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        service = f.service(),
        result = await service.login(f.body(), randomUUID());
      const identity = await service.authenticateAccess(result.accessToken);
      assert.equal(identity.mustChangePassword, true);
      assert.throws(
        () => requireNormalAccess(identity),
        (e) => e.code === "restricted",
      );
      assert.deepEqual(
        Object.keys(result).sort(),
        [
          "user",
          "accessToken",
          "refreshToken",
          "tokenType",
          "expiresIn",
          "refreshExpiresAt",
        ].sort(),
      );
      assert.deepEqual(
        Object.keys(decodeJwt(result.accessToken)).sort(),
        ["sid", "iss", "aud", "sub", "iat", "exp"].sort(),
      );
      const rows = await f.rows();
      assert.equal(
        rows[0].refreshTokenHash,
        refreshDigest(result.refreshToken),
      );
      assert.equal(
        rows[0].credentialFingerprint,
        credentialFingerprint(identity.userId, f.hash),
      );
      assert.ok(!JSON.stringify(rows).includes(result.refreshToken));
      assert.ok(!JSON.stringify(result).includes(f.hash));
      assert.ok(!JSON.stringify(await f.readAudit()).includes(f.hash));
      await f.setUser({ role: "SALES_STAFF" });
      assert.equal(
        (await service.authenticateAccess(result.accessToken)).role,
        "SALES_STAFF",
      );
      await f.setUser({ status: "SUSPENDED" });
      await assert.rejects(
        service.authenticateAccess(result.accessToken),
        invalid,
      );
      await f.setUser({ status: "PENDING" });
      await assert.rejects(
        service.login(f.body(), randomUUID()),
        (e) => e.code === "invalid_credentials",
      );
      const customer = await service.login(f.body(2), randomUUID());
      await f.setCompany("SUSPENDED");
      await assert.rejects(
        service.authenticateAccess(customer.accessToken),
        invalid,
      );
      await assert.rejects(
        service.refresh({ refreshToken: customer.refreshToken }, randomUUID()),
        invalid,
      );
    },
  );
  test(
    provider +
      ": credential change after password verification cannot issue a session from the stale proof",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        entered = deferred(),
        release = deferred();
      const service = createSessions(
        f.repository,
        async (...args) => {
          const verified = await f.verify(...args);
          entered.resolve();
          await release.promise;
          return verified;
        },
        f.record,
        f.config,
        f.tokens,
        sessionProofs,
      );
      const pending = service.login(f.body(), randomUUID());
      await entered.promise;
      const replacement = await hashPassword(password);
      await f.setUser({ passwordHash: replacement, mustChangePassword: false });
      release.resolve();
      await assert.rejects(pending, invalid);
      assert.equal((await f.rows()).length, 0);
      const result = await f.service().login(f.body(), randomUUID());
      assert.equal(
        (await f.service().authenticateAccess(result.accessToken))
          .mustChangePassword,
        false,
      );
    },
  );
  test(
    provider +
      ": refresh has exactly one winner, stable absolute lifetime, independent sessions and persistent revocation",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        service = f.service(),
        original = await service.login(f.body(), randomUUID()),
        other = await service.login(f.body(), randomUUID());
      const before = await f.rows();
      const results = await Promise.allSettled([
        service.refresh({ refreshToken: original.refreshToken }, randomUUID()),
        service.refresh({ refreshToken: original.refreshToken }, randomUUID()),
      ]);
      const winner = results.find((r) => r.status === "fulfilled").value;
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.find((r) => r.status === "rejected").reason.code,
        "invalid_proof",
      );
      assert.equal(winner.refreshExpiresAt, original.refreshExpiresAt);
      assert.deepEqual(
        (await f.rows()).map((r) => [r.id, r.createdAt, r.expiresAt]).sort(),
        before.map((r) => [r.id, r.createdAt, r.expiresAt]).sort(),
      );
      await assert.rejects(
        service.refresh({ refreshToken: original.refreshToken }, randomUUID()),
        invalid,
      );
      assert.equal(
        (await service.authenticateAccess(winner.accessToken)).userId,
        f.data.users[0].id,
      );
      const sid = decodeJwt(winner.accessToken).sid;
      await f.repository.revoke(sid, f.data.users[0].id);
      const revoked = (await f.rows()).find((r) => r.id === sid).revokedAt;
      await f.repository.revoke(sid, f.data.users[0].id);
      assert.equal(
        (await f.rows()).find((r) => r.id === sid).revokedAt,
        revoked,
      );
      await assert.rejects(
        service.authenticateAccess(winner.accessToken),
        invalid,
      );
      await assert.rejects(
        service.refresh({ refreshToken: winner.refreshToken }, randomUUID()),
        invalid,
      );
      await assert.rejects(
        service.revoke(winner.accessToken, randomUUID()),
        invalid,
      );
      assert.ok(await service.authenticateAccess(other.accessToken));
    },
  );
  test(
    provider +
      ": refresh admitted before revoke can return already-revoked proof; audit failure never restores consumed state",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        service = f.service(),
        original = await service.login(f.body(), randomUUID());
      const entered = deferred(),
        release = deferred();
      f.beforeAudit = async (input) => {
        if (input.action === "session.refreshed") {
          entered.resolve();
          await release.promise;
        }
      };
      const pending = service.refresh(
        { refreshToken: original.refreshToken },
        randomUUID(),
      );
      await entered.promise;
      await f.repository.revoke(
        decodeJwt(original.accessToken).sid,
        f.data.users[0].id,
      );
      release.resolve();
      const rotated = await pending;
      await assert.rejects(
        service.authenticateAccess(rotated.accessToken),
        invalid,
      );
      f.beforeAudit = async () => {};
      const next = await service.login(f.body(), randomUUID()),
        oldHash = refreshDigest(next.refreshToken);
      f.beforeAudit = async (input) => {
        if (input.action === "session.refreshed")
          throw new Error("PRIVATE_AUDIT_FAILURE");
      };
      await assert.rejects(
        service.refresh({ refreshToken: next.refreshToken }, randomUUID()),
        unavailable,
      );
      assert.ok(!(await f.rows()).some((r) => r.refreshTokenHash === oldHash));
      await assert.rejects(
        service.refresh({ refreshToken: next.refreshToken }, randomUUID()),
        invalid,
      );
    },
  );
  test(
    provider +
      ": hard expiry is sampled after queue/account-lock waits and never borrows JWT tolerance",
    options,
    async (t) => {
      const f = await fixture(t, provider);
      const id = randomUUID(),
        digest = refreshDigest("synthetic");
      await f.repository.create(
        { userId: f.data.users[0].id, passwordHash: f.hash },
        id,
        digest,
        1,
      );
      const release = await f.hold();
      const pending = f.repository.rotate(
        id,
        digest,
        refreshDigest("replacement"),
      );
      if (provider === "postgresql") await f.userLockAttempt.promise;
      f.clock.value += 1000;
      await release();
      await assert.rejects(pending, invalid);
      assert.equal((await f.rows())[0].refreshTokenHash, digest);
      const cfg = config({
        AUTH_ACCESS_TTL_SECONDS: "1",
        AUTH_REFRESH_TTL_SECONDS: "2",
      });
      const service = createSessions(
        f.repository,
        f.verify,
        f.record,
        cfg,
        createAccessTokens(cfg, f.now),
        sessionProofs,
      );
      const result = await service.login(f.body(), randomUUID());
      f.clock.value += 2000;
      await assert.rejects(
        service.authenticateAccess(result.accessToken),
        invalid,
      );
      await assert.rejects(
        service.refresh({ refreshToken: result.refreshToken }, randomUUID()),
        invalid,
      );
    },
  );
  test(
    provider +
      ": null/unknown credential binding denies without backfill; post-change old sessions remain invalid",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        service = f.service(),
        result = await service.login(f.body(), randomUUID()),
        sid = decodeJwt(result.accessToken).sid;
      for (const credentialFingerprint of [null, "future-v99:unrecognized"]) {
        await f.patchSession(sid, { credentialFingerprint });
        await assert.rejects(
          service.authenticateAccess(result.accessToken),
          invalid,
        );
        await assert.rejects(
          service.refresh({ refreshToken: result.refreshToken }, randomUUID()),
          invalid,
        );
        assert.equal(
          (await f.rows()).find((r) => r.id === sid).credentialFingerprint,
          credentialFingerprint,
        );
      }
      await f.patchSession(sid, {
        credentialFingerprint: credentialFingerprint(
          f.data.users[0].id,
          f.hash,
        ),
      });
      await f.setUser({
        passwordHash: await hashPassword(password),
        mustChangePassword: false,
      });
      await assert.rejects(
        service.authenticateAccess(result.accessToken),
        invalid,
      );
      await assert.rejects(
        service.refresh({ refreshToken: result.refreshToken }, randomUUID()),
        invalid,
      );
      assert.ok((await f.rows()).every((r) => r.revokedAt === null));
    },
  );
}

test("JSON publication/corruption failures fail closed without fallback, hash restoration or queue poisoning", async (t) => {
  const f = await fixture(t),
    service = f.service();
  f.failRename = true;
  await assert.rejects(service.login(f.body(), randomUUID()), unavailable);
  assert.equal((await f.rows()).length, 0);
  f.failRename = false;
  const result = await service.login(f.body(), randomUUID()),
    oldRows = await fs.readFile(join(f.directory, "user_sessions.json"));
  f.failRename = true;
  await assert.rejects(
    service.refresh({ refreshToken: result.refreshToken }, randomUUID()),
    unavailable,
  );
  assert.deepEqual(
    await fs.readFile(join(f.directory, "user_sessions.json")),
    oldRows,
  );
  f.failRename = false;
  const refreshed = await service.refresh(
    { refreshToken: result.refreshToken },
    randomUUID(),
  );
  await fs.writeFile(
    join(f.directory, "user_sessions.json"),
    "PRIVATE_CORRUPTION",
  );
  await assert.rejects(
    service.authenticateAccess(refreshed.accessToken),
    unavailable,
  );
  assert.equal(await f.repository.ready(), false);
  assert.equal(
    await fs.readFile(join(f.directory, "user_sessions.json"), "utf8"),
    "PRIVATE_CORRUPTION",
  );
  await fs.writeFile(join(f.directory, "user_sessions.json"), oldRows);
  assert.ok(await service.authenticateAccess(result.accessToken));
  await fs.rm(join(f.directory, "users.json"));
  await assert.rejects(
    service.authenticateAccess(result.accessToken),
    unavailable,
  );
});
test("JSON credential publication survives process termination before session cleanup without upgrading old restricted proof", async (t) => {
  const f = await fixture(t),
    service = f.service(),
    result = await service.login(f.body(), randomUUID()),
    replacement = await hashPassword(password);
  const moduleUrl = new URL(
    "../dist/infrastructure/json/security.js",
    import.meta.url,
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {JsonSecurityCoordinator} from ${JSON.stringify(moduleUrl)}; process.on("message",async ({directory,hash})=>{const security=new JsonSecurityCoordinator(directory);await security.run(async()=>{const rows=await security.store.read("users");rows[0]={...rows[0],passwordHash:hash,mustChangePassword:false};await security.store.replace("users",rows);});process.send("published");});setInterval(()=>{},10000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true },
  );
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await closed;
  });
  child.send({ directory: f.directory, hash: replacement });
  const [ack] = await once(child, "message");
  assert.equal(ack, "published");
  child.kill();
  await closed;
  const fresh = createJsonSessions(
    new JsonSecurityCoordinator(f.directory),
    f.now,
  );
  const reopened = createSessions(
    fresh,
    f.verify,
    f.record,
    f.config,
    f.tokens,
    sessionProofs,
  );
  await assert.rejects(
    reopened.authenticateAccess(result.accessToken),
    invalid,
  );
  await assert.rejects(
    reopened.refresh({ refreshToken: result.refreshToken }, randomUUID()),
    invalid,
  );
  assert.equal((await f.rows())[0].revokedAt, null);
  const login = await reopened.login(f.body(), randomUUID());
  assert.equal(login.user.mustChangePassword, false);
});
test(
  "real SQL migration preserves unbound legacy rows, refuses old schema and rolls back session insert failure",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL, timeout: 30000 },
  async (t) => {
    const f = await fixture(t, "postgresql", true),
      id = randomUUID(),
      hash = refreshDigest("legacy");
    await f.admin.query(
      "INSERT INTO user_sessions(id,user_id,refresh_token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)",
      [
        id,
        f.data.users[0].id,
        hash,
        new Date(f.clock.value),
        new Date(f.clock.value + 10000),
      ],
    );
    assert.equal(await f.repository.ready(), false);
    await assert.rejects(
      f.repository.admit(id, f.data.users[0].id),
      unavailable,
    );
    await runMigrations(f.admin, f.migrations);
    assert.equal(await f.repository.ready(), true);
    const legacy = (await f.rows())[0];
    assert.equal(legacy.refreshTokenHash, hash);
    assert.equal(legacy.credentialFingerprint, null);
    await assert.rejects(f.repository.admit(id, f.data.users[0].id), invalid);
    assert.equal((await runMigrations(f.admin, f.migrations)).applied, 0);
    await f.admin.query(
      "CREATE FUNCTION fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_INSERT_FAILURE'; END $$",
    );
    await f.admin.query(
      "CREATE TRIGGER fail_session BEFORE INSERT ON user_sessions FOR EACH ROW EXECUTE FUNCTION fail_session()",
    );
    await assert.rejects(
      f.service().login(f.body(), randomUUID()),
      unavailable,
    );
    assert.equal((await f.rows()).length, 1);
    await f.admin.query("DROP TRIGGER fail_session ON user_sessions");
    assert.ok(await f.service().login(f.body(), randomUUID()));
  },
);
test("actual session HTTP flow has safe envelopes/no-store/privacy, strict bearer and restricted first-login denial", async (t) => {
  const f = await fixture(t),
    service = f.service(),
    logs = [];
  await f.setUser({ mustChangePassword: false });
  const url = await serve(
    t,
    createApp({
      login: f.credentialLogin,
      sessionLogin: service.login,
      sessions: service,
      logger: (_level, event) => logs.push(event),
    }),
  );
  const response = await post(url + "/api/v1/auth/login", f.body());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  const result = (await response.json()).data;
  assert.equal(
    (
      await fetch(url + "/api/v1/auth/me", {
        headers: { Authorization: "Bearer " + result.accessToken },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(url + "/api/v1/auth/me", {
        headers: { Authorization: "Bearer " + result.refreshToken },
      })
    ).status,
    401,
  );
  const restricted = (
    await (await post(url + "/api/v1/auth/login", f.body(2))).json()
  ).data;
  assert.equal(
    (
      await fetch(url + "/api/v1/auth/me", {
        headers: { Authorization: "Bearer " + restricted.accessToken },
      })
    ).status,
    403,
  );
  const rotated = await post(url + "/api/v1/auth/refresh", {
    refreshToken: result.refreshToken,
  });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.headers.get("cache-control"), "no-store");
  assert.equal(
    (
      await post(url + "/api/v1/auth/refresh", {
        refreshToken: result.refreshToken,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await post(url + "/api/v1/auth/refresh", {
        refreshToken: "bad",
        role: "INTERNAL_ADMIN",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post(url + "/api/v1/auth/refresh", {
        refreshToken: "x".repeat(5000),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await post(
        url + "/api/v1/auth/refresh",
        { refreshToken: "bad" },
        { "content-type": "text/plain" },
      )
    ).status,
    415,
  );
  for (const sentinel of [
    password,
    f.hash,
    result.accessToken,
    result.refreshToken,
    "example.test",
    "credentialFingerprint",
  ])
    assert.ok(!JSON.stringify(logs).includes(sentinel));
});
test("missing session configuration leaves refresh/me unavailable and never invents a signing key", async (t) => {
  const url = await serve(t, createApp({ logger: () => {} }));
  assert.equal(
    (await post(url + "/api/v1/auth/refresh", { refreshToken: "bad" })).status,
    503,
  );
  assert.equal((await fetch(url + "/api/v1/auth/me")).status, 503);
});
test("offline catalog preserves session bytes while confirmed demo reset clears them and still rejects unknown files", async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), "b2b28-offline-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "b2b_demo_sessions");
  await seedJson(directory, {
    mode: "seed",
    confirmTarget: "b2b_demo_sessions",
  });
  const bytes = '[{"private":"session sentinel"}]\n';
  await fs.writeFile(join(directory, "user_sessions.json"), bytes);
  const store = new JsonSecurityCoordinator(directory).store;
  await createJsonCatalogCache(directory, "b2b_demo_sessions", true).refresh(
    () => ({
      products: [],
      customer_product_access: [],
      customer_product_prices: [],
    }),
  );
  assert.equal(
    await fs.readFile(join(directory, "user_sessions.json"), "utf8"),
    bytes,
  );
  assert.ok((await store.read("users")).length > 0);
  await fs.writeFile(join(directory, "unknown-private.json"), "{}");
  await assert.rejects(
    seedJson(directory, { mode: "reset", confirmTarget: "b2b_demo_sessions" }),
  );
  await fs.rm(join(directory, "unknown-private.json"));
  await seedJson(directory, {
    mode: "reset",
    confirmTarget: "b2b_demo_sessions",
  });
  await assert.rejects(fs.readFile(join(directory, "user_sessions.json")), {
    code: "ENOENT",
  });
});
