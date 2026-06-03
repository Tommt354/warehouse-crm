const Database = require("better-sqlite3");
const path = require("path");
const bcrypt = require("bcryptjs");
const fs = require("fs");

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

  CREATE INDEX IF NOT EXISTS idx_orders_drop ON orders(dropshipper_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_bp_model ON base_products(model_id);
  CREATE INDEX IF NOT EXISTS idx_var_bp ON variations(base_product_id);
  CREATE INDEX IF NOT EXISTS idx_cat_parent ON categories(parent_id);
`);

// Migrations
const addCol=(t,c,d)=>{try{db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`)}catch(e){}};
addCol("categories","photo","TEXT DEFAULT ''");
addCol("categories","hidden_from_drop","INTEGER DEFAULT 0");
addCol("categories","scope","TEXT DEFAULT 'base'");
addCol("base_products","cost_price","REAL DEFAULT 0");
addCol("base_products","drop_price","REAL DEFAULT 0");
addCol("models","category_drop_id","INTEGER DEFAULT NULL");
addCol("order_items","kit_id","INTEGER DEFAULT NULL");
addCol("variations","allow_negative_order","INTEGER DEFAULT 1");
addCol("orders","np_ref","TEXT DEFAULT ''");
addCol("orders","ttn_return","TEXT DEFAULT ''");
addCol("models","drop_channel","TEXT DEFAULT 'hot'");
addCol("order_items","drop_channel","TEXT DEFAULT ''");
addCol("kits","drop_channel","TEXT DEFAULT 'hot'");

// Defaults
if(!db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()){
  db.prepare("INSERT INTO users(username,password_hash,role,name)VALUES(?,?,'admin','Адміністратор')").run("admin",bcrypt.hashSync("admin123",10));
  console.log("✅ admin / admin123");
}
if(!db.prepare("SELECT id FROM users WHERE role='dropshipper' LIMIT 1").get()){
  db.prepare("INSERT INTO users(username,password_hash,role,name)VALUES(?,?,'dropshipper','Тест Дроп')").run("drop1",bcrypt.hashSync("drop1234",10));
  console.log("✅ drop1 / drop1234");
}
if(!db.prepare("SELECT id FROM users WHERE role='warehouse' LIMIT 1").get()){
  db.prepare("INSERT INTO users(username,password_hash,role,name,worker_role,worker_rate)VALUES(?,?,'warehouse','Пакувальник 1','packer',5)").run("pack1",bcrypt.hashSync("pack1234",10));
  console.log("✅ pack1 / pack1234");
}
if(!db.prepare("SELECT id FROM sizes LIMIT 1").get()){
  const s=db.prepare("INSERT INTO sizes(name,sort_order)VALUES(?,?)");
  ["XXS","XS","S","M","L","XL","2XL","3XL"].forEach((n,i)=>s.run(n,i));
}
const ups=db.prepare("INSERT OR IGNORE INTO settings(key,value)VALUES(?,?)");
({stock_warning_threshold:"3",company_name:"Warehouse CRM",np_api_key:process.env.NP_API_KEY||""}).
  constructor.entries&&Object.entries({stock_warning_threshold:"3",company_name:"Warehouse CRM",np_api_key:process.env.NP_API_KEY||"",sender_city:"",sender_warehouse:"",sender_phone:"",sender_name:""}).forEach(([k,v])=>ups.run(k,v));

module.exports=db;
