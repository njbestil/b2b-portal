import { SignJWT, jwtVerify, decodeProtectedHeader } from "jose";
import type { SessionConfiguration } from "./session-config.js";
import { SessionError, sessionId } from "../services/session-state.js";
export function createAccessTokens(
  config: SessionConfiguration,
  now: () => number = Date.now,
) {
  return {
    async issue(userId: string, id: string, sessionExpiry: string) {
      const time = now(),
        iat = Math.floor(time / 1000),
        exp = Math.floor(
          Math.min(
            time + config.accessSeconds * 1000,
            Date.parse(sessionExpiry),
          ) / 1000,
        );
      if (!Number.isFinite(time) || exp <= iat)
        throw new SessionError("invalid_proof");
      const token = await new SignJWT({ sid: id })
        .setProtectedHeader({
          alg: "HS256",
          typ: "b2b-access+jwt",
          kid: config.activeKeyId,
        })
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setSubject(userId)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(config.keys.get(config.activeKeyId)!);
      const disclosedAt = now();
      if (
        !Number.isFinite(disclosedAt) ||
        disclosedAt >= Date.parse(sessionExpiry) ||
        disclosedAt >= exp * 1000
      )
        throw new SessionError("invalid_proof");
      return {
        token,
        expiresAt: exp * 1000,
        expiresIn: exp - Math.floor(disclosedAt / 1000),
      };
    },
    async verify(token: string) {
      try {
        if (
          typeof token !== "string" ||
          token.length > 4096 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
        )
          throw new Error();
        const header = decodeProtectedHeader(token);
        if (
          header.alg !== "HS256" ||
          header.typ !== "b2b-access+jwt" ||
          typeof header.kid !== "string" ||
          Object.keys(header).some(
            (name) => !["alg", "typ", "kid"].includes(name),
          )
        )
          throw new Error();
        const key = config.keys.get(header.kid);
        if (!key) throw new Error();
        const time = now();
        const { payload } = await jwtVerify(token, key, {
          algorithms: ["HS256"],
          issuer: config.issuer,
          audience: config.audience,
          typ: "b2b-access+jwt",
          currentDate: new Date(time),
          clockTolerance: 30,
          requiredClaims: ["sub", "sid", "iat", "exp"],
        });
        if (
          !sessionId(payload.sub) ||
          !sessionId(payload.sid) ||
          !Number.isSafeInteger(payload.iat) ||
          !Number.isSafeInteger(payload.exp) ||
          payload.iat! > Math.floor(time / 1000) + 30 ||
          payload.exp! <= payload.iat! ||
          payload.exp! - payload.iat! > config.accessSeconds ||
          Object.keys(payload).some(
            (name) =>
              !["iss", "aud", "sub", "sid", "iat", "exp"].includes(name),
          )
        )
          throw new Error();
        return {
          userId: payload.sub,
          sessionId: payload.sid,
          expiresAt: payload.exp! * 1000,
        };
      } catch {
        throw new SessionError("invalid_proof");
      }
    },
  };
}
