import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AuthError, SessionClient } from "./session";

/** Feature-level UI port, not an invented HTTP DTO. Bind only after producer handoff. */
export interface PasswordFlows {
  changeInitialPassword(
    currentPassword: string,
    newPassword: string,
    signal?: AbortSignal,
  ): Promise<void>;
  requestRecovery(email: string, signal?: AbortSignal): Promise<void>;
  redeemRecovery(
    proof: string,
    newPassword: string,
    signal?: AbortSignal,
  ): Promise<void>;
}
const unavailable: PasswordFlows = {
  async changeInitialPassword() {
    throw new AuthError("unavailable");
  },
  async requestRecovery() {
    throw new AuthError("unavailable");
  },
  async redeemRecovery() {
    throw new AuthError("unavailable");
  },
};
const AuthContext = createContext<{
  client: SessionClient;
  passwords: PasswordFlows;
  passwordFlowsConnected: boolean;
} | null>(null);
export function AuthProvider({
  children,
  client: supplied,
  passwords,
}: {
  children: ReactNode;
  client?: SessionClient;
  passwords?: PasswordFlows;
}) {
  const [client] = useState(() => supplied ?? new SessionClient());
  return (
    <AuthContext
      value={{
        client,
        passwords: passwords ?? unavailable,
        passwordFlowsConnected: !!passwords,
      }}
    >
      {children}
    </AuthContext>
  );
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("Authentication provider is missing.");
  const user = useSyncExternalStore(
    context.client.subscribe,
    context.client.snapshot,
    context.client.snapshot,
  );
  return { ...context, user };
}
