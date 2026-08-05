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

  -- Полиця браку. Товар сюди не "зникає" зі списанням, а лежить окремо, щоб
  -- було видно скільки браку накопичилось і на яку собівартість.
  -- variation_id = 0 означає "прийшло з бази" (там облік по базовому товару,
  -- без варіації); нуль, а не NULL, щоб працював UNIQUE — у SQLite NULL-и в
  -- унікальному індексі вважаються різними.
  CREATE TABLE IF NOT EXISTS stock_defect (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_product_id INTEGER NOT NULL,
    variation_id INTEGER NOT NULL DEFAULT 0,
    size_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 0,
    source TEXT DEFAULT 'base',
    in_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(base_product_id, variation_id, size_id),
    FOREIGN KEY (base_product_id) REFERENCES base_products(id) ON DELETE CASCADE,
    FOREIGN KEY (size_id) REFERENCES sizes(id) ON DELETE CASCADE
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

  -- Per-dropshipper fixed-₴ discounts on a drop category OR a single variation.
  -- Exactly one of category_id / variation_id is set. The discount is subtracted
  -- (per unit) from the item's drop price everywhere that dropshipper sees prices;
  -- when both a category and a variation discount match, the larger one applies.
  CREATE TABLE IF NOT EXISTS dropshipper_discounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dropshipper_id INTEGER NOT NULL,
    category_id INTEGER,
    variation_id INTEGER,
    amount REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (dropshipper_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
    FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE
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

  -- Позиції кожного переобліку: що було на полиці, що порахували, різниця.
  -- Сесія фіксує "коли і хто", а ці рядки — "що саме змінилось", щоб історію
  -- можна було відкрити й побачити недостачі та перестачі поіменно.
  CREATE TABLE IF NOT EXISTS recount_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    base_product_id INTEGER NOT NULL,
    size_id INTEGER NOT NULL,
    before_qty INTEGER DEFAULT 0,
    after_qty INTEGER DEFAULT 0,
    diff INTEGER DEFAULT 0,
    ordered_during INTEGER DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES recount_sessions(id) ON DELETE CASCADE
  );

  -- Щоденний циклічний переоблік: одне завдання на склад на день. Поки воно
  -- не виконане, пакувальник цього складу не може відкрити зміну — це і є
  -- весь сенс механізму: розбіжність знаходиться назавтра, а не через місяць.
  -- Завдання видається сліпим: працівник бачить лише які товари рахувати,
  -- очікувану кількість — ніколи. Введені цифри йдуть через звичайний
  -- /api/recount/apply, тож завдання посилається на recount-сесію, у якій
  -- лежать і заморозка, і історія по позиціях.
  CREATE TABLE IF NOT EXISTS cycle_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse TEXT NOT NULL DEFAULT 'base',
    task_date TEXT NOT NULL,
    session_id INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    finished_at TEXT DEFAULT NULL,
    finished_by INTEGER,
    UNIQUE(warehouse, task_date),
    FOREIGN KEY (session_id) REFERENCES recount_sessions(id) ON DELETE SET NULL
  );

  -- Які саме товари випали на цей день. Зберігаємо окремо від recount_items:
  -- ті пишуться лише коли щось змінилось, а знати треба весь виданий список
  -- (у т.ч. позиції, що зійшлися) — інакше % перерахованого складу бреше.
  CREATE TABLE IF NOT EXISTS cycle_task_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    base_product_id INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES cycle_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (base_product_id) REFERENCES base_products(id) ON DELETE CASCADE
  );

  -- Фінансовий модуль. Категорії заводить власник сам, і логіка живе саме в
  -- категорії — обравши її, він більше нічого не вказує. kind:
  --   expense  — гроші згоріли (бензин, оренда, реклама)
  --   material — пішли в матеріали (тканина, фурнітура)
  --   sewing   — оплата роботи цеху
  --   purchase — закупка готового товару
  -- is_goods — похідний прапорець (kind != 'expense') для звітів, пишеться
  -- автоматично: у звітах потрібен саме поділ «згоріло / лежить у товарі».
  CREATE TABLE IF NOT EXISTS fin_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT DEFAULT 'expense',
    is_goods INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    note TEXT DEFAULT '',
    active INTEGER DEFAULT 1
  );

  -- Витрата — це факт «ми винні або заплатили». Скільки з неї реально пішло
  -- з рахунку, живе в expense_payments: постачальники дають у борг, і
  -- неоплачений залишок — це і є борг.
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    category_id INTEGER,
    supplier_id INTEGER,
    workshop_id INTEGER,
    wholesale_id INTEGER,
    note TEXT DEFAULT '',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (category_id) REFERENCES fin_categories(id),
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
    FOREIGN KEY (workshop_id) REFERENCES workshops(id)
  );

  CREATE TABLE IF NOT EXISTS expense_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
  );

  -- Єдине джерело правди по рахунку: кожен рух грошей — рядок. ref_type/ref_id
  -- вказують на подію-джерело, а унікальний індекс не дає записати той самий
  -- рух двічі (трекінг НП ходить кожні 15 хв і бачить те саме замовлення).
  CREATE TABLE IF NOT EXISTS cash_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    kind TEXT NOT NULL,
    ref_type TEXT DEFAULT '',
    ref_id INTEGER,
    wholesale_id INTEGER,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS cash_moves_ref_uniq
    ON cash_moves(kind, ref_type, ref_id) WHERE ref_id IS NOT NULL;

  -- Менеджер отримує відсоток від прибутку. Ставку зберігаємо історією, а не
  -- одним числом у налаштуваннях: змінивши відсоток, не можна перерахувати
  -- заднім числом уже закриті місяці — людині вже заплачено за домовленістю,
  -- яка діяла тоді.
  CREATE TABLE IF NOT EXISTS manager_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    percent REAL NOT NULL DEFAULT 0,
    from_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS cash_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    actual_balance REAL NOT NULL,
    calc_balance REAL NOT NULL,
    diff REAL NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
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

  -- Стрічка сповіщень користувача. Зараз пишеться тільки дроперу (статуси його
  -- замовлень, ТТН/Нова Пошта, виплати), але прив'язка йде до user_id, тож той
  -- самий механізм вмикається на адміна чи склад без зміни схеми.
  -- type — категорія для бейджа в UI: status | ttn | payout.
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'status',
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    order_id INTEGER,
    payout_id INTEGER,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id,id DESC);
  CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id,is_read);
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
// Позиція замовлена під час активного переобліку: списану кількість тоді не
// чіпають, її зводять при збереженні переобліку. Позначаємо саму позицію, а не
// вираховуємо по часу створення замовлення — час має точність до секунди, і
// замовлення, створене в ту саму секунду, що й старт переобліку, списувалось
// двічі. Зі щоденним переобліком такі збіги стають реальними.
addCol("order_items","recount_session_id","INTEGER DEFAULT NULL");
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
addCol("users","balance_enabled","INTEGER DEFAULT 0");
addCol("orders","paid_from_balance","INTEGER DEFAULT 0");
addCol("payout_requests","balance_applied","REAL DEFAULT 0");
// Чи вже зняли товар з полиці за цим замовленням. Фактичний залишок
// зменшується один раз — коли пакувальник натиснув "Готово" (замовлення
// зібране), а не коли просто взяв його в роботу. Позначка потрібна, бо до
// "Зібрано" можна дійти різними шляхами (кнопкою, ручною випадачкою, скном
// пакувальниці), і списатись воно має рівно один раз незалежно від шляху.
if (addCol("orders","stock_pulled","INTEGER DEFAULT 0")) {
  // Разова міграція: за старим правилом фактична списувалась на "Взяти",
  // тож усе, що вже вийшло зі статусу "Нове", вважаємо знятим з полиці —
  // інакше такі замовлення списали б залишок удруге.
  db.prepare("UPDATE orders SET stock_pulled=1 WHERE status NOT IN ('new','cancelled')").run();
  console.log("✅ orders.stock_pulled додано і заповнено для наявних замовлень");
}
// Коли повернення лягло на полицю. Ставиться, щойно позиція з'являється
// (0 → >0), живе поки лежить, і зникає, коли її розібрали; прийде знову —
// дата буде нова. Логіка навмисно в тригері, а не в кожному ендпоінті:
// stock_returns.quantity рухається з п'яти різних місць (повернення
// замовлення, ручний set адміна, use-return, клон варіації), і будь-яке
// нове місце автоматично отримає правильну дату.
addCol("stock_returns","in_at","TEXT DEFAULT NULL");
// Переоблік складу повернень ведеться по варіації (вона несе принт), а не по
// базовому товару, тож позиція історії має вміти зберігати і те, і те.
// Скільки розмірів і скільки штук реально перерахували у цьому завданні.
// Без цих двох чисел знаменник для розбіжності взяти нізвідки: recount_items
// пишеться тільки для позицій, які розійшлись, а ті, що зійшлися, не лишають
// сліду — і виходило б, що розбіжність завжди 100%.
addCol("cycle_tasks","positions_counted","INTEGER DEFAULT 0");
addCol("cycle_tasks","units_counted","INTEGER DEFAULT 0");
addCol("recount_items","variation_id","INTEGER DEFAULT 0");
addCol("recount_sessions","scope","TEXT DEFAULT 'base'");
db.exec(`
  DROP TRIGGER IF EXISTS stock_returns_in_at;
  CREATE TRIGGER stock_returns_in_at AFTER UPDATE OF quantity ON stock_returns
  FOR EACH ROW WHEN NEW.quantity IS NOT OLD.quantity
  BEGIN
    UPDATE stock_returns SET in_at = CASE
      WHEN NEW.quantity <= 0 THEN NULL
      WHEN OLD.quantity <= 0 OR OLD.in_at IS NULL THEN datetime('now','localtime')
      ELSE OLD.in_at
    END WHERE id = NEW.id;
  END;
`);
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
// Код статусу Нової Пошти (StatusCode із TrackingDocument). Текст np_status_text
// містить назви міст і для фільтра не годиться — фільтруємо по коду. Колонка
// вже є в CREATE TABLE вище з DEFAULT 0, тож у старих замовлень там нуль —
// це і означає «коду немає», група НП тоді виводиться з внутрішнього статусу.
addCol("orders","np_status_code","INTEGER DEFAULT 0");

