"""customers service: profiles, shipping addresses, loyalty and order history.

    GET  /customers/{id}                    profile
    GET  /customers/{id}/shipping-address   shipping address, validated
    GET  /customers/{id}/loyalty            loyalty tier, discount and points
    POST /customers/{id}/loyalty/points     {"orderId": "ord-1", "points": 89}  (negative takes points back)
    GET  /customers/{id}/orders             order history (asks the orders service)

Logging rule of the store: say when a request comes in, say what you are about
to ask a store or another service, say what you answer.
"""
import asyncio
import os
import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from telemetry import call_service, history_orders, history_requests, log, metrics_response, telemetry_middleware

ORDERS_URL = os.environ.get("ORDERS_URL", "http://orders:3000")

CUSTOMERS = {
    "c-1001": {
        "id": "c-1001", "name": "Ana Torres", "email": "ana.torres@example.com",
        "address": {"street": "Av. Larco 1200", "city": "Lima", "postalCode": "15074", "country": "PE"},
    },
    "c-1002": {
        "id": "c-1002", "name": "Bruno Diaz", "email": "bruno.diaz@example.com",
        "address": {"street": "Calle 85 #11-53", "city": "Bogota", "postalCode": "110221", "country": "CO"},
    },
    "c-1003": {
        "id": "c-1003", "name": "Carla Mendez", "email": "carla.mendez@example.com",
        "address": {"street": "Av. Providencia 2133", "city": "Santiago", "postalCode": "7510086", "country": "CL"},
    },
    "c-1004": {
        "id": "c-1004", "name": "Diego Rojas", "email": "diego.rojas@example.com",
        "address": {"street": "Av. Reforma 222", "city": "Ciudad de Mexico", "postalCode": "06600", "country": "MX"},
    },
    "c-1005": {
        "id": "c-1005", "name": "Elena Ruiz", "email": "elena.ruiz@example.com",
        "address": {"street": "Jr. de la Union 450", "city": "Lima", "postalCode": "15001", "country": "PE"},
    },
}

# Loyalty accounts: tier and points of each customer.
LOYALTY = {
    "c-1001": {"tier": "gold", "points": 8420},
    "c-1002": {"tier": "standard", "points": 310},
    "c-1003": {"tier": "silver", "points": 2150},
    "c-1004": {"tier": "vip", "points": 26900},
    "c-1005": {"tier": "standard", "points": 95},
}

# Discount of each loyalty tier.
TIER_DISCOUNT = {
    "standard": 0.0,
    "silver": 0.05,
    "gold": 0.10,
    "vip": 20,  # new for the peak weekend: 20 % off for VIP customers
}

# Postal-code format of each country we ship to.
POSTAL_CODE_RULES = {
    "PE": r"\d{5}",
    "CO": r"\d{6}",
    "MX": r"\d{5}",
    "AR": r"[A-Z]\d{4}[A-Z]{3}",
}

VALIDATION_ATTEMPTS = 3
VALIDATION_RETRY_WAIT_MS = 500

# FastAPI's built-in telemetry is off: it would start a trace on every request.
# Tracing is done by hand in telemetry.py, so the rule there is easy to read.
app = FastAPI(title="customers", docs_url=None, redoc_url=None,
              telemetry={"tracing": False, "metrics": False, "logs": False})
app.middleware("http")(telemetry_middleware)  # logs, metrics and tracing: see telemetry.py


def not_found(customer_id: str) -> JSONResponse:
    log("warn", f"answering 404 customer_not_found: the customer store has no customer {customer_id}",
        customer_id=customer_id)
    return JSONResponse({"error": "customer_not_found"}, status_code=404)


# ---------- GET /customers/{id} ----------

@app.get("/customers/{customer_id}")
async def get_customer(customer_id: str):
    log("info", f"get customer received: profile of customer {customer_id}", customer_id=customer_id)

    log("info", f"reading customer {customer_id} from the customer store", customer_id=customer_id)
    customer = CUSTOMERS.get(customer_id)
    if customer is None:
        return not_found(customer_id)

    log("info", f"reading the loyalty account of customer {customer_id} from the loyalty store",
        customer_id=customer_id)
    tier = LOYALTY[customer_id]["tier"]

    log("info", f"answering 200 with the profile of customer {customer_id}: {customer['name']}, "
        f"country {customer['address']['country']}, loyalty tier {tier}", customer_id=customer_id)
    return {**customer, "loyaltyTier": tier}


# ---------- GET /customers/{id}/shipping-address ----------

async def validate_address(customer_id: str, address: dict) -> bool:
    """Checks the postal code against the format of the country."""
    country, postal_code = address["country"], address["postalCode"]
    for attempt in range(1, VALIDATION_ATTEMPTS + 1):
        log("info", f"address validation attempt {attempt}/{VALIDATION_ATTEMPTS}: reading the postal-code rule "
            f"for country {country} from the address-rules store", customer_id=customer_id)
        await asyncio.sleep(0.1)  # the rules store is a slow lookup
        rule = POSTAL_CODE_RULES.get(country)
        if rule is not None:
            valid = re.fullmatch(rule, postal_code) is not None
            log("info", f"address validation attempt {attempt}/{VALIDATION_ATTEMPTS}: rule for {country} is "
                f"'{rule}', postal code '{postal_code}' matches={str(valid).lower()}", customer_id=customer_id)
            return valid

        registered = ", ".join(sorted(POSTAL_CODE_RULES))
        log("warn", f"address validation attempt {attempt}/{VALIDATION_ATTEMPTS} failed: the address-rules store "
            f"has no postal-code rule for country {country} (countries with a rule: {registered})",
            customer_id=customer_id)
        if attempt < VALIDATION_ATTEMPTS:
            log("info", f"waiting {VALIDATION_RETRY_WAIT_MS} ms before address validation attempt "
                f"{attempt + 1}/{VALIDATION_ATTEMPTS}", customer_id=customer_id)
            await asyncio.sleep(VALIDATION_RETRY_WAIT_MS / 1000)

    log("warn", f"address validation gave up after {VALIDATION_ATTEMPTS} attempts for country {country}; "
        "the address will be returned as not verified", customer_id=customer_id)
    return False


