import React, { useState, useMemo, useEffect, useRef, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "./auth/AuthContext";
import { fetchAllData, dbInsertProduct, dbUpdateProduct, dbSetProductStock, dbInsertMovement, dbInsertCustomer, dbInsertSale, dbInsertSaleItems, dbInsertFollowup, dbUpsertSettings } from "./lib/db";
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";
import {
  LayoutDashboard, Receipt, Package, Boxes, TrendingUp, Calendar as CalendarIcon,
  BarChart3, Settings as SettingsIcon, Search, Plus, Minus, X, ChevronLeft, ChevronRight,
  ChevronDown, AlertTriangle, CheckCircle2, Download, User, Trash2, Pencil, History,
  PackagePlus, SlidersHorizontal, ShoppingCart, Banknote, Smartphone, CreditCard, Menu,
  ArrowUpRight, ArrowDownRight, IndianRupee, PauseCircle, PlayCircle, Info, XCircle,
  Users, Phone, MessageCircle, Copy, Snowflake, BellRing, UserPlus, Clock, PhoneCall, LogOut,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

/* ============================================================================
   DATA MODEL (documented for a future backend integration)
   ----------------------------------------------------------------------------
   Product        { id, name, brand, category, purchasePrice, sellingPrice,
                     stock, lowStockLimit, reorderDays }
                  reorderDays: days after a purchase before that product is
                  "due for reorder" (e.g. a 25-serving tub -> 25). null/blank
                  means the product is not tracked for reorder-days.
   Sale           { id, invoiceNumber, dateISO, time, items: SaleItem[],
                     subtotal, discount, total, paymentMethod, status, customerId }
   SaleItem       { productId, name, qty, price, total }
   StockMovement  { id, productId, dateISO, time, type, quantity, reference,
                     reason, previousStock, newStock }
   Customer       { id, name, phone, createdAt }
   OpportunityState (keyed by customerId, kept separately so purchase history
                     never needs to be duplicated)
                  { status: 'pending' | 'contacted' | 'followup' | 'closed',
                    contactedAt, outcome, followupDate }
   ========================================================================== */

const TODAY_ISO = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
const STORE_NAME_DEFAULT = "FitFuel Supplements";

/* ---------------------------------- helpers ---------------------------------- */

function formatINR(n) {
  const v = Math.round(n || 0);
  return "₹" + v.toLocaleString("en-IN");
}

function formatCompactINR(n) {
  const v = n || 0;
  if (v >= 100000) return "₹" + (v / 100000).toFixed(1) + "L";
  if (v >= 1000) return "₹" + (v / 1000).toFixed(1) + "K";
  return "₹" + v;
}

function parseISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/*
 * AMOUNT IN WORDS (Indian numbering: Crore / Lakh / Thousand)
 * Only handles whole rupees — formatINR() already rounds every amount
 * shown in the app, so invoice totals never carry paise.
 */
const NUM_WORDS_ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const NUM_WORDS_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigitWords(n) {
  if (n < 20) return NUM_WORDS_ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return NUM_WORDS_TENS[t] + (o ? " " + NUM_WORDS_ONES[o] : "");
}

function threeDigitWords(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let str = "";
  if (h) str += NUM_WORDS_ONES[h] + " Hundred";
  if (rest) str += (str ? " " : "") + twoDigitWords(rest);
  return str;
}

function numberToWordsIndian(amount) {
  let num = Math.floor(Math.abs(Number(amount) || 0));
  if (num === 0) return "Zero";

  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  const hundred = num;

  const parts = [];
  if (crore) parts.push(threeDigitWords(crore) + " Crore");
  if (lakh) parts.push(threeDigitWords(lakh) + " Lakh");
  if (thousand) parts.push(threeDigitWords(thousand) + " Thousand");
  if (hundred) parts.push(threeDigitWords(hundred));
  return parts.join(" ");
}

function formatDateShort(iso) {
  return parseISO(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateLong(iso) {
  return parseISO(iso).toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
}

function todayLabel(iso) {
  if (iso === TODAY_ISO) return "Today";
  const diff = Math.round((parseISO(TODAY_ISO) - parseISO(iso)) / 86400000);
  if (diff === 1) return "Yesterday";
  if (diff > 1 && diff < 7) return `${diff} days ago`;
  return formatDateShort(iso);
}

function statusOf(product) {
  if (product.stock === 0) return "Out of Stock";
  if (product.stock <= product.lowStockLimit) return "Low Stock";
  return "In Stock";
}

function statusClasses(status) {
  if (status === "Out of Stock") return "bg-red-50 text-red-700 border border-red-200";
  if (status === "Low Stock") return "bg-amber-50 text-amber-700 border border-amber-200";
  return "bg-green-50 text-green-700 border border-green-200";
}

function timeStr(hour, minute) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h}:${String(minute).padStart(2, "0")} ${ampm}`;
}

/* --------------------------- customer / reorder helpers ----------------------- */
// These are pure functions: given (customers, sales, opportunityState) they derive
// everything else, the same "compute, don't duplicate" approach used for stock.

function diffDays(fromISO, toISO) {
  return Math.round((parseISO(toISO) - parseISO(fromISO)) / 86400000);
}

function addDaysISO(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function normalizePhoneDigits(input) {
  return (input || "").replace(/\D/g, "").slice(-10);
}

function formatPhoneDisplay(digits10) {
  if (!digits10 || digits10.length < 10) return digits10 ? `+91 ${digits10}` : "";
  return `+91 ${digits10.slice(0, 5)} ${digits10.slice(5)}`;
}

function maskPhone(phone) {
  if (!phone) return "—";
  const parts = phone.split(" ");
  if (parts.length === 3) return `${parts[0]} ${parts[1]} XXXXX`;
  return phone;
}

function customerLabel(customers, customerId) {
  if (!customerId) return "Walk-in Customer";
  const c = customers.find((x) => x.id === customerId);
  return c ? c.name || "Customer" : "Walk-in Customer";
}

function customerSalesOf(sales, customerId) {
  return sales
    .filter((s) => s.customerId === customerId)
    .sort((a, b) => (a.dateISO + a.time).localeCompare(b.dateISO + b.time));
}

function customerStats(sales, customerId) {
  const list = customerSalesOf(sales, customerId);
  const totalPurchases = list.length;
  const totalSpent = list.reduce((s, x) => s + x.total, 0);
  const lastPurchaseDate = list.length ? list[list.length - 1].dateISO : null;
  return { totalPurchases, totalSpent, lastPurchaseDate, sales: list };
}

// Finds the product this customer buys most repeatedly and estimates the typical
// gap between purchases, purely from their own purchase history.
function reorderPattern(sales, customerId) {
  const list = customerSalesOf(sales, customerId);
  const byProduct = {};
  list.forEach((sale) => {
    sale.items.forEach((it) => {
      if (!byProduct[it.productId]) byProduct[it.productId] = { name: it.name, dates: [] };
      byProduct[it.productId].dates.push(sale.dateISO);
    });
  });
  let best = null;
  Object.entries(byProduct).forEach(([productId, info]) => {
    if (info.dates.length < 2) return;
    const dates = [...info.dates].sort();
    const diffs = [];
    for (let i = 1; i < dates.length; i++) diffs.push(diffDays(dates[i - 1], dates[i]));
    const avgInterval = Math.max(1, Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length));
    const lastPurchaseDate = dates[dates.length - 1];
    const candidate = {
      productId,
      productName: info.name,
      occurrences: dates.length,
      avgInterval,
      lastPurchaseDate,
      expectedDate: addDaysISO(lastPurchaseDate, avgInterval),
    };
    if (!best || candidate.occurrences > best.occurrences || (candidate.occurrences === best.occurrences && candidate.lastPurchaseDate > best.lastPurchaseDate)) {
      best = candidate;
    }
  });
  return best;
}

// --- Reorder Days system (product-defined, independent of the learned
// "Going Cold" pattern above) -----------------------------------------------
//
// Unlike reorderPattern() (which needs 2+ purchases of the same product to
// learn an average gap), this only needs ONE purchase: a product simply
// declares how many days its stock is expected to last (product.reorderDays,
// e.g. a 25-serving tub of creatine -> 25), and the customer becomes "Due
// for Reorder" that many days after buying it.
function reorderDaysCandidate(sales, customerId, productsById, todayISO = TODAY_ISO) {
  const list = customerSalesOf(sales, customerId);

  // Track only the most recent purchase date of each product.
  const lastByProduct = {};
  list.forEach((sale) => {
    sale.items.forEach((it) => {
      const existing = lastByProduct[it.productId];
      if (!existing || sale.dateISO > existing.lastPurchaseDate) {
        lastByProduct[it.productId] = { name: it.name, lastPurchaseDate: sale.dateISO };
      }
    });
  });

  let best = null; // the most urgent (soonest/most overdue) qualifying product
  Object.entries(lastByProduct).forEach(([productId, info]) => {
    // productId here is always a string (plain-object keys coerce to strings).
    // productsById is now keyed by String(p.id) too, so this lookup is safe
    // regardless of whether the DB's product id is numeric or a string/UUID.
    const product = productsById.get(String(productId));
    const reorderDays = product ? Number(product.reorderDays) : 0;
    if (!reorderDays || reorderDays <= 0) return; // product not tracked for reorder

    const expectedDate = addDaysISO(info.lastPurchaseDate, reorderDays);
    const daysUntil = diffDays(todayISO, expectedDate); // positive = still in the future
    if (daysUntil > 0) return; // not due yet

    const status =
      daysUntil === 0
        ? { category: "due", label: "Likely due today" }
        : { category: "overdue", label: `Expected ${-daysUntil} day${-daysUntil === 1 ? "" : "s"} ago` };

    const candidate = {
      pattern: {
        productId,
        productName: info.name,
        lastPurchaseDate: info.lastPurchaseDate,
        expectedDate,
      },
      status,
      daysUntil,
    };

    if (!best || candidate.daysUntil < best.daysUntil) best = candidate;
  });

  return best;
}

// Turns a pattern into a soft, non-medical status label. Never asserts certainty.
function reorderStatusFor(pattern, todayISO = TODAY_ISO) {
  if (!pattern) return { category: "none" };
  const daysUntil = diffDays(todayISO, pattern.expectedDate); // positive = still in the future
  const daysSinceLast = diffDays(pattern.lastPurchaseDate, todayISO);
  const coldThreshold = Math.max(21, pattern.avgInterval * 1.8);
  if (daysSinceLast > coldThreshold) {
    return { category: "cold", overdueDays: daysSinceLast - pattern.avgInterval, pattern };
  }
  if (daysUntil > 5) return { category: "none", pattern };
  if (daysUntil > 0) return { category: "upcoming", label: `Expected in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`, pattern };
  if (daysUntil === 0) return { category: "due", label: "Likely due today", pattern };
  return { category: "overdue", label: `Expected ${-daysUntil} day${-daysUntil === 1 ? "" : "s"} ago`, pattern };
}

// --- Full customer lifecycle: Purchased -> Due for Reorder -> Going Cold -> Lost ---
//
// Built on the same "product's own reorder_days, most recent purchase" mechanism as
// reorderDaysCandidate above (that function is unchanged and still drives the Due for
// Reorder dashboard widget/candidate selection as-is). This is a separate function that
// carries the same expected-reorder-date math forward past "overdue" into two further
// grace stages, purely for classifying the customer's overall lifecycle stage:
//   - not yet at the expected reorder date:            "purchased"
//   - 0-15 days past the expected reorder date:         "due"   (Due for Reorder)
//   - 15-30 days past the expected reorder date:         "cold"  (Going Cold)
//   - 30+ days past the expected reorder date:           "lost"  (Lost)
const REORDER_GRACE_DAYS = 15; // grace period after the reorder date before "Going Cold"
const REORDER_LOST_DAYS = REORDER_GRACE_DAYS * 2; // further grace before "Lost"

function customerLifecycleStage(sales, customerId, productsById, todayISO = TODAY_ISO) {
  const list = customerSalesOf(sales, customerId);
  if (!list.length) return null; // no purchases yet

  // Track only the most recent purchase date of each product (same as reorderDaysCandidate).
  const lastByProduct = {};
  list.forEach((sale) => {
    sale.items.forEach((it) => {
      const existing = lastByProduct[it.productId];
      if (!existing || sale.dateISO > existing.lastPurchaseDate) {
        lastByProduct[it.productId] = { name: it.name, lastPurchaseDate: sale.dateISO };
      }
    });
  });

  let best = null; // the most advanced (furthest past its reorder date) tracked product
  Object.entries(lastByProduct).forEach(([productId, info]) => {
    const product = productsById.get(String(productId));
    const reorderDays = product ? Number(product.reorderDays) : 0;
    if (!reorderDays || reorderDays <= 0) return; // product not tracked for reorder

    const expectedDate = addDaysISO(info.lastPurchaseDate, reorderDays);
    const daysPastDue = diffDays(expectedDate, todayISO); // positive = past the reorder date

    const candidate = {
      productId,
      productName: info.name,
      lastPurchaseDate: info.lastPurchaseDate,
      expectedDate,
      daysPastDue,
    };

    if (!best || candidate.daysPastDue > best.daysPastDue) best = candidate;
  });

  if (!best) return null; // customer hasn't bought a reorder-tracked product

  let stage = "purchased";
  if (best.daysPastDue > REORDER_LOST_DAYS) stage = "lost";
  else if (best.daysPastDue > REORDER_GRACE_DAYS) stage = "cold";
  else if (best.daysPastDue >= 0) stage = "due";

  return { stage, pattern: best };
}

function customerSegment(stats, statusInfo, lifecycleStage) {
  if (lifecycleStage === "lost") return "Lost Customer";
  if (stats.totalPurchases <= 1) return "New Customer";
  if (statusInfo && statusInfo.category === "cold") return "At Risk";
  if (stats.totalSpent >= 10000) return "High Value";
  if (stats.totalPurchases >= 4) return "Loyal Customer";
  return "Returning Customer";
}

function segmentClasses(segment) {
  if (segment === "Lost Customer") return "bg-red-50 text-red-700 border border-red-200";
  if (segment === "At Risk") return "bg-red-50 text-red-700 border border-red-200";
  if (segment === "High Value") return "bg-amber-50 text-amber-700 border border-amber-200";
  if (segment === "Loyal Customer") return "bg-green-100 text-green-800 border border-green-200";
  if (segment === "Returning Customer") return "bg-green-50 text-green-700 border border-green-200";
  if (segment === "New Customer") return "bg-gray-100 text-gray-600 border border-gray-200";
  return "bg-gray-100 text-gray-600 border border-gray-200";
}

// Aggregates dashboard-ready opportunity lists, respecting the pending -> contacted
// -> followup -> closed lifecycle so the same customer isn't nagged every day.
//
// "Due for Reorder" and "Going Cold" are two independent signals:
//  - Going Cold is UNCHANGED: it needs 2+ purchases of the same product and
//    uses the learned average-gap pattern (reorderPattern/reorderStatusFor).
//  - Due for Reorder now comes from each product's own reorder_days value
//    and qualifies a customer after just ONE purchase of that product
//    (reorderDaysCandidate).
function computeOpportunities(customers, sales, products, opportunityState) {
  const due = [];
  const cold = [];
  const followups = [];
  const productsById = new Map((products || []).map((p) => [String(p.id), p]));

  customers.forEach((c) => {
    const stats = customerStats(sales, c.id);
    const state = opportunityState[c.id] || { status: "pending" };

    // --- Going Cold: unchanged, still gated on 2+ total purchases and a
    // learned repeat-purchase pattern.
    const coldPattern = stats.totalPurchases >= 2 ? reorderPattern(sales, c.id) : null;
    const coldStatus = coldPattern ? reorderStatusFor(coldPattern) : { category: "none" };

    // --- Due for Reorder: new, product-defined, needs only 1 purchase.
    const dueCandidate = reorderDaysCandidate(sales, c.id, productsById);

    // The raw dueCandidate only distinguishes "due" (today) vs "overdue" (any
    // amount past the expected date) — it never resolves to "cold" or "lost".
    // Run the same product-defined signal through customerLifecycleStage (the
    // function the Customers page already uses for segment badges) so a
    // customer who is well past their expected reorder date gets bucketed as
    // "Going Cold" / "Lost" here too, instead of staying under "Due for
    // Reorder" forever.
    const dueLifecycle = dueCandidate ? customerLifecycleStage(sales, c.id, productsById) : null;

    // Prefer the learned pattern for display (e.g. in the Follow-ups list),
    // falling back to the reorder-days candidate when only one purchase exists.
    const displayPattern = coldPattern || (dueCandidate ? dueCandidate.pattern : null);
    const displayStatus = coldStatus.category === "cold" ? coldStatus : dueCandidate ? dueCandidate.status : coldStatus;

    if (state.status === "followup" && state.followupDate && state.followupDate <= TODAY_ISO) {
      followups.push({ customer: c, pattern: displayPattern, status: displayStatus, stats, state });
      return;
    }
    if (state.status === "contacted" || state.status === "closed" || state.status === "followup") return;

    if (coldStatus.category === "cold") {
      cold.push({ customer: c, pattern: coldPattern, status: coldStatus, stats, state });
    } else if (dueCandidate && dueLifecycle?.stage === "cold") {
      // Reorder-days signal has drifted 16-30 days past its expected date —
      // same "Going Cold" window used on the Customers page.
      cold.push({
        customer: c,
        pattern: dueCandidate.pattern,
        status: { category: "cold", overdueDays: dueLifecycle.pattern.daysPastDue, pattern: dueCandidate.pattern },
        stats,
        state,
      });
    }
    // Only 0-15 days past the expected reorder date counts as "Due for
    // Reorder"; 16-30 is handled above as "Going Cold", and 31+ ("lost")
    // is deliberately excluded from both dashboard widgets.
    if (dueCandidate && dueLifecycle?.stage === "due") {
      due.push({ customer: c, pattern: dueCandidate.pattern, status: dueCandidate.status, stats, state });
    }
  });
  due.sort((a, b) => (a.status.category === b.status.category ? 0 : a.status.category === "overdue" ? -1 : 1));
  cold.sort((a, b) => b.status.overdueDays - a.status.overdueDays);
  return { due, cold, followups };
}

/* ---------------------------------- context ---------------------------------- */

const StoreContext = createContext(null);
function useStore() {
  return useContext(StoreContext);
}

function StoreProvider({ children }) {
  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [movements, setMovements] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [followups, setFollowups] = useState([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [settings, setSettings] = useState({
    storeName: STORE_NAME_DEFAULT,
    address: "12 MG Road, Bengaluru, Karnataka 560001",
    phone: "+91 98765 43210",
    gst: "",
    invoicePrefix: "INV",
    defaultPayment: "Cash",
    ownerName: "Store Owner",
  });

  function pushToast(message, type = "success") {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }
  function dismissToast(id) {
    setToasts((t) => t.filter((x) => x.id !== id));
  }

  async function loadAll() {
    setDataLoading(true);
    try {
      const data = await fetchAllData();
      setProducts(data.products);
      setCustomers(data.customers);
      setSales(data.sales);
      setMovements(data.movements);
      setFollowups(data.followups);
      if (data.settings) {
        setSettings(data.settings);
      }
      setDataError(null);
    } catch (err) {
      console.error("Supabase fetchAllData failed:", err);
      setDataError(err.message || "Failed to load data from Supabase.");
      pushToast(`Failed to load data from Supabase: ${err.message || err}`, "error");
    } finally {
      setDataLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // opportunityState mirrors the previous in-memory shape (one entry per
  // customer, derived from their latest customer_followups row) so all the
  // reorder-pattern helpers keep working unchanged.
  const opportunityState = useMemo(() => {
    const map = {};
    [...followups]
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
      .forEach((f) => {
        map[f.customerId] = { status: f.status, contactedAt: f.contactedAt, outcome: f.outcome, followupDate: f.followupDate };
      });
    return map;
  }, [followups]);

  function nextInvoiceNumber() {
    let max = 1000;

    sales.forEach((s) => {
      const m = /(\d+)\s*$/.exec(s.invoiceNumber || "");

      if (m) {
        max = Math.max(max, Number(m[1]));
      }
    });

    return `${settings.invoicePrefix}-${max + 1}`;
  }

  async function saveSettings(data) {
    try {
      const saved = await dbUpsertSettings(data);
      setSettings(saved);
      pushToast("Settings Saved ✓", "success");
      return saved;
    } catch (err) {
      console.error("saveSettings failed:", err);
      pushToast(`Failed to save settings: ${err.message}`, "error");
      return null;
    }
  }

  async function addProduct(data) {
    try {
      const product = await dbInsertProduct(data);
      setProducts((prev) => [...prev, product]);
      if (product.stock > 0) {
        const movement = await dbInsertMovement({
          productId: product.id,
          type: "Stock Added",
          quantity: product.stock,
          reference: null,
          reason: "Initial stock on product creation",
          previousStock: 0,
          newStock: product.stock,
        });
        setMovements((prev) => [...prev, movement]);
      }
      pushToast(`Product Added Successfully ✓  ${product.name}`, "success");
      return product;
    } catch (err) {
      console.error("addProduct failed:", err);
      pushToast(`Failed to add product: ${err.message}`, "error");
      return null;
    }
  }

  async function editProduct(id, data) {
    try {
      await dbUpdateProduct(id, data);
      setProducts((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
              ...p,
              name: data.name,
              brand: data.brand,
              category: data.category,
              purchasePrice: Number(data.purchasePrice) || 0,
              sellingPrice: Number(data.sellingPrice) || 0,
              lowStockLimit: Number(data.lowStockLimit) || 5,
              reorderDays:
                data.reorderDays === "" || data.reorderDays === undefined || data.reorderDays === null
                  ? null
                  : Number(data.reorderDays) || null,
            }
            : p
        )
      );
      pushToast(`Product Updated ✓  ${data.name}`, "success");
    } catch (err) {
      console.error("editProduct failed:", err);
      pushToast(`Failed to update product: ${err.message}`, "error");
    }
  }

  async function addStock(productId, qty, purchasePrice, supplier, note) {
    const product = products.find((p) => p.id === productId);
    if (!product || qty <= 0) return;
    const previousStock = product.stock;
    const newStock = previousStock + qty;
    try {
      const ok = await dbSetProductStock(productId, previousStock, newStock);
      if (!ok) {
        pushToast("Stock changed elsewhere — reloading and please retry.", "error");
        await loadAll();
        return;
      }
      const movement = await dbInsertMovement({
        productId,
        type: "Stock Added",
        quantity: qty,
        reference: supplier ? `Supplier: ${supplier}` : null,
        reason: note || "Stock received",
        previousStock,
        newStock,
      });
      setProducts((prev) =>
        prev.map((p) =>
          p.id === productId ? { ...p, stock: newStock, purchasePrice: purchasePrice ? Number(purchasePrice) : p.purchasePrice } : p
        )
      );
      setMovements((prev) => [...prev, movement]);
      pushToast(`Stock Updated ✓  ${product.name}: ${previousStock} → ${newStock}`, "success");
    } catch (err) {
      console.error("addStock failed:", err);
      pushToast(`Failed to add stock: ${err.message}`, "error");
    }
  }

  async function adjustStock(productId, adjustment, reason) {
    const product = products.find((p) => p.id === productId);
    if (!product || adjustment === 0) return;
    const previousStock = product.stock;
    const newStock = Math.max(0, previousStock + adjustment);
    try {
      const ok = await dbSetProductStock(productId, previousStock, newStock);
      if (!ok) {
        pushToast("Stock changed elsewhere — reloading and please retry.", "error");
        await loadAll();
        return;
      }
      const movement = await dbInsertMovement({
        productId,
        type: "Stock Adjustment",
        quantity: newStock - previousStock,
        reference: null,
        reason: reason || "Physical stock correction",
        previousStock,
        newStock,
      });
      setProducts((prev) => prev.map((p) => (p.id === productId ? { ...p, stock: newStock } : p)));
      setMovements((prev) => [...prev, movement]);
      pushToast(`Stock Adjusted ✓  ${product.name}: ${previousStock} → ${newStock}`, "success");
    } catch (err) {
      console.error("adjustStock failed:", err);
      pushToast(`Failed to adjust stock: ${err.message}`, "error");
    }
  }

  // V2: customer directory ---------------------------------------------------
  function findCustomerByPhone(phoneInput) {
    const digits = normalizePhoneDigits(phoneInput);
    if (digits.length < 10) return null;
    return customers.find((c) => normalizePhoneDigits(c.phone) === digits) || null;
  }

  async function createCustomer(phoneInput, name) {
    const digits = normalizePhoneDigits(phoneInput);
    if (digits.length < 10) return null;
    const existing = findCustomerByPhone(digits);
    if (existing) return existing;
    try {
      const customer = await dbInsertCustomer(formatPhoneDisplay(digits), name);
      setCustomers((prev) => [...prev, customer]);
      pushToast(`New customer saved ✓  ${customer.name}`, "success");
      return customer;
    } catch (err) {
      console.error("createCustomer failed:", err);
      pushToast(`Failed to save customer: ${err.message}`, "error");
      return null;
    }
  }

  async function findOrCreateCustomer(phoneInput, name) {
    const digits = normalizePhoneDigits(phoneInput);
    if (digits.length < 10) return null;
    const existing = findCustomerByPhone(digits);
    if (existing) return existing;
    return createCustomer(digits, name);
  }

  async function markContacted(customerId) {
    try {
      const followup = await dbInsertFollowup({ customerId, status: "contacted", contactedAt: new Date().toISOString() });
      setFollowups((prev) => [...prev, followup]);
      pushToast("Contacted ✓", "success");
    } catch (err) {
      console.error("markContacted failed:", err);
      pushToast(`Failed to record contact: ${err.message}`, "error");
    }
  }

  async function recordOutcome(customerId, outcome, followupDate) {
    const closing = outcome === "Purchased" || outcome === "Not interested";
    const OUTCOME_DB_VALUES = {
      "Purchased": "purchased",
      "Will visit later": "will_visit",
      "Not interested": "not_interested",
      "No response": "no_response",
      "Follow up later": "follow_up_later",
    };
    const dbOutcome = OUTCOME_DB_VALUES[outcome] || null;
    try {
      const followup = await dbInsertFollowup({
        customerId,
        status: closing ? "closed" : "followup",
        outcome: dbOutcome,
        contactedAt: opportunityState[customerId]?.contactedAt || new Date().toISOString(),
        followupDate: closing ? null : followupDate || TODAY_ISO,
      });
      setFollowups((prev) => [...prev, followup]);
      pushToast("Outcome recorded ✓", "success");
    } catch (err) {
      console.error("recordOutcome failed:", err);
      pushToast(`Failed to record outcome: ${err.message}`, "error");
    }
  }

  async function markFollowupDone(customerId) {
    try {
      const followup = await dbInsertFollowup({ customerId, status: "closed" });
      setFollowups((prev) => [...prev, followup]);
      pushToast("Follow-up completed ✓", "success");
    } catch (err) {
      console.error("markFollowupDone failed:", err);
      pushToast(`Failed to update follow-up: ${err.message}`, "error");
    }
  }

  async function completeSale(cart, discount, paymentMethod, customerId) {
    if (!cart || cart.length === 0) {
      pushToast("Cart is empty.", "error");
      return null;
    }

    /*
     * IMPORTANT:
     * Work from the current local product snapshot and validate
     * every product before creating the sale.
     */
    for (const item of cart) {
      const product = products.find((p) => p.id === item.id);

      if (!product) {
        pushToast(`Product not found: ${item.name}`, "error");
        return null;
      }

      if (item.qty <= 0) {
        pushToast(`Invalid quantity for ${item.name}.`, "error");
        return null;
      }

      if (item.qty > product.stock) {
        pushToast(
          `Only ${product.stock} units of ${item.name} are available.`,
          "error"
        );

        return null;
      }
    }

    const subtotal = cart.reduce(
      (sum, item) => sum + Number(item.price) * Number(item.qty),
      0
    );

    const safeDiscount = Math.max(
      0,
      Math.min(Number(discount) || 0, subtotal)
    );

    const total = Math.max(0, subtotal - safeDiscount);

    /*
     * Generate the invoice number from the latest local sales state.
     */
    const invoiceNumber = nextInvoiceNumber();

    try {
      /*
       * ---------------------------------------------------------
       * STEP 1 — CREATE SALE
       * ---------------------------------------------------------
       */
      const saleRow = await dbInsertSale({
        invoiceNumber,
        customerId: customerId || null,
        subtotal,
        discount: safeDiscount,
        total,
        paymentMethod,
      });

      if (!saleRow || !saleRow.id) {
        throw new Error("Sale was not created.");
      }

      /*
       * ---------------------------------------------------------
       * STEP 2 — CREATE SALE ITEMS
       * ---------------------------------------------------------
       */
      const items = cart.map((item) => ({
        productId: item.id,
        name: item.name,
        qty: Number(item.qty),
        price: Number(item.price),
        total: Number(item.price) * Number(item.qty),
      }));

      await dbInsertSaleItems(saleRow.id, items);

      /*
       * ---------------------------------------------------------
       * STEP 3 — UPDATE STOCK
       * ---------------------------------------------------------
       *
       * We process each product one at a time.
       * This is intentional because stock changes must be
       * handled safely.
       */
      const newMovements = [];

      for (const item of cart) {
        const product = products.find((p) => p.id === item.id);

        if (!product) {
          throw new Error(`Product not found while updating stock: ${item.name}`);
        }

        const previousStock = Number(product.stock);
        const newStock = previousStock - Number(item.qty);

        if (newStock < 0) {
          throw new Error(
            `Insufficient stock for ${item.name}. Available: ${previousStock}, requested: ${item.qty}`
          );
        }

        /*
         * IMPORTANT:
         * Wait for the Supabase stock update.
         *
         * A thrown error here means the write itself failed and is
         * still fatal. An empty/falsy confirmation with NO thrown
         * error (e.g. RLS permits the update but blocks reading the
         * row back) does not mean the write failed — the UPDATE has
         * already been committed at that point — so it must not abort
         * the sale after the sale + sale_items rows already exist.
         */
        let stockUpdateConfirmed;
        try {
          stockUpdateConfirmed = await dbSetProductStock(
            item.id,
            previousStock,
            newStock
          );
        } catch (stockErr) {
          throw new Error(
            `Stock update failed for ${item.name}: ${stockErr?.message || stockErr}`
          );
        }

        if (!stockUpdateConfirmed) {
          console.warn(
            `Stock update for ${item.name} committed without a confirmation row (previousStock=${previousStock}, newStock=${newStock}).`
          );
        }

        /*
         * -------------------------------------------------------
         * STEP 4 — INSERT STOCK MOVEMENT
         * -------------------------------------------------------
         * Same reasoning as above: a missing confirmation row is not
         * treated as a failed sale, since the movement is an audit
         * record for a stock change that has already happened.
         */
        let movement = null;
        try {
          movement = await dbInsertMovement({
            productId: item.id,
            type: "Sale",
            quantity: -Number(item.qty),
            reference: invoiceNumber,
            reason: null,
            previousStock,
            newStock,
          });
        } catch (movementErr) {
          console.warn(
            `Stock movement could not be recorded for ${item.name}:`,
            movementErr
          );
        }

        if (movement) {
          newMovements.push(movement);
        }

        /*
         * Update React product state immediately after the
         * database stock update succeeds.
         */
        setProducts((prev) =>
          prev.map((p) =>
            p.id === item.id
              ? {
                ...p,
                stock: newStock,
              }
              : p
          )
        );
      }

      /*
       * ---------------------------------------------------------
       * STEP 5 — BUILD FRONTEND SALE OBJECT
       * ---------------------------------------------------------
       */
      const createdAt = new Date(saleRow.created_at);

      const dateISO = `${createdAt.getFullYear()}-${String(
        createdAt.getMonth() + 1
      ).padStart(2, "0")}-${String(
        createdAt.getDate()
      ).padStart(2, "0")}`;

      const time = timeStr(
        createdAt.getHours(),
        createdAt.getMinutes()
      );

      const sale = {
        id: saleRow.id,
        invoiceNumber,
        dateISO,
        time,
        items,
        subtotal,
        discount: safeDiscount,
        total,
        paymentMethod,
        status: "Completed",
        customerId: customerId || null,
      };

      /*
       * ---------------------------------------------------------
       * STEP 6 — UPDATE FRONTEND STATE
       * ---------------------------------------------------------
       */
      setSales((prev) => [...prev, sale]);

      setMovements((prev) => [
        ...prev,
        ...newMovements,
      ]);

      pushToast(
        `Sale Completed ✓ Invoice #${invoiceNumber}`,
        "success"
      );

      return sale;

    } catch (err) {
      console.error("completeSale failed:", err);

      /*
       * IMPORTANT:
       *
       * We do NOT pretend the sale succeeded.
       *
       * We return null so Billing can keep the current bill
       * instead of clearing it.
       */
      pushToast(
        `Failed to complete sale: ${err?.message || "Unknown error"
        }`,
        "error"
      );

      return null;
    }
  }

  const value = {
    products,
    sales,
    movements,
    settings,
    setSettings,
    saveSettings,
    addProduct,
    editProduct,
    addStock,
    adjustStock,
    completeSale,
    toasts,
    pushToast,
    dismissToast,
    customers,
    opportunityState,
    findCustomerByPhone,
    createCustomer,
    findOrCreateCustomer,
    markContacted,
    recordOutcome,
    markFollowupDone,
    dataLoading,
    dataError,
    reloadData: loadAll,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/* ------------------------------- ui primitives ------------------------------- */

function Card({ className = "", children }) {
  return <div className={`bg-white border border-gray-200 rounded-lg ${className}`}>{children}</div>;
}

function Badge({ children, className = "" }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${className}`}>{children}</span>;
}

function PrimaryButton({ children, className = "", ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-md transition-colors ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, className = "", ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 bg-white hover:bg-gray-50 border border-gray-300 text-gray-700 text-sm font-medium px-4 py-2 rounded-md transition-colors ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function DangerButton({ children, className = "", ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 bg-white hover:bg-red-50 border border-gray-300 hover:border-red-300 text-gray-700 hover:text-red-600 text-sm font-medium px-4 py-2 rounded-md transition-colors ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function Modal({ open, onClose, title, children, width = "max-w-lg" }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40" onClick={onClose} />
      <div className={`relative bg-white rounded-lg border border-gray-200 shadow-lg w-full ${width} max-h-[88vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white rounded-t-lg">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <div className="mb-4">
      <label className="block text-xs font-medium text-gray-600 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

const inputClass =
  "w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500 placeholder:text-gray-400";

function EmptyState({ icon: Icon, title, subtitle }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
        <Icon size={20} className="text-gray-400" />
      </div>
      <p className="text-sm font-medium text-gray-700">{title}</p>
      {subtitle && <p className="text-xs text-gray-400 mt-1 max-w-xs">{subtitle}</p>}
    </div>
  );
}

/* ----------------------------------- toasts ---------------------------------- */

function ToastStack() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 w-80">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2.5 bg-white border rounded-lg shadow-md px-4 py-3 text-sm ${t.type === "error" ? "border-red-200" : "border-green-200"
            }`}
        >
          {t.type === "error" ? (
            <XCircle size={18} className="text-red-500 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 size={18} className="text-green-600 shrink-0 mt-0.5" />
          )}
          <span className="text-gray-700 flex-1">{t.message}</span>
          <button onClick={() => dismissToast(t.id)} className="text-gray-300 hover:text-gray-500">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------- invoice modal -------------------------------- */

function InvoiceModal({ sale, onClose }) {
  const { settings, customers } = useStore();
  const [downloading, setDownloading] = useState(false);
  if (!sale) return null;

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadInvoicePdf(sale.invoiceNumber);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
    <Modal open={!!sale} onClose={onClose} title={`Invoice #${sale.invoiceNumber}`} width="max-w-md">
      <div className="text-center mb-4">
        <p className="text-sm font-semibold text-gray-900">{settings.storeName}</p>
        <p className="text-xs text-gray-400 mt-0.5">{settings.address}</p>
        <p className="text-xs text-gray-400">Invoice #{sale.invoiceNumber}</p>
        <p className="text-xs text-gray-400">
          {formatDateShort(sale.dateISO)} · {sale.time}
        </p>
      </div>
      <div className="border-t border-dashed border-gray-300 pt-3 space-y-2">
        {sale.items.map((it, idx) => (
          <div key={idx} className="flex justify-between text-sm">
            <div>
              <p className="text-gray-800">{it.name}</p>
              <p className="text-xs text-gray-400">
                {it.qty} × {formatINR(it.price)}
              </p>
            </div>
            <p className="text-gray-800 font-medium">{formatINR(it.total)}</p>
          </div>
        ))}
      </div>
      <div className="border-t border-dashed border-gray-300 mt-3 pt-3 space-y-1.5 text-sm">
        <div className="flex justify-between text-gray-500">
          <span>Subtotal</span>
          <span>{formatINR(sale.subtotal)}</span>
        </div>
        {sale.discount > 0 && (
          <div className="flex justify-between text-red-500">
            <span>Discount</span>
            <span>-{formatINR(sale.discount)}</span>
          </div>
        )}
        <div className="flex justify-between text-base font-semibold text-gray-900 pt-1.5 border-t border-gray-200">
          <span>Total</span>
          <span>{formatINR(sale.total)}</span>
        </div>
        <div className="flex justify-between text-gray-500 pt-1">
          <span>Payment</span>
          <span className="font-medium text-gray-700">{sale.paymentMethod}</span>
        </div>
      </div>
      <div className="flex gap-2 mt-5">
        <SecondaryButton className="flex-1" onClick={handleDownload} disabled={downloading}>
          <Download size={15} /> {downloading ? "Preparing PDF…" : "Download Invoice PDF"}
        </SecondaryButton>
        <PrimaryButton className="flex-1" onClick={onClose}>
          Close
        </PrimaryButton>
      </div>
    </Modal>
    <PrintableInvoice sale={sale} settings={settings} customers={customers} />
    </>
  );
}

