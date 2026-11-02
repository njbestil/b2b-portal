import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  authFixture,
  oldPassword,
  newPassword,
  barrier,
} from "./helpers/auth-fixture.mjs";
import { createPasswordReset } from "../dist/services/password-reset.js";
import { createJsonPasswordReset } from "../dist/infrastructure/json/password-reset.js";
import { createPostgresPasswordReset } from "../dist/infrastructure/postgres-password-reset.js";
import { createJsonResetFile } from "../dist/infrastructure/json/reset-file.js";
import { JsonSecurityCoordinator } from "../dist/infrastructure/json/security.js";
import { resetProofs } from "../dist/infrastructure/reset-crypto.js";
import {
  hashPassword,
  verifyPassword,
} from "../dist/infrastructure/passwords.js";
import { protectedResetDelivery } from "../dist/infrastructure/reset-handoff.js";
import { createApp } from "../dist/app.js";
const invalid = (e) => e.code === "invalid_proof",
  unavailable = (e) => e.code === "unavailable";
async function fixture(t, provider = "json") {
  const f = await authFixture(t, provider);
  f.resetRepository =
    provider === "json"
      ? createJsonPasswordReset(f.security, f.now)
      : createPostgresPasswordReset(f.pool, f.now);
  f.reset = (hash = hashPassword) =>
    createPasswordReset(
      f.resetRepository,
      hash,
      verifyPassword,
      f.record,
      resetProofs,
    );
  f.issue = async (index = 0) => {
    let token;
    await f
      .reset()
      .issue(f.data.users[index].email, randomUUID(), async (value) => {
        token = value;
      });
    return token;
  };
  f.tokenRows =
    provider === "json"
      ? () => createJsonResetFile(f.directory).read()
      : async () =>
          (
            await f.pool.query(
              'SELECT id,token_hash AS "tokenHash",used_at AS "usedAt",credential_fingerprint AS "credentialFingerprint" FROM password_reset_tokens',
            )
          ).rows;
  return f;
}
async function serve(t, service, logs = []) {
  const server = createApp({
    passwordReset: service,
    logger: (level, event) => logs.push({ level, event }),
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return "http://127.0.0.1:" + server.address().port + "/api/v1/auth/";
}
const post = (url, body, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
test("public request performs identical work without account lookup, proof issuance or account disclosure", async () => {
  const events = [],
    fail = () => assert.fail("public request used private issuance");
  const service = createPasswordReset(
    { issue: fail, inspect: fail, consume: fail },
    fail,
    fail,
    async (e) => events.push(e),
    resetProofs,
  );
  for (const email of [
    "known@example.test",
    "unknown@example.test",
    "suspended@example.test",
  ])
    assert.deepEqual(await service.request({ email }, randomUUID()), {
      received: true,
    });
  assert.equal(events.length, 3);
  assert.equal(JSON.stringify(events).includes("@"), false);
  for (const value of [
    {},
    null,
    [],
    { email: "wrong" },
    { email: "user@example.test", role: "INTERNAL_ADMIN" },
  ])
    await assert.rejects(
      service.request(value, randomUUID()),
      (e) => e.code === "invalid_input",
    );
});
for (const provider of ["json", "postgresql"]) {
  const options = {
    skip:
      provider === "postgresql" && !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL
        ? "Set B2B_TEST_MIGRATIONS_DATABASE_URL"
        : false,
  };
  test(
    provider +
      ": reset is hashed, credential-bound, one-use and requires fresh login while other users stay signed in",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        login = await f.login(),
        sibling = await f.login(),
        other = await f.login(1),
        token = await f.issue();
      const before = JSON.stringify(await f.tokenRows());
      assert.equal(before.includes(token), false);
      assert.equal(before.includes(f.passwordHash), false);
      assert.deepEqual(
        await f.reset().redeem({ token, newPassword }, randomUUID()),
        { requiresLogin: true },
      );
      assert.equal((await f.user()).mustChangePassword, false);
      for (const proof of [login, sibling]) {
        await assert.rejects(
          f.auth.authenticateAccess(proof.accessToken),
          invalid,
        );
        await assert.rejects(
          f.auth.refresh({ refreshToken: proof.refreshToken }, randomUUID()),
          invalid,
        );
      }
      await f.auth.authenticateAccess(other.accessToken);
      await assert.rejects(f.login(), (e) => e.code === "invalid_credentials");
      assert.equal(
        (await f.login(0, newPassword)).user.mustChangePassword,
        false,
      );
      await assert.rejects(
        f.reset().redeem({ token, newPassword: oldPassword }, randomUUID()),
        invalid,
      );
    },
  );
  test(
    provider +
      ": unknown/ineligible users, wrong/expired/legacy proof and prior credential changes deny safely",
    options,
    async (t) => {
      const f = await fixture(t, provider);
      await assert.rejects(
        f
          .reset()
          .issue("unknown@example.test", randomUUID(), () => assert.fail()),
        invalid,
      );
      await f.setUser({ status: "SUSPENDED" });
      await assert.rejects(f.issue(), invalid);
      await f.setUser({ status: "ACTIVE" });
      const old = await f.issue(),
        token = await f.issue();
      await assert.rejects(
        f.reset().redeem({ token: old, newPassword }, randomUUID()),
        invalid,
      );
      const saved = f.clock.value;
      f.clock.value += 1800000;
      await assert.rejects(
        f.reset().redeem({ token, newPassword }, randomUUID()),
        invalid,
      );
      f.clock.value = saved;
      if (provider === "json") {
        const file = createJsonResetFile(f.directory),
          rows = await file.read();
        rows[0].credentialFingerprint = null;
        await file.publish(rows);
      } else
        await f.pool.query(
          "UPDATE password_reset_tokens SET credential_fingerprint=NULL",
        );
      await assert.rejects(
        f.reset().redeem({ token, newPassword }, randomUUID()),
        invalid,
      );
      const fresh = await f.issue(),
        login = await f.login();
      await f.change()(
        login.accessToken,
        { currentPassword: oldPassword, newPassword },
        randomUUID(),
      );
      await assert.rejects(
        f
          .reset()
          .redeem({ token: fresh, newPassword: oldPassword }, randomUUID()),
        invalid,
      );
    },
  );
  test(
    provider +
      ": concurrent full redemptions have one winner; expiry is rechecked after password work",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        token = await f.issue(),
        both = barrier(),
        release = barrier();
      let entered = 0;
      const reset = f.reset(async (value) => {
        const hash = await hashPassword(value);
        if (++entered === 2) both.resolve();
        await release.promise;
        return hash;
      });
      const pending = [
        reset.redeem({ token, newPassword }, randomUUID()),
        reset.redeem({ token, newPassword: newPassword + "2" }, randomUUID()),
      ];
      await both.promise;
      release.resolve();
      const outcomes = await Promise.allSettled(pending);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        outcomes.filter((r) => r.status === "rejected" && invalid(r.reason))
          .length,
        1,
      );
      const next = await f.issue();
      await assert.rejects(
        f
          .reset(async (value) => {
            const hash = await hashPassword(value);
            f.clock.value += 1800000;
            return hash;
          })
          .redeem({ token: next, newPassword: oldPassword }, randomUUID()),
        invalid,
      );
    },
  );
  test(
    provider +
      ": required audit and delivery failures disclose no proof and never restore a committed credential",
    options,
    async (t) => {
      const f = await fixture(t, provider),
        login = await f.login(),
        token = await f.issue();
      await assert.rejects(
        f.reset().issue(f.data.users[0].email, randomUUID(), async () => {
          throw new Error("PRIVATE_DELIVERY");
        }),
        unavailable,
      );
      const fresh = await f.issue();
      f.beforeAudit = async (e) => {
        if (e.action === "password.reset_completed")
          throw new Error("PRIVATE_AUDIT");
      };
      await assert.rejects(
        f.reset().redeem({ token: fresh, newPassword }, randomUUID()),
        unavailable,
      );
      await assert.rejects(
        f.auth.authenticateAccess(login.accessToken),
        invalid,
      );
      await assert.rejects(
        f.reset().redeem({ token, newPassword: oldPassword }, randomUUID()),
        invalid,
      );
      assert.equal(
        await verifyPassword(newPassword, (await f.user()).passwordHash),
        true,
      );
      f.beforeAudit = async () => {
        throw new Error("PRIVATE_AUDIT");
      };
      await assert.rejects(
        f
          .reset()
          .issue(f.data.users[0].email, randomUUID(), () =>
            assert.fail("audit failed but proof delivered"),
          ),
        unavailable,
      );
    },
  );
}
test("JSON before/after credential publication, session cleanup and token cleanup failures keep restart-safe one-use evidence", async (t) => {
  for (const stage of ["before", "after", "sessions", "tokens"])
    await t.test(stage, async (t) => {
      const f = await fixture(t),
        login = await f.login(),
        token = await f.issue();
      const io = {
        ...fs,
        rename: async (...args) => {
          if (
            args[1].endsWith(
              stage === "tokens"
                ? "password_reset_tokens.json"
                : "user_sessions.json",
            ) &&
            ["tokens", "sessions"].includes(stage)
          )
            throw new Error("PRIVATE_PUBLISH");
          return fs.rename(...args);
        },
      };
      const repo = createJsonPasswordReset(
        f.security,
        f.now,
        io,
        async (rows) => {
          if (stage === "before") throw new Error("PRIVATE_BEFORE");
          await f.security.store.replace("users", rows);
          if (stage === "after") throw new Error("PRIVATE_AFTER");
        },
      );
      const service = createPasswordReset(
        repo,
        hashPassword,
        verifyPassword,
        f.record,
        resetProofs,
      );
      await assert.rejects(
        service.redeem({ token, newPassword }, randomUUID()),
        unavailable,
      );
      const reopened = createJsonPasswordReset(
        new JsonSecurityCoordinator(f.directory),
        f.now,
      );
      if (stage === "before") {
        await reopened.inspect(token.split(".")[1], resetProofs.digest(token));
        await f.auth.authenticateAccess(login.accessToken);
      } else {
        await assert.rejects(
          reopened.inspect(token.split(".")[1], resetProofs.digest(token)),
          invalid,
        );
        await assert.rejects(
          f.auth.authenticateAccess(login.accessToken),
          invalid,
        );
        assert.equal(
          await verifyPassword(newPassword, (await f.user()).passwordHash),
          true,
        );
      }
    });
});
test("JSON actual termination around credential publication preserves reset replay denial after reopen", async (t) => {
  for (const stage of ["before", "after"])
    await t.test(stage, async (t) => {
      const f = await fixture(t),
        login = await f.login(),
        token = await f.issue(),
        newHash = await hashPassword(newPassword);
      const script = `
      import {createJsonPasswordReset} from './apps/api/dist/infrastructure/json/password-reset.js';
      import {JsonSecurityCoordinator} from './apps/api/dist/infrastructure/json/security.js';
      const s=new JsonSecurityCoordinator(process.env.SYNTHETIC_DIRECTORY);
      const ack=async()=>{process.send({stage:process.env.SYNTHETIC_STAGE});await new Promise(()=>{});};
      const r=createJsonPasswordReset(s,()=>Number(process.env.SYNTHETIC_NOW),undefined,async(rows)=>{
        if(process.env.SYNTHETIC_STAGE==='before')await ack();
        await s.store.replace('users',rows);
        if(process.env.SYNTHETIC_STAGE==='after')await ack();
      });
      const p=await r.inspect(process.env.SYNTHETIC_ID,process.env.SYNTHETIC_DIGEST);
      await r.consume(process.env.SYNTHETIC_ID,process.env.SYNTHETIC_DIGEST,p,process.env.SYNTHETIC_HASH);
    `;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          cwd: new URL("../../../", import.meta.url),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          env: {
            ...process.env,
            SYNTHETIC_DIRECTORY: f.directory,
            SYNTHETIC_STAGE: stage,
            SYNTHETIC_NOW: String(f.now()),
            SYNTHETIC_ID: token.split(".")[1],
            SYNTHETIC_DIGEST: resetProofs.digest(token),
            SYNTHETIC_HASH: newHash,
          },
        },
      );
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      const [ack] = await once(child, "message");
      assert.equal(ack.stage, stage);
      child.kill();
      await once(child, "exit");
      const reopened = createJsonPasswordReset(
        new JsonSecurityCoordinator(f.directory),
        f.now,
      );
      if (stage === "before") {
        await reopened.inspect(token.split(".")[1], resetProofs.digest(token));
        await f.auth.authenticateAccess(login.accessToken);
      } else {
        await assert.rejects(
          reopened.inspect(token.split(".")[1], resetProofs.digest(token)),
          invalid,
        );
        await assert.rejects(
          f.auth.authenticateAccess(login.accessToken),
          invalid,
        );
      }
    });
});
test(
  "real SQL reset consumption failure rolls back hash, flag, token and session changes",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "postgresql"),
      login = await f.login(),
      token = await f.issue();
    await f.admin.query(
      "CREATE FUNCTION reject_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_RESET_WRITE'; END $$; CREATE TRIGGER reject_reset BEFORE UPDATE ON password_reset_tokens FOR EACH ROW EXECUTE FUNCTION reject_reset()",
    );
    await assert.rejects(
      f.reset().redeem({ token, newPassword }, randomUUID()),
      unavailable,
    );
    assert.equal((await f.user()).passwordHash, f.passwordHash);
    assert.equal((await f.user()).mustChangePassword, true);
    assert.equal((await f.tokenRows())[0].usedAt, null);
    assert.equal((await f.rows())[0].revokedAt, null);
    await f.auth.authenticateAccess(login.accessToken);
  },
);
test("HTTP recovery has non-enumerating receipts, bounded no-store envelopes and no token/credential logging", async (t) => {
  const f = await fixture(t),
    logs = [],
    url = await serve(t, f.reset(), logs);
  for (const email of [f.data.users[0].email, "unknown@example.test"]) {
    const response = await post(url + "forgot-password", { email });
    assert.equal(response.status, 202);
    assert.deepEqual((await response.json()).data, { received: true });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const token = await f.issue();
  const response = await post(url + "reset-password", { token, newPassword });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { requiresLogin: true });
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(
    (await post(url + "reset-password", { token, newPassword: oldPassword }))
      .status,
    401,
  );
  assert.equal(
    (await post(url + "reset-password", { token, newPassword: "weak" })).status,
    400,
  );
  assert.equal(
    (await post(url + "forgot-password", { email: "invalid" })).status,
    400,
  );
  assert.equal(
    (
      await post(
        url + "forgot-password",
        { email: "known@example.test" },
        { "content-type": "text/plain" },
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await post(
        url + "forgot-password",
        { email: "known@example.test" },
        { "content-encoding": "gzip" },
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await post(url + "reset-password", {
        token,
        newPassword: "A1!".repeat(2000),
      })
    ).status,
    413,
  );
  let limited;
  for (let n = 0; n < 12; n++)
    limited = await post(
      url + "forgot-password",
      { email: "valid@example.test" },
      { "x-forwarded-for": String(n) },
    );
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  const serialized = JSON.stringify(logs);
  for (const value of [token, newPassword, oldPassword, f.passwordHash])
    assert.equal(serialized.includes(value), false);
  const missing = await serve(t);
  assert.equal(
    (await post(missing + "forgot-password", { email: "valid@example.test" }))
      .status,
    503,
  );
});
test("protected local operator CLI refuses unsafe gates, then writes synthetic proof only to an exclusive protected artifact", async (t) => {
  const f = await fixture(t),
    root = join(f.directory, "handoff");
  await fs.mkdir(root, { mode: 0o700 });
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop';$acl=[IO.Directory]::GetAccessControl($env:SYNTHETIC_HANDOFF);$acl.SetAccessRuleProtection($true,$false);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);[IO.Directory]::SetAccessControl($env:SYNTHETIC_HANDOFF,$acl)`;
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, env: { ...process.env, SYNTHETIC_HANDOFF: root } },
    );
  }
  const target = join(root, "proof.json"),
    deliver = await protectedResetDelivery(target);
  if (process.platform === "win32") {
    const script = `$acl=[IO.Directory]::GetAccessControl($env:SYNTHETIC_HANDOFF);$rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);[IO.Directory]::SetAccessControl($env:SYNTHETIC_HANDOFF,$acl)`;
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, env: { ...process.env, SYNTHETIC_HANDOFF: root } },
    );
    await assert.rejects(protectedResetDelivery(target));
    const restore = `$acl=[IO.Directory]::GetAccessControl($env:SYNTHETIC_HANDOFF);$acl.PurgeAccessRules([Security.Principal.SecurityIdentifier]::new('S-1-1-0'));[IO.Directory]::SetAccessControl($env:SYNTHETIC_HANDOFF,$acl)`;
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(restore, "utf16le").toString("base64"),
      ],
      { windowsHide: true, env: { ...process.env, SYNTHETIC_HANDOFF: root } },
    );
  } else {
    await fs.chmod(root, 0o755);
    await assert.rejects(protectedResetDelivery(target));
    await fs.chmod(root, 0o700);
  }
  await deliver("synthetic-private-proof", "2026-11-02T10:00:00.000Z");
  assert.equal(
    JSON.parse(await fs.readFile(target, "utf8")).token,
    "synthetic-private-proof",
  );
  await assert.rejects(protectedResetDelivery(target));
  await fs.unlink(target);
  const directory = join(f.directory, "b2b_demo_reset");
  await fs.mkdir(directory);
  for (const name of await fs.readdir(f.directory))
    if (name.endsWith(".json"))
      await fs.copyFile(join(f.directory, name), join(directory, name));
  const args = [
    "apps/api/dist/reset-password-operator.js",
    "--provider",
    "json",
    "--directory",
    directory,
    "--confirm-target",
    directory,
    "--offline",
    "--identity-verified",
    "--email",
    f.data.users[0].email,
    "--output",
    target,
  ];
  const run = (env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: new URL("../../../", import.meta.url),
        windowsHide: true,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (b) => {
        output += b;
      });
      child.stderr.on("data", (b) => {
        output += b;
      });
      child.on("exit", (code) => resolve({ code, output }));
    });
  const denied = await run({
    AUTH_LOCAL_RESET_ENABLED: "false",
    NODE_ENV: "test",
  });
  assert.equal(denied.code, 1);
  const production = await run({
    AUTH_LOCAL_RESET_ENABLED: "true",
    NODE_ENV: "production",
  });
  assert.equal(production.code, 1);
  const result = await run({
    AUTH_LOCAL_RESET_ENABLED: "true",
    NODE_ENV: "test",
  });
  assert.equal(result.code, 0, result.output);
  const artifact = JSON.parse(await fs.readFile(target, "utf8"));
  assert.match(artifact.token, /^p1\./);
  assert.equal(result.output.includes(artifact.token), false);
  assert.equal(result.output.includes(f.data.users[0].email), false);
  const repeat = await run({
    AUTH_LOCAL_RESET_ENABLED: "true",
    NODE_ENV: "test",
  });
  assert.equal(repeat.code, 1);
});
test(
  "reset readiness detects missing SQL capability and corrupt JSON evidence without fallback",
  { skip: !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL },
  async (t) => {
    const sql = await fixture(t, "postgresql");
    assert.equal(await sql.resetRepository.ready(), true);
    await sql.pool.query(
      "ALTER TABLE password_reset_tokens DROP COLUMN credential_fingerprint",
    );
    assert.equal(await sql.resetRepository.ready(), false);
    const json = await fixture(t),
      token = await json.issue(),
      path = join(json.directory, "password_reset_tokens.json");
    const bytes = await fs.readFile(path);
    await fs.writeFile(path, "PRIVATE_CORRUPT");
    assert.equal(await json.resetRepository.ready(), false);
    await assert.rejects(
      json.reset().redeem({ token, newPassword }, randomUUID()),
      unavailable,
    );
    await fs.writeFile(path, bytes);
    assert.equal(await json.resetRepository.ready(), true);
  },
);
test("reset HTTP bounds in-flight work and releases capacity", async (t) => {
  const entered = barrier(),
    release = barrier();
  let count = 0;
  const url = await serve(t, {
    request: async () => {
      if (++count === 2) entered.resolve();
      await release.promise;
      return { received: true };
    },
  });
  const pending = [
    post(url + "forgot-password", { email: "valid@example.test" }),
    post(url + "forgot-password", { email: "valid@example.test" }),
  ];
  await entered.promise;
  assert.equal(
    (await post(url + "forgot-password", { email: "valid@example.test" }))
      .status,
    503,
  );
  release.resolve();
  assert.ok((await Promise.all(pending)).every((r) => r.status === 202));
  assert.equal(
    (await post(url + "forgot-password", { email: "valid@example.test" }))
      .status,
    202,
  );
});
