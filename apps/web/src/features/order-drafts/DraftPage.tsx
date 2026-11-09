import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useSearchParams } from "react-router";
import { useAuth } from "../authentication/AuthContext";
import {
  CatalogClient,
  customerCatalogAdapter,
  type CatalogProduct,
} from "../catalog/api";
import {
  AddressClient,
  authenticatedAddressAdapter,
  type DeliveryAddress,
} from "../delivery-addresses/api";
import { Page } from "../../shell/pages";
import { Button, Field } from "../../shared/ui";
import { entityId, RemoteError, remoteMessage } from "../../shared/remote";
import {
  DraftClient,
  meetsMinimum,
  quantity,
  type Basket,
  type Draft,
  type Item,
} from "./api";

function Line({
  item,
  product,
  busy,
  save,
  remove,
}: {
  item: Item;
  product: CatalogProduct | null;
  busy: boolean;
  save: (value: string) => void;
  remove: () => void;
}) {
  const [value, setValue] = useState(item.quantity),
    [error, setError] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error) inputRef.current?.focus();
  }, [error]);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (
      !quantity(value) ||
      (product && !meetsMinimum(value, product.minimumOrderQuantity))
    ) {
      setError(
        product
          ? `Enter a positive quantity of at least ${product.minimumOrderQuantity} ${product.sellingUom}, with up to 12 integer and 6 fractional digits.`
          : "Enter a positive decimal with up to 12 integer and 6 fractional digits.",
      );
      return;
    }
    setError("");
    save(value);
  }
  return (
    <li className="panel draft-line">
      <h3>{product?.name ?? "Product unavailable"}</h3>
      {product ? (
        <p>
          SKU {product.sku} · Minimum {product.minimumOrderQuantity}{" "}
          {product.sellingUom}
        </p>
      ) : (
        <p>Product details are unavailable. You can still remove this item.</p>
      )}
      <form onSubmit={submit} noValidate>
        <Field
          ref={inputRef}
          label={`Quantity for ${product?.name ?? "unavailable product"}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="decimal"
          aria-invalid={!!error}
          hint={error || "Use a positive decimal quantity."}
        />
        <Button type="submit" unavailable={busy}>
          Update quantity
        </Button>{" "}
        <Button variant="secondary" unavailable={busy} onClick={remove}>
          Remove item
        </Button>
      </form>
    </li>
  );
}
function Connected() {
  const { client: session, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const client = useMemo(
    () => new DraftClient(session, user!),
    [session, user],
  );
  const catalog = useMemo(
    () =>
      new CatalogClient(
        customerCatalogAdapter((path, signal) => session.read(path, signal)),
      ),
    [session],
  );
  const addresses = useMemo(
    () => new AddressClient(user!, authenticatedAddressAdapter(session)),
    [session, user],
  );
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [basket, setBasket] = useState<Basket | null>(null),
    [products, setProducts] = useState<Record<string, CatalogProduct | null>>(
      {},
    ),
    [locations, setLocations] = useState<DeliveryAddress[]>([]),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<RemoteError | null>(null),
    [reloadRequired, setReloadRequired] = useState(false),
    [message, setMessage] = useState(""),
    [amount, setAmount] = useState(""),
    [formError, setFormError] = useState("");
  const errorRef = useRef<HTMLDivElement>(null),
    lock = useRef(false);
  const selected = params.get("draft"),
    pending = params.get("product"),
    validPending = entityId(pending) ? pending : null;
  const list = useCallback(() => client.list(offset), [client, offset]);
  const load = useCallback(
    () =>
      selected && entityId(selected)
        ? client.read(selected)
        : Promise.resolve(null),
    [client, selected],
  );
  useEffect(() => {
    let alive = true;
    Promise.all([list(), load()])
      .then(([result, loaded]) => {
        if (!alive) return;
        setDrafts(result.drafts);
        setTotal(result.total);
        setBasket(loaded);
        setError(null);
        setReloadRequired(false);
        setLoading(false);
      })
      .catch((e) => {
        if (alive) {
          setLoading(false);
          setReloadRequired(true);
          setError(
            e instanceof RemoteError ? e : new RemoteError("unavailable"),
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [list, load]);
  useEffect(() => {
    let alive = true;
    const ids = new Set([
      ...(basket?.items.map((i) => i.productId) ?? []),
      ...(validPending ? [validPending] : []),
    ]);
    Promise.all(
      [...ids].map(async (id) => {
        try {
          return [
            id,
            await catalog.detail(id, new AbortController().signal),
          ] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((entries) => {
      if (alive) setProducts(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, [basket, catalog, validPending]);
  useEffect(() => {
    let alive = true;
    addresses
      .read(new AbortController().signal)
      .then((data) => {
        if (alive) setLocations(data.items.filter((i) => i.active));
      })
      .catch(() => {
        if (alive) setLocations([]);
      });
    return () => {
      alive = false;
    };
  }, [addresses]);
  useEffect(() => {
    if (error || formError) errorRef.current?.focus();
  }, [error, formError]);
  const choose = (id: string | null, product = validPending) => {
    if (id !== selected) setLoading(true);
    const next = new URLSearchParams();
    if (id) next.set("draft", id);
    if (product) next.set("product", product);
    setParams(next);
  };
  async function action(fn: () => Promise<void>) {
    if (lock.current || busy || loading || reloadRequired) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof RemoteError ? e : new RemoteError("unavailable"));
      setReloadRequired(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const [result, loaded] = await Promise.all([list(), load()]);
      setDrafts(result.drafts);
      setTotal(result.total);
      setBasket(loaded);
      setError(null);
      setReloadRequired(false);
      setMessage("Latest details loaded.");
    } catch (e) {
      setError(e instanceof RemoteError ? e : new RemoteError("unavailable"));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const change = (fn: (b: Basket) => Promise<Basket>) => {
    if (!basket || basket.draft.id !== selected) return;
    void action(async () => {
      setBasket(await fn(basket));
      setMessage("Draft saved.");
    });
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const product = validPending ? products[validPending] : null;
    if (
      !basket ||
      basket.draft.id !== selected ||
      !validPending ||
      !product ||
      !quantity(amount) ||
      !meetsMinimum(amount, product.minimumOrderQuantity)
    ) {
      setFormError(
        "Enter an available product quantity at or above its minimum, using up to 12 integer and 6 fractional digits.",
      );
      return;
    }
    setFormError("");
    void action(async () => {
      setBasket(await client.add(basket, validPending, amount));
      setAmount("");
      choose(basket.draft.id, null);
      setMessage("Item added to draft.");
    });
  };
  return (
    <Page
      title="Draft orders"
      eyebrow="Orders"
      description="Create and manage your own draft orders."
    >
      <div role="status">{busy ? "Loading or saving…" : message}</div>
      {(error || formError) && (
        <div className="application-error" tabIndex={-1} ref={errorRef}>
          <h2>Check your draft</h2>
          <p>{formError || (error && remoteMessage(error, true))}</p>
          {reloadRequired && (
            <Button variant="secondary" onClick={() => void refresh()}>
              Reload latest details
            </Button>
          )}
        </div>
      )}
      <div className="draft-layout">
        <section className="panel draft-panel">
          <h2>Your drafts</h2>
          <p>
            Drafts are visible to their creator. Results are grouped by order
            page.
          </p>
          <Button
            unavailable={busy || loading || reloadRequired}
            onClick={() =>
              void action(async () => {
                const draft = await client.create();
                choose(draft.id);
                setMessage("Draft created.");
              })
            }
          >
            Create draft
          </Button>
          <ul>
            {drafts.map((d) => (
              <li key={d.id}>
                <button
                  className="button button-quiet"
                  disabled={busy || loading || reloadRequired}
                  type="button"
                  onClick={() => choose(d.id)}
                >
                  {new Date(d.createdAt).toLocaleString()} · {d.id.slice(0, 8)}
                </button>
              </li>
            ))}
          </ul>
          {drafts.length === 0 && !busy && !loading && (
            <p>No accessible drafts on this page.</p>
          )}
          <nav aria-label="Order pages">
            <Button
              variant="secondary"
              unavailable={busy || loading || offset === 0}
              onClick={() => {
                setLoading(true);
                setOffset(Math.max(0, offset - 20));
              }}
            >
              Previous
            </Button>{" "}
            <span>
              Page {Math.floor(offset / 20) + 1} · {total} company orders
            </span>{" "}
            <Button
              variant="secondary"
              unavailable={busy || loading || offset + 20 >= total}
              onClick={() => {
                setLoading(true);
                setOffset(offset + 20);
              }}
            >
              Next
            </Button>
          </nav>
        </section>
        <section className="panel draft-panel">
          <h2>
            {basket && basket.draft.id === selected
              ? "Draft details"
              : "Choose a draft"}
          </h2>
          {!basket || basket.draft.id !== selected ? (
            <p>Select a draft or create one to add products.</p>
          ) : (
            <>
              <p>
                Draft · {basket.draft.id.slice(0, 8)} · Saved{" "}
                {new Date(basket.draft.updatedAt).toLocaleString()}
              </p>
              <label htmlFor="draft-address">Delivery address</label>
              <select
                id="draft-address"
                value={basket.draft.deliveryAddressId ?? ""}
                disabled={busy || loading || reloadRequired}
                onChange={(e) =>
                  change((b) => client.address(b, e.target.value || null))
                }
              >
                <option value="">No address selected</option>
                {basket.draft.deliveryAddressId &&
                  !locations.some(
                    (a) => a.id === basket.draft.deliveryAddressId,
                  ) && (
                    <option value={basket.draft.deliveryAddressId}>
                      Previously selected address unavailable
                    </option>
                  )}
                {locations.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} — {a.address.line1}
                  </option>
                ))}
              </select>
              <p>
                <Link to="/company/addresses">Manage delivery addresses</Link>
              </p>
              <h3>Items</h3>
              {basket.items.length === 0 ? (
                <p>Your draft has no items yet.</p>
              ) : (
                <ul className="draft-lines">
                  {basket.items.map((item) => (
                    <Line
                      key={`${item.id}:${item.quantity}`}
                      item={item}
                      product={products[item.productId] ?? null}
                      busy={busy || loading || reloadRequired}
                      save={(v) => change((b) => client.update(b, item, v))}
                      remove={() => change((b) => client.remove(b, item))}
                    />
                  ))}
                </ul>
              )}
              {validPending && (
                <form onSubmit={add} noValidate>
                  <h3>Add {products[validPending]?.name ?? "product"}</h3>
                  <p>
                    {products[validPending]
                      ? `Minimum ${products[validPending].minimumOrderQuantity} ${products[validPending].sellingUom}`
                      : "Product details unavailable."}
                  </p>
                  <Field
                    label="Quantity to add"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    aria-invalid={!!formError}
                    hint={formError || "Enter a positive decimal quantity."}
                  />
                  <Button
                    type="submit"
                    unavailable={
                      busy ||
                      loading ||
                      reloadRequired ||
                      !products[validPending]
                    }
                  >
                    Add to draft
                  </Button>
                </form>
              )}
              <p>
                <Link to="/catalog">Browse products</Link>
              </p>
              <Button
                variant="danger"
                unavailable={
                  busy || loading || reloadRequired || basket.items.length > 0
                }
                onClick={() =>
                  void action(async () => {
                    await client.delete(basket);
                    choose(null, null);
                    setMessage("Draft deleted.");
                  })
                }
              >
                Delete empty draft
              </Button>
              {basket.items.length > 0 && (
                <p>Remove all items before deleting this draft.</p>
              )}
              <p>
                Drafts are not submitted. Submission and final validation are
                not available here.
              </p>
            </>
          )}
        </section>
      </div>
    </Page>
  );
}
export function DraftEntry() {
  const { user } = useAuth();
  if (
    !user ||
    user.mustChangePassword ||
    !user.companyId ||
    !(user.role === "CUSTOMER_ADMIN" || user.role === "CUSTOMER_USER")
  )
    return (
      <Page
        title="Draft orders"
        description="Sign in with a customer account to manage your drafts."
      >
        <Link to="/login">Sign in</Link>
      </Page>
    );
  return <Connected key={`${user.id}:${user.companyId}`} />;
}
