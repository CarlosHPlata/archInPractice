// cart service: shopping carts, price quotes and stock.
//
//	GET    /carts/{id}?customerId=c-1001                  the cart
//	PUT    /carts/{id}/items/{sku}        {"qty": 2}      set the quantity of an item (0 removes it)
//	GET    /carts/{id}/quote?customerId=c-1001&country=PE price of the cart: subtotal, loyalty discount, shipping
//	POST   /stock/reservations            {"orderId": "ord-1", "items": [{"sku": "tv-55", "qty": 1}]}
//	DELETE /stock/reservations/{orderId}                  give the stock of an order back
//	GET    /stock/{sku}                                   stock level of one product
//
// The quote needs the loyalty tier of the customer, which belongs to the
// customers service. Logging rule of the store: say when a request comes in,
// say what you are about to ask a store or another service, say what you answer.
package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
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

type Product struct {
	Name  string
	Price float64
	Bulky bool // bulky goods are kept in a second warehouse
}

type Reservation struct {
	ID      string `json:"id"`
	OrderID string `json:"orderId"`
	SKU     string `json:"sku"`
	Qty     int    `json:"qty"`
}

var customersURL = envOr("CUSTOMERS_URL", "http://customers:8000")

// ---------- the "databases" ----------

var catalog = map[string]Product{
	"tv-55":  {Name: "Smart TV 55\"", Price: 1299.00, Bulky: true},
	"bk-102": {Name: "Cookbook", Price: 24.50},
	"mg-7":   {Name: "Coffee mug", Price: 7.00},
	"hp-20":  {Name: "Headphones", Price: 89.90},
	"nb-1":   {Name: "Notebook", Price: 5.00},
	"kb-88":  {Name: "Mechanical keyboard", Price: 119.00},
	"cb-3":   {Name: "USB-C cable", Price: 9.50},
}

// restockLevel is what the restock job fills each product back up to.
var restockLevel = map[string]int{
	"tv-55": 40, "bk-102": 300, "mg-7": 300, "hp-20": 300, "nb-1": 300, "kb-88": 300, "cb-3": 300,
}

// shippingRates is the price of a parcel per destination country.
var shippingRates = map[string]float64{"PE": 5.00, "CO": 7.50, "CL": 8.00, "MX": 9.00, "AR": 9.50}

const internationalRate = 25.00

var (
	mu           sync.Mutex // guards everything below
	carts        = map[string]Cart{}
	cartCache    = map[string]Cart{}
	stock        = map[string]int{}
	reservations []Reservation
	reservationN int
)

func seed() {
	item := func(sku string, qty int) Item {
		p := catalog[sku]
		return Item{SKU: sku, Name: p.Name, Qty: qty, Price: p.Price}
	}
	for _, c := range []Cart{
		{ID: "cart-7", CustomerID: "c-1001", Items: []Item{item("tv-55", 1)}},
		{ID: "cart-9", CustomerID: "c-1002", Items: []Item{item("hp-20", 1)}},
		{ID: "cart-3", CustomerID: "c-1003", Items: []Item{item("nb-1", 3)}},
		{ID: "cart-12", CustomerID: "c-1004", Items: []Item{item("kb-88", 1)}},
		{ID: "cart-5", CustomerID: "c-1005", Items: []Item{item("bk-102", 1), item("mg-7", 2)}},
	} {
		c.Total = subtotal(c.Items)
		carts[c.ID] = c
	}
	for sku, level := range restockLevel {
		stock[sku] = level
		registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "stock_units_available", Help: "Units available in the stock.", ConstLabels: prometheus.Labels{"sku": sku},
		}, func() float64 {
			mu.Lock()
			defer mu.Unlock()
			return float64(stock[sku])
		}))
	}
}

// ---------- helpers ----------

func money(v float64) string   { return fmt.Sprintf("%.2f", v) }
func round2(v float64) float64 { return math.Round(v*100) / 100 }
func number(v float64) string {
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.4f", v), "0"), ".")
}
func subtotal(items []Item) float64 {
	sum := 0.0
	for _, it := range items {
		sum += it.Price * float64(it.Qty)
	}
	return round2(sum)
}

