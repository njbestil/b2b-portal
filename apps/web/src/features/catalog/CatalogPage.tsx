import {
  useCallback,
  useId,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useAuth } from "../authentication/AuthContext";
import { Page } from "../../shell/pages";
import { Badge, Button, Field } from "../../shared/ui";
import { Icon } from "../../shared/Icon";
import {
  CatalogClient,
  CatalogError,
  defaultQuery,
  filteredQuery,
  parseQuery,
  queryParams,
  customerCatalogAdapter,
  type CatalogAdapter,
  type CatalogPage,
  type CatalogProduct,
  type CatalogQuery,
} from "./api";
import { CatalogResource, type ResourceState } from "./resource";

function failure(error: CatalogError) {
  if (error.code === "session")
    return "Sign in again to view your company catalogue.";
  if (error.code === "forbidden")
    return "This account cannot access the catalogue.";
  if (error.code === "not-found")
    return "This product is unavailable for this account.";
  if (error.code === "invalid")
    return "Check your catalogue filters and page settings.";
  return "The catalogue is unavailable. Please try again later.";
}
function ResourceError({
  error,
  retry,
}: {
  error: CatalogError;
  retry: () => void;
}) {
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => summary.current?.focus(), [error]);
  return (
    <div
      className="application-error catalog-error"
      tabIndex={-1}
      ref={summary}
    >
      <h2>Unable to show products</h2>
      <p>{failure(error)}</p>
      {error.code === "session" ? (
        <Link to="/login">Sign in</Link>
      ) : (
        error.code !== "forbidden" &&
        error.code !== "not-found" && (
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        )
      )}
    </div>
  );
}
function ProductFacts({ product }: { product: CatalogProduct }) {
  return (
    <>
      <p className="catalog-sku">SKU {product.sku}</p>
      <p className="catalog-price">
        {product.price ? (
          <>
            <strong>
              {product.price.currency} {product.price.amount}
            </strong>
            <span> / {product.sellingUom}</span>
          </>
        ) : (
          <strong>Price unavailable</strong>
        )}
      </p>
      <dl className="catalog-facts">
        <div>
          <dt>Minimum order</dt>
          <dd>
            {product.minimumOrderQuantity} {product.sellingUom}
          </dd>
        </div>
        <div>
          <dt>Selling unit</dt>
          <dd>{product.sellingUom}</dd>
        </div>
        <div>
          <dt>Availability</dt>
          <dd>
            {product.availableQuantity === null
              ? "Not supplied"
              : `${product.availableQuantity} ${product.sellingUom} (cached quantity)`}
          </dd>
        </div>
      </dl>
      {!product.price && (
        <p className="catalog-price-note">
          Ordering requires a confirmed account price.
        </p>
      )}
    </>
  );
}
function ProductVisual() {
  return (
    <div className="catalog-product-image">
      <Icon name="box" />
      <span>Product image unavailable</span>
    </div>
  );
}

