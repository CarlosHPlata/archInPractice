// orders service: creates an order from a customer's cart.
//
//   POST /orders   {"customerId": "c-1001", "cartId": "cart-7"}
//
// It asks the cart service for the cart, the customers service for the
// customer, checks that the cart really belongs to that customer and then
// confirms the order.
import { createHash, randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { callService, log, metricsText, ordersMismatch, telemetry } from "./telemetry.js";

const CART_URL = process.env.CART_URL ?? "http://cart:8080";
const CUSTOMERS_URL = process.env.CUSTOMERS_URL ?? "http://customers:8000";
const PORT = Number(process.env.PORT ?? 3000);

type Item = { sku: string; name: string; qty: number; price: number };
type Cart = { id: string; customerId: string; items: Item[]; total: number };
type Customer = { id: string; name: string; email: string; address: Record<string, string> };

const app = new Hono();
app.use(telemetry); // logs, metrics and tracing: see telemetry.ts

app.get("/healthz", (c) => c.text("ok"));
app.get("/metrics", async (c) => c.text(await metricsText()));

app.post("/orders", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { customerId, cartId } = body as { customerId?: string; cartId?: string };
  if (!customerId || !cartId) {
    return c.json({ error: "bad_request", detail: "customerId and cartId are required" }, 400);
  }

  const orderId = `ord-${randomUUID().slice(0, 8)}`;
  const ids = { order_id: orderId, cart_id: cartId, customer_id: customerId };
  log("info", "order received", ids);

  // 1. the cart
  const cartRes = await callService("cart", `${CART_URL}/carts/${cartId}?customerId=${customerId}`);
  if (!cartRes.ok) {
    log("warn", `cart service answered ${cartRes.status}`, ids);
    return c.json({ error: "cart_not_found" }, 404);
  }
  const cart = (await cartRes.json()) as Cart;

  // 2. the customer
  const customerRes = await callService("customers", `${CUSTOMERS_URL}/customers/${customerId}`);
  if (!customerRes.ok) {
    log("warn", `customers service answered ${customerRes.status}`, ids);
    return c.json({ error: "customer_not_found" }, 404);
  }
  const customer = (await customerRes.json()) as Customer;

  // 3. never ship a cart to somebody who does not own it
  if (cart.customerId !== customerId) {
    log("error", "order mismatch: cart owner differs from the customer placing the order", {
      ...ids,
      cart_owner: cart.customerId,
    });
    ordersMismatch.inc();
    return c.json({ error: "order_mismatch" }, 500);
  }

  // 4. confirm
  log("info", "order confirmed", { ...ids, total: cart.total });
  return c.json(
    {
      orderId,
      customerId,
      cartId,
      items: cart.items,
      total: cart.total,
      shipTo: { name: customer.name, ...customer.address },
      flag: flagFor(customerId, cartId),
    },
    201,
  );
});

// The flag proves that this exact order went through.
function flagFor(customerId: string, cartId: string): string {
  const digest = createHash("sha256").update(`otzzo:${customerId}:${cartId}`).digest("hex");
  return `FLAG{otzzo-${digest.slice(0, 12)}}`;
}

serve({ fetch: app.fetch, port: PORT }, () => log("info", `orders service listening on :${PORT}`));