// День, коли клієнт забрав посилку. Досі його брали з updated_at, який
// змінюється від будь-якої дії із замовленням, через що виручка повзла
// заднім числом. Ставиться один раз і більше не рухається.
if (addCol("orders","delivered_at","TEXT DEFAULT ''")) {
  db.exec("UPDATE orders SET delivered_at=updated_at WHERE status='delivered' AND COALESCE(delivered_at,'')=''");
}
addCol("orders","refunded_amount","REAL DEFAULT 0");
addCol("orders","refunded_at","TEXT DEFAULT ''");

// Модель каси змінилась на «як у банку»: рух каси — це реальні гроші на
// рахунку (наложка/передоплата/виплата), а не заробіток складу. Раніше сюди
// писалась дроп-ціна під kind='income', і окремим рухом ще й віднімалась
// виплата дроперу — тобто його частка віднімалась двічі, а розрахунковий
// залишок накопичувально занижувався на суму всіх виплат. Дохід тепер
// рахується зі замовлень (GET /api/finance/report), а не з каси, тож старі
// рухи income лишились би задвоєним доходом поруч із новими cod/prepaid —
// прибираємо їх один раз, під прапорцем, щоб не чіпати рухи, які власник
// міг завести вручну після цієї міграції.
if (!db.prepare("SELECT value FROM settings WHERE key='cash_income_kind_removed_v1'").get()) {
  const removed = db.prepare("DELETE FROM cash_moves WHERE kind='income'").run().changes;
  db.prepare("INSERT OR REPLACE INTO settings(key,value)VALUES('cash_income_kind_removed_v1','1')").run();
  if (removed) console.log("✅ Прибрано застарілих рухів каси kind=income: " + removed + " (дохід тепер рахується зі замовлень)");
}

