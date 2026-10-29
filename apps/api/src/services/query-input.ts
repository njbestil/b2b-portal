import type { CompanyScope, PageRequest } from "../repositories/common.js";

export function checkedScope(scope: CompanyScope): CompanyScope {
  if (
    !scope ||
    typeof scope.companyId !== "string" ||
    !scope.companyId.trim()
  ) {
    throw new TypeError("An authorized company scope is required.");
  }
  return { companyId: scope.companyId };
}

export function checkedPage(
  page: PageRequest = { offset: 0, limit: 20 },
): PageRequest {
  if (
    !page ||
    !Number.isSafeInteger(page.offset) ||
    page.offset < 0 ||
    !Number.isSafeInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > 100
  ) {
    throw new RangeError(
      "Page offset must be nonnegative and limit must be 1–100.",
    );
  }
  return { offset: page.offset, limit: page.limit };
}
