// cart service: returns the shopping cart of a customer.
//
//	GET /carts/{id}?customerId=c-1001
//
// Cart ids are numbered per customer, so the same cart id can exist for
// several customers. Reading a cart from the store is slow, so there is a
// small in-memory cache in front of it.
package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"
)

type Item struct {
	SKU   string  `json:"sku"`
	Name  string  `json:"name"`
	Qty   int     `json:"qty"`
	Price float64 `json:"price"`
}

type Cart struct {
	ID         string  `json:"id"`
	CustomerID string  `json:"customerId"`
	Items      []Item  `json:"items"`
	Total      float64 `json:"total"`
}

// store is the "database": carts indexed by customer and cart id.
var store = map[string]Cart{
	"c-1001/cart-7": {ID: "cart-7", CustomerID: "c-1001", Total: 1299.00,
		Items: []Item{{SKU: "tv-55", Name: "Smart TV 55\"", Qty: 1, Price: 1299.00}}},
	"c-1002/cart-7": {ID: "cart-7", CustomerID: "c-1002", Total: 38.50,
		Items: []Item{{SKU: "bk-102", Name: "Cookbook", Qty: 1, Price: 24.50}, {SKU: "mg-7", Name: "Coffee mug", Qty: 2, Price: 7.00}}},
	"c-1002/cart-9": {ID: "cart-9", CustomerID: "c-1002", Total: 89.90,
		Items: []Item{{SKU: "hp-20", Name: "Headphones", Qty: 1, Price: 89.90}}},
	"c-1003/cart-3": {ID: "cart-3", CustomerID: "c-1003", Total: 15.00,
		Items: []Item{{SKU: "nb-1", Name: "Notebook", Qty: 3, Price: 5.00}}},
}

var (
	cache   = map[string]Cart{}
	cacheMu sync.RWMutex
)

// cacheKey builds the key used to store and find a cart in the cache.
func cacheKey(customerID, cartID string) string {
	return cartID
}

// loadFromStore simulates a slow database read.
func loadFromStore(customerID, cartID string) (Cart, bool) {
	time.Sleep(40 * time.Millisecond)
	cart, ok := store[customerID+"/"+cartID]
	return cart, ok
}

// warmCache pre-loads the most requested cart, so the peak weekend starts fast.
func warmCache() {
	cart := store["c-1001/cart-7"]
	key := cacheKey(cart.CustomerID, cart.ID)
	cache[key] = cart
	slog.Info("cart cache warmed key="+key, "cart_id", cart.ID)
}

func getCart(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cartID := r.PathValue("id")
	customerID := r.URL.Query().Get("customerId")
	ids := []any{"cart_id", cartID, "customer_id", customerID}
	key := cacheKey(customerID, cartID)
	slog.InfoContext(ctx, "getCart recieved request for customer: "+customerID+"to access cart: "+cartID, ids...)

	cacheMu.RLock()
	cart, hit := cache[key]
	cacheMu.RUnlock()

	if hit {
		slog.InfoContext(ctx, "Looked for cart in cache for key="+key, append(ids, "cart", cart)...)
	} else {
		var found bool
		cart, found = loadFromStore(customerID, cartID)
		if !found {
			slog.WarnContext(ctx, "cart not found", ids...)
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "cart_not_found"})
			return
		}
		cacheMu.Lock()
		cache[key] = cart
		cacheMu.Unlock()
		slog.InfoContext(ctx, "cart cache miss key="+key+", loaded from store", ids...)
	}
	writeJSON(w, http.StatusOK, cart)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func main() {
	// "cart healthcheck" is used by the container healthcheck (the image has no shell).
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}

	shutdown := setupTelemetry() // logs, metrics and tracing: see telemetry.go
	defer shutdown()
	warmCache()

	mux := http.NewServeMux()
	mux.Handle("GET /carts/{id}", instrument("/carts/{id}", getCart))
	mux.Handle("GET /metrics", metricsHandler())
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })

	slog.Info("cart service listening on :8080")
	if err := http.ListenAndServe(":8080", mux); err != nil {
		slog.Error("server stopped: " + err.Error())
		os.Exit(1)
	}
}

func healthcheck() int {
	res, err := http.Get("http://127.0.0.1:8080/healthz")
	if err != nil || res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