// Стартовий набір категорій, щоб було з чого почати. Далі власник додає й
// перейменовує свої; сідимо лише на порожній таблиці, щоб не воскрешати
// видалене.
if (!db.prepare("SELECT COUNT(*) c FROM fin_categories").get().c) {
  const insCat = db.prepare("INSERT INTO fin_categories(name,kind,is_goods,sort_order)VALUES(?,?,?,?)");
  // Назви взяті з таблиці, яку власник веде зараз, щоб він відкрив вкладку і
  // побачив звичні колонки, а не порожній список.
  [["Оренда","expense"],["Комуналка","expense"],["Реклама","expense"],["Повернення НП","expense"],
   ["Форс-мажор","expense"],["PK-CRM","expense"],["Бензин","expense"],["Браки","expense"],["Інше","expense"],
   ["Тканина","material"],["Фурнітура","material"],["Матеріали","material"],
   ["Пошив у цеху","sewing"],["Принт","sewing"],
   ["Базар","purchase"]]
    .forEach((r,i) => insCat.run(r[0], r[1], r[1] === "expense" ? 0 : 1, i));
}

// Свій цех платить швачкам зарплатою, чужий — платежем за рахунком. Ставка за
// пошив одиниці однакова в обох випадках і вводиться в крої; is_own лише
// каже системі, звідки вийдуть гроші.
addCol("workshops","is_own","INTEGER DEFAULT 1");

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

