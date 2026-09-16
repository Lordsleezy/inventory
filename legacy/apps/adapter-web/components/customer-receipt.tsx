import type { CustomerReceipt } from "@floor/domain";

export function ReceiptDocument({ doc }: { doc: CustomerReceipt }) {
  return (
    <article className="receipt-document">
      <header className="receipt-head">
        <h1>{doc.storeName}</h1>
        <p>{doc.storeAddress}</p>
        {doc.storeEmail ? <p>{doc.storeEmail}</p> : null}
      </header>

      <section className="receipt-meta">
        <div>
          <p className="receipt-k">Receipt</p>
          <p className="receipt-v">{doc.reference}</p>
        </div>
        {doc.soldOnLabel ? (
          <div>
            <p className="receipt-k">Date</p>
            <p className="receipt-v">{doc.soldOnLabel}</p>
          </div>
        ) : null}
      </section>

      {doc.customer ? (
        <section className="receipt-customer">
          <p className="receipt-k">Sold to</p>
          {doc.customer.name ? <p className="receipt-v">{doc.customer.name}</p> : null}
          {doc.customer.email ? <p>{doc.customer.email}</p> : null}
        </section>
      ) : null}

      <ul className="receipt-items">
        {doc.lines.map((line) => (
          <li key={line.sku} className="receipt-item">
            <div className="receipt-item-copy">
              <p className="receipt-sku">SKU {line.sku}</p>
              {line.brand || line.model ? (
                <p className="receipt-identity">
                  {[line.brand, line.model].filter(Boolean).join(" ")}
                </p>
              ) : null}
              {line.description ? <p>{line.description}</p> : null}
              <p className="receipt-condition">Condition: {line.condition}</p>
            </div>
            <p className="receipt-amt">{line.priceLabel}</p>
          </li>
        ))}
      </ul>

      <section className="receipt-totals">
        <div className="receipt-row">
          <span>Subtotal</span>
          <span className="receipt-amt">{doc.subtotalLabel}</span>
        </div>
        {doc.saleDiscountCents ? (
          <div className="receipt-row">
            <span>Discount</span>
            <span className="receipt-amt">{doc.saleDiscountLabel}</span>
          </div>
        ) : null}
        <div className="receipt-row">
          <span>{doc.taxLineLabel}</span>
          <span className="receipt-amt">{doc.taxAmountLabel}</span>
        </div>
        <div className="receipt-row receipt-total">
          <span>Total</span>
          <span className="receipt-amt">{doc.totalLabel}</span>
        </div>
      </section>

      <section className="receipt-pay">
        {doc.paymentMethod ? <p>Payment: {doc.paymentMethod}</p> : null}
        {doc.channel ? <p>Channel: {doc.channel}</p> : null}
      </section>

      <footer className="receipt-policy">{doc.returnPolicy}</footer>
    </article>
  );
}
