const Database = require("better-sqlite3");
const path = require("path");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const crypto = require("crypto");

function genPassword() { return crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, ""); }

const dbPath = process.env.DB_PATH || path.join(__dirname, "crm.db");
if (process.env.RESET_DB === "1" && fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
  try{fs.unlinkSync(dbPath+"-wal")}catch(e){}
  try{fs.unlinkSync(dbPath+"-shm")}catch(e){}
  console.log("🗑 DB reset");
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','dropshipper','warehouse')),
    name TEXT NOT NULL DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    telegram TEXT DEFAULT '',
    discount_percent REAL DEFAULT 0,
    discount_fixed REAL DEFAULT 0,
    payout_details TEXT DEFAULT '',
    worker_role TEXT DEFAULT '',
    worker_rate REAL DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    last_login TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS colors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    hex_code TEXT DEFAULT '#808080',
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS prints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS patches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER DEFAULT NULL,
    photo TEXT DEFAULT '',
    hidden_from_drop INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category_id INTEGER DEFAULT NULL,
    is_ready_product INTEGER DEFAULT 0,
    cost_price REAL DEFAULT 0,
    drop_price REAL DEFAULT 0,
    photo TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS model_colors (
    model_id INTEGER NOT NULL, color_id INTEGER NOT NULL,
    PRIMARY KEY (model_id, color_id),
    FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
    FOREIGN KEY (color_id) REFERENCES colors(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS model_sizes (
    model_id INTEGER NOT NULL, size_id INTEGER NOT NULL,
    PRIMARY KEY (model_id, size_id),
    FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
    FOREIGN KEY (size_id) REFERENCES sizes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS model_prints (
    model_id INTEGER NOT NULL, print_id INTEGER NOT NULL,
    PRIMARY KEY (model_id, print_id),
    FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
    FOREIGN KEY (print_id) REFERENCES prints(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS model_patches (
    model_id INTEGER NOT NULL, patch_id INTEGER NOT NULL,
    PRIMARY KEY (model_id, patch_id),
    FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
    FOREIGN KEY (patch_id) REFERENCES patches(id) ON DELETE CASCADE
  );

  -- Працівники прив'язані до моделі з індивідуальною оплатою
  CREATE TABLE IF NOT EXISTS model_workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    amount REAL DEFAULT 0,
    FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS base_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL,
    color_id INTEGER,
    name TEXT NOT NULL,
    photo TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
    FOREIGN KEY (color_id) REFERENCES colors(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS variations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_product_id INTEGER NOT NULL,
    print_id INTEGER DEFAULT NULL,
    name TEXT NOT NULL,
    photo TEXT DEFAULT '',
    drop_price_override REAL DEFAULT NULL,
    active INTEGER DEFAULT 1,
    FOREIGN KEY (base_product_id) REFERENCES base_products(id) ON DELETE CASCADE,
    FOREIGN KEY (print_id) REFERENCES prints(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS stock_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_product_id INTEGER NOT NULL, size_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 0,
    UNIQUE(base_product_id, size_id),
    FOREIGN KEY (base_product_id) REFERENCES base_products(id) ON DELETE CASCADE,
    FOREIGN KEY (size_id) REFERENCES sizes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS stock_returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    variation_id INTEGER NOT NULL, size_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 0,
    UNIQUE(variation_id, size_id),
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE,
    FOREIGN KEY (size_id) REFERENCES sizes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS stock_incoming (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_product_id INTEGER NOT NULL, size_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL, note TEXT DEFAULT '',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (base_product_id) REFERENCES base_products(id),
    FOREIGN KEY (size_id) REFERENCES sizes(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dropshipper_id INTEGER NOT NULL, status TEXT DEFAULT 'new',
    client_name TEXT DEFAULT '', client_phone TEXT DEFAULT '',
    client_city TEXT DEFAULT '', client_warehouse TEXT DEFAULT '',
    cod_amount REAL DEFAULT 0, total_drop_price REAL DEFAULT 0, payout_amount REAL DEFAULT 0,
    ttn TEXT DEFAULT '', ttn_return TEXT DEFAULT '',
    np_status TEXT DEFAULT '', np_status_code INTEGER DEFAULT 0, np_status_updated TEXT DEFAULT '',
    packed_by INTEGER DEFAULT NULL, packed_at TEXT DEFAULT '', note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (dropshipper_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL, variation_id INTEGER NOT NULL, size_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 1, drop_price REAL DEFAULT 0,
    from_returns INTEGER DEFAULT 0, missing INTEGER DEFAULT 0, returned_to_stock INTEGER DEFAULT 0,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (variation_id) REFERENCES variations(id),
    FOREIGN KEY (size_id) REFERENCES sizes(id)
  );

  CREATE TABLE IF NOT EXISTS payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dropshipper_id INTEGER NOT NULL, amount REAL NOT NULL,
    status TEXT DEFAULT 'pending', payout_details TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')), paid_at TEXT DEFAULT '',
    FOREIGN KEY (dropshipper_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS worker_production (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, order_id INTEGER DEFAULT NULL,
    work_type TEXT NOT NULL, units INTEGER DEFAULT 1, rate REAL DEFAULT 0, total REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');

  CREATE TABLE IF NOT EXISTS np_senders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    sender_ref TEXT DEFAULT '',
    address_ref TEXT DEFAULT '',
    contact_ref TEXT DEFAULT '',
    address_description TEXT DEFAULT '',
    is_active INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS payout_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dropshipper_id INTEGER NOT NULL,
    total_amount REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    comment TEXT DEFAULT '',
    admin_comment TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    paid_at TEXT DEFAULT NULL,
    FOREIGN KEY(dropshipper_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payout_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payout_request_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    amount REAL DEFAULT 0,
    is_return INTEGER DEFAULT 0,
    FOREIGN KEY(payout_request_id) REFERENCES payout_requests(id),
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS stock_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    base_product_id INTEGER,
    variation_id INTEGER,
    size_id INTEGER,
    quantity INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    user_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS scan_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ttn TEXT NOT NULL,
    order_id INTEGER,
    scan_type TEXT DEFAULT 'shipment',
    user_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    user_id INTEGER DEFAULT NULL,
    daily_rate REAL DEFAULT 0,
    per_item_rate REAL DEFAULT 0,
    per_return_item_rate REAL DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    packer_user_id INTEGER NOT NULL,
    status TEXT DEFAULT 'open',
    opened_at TEXT DEFAULT (datetime('now','localtime')),
    closed_at TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS shift_workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL,
    worker_id INTEGER NOT NULL,
    FOREIGN KEY(shift_id) REFERENCES shifts(id),
    FOREIGN KEY(worker_id) REFERENCES workers(id)
  );

  CREATE TABLE IF NOT EXISTS worker_payroll (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER NOT NULL,
    shift_id INTEGER,
    order_id INTEGER,
    amount REAL DEFAULT 0,
    type TEXT DEFAULT 'item',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(worker_id) REFERENCES workers(id)
  );

  CREATE TABLE IF NOT EXISTS worker_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER NOT NULL,
    amount REAL DEFAULT 0,
    period_from TEXT,
    period_to TEXT,
    status TEXT DEFAULT 'paid',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(worker_id) REFERENCES workers(id)
  );

  CREATE TABLE IF NOT EXISTS product_worker_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL,
    worker_role TEXT NOT NULL,
    operations_count INTEGER DEFAULT 1,
    FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workshops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS stock_cuts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_product_id INTEGER NOT NULL,
    size_id INTEGER NOT NULL,
    workshop_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 0,
    UNIQUE(base_product_id, size_id, workshop_id),
    FOREIGN KEY(base_product_id) REFERENCES base_products(id),
    FOREIGN KEY(size_id) REFERENCES sizes(id),
    FOREIGN KEY(workshop_id) REFERENCES workshops(id)
  );

  CREATE TABLE IF NOT EXISTS cut_incoming (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_product_id INTEGER NOT NULL,
    size_id INTEGER NOT NULL,
    workshop_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Комплекти (віртуальні товари для дропшиперів)
  CREATE TABLE IF NOT EXISTS kits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo TEXT DEFAULT '',
    category_drop_id INTEGER DEFAULT NULL,
    drop_price REAL DEFAULT 0,
    cost_price REAL DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (category_drop_id) REFERENCES categories(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS kit_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kit_id INTEGER NOT NULL,
    variation_id INTEGER NOT NULL,
    FOREIGN KEY (kit_id) REFERENCES kits(id) ON DELETE CASCADE,
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS order_statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#888888',
    sort_order INTEGER DEFAULT 0,
    is_system INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS ready_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    variation_id INTEGER NOT NULL,
    size_id INTEGER NOT NULL,
    warehouse TEXT DEFAULT 'base',
    quantity INTEGER DEFAULT 0,
    UNIQUE(variation_id, size_id, warehouse),
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE,
    FOREIGN KEY (size_id) REFERENCES sizes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS balance_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    type TEXT NOT NULL,
    order_id INTEGER,
    note TEXT DEFAULT '',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  -- A recount session freezes stock_base.quantity (allocated) for whichever
  -- products it covers, so a physical count in progress isn't disturbed by
  -- new orders quietly decrementing the number mid-count. New orders placed
  -- while a row is frozen still go through normally (order_items get
  -- created as usual), they just don't touch that row's quantity — the
  -- deferred decrement gets reconciled all at once when the session is saved.
  CREATE TABLE IF NOT EXISTS recount_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER,
    status TEXT DEFAULT 'active',
    started_by INTEGER,
    started_at TEXT DEFAULT (datetime('now','localtime')),
    finished_at TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    note TEXT DEFAULT '',
    is_paid INTEGER DEFAULT 0,
    amount REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS task_assignees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    worker_id INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (worker_id) REFERENCES workers(id)
  );

  -- Закордонні посилки: parcels shipped abroad have no Nova Poshta TTN, so a
  -- packer can't scan them. She just logs the client's phone at pack time;
  -- phone_digits is the digits-only form so search matches regardless of how
  -- the number was formatted (+380, spaces, etc.).
  CREATE TABLE IF NOT EXISTS foreign_parcels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    phone_digits TEXT NOT NULL DEFAULT '',
    packed_by INTEGER,
    packed_at TEXT DEFAULT (datetime('now','localtime')),
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (packed_by) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_fparcels_digits ON foreign_parcels(phone_digits);
  CREATE INDEX IF NOT EXISTS idx_orders_drop ON orders(dropshipper_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_bp_model ON base_products(model_id);
  CREATE INDEX IF NOT EXISTS idx_var_bp ON variations(base_product_id);
  CREATE INDEX IF NOT EXISTS idx_cat_parent ON categories(parent_id);
`);

// Migrations
const addCol=(t,c,d)=>{try{db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);return true}catch(e){return false}};
addCol("categories","photo","TEXT DEFAULT ''");
addCol("categories","hidden_from_drop","INTEGER DEFAULT 0");
addCol("categories","scope","TEXT DEFAULT 'base'");
addCol("base_products","cost_price","REAL DEFAULT 0");
addCol("base_products","drop_price","REAL DEFAULT 0");
addCol("models","category_drop_id","INTEGER DEFAULT NULL");
addCol("order_items","kit_id","INTEGER DEFAULT NULL");
addCol("variations","allow_negative_order","INTEGER DEFAULT 1");
// Per-variation drop-catalog category override. A model has one
// category_drop_id, but its printed variations can each belong to a different
// dropshipper-facing category (e.g. 4 prints → 4 categories). NULL = fall back
// to the model's category_drop_id. Base warehouse is unaffected (it groups by
// colour, not print). See the COALESCE in GET /api/variations.
addCol("variations","category_drop_id","INTEGER DEFAULT NULL");
addCol("users","payment_type","TEXT DEFAULT 'card'");
addCol("users","payment_card","TEXT DEFAULT ''");
addCol("users","payment_iban","TEXT DEFAULT ''");
addCol("users","edrpou","TEXT DEFAULT ''");
addCol("users","full_name","TEXT DEFAULT ''");
addCol("users","payment_purpose","TEXT DEFAULT ''");
addCol("users","phone","TEXT DEFAULT ''");
addCol("users","telegram","TEXT DEFAULT ''");
addCol("orders","np_ref","TEXT DEFAULT ''");
addCol("orders","ttn_return","TEXT DEFAULT ''");
addCol("models","drop_channel","TEXT DEFAULT 'ads'");
addCol("models","no_workshop","INTEGER DEFAULT 0");
addCol("order_items","drop_channel","TEXT DEFAULT ''");
addCol("kits","drop_channel","TEXT DEFAULT 'ads'");
addCol("orders","drop_channel","TEXT DEFAULT ''");
addCol("order_items","original_size_id","INTEGER DEFAULT NULL");
addCol("orders","np_status_text","TEXT DEFAULT ''");
addCol("orders","return_ttn","TEXT DEFAULT ''");
addCol("orders","return_cost","REAL DEFAULT 0");
// Returns only count as physically received once staff explicitly confirms
// them (not the moment NP flags a refusal or the moment someone scans the
// return TTN to look it up) — return_flagged_at anchors the "not received"
// day-count from when NP first signaled a return, independent of later
// order edits that would otherwise bump updated_at.
addCol("orders","return_flagged_at","TEXT DEFAULT ''");
// Set only once — the moment NP tracking actually reports the parcel as
// departed/in transit, not when the finalizer scans+confirms it (that just
// means it's packed and handed off; NP may not have picked it up yet).
addCol("orders","shipped_at","TEXT DEFAULT ''");
addCol("orders","return_received","INTEGER DEFAULT 0");
addCol("orders","return_received_at","TEXT DEFAULT ''");
addCol("orders","return_received_by","INTEGER DEFAULT NULL");
addCol("orders","is_prepaid","INTEGER DEFAULT 0");
addCol("orders","receipt_photo","TEXT DEFAULT ''");
addCol("orders","declared_value","REAL DEFAULT 0");
addCol("np_senders","api_key","TEXT DEFAULT ''");
// A sender that ships from an NP branch (the overwhelmingly common case for
// a business account) needs InternetDocument.SenderAddress to be that
// branch's Warehouse ref, not a Counterparty custom-address ref — those are
// two different NP object types and getCounterpartyAddresses only ever
// returns the latter (empty for accounts that never set up a personal
// pickup address). These columns store the admin's explicit branch pick.
addCol("np_senders","sender_city_ref","TEXT DEFAULT ''");
addCol("np_senders","sender_city_name","TEXT DEFAULT ''");
addCol("np_senders","sender_warehouse_ref","TEXT DEFAULT ''");
addCol("np_senders","sender_warehouse_desc","TEXT DEFAULT ''");
// Tracks the ~1-2s window while the auto-TTN background job (fired after
// order creation) is still talking to Nova Poshta, so the UI can show a
// clear "generating" state instead of letting someone click "Створити ТТН"
// and hit a confusing "already created" error mid-flight.
addCol("orders","ttn_pending","INTEGER DEFAULT 0");
addCol("orders","own_ttn","INTEGER DEFAULT 0");
addCol("models","size_grid_photo","TEXT DEFAULT ''");
addCol("orders","cargo_description","TEXT DEFAULT 'Одяг'");
addCol("models","main_warehouse","TEXT DEFAULT 'base'");
addCol("users","assigned_warehouse","TEXT DEFAULT ''");
addCol("users","balance","REAL DEFAULT 0");
addCol("order_items","return_condition","TEXT DEFAULT ''");
addCol("models","weight","REAL DEFAULT 0.3");
addCol("kits","weight","REAL DEFAULT 0.5");
addCol("orders","weight","REAL DEFAULT 0");
addCol("orders","delivery_type","TEXT DEFAULT 'warehouse'");
addCol("orders","client_street","TEXT DEFAULT ''");
addCol("orders","client_house","TEXT DEFAULT ''");
addCol("orders","client_flat","TEXT DEFAULT ''");
addCol("orders","is_postomat","INTEGER DEFAULT 0");
addCol("orders","parcel_width","REAL DEFAULT 0");
addCol("orders","parcel_height","REAL DEFAULT 0");
addCol("orders","parcel_length","REAL DEFAULT 0");
addCol("workers","use_daily_rate","INTEGER DEFAULT 1");
addCol("worker_payroll","task_id","INTEGER DEFAULT NULL");
// Payroll operation counts now live on the print/patch itself (not on the
// product): each carries how many printer-operations and seamstress-operations
// applying it represents. calcOrderPayroll sums these across all prints and
// patches linked to an ordered item's model. Replaces the old per-model
// product_worker_ops table (kept in schema, no longer read).
addCol("prints","printer_ops","INTEGER DEFAULT 0");
addCol("prints","seamstress_ops","INTEGER DEFAULT 0");
addCol("patches","printer_ops","INTEGER DEFAULT 0");
addCol("patches","seamstress_ops","INTEGER DEFAULT 0");
// stock_base.quantity ("списана"/allocated) is decremented the instant a
// dropshipper places an order, before anyone has physically touched the
// shelf — so it can run negative when allow_negative_order permits, and a
// packer reading it saw "0 left" for stock that was still sitting there.
// quantity_actual ("фактична") is the real physical count: it only moves
// when a packer actually takes an order into work (see the in_progress
// status transition) or on a real physical event (incoming/write-off/swap/
// return-to-stock/recount), and it's floored at 0 since a shelf can't hold
// a negative amount of anything. Backfilled once from the existing
// quantity on the migration that adds the column — there's no way to
// recover the true historical physical count, so this is the best
// approximation available at that point in time.
if(addCol("stock_base","quantity_actual","INTEGER DEFAULT 0")){
  db.exec("UPDATE stock_base SET quantity_actual=quantity");
}
// Set while an active recount_sessions row covers this product/size — see
// the recount_sessions table comment for what freezing means.
addCol("stock_base","recount_session_id","INTEGER DEFAULT NULL");

// Defaults
if(!db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()){
  const pw = process.env.ADMIN_PASSWORD || genPassword();
  db.prepare("INSERT INTO users(username,password_hash,role,name)VALUES(?,?,'admin','Адміністратор')").run("admin",bcrypt.hashSync(pw,10));
  console.log("✅ Створено admin, логін: admin, пароль: "+pw+" — увійдіть і одразу змініть пароль.");
}
if(!db.prepare("SELECT id FROM users WHERE role='dropshipper' LIMIT 1").get()){
  const pw = process.env.DROPSHIPPER_PASSWORD || genPassword();
  db.prepare("INSERT INTO users(username,password_hash,role,name)VALUES(?,?,'dropshipper','Тест Дроп')").run("drop1",bcrypt.hashSync(pw,10));
  console.log("✅ Створено drop1, логін: drop1, пароль: "+pw+" — увійдіть і одразу змініть пароль.");
}
if(!db.prepare("SELECT id FROM users WHERE role='warehouse' LIMIT 1").get()){
  const pw = process.env.WAREHOUSE_PASSWORD || genPassword();
  db.prepare("INSERT INTO users(username,password_hash,role,name,worker_role,worker_rate)VALUES(?,?,'warehouse','Пакувальник 1','packer',5)").run("pack1",bcrypt.hashSync(pw,10));
  console.log("✅ Створено pack1, логін: pack1, пароль: "+pw+" — увійдіть і одразу змініть пароль.");
}
// Dedicated seed accounts for the distinct warehouse worker roles (packer on
// Склад База, packer on Склад Молодіжна, finalizer) so each has its own
// login — needed since a single shared account can't demonstrate the
// per-warehouse packer split or the dev quick-login role buttons.
if(!db.prepare("SELECT id FROM users WHERE username='pack2'").get()){
  const pw = process.env.WAREHOUSE2_PASSWORD || genPassword();
  db.prepare("INSERT INTO users(username,password_hash,role,name,worker_role,worker_rate,assigned_warehouse)VALUES(?,?,'warehouse',?,'packer',5,'base')").run("pack2",bcrypt.hashSync(pw,10),"Пакувальник (База)");
  console.log("✅ Створено pack2, логін: pack2, пароль: "+pw+" — увійдіть і одразу змініть пароль.");
}
if(!db.prepare("SELECT id FROM users WHERE username='pack3'").get()){
  const pw = process.env.WAREHOUSE3_PASSWORD || genPassword();
  db.prepare("INSERT INTO users(username,password_hash,role,name,worker_role,worker_rate,assigned_warehouse)VALUES(?,?,'warehouse',?,'packer_ready',5,'molod')").run("pack3",bcrypt.hashSync(pw,10),"Пакувальник (Готовий товар)");
  console.log("✅ Створено pack3, логін: pack3, пароль: "+pw+" — увійдіть і одразу змініть пароль.");
}
if(!db.prepare("SELECT id FROM users WHERE username='final1'").get()){
  const pw = process.env.FINALIZER_PASSWORD || genPassword();
  db.prepare("INSERT INTO users(username,password_hash,role,name,worker_role,worker_rate)VALUES(?,?,'warehouse',?,'finalizer',5)").run("final1",bcrypt.hashSync(pw,10),"Пакувальниця 1");
  console.log("✅ Створено final1, логін: final1, пароль: "+pw+" — увійдіть і одразу змініть пароль.");
}
// Молодіжна IS the ready-product warehouse (one and the same place) — an
// earlier iteration modeled them as two separate packer concepts (regular
// packer assigned to склад Молодіжна vs a distinct packer_ready role).
// Collapse that into pack3 alone and drop the now-redundant duplicate.
if(db.prepare("SELECT id FROM users WHERE username='pack3' AND worker_role='packer'").get()){
  db.prepare("UPDATE users SET worker_role='packer_ready',name='Пакувальник (Готовий товар)' WHERE username='pack3'").run();
  db.prepare("UPDATE workers SET role='packer_ready',name='Пакувальник (Готовий товар)' WHERE user_id=(SELECT id FROM users WHERE username='pack3')").run();
  console.log("🔄 pack3 переведено на роль packer_ready (Молодіжна = Готовий товар)");
}
const readyDup = db.prepare("SELECT id FROM users WHERE username='ready1'").get();
if(readyDup){
  db.prepare("DELETE FROM workers WHERE user_id=?").run(readyDup.id);
  db.prepare("DELETE FROM users WHERE id=?").run(readyDup.id);
  console.log("🗑 Видалено дублікат ready1 (об'єднано з pack3)");
}
if(!db.prepare("SELECT id FROM users WHERE username='seam1'").get()){
  const pw = process.env.SEAMSTRESS_PASSWORD || genPassword();
  db.prepare("INSERT INTO users(username,password_hash,role,name,worker_role,worker_rate)VALUES(?,?,'warehouse',?,'seamstress',5)").run("seam1",bcrypt.hashSync(pw,10),"Швея 1");
  console.log("✅ Створено seam1, логін: seam1, пароль: "+pw+" — увійдіть і одразу змініть пароль.");
}
if(!db.prepare("SELECT id FROM users WHERE username='print1'").get()){
  const pw = process.env.PRINTER_PASSWORD || genPassword();
  db.prepare("INSERT INTO users(username,password_hash,role,name,worker_role,worker_rate)VALUES(?,?,'warehouse',?,'printer',5)").run("print1",bcrypt.hashSync(pw,10),"Принтувальник 1");
  console.log("✅ Створено print1, логін: print1, пароль: "+pw+" — увійдіть і одразу змініть пароль.");
}
// Ensure every warehouse-role login has a matching workers profile (needed
// for payroll crediting and the self-service /api/my-payroll salary view) —
// seed accounts created directly in users don't go through POST /api/workers
// which normally creates both rows together.
db.prepare(`SELECT * FROM users WHERE role='warehouse' AND id NOT IN (SELECT user_id FROM workers WHERE user_id IS NOT NULL)`).all().forEach(u => {
  db.prepare("INSERT INTO workers(name,role,user_id,daily_rate,per_item_rate,per_return_item_rate)VALUES(?,?,?,?,?,?)")
    .run(u.name, u.worker_role || "packer", u.id, 0, u.worker_rate || 0, 0);
});
// Seed default order statuses
if(!db.prepare("SELECT id FROM order_statuses LIMIT 1").get()){
  const statuses = [
    { code: "new", name: "Нове", color: "#3b82f6", sort: 1, system: 1 },
    { code: "in_progress", name: "В роботі", color: "#f59e0b", sort: 2, system: 1 },
    { code: "packed", name: "Запаковано", color: "#8b5cf6", sort: 3, system: 1 },
    { code: "shipped", name: "Відправлено", color: "#10b981", sort: 4, system: 1 },
    { code: "delivered", name: "Доставлено", color: "#22c55e", sort: 5, system: 0 },
    { code: "done", name: "Виконано", color: "#059669", sort: 6, system: 0 },
    { code: "refused", name: "Відмова", color: "#ef4444", sort: 7, system: 0 },
    { code: "return_transit", name: "Повернення", color: "#f97316", sort: 8, system: 0 },
    { code: "cancelled", name: "Скасовано", color: "#6b7280", sort: 9, system: 1 }
  ];
  const ins = db.prepare("INSERT INTO order_statuses(code,name,color,sort_order,is_system)VALUES(?,?,?,?,?)");
  statuses.forEach(s => ins.run(s.code, s.name, s.color, s.sort, s.system));
}
// Reconcile: "delivering" is a real status the NP-tracking cron assigns
// (see trackOneOrder in server.js) but was missing from the original seed
// above, and "delivered"/"return_transit" also drive real stock/payout
// logic — none of these are safe for an admin to delete via the custom
// order-statuses UI, so make sure they exist and are flagged is_system,
// without touching any status an admin has since customized.
(() => {
  const maxSort = db.prepare("SELECT MAX(sort_order) as m FROM order_statuses").get().m || 0;
  const required = [
    { code: "delivering", name: "Доставка", color: "#f59e0b", sort: maxSort + 1 },
  ];
  required.forEach(s => {
    if (!db.prepare("SELECT id FROM order_statuses WHERE code=?").get(s.code)) {
      db.prepare("INSERT INTO order_statuses(code,name,color,sort_order,is_system)VALUES(?,?,?,?,1)").run(s.code, s.name, s.color, s.sort);
    }
  });
  db.prepare("UPDATE order_statuses SET is_system=1 WHERE code IN ('new','in_progress','packed','shipped','delivering','delivered','refused','return_transit','cancelled')").run();
})();
if(!db.prepare("SELECT id FROM sizes LIMIT 1").get()){
  const s=db.prepare("INSERT INTO sizes(name,sort_order)VALUES(?,?)");
  ["XXS","XS","S","M","L","XL","2XL","3XL"].forEach((n,i)=>s.run(n,i));
}
const ups=db.prepare("INSERT OR IGNORE INTO settings(key,value)VALUES(?,?)");
Object.entries({stock_warning_threshold:"3",company_name:"ADS DROP",np_api_key:process.env.NP_API_KEY||"",sender_city:"",sender_warehouse:"",sender_phone:"",sender_name:""}).forEach(([k,v])=>ups.run(k,v));

module.exports=db;
