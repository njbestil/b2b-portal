import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { authFixture } from "./auth-fixture.mjs";
import { createAuthorization } from "../../dist/services/authorization.js";
import { createOrderDrafts } from "../../dist/services/order-drafts.js";
import { createJsonOrderDrafts } from "../../dist/infrastructure/json/order-drafts.js";
import { createPostgresOrderDrafts } from "../../dist/infrastructure/postgres-order-drafts.js";
import { createMockCustomerCatalogSource } from "../../dist/infrastructure/mock-customer-catalog-adapter.js";
import { createApp as createMock } from "../../../mock-erp/dist/app.js";
export async function businessFixture(t, provider) {
  const f = await authFixture(t, provider);
  for (let i = 0; i < f.data.users.length; i++)
    await f.setUser({ mustChangePassword: false }, i);
  const cid = f.data.companies[0].id,
    addressId = randomUUID();
  if (provider === "json")
    await fs.writeFile(
      join(f.directory, "delivery_addresses.json"),
      JSON.stringify([
        {
          id: addressId,
          companyId: cid,
          label: "Delivery",
          address: { line1: "Synthetic" },
          active: true,
          isDefault: false,
        },
      ]),
    );
  else {
    await f.pool.query(
      "UPDATE companies SET erp_customer_reference=$1 WHERE id=$2",
      ["DEMO-C001", cid],
    );
    await f.pool.query(
      "INSERT INTO delivery_addresses(id,company_id,label,address,active,is_default) VALUES($1,$2,'Delivery',$3::jsonb,true,false)",
      [addressId, cid, JSON.stringify({ line1: "Synthetic" })],
    );
    for (const p of f.data.products)
      await f.pool.query(
        "INSERT INTO products(id,erp_product_reference,sku,name,selling_uom,minimum_order_quantity,active) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          p.id,
          p.erpProductReference,
          p.sku,
          p.name,
          p.sellingUom,
          p.minimumOrderQuantity,
          p.active,
        ],
      );
    for (const a of f.data.customer_product_access)
      await f.pool.query(
        "INSERT INTO customer_product_access(id,company_id,product_id,eligible) VALUES($1,$2,$3,$4)",
        [randomUUID(), a.companyId, a.productId, a.eligible],
      );
  }
  f.repo =
    provider === "json"
      ? createJsonOrderDrafts(f.security, f.now)
      : createPostgresOrderDrafts(f.pool, f.now);
  f.actor = async (i) =>
    createAuthorization(f.auth.authenticateAccess).admit(
      (await f.login(i)).accessToken,
      "profile.read",
    );
  f.ca = await f.actor(2);
  f.cu = await f.actor(3);
  f.base = createOrderDrafts(f.repo, f.record);
  const draft = (
    await f.base.create(f.ca, { deliveryAddressId: addressId }, randomUUID())
  ).draft;
  f.draft = (
    await f.base.changeItem(
      f.ca,
      draft.id,
      undefined,
      "add",
      {
        version: draft.version,
        productId: f.data.products[0].id,
        quantity: "1",
      },
      randomUUID(),
    )
  ).draft;
  f.server = createMock().listen(0, "127.0.0.1");
  await once(f.server, "listening");
  t.after(
    () =>
      new Promise((r) => {
        f.server.closeAllConnections();
        f.server.close(r);
      }),
  );
  f.source = createMockCustomerCatalogSource({
    baseUrl: "http://127.0.0.1:" + f.server.address().port + "/mock-erp/v1/",
    timeoutMs: 5000,
  });
  f.service = createOrderDrafts(f.repo, f.record, {
    minimum: { amount: "27.5", currency: "AED" },
    source: f.source,
  });
  f.unacknowledged = f.draft;
  const quote = await f.service.terms(f.ca, f.draft.id, {
    version: f.draft.version,
  });
  f.draft = (
    await f.service.acknowledgeTerms(
      f.ca,
      f.draft.id,
      { version: f.draft.version, token: quote.token },
      randomUUID(),
    )
  ).draft;
  return f;
}
