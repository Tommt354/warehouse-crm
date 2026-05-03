const Database = require("better-sqlite3");
const path = require("path");
const bcrypt = require("bcryptjs");

const dbPath = process.env.DB_PATH || path.join(__dirname, "crm.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ══════════════════════════════════════════════════════════════════
// SCHEMA — всі таблиці для всіх модулів
// ══════════════════════════════════════════════════════════════════

db.exec(`
  -- ── Користувачі ──────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','dropshipper','warehouse')),
    name TEXT NOT NULL DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    telegram TEXT DEFAULT '',
    -- Дропшипер
    discount_percent REAL DEFAULT 0,
    discount_fixed REAL DEFAULT 0,
    payout_details TEXT DEFAULT '',
    -- Склад працівник
    worker_role TEXT DEFAULT '' CHECK(worker_role IN ('','packer','printer','sewer','distributor')),
    worker_rate REAL DEFAULT 0,
    -- Загальне
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    last_login TEXT DEFAULT ''
  );

  -- ── Категорії ────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER DEFAULT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
  );

  -- ── Базові товари ────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS base_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category_id INTEGER DEFAULT NULL,
    photo TEXT DEFAULT '',
    drop_price REAL DEFAULT 0,
    description TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
  );

  -- ── Розміри ──────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS sizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );

  -- ── Принти ───────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS prints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo TEXT DEFAULT '',
    print_count INTEGER DEFAULT 1,
    patch_count INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );

  -- ── Варіації (базовий товар + принт) ─────────────────────────
  CREATE TABLE IF NOT EXISTS variations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_product_id INTEGER NOT NULL,
    print_id INTEGER NOT NULL,
    name TEXT DEFAULT '',
    photo TEXT DEFAULT '',
    drop_price_override REAL DEFAULT NULL,
    active INTEGER DEFAULT 1,
    FOREIGN KEY (base_product_id) REFERENCES base_products(id) ON DELETE CASCADE,
    FOREIGN KEY (print_id) REFERENCES prints(id) ON DELETE CASCADE,
    UNIQUE(base_product_id, print_id)
  );

  -- ── Залишки базового товару (по розмірах) ─────────────────────
  CREATE TABLE IF NOT EXISTS stock_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_product_id INTEGER NOT NULL,
    size_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 0,
    FOREIGN KEY (base_product_id) REFERENCES base_products(id) ON DELETE CASCADE,
    FOREIGN KEY (size_id) REFERENCES sizes(id) ON DELETE CASCADE,
    UNIQUE(base_product_id, size_id)
  );

  -- ── Залишки повернень (варіація + розмір) ─────────────────────
  CREATE TABLE IF NOT EXISTS stock_returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    variation_id INTEGER NOT NULL,
    size_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 0,
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE,
    FOREIGN KEY (size_id) REFERENCES sizes(id) ON DELETE CASCADE,
    UNIQUE(variation_id, size_id)
  );

  -- ── Прихід товару ────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS stock_incoming (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_product_id INTEGER NOT NULL,
    size_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    note TEXT DEFAULT '',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (base_product_id) REFERENCES base_products(id),
    FOREIGN KEY (size_id) REFERENCES sizes(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  -- ── Замовлення ───────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dropshipper_id INTEGER NOT NULL,
    status TEXT DEFAULT 'new' CHECK(status IN (
      'new','in_progress','packed','shipped','delivering','delivered',
      'refused','return_transit','return_warehouse','return_received','cancelled'
    )),
    client_name TEXT NOT NULL DEFAULT '',
    client_phone TEXT NOT NULL DEFAULT '',
    client_city TEXT DEFAULT '',
    client_warehouse TEXT DEFAULT '',
    cod_amount REAL DEFAULT 0,
    total_drop_price REAL DEFAULT 0,
    payout_amount REAL DEFAULT 0,
    ttn TEXT DEFAULT '',
    ttn_return TEXT DEFAULT '',
    np_status TEXT DEFAULT '',
    np_status_code INTEGER DEFAULT 0,
    np_status_updated TEXT DEFAULT '',
    packed_by INTEGER DEFAULT NULL,
    packed_at TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (dropshipper_id) REFERENCES users(id),
    FOREIGN KEY (packed_by) REFERENCES users(id)
  );

  -- ── Товари в замовленні ──────────────────────────────────────
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    variation_id INTEGER NOT NULL,
    size_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 1,
    drop_price REAL DEFAULT 0,
    from_returns INTEGER DEFAULT 0,
    missing INTEGER DEFAULT 0,
    returned_to_stock INTEGER DEFAULT 0,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (variation_id) REFERENCES variations(id),
    FOREIGN KEY (size_id) REFERENCES sizes(id)
  );

  -- ── Виплати дропшиперам ──────────────────────────────────────
  CREATE TABLE IF NOT EXISTS payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dropshipper_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid')),
    payout_details TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    paid_at TEXT DEFAULT '',
    FOREIGN KEY (dropshipper_id) REFERENCES users(id)
  );

  -- ── Виробіток працівників ────────────────────────────────────
  CREATE TABLE IF NOT EXISTS worker_production (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    order_id INTEGER DEFAULT NULL,
    order_item_id INTEGER DEFAULT NULL,
    work_type TEXT NOT NULL CHECK(work_type IN ('pack','print','sew','distribute')),
    units INTEGER DEFAULT 1,
    rate REAL DEFAULT 0,
    total REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );

  -- ── Налаштування ─────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
  );

  -- ── Сканування ЕН (з попереднього сканера) ────────────────────
  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    scanned_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    worker TEXT DEFAULT '',
    np_status TEXT DEFAULT '',
    np_status_code INTEGER DEFAULT 0,
    np_status_updated TEXT DEFAULT '',
    return_ttn TEXT DEFAULT '',
    return_received INTEGER DEFAULT 0,
    return_received_at TEXT DEFAULT '',
    return_scanned_by TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_scans_code ON scans(code);

  -- ── Індекси ──────────────────────────────────────────────────
  CREATE INDEX IF NOT EXISTS idx_orders_drop ON orders(dropshipper_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_ttn ON orders(ttn);
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_stock_base ON stock_base(base_product_id, size_id);
  CREATE INDEX IF NOT EXISTS idx_stock_returns ON stock_returns(variation_id, size_id);
`);

// ── Дефолтні дані ────────────────────────────────────────────────
// Створюємо адміна якщо ще немає
const adminExists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
if (!adminExists) {
  const hash = bcrypt.hashSync("admin123", 10);
  db.prepare("INSERT INTO users (username, password_hash, role, name) VALUES (?, ?, 'admin', 'Адміністратор')").run("admin", hash);
  console.log("✅ Created default admin: admin / admin123");
}

// Дефолтні розміри
const sizesExist = db.prepare("SELECT id FROM sizes LIMIT 1").get();
if (!sizesExist) {
  const sizes = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL"];
  const stmt = db.prepare("INSERT INTO sizes (name, sort_order) VALUES (?, ?)");
  sizes.forEach((s, i) => stmt.run(s, i));
  console.log("✅ Created default sizes");
}

// Дефолтні налаштування
const defaults = {
  stock_warning_threshold: "3",
  company_name: "Warehouse CRM",
  np_api_key: process.env.NP_API_KEY || "",
  sender_city: "",
  sender_warehouse: "",
  sender_phone: "",
  sender_name: "",
};
const upsert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
Object.entries(defaults).forEach(([k, v]) => upsert.run(k, v));

module.exports = db;