// Backfill: a ready product (no print) has a single photo on its base_product,
// which must show everywhere — base warehouse AND the dropshipper catalog.
// Older ready variations were created with an empty photo, so copy the base
// photo onto them. Idempotent (only fills empties); runs every startup.
db.exec(`UPDATE variations SET photo=(SELECT bp.photo FROM base_products bp WHERE bp.id=variations.base_product_id)
  WHERE (photo IS NULL OR photo='') AND print_id IS NULL
  AND base_product_id IN (SELECT bp.id FROM base_products bp JOIN models m ON bp.model_id=m.id WHERE m.is_ready_product=1)
  AND COALESCE((SELECT bp.photo FROM base_products bp WHERE bp.id=variations.base_product_id),'')<>''`);

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
    { code: "shipped", name: "В дорозі", color: "#10b981", sort: 4, system: 1 },
    { code: "delivered", name: "Отримано", color: "#22c55e", sort: 5, system: 0 },
    { code: "done", name: "Виконано", color: "#059669", sort: 6, system: 0 },
    { code: "refused", name: "Відмова від отримання", color: "#ef4444", sort: 7, system: 0 },
    { code: "return_transit", name: "Повертається", color: "#f97316", sort: 8, system: 0 },
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
// "Зібрано" — проміжний статус між "В роботі" і "Запаковано". Пакувальник Бази
// ставить його, зібравши речі з полиці; фінальний "Запаковано" лишається за
// пакувальницею (скан ТТН, /api/scan/finalize). Додається тут, а не в seed вище,
// бо на проді order_statuses уже заповнена. is_system — щоб адмін не видалив
// статус, на якому тримається потік складу.
if (!db.prepare("SELECT id FROM order_statuses WHERE code='collected'").get()) {
  const ip = db.prepare("SELECT sort_order FROM order_statuses WHERE code='in_progress'").get();
  const base = ip ? ip.sort_order : 2;
  db.prepare("UPDATE order_statuses SET sort_order=sort_order+1 WHERE sort_order>?").run(base);
  db.prepare("INSERT INTO order_statuses(code,name,color,sort_order,is_system)VALUES('collected','Зібрано','#14b8a6',?,1)").run(base + 1);
  console.log("✅ Додано статус 'Зібрано'");
}
// Одне замовлення — не більше однієї позиції кожного типу (успіх / повернення)
// в одному запиті. Раніше вставка йшла через INSERT OR IGNORE, але без
// унікального індексу «OR IGNORE» нічого не ігнорує: два одночасні натискання
// «Подати запит» могли додати ту саму суму двічі. Перед створенням індексу
// прибираємо дублі, якщо вони вже встигли з'явитись.
(() => {
  const dups = db.prepare(`SELECT payout_request_id,order_id,is_return,COUNT(*) c,MIN(id) keep
    FROM payout_items GROUP BY payout_request_id,order_id,is_return HAVING c>1`).all();
  if (dups.length) {
    const del = db.prepare("DELETE FROM payout_items WHERE payout_request_id=? AND order_id=? AND is_return=? AND id<>?");
    dups.forEach(d => del.run(d.payout_request_id, d.order_id, d.is_return, d.keep));
    // Суми запитів, у яких були дублі, перераховуємо під фактичні позиції.
    const prIds = [...new Set(dups.map(d => d.payout_request_id))];
    prIds.forEach(id => db.prepare(`UPDATE payout_requests SET total_amount=ROUND((SELECT COALESCE(SUM(amount),0) FROM payout_items WHERE payout_request_id=?),2) WHERE id=?`).run(id, id));
    console.log("✅ Прибрано дублі позицій у виплатах: " + dups.length + " (запитів: " + prIds.length + ")");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_items_uniq ON payout_items(payout_request_id,order_id,is_return)");
})();
// Назви статусів після відправки мають збігатися з тим, що пише Нова Пошта:
// раніше бейдж казав «Отримано», випадачка — «Доставлено», а НП — «Відправлення
// отримано», і це був один і той самий стан. Разова міграція під прапорцем, щоб
// не перезаписувати назви, якщо адмін колись перейменує їх свідомо.
if (!db.prepare("SELECT value FROM settings WHERE key='status_names_np_v1'").get()) {
  const rename = db.prepare("UPDATE order_statuses SET name=? WHERE code=?");
  [["shipped","В дорозі"],["delivering","У відділенні"],["delivered","Отримано"],
   ["refused","Відмова від отримання"],["return_transit","Повертається"]].forEach(([c,n]) => rename.run(n, c));
  db.prepare("INSERT OR REPLACE INTO settings(key,value)VALUES('status_names_np_v1','1')").run();
  console.log("✅ Назви статусів узгоджено з Новою Поштою");
}
if(!db.prepare("SELECT id FROM sizes LIMIT 1").get()){
  const s=db.prepare("INSERT INTO sizes(name,sort_order)VALUES(?,?)");
  ["XXS","XS","S","M","L","XL","2XL","3XL"].forEach((n,i)=>s.run(n,i));
}
const ups=db.prepare("INSERT OR IGNORE INTO settings(key,value)VALUES(?,?)");
Object.entries({stock_warning_threshold:"3",company_name:"ADS DROP",np_api_key:process.env.NP_API_KEY||"",sender_city:"",sender_warehouse:"",sender_phone:"",sender_name:""}).forEach(([k,v])=>ups.run(k,v));

module.exports=db;
