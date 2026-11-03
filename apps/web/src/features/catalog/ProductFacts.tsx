import type { CatalogProduct } from "./api";
export function ProductFacts({ product }: { product: CatalogProduct }) {
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
          <dt>Pack information</dt>
          <dd>Not supplied</dd>
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
      <p className="catalog-pack-note">
        Pack size and unit conversions have not been supplied.
      </p>
      {!product.price && (
        <p className="catalog-price-note">
          Ordering requires a confirmed account price.
        </p>
      )}
    </>
  );
}
