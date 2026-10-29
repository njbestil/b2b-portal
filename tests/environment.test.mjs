import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import test from "node:test";
import {
  EnvironmentConfigurationError,
  parseServerEnvironment,
} from "@b2b-portal/config/server";

const repository = fileURLToPath(new URL("../", import.meta.url));
const services = [
  { name: "api", prefix: "API", response: "b2b-portal-api" },
  { name: "mock-erp", prefix: "MOCK_ERP", response: "b2b-portal-mock-erp" },
];

function validEnvironment(service, overrides = {}) {
  return {
    NODE_ENV: "test",
    [`${service.prefix}_HOST`]: "127.0.0.1",
    [`${service.prefix}_PORT`]: "3000",
    ...overrides,
  };
}

// Keep application tests independent of the user's local environment and .env.
function processEnvironment(overrides) {
  return {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...overrides,
  };
}

function entryPoint(service) {
  return join(repository, "apps", service.name, "dist", "index.js");
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

test("the committed .env.example configures both services", async () => {
  const example = parseEnv(
    await readFile(join(repository, ".env.example"), "utf8"),
  );
  assert.deepEqual(parseServerEnvironment("api", example), {
    nodeEnv: "development",
    host: "127.0.0.1",
    port: 3000,
  });
  assert.deepEqual(parseServerEnvironment("mock-erp", example), {
    nodeEnv: "development",
    host: "127.0.0.1",
    port: 3001,
  });
});

for (const service of services) {
  test(`${service.name}: valid settings do not require the other service's variables`, () => {
    for (const nodeEnv of ["development", "test", "production"]) {
      for (const host of ["127.0.0.1", "0.0.0.0", "::1", "::", "localhost"]) {
        for (const port of ["1", "3000", "65535"]) {
          assert.deepEqual(
            parseServerEnvironment(
              service.name,
              validEnvironment(service, {
                NODE_ENV: nodeEnv,
                [`${service.prefix}_HOST`]: host,
                [`${service.prefix}_PORT`]: port,
              }),
            ),
            { nodeEnv, host, port: Number(port) },
          );
        }
      }
    }
  });

  test(`${service.name}: required settings reject missing and blank values`, () => {
    for (const key of [
      "NODE_ENV",
      `${service.prefix}_HOST`,
      `${service.prefix}_PORT`,
    ]) {
      for (const value of [undefined, "", "   "]) {
        assert.throws(
          () =>
            parseServerEnvironment(
              service.name,
              validEnvironment(service, { [key]: value }),
            ),
          (error) =>
            error instanceof EnvironmentConfigurationError &&
            error.message.includes(`${key} is required`),
        );
      }
    }
  });

  test(`${service.name}: invalid modes, hosts, and ports are rejected without exposing their values`, () => {
    const cases = [
      ["NODE_ENV", ["staging", "Production", "DO_NOT_LOG_MODE"]],
      [
        `${service.prefix}_HOST`,
        ["https://localhost", "127.0.0.999", "DO_NOT_LOG_HOST"],
      ],
      [
        `${service.prefix}_PORT`,
        [
          "0",
          "65536",
          "-1",
          "1.5",
          "1e3",
          "123abc",
          "Infinity",
          " 3000",
          "3000\n",
          "DO_NOT_LOG_PORT",
        ],
      ],
    ];
    for (const [key, values] of cases) {
      for (const value of values) {
        assert.throws(
          () =>
            parseServerEnvironment(
              service.name,
              validEnvironment(service, { [key]: value }),
            ),
          (error) => {
            assert.ok(error instanceof EnvironmentConfigurationError);
            assert.match(error.message, new RegExp(key));
            if (value.startsWith("DO_NOT_LOG"))
              assert.ok(!error.message.includes(value));
            return true;
          },
        );
      }
    }
    assert.throws(
      () => parseServerEnvironment(service.name, {}),
      (error) =>
        ["NODE_ENV", `${service.prefix}_HOST`, `${service.prefix}_PORT`].every(
          (key) => error.message.includes(key),
        ),
    );
  });

  test(`${service.name}: the actual entry point exits unsuccessfully for each missing setting`, () => {
    for (const key of [
      "NODE_ENV",
      `${service.prefix}_HOST`,
      `${service.prefix}_PORT`,
    ]) {
      const environment = validEnvironment(service);
      delete environment[key];
      const child = spawnSync(process.execPath, [entryPoint(service)], {
        env: processEnvironment(environment),
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      assert.ifError(child.error);
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stderr, new RegExp(`${key} is required`));
      assert.equal(child.stdout, "");
    }
  });

  test(`${service.name}: startup errors redact invalid values`, () => {
    const child = spawnSync(process.execPath, [entryPoint(service)], {
      env: processEnvironment(
        validEnvironment(service, {
          [`${service.prefix}_PORT`]: "DO_NOT_LOG_THIS_VALUE",
        }),
      ),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.match(child.stderr, new RegExp(`${service.prefix}_PORT`));
    assert.ok(!child.stderr.includes("DO_NOT_LOG_THIS_VALUE"));
    assert.equal(child.stdout, "");
  });

  for (const useEnvFile of [false, true]) {
    test(`${service.name}: starts with ${useEnvFile ? ".env values and a process override" : "injected environment values without a .env file"}`, async (t) => {
      const port = await availablePort();
      const directory = await mkdtemp(join(tmpdir(), "b2b-003-env-"));
      const envPath = join(directory, ".env");
      t.after(async () => {
        if (useEnvFile) await unlink(envPath);
        await rmdir(directory);
      });
      if (useEnvFile) {
        await writeFile(
          envPath,
          `NODE_ENV=test\n${service.prefix}_HOST=127.0.0.1\n${service.prefix}_PORT=1\n`,
        );
      }
      const environment = useEnvFile
        ? { [`${service.prefix}_PORT`]: String(port) }
        : validEnvironment(service, {
            [`${service.prefix}_PORT`]: String(port),
          });
      environment.JSON_DATA_DIR = join(directory, "missing-json-data");
      const child = spawn(
        process.execPath,
        [`--env-file-if-exists=${envPath}`, entryPoint(service)],
        {
          cwd: join(repository, "apps", service.name),
          env: processEnvironment(environment),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      const closed = new Promise((resolve) => child.once("close", resolve));
      let childError;
      let stderr = "";
      let stdout = "";
      child.on("error", (error) => {
        childError = error;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      t.after(async () => {
        child.kill();
        await closed;
      });
      let response;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.ifError(childError);
        assert.equal(child.exitCode, null, stderr);
        try {
          response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(1000),
          });
          break;
        } catch {
          await setTimeout(25);
        }
      }
      assert.ok(response, "The service must listen on the configured port");
      assert.equal(response.status, 200);
      const body = await response.json();
      if (service.name === "api") {
        assert.deepEqual(body, {
          success: true,
          data: { service: service.response },
          requestId: response.headers.get("x-request-id"),
        });
        const healthResponse = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        assert.equal(healthResponse.status, 503);
        const healthBody = await healthResponse.json();
        assert.equal(healthBody.error.details.api.status, "up");
        assert.equal(healthBody.error.details.storage.status, "down");
        assert.equal(healthBody.error.details.storage.provider, "json");
        assert.equal(healthBody.error.details.erp.status, "unconfigured");
        let logs = [];
        for (let attempt = 0; attempt < 100; attempt++) {
          logs = stdout
            .slice(0, stdout.lastIndexOf("\n") + 1)
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(JSON.parse);
          if (logs.some((entry) => entry.requestId === healthBody.requestId))
            break;
          await setTimeout(10);
        }
        assert.ok(logs.some((entry) => entry.event === "api.started"));
        assert.ok(
          logs.some(
            (entry) =>
              entry.event === "health.checked" &&
              entry.requestId === healthBody.requestId &&
              entry.health.storage.status === "down" &&
              entry.health.storage.provider === "json" &&
              entry.health.erp.status === "unconfigured",
          ),
        );
        assert.ok(logs.every((entry) => entry.service === "b2b-portal-api"));
      } else {
        assert.deepEqual(body, { service: service.response });
        const erpHealth = await fetch(
          `http://127.0.0.1:${port}/mock-erp/v1/health`,
          { signal: AbortSignal.timeout(1000) },
        );
        assert.equal(erpHealth.status, 200);
        assert.equal(erpHealth.headers.get("cache-control"), "no-store");
        assert.deepEqual(await erpHealth.json(), { status: "up" });
        const masterData = await fetch(
          `http://127.0.0.1:${port}/mock-erp/v1/master-data`,
          { signal: AbortSignal.timeout(1000) },
        );
        assert.equal(masterData.status, 200);
        assert.equal(masterData.headers.get("cache-control"), "no-store");
        const { createMasterData } =
          await import("../apps/mock-erp/dist/master-data.js");
        assert.deepEqual(await masterData.json(), createMasterData());
        const orderUrl = `http://127.0.0.1:${port}/mock-erp/v1/orders`;
        const orderRequest = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "startup-test",
          },
          body: JSON.stringify({
            portalOrderId: "12345678-1234-1234-1234-123456789abc",
            customerId: "DEMO-C001",
            items: [{ productId: "DEMO-P001", quantity: "2" }],
          }),
        };
        const created = await fetch(orderUrl, orderRequest);
        assert.equal(created.status, 201);
        const createdOrder = await created.json();
        assert.equal(createdOrder.status, "created");
        assert.match(createdOrder.erpOrderId, /^[\da-f-]{36}$/);
        const replay = await fetch(orderUrl, orderRequest);
        assert.equal(replay.status, 200);
        assert.deepEqual(await replay.json(), createdOrder);
      }
    });
  }
}
