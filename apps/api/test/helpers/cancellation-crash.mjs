import { readFile } from "node:fs/promises";
import { JsonSecurityCoordinator } from "../../dist/infrastructure/json/security.js";
import { createJsonCancellation } from "../../dist/infrastructure/json/cancellation.js";
import { createAuthorization } from "../../dist/services/authorization.js";
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const actor = await createAuthorization(async () => input.actor).admit(
  "synthetic-test-principal",
  "orders.cancel",
);
await createJsonCancellation(
  new JsonSecurityCoordinator(input.directory),
  {
    async cancel() {
      throw Error("No outbound call before interruption");
    },
  },
  Date.now,
  {
    async afterPublish(phase, stage) {
      if (phase === "claim" && stage === "intent") process.exit(77);
    },
  },
)(actor, input.companyId, input.orderId, "process-crash", {
  reason: "Synthetic private reason",
});
throw Error("Expected interruption");
