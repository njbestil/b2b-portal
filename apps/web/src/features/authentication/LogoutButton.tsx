import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../shared/ui";
import { Icon } from "../../shared/Icon";
import { useAuth } from "./AuthContext";
/** Leaving the sidebar must not cancel the user's explicit server revocation. */
export function LogoutButton() {
  const { client, user } = useAuth(),
    navigate = useNavigate(),
    mounted = useRef(true),
    pending = useRef(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!user) return null;
  return (
    <div className="auth-logout">
      <Button
        variant="quiet"
        className="exit-link"
        unavailable={busy}
        onClick={async () => {
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          try {
            await client.logout();
          } catch {
            /* The client records a safe uncertain-outcome notice. */
          } finally {
            pending.current = false;
            if (mounted.current) {
              setBusy(false);
              navigate("/login", { replace: true });
            }
          }
        }}
      >
        <Icon name="logout" />
        Sign out
      </Button>
      <span role="status">{busy ? "Signing out…" : ""}</span>
    </div>
  );
}
