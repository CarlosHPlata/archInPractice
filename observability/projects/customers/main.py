"""customers service: returns the profile and address of a customer.

    GET /customers/{id}
"""
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response

from telemetry import log, metrics_response, telemetry_middleware

CUSTOMERS = {
    "c-1001": {
        "id": "c-1001", "name": "Ana Torres", "email": "ana.torres@example.com",
        "address": {"street": "Av. Larco 1200", "city": "Lima", "country": "PE"},
    },
    "c-1002": {
        "id": "c-1002", "name": "Bruno Diaz", "email": "bruno.diaz@example.com",
        "address": {"street": "Calle 85 #11-53", "city": "Bogota", "country": "CO"},
    },
    "c-1003": {
        "id": "c-1003", "name": "Carla Mendez", "email": "carla.mendez@example.com",
        "address": {"street": "Av. Providencia 2133", "city": "Santiago", "country": "CL"},
    },
}

# FastAPI's built-in telemetry is off: it would start a trace on every request.
# Tracing is done by hand in telemetry.py, so the rule there is easy to read.
app = FastAPI(title="customers", docs_url=None, redoc_url=None,
              telemetry={"tracing": False, "metrics": False, "logs": False})
app.middleware("http")(telemetry_middleware)  # logs, metrics and tracing: see telemetry.py


@app.get("/customers/{customer_id}")
async def get_customer(customer_id: str):
    # The loyalty programme is not live yet, so every lookup falls back to the default tier.
    log("warn", "loyalty tier lookup skipped, using default tier", customer_id=customer_id)

    customer = CUSTOMERS.get(customer_id)
    if customer is None:
        log("warn", "customer not found", customer_id=customer_id)
        return JSONResponse({"error": "customer_not_found"}, status_code=404)

    log("info", "customer profile served", customer_id=customer_id)
    return {**customer, "loyaltyTier": "standard"}


@app.get("/metrics")
async def metrics() -> Response:
    return metrics_response()


@app.get("/healthz")
async def healthz() -> Response:
    return Response("ok")
