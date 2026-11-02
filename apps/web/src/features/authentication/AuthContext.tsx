import {
  createContext,
  useContext,
  useState,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { SessionClient } from "./session";
import {
  createPasswordFlows,
  httpPasswordProducer,
  type PasswordFlows,
} from "./passwords";
export type { PasswordFlows } from "./passwords";

/** Feature-level UI port, not an invented HTTP DTO. Bind only after producer handoff. */
const AuthContext = createContext<{
  client: SessionClient;
  passwords: PasswordFlows;
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
  const connected = useMemo(
    () => createPasswordFlows(httpPasswordProducer(client)),
    [client],
  );
  return (
    <AuthContext
      value={{
        client,
        passwords: passwords ?? connected,
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
