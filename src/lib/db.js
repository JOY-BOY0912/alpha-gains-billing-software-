import { supabase } from "./supabaseClient";

function splitTimestamp(ts) {
  const d = ts ? new Date(ts) : new Date();

  const dateISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;

  let hour = d.getHours();
  const minute = d.getMinutes();

  const ampm = hour < 12 ? "AM" : "PM";

  hour = hour % 12 === 0 ? 12 : hour % 12;

  const time = `${hour}:${String(minute).padStart(2, "0")} ${ampm}`;

  return {
    dateISO,
    time,
  };
}

function shapeSettings(row) {
  return {
    storeName: row.store_name || "",
    address: row.address || "",
    phone: row.phone || "",
    gst: row.gst_number || "",
    invoicePrefix: row.invoice_prefix || "INV",
    defaultPayment: row.default_payment_method || "Cash",
    ownerName: row.owner_name || "Store Owner",
  };
}

function shapeProduct(row) {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand || "",
    category: row.category || "",
    sellingPrice: Number(row.selling_price) || 0,
    stock: Number(row.current_stock) || 0,
    lowStockLimit: Number(row.low_stock_limit) || 5,
    // Number of days after a purchase before this product is considered
    // "due for reorder" (e.g. a 25-serving tub of creatine -> 25). Null/blank
    // means the product doesn't participate in the reorder-days system.
    reorderDays:
      row.reorder_days === null || row.reorder_days === undefined
        ? null
        : Number(row.reorder_days) || null,
  };
}

function shapeCustomer(row) {
  const { dateISO } = splitTimestamp(row.created_at);

  return {
    id: row.id,
    name: row.name || "Customer",
    phone: row.phone || "",
    createdAt: dateISO,
  };
}

/*
 * Reverse of mapMovementTypeToDb (defined below, near dbInsertMovement):
 * translates DB values back to the UI-facing labels the rest of the
 * app (e.g. movement history display) already expects.
 */
function mapMovementTypeFromDb(dbType) {
  switch (dbType) {
    case "stock_in":
      return "Stock Added";
    case "adjustment":
      return "Stock Adjustment";
    case "sale":
      return "Sale";
    case "return":
      return "Return";
    default:
      return dbType;
  }
}

function shapeMovement(row) {
  const { dateISO, time } = splitTimestamp(row.created_at);

  return {
    id: row.id,
    productId: row.product_id,
    type: mapMovementTypeFromDb(row.movement_type),
    quantity: Number(row.quantity) || 0,
    reference: row.reference_id || null,
    reason: row.reason || null,
    previousStock: Number(row.previous_stock) || 0,
    newStock: Number(row.new_stock) || 0,
    dateISO,
    time,
  };
}

/*
 * The app's UI-facing status vocabulary ("pending" | "contacted" |
 * "followup" | "closed") does not match the values allowed by the
 * customer_followups_status_check constraint in Supabase
 * ("pending" | "contacted" | "completed" | "cancelled").
 *
 * These two helpers translate at the DB boundary so the constraint is
 * always satisfied on write, while every other part of the app can keep
 * using the original "followup" / "closed" vocabulary unchanged.
 */
function mapStatusToDb(status, outcome) {
  if (status === "closed") {
    return outcome === "not_interested" ? "cancelled" : "completed";
  }
  if (status === "followup") {
    return "pending";
  }
  if (status === "contacted") {
    return "contacted";
  }
  return "pending";
}

function mapStatusFromDb(dbStatus, scheduledDate) {
  if (dbStatus === "completed" || dbStatus === "cancelled") {
    return "closed";
  }
  if (dbStatus === "contacted") {
    return "contacted";
  }
  if (dbStatus === "pending" && scheduledDate) {
    return "followup";
  }
  return "pending";
}

function shapeFollowup(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    productId: row.product_id || null,
    followupType: row.followup_type,
    status: mapStatusFromDb(row.status, row.scheduled_date),
    outcome: row.outcome || null,
    followupDate: row.scheduled_date || null,
    notes: row.notes || null,
    createdAt: row.created_at,
    completedAt: row.completed_at || null,
  };
}

function shapeSale(row, itemRows, productsById) {
  const { dateISO, time } = splitTimestamp(row.created_at);

  const items = (itemRows || []).map((it) => {
    const product = productsById.get(it.product_id);

    return {
      productId: it.product_id,
      name: product ? product.name : "Unknown Product",
      qty: Number(it.quantity) || 0,
      price: Number(it.unit_price) || 0,
      total: Number(it.total_price) || 0,
    };
  });

  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    dateISO,
    time,
    items,
    subtotal: Number(row.subtotal) || 0,
    discount: Number(row.discount) || 0,
    total: Number(row.total_amount) || 0,
    paymentMethod: row.payment_method,
    status: row.status || "completed",
    customerId: row.customer_id || null,
  };
}