func describe(items []Item) string {
	if len(items) == 0 {
		return "(empty)"
	}
	parts := make([]string, len(items))
	for i, it := range items {
		parts[i] = fmt.Sprintf("%s x%d", it.SKU, it.Qty)
	}
	return strings.Join(parts, ", ")
}

// loadCart reads a cart through the cache. Reading the store is slow.
func loadCart(r *http.Request, cartID string) (Cart, bool) {
	ctx := r.Context()
	slog.InfoContext(ctx, "looking for cart "+cartID+" in the cart cache (key="+cartID+")", "cart_id", cartID)
	mu.Lock()
	cart, hit := cartCache[cartID]
	mu.Unlock()
	if hit {
		slog.InfoContext(ctx, fmt.Sprintf("cart cache hit for key=%s: cart of customer %s with items: %s", cartID, cart.CustomerID, describe(cart.Items)), "cart_id", cartID)
		return cart, true
	}

	slog.InfoContext(ctx, "cart cache miss for key="+cartID+": reading cart "+cartID+" from the cart store", "cart_id", cartID)
	time.Sleep(40 * time.Millisecond)
	mu.Lock()
	cart, found := carts[cartID]
	if found {
		cartCache[cartID] = cart
	}
	mu.Unlock()
	if !found {
		slog.WarnContext(ctx, "the cart store has no cart with id "+cartID, "cart_id", cartID)
		return Cart{}, false
	}
	slog.InfoContext(ctx, fmt.Sprintf("cart store returned cart %s: owner is customer %s, items: %s; saved in the cache", cartID, cart.CustomerID, describe(cart.Items)), "cart_id", cartID)
	return cart, true
}

// ---------- GET /carts/{id} ----------

func getCart(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cartID := r.PathValue("id")
	customerID := r.URL.Query().Get("customerId")
	ids := []any{"cart_id", cartID, "customer_id", customerID}
	slog.InfoContext(ctx, "get cart received: customer "+customerID+" wants to see cart "+cartID, ids...)

	cart, found := loadCart(r, cartID)
	if !found {
		slog.WarnContext(ctx, "answering 404 cart_not_found for cart "+cartID, ids...)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "cart_not_found"})
		return
	}
	slog.InfoContext(ctx, fmt.Sprintf("answering 200 with cart %s: owner %s, %d item line(s), subtotal %s", cart.ID, cart.CustomerID, len(cart.Items), money(cart.Total)), ids...)
	writeJSON(w, http.StatusOK, cart)
}

// ---------- PUT /carts/{id}/items/{sku} ----------

