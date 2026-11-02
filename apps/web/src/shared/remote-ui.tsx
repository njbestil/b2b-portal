import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { Button } from "./ui";
import { RemoteModel, RemoteError, remoteMessage } from "./remote";
export function useRemote<T>(read: (signal: AbortSignal) => Promise<T>) {
  const [model] = useState(() => new RemoteModel<T>()),
    [attempt, setAttempt] = useState(0);
  const state = useSyncExternalStore(
    model.subscribe,
    model.snapshot,
    model.snapshot,
  );
  useEffect(() => {
    void model.load(read);
    return model.cancel;
  }, [model, read, attempt]);
  return { state, model, reload: () => setAttempt((n) => n + 1) };
}
export function RemoteFailure({
  error,
  mutation = false,
  reload,
}: {
  error: RemoteError;
  mutation?: boolean;
  reload: () => void;
}) {
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => summary.current?.focus(), [error]);
  return (
    <div
      className="application-error account-error"
      tabIndex={-1}
      ref={summary}
    >
      <h2>We need your attention</h2>
      <p>{remoteMessage(error, mutation)}</p>
      {error.code === "session" ? (
        <Link to="/login">Sign in</Link>
      ) : (
        <Button variant="secondary" onClick={reload}>
          Reload latest details
        </Button>
      )}
    </div>
  );
}