/* =========================================================
   FETCH ALL DATA
   ========================================================= */

export async function fetchAllData() {
  const [
    productsRes,
    customersRes,
    salesRes,
    saleItemsRes,
    movementsRes,
    followupsRes,
    settingsRes,
  ] = await Promise.all([
    supabase
      .from("products")
      .select("*")
      .order("name", { ascending: true }),

    supabase
      .from("customers")
      .select("*")
      .order("created_at", { ascending: true }),

    supabase
      .from("sales")
      .select("*")
      .order("created_at", { ascending: true }),

    supabase
      .from("sale_items")
      .select("*"),

    supabase
      .from("stock_movements")
      .select("*")
      .order("created_at", { ascending: true }),

    supabase
      .from("customer_followups")
      .select("*")
      .order("created_at", { ascending: true }),

    supabase
      .from("store_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle(),
  ]);

  const firstError =
    productsRes.error ||
    customersRes.error ||
    salesRes.error ||
    saleItemsRes.error ||
    movementsRes.error ||
    followupsRes.error ||
    settingsRes.error;

  if (firstError) {
    throw firstError;
  }

  const products = (productsRes.data || []).map(shapeProduct);

  const productsById = new Map(
    (productsRes.data || []).map((p) => [p.id, p])
  );

  const customers = (customersRes.data || []).map(shapeCustomer);

  const itemsBySale = new Map();

  (saleItemsRes.data || []).forEach((item) => {
    if (!itemsBySale.has(item.sale_id)) {
      itemsBySale.set(item.sale_id, []);
    }

    itemsBySale.get(item.sale_id).push(item);
  });

  const sales = (salesRes.data || []).map((sale) =>
    shapeSale(
      sale,
      itemsBySale.get(sale.id),
      productsById
    )
  );

  const movements = (movementsRes.data || []).map(shapeMovement);

  const followups = (followupsRes.data || []).map(shapeFollowup);

  const settings = settingsRes.data ? shapeSettings(settingsRes.data) : null;

  return {
    products,
    customers,
    sales,
    movements,
    followups,
    settings,
  };
}

/* =========================================================
   PRODUCTS
   ========================================================= */

export async function dbInsertProduct(data) {
  const { data: row, error } = await supabase
    .from("products")
    .insert({
      name: data.name,
      brand: data.brand,
      category: data.category,
      selling_price: Number(data.sellingPrice) || 0,
      current_stock: Number(data.initialStock) || 0,
      low_stock_limit: Number(data.lowStockLimit) || 5,
      reorder_days:
        data.reorderDays === "" || data.reorderDays === undefined || data.reorderDays === null
          ? null
          : Number(data.reorderDays) || null,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return shapeProduct(row);
}

export async function dbUpdateProduct(id, data) {
  const { error } = await supabase
    .from("products")
    .update({
      name: data.name,
      brand: data.brand,
      category: data.category,
      selling_price: Number(data.sellingPrice) || 0,
      low_stock_limit: Number(data.lowStockLimit) || 5,
      reorder_days:
        data.reorderDays === "" || data.reorderDays === undefined || data.reorderDays === null
          ? null
          : Number(data.reorderDays) || null,
    })
    .eq("id", id);

  if (error) {
    throw error;
  }
}

/* =========================================================
   STOCK
   ========================================================= */

export async function dbSetProductStock(
  id,
  previousStock,
  newStock
) {
  const oldStock = Number(previousStock) || 0;
  const updatedStock = Number(newStock) || 0;

  let query = supabase
    .from("products")
    .update({
      current_stock: updatedStock,
    })
    .eq("id", id);

  /*
   * When decreasing stock, make sure the database still
   * contains the expected previous stock.
   *
   * This prevents accidentally overwriting a newer stock
   * value if another operation changed it.
   */
  if (updatedStock < oldStock) {
    query = query.gte("current_stock", oldStock);
  }

  const { data, error } = await query
    .select()
    .single();

  if (error) {
    throw error;
  }

  /*
   * If no row was updated, the guarded stock update failed.
   * Treat it as an actual failure instead of silently
   * continuing with the sale.
   */
  if (!data) {
    throw new Error(
      `Stock update failed for product ${id}. Expected stock: ${oldStock}`
    );
  }

  return shapeProduct(data);
}

/*
 * The app's UI-facing movement type labels ("Stock Added", "Stock
 * Adjustment", "Sale", "Return") do not match the values allowed by the
 * stock_movements_type_check constraint in Supabase ("stock_in" |
 * "sale" | "return" | "adjustment").
 *
 * This translates at the DB boundary so the constraint is always
 * satisfied on write, while the rest of the app can keep using the
 * original labels unchanged.
 */
function mapMovementTypeToDb(type) {
  switch (type) {
    case "Stock Added":
      return "stock_in";
    case "Stock Adjustment":
      return "adjustment";
    case "Sale":
      return "sale";
    case "Return":
      return "return";
    default:
      return type;
  }
}

export async function dbInsertMovement(movement) {
  const { data: row, error } = await supabase
    .from("stock_movements")
    .insert({
      product_id: movement.productId,
      movement_type: mapMovementTypeToDb(movement.type),
      quantity: Number(movement.quantity) || 0,
      reference_id: movement.reference || null,
      reason: movement.reason || null,
      previous_stock: Number(movement.previousStock) || 0,
      new_stock: Number(movement.newStock) || 0,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return shapeMovement(row);
}

/* =========================================================
   CUSTOMERS
   ========================================================= */

export async function dbInsertCustomer(phone, name) {
  const cleanPhone = String(phone || "").trim();

  if (!cleanPhone) {
    throw new Error("Customer phone number is required.");
  }

  const { data: existing, error: findError } = await supabase
    .from("customers")
    .select("*")
    .eq("phone", cleanPhone)
    .maybeSingle();

  if (findError) {
    throw findError;
  }

  if (existing) {
    return shapeCustomer(existing);
  }

  const { data: row, error } = await supabase
    .from("customers")
    .insert({
      name: (name || "").trim() || "Customer",
      phone: cleanPhone,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return shapeCustomer(row);
}

/* =========================================================
   SALES
   ========================================================= */

export async function dbInsertSale(sale) {
  if (!sale) {
    throw new Error("Sale data is required.");
  }

  if (!sale.invoiceNumber) {
    throw new Error("Invoice number is required.");
  }

  const paymentMethod = String(
    sale.paymentMethod || "cash"
  ).toLowerCase();

  const { data: row, error } = await supabase
    .from("sales")
    .insert({
      invoice_number: sale.invoiceNumber,
      customer_id: sale.customerId || null,
      subtotal: Number(sale.subtotal) || 0,
      discount: Number(sale.discount) || 0,
      total_amount: Number(sale.total) || 0,
      payment_method: paymentMethod,
      status: "completed",
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  if (!row) {
    throw new Error("Sale was not created.");
  }

  return row;
}

export async function dbInsertSaleItems(saleId, items) {
  if (!saleId) {
    throw new Error("Sale ID is required.");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("At least one sale item is required.");
  }

  const rows = items.map((item) => ({
    sale_id: saleId,
    product_id: item.productId,
    quantity: Number(item.qty) || 0,
    unit_price: Number(item.price) || 0,
    total_price: Number(item.total) || 0,
  }));

  const { data, error } = await supabase
    .from("sale_items")
    .insert(rows)
    .select();

  if (error) {
    throw error;
  }

  if (!data || data.length !== rows.length) {
    throw new Error(
      `Sale items insert incomplete. Expected ${rows.length}, created ${
        data?.length || 0
      }.`
    );
  }

  return data;
}

/* =========================================================
   FOLLOWUPS
   ========================================================= */

/*
 * customer_followups.scheduled_date is NOT NULL in the DB. Terminal
 * outcomes ("closed" via Purchased/Not interested) and the initial
 * "contacted" touch don't have a real future follow-up date, so we
 * stamp them with today's date as a placeholder. This satisfies the
 * NOT NULL constraint without affecting app logic: followupDate is
 * only ever read (App.jsx) when status === "followup", which these
 * rows are not.
 */
function todayDateOnly() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function dbInsertFollowup(row) {
  const { data, error } = await supabase
    .from("customer_followups")
    .insert({
      customer_id: row.customerId,
      product_id: row.productId || null,
      followup_type: row.followupType || "follow_up",
      scheduled_date: row.followupDate || todayDateOnly(),
      status: mapStatusToDb(row.status, row.outcome),
      outcome: row.outcome || null,
      notes: row.notes || null,
      completed_at: row.completedAt || null,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return shapeFollowup(data);
}

/* =========================================================
   SETTINGS
   ========================================================= */

export async function dbUpsertSettings(settings) {
  const { data, error } = await supabase
    .from("store_settings")
    .upsert({
      id: 1,
      store_name: settings.storeName,
      address: settings.address,
      phone: settings.phone,
      gst_number: settings.gst,
      invoice_prefix: settings.invoicePrefix,
      default_payment_method: settings.defaultPayment,
      owner_name: settings.ownerName,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return shapeSettings(data);
}