@app.get("/customers/{customer_id}/shipping-address")
async def get_shipping_address(customer_id: str):
    log("info", f"shipping address received: validated shipping address of customer {customer_id}",
        customer_id=customer_id)

    log("info", f"reading customer {customer_id} from the customer store", customer_id=customer_id)
    customer = CUSTOMERS.get(customer_id)
    if customer is None:
        return not_found(customer_id)
    address = customer["address"]
    log("info", f"customer store returned the address of customer {customer_id}: {address['street']}, "
        f"{address['city']}, postal code {address['postalCode']}, country {address['country']}",
        customer_id=customer_id)

    verified = await validate_address(customer_id, address)

    log("info", f"answering 200 with the shipping address of customer {customer_id}: country "
        f"{address['country']}, verified={str(verified).lower()}", customer_id=customer_id)
    return {"customerId": customer_id, "name": customer["name"], **address, "verified": verified}


# ---------- GET /customers/{id}/loyalty ----------

@app.get("/customers/{customer_id}/loyalty")
async def get_loyalty(customer_id: str):
    log("info", f"loyalty received: loyalty tier and discount of customer {customer_id}", customer_id=customer_id)

    log("info", f"reading the loyalty account of customer {customer_id} from the loyalty store",
        customer_id=customer_id)
    account = LOYALTY.get(customer_id)
    if account is None:
        return not_found(customer_id)

    tier = account["tier"]
    log("info", f"reading the discount of tier {tier} from the tier table", customer_id=customer_id)
    discount = TIER_DISCOUNT[tier]

    log("info", f"answering 200: customer {customer_id} has loyalty tier {tier}, {account['points']} points, "
        f"discount value {discount}", customer_id=customer_id)
    return {"customerId": customer_id, "tier": tier, "discount": discount, "points": account["points"]}


# ---------- POST /customers/{id}/loyalty/points ----------

@app.post("/customers/{customer_id}/loyalty/points")
async def add_points(customer_id: str, request: Request):
    body = await request.json()
    order_id, points = body.get("orderId"), body.get("points")
    ids = {"customer_id": customer_id, "order_id": order_id}
    log("info", f"loyalty points received: add {points} point(s) to customer {customer_id} for order {order_id}",
        **ids)

    if not isinstance(points, int) or isinstance(points, bool):
        log("warn", f"answering 400 invalid_points: points must be a whole number, got {points!r}", **ids)
        return JSONResponse({"error": "invalid_points"}, status_code=400)

    log("info", f"reading the loyalty account of customer {customer_id} from the loyalty store", **ids)
    account = LOYALTY.get(customer_id)
    if account is None:
        return not_found(customer_id)

    before = account["points"]
    log("info", f"writing the new balance of customer {customer_id} to the loyalty store: "
        f"{before} + ({points}) = {before + points}", **ids)
    account["points"] = before + points

    log("info", f"answering 200: customer {customer_id} now has {account['points']} points (tier {account['tier']})",
        **ids)
    return {"customerId": customer_id, "points": account["points"], "tier": account["tier"]}


# ---------- GET /customers/{id}/orders ----------

@app.get("/customers/{customer_id}/orders")
async def get_order_history(customer_id: str):
    log("info", f"order history received: every order of customer {customer_id}", customer_id=customer_id)

    log("info", f"reading customer {customer_id} from the customer store", customer_id=customer_id)
    customer = CUSTOMERS.get(customer_id)
    if customer is None:
        return not_found(customer_id)

    path = f"/orders?customer_id={customer_id}"
    log("info", f"asking orders service for the orders of customer {customer_id} (GET {path})",
        customer_id=customer_id)
    status, body = await call_service("orders", ORDERS_URL + path)
    if status != 200:
        log("error", f"answering 502 orders_unavailable: orders service answered {status or 'nothing'} "
            f"to GET {path}", customer_id=customer_id)
        return JSONResponse({"error": "orders_unavailable"}, status_code=502)

    orders = body.get("orders", [])
    history_requests.inc()
    history_orders.inc(len(orders))
    log("info", f"orders service answered 200 with {len(orders)} order(s) to GET {path}", customer_id=customer_id)

    log("info", f"answering 200 with the order history of customer {customer_id} ({customer['name']}): "
        f"{len(orders)} order(s)", customer_id=customer_id)
    return {"customerId": customer_id, "name": customer["name"], "orders": orders}


@app.get("/metrics")
async def metrics() -> Response:
    return metrics_response()


@app.get("/healthz")
async def healthz() -> Response:
    return Response("ok")
