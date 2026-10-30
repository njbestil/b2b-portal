import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "pg";
import { parsePostgresEnvironment } from "@b2b-portal/config/server";
import {
  loadMigrations,
  runMigrations,
} from "../dist/infrastructure/migrations.js";

const directory = new URL("../migrations/", import.meta.url);
const coreTables = [
  "companies",
  "users",
  "customer_sales_assignments",
  "delivery_addresses",
  "products",
  "customer_product_access",
  "customer_product_prices",
  "orders",
  "order_items",
  "order_confirmations",
  "order_cancellation_requests",
  "integration_transactions",
  "invoices",
  "notifications",
  "audit_logs",
  "user_sessions",
  "password_reset_tokens",
].sort();
const tables = [...coreTables, "order_internal_notes"].sort();
const options = {
  skip:
    !process.env.B2B_TEST_MIGRATIONS_DATABASE_URL &&
    "Set B2B_TEST_MIGRATIONS_DATABASE_URL to a disposable PostgreSQL database with schema-creation privileges",
  timeout: 30000,
};
function databaseConfig(value) {
  const parsed = parsePostgresEnvironment({ DATABASE_URL: value });
  assert.ok(parsed, "An explicit disposable test database URL is required");
  return parsed;
}
const config = () =>
  databaseConfig(process.env.B2B_TEST_MIGRATIONS_DATABASE_URL);