func putItem(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cartID, sku := r.PathValue("id"), r.PathValue("sku")
	var body struct {
		Qty int `json:"qty"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	ids := []any{"cart_id", cartID, "sku", sku}
	slog.InfoContext(ctx, fmt.Sprintf("update cart item received: set sku %s to quantity %d in cart %s", sku, body.Qty, cartID), ids...)

	slog.InfoContext(ctx, "looking up sku "+sku+" in the product catalog", ids...)
	product, known := catalog[sku]
	if !known || body.Qty < 0 || body.Qty > 10 {
		slog.WarnContext(ctx, fmt.Sprintf("answering 400 invalid_item: sku %s in catalog=%t, quantity %d (allowed 0 to 10)", sku, known, body.Qty), ids...)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_item"})
		return
	}

	slog.InfoContext(ctx, "writing the new quantity to the cart store for cart "+cartID+" and removing key="+cartID+" from the cart cache", ids...)
	mu.Lock()
	cart, found := carts[cartID]
	if found {
		items := []Item{}
		for _, it := range cart.Items {
			if it.SKU != sku {
				items = append(items, it)
			}
		}
		if body.Qty > 0 {
			items = append(items, Item{SKU: sku, Name: product.Name, Qty: body.Qty, Price: product.Price})
		}
		cart.Items, cart.Total = items, subtotal(items)
		carts[cartID] = cart
		delete(cartCache, cartID)
	}
	mu.Unlock()
	if !found {
		slog.WarnContext(ctx, "answering 404 cart_not_found: the cart store has no cart with id "+cartID, ids...)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "cart_not_found"})
		return
	}
	slog.InfoContext(ctx, fmt.Sprintf("answering 200: cart %s now has items: %s, subtotal %s", cartID, describe(cart.Items), money(cart.Total)), ids...)
	writeJSON(w, http.StatusOK, cart)
}

// ---------- GET /carts/{id}/quote ----------

type Quote struct {
	CartID         string  `json:"cartId"`
	CustomerID     string  `json:"customerId"`
	Subtotal       float64 `json:"subtotal"`
	LoyaltyTier    string  `json:"loyaltyTier"`
	Discount       float64 `json:"discount"`
	DiscountAmount float64 `json:"discountAmount"`
	Country        string  `json:"country"`
	Shipping       float64 `json:"shipping"`
	Total          float64 `json:"total"`
}

func getQuote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cartID := r.PathValue("id")
	customerID := r.URL.Query().Get("customerId")
	country := r.URL.Query().Get("country")
	ids := []any{"cart_id", cartID, "customer_id", customerID}
	slog.InfoContext(ctx, fmt.Sprintf("quote received: price cart %s for customer %s, shipping to country %s", cartID, customerID, country), ids...)

	// 1. the cart
	slog.InfoContext(ctx, "quote step 1/4: loading cart "+cartID, ids...)
	cart, found := loadCart(r, cartID)
	if !found {
		slog.WarnContext(ctx, "answering 404 cart_not_found for cart "+cartID, ids...)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "cart_not_found"})
		return
	}
	sub := subtotal(cart.Items)
	slog.InfoContext(ctx, fmt.Sprintf("quote step 1/4 done: cart %s belongs to customer %s, items: %s, subtotal %s", cartID, cart.CustomerID, describe(cart.Items), money(sub)), ids...)

	// 2. the loyalty discount of the customer the quote is for
	path := "/customers/" + customerID + "/loyalty"
	slog.InfoContext(ctx, fmt.Sprintf("quote step 2/4: asking customers service for the loyalty tier of customer %s (GET %s)", customerID, path), ids...)
	var loyalty struct {
		Tier     string  `json:"tier"`
		Discount float64 `json:"discount"`
	}
	loyalty.Tier = "standard"
	status, err := getJSON(ctx, "customers", customersURL+path, &loyalty)
	switch {
	case err != nil:
		slog.WarnContext(ctx, "quote step 2/4: customers service could not be reached ("+err.Error()+"); pricing without loyalty discount", ids...)
	case status != http.StatusOK:
		slog.WarnContext(ctx, fmt.Sprintf("quote step 2/4: customers service answered %d for customer %s; pricing without loyalty discount", status, customerID), ids...)
	default:
		slog.InfoContext(ctx, fmt.Sprintf("quote step 2/4 done: customers service answered 200: customer %s has loyalty tier %s with discount value %s", customerID, loyalty.Tier, number(loyalty.Discount)), ids...)
	}

	// 3. shipping
	slog.InfoContext(ctx, "quote step 3/4: looking up the shipping rate for country "+country+" in the shipping table", ids...)
	shipping, known := shippingRates[country]
	if !known {
		shipping = internationalRate
		slog.WarnContext(ctx, fmt.Sprintf("quote step 3/4: country %q is not in the shipping table, using the international rate %s", country, money(shipping)), ids...)
	} else {
		slog.InfoContext(ctx, fmt.Sprintf("quote step 3/4 done: shipping rate for %s is %s", country, money(shipping)), ids...)
	}

	// 4. the total
	discountAmount := round2(sub * loyalty.Discount)
	total := round2(sub*(1-loyalty.Discount) + shipping)
	slog.InfoContext(ctx, fmt.Sprintf("quote step 4/4: total = subtotal %s x (1 - discount %s) + shipping %s = %s (discount amount %s)",
		money(sub), number(loyalty.Discount), money(shipping), money(total), money(discountAmount)), ids...)

	quote := Quote{CartID: cartID, CustomerID: customerID, Subtotal: sub, LoyaltyTier: loyalty.Tier, Discount: loyalty.Discount,
		DiscountAmount: discountAmount, Country: country, Shipping: shipping, Total: total}
	slog.InfoContext(ctx, fmt.Sprintf("answering 200 with quote for cart %s: priced for customer %s (tier %s), total %s", cartID, customerID, loyalty.Tier, money(total)), ids...)
	writeJSON(w, http.StatusOK, quote)
}

// ---------- POST /stock/reservations ----------

// readStockLevel asks the warehouse how many units are left. Bulky goods live
// in a second warehouse whose system is slower.
func readStockLevel(r *http.Request, sku, orderID string) {
	ctx := r.Context()
	if catalog[sku].Bulky {
		slog.InfoContext(ctx, "sku "+sku+" is a bulky item: asking the bulky-goods warehouse for its stock level", "order_id", orderID, "sku", sku)
		time.Sleep(350 * time.Millisecond)
		return
	}
	slog.InfoContext(ctx, "asking the main warehouse for the stock level of sku "+sku, "order_id", orderID, "sku", sku)
	time.Sleep(15 * time.Millisecond)
}

func reserveStock(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	start := time.Now()
	var body struct {
		OrderID string `json:"orderId"`
		Items   []Item `json:"items"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	ids := []any{"order_id", body.OrderID}
	slog.InfoContext(ctx, fmt.Sprintf("stock reservation received for order %s, items: %s", body.OrderID, describe(body.Items)), ids...)
	if body.OrderID == "" || len(body.Items) == 0 {
		slog.WarnContext(ctx, "answering 400 bad_request: orderId and items are required", ids...)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request"})
		return
	}

	created := []Reservation{}
	for _, it := range body.Items {
		readStockLevel(r, it.SKU, body.OrderID)

		mu.Lock()
		available := stock[it.SKU]
		if _, known := catalog[it.SKU]; !known || it.Qty <= 0 || available < it.Qty {
			// give back what this request already took
			for _, res := range created {
				stock[res.SKU] += res.Qty
				stockReleased.WithLabelValues(res.SKU).Add(float64(res.Qty))
			}
			reservations = reservations[:len(reservations)-len(created)]
			mu.Unlock()
			slog.WarnContext(ctx, fmt.Sprintf("answering 409 out_of_stock: sku %s has %d unit(s) in stock, order %s needs %d; %d reservation(s) made by this request were undone",
				it.SKU, available, body.OrderID, it.Qty, len(created)), append(ids, "sku", it.SKU)...)
			writeJSON(w, http.StatusConflict, map[string]string{"error": "out_of_stock", "sku": it.SKU})
			return
		}
		stock[it.SKU] = available - it.Qty
		reservationN++
		res := Reservation{ID: fmt.Sprintf("res-%05d", reservationN), OrderID: body.OrderID, SKU: it.SKU, Qty: it.Qty}
		reservations = append(reservations, res)
		created = append(created, res)
		mu.Unlock()
		stockReserved.WithLabelValues(it.SKU).Add(float64(it.Qty))

		slog.InfoContext(ctx, fmt.Sprintf("writing reservation %s to the stock store: sku %s had %d unit(s), reserved %d for order %s, %d remaining",
			res.ID, it.SKU, available, it.Qty, body.OrderID, available-it.Qty), append(ids, "sku", it.SKU, "reservation_id", res.ID)...)
	}

	names := make([]string, len(created))
	for i, res := range created {
		names[i] = res.ID
	}
	slog.InfoContext(ctx, fmt.Sprintf("answering 201: order %s got reservation(s) %s after %d ms", body.OrderID, strings.Join(names, ", "), time.Since(start).Milliseconds()), ids...)
	writeJSON(w, http.StatusCreated, map[string]any{"orderId": body.OrderID, "reservations": created})
}

// ---------- DELETE /stock/reservations/{orderId} ----------

func releaseStock(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	orderID := r.PathValue("orderId")
	ids := []any{"order_id", orderID}
	slog.InfoContext(ctx, "stock release received: give back every reservation of order "+orderID, ids...)

	slog.InfoContext(ctx, "reading the reservations of order "+orderID+" from the stock store", ids...)
	mu.Lock()
	kept, released := []Reservation{}, []Reservation{}
	for _, res := range reservations {
		if res.OrderID == orderID {
			stock[res.SKU] += res.Qty
			released = append(released, res)
		} else {
			kept = append(kept, res)
		}
	}
	reservations = kept
	levels := map[string]int{}
	for _, res := range released {
		levels[res.SKU] = stock[res.SKU]
	}
	mu.Unlock()

	if len(released) == 0 {
		slog.WarnContext(ctx, "answering 404 reservation_not_found: the stock store has no reservation for order "+orderID, ids...)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "reservation_not_found"})
		return
	}
	for _, res := range released {
		stockReleased.WithLabelValues(res.SKU).Add(float64(res.Qty))
		slog.InfoContext(ctx, fmt.Sprintf("released reservation %s of order %s: %d unit(s) of sku %s back in stock, %d now available",
			res.ID, orderID, res.Qty, res.SKU, levels[res.SKU]), append(ids, "sku", res.SKU, "reservation_id", res.ID)...)
	}
	slog.InfoContext(ctx, fmt.Sprintf("answering 200: %d reservation(s) of order %s released", len(released), orderID), ids...)
	writeJSON(w, http.StatusOK, map[string]any{"orderId": orderID, "released": released})
}