/* ---------------------------- printable A4 invoice ----------------------------- */

/*
 * The invoice must be the ONLY thing that appears in the print/PDF output —
 * nothing from the app shell (sidebar, modals, toasts, the billing screen
 * underneath the success modal) is acceptable.
 *
 * Nesting the invoice inside the normal component tree and trying to hide
 * everything else with CSS (visibility/display toggles on ancestors) is
 * fragile: any ancestor with its own `display: none` (e.g. a Tailwind
 * `hidden` class) silently wins and the invoice never renders at all,
 * while unrelated fixed-position UI (like the success modal) can still
 * leak into the printed page. That was the actual bug here.
 *
 * The reliable fix: render the invoice through a React portal into a
 * dedicated element attached directly to <body>, completely outside the
 * app's own DOM subtree. Print CSS then only has to do one simple,
 * bulletproof thing: hide every other direct child of <body> and show
 * this one. See the #print-invoice-root rules in index.css.
 */
let printPortalNode = null;
function getPrintPortalNode() {
  if (typeof document === "undefined") return null;
  if (printPortalNode && document.body.contains(printPortalNode)) {
    return printPortalNode;
  }
  printPortalNode = document.getElementById("print-invoice-root");
  if (!printPortalNode) {
    printPortalNode = document.createElement("div");
    printPortalNode.id = "print-invoice-root";
    document.body.appendChild(printPortalNode);
  }
  return printPortalNode;
}

