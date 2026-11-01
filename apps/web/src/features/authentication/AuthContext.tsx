import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { SessionClient } from "./session";
import { createPasswordFlows, type PasswordFlows } from "./passwords";
export type { PasswordFlows } from "./passwords";

/** Feature-level UI port, not an invented HTTP DTO. Bind only after producer handoff. */
const unavailable = createPasswordFlows();
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