export function CatalogView({
  query,
  state,
  apply,
  page,
  clear,
  retry,
}: {
  query: CatalogQuery;
  state: ResourceState<CatalogPage>;
  apply: (
    values: Pick<
      CatalogQuery,
      "search" | "category" | "brand" | "availability"
    >,
  ) => void;
  page: (offset: number) => void;
  clear: () => void;
  retry: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    apply({
      search: String(data.get("search") ?? ""),
      category: String(data.get("category") ?? ""),
      brand: String(data.get("brand") ?? ""),
      availability: String(
        data.get("availability") ?? "all",
      ) as CatalogQuery["availability"],
    });
  }
  const availabilityId = useId();
  const data = state.kind === "ready" ? state.data : null;
  const hasNext =
    !!data &&
    query.offset + query.limit <= 100000 &&
    query.offset + query.limit < data.total;
  return (
    <>
      <form
        className="catalog-tools"
        key={queryParams(query).toString()}
        onSubmit={submit}
      >
        <Field
          type="search"
          label="Search products"
          name="search"
          defaultValue={query.search}
          placeholder="Product name or SKU"
          maxLength={128}
        />
        <Field
          label="Category"
          name="category"
          defaultValue={query.category}
          placeholder="All categories"
          maxLength={128}
        />
        <Field
          label="Brand"
          name="brand"
          defaultValue={query.brand}
          placeholder="All brands"
          maxLength={128}
        />
        <div className="field">
          <label htmlFor={availabilityId}>Availability</label>
          <select
            id={availabilityId}
            name="availability"
            defaultValue={query.availability}
          >
            <option value="all">All availability</option>
            <option value="available">Available</option>
            <option value="unavailable">Unavailable</option>
            <option value="unknown">Unknown availability</option>
          </select>
        </div>
        <Button type="submit">Apply filters</Button>
        <Button variant="secondary" onClick={clear}>
          Clear filters
        </Button>
      </form>
      <p role="status" className="catalog-result-line">
        {state.kind === "loading"
          ? "Loading company products…"
          : data
            ? `${data.total} matching products · ${data.items.length} shown`
            : ""}
      </p>
      {state.kind === "error" && (
        <ResourceError error={state.error} retry={retry} />
      )}
      {data && (
        <>
          {data.items.length === 0 ? (
            <div className="panel catalog-empty">
              <h2>
                {data.total === 0
                  ? "No products match these filters"
                  : "No products on this page"}
              </h2>
              <p>Try different search terms or return to the first page.</p>
              {query.offset > 0 ? (
                <Button variant="secondary" onClick={() => page(0)}>
                  First page
                </Button>
              ) : (
                <Button variant="secondary" onClick={clear}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <ul className="catalog-product-grid">
              {data.items.map((product) => (
                <li key={product.id}>
                  <article className="catalog-product-card">
                    <ProductVisual />
                    <div className="catalog-product-body">
                      <p className="catalog-product-brand">
                        {product.brand ?? "Brand not supplied"} ·{" "}
                        {product.category ?? "Category not supplied"}
                      </p>
                      <h2>
                        <Link
                          to={{
                            pathname: `/catalog/${product.id}`,
                            search: queryParams(query).toString(),
                          }}
                        >
                          {product.name}
                        </Link>
                      </h2>
                      <ProductFacts product={product} />
                      <Link
                        className="button button-secondary"
                        to={{
                          pathname: `/catalog/${product.id}`,
                          search: queryParams(query).toString(),
                        }}
                      >
                        View product
                        <span className="visually-hidden">
                          : {product.name}
                        </span>
                      </Link>
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          )}
          <nav aria-label="Product pages" className="catalog-pagination">
            <Button
              variant="secondary"
              unavailable={query.offset === 0}
              onClick={() => page(Math.max(0, query.offset - query.limit))}
            >
              Previous
            </Button>
            <span>
              {data.items.length
                ? `${query.offset + 1}–${query.offset + data.items.length} of ${data.total}`
                : `0 shown of ${data.total}`}
            </span>
            <Button
              variant="secondary"
              unavailable={!hasNext}
              onClick={() => {
                if (hasNext) page(query.offset + query.limit);
              }}
            >
              Next
            </Button>
          </nav>
        </>
      )}
      <p className="catalog-disclaimer">
        Browsing does not reserve stock. Prices, availability and account
        eligibility must be checked before ordering. Ordering is not available
        from this screen yet.
      </p>
    </>
  );
}
export function ProductView({
  state,
  back,
  retry,
}: {
  state: ResourceState<CatalogProduct>;
  back: string;
  retry: () => void;
}) {
  return (
    <>
      <Link className="catalog-back" to={back}>
        Back to products
      </Link>
      <p role="status">{state.kind === "loading" ? "Loading product…" : ""}</p>
      {state.kind === "error" && (
        <ResourceError error={state.error} retry={retry} />
      )}
      {state.kind === "ready" && (
        <article className="panel catalog-product-detail">
          <ProductVisual />
          <div>
            <Badge>Company catalogue</Badge>
            <h2>Product information</h2>
            <dl className="catalog-facts">
              <div>
                <dt>Brand</dt>
                <dd>{state.data.brand ?? "Not supplied"}</dd>
              </div>
              <div>
                <dt>Category</dt>
                <dd>{state.data.category ?? "Not supplied"}</dd>
              </div>
            </dl>
            <ProductFacts product={state.data} />
            <p className="catalog-disclaimer">
              Cached browsing information does not confirm stock or pricing for
              an order. Ordering is not available from this screen yet.
            </p>
          </div>
        </article>
      )}
    </>
  );
}
function useResource<T>(loader: (signal: AbortSignal) => Promise<T>) {
  const [resource] = useState(() => new CatalogResource<T>());
  const state = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
    resource.snapshot,
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    void resource.load(loader);
    return resource.cancel;
  }, [resource, loader, attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}
function Browse({ client }: { client: CatalogClient }) {
  const [params, setParams] = useSearchParams(),
    serialized = params.toString();
  const parsed = useMemo(() => {
    try {
      return {
        query: parseQuery(new URLSearchParams(serialized)),
        invalid: false,
      };
    } catch {
      return { query: defaultQuery, invalid: true };
    }
  }, [serialized]);
  const loader = useCallback(
    (signal: AbortSignal) =>
      parsed.invalid
        ? Promise.reject(new CatalogError("invalid"))
        : client.list(parsed.query, signal),
    [client, parsed],
  );
  const { state, retry } = useResource(loader);
  const [invalid, setInvalid] = useState(false);
  return (
    <Page
      title="Products & pricing"
      eyebrow="Company catalogue"
      description="Browse eligible company products and the account prices supplied for them."
    >
      <CatalogView
        query={parsed.query}
        state={
          invalid
            ? { kind: "error", error: new CatalogError("invalid") }
            : state
        }
        apply={(values) => {
          try {
            const next = filteredQuery(parsed.query, values);
            setInvalid(false);
            setParams(queryParams(next));
          } catch {
            setInvalid(true);
          }
        }}
        page={(offset) => {
          setInvalid(false);
          setParams(queryParams({ ...parsed.query, offset }));
        }}
        clear={() => {
          setInvalid(false);
          setParams({});
        }}
        retry={retry}
      />
    </Page>
  );
}
function Detail({ client, id }: { client: CatalogClient; id: string }) {
  const [params] = useSearchParams();
  const loader = useCallback(
    (signal: AbortSignal) => client.detail(id, signal),
    [client, id],
  );
  const { state, retry } = useResource(loader);
  let back = "/catalog";
  try {
    const search = queryParams(parseQuery(params)).toString();
    if (search) back += `?${search}`;
  } catch {
    /* Invalid return filters never become API input. */
  }
  return (
    <Page
      title={state.kind === "ready" ? state.data.name : "Product details"}
      eyebrow="Company catalogue"
      description="Product details for your account."
    >
      <ProductView state={state} back={back} retry={retry} />
    </Page>
  );
}
function ConnectedCatalog({ adapter }: { adapter?: CatalogAdapter }) {
  const { client: session } = useAuth();
  const client = useMemo(
      () =>
        new CatalogClient(
          adapter ??
            customerCatalogAdapter((path, signal) =>
              session.read(path, signal),
            ),
        ),
      [adapter, session],
    ),
    { productId } = useParams();
  return productId ? (
    <Detail key={productId} client={client} id={productId} />
  ) : (
    <Browse client={client} />
  );
}
export function CatalogEntry({ adapter }: { adapter?: CatalogAdapter }) {
  const { user } = useAuth();
  if (
    !user ||
    user.mustChangePassword ||
    (user.role !== "CUSTOMER_ADMIN" && user.role !== "CUSTOMER_USER")
  )
    return (
      <Page
        title="Products & pricing"
        eyebrow="Company catalogue"
        description="Sign in with an approved customer account to browse its eligible products and pricing."
      >
        <Link className="button button-primary" to="/login">
          Sign in
        </Link>
      </Page>
    );
  return (
    <ConnectedCatalog key={`${user.id}:${user.companyId}`} adapter={adapter} />
  );
}
