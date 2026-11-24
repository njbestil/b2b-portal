import type { CompanyProfileActor } from "./company-profiles.js";
import type { InternalNotesRepository } from "./internal-notes.js";
/** Execute against the existing private note store while current authority is held. */
export interface OrderNotesRepository {
  run<T>(
    actor: CompanyProfileActor,
    companyId: string,
    operation: (notes: InternalNotesRepository) => Promise<T>,
  ): Promise<T>;
}
