export interface ApplicationInput {
  companyName: string;
  tradeLicenseReference: string;
  businessEmail: string;
  phone: string;
  billingAddress: string;
  deliveryAddress: string;
  administratorName: string;
  administratorEmail: string;
  administratorMobile: string;
  password: string;
}
export type SubmissionFailure =
  "invalid" | "size" | "media" | "rate" | "unavailable";
export class ApplicationSubmissionError extends Error {
  readonly code: SubmissionFailure;
  readonly retryAfter?: number;
  constructor(code: SubmissionFailure, retryAfter?: number) {
    super("Application receipt could not be confirmed.");
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
export const isReceiptReference = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
/** Real HTTP only; synthetic responses belong to explicit tests, never this bundle. */
export async function submitApplication(
  input: ApplicationInput,
  signal?: AbortSignal,
  send: typeof fetch = fetch,
): Promise<string> {
  try {
    const response = await send("/api/v1/customer-applications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify(input),
      signal: AbortSignal.any([
        AbortSignal.timeout(15000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (response.status !== 202) {
      const code: SubmissionFailure =
        response.status === 400
          ? "invalid"
          : response.status === 413
            ? "size"
            : response.status === 415
              ? "media"
              : response.status === 429
                ? "rate"
                : "unavailable";
      const raw = response.headers.get("retry-after") ?? "";
      const seconds = /^[0-9]{1,4}$/.test(raw) ? Number(raw) : 0;
      throw new ApplicationSubmissionError(
        code,
        seconds > 0 && seconds <= 3600 ? seconds : undefined,
      );
    }
    if (
      !/^application\/json(?:;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      throw new ApplicationSubmissionError("unavailable");
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("success" in body) ||
      body.success !== true ||
      !("requestId" in body) ||
      !("data" in body) ||
      !body.data ||
      typeof body.data !== "object" ||
      !("state" in body.data) ||
      body.data.state !== "received" ||
      !("reference" in body.data) ||
      !isReceiptReference(body.data.reference) ||
      body.requestId !== body.data.reference
    )
      throw new ApplicationSubmissionError("unavailable");
    return body.data.reference;
  } catch (error) {
    if (error instanceof ApplicationSubmissionError) throw error;
    throw new ApplicationSubmissionError("unavailable");
  }
}