async function fixture(t, migrate = true) {
  const admin = new Client({ ...config(), query_timeout: 0 });
  await admin.connect();
  const schema = `b2b_mvp_${randomUUID().replaceAll("-", "")}`;
  const clients = [];
  let created = false;
  t.after(async () => {
    try {
      for (const client of clients) await client.end();
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  const connect = async () => {
    const client = new Client({ ...config(), query_timeout: 0 });
    clients.push(client);
    await client.connect();
    await client.query(`SET search_path TO "${schema}"`);
    return client;
  };
  const client = await connect();
  const migrations = await loadMigrations(directory);
  if (migrate) await runMigrations(client, migrations);
  return { client, connect, migrations, schema };
}

async function base(client) {
  const ids = Object.fromEntries(
    [
      "company",
      "otherCompany",
      "admin",
      "sales",
      "customer",
      "otherCustomer",
      "address",
      "otherAddress",
      "product",
      "order",
    ].map((key) => [key, randomUUID()]),
  );
  await client.query(
    "INSERT INTO companies (id, legal_name, trade_name, status) VALUES ($1,'Demo A','A','ACTIVE'),($2,'Demo B','B','ACTIVE')",
    [ids.company, ids.otherCompany],
  );
  for (const [id, companyId, role] of [
    [ids.admin, null, "INTERNAL_ADMIN"],
    [ids.sales, null, "SALES_STAFF"],
    [ids.customer, ids.company, "CUSTOMER_ADMIN"],
    [ids.otherCustomer, ids.otherCompany, "CUSTOMER_USER"],
  ])
    await client.query(
      "INSERT INTO users (id,company_id,email,password_hash,display_name,role,status) VALUES ($1,$2,$3,'synthetic-test-hash-not-a-credential','Demo',$4,'ACTIVE')",
      [id, companyId, `${id}@example.test`, role],
    );
  for (const [id, companyId] of [
    [ids.address, ids.company],
    [ids.otherAddress, ids.otherCompany],
  ])
    await client.query(
      "INSERT INTO delivery_addresses (id,company_id,label,address,is_default) VALUES ($1,$2,'Demo','{\"city\":\"Demo\"}',true)",
      [id, companyId],
    );
  await client.query(
    "INSERT INTO products (id,erp_product_reference,sku,name,selling_uom,minimum_order_quantity,active,default_price,currency,available_quantity) VALUES ($1,'DEMO-P001','DEMO-APPLE-KG','Apples','KG',0.5,true,8.25,'AED',25.5)",
    [ids.product],
  );
  await client.query(
    "INSERT INTO orders (id,company_id,created_by_user_id,delivery_address_id,order_status,integration_status) VALUES ($1,$2,$3,$4,'SUBMITTED','FAILED')",
    [ids.order, ids.company, ids.customer, ids.address],
  );
  return ids;
}

test("shipped migration discovers exactly the approved core tables, without transaction control or internal notes", async () => {
  assert.throws(() => databaseConfig(" "));
  const migrations = await loadMigrations(directory);
  assert.equal(migrations.length, 2);
  assert.equal(migrations[0].version, 1);
  assert.equal(migrations[0].name, "mvp_schema");
  const sql = migrations[0].sql;
  assert.deepEqual(
    [...sql.matchAll(/CREATE TABLE (\w+) \(/g)].map((m) => m[1]).sort(),
    coreTables,
  );
  assert.doesNotMatch(
    sql,
    /\b(?:BEGIN|COMMIT|ROLLBACK|TRUNCATE|GRANT|CREATE EXTENSION)\b|order_internal_notes/,
  );
});

test(
  "real MVP schema: empty apply/rerun creates UUID tables, validated keys and query indexes",
  options,
  async (t) => {
    const { client, schema, migrations } = await fixture(t, false);
    assert.deepEqual(await runMigrations(client, migrations), {
      applied: 2,
      skipped: 0,
    });
    assert.deepEqual(await runMigrations(client, migrations), {
      applied: 0,
      skipped: 2,
    });
    const actual = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name",
      [schema],
    );
    assert.deepEqual(
      actual.rows.map((r) => r.table_name),
      [...tables, "schema_migrations"].sort(),
    );
    for (const table of tables) {
      assert.equal(
        (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]
          .n,
        0,
      );
    }
    const keys = await client.query(
      `SELECT c.relname AS table_name, a.attname, format_type(a.atttypid,a.atttypmod) AS type
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=ANY(k.conkey)
    WHERE n.nspname=$1 AND k.contype='p' AND c.relname <> 'schema_migrations'`,
      [schema],
    );
    assert.equal(keys.rows.length, 18);
    assert.ok(keys.rows.every((r) => r.attname === "id" && r.type === "uuid"));
    const foreignKeys = await client.query(
      "SELECT convalidated FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace WHERE n.nspname=$1 AND contype='f'",
      [schema],
    );
    assert.ok(foreignKeys.rows.length >= 25);
    assert.ok(foreignKeys.rows.every((r) => r.convalidated));
    const indexes = await client.query(
      "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1",
      [schema],
    );
    for (const name of [
      "users_email_unique_idx",
      "assignments_one_active_primary_idx",
      "addresses_one_active_default_idx",
      "orders_company_created_idx",
      "orders_company_status_created_idx",
      "integration_retry_queue_idx",
      "notifications_user_unread_idx",
      "audit_target_created_idx",
      "sessions_expiry_idx",
      "password_resets_expiry_idx",
    ]) {
      assert.ok(
        indexes.rows.some((r) => r.indexname === name),
        name,
      );
    }
    assert.match(
      indexes.rows.find(
        (r) => r.indexname === "assignments_one_active_primary_idx",
      ).indexdef,
      /UNIQUE.*WHERE \(active AND is_primary\)/,
    );
    const history = (await client.query("SELECT * FROM schema_migrations"))
      .rows;
    assert.equal(history.length, 2);
    assert.match(history[0].checksum, /^[a-f0-9]{64}$/);
    assert.ok(history[0].applied_at instanceof Date);
  },
);

test(
  "real MVP schema: valid graph supports every entity, exact decimals and independent order statuses",
  options,
  async (t) => {
    const { client } = await fixture(t);
    const i = await base(client);
    await client.query(
      "INSERT INTO customer_sales_assignments (id,company_id,sales_staff_user_id,assigned_by_user_id) VALUES ($1,$2,$3,$4)",
      [randomUUID(), i.company, i.sales, i.admin],
    );
    await client.query(
      "INSERT INTO customer_product_access (id,company_id,product_id,eligible) VALUES ($1,$2,$3,true)",
      [randomUUID(), i.company, i.product],
    );
    await client.query(
      "INSERT INTO customer_product_prices (id,company_id,product_id,amount,currency) VALUES ($1,$2,$3,$4,'AED')",
      [randomUUID(), i.company, i.product, "7.12345678901234567890"],
    );
    await client.query(
      'INSERT INTO order_items (id,company_id,order_id,product_id,quantity,unit_price,line_total,item_snapshot) VALUES ($1,$2,$3,$4,$5,7.1,3.55,\'{"sku":"HISTORIC","uom":"KG","moq":"0.5"}\')',
      [randomUUID(), i.company, i.order, i.product, "0.12345678901234567890"],
    );
    await client.query(
      "INSERT INTO order_confirmations (id,company_id,order_id,customer_user_id) VALUES ($1,$2,$3,$4)",
      [randomUUID(), i.company, i.order, i.customer],
    );
    await client.query(
      "INSERT INTO order_cancellation_requests (id,company_id,order_id,requested_by_user_id,reason) VALUES ($1,$2,$3,$4,'Demo cancellation')",
      [randomUUID(), i.company, i.order, i.sales],
    );
    await client.query(
      "INSERT INTO integration_transactions (id,company_id,order_id,operation,idempotency_key,status,retryable) VALUES ($1,$2,$3,'SUBMIT_ORDER','demo-transaction','FAILED',true)",
      [randomUUID(), i.company, i.order],
    );
    await client.query(
      "INSERT INTO invoices (id,company_id,order_id,erp_invoice_reference,invoice_number,status,amount,currency) VALUES ($1,$2,$3,'DEMO-INV','INV-1','available',3.55,'AED')",
      [randomUUID(), i.company, i.order],
    );
    await client.query(
      "INSERT INTO notifications (id,user_id,type,title,message) VALUES ($1,$2,'ORDER_UPDATE','Demo','Synthetic notification')",
      [randomUUID(), i.customer],
    );
    await client.query(
      "INSERT INTO audit_logs (id,company_id,actor_user_id,actor_role,action,target_type,target_id) VALUES ($1,$2,$3,'INTERNAL_ADMIN','demo','order',$4)",
      [randomUUID(), i.company, i.admin, i.order],
    );
    await client.query(
      "INSERT INTO user_sessions (id,user_id,refresh_token_hash,expires_at) VALUES ($1,$2,'synthetic-refresh-hash',CURRENT_TIMESTAMP + interval '1 day')",
      [randomUUID(), i.customer],
    );
    await client.query(
      "INSERT INTO password_reset_tokens (id,user_id,token_hash,expires_at) VALUES ($1,$2,'synthetic-reset-hash',CURRENT_TIMESTAMP + interval '1 hour')",
      [randomUUID(), i.customer],
    );
    for (const table of coreTables)
      assert.ok(
        (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]
          .n > 0,
        table,
      );
    assert.deepEqual(
      (await client.query("SELECT order_status,integration_status FROM orders"))
        .rows[0],
      { order_status: "SUBMITTED", integration_status: "FAILED" },
    );
    assert.equal(
      (await client.query("SELECT quantity::text AS q FROM order_items"))
        .rows[0].q,
      "0.12345678901234567890",
    );
    assert.equal(
      (
        await client.query(
          "SELECT amount::text AS amount FROM customer_product_prices",
        )
      ).rows[0].amount,
      "7.12345678901234567890",
    );
    await client.query("UPDATE products SET sku='CHANGED' WHERE id=$1", [
      i.product,
    ]);
    assert.equal(
      (
        await client.query(
          "SELECT item_snapshot->>'sku' AS sku FROM order_items",
        )
      ).rows[0].sku,
      "HISTORIC",
    );
  },
);

async function rejects(client, sql, values, expected) {
  await assert.rejects(
    client.query(sql, values),
    (error) => error.code === expected,
  );
}

test(
  "real MVP schema: role/status/uniqueness, finite amounts and quantity checks reject invalid writes",
  options,
  async (t) => {
    const { client } = await fixture(t);
    const i = await base(client);
    for (const sql of [
      "UPDATE users SET company_id=NULL WHERE id=$1",
      "UPDATE users SET role='SALES_STAFF' WHERE id=$1",
      "UPDATE users SET role='UNKNOWN' WHERE id=$1",
      "UPDATE users SET status='UNKNOWN' WHERE id=$1",
    ])
      await rejects(client, sql, [i.customer], "23514");
    await rejects(
      client,
      "UPDATE users SET company_id=$1 WHERE id=$2",
      [i.company, i.sales],
      "23514",
    );
    await rejects(
      client,
      "UPDATE companies SET status='UNKNOWN' WHERE id=$1",
      [i.company],
      "23514",
    );
    await rejects(
      client,
      "UPDATE orders SET order_status='FAILED' WHERE id=$1",
      [i.order],
      "23514",
    );
    await rejects(
      client,
      "UPDATE orders SET integration_status='SUBMITTED' WHERE id=$1",
      [i.order],
      "23514",
    );
    await rejects(
      client,
      "UPDATE users SET email=$1 WHERE id=$2",
      [`${i.customer.toUpperCase()}@EXAMPLE.TEST`, i.otherCustomer],
      "23505",
    );
    for (const value of ["0", "-1", "NaN", "Infinity", "-Infinity"]) {
      await rejects(
        client,
        "UPDATE products SET minimum_order_quantity=$1 WHERE id=$2",
        [value, i.product],
        "23514",
      );
      await rejects(
        client,
        "INSERT INTO order_items (id,company_id,order_id,product_id,quantity) VALUES ($1,$2,$3,$4,$5)",
        [randomUUID(), i.company, i.order, i.product, value],
        "23514",
      );
    }
    for (const column of ["available_quantity", "default_price"]) {
      for (const value of ["-1", "NaN", "Infinity", "-Infinity"])
        await rejects(
          client,
          `UPDATE products SET ${column}=$1 WHERE id=$2`,
          [value, i.product],
          "23514",
        );
    }
    await rejects(
      client,
      "UPDATE products SET currency=NULL WHERE id=$1",
      [i.product],
      "23514",
    );
    await rejects(
      client,
      "UPDATE products SET currency='aed' WHERE id=$1",
      [i.product],
      "23514",
    );
    await rejects(
      client,
      "UPDATE products SET price_valid_from='2026-02-01Z',price_valid_to='2026-01-01Z' WHERE id=$1",
      [i.product],
      "23514",
    );
    await rejects(
      client,
      "INSERT INTO customer_product_prices (id,company_id,product_id,amount,currency,valid_from,valid_to) VALUES ($1,$2,$3,1,'AED','2026-01-01Z','2026-01-01Z')",
      [randomUUID(), i.company, i.product],
      "23514",
    );
    await rejects(
      client,
      "UPDATE delivery_addresses SET active=false WHERE id=$1",
      [i.address],
      "23514",
    );
    await rejects(
      client,
      "INSERT INTO delivery_addresses (id,company_id,label,address,is_default) VALUES ($1,$2,'Second','{}',true)",
      [randomUUID(), i.company],
      "23505",
    );
    await client.query(
      "INSERT INTO customer_sales_assignments (id,company_id,sales_staff_user_id,assigned_by_user_id) VALUES ($1,$2,$3,$4)",
      [randomUUID(), i.company, i.sales, i.admin],
    );
    const otherSales = randomUUID();
    await client.query(
      "INSERT INTO users (id,email,password_hash,display_name,role,status) VALUES ($1,'sales2@example.test','synthetic-hash','Sales 2','SALES_STAFF','ACTIVE')",
      [otherSales],
    );
    await rejects(
      client,
      "INSERT INTO customer_sales_assignments (id,company_id,sales_staff_user_id,assigned_by_user_id) VALUES ($1,$2,$3,$4)",
      [randomUUID(), i.company, otherSales, i.admin],
      "23505",
    );
    await client.query(
      "UPDATE customer_sales_assignments SET active=false,ended_at=CURRENT_TIMESTAMP WHERE company_id=$1",
      [i.company],
    );
    await client.query(
      "INSERT INTO customer_sales_assignments (id,company_id,sales_staff_user_id,assigned_by_user_id) VALUES ($1,$2,$3,$4)",
      [randomUUID(), i.company, otherSales, i.admin],
    );
    await client.query(
      "UPDATE products SET available_quantity=0,default_price=0 WHERE id=$1",
      [i.product],
    );
  },
);

test(
  "real MVP schema: tenant composite references and orphan references fail closed",
  options,
  async (t) => {
    const { client } = await fixture(t);
    const i = await base(client);
    await rejects(
      client,
      "UPDATE orders SET delivery_address_id=$1 WHERE id=$2",
      [i.otherAddress, i.order],
      "23503",
    );
    for (const [sql, values] of [
      [
        "INSERT INTO order_items (id,company_id,order_id,product_id,quantity) VALUES ($1,$2,$3,$4,0.5)",
        [randomUUID(), i.otherCompany, i.order, i.product],
      ],
      [
        "INSERT INTO order_confirmations (id,company_id,order_id,customer_user_id) VALUES ($1,$2,$3,$4)",
        [randomUUID(), i.company, i.order, i.otherCustomer],
      ],
      [
        "INSERT INTO order_cancellation_requests (id,company_id,order_id,requested_by_user_id,reason) VALUES ($1,$2,$3,$4,'Demo')",
        [randomUUID(), i.otherCompany, i.order, i.sales],
      ],
      [
        "INSERT INTO integration_transactions (id,company_id,order_id,operation,idempotency_key) VALUES ($1,$2,$3,'SUBMIT_ORDER','x')",
        [randomUUID(), i.otherCompany, i.order],
      ],
      [
        "INSERT INTO invoices (id,company_id,order_id,erp_invoice_reference,invoice_number,status,amount,currency) VALUES ($1,$2,$3,'X','X','available',1,'AED')",
        [randomUUID(), i.otherCompany, i.order],
      ],
      [
        "INSERT INTO notifications (id,user_id,type,title,message) VALUES ($1,$2,'demo','Demo','Demo')",
        [randomUUID(), randomUUID()],
      ],
    ])
      await rejects(client, sql, values, "23503");
    await rejects(
      client,
      "DELETE FROM companies WHERE id=$1",
      [i.company],
      "23503",
    );
  },
);

test(
  "real MVP schema: price/access, transaction/token keys and expiry/reason checks",
  options,
  async (t) => {
    const { client } = await fixture(t);
    const i = await base(client);
    for (const table of [
      "customer_product_access",
      "customer_product_prices",
    ]) {
      const extra = table.endsWith("access")
        ? ",eligible) VALUES ($1,$2,$3,true)"
        : ",amount,currency) VALUES ($1,$2,$3,0,'AED')";
      const sql = `INSERT INTO ${table} (id,company_id,product_id${extra}`;
      await client.query(sql, [randomUUID(), i.company, i.product]);
      await rejects(client, sql, [randomUUID(), i.company, i.product], "23505");
    }
    const tx =
      "INSERT INTO integration_transactions (id,company_id,order_id,operation,idempotency_key) VALUES ($1,$2,$3,'SUBMIT_ORDER','same-key')";
    await client.query(tx, [randomUUID(), i.company, i.order]);
    await rejects(client, tx, [randomUUID(), i.company, i.order], "23505");
    await rejects(
      client,
      "UPDATE integration_transactions SET retry_count=-1",
      [],
      "23514",
    );
    const tokenTables = [
      ["user_sessions", "refresh_token_hash"],
      ["password_reset_tokens", "token_hash"],
    ];
    for (const [table, column] of tokenTables) {
      const sql = `INSERT INTO ${table} (id,user_id,${column},expires_at) VALUES ($1,$2,'synthetic-hash',CURRENT_TIMESTAMP + interval '1 hour')`;
      await client.query(sql, [randomUUID(), i.customer]);
      await rejects(client, sql, [randomUUID(), i.customer], "23505");
      await rejects(
        client,
        `UPDATE ${table} SET expires_at=created_at`,
        [],
        "23514",
      );
    }
    await rejects(
      client,
      "INSERT INTO order_cancellation_requests (id,company_id,order_id,requested_by_user_id,reason) VALUES ($1,$2,$3,$4,' ')",
      [randomUUID(), i.company, i.order, i.customer],
      "23514",
    );
    await rejects(
      client,
      "INSERT INTO order_confirmations (id,company_id,order_id,customer_user_id,status) VALUES ($1,$2,$3,$4,'REJECTED')",
      [randomUUID(), i.company, i.order, i.customer],
      "23514",
    );
  },
);

test(
  "real MVP schema: initial DDL/history roll back atomically on later failure and concurrent runners apply once",
  options,
  async (t) => {
    const { client, connect, migrations } = await fixture(t, false);
    await assert.rejects(
      runMigrations(client, [
        ...migrations,
        {
          version: 3,
          name: "failure_probe",
          sql: "SELECT definitely_not_a_function();",
        },
      ]),
    );
    assert.equal(
      (
        await client.query(
          "SELECT to_regclass('companies') AS business, to_regclass('schema_migrations') AS history",
        )
      ).rows[0].business,
      null,
    );
    assert.equal(
      (await client.query("SELECT to_regclass('schema_migrations') AS history"))
        .rows[0].history,
      null,
    );
    const second = await connect();
    const results = await Promise.all([
      runMigrations(client, migrations),
      runMigrations(second, migrations),
    ]);
    assert.deepEqual(
      results.sort((a, b) => b.applied - a.applied),
      [
        { applied: 2, skipped: 0 },
        { applied: 0, skipped: 2 },
      ],
    );
  },
);

test(
  "real MVP schema: actual migration CLI creates public schema in an isolated empty database and skips on rerun",
  {
    timeout: 30000,
    skip:
      !process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL &&
      "Set B2B_TEST_MIGRATIONS_CLI_DATABASE_URL to a disposable PostgreSQL cluster with CREATEDB privileges",
  },
  async (t) => {
    const admin = new Client({
      ...databaseConfig(process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL),
      query_timeout: 0,
    });
    await admin.connect();
    const name = `b2b_mvp_cli_${randomUUID().replaceAll("-", "")}`;
    let created = false;
    t.after(async () => {
      try {
        if (created) await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    });
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    const url = new URL(process.env.B2B_TEST_MIGRATIONS_CLI_DATABASE_URL);
    url.pathname = `/${name}`;
    const entry = fileURLToPath(new URL("../dist/migrate.js", import.meta.url));
    for (const expected of [
      { applied: 2, skipped: 0 },
      { applied: 0, skipped: 2 },
    ]) {
      const result = spawnSync(process.execPath, [entry], {
        env: {
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          DATABASE_URL: url.toString(),
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      const record = JSON.parse(result.stdout);
      assert.equal(record.event, "migrations.completed");
      assert.equal(record.applied, expected.applied);
      assert.equal(record.skipped, expected.skipped);
    }
    const inspect = new Client({
      ...databaseConfig(url.toString()),
      query_timeout: 0,
    });
    await inspect.connect();
    try {
      const result = await inspect.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      );
      assert.deepEqual(
        result.rows.map((r) => r.tablename),
        [...tables, "schema_migrations"].sort(),
      );
    } finally {
      await inspect.end();
    }
  },
);