/*
 * Renders the currently-portaled invoice (#print-invoice-root, painted
 * off-screen at A4 width by index.css) to a canvas, then embeds it in a
 * jsPDF A4 document. Splits across multiple pages if the invoice is
 * ever taller than one A4 page (e.g. a great many line items).
 */
async function renderInvoicePdfBlob() {
  const node = document.getElementById("print-invoice-root");
  if (!node) return null;

  const canvas = await html2canvas(node, {
    scale: 2,
    backgroundColor: "#ffffff",
  });
  const imgData = canvas.toDataURL("image/png");

  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const imgWidth = pageWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  let heightLeft = imgHeight;
  let position = 0;
  pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
  heightLeft -= pageHeight;

  while (heightLeft > 0) {
    position = heightLeft - imgHeight;
    pdf.addPage();
    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
  }

  return pdf.output("blob");
}

function isIOSDevice() {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/*
 * Android + Mac (+ any other desktop browser): a plain <a download> is
 * the reliable, native way to save a Blob to disk.
 *
 * iPhone/iPad: Mobile Safari does not offer a real "download" concept —
 * the closest native equivalent is the share sheet, which lets the
 * person save the PDF to Files, AirDrop it, etc. We use the Web Share
 * API with a File when the browser supports sharing files, falling
 * back to the normal download link otherwise.
 */
async function downloadInvoicePdf(invoiceNumber) {
  const blob = await renderInvoicePdfBlob();
  if (!blob) return;

  const filename = `Invoice-${invoiceNumber}.pdf`;

  if (isIOSDevice() && typeof navigator !== "undefined" && navigator.canShare) {
    const file = new File([blob], filename, { type: "application/pdf" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
        // Sharing failed for some other reason — fall through to a normal download.
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/*
 * Renders a full A4 tax-invoice for `sale`. Mounted once per
 * invoice-viewing flow (InvoiceModal, and the post-sale success screen in
 * Billing) right next to the sale data each flow already has, so it
 * always reflects the actual sale and the current Settings values —
 * nothing here is hardcoded.
 */
function PrintableInvoice({ sale, settings, customers }) {
  const portalNode = getPrintPortalNode();
  if (!sale || !portalNode) return null;

  const customer = sale.customerId
    ? (customers || []).find((c) => c.id === sale.customerId)
    : null;

  const subtotal = Number(sale.subtotal) || 0;
  const discount = Number(sale.discount) || 0;
  const grandTotal = Number(sale.total) || 0;
  /*
   * The app does not currently record a tax rate anywhere (products,
   * settings, or sales) — billing today is subtotal minus discount only.
   * Tax is computed from the real numbers rather than assumed, so it
   * correctly shows ₹0 until the app captures actual tax data.
   */
  const taxAmount = Math.max(0, grandTotal - (subtotal - discount));

  return createPortal(
    <div className="print-invoice">
      <div className="flex justify-between items-start mb-6 pb-4 border-b-2 border-gray-800">
        <div>
          <p className="text-xl font-bold text-gray-900">{settings.storeName}</p>
          <p className="text-xs text-gray-600 mt-1 max-w-xs">{settings.address}</p>
          <p className="text-xs text-gray-600">Phone: {formatPhoneDisplay(normalizePhoneDigits(settings.phone))}</p>
          {settings.gst && <p className="text-xs text-gray-600">GSTIN: {settings.gst}</p>}
        </div>
        <div className="text-right">
          <p className="text-base font-bold text-gray-900 uppercase tracking-wide">Tax Invoice</p>
          <p className="text-xs text-gray-600 mt-1">Invoice No: {sale.invoiceNumber}</p>
          <p className="text-xs text-gray-600">
            Date: {formatDateShort(sale.dateISO)} · {sale.time}
          </p>
        </div>
      </div>

      <div className="mb-5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Bill To</p>
        {customer ? (
          <>
            <p className="text-sm font-medium text-gray-900">{customer.name}</p>
            {customer.phone && <p className="text-xs text-gray-600">{formatPhoneDisplay(customer.phone)}</p>}
          </>
        ) : (
          <p className="text-sm font-medium text-gray-900">Walk-in Customer</p>
        )}
      </div>

      <table className="w-full text-xs border-collapse mb-5">
        <thead>
          <tr className="border-b-2 border-gray-800 text-left text-gray-700">
            <th className="py-1.5 pr-2 font-semibold">#</th>
            <th className="py-1.5 pr-2 font-semibold">Product</th>
            <th className="py-1.5 px-2 font-semibold text-right">Qty</th>
            <th className="py-1.5 px-2 font-semibold text-right">Rate</th>
            <th className="py-1.5 px-2 font-semibold text-right">Tax</th>
            <th className="py-1.5 pl-2 font-semibold text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {sale.items.map((it, idx) => (
            <tr key={idx} className="border-b border-gray-200">
              <td className="py-1.5 pr-2 text-gray-600">{idx + 1}</td>
              <td className="py-1.5 pr-2 text-gray-900">{it.name}</td>
              <td className="py-1.5 px-2 text-right text-gray-700">{it.qty}</td>
              <td className="py-1.5 px-2 text-right text-gray-700">{formatINR(it.price)}</td>
              <td className="py-1.5 px-2 text-right text-gray-700">₹0</td>
              <td className="py-1.5 pl-2 text-right font-medium text-gray-900">{formatINR(it.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex justify-end mb-5">
        <div className="w-64 text-xs space-y-1.5">
          <div className="flex justify-between text-gray-600">
            <span>Subtotal</span>
            <span>{formatINR(subtotal)}</span>
          </div>
          {discount > 0 && (
            <div className="flex justify-between text-gray-600">
              <span>Discount</span>
              <span>-{formatINR(discount)}</span>
            </div>
          )}
          <div className="flex justify-between text-gray-600">
            <span>GST/Tax</span>
            <span>{formatINR(taxAmount)}</span>
          </div>
          <div className="flex justify-between text-sm font-bold text-gray-900 pt-1.5 border-t-2 border-gray-800">
            <span>Grand Total</span>
            <span>{formatINR(grandTotal)}</span>
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-700 mb-8">
        <span className="font-semibold">Amount in Words: </span>
        {numberToWordsIndian(grandTotal)} Rupees Only
      </p>

      <div className="text-[10px] text-gray-500 border-t border-gray-300 pt-3 text-center">
        <p>Payment Method: {sale.paymentMethod}</p>
        <p className="mt-1">Thank you for your business!</p>
        <p className="mt-1">This is a system-generated invoice.</p>
      </div>
    </div>,
    portalNode
  );
}

/* ---------------------------------- sidebar ----------------------------------- */

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["owner", "staff"] },
  { id: "billing", label: "Billing", icon: Receipt, roles: ["owner", "staff"] },
  { id: "products", label: "Products", icon: Package, roles: ["owner"] },
  { id: "stock", label: "Stock", icon: Boxes, roles: ["owner"] },
  { id: "customers", label: "Customers", icon: Users, roles: ["owner"] },
  { id: "sales", label: "Sales", icon: TrendingUp, roles: ["owner", "staff"] },
  { id: "calendar", label: "Calendar", icon: CalendarIcon, roles: ["owner", "staff"] },
  { id: "reports", label: "Reports", icon: BarChart3, roles: ["owner"] },
  { id: "settings", label: "Settings", icon: SettingsIcon, roles: ["owner"] },
];

function Sidebar({ page, setPage, role, setRole, mobileOpen, setMobileOpen }) {
  const { settings } = useStore();
  const { user, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const items = NAV_ITEMS.filter((it) => it.roles.includes(role));

  const content = (
    <div className="flex flex-col h-full">
      <div className="px-5 py-5 flex items-center gap-2 border-b border-gray-200">
        <div className="w-8 h-8 rounded-md bg-green-600 flex items-center justify-center shrink-0">
          <IndianRupee size={16} className="text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">{settings.storeName}</p>
          <p className="text-xs text-gray-400">Billing &amp; Inventory</p>
        </div>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {items.map((item) => {
          const Icon = item.icon;
          const active = page === item.id;
          return (
            <button
              key={item.id}
              onClick={() => {
                setPage(item.id);
                setMobileOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${active ? "bg-green-50 text-green-700" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`}
            >
              <Icon size={17} className={active ? "text-green-600" : "text-gray-400"} />
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="border-t border-gray-200 p-3 relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-gray-50"
        >
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
            <User size={15} className="text-gray-500" />
          </div>
          <div className="flex-1 text-left min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{role === "owner" ? "Owner" : "Staff"}</p>
            <p className="text-xs text-gray-400 truncate">{settings.ownerName}</p>
          </div>
          <ChevronDown size={14} className="text-gray-400" />
        </button>
        {menuOpen && (
          <div className="absolute bottom-16 left-3 right-3 bg-white border border-gray-200 rounded-md shadow-lg py-1 z-10">
            <p className="px-3 py-1.5 text-xs text-gray-400">Demo role switcher</p>
            <button
              onClick={() => {
                setRole("owner");
                setMenuOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-gray-50 ${role === "owner" ? "text-green-700 font-medium" : "text-gray-700"
                }`}
            >
              Switch to Owner View {role === "owner" && <CheckCircle2 size={14} />}
            </button>
            <button
              onClick={() => {
                setRole("staff");
                setPage((p) => (NAV_ITEMS.find((n) => n.id === p)?.roles.includes("staff") ? p : "dashboard"));
                setMenuOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-gray-50 ${role === "staff" ? "text-green-700 font-medium" : "text-gray-700"
                }`}
            >
              Switch to Staff View {role === "staff" && <CheckCircle2 size={14} />}
            </button>
            <div className="border-t border-gray-100 mt-1 pt-1">
              {user?.email && <p className="px-3 pb-1 text-xs text-gray-400 truncate">Signed in as {user.email}</p>}
              <button
                onClick={() => {
                  setMenuOpen(false);
                  signOut();
                }}
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 text-red-600 hover:bg-red-50"
              >
                <LogOut size={14} /> Log Out
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden md:flex md:flex-col w-60 shrink-0 bg-white border-r border-gray-200 h-screen sticky top-0">
        {content}
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-gray-900/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-64 bg-white shadow-lg">{content}</aside>
        </div>
      )}
    </>
  );
}

/* --------------------------------- dashboard ---------------------------------- */

function KpiCard({ label, value, icon: Icon, tone = "gray" }) {
  const toneMap = {
    green: "bg-green-50 text-green-600",
    red: "bg-red-50 text-red-600",
    amber: "bg-amber-50 text-amber-600",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <div className={`w-8 h-8 rounded-md flex items-center justify-center ${toneMap[tone]}`}>
          <Icon size={16} />
        </div>
      </div>
      <p className="text-2xl font-semibold text-gray-900">{value}</p>
    </Card>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 17) return "Good Afternoon";
  return "Good Evening";
}

function Dashboard({ setPage, openInvoice, openCustomer, openContact, goToCustomers }) {
  const { products, sales, settings, customers, opportunityState, markFollowupDone } = useStore();
  const opportunities = useMemo(() => computeOpportunities(customers, sales, products, opportunityState), [customers, sales, products, opportunityState]);
  const estimatedOpportunity = useMemo(
    () => Math.round(opportunities.due.reduce((s, o) => s + o.stats.totalSpent / o.stats.totalPurchases, 0)),
    [opportunities.due]
  );

  const todaysSales = useMemo(() => sales.filter((s) => s.dateISO === TODAY_ISO), [sales]);
  const todaysTotal = todaysSales.reduce((s, x) => s + x.total, 0);
  const lowStock = products.filter((p) => p.stock > 0 && p.stock <= p.lowStockLimit);
  const outOfStock = products.filter((p) => p.stock === 0);

  const chartData = useMemo(() => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      days.push(iso);
    }
    return days.map((iso) => {
      const dayTotal = sales.filter((s) => s.dateISO === iso).reduce((s, x) => s + x.total, 0);
      return { label: parseISO(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }), amount: dayTotal };
    });
  }, [sales]);

  const recent = useMemo(
    () =>
      [...sales]
        .sort((a, b) => (b.dateISO + b.time).localeCompare(a.dateISO + a.time))
        .slice(0, 6),
    [sales]
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">
          {greeting()}, {settings.ownerName.split(" ")[0]}
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">Here's what's happening in your store today.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Today's Sales" value={formatINR(todaysTotal)} icon={IndianRupee} tone="green" />
        <KpiCard label="Today's Bills" value={todaysSales.length} icon={Receipt} tone="gray" />
        <KpiCard label="Total Products" value={products.length} icon={Package} tone="gray" />
        <KpiCard label="Low Stock" value={lowStock.length + outOfStock.length} icon={AlertTriangle} tone="amber" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="p-4 lg:col-span-2">
          <p className="text-sm font-semibold text-gray-900 mb-4">Sales Overview — Last 7 Days</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#9ca3af" }} axisLine={{ stroke: "#e5e7eb" }} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: "#9ca3af" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCompactINR(v)} width={50} />
                <Tooltip formatter={(v) => formatINR(v)} contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "#e5e7eb" }} />
                <Line type="monotone" dataKey="amount" stroke="#16a34a" strokeWidth={2.5} dot={{ r: 3, fill: "#16a34a" }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-gray-900">Low Stock</p>
            <button onClick={() => setPage("stock")} className="text-xs font-medium text-green-600 hover:text-green-700">
              View All
            </button>
          </div>
          {lowStock.length === 0 && outOfStock.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">All products are well stocked.</p>
          ) : (
            <div className="space-y-3">
              {[...outOfStock, ...lowStock].slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-sm text-gray-800 truncate">{p.name}</p>
                    <p className="text-xs text-gray-400">{p.stock} units left</p>
                  </div>
                  <Badge className={statusClasses(statusOf(p))}>{statusOf(p)}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <p className="text-sm font-semibold text-gray-900 mb-3">Recent Sales</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                <th className="pb-2 font-medium">Invoice</th>
                <th className="pb-2 font-medium">Time</th>
                <th className="pb-2 font-medium">Items</th>
                <th className="pb-2 font-medium">Payment</th>
                <th className="pb-2 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => openInvoice(s)}
                  className="border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer"
                >
                  <td className="py-2.5 font-medium text-gray-800">{s.invoiceNumber}</td>
                  <td className="py-2.5 text-gray-500">{s.time}</td>
                  <td className="py-2.5 text-gray-500">{s.items.reduce((a, i) => a + i.qty, 0)}</td>
                  <td className="py-2.5 text-gray-500">{s.paymentMethod}</td>
                  <td className="py-2.5 text-right font-medium text-green-700">{formatINR(s.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* V2 — Customer Reorder & Sales Intelligence */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Users size={15} className="text-green-600" />
          <p className="text-sm font-semibold text-gray-900">Customer Sales Opportunities</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <button onClick={() => goToCustomers("due")} className="text-left">
            <Card className="p-4 hover:border-green-300 transition-colors">
              <p className="text-xs font-medium text-gray-500">Due for Reorder</p>
              <p className="text-2xl font-semibold text-gray-900 mt-1">{opportunities.due.length}</p>
            </Card>
          </button>
          <button onClick={() => goToCustomers("cold")} className="text-left">
            <Card className="p-4 hover:border-orange-300 transition-colors">
              <p className="text-xs font-medium text-gray-500">Going Cold</p>
              <p className="text-2xl font-semibold text-gray-900 mt-1">{opportunities.cold.length}</p>
            </Card>
          </button>
          <button onClick={() => goToCustomers("followup")} className="text-left">
            <Card className="p-4 hover:border-amber-300 transition-colors">
              <p className="text-xs font-medium text-gray-500">Follow-ups Today</p>
              <p className="text-2xl font-semibold text-gray-900 mt-1">{opportunities.followups.length}</p>
            </Card>
          </button>
        </div>

        {opportunities.due.length > 0 && (
          <Card className="p-4 mb-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Customer Reorder Opportunities</p>
              <p className="text-xs text-gray-400">Potential Repeat Sales</p>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              {opportunities.due.length} customers due · previous purchase value ~<span className="font-medium text-gray-600">{formatINR(estimatedOpportunity)}</span> ·{" "}
              <span className="italic">estimated repeat-sales opportunity, not guaranteed revenue</span>
            </p>
            <div className="divide-y divide-gray-50">
              {opportunities.due.slice(0, 4).map((o) => (
                <div key={o.customer.id} className="py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{o.customer.name}</p>
                    <p className="text-xs text-gray-500">{o.pattern.productName}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Last purchase {formatDateShort(o.pattern.lastPurchaseDate)} · Expected reorder ~{formatDateShort(o.pattern.expectedDate)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge className="bg-amber-50 text-amber-700 border border-amber-200">
                      <BellRing size={11} className="inline mr-1 -mt-0.5" />
                      {o.status.label}
                    </Badge>
                    <SecondaryButton onClick={() => openCustomer(o.customer.id)} className="!px-3 !py-1.5 !text-xs">
                      View Customer
                    </SecondaryButton>
                    <PrimaryButton onClick={() => openContact(o.customer.id)} className="!px-3 !py-1.5 !text-xs">
                      Contact
                    </PrimaryButton>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {opportunities.cold.length > 0 && (
          <Card className="p-4 mb-4">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-3">Customers Going Cold</p>
            <div className="divide-y divide-gray-50">
              {opportunities.cold.slice(0, 3).map((o) => (
                <div key={o.customer.id} className="py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{o.customer.name}</p>
                    <p className="text-xs text-gray-500">{o.pattern.productName}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Expected ~{formatDateShort(o.pattern.expectedDate)} · Last purchase {formatDateShort(o.pattern.lastPurchaseDate)} · Overdue {o.status.overdueDays} days
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge className="bg-orange-50 text-orange-700 border border-orange-200">
                      <Snowflake size={11} className="inline mr-1 -mt-0.5" />
                      Going Cold
                    </Badge>
                    <PrimaryButton onClick={() => openContact(o.customer.id)} className="!px-3 !py-1.5 !text-xs">
                      Contact
                    </PrimaryButton>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {opportunities.followups.length > 0 && (
          <Card className="p-4">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-3">Follow-ups Today</p>
            <div className="divide-y divide-gray-50">
              {opportunities.followups.map((o) => (
                <div key={o.customer.id} className="py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{o.customer.name}</p>
                    <p className="text-xs text-gray-500">{o.pattern.productName}</p>
                    <p className="text-xs text-gray-400 mt-0.5">Customer said they would visit.</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <SecondaryButton onClick={() => openContact(o.customer.id)} className="!px-3 !py-1.5 !text-xs">
                      Contact
                    </SecondaryButton>
                    <PrimaryButton onClick={() => markFollowupDone(o.customer.id)} className="!px-3 !py-1.5 !text-xs">
                      Mark Done
                    </PrimaryButton>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------- billing ------------------------------------ */

function Billing() {
  const {
    products,
    sales,
    customers,
    settings,
    completeSale,
    findCustomerByPhone,
    findOrCreateCustomer,
  } = useStore();

  const [query, setQuery] = useState("");
  const [cart, setCart] = useState([]);
  const [discount, setDiscount] = useState(0);
  const [payment, setPayment] = useState(settings.defaultPayment);
  const [heldBills, setHeldBills] = useState([]);
  const [heldOpen, setHeldOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [successSale, setSuccessSale] = useState(null);
  const [downloadingInvoice, setDownloadingInvoice] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [customerSaved, setCustomerSaved] = useState(null);
  const [processingSale, setProcessingSale] = useState(false);

  /*
   * This lock prevents the sale function from being triggered
   * more than once before React has time to re-render.
   */
  const saleLockRef = useRef(false);

  const { pushToast } = useStore();

  const phoneDigits = normalizePhoneDigits(phoneInput);

  const matchedCustomer =
    phoneDigits.length === 10
      ? findCustomerByPhone(phoneDigits)
      : null;

  const activeCustomer =
    customerSaved || matchedCustomer;

  function resetCustomer() {
    setPhoneInput("");
    setNewCustomerName("");
    setCustomerSaved(null);
  }

  async function saveCustomerNow() {
    if (phoneDigits.length !== 10) return;

    try {
      const c = await findOrCreateCustomer(
        phoneDigits,
        newCustomerName
      );

      if (c) {
        setCustomerSaved(c);
      }
    } catch (err) {
      console.error("Save customer failed:", err);

      pushToast(
        "Failed to save customer.",
        "error"
      );
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (!q) {
      return products;
    }

    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.brand.toLowerCase().includes(q)
    );
  }, [products, query]);

  const subtotal = cart.reduce(
    (sum, item) =>
      sum + item.price * item.qty,
    0
  );

  const total = Math.max(
    0,
    subtotal - discount
  );

  function addToCart(product) {
    if (product.stock <= 0) {
      pushToast(
        `${product.name} is out of stock.`,
        "error"
      );
      return;
    }

    setCart((prev) => {
      const existing = prev.find(
        (c) => c.id === product.id
      );

      const currentQty = existing
        ? existing.qty
        : 0;

      if (
        currentQty + 1 >
        product.stock
      ) {
        pushToast(
          `Only ${product.stock} units available.`,
          "error"
        );

        return prev;
      }

      if (existing) {
        return prev.map((c) =>
          c.id === product.id
            ? {
                ...c,
                qty: c.qty + 1,
              }
            : c
        );
      }

      return [
        ...prev,
        {
          id: product.id,
          name: product.name,
          price: product.sellingPrice,
          stock: product.stock,
          qty: 1,
        },
      ];
    });
  }

  function changeQty(id, delta) {
    setCart((prev) => {
      return prev
        .map((c) => {
          if (c.id !== id) {
            return c;
          }

          const product = products.find(
            (p) => p.id === id
          );

          if (!product) {
            return c;
          }

          const newQty =
            c.qty + delta;

          if (newQty > product.stock) {
            pushToast(
              `Only ${product.stock} units available.`,
              "error"
            );

            return c;
          }

          return {
            ...c,
            qty: newQty,
          };
        })
        .filter(
          (c) => c.qty > 0
        );
    });
  }

  function removeItem(id) {
    setCart((prev) =>
      prev.filter(
        (c) => c.id !== id
      )
    );
  }

  function clearBill() {
    setCart([]);
    setDiscount(0);
    setConfirmClear(false);
    resetCustomer();
  }

  function holdBill() {
    if (cart.length === 0) {
      return;
    }

    setHeldBills((prev) => [
      ...prev,
      {
        id: Math.random()
          .toString(36)
          .slice(2),
        cart,
        discount,
        payment,
        phoneInput,
        newCustomerName,
        customerSaved,
        time: timeStr(
          new Date().getHours(),
          new Date().getMinutes()
        ),
      },
    ]);

    setCart([]);
    setDiscount(0);
    resetCustomer();

    pushToast(
      "Bill Held",
      "success"
    );
  }

  function resumeHeld(id) {
    const held = heldBills.find(
      (h) => h.id === id
    );

    if (!held) {
      return;
    }

    setCart(held.cart);
    setDiscount(held.discount);
    setPayment(held.payment);
    setPhoneInput(
      held.phoneInput || ""
    );
    setNewCustomerName(
      held.newCustomerName || ""
    );
    setCustomerSaved(
      held.customerSaved || null
    );

    setHeldBills((prev) =>
      prev.filter(
        (h) => h.id !== id
      )
    );

    setHeldOpen(false);
  }

  /*
   * ---------------------------------------------------------
   * COMPLETE SALE
   * ---------------------------------------------------------
   *
   * There must be ONLY ONE completeSaleClick function.
   */
  async function completeSaleClick() {
    /*
     * Synchronous lock.
     *
     * This is intentionally checked before setProcessingSale()
     * because React state updates are asynchronous.
     */
    if (
      saleLockRef.current ||
      processingSale ||
      cart.length === 0
    ) {
      return;
    }

    saleLockRef.current = true;
    setProcessingSale(true);

    let customerId = null;

    try {
      /*
       * Resolve customer first.
       */
      if (phoneDigits.length === 10) {
        let customer =
          customerSaved ||
          matchedCustomer;

        if (!customer) {
          customer =
            await findOrCreateCustomer(
              phoneDigits,
              newCustomerName
            );
        }

        customerId = customer
          ? customer.id
          : null;
      }

      /*
       * Complete the sale.
       *
       * IMPORTANT:
       * We wait for completeSale() to finish before
       * clearing the cart.
       */
      const sale = await completeSale(
        cart,
        discount,
        payment,
        customerId
      );

      /*
       * If the store did not return a sale,
       * keep the current bill intact.
       */
      if (!sale) {
        return;
      }

      /*
       * Sale was successfully completed.
       */
      setSuccessSale(sale);

      setCart([]);
      setDiscount(0);

      resetCustomer();

    } catch (err) {
      console.error(
        "Complete Sale Click failed:",
        err
      );

      /*
       * DO NOT clear the cart when an error occurs.
       */
      pushToast(
        `Failed to complete sale: ${
          err?.message || "Unknown error"
        }`,
        "error"
      );

    } finally {
      /*
       * Always unlock the button.
       */
      saleLockRef.current = false;
      setProcessingSale(false);
    }
  }

  const paymentIcons = {
    Cash: Banknote,
    UPI: Smartphone,
    Card: CreditCard,
  };

  async function handleDownloadInvoice() {
    if (downloadingInvoice || !successSale) return;
    setDownloadingInvoice(true);
    try {
      await downloadInvoicePdf(successSale.invoiceNumber);
    } finally {
      setDownloadingInvoice(false);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">

      {/* LEFT */}
      <div className="lg:col-span-3 space-y-4">

        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />

          <input
            className={
              inputClass + " pl-9"
            }
            placeholder="Search product..."
            value={query}
            onChange={(e) =>
              setQuery(e.target.value)
            }
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

          {filtered.map((p) => {
            const status = statusOf(p);
            const disabled =
              p.stock <= 0;

            return (
              <button
                key={p.id}
                onClick={() =>
                  addToCart(p)
                }
                disabled={disabled}
                className={`text-left border rounded-lg p-3.5 bg-white transition-colors ${
                  disabled
                    ? "opacity-50 cursor-not-allowed border-gray-200"
                    : "border-gray-200 hover:border-green-400 hover:shadow-sm"
                }`}
              >
                <p className="text-sm font-medium text-gray-900 leading-tight">
                  {p.name}
                </p>

                <p className="text-xs text-gray-400 mt-0.5">
                  {p.brand}
                </p>

                <div className="flex items-center justify-between mt-2.5">

                  <span className="text-sm font-semibold text-gray-900">
                    {formatINR(
                      p.sellingPrice
                    )}
                  </span>

                  <Badge
                    className={statusClasses(
                      status
                    )}
                  >
                    {status ===
                    "In Stock"
                      ? `Stock: ${p.stock}`
                      : status}
                  </Badge>

                </div>
              </button>
            );
          })}

          {filtered.length === 0 && (
            <div className="sm:col-span-2">
              <EmptyState
                icon={Search}
                title="No products found"
                subtitle="Try a different search term."
              />
            </div>
          )}

        </div>
      </div>

      {/* RIGHT */}
      <div className="lg:col-span-2">

        <Card className="p-4 sticky top-4">

          <div className="flex items-center justify-between mb-3">

            <div className="flex items-center gap-2">

              <ShoppingCart
                size={16}
                className="text-green-600"
              />

              <p className="text-sm font-semibold text-gray-900">
                New Bill
              </p>

            </div>

            {heldBills.length > 0 && (
              <div className="relative">

                <button
                  onClick={() =>
                    setHeldOpen(
                      (v) => !v
                    )
                  }
                  className="text-xs font-medium text-amber-600 flex items-center gap-1 hover:text-amber-700"
                >
                  <PauseCircle
                    size={13}
                  />

                  Held Bills (
                  {heldBills.length})
                </button>

                {heldOpen && (
                  <div className="absolute right-0 mt-2 w-56 bg-white border border-gray-200 rounded-md shadow-lg z-10 py-1">

                    {heldBills.map(
                      (h) => (
                        <button
                          key={h.id}
                          onClick={() =>
                            resumeHeld(
                              h.id
                            )
                          }
                          className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 flex items-center justify-between"
                        >
                          <span className="text-gray-600">
                            {h.time} ·{" "}
                            {
                              h.cart
                                .length
                            }{" "}
                            items
                          </span>

                          <span className="flex items-center gap-1 text-green-600 font-medium">
                            <PlayCircle
                              size={12}
                            />

                            Resume
                          </span>
                        </button>
                      )
                    )}

                  </div>
                )}

              </div>
            )}

          </div>

          {/* CUSTOMER */}

          <div className="mb-4 border border-gray-200 rounded-md p-3 bg-gray-50/60">

            <p className="text-xs font-medium text-gray-500 mb-2">
              Customer
            </p>

            {activeCustomer ? (

              <div className="flex items-center justify-between gap-2">

                <div>

                  <p className="text-xs font-semibold text-green-700 flex items-center gap-1">

                    <UserPlus
                      size={12}
                    />

                    {matchedCustomer
                      ? "Existing Customer"
                      : "New Customer Saved"}

                  </p>

                  <p className="text-sm text-gray-900 font-medium mt-0.5">
                    {
                      activeCustomer.name
                    }
                  </p>

                  {matchedCustomer &&
                    (() => {
                      const stats =
                        customerStats(
                          sales,
                          matchedCustomer.id
                        );

                      return (
                        <p className="text-xs text-gray-400">
                          Last Purchase:{" "}
                          {stats.lastPurchaseDate
                            ? formatDateShort(
                                stats.lastPurchaseDate
                              )
                            : "—"}{" "}
                          · Previous Spend:{" "}
                          {formatINR(
                            stats.totalSpent
                          )}
                        </p>
                      );
                    })()}

                </div>

                <button
                  onClick={
                    resetCustomer
                  }
                  className="text-xs text-gray-400 hover:text-red-500 flex items-center gap-1 shrink-0"
                >
                  <X size={12} />
                  Walk-in
                </button>

              </div>

            ) : (

              <>
                <div className="relative">

                  <Phone
                    size={13}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
                  />

                  <input
                    value={phoneInput}
                    onChange={(e) =>
                      setPhoneInput(
                        e.target.value
                      )
                    }
                    placeholder="+91 Phone Number (optional)"
                    className={
                      inputClass +
                      " pl-8 !py-1.5 !text-sm"
                    }
                  />

                </div>

                {phoneDigits.length ===
                  10 &&
                  !matchedCustomer && (

                    <div className="mt-2 flex items-center gap-2">

                      <input
                        value={
                          newCustomerName
                        }
                        onChange={(e) =>
                          setNewCustomerName(
                            e.target.value
                          )
                        }
                        placeholder="Name (optional)"
                        className={
                          inputClass +
                          " !py-1.5 !text-sm flex-1"
                        }
                      />

                      <SecondaryButton
                        onClick={
                          saveCustomerNow
                        }
                        className="!px-3 !py-1.5 !text-xs shrink-0"
                      >
                        Save Customer
                      </SecondaryButton>

                    </div>
                  )}

                {phoneDigits.length ===
                  0 && (
                  <p className="text-xs text-gray-400 mt-1">
                    Walk-in Customer —
                    phone number is
                    optional.
                  </p>
                )}

              </>
            )}

          </div>

          {/* CART */}

          {cart.length === 0 ? (

            <EmptyState
              icon={ShoppingCart}
              title="Cart is empty"
              subtitle="Search and select products on the left to start a bill."
            />

          ) : (

            <div className="space-y-3 max-h-72 overflow-y-auto pr-1">

              {cart.map((item) => (

                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2"
                >

                  <div className="min-w-0 flex-1">

                    <p className="text-sm text-gray-800 truncate">
                      {item.name}
                    </p>

                    <p className="text-xs text-gray-400">
                      {formatINR(
                        item.price
                      )}{" "}
                      × {item.qty}
                    </p>

                  </div>

                  <div className="flex items-center gap-1.5">

                    <button
                      onClick={() =>
                        changeQty(
                          item.id,
                          -1
                        )
                      }
                      className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 text-gray-500 hover:bg-gray-50"
                    >
                      <Minus
                        size={12}
                      />
                    </button>

                    <span className="w-5 text-center text-sm font-medium">
                      {item.qty}
                    </span>

                    <button
                      onClick={() =>
                        changeQty(
                          item.id,
                          1
                        )
                      }
                      className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 text-gray-500 hover:bg-gray-50"
                    >
                      <Plus
                        size={12}
                      />
                    </button>

                  </div>

                  <p className="w-16 text-right text-sm font-medium text-gray-900">
                    {formatINR(
                      item.price *
                        item.qty
                    )}
                  </p>

                  <button
                    onClick={() =>
                      removeItem(
                        item.id
                      )
                    }
                    className="text-gray-300 hover:text-red-500"
                  >
                    <Trash2
                      size={14}
                    />
                  </button>

                </div>

              ))}

            </div>
          )}

          {/* TOTALS */}

          <div className="border-t border-gray-200 mt-4 pt-3 space-y-1.5 text-sm">

            <div className="flex justify-between text-gray-500">

              <span>
                Subtotal
              </span>

              <span>
                {formatINR(
                  subtotal
                )}
              </span>

            </div>

            <div className="flex justify-between items-center text-gray-500">

              <span>
                Discount
              </span>

              <input
                type="number"
                min={0}
                max={subtotal}
                value={discount}
                onChange={(e) =>
                  setDiscount(
                    Math.max(
                      0,
                      Math.min(
                        subtotal,
                        Number(
                          e.target.value
                        ) || 0
                      )
                    )
                  )
                }
                className="w-24 text-right border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-green-500"
              />

            </div>

            <div className="flex justify-between text-base font-semibold text-gray-900 pt-2 border-t border-gray-200">

              <span>
                Total
              </span>

              <span>
                {formatINR(total)}
              </span>

            </div>

          </div>

          {/* PAYMENT */}

          <div className="mt-4">

            <p className="text-xs font-medium text-gray-500 mb-1.5">
              Payment Method
            </p>

            <div className="grid grid-cols-3 gap-2">

              {[
                "Cash",
                "UPI",
                "Card",
              ].map((m) => {

                const Icon =
                  paymentIcons[m];

                const active =
                  payment === m;

                return (
                  <button
                    key={m}
                    onClick={() =>
                      setPayment(m)
                    }
                    className={`flex flex-col items-center gap-1 py-2 rounded-md border text-xs font-medium transition-colors ${
                      active
                        ? "border-green-600 bg-green-50 text-green-700"
                        : "border-gray-200 text-gray-500 hover:bg-gray-50"
                    }`}
                  >
                    <Icon size={15} />
                    {m}
                  </button>
                );
              })}

            </div>

          </div>

          {/* ACTIONS */}

          <div className="grid grid-cols-2 gap-2 mt-4">

            <DangerButton
              onClick={() =>
                cart.length
                  ? setConfirmClear(
                      true
                    )
                  : null
              }
              disabled={
                cart.length === 0 ||
                processingSale
              }
            >
              Clear Bill
            </DangerButton>

            <SecondaryButton
              onClick={holdBill}
              disabled={
                cart.length === 0 ||
                processingSale
              }
            >
              Hold Bill
            </SecondaryButton>

          </div>

          <PrimaryButton
            className="w-full mt-2"
            onClick={
              completeSaleClick
            }
            disabled={
              cart.length === 0 ||
              processingSale
            }
          >
            {processingSale
              ? "Completing Sale..."
              : "Complete Sale"}
          </PrimaryButton>

        </Card>

      </div>

      {/* CLEAR BILL MODAL */}

      <Modal
        open={confirmClear}
        onClose={() =>
          setConfirmClear(false)
        }
        title="Clear this bill?"
        width="max-w-sm"
      >

        <p className="text-sm text-gray-500">
          This will remove all
          items from the current
          bill. This can't be
          undone.
        </p>

        <div className="flex gap-2 mt-5">

          <SecondaryButton
            className="flex-1"
            onClick={() =>
              setConfirmClear(false)
            }
          >
            Cancel
          </SecondaryButton>

          <DangerButton
            className="flex-1 !text-red-600 !border-red-300"
            onClick={clearBill}
          >
            Clear Bill
          </DangerButton>

        </div>

      </Modal>

      {/* SUCCESS MODAL */}

      {successSale && (

        <Modal
          open={!!successSale}
          onClose={() =>
            setSuccessSale(null)
          }
          title=""
          width="max-w-sm"
        >

          <div className="text-center">

            <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-3">

              <CheckCircle2
                size={24}
                className="text-green-600"
              />

            </div>

            <p className="text-base font-semibold text-gray-900">
              Sale Completed
            </p>

            <p className="text-sm text-gray-400 mt-0.5">
              Invoice #
              {
                successSale.invoiceNumber
              }
            </p>

            <p className="text-2xl font-semibold text-gray-900 mt-3">
              {formatINR(
                successSale.total
              )}
            </p>

            <div className="flex gap-2 mt-6">

              <SecondaryButton
                className="flex-1"
                onClick={handleDownloadInvoice}
                disabled={downloadingInvoice}
              >
                <Download
                  size={15}
                />
                {downloadingInvoice ? "Preparing PDF…" : "Download Invoice PDF"}
              </SecondaryButton>

              <PrimaryButton
                className="flex-1"
                onClick={() =>
                  setSuccessSale(
                    null
                  )
                }
              >
                New Bill
              </PrimaryButton>

            </div>

          </div>

        </Modal>

      )}

      <PrintableInvoice sale={successSale} settings={settings} customers={customers} />

    </div>
  );
}

/* --------------------------------- products ------------------------------------ */

function ProductFormFields({ form, setForm }) {
  return (
    <>
      <Field label="Product Name">
        <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. MuscleBlaze Whey 1kg" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Brand">
          <input className={inputClass} value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} placeholder="e.g. MuscleBlaze" />
        </Field>
        <Field label="Category">
          <input className={inputClass} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. Protein" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Purchase Price (₹)">
          <input type="number" className={inputClass} value={form.purchasePrice} onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })} />
        </Field>
        <Field label="Selling Price (₹)">
          <input type="number" className={inputClass} value={form.sellingPrice} onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {form.showInitialStock && (
          <Field label="Initial Stock">
            <input type="number" className={inputClass} value={form.initialStock} onChange={(e) => setForm({ ...form, initialStock: e.target.value })} />
          </Field>
        )}
        <Field label="Low Stock Limit">
          <input type="number" className={inputClass} value={form.lowStockLimit} onChange={(e) => setForm({ ...form, lowStockLimit: e.target.value })} />
        </Field>
      </div>
      <Field label="Reorder Days">
        <input
          type="number"
          min="0"
          className={inputClass}
          value={form.reorderDays}
          onChange={(e) => setForm({ ...form, reorderDays: e.target.value })}
          placeholder="e.g. 25 (servings in the tub)"
        />
        <p className="text-xs text-gray-400 mt-1">
          Customers who buy this product become "Due for Reorder" this many days after their purchase. Leave blank to skip reorder tracking for this product.
        </p>
      </Field>
    </>
  );
}

const emptyProductForm = { name: "", brand: "", category: "", purchasePrice: "", sellingPrice: "", initialStock: "", lowStockLimit: "5", reorderDays: "", showInitialStock: true };

function Products({ role }) {
  const { products, addProduct, editProduct } = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyProductForm);

  const filtered = useMemo(() => {
    let list = products;
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q) || p.brand.toLowerCase().includes(q));
    if (filter !== "All") list = list.filter((p) => statusOf(p) === filter);
    return list;
  }, [products, query, filter]);

  function openAdd() {
    setForm(emptyProductForm);
    setAddOpen(true);
  }
  function submitAdd() {
    if (!form.name.trim()) return;
    addProduct(form);
    setAddOpen(false);
  }
  function openEdit(p) {
    setEditing(p);
    setForm({
      name: p.name,
      brand: p.brand,
      category: p.category,
      purchasePrice: p.purchasePrice,
      sellingPrice: p.sellingPrice,
      lowStockLimit: p.lowStockLimit,
      reorderDays: p.reorderDays === null || p.reorderDays === undefined ? "" : p.reorderDays,
      initialStock: "",
      showInitialStock: false,
    });
  }
  function submitEdit() {
    editProduct(editing.id, form);
    setEditing(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Products</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage all products in your store.</p>
        </div>
        {role === "owner" && (
          <PrimaryButton onClick={openAdd}>
            <Plus size={15} /> Add Product
          </PrimaryButton>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className={inputClass + " pl-9"} placeholder="Search products..." value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="flex gap-1.5">
          {["All", "In Stock", "Low Stock", "Out of Stock"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${filter === f ? "bg-green-600 border-green-600 text-white" : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
                }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-2.5 font-medium">Product</th>
                <th className="px-4 py-2.5 font-medium">Brand</th>
                <th className="px-4 py-2.5 font-medium">Category</th>
                <th className="px-4 py-2.5 font-medium text-right">Purchase Price</th>
                <th className="px-4 py-2.5 font-medium text-right">Selling Price</th>
                <th className="px-4 py-2.5 font-medium text-right">Stock</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                {role === "owner" && <th className="px-4 py-2.5 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{p.name}</td>
                  <td className="px-4 py-3 text-gray-500">{p.brand}</td>
                  <td className="px-4 py-3 text-gray-500">{p.category}</td>
                  <td className="px-4 py-3 text-right text-gray-500">{formatINR(p.purchasePrice)}</td>
                  <td className="px-4 py-3 text-right text-gray-800 font-medium">{formatINR(p.sellingPrice)}</td>
                  <td className="px-4 py-3 text-right text-gray-800">{p.stock}</td>
                  <td className="px-4 py-3">
                    <Badge className={statusClasses(statusOf(p))}>{statusOf(p)}</Badge>
                  </td>
                  {role === "owner" && (
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => openEdit(p)} className="text-gray-400 hover:text-green-600">
                        <Pencil size={15} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && <EmptyState icon={Package} title="No products found" subtitle="Try adjusting your search or filter." />}
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Product">
        <ProductFormFields form={form} setForm={setForm} />
        <div className="flex gap-2 mt-2">
          <SecondaryButton className="flex-1" onClick={() => setAddOpen(false)}>
            Cancel
          </SecondaryButton>
          <PrimaryButton className="flex-1" onClick={submitAdd}>
            Add Product
          </PrimaryButton>
        </div>
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit Product">
        <ProductFormFields form={form} setForm={setForm} />
        <div className="flex gap-2 mt-2">
          <SecondaryButton className="flex-1" onClick={() => setEditing(null)}>
            Cancel
          </SecondaryButton>
          <PrimaryButton className="flex-1" onClick={submitEdit}>
            Save Changes
          </PrimaryButton>
        </div>
      </Modal>
    </div>
  );
}

/* ----------------------------------- stock -------------------------------------- */

function Stock() {
  const { products, movements, addStock, adjustStock } = useStore();
  const [addingFor, setAddingFor] = useState(null);
  const [adjustingFor, setAdjustingFor] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);
  const [addForm, setAddForm] = useState({ quantity: "", purchasePrice: "", supplier: "", note: "" });
  const [adjustForm, setAdjustForm] = useState({ amount: "", reason: "" });

  const totalUnits = products.reduce((s, p) => s + p.stock, 0);
  const lowCount = products.filter((p) => p.stock > 0 && p.stock <= p.lowStockLimit).length;
  const outCount = products.filter((p) => p.stock === 0).length;

  function lastUpdated(productId) {
    const list = movements.filter((m) => m.productId === productId).sort((a, b) => (b.dateISO + b.time).localeCompare(a.dateISO + a.time));
    if (list.length === 0) return "—";
    return todayLabel(list[0].dateISO);
  }

  function openAdd(p) {
    setAddingFor(p);
    setAddForm({ quantity: "", purchasePrice: p.purchasePrice, supplier: "", note: "Monthly stock received" });
  }
  function submitAdd() {
    const qty = Number(addForm.quantity);
    if (!qty || qty <= 0) return;
    addStock(addingFor.id, qty, addForm.purchasePrice, addForm.supplier, addForm.note);
    setAddingFor(null);
  }

  function openAdjust(p) {
    setAdjustingFor(p);
    setAdjustForm({ amount: "", reason: "Physical stock correction" });
  }
  function submitAdjust() {
    const amount = Number(adjustForm.amount);
    if (!amount) return;
    adjustStock(adjustingFor.id, amount, adjustForm.reason);
    setAdjustingFor(null);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Stock Management</h1>
        <p className="text-sm text-gray-500 mt-0.5">Track and update your store inventory.</p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Total Stock Units" value={totalUnits} icon={Boxes} tone="green" />
        <KpiCard label="Low Stock" value={lowCount} icon={AlertTriangle} tone="amber" />
        <KpiCard label="Out of Stock" value={outCount} icon={XCircle} tone="red" />
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-2.5 font-medium">Product</th>
                <th className="px-4 py-2.5 font-medium text-right">Current Stock</th>
                <th className="px-4 py-2.5 font-medium text-right">Low Stock Limit</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Last Updated</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{p.name}</td>
                  <td className="px-4 py-3 text-right text-gray-800">{p.stock}</td>
                  <td className="px-4 py-3 text-right text-gray-500">{p.lowStockLimit}</td>
                  <td className="px-4 py-3">
                    <Badge className={statusClasses(statusOf(p))}>{statusOf(p)}</Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{lastUpdated(p.id)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-3 text-xs font-medium">
                      <button onClick={() => openAdd(p)} className="text-green-600 hover:text-green-700 flex items-center gap-1">
                        <PackagePlus size={13} /> Add Stock
                      </button>
                      <button onClick={() => setHistoryFor(p)} className="text-gray-500 hover:text-gray-700 flex items-center gap-1">
                        <History size={13} /> History
                      </button>
                      <button onClick={() => openAdjust(p)} className="text-gray-500 hover:text-gray-700 flex items-center gap-1">
                        <SlidersHorizontal size={13} /> Adjust
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={!!addingFor} onClose={() => setAddingFor(null)} title="Add Stock">
        {addingFor && (
          <>
            <Field label="Product">
              <p className="text-sm font-medium text-gray-800">{addingFor.name}</p>
            </Field>
            <Field label="Current Stock">
              <p className="text-sm text-gray-500">{addingFor.stock}</p>
            </Field>
            <Field label="Quantity to Add">
              <input type="number" className={inputClass} value={addForm.quantity} onChange={(e) => setAddForm({ ...addForm, quantity: e.target.value })} placeholder="e.g. 20" />
            </Field>
            <Field label="Purchase Price (₹)">
              <input type="number" className={inputClass} value={addForm.purchasePrice} onChange={(e) => setAddForm({ ...addForm, purchasePrice: e.target.value })} />
            </Field>
            <Field label="Supplier" hint="Optional">
              <input className={inputClass} value={addForm.supplier} onChange={(e) => setAddForm({ ...addForm, supplier: e.target.value })} placeholder="Optional" />
            </Field>
            <Field label="Note">
              <input className={inputClass} value={addForm.note} onChange={(e) => setAddForm({ ...addForm, note: e.target.value })} placeholder="e.g. Monthly stock received" />
            </Field>
            {Number(addForm.quantity) > 0 && (
              <p className="text-xs text-gray-400 mb-3">
                {addingFor.stock} + {Number(addForm.quantity)} = <span className="font-medium text-green-600">{addingFor.stock + Number(addForm.quantity)}</span>
              </p>
            )}
            <PrimaryButton className="w-full" onClick={submitAdd} disabled={!addForm.quantity || Number(addForm.quantity) <= 0}>
              Add Stock
            </PrimaryButton>
          </>
        )}
      </Modal>

      <Modal open={!!adjustingFor} onClose={() => setAdjustingFor(null)} title="Adjust Stock" width="max-w-sm">
        {adjustingFor && (
          <>
            <Field label="Current Stock">
              <p className="text-sm text-gray-500">{adjustingFor.stock}</p>
            </Field>
            <Field label="Adjustment" hint="Use a negative number to reduce stock, positive to increase.">
              <input type="number" className={inputClass} value={adjustForm.amount} onChange={(e) => setAdjustForm({ ...adjustForm, amount: e.target.value })} placeholder="e.g. -2" />
            </Field>
            <Field label="Reason">
              <input className={inputClass} value={adjustForm.reason} onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })} placeholder="e.g. Physical stock correction" />
            </Field>
            {adjustForm.amount && Number(adjustForm.amount) !== 0 && (
              <p className="text-xs text-gray-400 mb-3">
                {adjustingFor.stock} → <span className={`font-medium ${Number(adjustForm.amount) < 0 ? "text-red-600" : "text-green-600"}`}>{Math.max(0, adjustingFor.stock + Number(adjustForm.amount))}</span>
              </p>
            )}
            <div className="flex gap-2">
              <SecondaryButton className="flex-1" onClick={() => setAdjustingFor(null)}>
                Cancel
              </SecondaryButton>
              <PrimaryButton className="flex-1" onClick={submitAdjust} disabled={!adjustForm.amount || Number(adjustForm.amount) === 0}>
                Confirm Adjustment
              </PrimaryButton>
            </div>
          </>
        )}
      </Modal>

      <Modal open={!!historyFor} onClose={() => setHistoryFor(null)} title={historyFor ? historyFor.name.toUpperCase() : ""}>
        {historyFor && (
          <>
            <div className="flex items-center justify-between bg-gray-50 rounded-md px-4 py-3 mb-4">
              <span className="text-sm text-gray-500">Current Stock</span>
              <span className="text-lg font-semibold text-gray-900">{historyFor.stock} Units</span>
            </div>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {movements
                .filter((m) => m.productId === historyFor.id)
                .sort((a, b) => (b.dateISO + b.time).localeCompare(a.dateISO + a.time))
                .map((m) => (
                  <div key={m.id} className="flex items-start justify-between border-b border-gray-50 last:border-0 pb-3">
                    <div>
                      <p className="text-xs text-gray-400">{formatDateShort(m.dateISO)} · {m.time}</p>
                      <p className="text-sm text-gray-800 font-medium mt-0.5">{m.type}</p>
                      <p className="text-xs text-gray-400">{m.reference ? `Invoice #${m.reference}`.replace("Invoice #Supplier", "Supplier") : m.reason || "—"}</p>
                    </div>
                    <span className={`text-sm font-semibold ${m.quantity < 0 ? "text-red-600" : "text-green-600"}`}>
                      {m.quantity > 0 ? "+" : ""}
                      {m.quantity}
                    </span>
                  </div>
                ))}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

/* ----------------------------------- sales -------------------------------------- */

function Sales({ openInvoice }) {
  const { sales, customers } = useStore();
  const [filter, setFilter] = useState("Today");
  const [customDate, setCustomDate] = useState(TODAY_ISO);

  const filtered = useMemo(() => {
    const today = parseISO(TODAY_ISO);
    return [...sales]
      .filter((s) => {
        if (filter === "Today") return s.dateISO === TODAY_ISO;
        if (filter === "This Week") {
          const diff = Math.round((today - parseISO(s.dateISO)) / 86400000);
          return diff >= 0 && diff < 7;
        }
        if (filter === "This Month") return s.dateISO.slice(0, 7) === TODAY_ISO.slice(0, 7);
        if (filter === "Custom Date") return s.dateISO === customDate;
        return true;
      })
      .sort((a, b) => (b.dateISO + b.time).localeCompare(a.dateISO + a.time));
  }, [sales, filter, customDate]);

  const totalAmount = filtered.reduce((s, x) => s + x.total, 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Sales</h1>
        <p className="text-sm text-gray-500 mt-0.5">View all completed transactions.</p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {["Today", "This Week", "This Month", "Custom Date"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${filter === f ? "bg-green-600 border-green-600 text-white" : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
              }`}
          >
            {f}
          </button>
        ))}
        {filter === "Custom Date" && (
          <input type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)} className="border border-gray-300 rounded-md px-2.5 py-1.5 text-xs" />
        )}
        <span className="ml-auto text-sm text-gray-500">
          {filtered.length} bills · <span className="font-semibold text-gray-800">{formatINR(totalAmount)}</span>
        </span>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-2.5 font-medium">Invoice</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Time</th>
                <th className="px-4 py-2.5 font-medium text-right">Items</th>
                <th className="px-4 py-2.5 font-medium">Payment</th>
                <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} onClick={() => openInvoice(s)} className="border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer">
                  <td className="px-4 py-3 font-medium text-gray-800">{s.invoiceNumber}</td>
                  <td className="px-4 py-3 text-gray-500">{customerLabel(customers, s.customerId)}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDateShort(s.dateISO)}</td>
                  <td className="px-4 py-3 text-gray-500">{s.time}</td>
                  <td className="px-4 py-3 text-right text-gray-500">{s.items.reduce((a, i) => a + i.qty, 0)}</td>
                  <td className="px-4 py-3 text-gray-500">{s.paymentMethod}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">{formatINR(s.total)}</td>
                  <td className="px-4 py-3">
                    <Badge className="bg-green-50 text-green-700 border border-green-200">{s.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && <EmptyState icon={Receipt} title="No sales found" subtitle="There are no transactions for this filter." />}
      </Card>
    </div>
  );
}

/* --------------------------------- calendar -------------------------------------- */

function SalesCalendar({ openInvoice }) {
  const { sales, products, customers } = useStore();
  const [viewDate, setViewDate] = useState(parseISO(TODAY_ISO));
  const [selectedISO, setSelectedISO] = useState(TODAY_ISO);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startWeekday = firstDay.getDay();

  const salesByDate = useMemo(() => {
    const map = {};
    sales.forEach((s) => {
      if (!map[s.dateISO]) map[s.dateISO] = [];
      map[s.dateISO].push(s);
    });
    return map;
  }, [sales]);

  function isoFor(day) {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const selectedSales = salesByDate[selectedISO] || [];
  const selectedTotal = selectedSales.reduce((s, x) => s + x.total, 0);
  const selectedItems = selectedSales.reduce((s, x) => s + x.items.reduce((a, i) => a + i.qty, 0), 0);
  const selectedProfit = selectedSales.reduce((sum, sale) => {
    return (
      sum +
      sale.items.reduce((s, it) => {
        const prod = products.find((p) => p.id === it.productId);
        const cost = prod ? prod.purchasePrice : 0;
        return s + (it.price - cost) * it.qty;
      }, 0)
    );
  }, 0);

  const selectedCustomerCount = new Set(selectedSales.filter((s) => s.customerId).map((s) => s.customerId)).size;

  const paymentSummary = { Cash: 0, UPI: 0, Card: 0 };
  selectedSales.forEach((s) => (paymentSummary[s.paymentMethod] += s.total));

  const productsSold = useMemo(() => {
    const map = {};
    selectedSales.forEach((s) =>
      s.items.forEach((it) => {
        map[it.name] = (map[it.name] || 0) + it.qty;
      })
    );
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [selectedSales]);

  const monthLabel = viewDate.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Sales Calendar</h1>
        <p className="text-sm text-gray-500 mt-0.5">Select any date to see exactly how much the store sold.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
        <Card className="p-4 lg:col-span-3">
          <div className="flex items-center justify-between mb-4">
            <button onClick={() => setViewDate(new Date(year, month - 1, 1))} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500">
              <ChevronLeft size={16} />
            </button>
            <p className="text-sm font-semibold text-gray-900 uppercase tracking-wide">{monthLabel}</p>
            <button onClick={() => setViewDate(new Date(year, month + 1, 1))} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500">
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="flex justify-end mb-2">
            <button
              onClick={() => {
                setViewDate(parseISO(TODAY_ISO));
                setSelectedISO(TODAY_ISO);
              }}
              className="text-xs font-medium text-green-600 hover:text-green-700"
            >
              Today
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1.5 text-center mb-1.5">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <p key={d} className="text-xs font-medium text-gray-400 py-1">
                {d}
              </p>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {cells.map((day, idx) => {
              if (day === null) return <div key={idx} />;
              const iso = isoFor(day);
              const daySales = salesByDate[iso];
              const dayTotal = daySales ? daySales.reduce((s, x) => s + x.total, 0) : 0;
              const isSelected = iso === selectedISO;
              const isToday = iso === TODAY_ISO;
              return (
                <button
                  key={idx}
                  onClick={() => setSelectedISO(iso)}
                  className={`aspect-square rounded-md border p-1.5 flex flex-col items-center justify-center text-center transition-colors ${isSelected ? "border-green-600 bg-green-50" : daySales ? "border-green-100 bg-green-50/40 hover:border-green-300" : "border-gray-100 hover:bg-gray-50"
                    }`}
                >
                  <span className={`text-xs font-medium ${isToday ? "text-green-700 font-bold" : "text-gray-700"}`}>{day}</span>
                  {daySales && (
                    <>
                      <span className="text-[10px] font-semibold text-green-700 leading-tight mt-0.5">{formatCompactINR(dayTotal)}</span>
                      <span className="text-[9px] text-gray-400 leading-tight">{daySales.length} bills</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </Card>

        <div className="lg:col-span-2 space-y-4">
          <Card className="p-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{formatDateLong(selectedISO)}</p>
            {selectedSales.length === 0 ? (
              <EmptyState icon={CalendarIcon} title="No Sales Recorded" subtitle={`There were no sales on ${formatDateShort(selectedISO)}.`} />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div>
                    <p className="text-xs text-gray-400">Total Sales</p>
                    <p className="text-lg font-semibold text-gray-900">{formatINR(selectedTotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Bills</p>
                    <p className="text-lg font-semibold text-gray-900">{selectedSales.length}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Customers</p>
                    <p className="text-lg font-semibold text-gray-900">{selectedCustomerCount}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Items Sold</p>
                    <p className="text-lg font-semibold text-gray-900">{selectedItems}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Estimated Profit</p>
                    <p className="text-lg font-semibold text-green-700">{formatINR(selectedProfit)}</p>
                  </div>
                </div>

                <p className="text-xs font-semibold text-gray-600 mb-2">Payment Summary</p>
                <div className="space-y-1 text-sm mb-4">
                  {["Cash", "UPI", "Card"].map((m) => (
                    <div key={m} className="flex justify-between text-gray-500">
                      <span>{m}</span>
                      <span className="text-gray-800">{formatINR(paymentSummary[m])}</span>
                    </div>
                  ))}
                  <div className="flex justify-between font-semibold text-gray-900 pt-1.5 border-t border-gray-100">
                    <span>Total</span>
                    <span>{formatINR(selectedTotal)}</span>
                  </div>
                </div>

                <p className="text-xs font-semibold text-gray-600 mb-2">Products Sold</p>
                <div className="space-y-1 text-sm mb-1">
                  {productsSold.map(([name, qty]) => (
                    <div key={name} className="flex justify-between text-gray-500">
                      <span className="truncate pr-2">{name}</span>
                      <span className="text-gray-800 shrink-0">{qty} units</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>

          {selectedSales.length > 0 && (
            <Card className="p-4">
              <p className="text-xs font-semibold text-gray-600 mb-2">Sales on This Date</p>
              <div className="space-y-2">
                {selectedSales.map((s) => (
                  <button key={s.id} onClick={() => openInvoice(s)} className="w-full flex items-center justify-between text-sm hover:bg-gray-50 rounded-md px-2 py-1.5 -mx-2">
                    <div className="text-left">
                      <p className="font-medium text-gray-800">
                        {s.invoiceNumber} <span className="font-normal text-gray-400">· {customerLabel(customers, s.customerId)}</span>
                      </p>
                      <p className="text-xs text-gray-400">
                        {s.time} · {s.items.reduce((a, i) => a + i.qty, 0)} items · {s.paymentMethod}
                      </p>
                    </div>
                    <span className="font-medium text-green-700">{formatINR(s.total)}</span>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- reports -------------------------------------- */

function Reports() {
  const { sales, products, customers, opportunityState } = useStore();

  const todayTotal = sales.filter((s) => s.dateISO === TODAY_ISO).reduce((s, x) => s + x.total, 0);
  const weekTotal = sales
    .filter((s) => {
      const diff = Math.round((parseISO(TODAY_ISO) - parseISO(s.dateISO)) / 86400000);
      return diff >= 0 && diff < 7;
    })
    .reduce((s, x) => s + x.total, 0);
  const monthSales = sales.filter((s) => s.dateISO.slice(0, 7) === TODAY_ISO.slice(0, 7));
  const monthTotal = monthSales.reduce((s, x) => s + x.total, 0);

  const bestSellers = useMemo(() => {
    const map = {};
    sales.forEach((s) => s.items.forEach((it) => (map[it.name] = (map[it.name] || 0) + it.qty)));
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [sales]);

  const estimatedCost = monthSales.reduce((sum, sale) => {
    return (
      sum +
      sale.items.reduce((s, it) => {
        const prod = products.find((p) => p.id === it.productId);
        return s + (prod ? prod.purchasePrice : 0) * it.qty;
      }, 0)
    );
  }, 0);
  const estimatedProfit = monthTotal - estimatedCost;

  const customerStatsAll = useMemo(() => customers.map((c) => ({ c, stats: customerStats(sales, c.id) })), [customers, sales]);
  const returningCustomers = customerStatsAll.filter((x) => x.stats.totalPurchases >= 2);
  const newThisMonth = customers.filter((c) => c.createdAt.slice(0, 7) === TODAY_ISO.slice(0, 7)).length;
  const opportunities = useMemo(() => computeOpportunities(customers, sales, products, opportunityState), [customers, sales, products, opportunityState]);
  const avgCustomerSpend = customerStatsAll.length
    ? Math.round(customerStatsAll.reduce((s, x) => s + x.stats.totalSpent, 0) / customerStatsAll.length)
    : 0;
  const avgReturningSpend = returningCustomers.length
    ? Math.round(returningCustomers.reduce((s, x) => s + x.stats.totalSpent, 0) / returningCustomers.length)
    : 0;
  const topCustomerSpend = customerStatsAll.reduce((max, x) => Math.max(max, x.stats.totalSpent), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Reports</h1>
        <p className="text-sm text-gray-500 mt-0.5">A simple overview of how your store is performing.</p>
      </div>

      <Card className="p-4">
        <p className="text-sm font-semibold text-gray-900 mb-4">Sales Summary</p>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-gray-400">Today</p>
            <p className="text-xl font-semibold text-gray-900 mt-0.5">{formatINR(todayTotal)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">This Week</p>
            <p className="text-xl font-semibold text-gray-900 mt-0.5">{formatINR(weekTotal)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">This Month</p>
            <p className="text-xl font-semibold text-gray-900 mt-0.5">{formatINR(monthTotal)}</p>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-4">
          <p className="text-sm font-semibold text-gray-900 mb-4">Best Selling Products</p>
          <div className="space-y-3">
            {bestSellers.map(([name, qty], idx) => (
              <div key={name} className="flex items-center gap-3">
                <span className="w-6 h-6 rounded-md bg-green-50 text-green-700 text-xs font-semibold flex items-center justify-center shrink-0">{idx + 1}</span>
                <span className="text-sm text-gray-800 flex-1">{name}</span>
                <span className="text-sm text-gray-500">{qty} units</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <p className="text-sm font-semibold text-gray-900 mb-1">Estimated Profit</p>
          <p className="text-xs text-gray-400 mb-4">This month, based on selling price minus purchase price.</p>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-gray-500">
              <span>Sales Revenue</span>
              <span className="text-gray-800 font-medium">{formatINR(monthTotal)}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>Estimated Cost</span>
              <span className="text-gray-800 font-medium">{formatINR(estimatedCost)}</span>
            </div>
            <div className="flex justify-between text-base font-semibold text-gray-900 pt-2 border-t border-gray-100">
              <span>Estimated Profit</span>
              <span className="text-green-700">{formatINR(estimatedProfit)}</span>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-4">
          <p className="text-sm font-semibold text-gray-900 mb-4">Customer Insights</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-400">Total Customers</p>
              <p className="text-xl font-semibold text-gray-900 mt-0.5">{customers.length}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Returning Customers</p>
              <p className="text-xl font-semibold text-gray-900 mt-0.5">{returningCustomers.length}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">New Customers This Month</p>
              <p className="text-xl font-semibold text-gray-900 mt-0.5">{newThisMonth}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Due for Reorder</p>
              <p className="text-xl font-semibold text-amber-600 mt-0.5">{opportunities.due.length}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Going Cold</p>
              <p className="text-xl font-semibold text-red-600 mt-0.5">{opportunities.cold.length}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <p className="text-sm font-semibold text-gray-900 mb-1">Customer Revenue Metrics</p>
          <p className="text-xs text-gray-400 mb-4">Based on all recorded customer purchases.</p>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-gray-500">
              <span>Average Customer Spend</span>
              <span className="text-gray-800 font-medium">{formatINR(avgCustomerSpend)}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>Returning Customer Spend</span>
              <span className="text-gray-800 font-medium">{formatINR(avgReturningSpend)}</span>
            </div>
            <div className="flex justify-between text-base font-semibold text-gray-900 pt-2 border-t border-gray-100">
              <span>Top Customer</span>
              <span className="text-green-700">{formatINR(topCustomerSpend)}</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* --------------------------------- settings -------------------------------------- */

function Settings({ role }) {
  const { settings, saveSettings } = useStore();
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await saveSettings(form);
    setSaving(false);
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Manage your store details and preferences.</p>
      </div>

      <Card className="p-5">
        <p className="text-sm font-semibold text-gray-900 mb-4">Store Information</p>
        <Field label="Store Name">
          <input className={inputClass} value={form.storeName} onChange={(e) => setForm({ ...form, storeName: e.target.value })} />
        </Field>
        <Field label="Address">
          <input className={inputClass} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone">
            <input className={inputClass} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="GST Number" hint="Optional">
            <input className={inputClass} value={form.gst} onChange={(e) => setForm({ ...form, gst: e.target.value })} placeholder="Optional" />
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <p className="text-sm font-semibold text-gray-900 mb-4">Invoice Settings</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Invoice Prefix">
            <input className={inputClass} value={form.invoicePrefix} onChange={(e) => setForm({ ...form, invoicePrefix: e.target.value })} />
          </Field>
          <Field label="Default Payment Method">
            <select className={inputClass} value={form.defaultPayment} onChange={(e) => setForm({ ...form, defaultPayment: e.target.value })}>
              <option>Cash</option>
              <option>UPI</option>
              <option>Card</option>
            </select>
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <p className="text-sm font-semibold text-gray-900 mb-4">User Settings</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className={inputClass} value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
          </Field>
          <Field label="Role">
            <p className="border border-gray-200 bg-gray-50 rounded-md px-3 py-2 text-sm text-gray-500 capitalize">{role}</p>
          </Field>
        </div>
      </Card>

      <PrimaryButton onClick={save} disabled={saving}>
        {saving ? "Saving..." : "Save Changes"}
      </PrimaryButton>
    </div>
  );
}

/* --------------------------------- customers -------------------------------------- */

function CustomersPage({ openCustomer, initialFilter }) {
  const { customers, sales, products, opportunityState } = useStore();
  const [query, setQuery] = useState("");
  const opportunities = useMemo(() => computeOpportunities(customers, sales, products, opportunityState), [customers, sales, products, opportunityState]);
  const productsById = useMemo(() => new Map((products || []).map((p) => [String(p.id), p])), [products]);

  const dueIds = new Set(opportunities.due.map((o) => o.customer.id));
  const coldIds = new Set(opportunities.cold.map((o) => o.customer.id));
  const followupIds = new Set(opportunities.followups.map((o) => o.customer.id));

  const rows = useMemo(() => {
    return customers
      .map((c) => {
        const stats = customerStats(sales, c.id);
        const pattern = reorderPattern(sales, c.id);
        const status = reorderStatusFor(pattern);
        const lifecycle = customerLifecycleStage(sales, c.id, productsById);
        return { ...c, stats, segment: customerSegment(stats, status, lifecycle?.stage) };
      })
      .filter((c) => {
        const q = query.trim().toLowerCase();
        if (!q) return true;
        const qDigits = q.replace(/\D/g, "");
        const nameMatch = c.name.toLowerCase().includes(q);
        const phoneMatch = qDigits.length > 0 && normalizePhoneDigits(c.phone).includes(qDigits);
        return nameMatch || phoneMatch;
      })
      .filter((c) => {
        if (!initialFilter) return true;
        if (initialFilter === "due") return dueIds.has(c.id);
        if (initialFilter === "cold") return coldIds.has(c.id);
        if (initialFilter === "followup") return followupIds.has(c.id);
        return true;
      })
      .sort((a, b) => (b.stats.lastPurchaseDate || "").localeCompare(a.stats.lastPurchaseDate || ""));
  }, [customers, sales, query, initialFilter, productsById]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Customers</h1>
        <p className="text-sm text-gray-500 mt-0.5">Your customer directory, built automatically from billing.</p>
      </div>

      {initialFilter && (
        <Badge className="bg-green-50 text-green-700 border border-green-200">
          Filtered: {initialFilter === "due" ? "Due for Reorder" : initialFilter === "cold" ? "Going Cold" : "Follow-ups Today"}
        </Badge>
      )}

      <div className="relative max-w-sm">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input className={inputClass + " pl-9"} placeholder="Search customer or phone number..." value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium">Phone</th>
                <th className="px-4 py-2.5 font-medium">Segment</th>
                <th className="px-4 py-2.5 font-medium">Last Purchase</th>
                <th className="px-4 py-2.5 font-medium text-right">Total Spent</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} onClick={() => openCustomer(c.id)} className="border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer">
                  <td className="px-4 py-3 font-medium text-gray-800">{c.name}</td>
                  <td className="px-4 py-3 text-gray-500">{maskPhone(c.phone)}</td>
                  <td className="px-4 py-3">
                    <Badge className={segmentClasses(c.segment)}>{c.segment}</Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{c.stats.lastPurchaseDate ? formatDateShort(c.stats.lastPurchaseDate) : "—"}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">{formatINR(c.stats.totalSpent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <EmptyState icon={Users} title="No customers found" subtitle="Try a different search or filter." />}
      </Card>
    </div>
  );
}

function CustomerProfileModal({ customerId, onClose, openInvoice, openContact }) {
  const { customers, sales, products } = useStore();
  const customer = customers.find((c) => c.id === customerId);
  if (!customer) return null;

  const stats = customerStats(sales, customerId);
  const pattern = reorderPattern(sales, customerId);
  const status = reorderStatusFor(pattern);
  const productsById = new Map((products || []).map((p) => [String(p.id), p]));
  const lifecycle = customerLifecycleStage(sales, customerId, productsById);
  const segment = customerSegment(stats, status, lifecycle?.stage);

  const historyLines = [];
  customerSalesOf(sales, customerId)
    .slice()
    .reverse()
    .forEach((sale) => {
      sale.items.forEach((it) => {
        historyLines.push({ dateISO: sale.dateISO, name: it.name, amount: it.total, sale });
      });
    });

  return (
    <Modal open={!!customerId} onClose={onClose} title={customer.name.toUpperCase()}>
      <div className="flex items-center justify-between mb-4">
        <Badge className={segmentClasses(segment)}>{segment}</Badge>
        {openContact && (
          <SecondaryButton onClick={() => openContact(customer.id)} className="!px-3 !py-1.5 !text-xs">
            <Phone size={12} /> Contact
          </SecondaryButton>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <p className="text-xs text-gray-400">Phone</p>
          <p className="text-sm font-medium text-gray-900 mt-0.5">{maskPhone(customer.phone)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Customer Since</p>
          <p className="text-sm font-medium text-gray-900 mt-0.5">{formatDateShort(customer.createdAt)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Total Purchases</p>
          <p className="text-sm font-medium text-gray-900 mt-0.5">{stats.totalPurchases}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Total Spent</p>
          <p className="text-sm font-medium text-gray-900 mt-0.5">{formatINR(stats.totalSpent)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Last Purchase</p>
          <p className="text-sm font-medium text-gray-900 mt-0.5">{stats.lastPurchaseDate ? formatDateShort(stats.lastPurchaseDate) : "—"}</p>
        </div>
      </div>

      {pattern && (
        <div className="bg-gray-50 border border-gray-200 rounded-md p-3 mb-4">
          <p className="text-xs font-semibold text-gray-600 mb-2">Reorder Pattern — {pattern.productName}</p>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <p className="text-gray-400">Typical interval</p>
              <p className="text-gray-800 font-medium mt-0.5">~{pattern.avgInterval} days</p>
            </div>
            <div>
              <p className="text-gray-400">Last purchase</p>
              <p className="text-gray-800 font-medium mt-0.5">{formatDateShort(pattern.lastPurchaseDate)}</p>
            </div>
            <div>
              <p className="text-gray-400">Expected next purchase</p>
              <p className="text-gray-800 font-medium mt-0.5">~{formatDateShort(pattern.expectedDate)}</p>
            </div>
          </div>
          {status.category !== "none" && (
            <Badge
              className={`mt-2 ${status.category === "cold" ? "bg-orange-50 text-orange-700 border border-orange-200" : "bg-amber-50 text-amber-700 border border-amber-200"
                }`}
            >
              {status.category === "cold" ? `Going Cold · Overdue ${status.overdueDays} days` : status.label}
            </Badge>
          )}
          <p className="text-[11px] text-gray-400 mt-2">Based only on this customer's own purchase history — not a guarantee.</p>
        </div>
      )}

      <p className="text-xs font-semibold text-gray-600 mb-2">Purchase History</p>
      <div className="space-y-2.5 max-h-64 overflow-y-auto">
        {historyLines.map((line, idx) => (
          <button
            key={idx}
            onClick={() => openInvoice(line.sale)}
            className="w-full flex items-center justify-between text-sm hover:bg-gray-50 rounded-md px-2 py-1.5 -mx-2"
          >
            <div className="text-left">
              <p className="text-gray-800">{line.name}</p>
              <p className="text-xs text-gray-400">{formatDateShort(line.dateISO)}</p>
            </div>
            <span className="font-medium text-gray-900">{formatINR(line.amount)}</span>
          </button>
        ))}
        {historyLines.length === 0 && <p className="text-sm text-gray-400 py-4 text-center">No purchases recorded yet.</p>}
      </div>
    </Modal>
  );
}

const OUTCOME_OPTIONS = ["Purchased", "Will visit later", "Not interested", "No response", "Follow up later"];
const FOLLOWUP_OPTIONS = ["Purchased", "Not interested"]; // no follow-up day picker needed for these

function ContactModal({ customerId, onClose }) {
  const { customers, opportunityState, markContacted, recordOutcome } = useStore();
  const customer = customers.find((c) => c.id === customerId);
  const state = customerId ? opportunityState[customerId] : null;
  const [outcome, setOutcome] = useState(null);
  const [followupDays, setFollowupDays] = useState(7);
  const [customDays, setCustomDays] = useState("");

  useEffect(() => {
    setOutcome(null);
    setFollowupDays(7);
    setCustomDays("");
  }, [customerId]);

  if (!customer) return null;
  const digits = normalizePhoneDigits(customer.phone);
  const alreadyContacted = state && state.status !== "pending" && state.status !== undefined;

  function copyNumber() {
    if (navigator.clipboard) navigator.clipboard.writeText(customer.phone).catch(() => { });
  }

  function saveOutcome() {
    if (!outcome) return;
    if (FOLLOWUP_OPTIONS.includes(outcome)) {
      recordOutcome(customer.id, outcome, null);
    } else {
      const days = followupDays === "custom" ? Number(customDays) || 1 : followupDays;
      recordOutcome(customer.id, outcome, addDaysISO(TODAY_ISO, days));
    }
    onClose();
  }

  return (
    <Modal open={!!customerId} onClose={onClose} title={`Contact ${customer.name}`} width="max-w-sm">
      <div className="mb-4">
        <p className="text-xs text-gray-400">Phone</p>
        <p className="text-sm font-medium text-gray-900 mt-0.5">{customer.phone}</p>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <SecondaryButton onClick={() => window.open(`tel:${digits}`, "_blank")} className="!flex-col !gap-1 !py-2.5">
          <PhoneCall size={15} /> <span className="text-xs">Call</span>
        </SecondaryButton>
        <SecondaryButton onClick={() => window.open(`https://wa.me/91${digits}`, "_blank")} className="!flex-col !gap-1 !py-2.5">
          <MessageCircle size={15} /> <span className="text-xs">WhatsApp</span>
        </SecondaryButton>
        <SecondaryButton onClick={copyNumber} className="!flex-col !gap-1 !py-2.5">
          <Copy size={15} /> <span className="text-xs">Copy</span>
        </SecondaryButton>
      </div>

      {alreadyContacted && state.status === "contacted" && (
        <div className="flex items-center gap-1.5 text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2 mb-4">
          <CheckCircle2 size={13} /> Contacted ✓ {formatDateShort(state.contactedAt)}
        </div>
      )}

      {!alreadyContacted && (
        <PrimaryButton className="w-full mb-4" onClick={() => markContacted(customer.id)}>
          Mark as Contacted
        </PrimaryButton>
      )}

      <p className="text-xs font-semibold text-gray-600 mb-2">Contact Outcome</p>
      <div className="space-y-1.5 mb-3">
        {OUTCOME_OPTIONS.map((opt) => (
          <label key={opt} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="radio" name="outcome" checked={outcome === opt} onChange={() => setOutcome(opt)} className="accent-green-600" />
            {opt}
          </label>
        ))}
      </div>

      {outcome && !FOLLOWUP_OPTIONS.includes(outcome) && (
        <div className="mb-4">
          <p className="text-xs text-gray-500 mb-1.5">Follow up in:</p>
          <div className="flex gap-2">
            {[3, 7].map((d) => (
              <button
                key={d}
                onClick={() => setFollowupDays(d)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium border ${followupDays === d ? "bg-green-600 border-green-600 text-white" : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
                  }`}
              >
                {d} days
              </button>
            ))}
            <button
              onClick={() => setFollowupDays("custom")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border ${followupDays === "custom" ? "bg-green-600 border-green-600 text-white" : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
                }`}
            >
              Custom
            </button>
            {followupDays === "custom" && (
              <input
                type="number"
                min={1}
                value={customDays}
                onChange={(e) => setCustomDays(e.target.value)}
                placeholder="days"
                className="w-16 border border-gray-300 rounded-md px-2 py-1 text-xs"
              />
            )}
          </div>
        </div>
      )}

      <PrimaryButton className="w-full" onClick={saveOutcome} disabled={!outcome}>
        Save Outcome
      </PrimaryButton>
    </Modal>
  );
}

/* ------------------------------------ app ---------------------------------------- */

function AppShell() {
  const [page, setPage] = useState("dashboard");
  const [role, setRole] = useState("owner");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [invoiceSale, setInvoiceSale] = useState(null);
  const [viewingCustomerId, setViewingCustomerId] = useState(null);
  const [contactingCustomerId, setContactingCustomerId] = useState(null);
  const [customersFilter, setCustomersFilter] = useState(null);
  const { settings, dataLoading, dataError } = useStore();
  const loading = dataLoading;

  const allowed = NAV_ITEMS.find((n) => n.id === page)?.roles.includes(role);
  const effectivePage = allowed ? page : "dashboard";

  function goToCustomers(filter) {
    setCustomersFilter(filter);
    setPage("customers");
  }

  function navigate(id) {
    setCustomersFilter(null);
    setPage(id);
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar page={effectivePage} setPage={navigate} role={role} setRole={setRole} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />
      <div className="flex-1 min-w-0">
        <div className="md:hidden flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 sticky top-0 z-30">
          <button onClick={() => setMobileOpen(true)} className="text-gray-500">
            <Menu size={20} />
          </button>
          <p className="text-sm font-semibold text-gray-900">{settings.storeName}</p>
        </div>
        <main className="p-4 md:p-6 max-w-7xl mx-auto">
          {dataError && !loading && (
            <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md px-4 py-3">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>Couldn't load data from Supabase: {dataError}</span>
            </div>
          )}
          {loading ? (
            <div className="space-y-4 animate-pulse">
              <div className="h-6 w-56 bg-gray-200 rounded" />
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-24 bg-gray-200 rounded-lg" />
                ))}
              </div>
              <div className="h-64 bg-gray-200 rounded-lg" />
            </div>
          ) : (
            <>
              {effectivePage === "dashboard" && (
                <Dashboard
                  setPage={navigate}
                  openInvoice={setInvoiceSale}
                  openCustomer={setViewingCustomerId}
                  openContact={setContactingCustomerId}
                  goToCustomers={goToCustomers}
                />
              )}
              {effectivePage === "billing" && <Billing />}
              {effectivePage === "products" && <Products role={role} />}
              {effectivePage === "stock" && <Stock />}
              {effectivePage === "customers" && <CustomersPage openCustomer={setViewingCustomerId} initialFilter={customersFilter} />}
              {effectivePage === "sales" && <Sales openInvoice={setInvoiceSale} />}
              {effectivePage === "calendar" && <SalesCalendar openInvoice={setInvoiceSale} />}
              {effectivePage === "reports" && <Reports />}
              {effectivePage === "settings" && <Settings role={role} />}
            </>
          )}
        </main>
      </div>
      <InvoiceModal sale={invoiceSale} onClose={() => setInvoiceSale(null)} />
      <CustomerProfileModal
        customerId={viewingCustomerId}
        onClose={() => setViewingCustomerId(null)}
        openInvoice={setInvoiceSale}
        openContact={setContactingCustomerId}
      />
      <ContactModal customerId={contactingCustomerId} onClose={() => setContactingCustomerId(null)} />
      <ToastStack />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <AppShell />
    </StoreProvider>
  );
}