// ---------- GET /stock/{sku} ----------

func getStock(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	sku := r.PathValue("sku")
	slog.InfoContext(ctx, "stock level received: how many units of sku "+sku+" are left", "sku", sku)
	slog.InfoContext(ctx, "reading the stock level of sku "+sku+" from the stock store", "sku", sku)
	mu.Lock()
	available, known := stock[sku]
	reserved := 0
	for _, res := range reservations {
		if res.SKU == sku {
			reserved += res.Qty
		}
	}
	mu.Unlock()
	if !known {
		slog.WarnContext(ctx, "answering 404 unknown_sku for sku "+sku, "sku", sku)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown_sku"})
		return
	}
	slog.InfoContext(ctx, fmt.Sprintf("answering 200: sku %s has %d unit(s) available and %d reserved", sku, available, reserved), "sku", sku)
	writeJSON(w, http.StatusOK, map[string]any{"sku": sku, "available": available, "reserved": reserved})
}

// ---------- restock job ----------

// restock fills the shelves again every couple of minutes and archives the
// reservations that were already shipped. It runs outside any request.
func restock(every time.Duration) {
	for range time.Tick(every) {
		mu.Lock()
		skus := make([]string, 0, len(restockLevel))
		for sku := range restockLevel {
			skus = append(skus, sku)
		}
		sort.Strings(skus)
		for _, sku := range skus {
			if before := stock[sku]; before != restockLevel[sku] {
				stock[sku] = restockLevel[sku]
				slog.Info(fmt.Sprintf("restock job: sku %s refilled from %d to %d unit(s)", sku, before, restockLevel[sku]), "sku", sku)
			}
		}
		if extra := len(reservations) - 2000; extra > 0 {
			reservations = append([]Reservation{}, reservations[extra:]...)
			slog.Info(fmt.Sprintf("restock job: archived %d shipped reservation(s)", extra))
		}
		mu.Unlock()
	}
}

// ---------- plumbing ----------

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func main() {
	// "cart healthcheck" is used by the container healthcheck (the image has no shell).
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}

	shutdown := setupTelemetry() // logs, metrics and tracing: see telemetry.go
	defer shutdown()
	seed()
	go restock(2 * time.Minute)

	mux := http.NewServeMux()
	mux.Handle("GET /carts/{id}", instrument("/carts/{id}", getCart))
	mux.Handle("PUT /carts/{id}/items/{sku}", instrument("/carts/{id}/items/{sku}", putItem))
	mux.Handle("GET /carts/{id}/quote", instrument("/carts/{id}/quote", getQuote))
	mux.Handle("POST /stock/reservations", instrument("/stock/reservations", reserveStock))
	mux.Handle("DELETE /stock/reservations/{orderId}", instrument("/stock/reservations/{orderId}", releaseStock))
	mux.Handle("GET /stock/{sku}", instrument("/stock/{sku}", getStock))
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
