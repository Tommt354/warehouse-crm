const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");
const db = require("./db");
const { createToken, authMiddleware, requireRole } = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;
const PHOTO_DIR = process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), "photos") : path.join(__dirname, "photos");

// Create photo directory
if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use("/photos", express.static(PHOTO_DIR));
app.use("/public", express.static(path.join(__dirname, "public")));

// ── AUTH ──────────────────────────────────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Введіть логін і пароль" });
  const user = db.prepare("SELECT * FROM users WHERE username=? AND active=1").get(username.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: "Невірний логін або пароль" });
  db.prepare("UPDATE users SET last_login=datetime('now','localtime') WHERE id=?").run(user.id);
  const token = createToken(user);
  res.cookie("token", token, { httpOnly: true, maxAge: 7*24*60*60*1000, sameSite: "lax" });
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, name: user.name } });
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT id,username,role,name,phone,email,telegram,discount_percent,discount_fixed,worker_role,payout_details FROM users WHERE id=?").get(req.user.id);
  if (!user) return res.status(401).json({ error: "Не знайдено" });
  res.json({ user });
});

app.post("/api/auth/logout", (req, res) => { res.clearCookie("token"); res.json({ ok: true }); });

// ── USERS (admin) ────────────────────────────────────────────────
app.get("/api/users", authMiddleware, requireRole("admin"), (req, res) => {
  const r = req.query.role;
  const users = r
    ? db.prepare("SELECT id,username,role,name,phone,email,telegram,discount_percent,discount_fixed,worker_role,worker_rate,active,created_at,last_login FROM users WHERE role=? ORDER BY name").all(r)
    : db.prepare("SELECT id,username,role,name,phone,email,telegram,discount_percent,discount_fixed,worker_role,worker_rate,active,created_at,last_login FROM users ORDER BY role,name").all();
  res.json({ users });
});

app.get("/api/users/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const u = db.prepare("SELECT id,username,role,name,phone,email,telegram,discount_percent,discount_fixed,worker_role,worker_rate,payout_details,active FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ error: "Не знайдено" });
  res.json({ user: u });
});

app.post("/api/users", authMiddleware, requireRole("admin"), (req, res) => {
  const { username, password, role, name, phone, email, telegram, discount_percent, discount_fixed, worker_role, worker_rate } = req.body;
  if (!username || !password || !role) return res.status(400).json({ error: "Логін, пароль і роль обов'язкові" });
  if (password.length < 4) return res.status(400).json({ error: "Пароль мінімум 4 символи" });
  if (db.prepare("SELECT id FROM users WHERE username=?").get(username.trim().toLowerCase()))
    return res.status(409).json({ error: "Логін зайнятий" });
  const r = db.prepare("INSERT INTO users (username,password_hash,role,name,phone,email,telegram,discount_percent,discount_fixed,worker_role,worker_rate) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(username.trim().toLowerCase(), bcrypt.hashSync(password,10), role, (name||"").trim(), (phone||"").trim(), (email||"").trim(), (telegram||"").trim(), parseFloat(discount_percent)||0, parseFloat(discount_fixed)||0, worker_role||"", parseFloat(worker_rate)||0);
  res.json({ ok: true, user: db.prepare("SELECT id,username,role,name FROM users WHERE id=?").get(r.lastInsertRowid) });
});

app.put("/api/users/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, phone, email, telegram, discount_percent, discount_fixed, worker_role, worker_rate, active, password } = req.body;
  db.prepare("UPDATE users SET name=?,phone=?,email=?,telegram=?,discount_percent=?,discount_fixed=?,worker_role=?,worker_rate=?,active=? WHERE id=?")
    .run((name||"").trim(), (phone||"").trim(), (email||"").trim(), (telegram||"").trim(), parseFloat(discount_percent)||0, parseFloat(discount_fixed)||0, worker_role||"", parseFloat(worker_rate)||0, active!==undefined?(active?1:0):1, req.params.id);
  if (password && password.length >= 4) db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(password,10), req.params.id);
  res.json({ ok: true });
});

app.delete("/api/users/:id", authMiddleware, requireRole("admin"), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: "Не можна видалити себе" });
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ── SETTINGS ─────────────────────────────────────────────────────
app.get("/api/settings", authMiddleware, requireRole("admin"), (req, res) => {
  const s = {}; db.prepare("SELECT key,value FROM settings").all().forEach(r => s[r.key] = r.value);
  res.json({ settings: s });
});
app.put("/api/settings", authMiddleware, requireRole("admin"), (req, res) => {
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES(?,?)");
  db.transaction(() => Object.entries(req.body).forEach(([k,v]) => stmt.run(k, String(v))))();
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// ДОВІДНИКИ
// ══════════════════════════════════════════════════════════════════

// Generic CRUD helper for simple directories
function dirRoutes(tableName, routePath) {
  app.get(`/api/${routePath}`, authMiddleware, (req, res) => {
    res.json({ items: db.prepare(`SELECT * FROM ${tableName} ORDER BY sort_order, id`).all() });
  });

  app.post(`/api/${routePath}`, authMiddleware, requireRole("admin"), (req, res) => {
    const { name, hex_code, photo, sort_order } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Назва обов'язкова" });
    const cols = ["name","sort_order"];
    const vals = [name.trim(), parseInt(sort_order)||0];
    if (hex_code !== undefined) { cols.push("hex_code"); vals.push(hex_code); }
    if (photo !== undefined) { cols.push("photo"); vals.push(photo); }
    const r = db.prepare(`INSERT INTO ${tableName} (${cols.join(",")}) VALUES(${cols.map(()=>"?").join(",")})`).run(...vals);
    res.json({ ok: true, item: db.prepare(`SELECT * FROM ${tableName} WHERE id=?`).get(r.lastInsertRowid) });
  });

  app.put(`/api/${routePath}/:id`, authMiddleware, requireRole("admin"), (req, res) => {
    const { name, hex_code, photo, sort_order, active } = req.body;
    const sets = []; const vals = [];
    if (name !== undefined) { sets.push("name=?"); vals.push(name.trim()); }
    if (hex_code !== undefined) { sets.push("hex_code=?"); vals.push(hex_code); }
    if (photo !== undefined) { sets.push("photo=?"); vals.push(photo); }
    if (sort_order !== undefined) { sets.push("sort_order=?"); vals.push(parseInt(sort_order)||0); }
    if (active !== undefined) { sets.push("active=?"); vals.push(active?1:0); }
    if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE ${tableName} SET ${sets.join(",")} WHERE id=?`).run(...vals); }
    res.json({ ok: true });
  });

  app.delete(`/api/${routePath}/:id`, authMiddleware, requireRole("admin"), (req, res) => {
    db.prepare(`DELETE FROM ${tableName} WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  });
}

dirRoutes("colors", "colors");
dirRoutes("sizes", "sizes");
dirRoutes("prints", "prints");
dirRoutes("patches", "patches");

// ══════════════════════════════════════════════════════════════════
// КАТЕГОРІЇ (дерево)
// ══════════════════════════════════════════════════════════════════

app.get("/api/categories", authMiddleware, (req, res) => {
  const all = db.prepare("SELECT * FROM categories ORDER BY sort_order, name").all();
  // Build tree
  const map = {}; const roots = [];
  all.forEach(c => { c.children = []; map[c.id] = c; });
  all.forEach(c => { if (c.parent_id && map[c.parent_id]) map[c.parent_id].children.push(c); else roots.push(c); });
  res.json({ categories: roots, flat: all });
});

app.post("/api/categories", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, parent_id, sort_order } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Назва обов'язкова" });
  const r = db.prepare("INSERT INTO categories (name,parent_id,sort_order) VALUES(?,?,?)").run(name.trim(), parent_id||null, parseInt(sort_order)||0);
  res.json({ ok: true, category: db.prepare("SELECT * FROM categories WHERE id=?").get(r.lastInsertRowid) });
});

app.put("/api/categories/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, parent_id, sort_order } = req.body;
  db.prepare("UPDATE categories SET name=?,parent_id=?,sort_order=? WHERE id=?").run(name?.trim(), parent_id||null, parseInt(sort_order)||0, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/categories/:id", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("DELETE FROM categories WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// ФОТО
// ══════════════════════════════════════════════════════════════════

app.post("/api/photos/upload", authMiddleware, requireRole("admin"), (req, res) => {
  const { data, filename } = req.body;
  if (!data) return res.status(400).json({ error: "No data" });
  // data = "data:image/jpeg;base64,/9j/4AAQ..."
  const match = data.match(/^data:image\/([\w]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: "Invalid image format" });
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const buffer = Buffer.from(match[2], "base64");
  const fname = `${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
  fs.writeFileSync(path.join(PHOTO_DIR, fname), buffer);
  res.json({ ok: true, url: `/photos/${fname}` });
});

// ══════════════════════════════════════════════════════════════════
// МОДЕЛІ + АВТОГЕНЕРАЦІЯ ТОВАРІВ
// ══════════════════════════════════════════════════════════════════

app.get("/api/models", authMiddleware, (req, res) => {
  const models = db.prepare("SELECT m.*, c.name as category_name FROM models m LEFT JOIN categories c ON m.category_id=c.id ORDER BY m.created_at DESC").all();
  // Attach relations
  models.forEach(m => {
    m.colors = db.prepare("SELECT c.* FROM model_colors mc JOIN colors c ON mc.color_id=c.id WHERE mc.model_id=? ORDER BY c.sort_order").all(m.id);
    m.sizes = db.prepare("SELECT s.* FROM model_sizes ms JOIN sizes s ON ms.size_id=s.id WHERE ms.model_id=? ORDER BY s.sort_order").all(m.id);
    m.prints = db.prepare("SELECT p.* FROM model_prints mp JOIN prints p ON mp.print_id=p.id WHERE mp.model_id=? ORDER BY p.sort_order").all(m.id);
    m.patches = db.prepare("SELECT p.* FROM model_patches mp JOIN patches p ON mp.patch_id=p.id WHERE mp.model_id=?").all(m.id);
    m.base_products_count = db.prepare("SELECT COUNT(*) as c FROM base_products WHERE model_id=?").get(m.id).c;
    m.variations_count = db.prepare("SELECT COUNT(*) as c FROM variations v JOIN base_products bp ON v.base_product_id=bp.id WHERE bp.model_id=?").get(m.id).c;
  });
  res.json({ models });
});

app.get("/api/models/:id", authMiddleware, (req, res) => {
  const m = db.prepare("SELECT m.*, c.name as category_name FROM models m LEFT JOIN categories c ON m.category_id=c.id WHERE m.id=?").get(req.params.id);
  if (!m) return res.status(404).json({ error: "Не знайдено" });
  m.colors = db.prepare("SELECT c.* FROM model_colors mc JOIN colors c ON mc.color_id=c.id WHERE mc.model_id=?").all(m.id);
  m.sizes = db.prepare("SELECT s.* FROM model_sizes ms JOIN sizes s ON ms.size_id=s.id WHERE ms.model_id=?").all(m.id);
  m.prints = db.prepare("SELECT p.* FROM model_prints mp JOIN prints p ON mp.print_id=p.id WHERE mp.model_id=?").all(m.id);
  m.patches = db.prepare("SELECT p.* FROM model_patches mp JOIN patches p ON mp.patch_id=p.id WHERE mp.model_id=?").all(m.id);
  m.base_products = db.prepare("SELECT bp.*, cl.name as color_name FROM base_products bp LEFT JOIN colors cl ON bp.color_id=cl.id WHERE bp.model_id=? ORDER BY cl.sort_order").all(m.id);
  m.base_products.forEach(bp => {
    bp.stock = db.prepare("SELECT sb.*, s.name as size_name FROM stock_base sb JOIN sizes s ON sb.size_id=s.id WHERE sb.base_product_id=? ORDER BY s.sort_order").all(bp.id);
    bp.variations = db.prepare("SELECT v.*, p.name as print_name FROM variations v LEFT JOIN prints p ON v.print_id=p.id WHERE v.base_product_id=?").all(bp.id);
  });
  res.json({ model: m });
});

// Створити модель + згенерувати товари
app.post("/api/models", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, category_id, is_ready_product, cost_price, drop_price, pack_rate, print_rate, sew_rate, distribute_rate, color_ids, size_ids, print_ids, patch_ids } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: "Назва обов'язкова" });
  if (!color_ids?.length) return res.status(400).json({ error: "Виберіть хоча б один колір" });
  if (!size_ids?.length) return res.status(400).json({ error: "Виберіть хоча б один розмір" });
  if (!is_ready_product && !print_ids?.length) return res.status(400).json({ error: "Виберіть хоча б один принт для базового товару" });

  const result = db.transaction(() => {
    // Create model
    const r = db.prepare("INSERT INTO models (name,category_id,is_ready_product,cost_price,drop_price,pack_rate,print_rate,sew_rate,distribute_rate) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(name.trim(), category_id||null, is_ready_product?1:0, parseFloat(cost_price)||0, parseFloat(drop_price)||0, parseFloat(pack_rate)||0, parseFloat(print_rate)||0, parseFloat(sew_rate)||0, parseFloat(distribute_rate)||0);
    const modelId = r.lastInsertRowid;

    // Link relations
    const linkColor = db.prepare("INSERT INTO model_colors (model_id,color_id) VALUES(?,?)");
    const linkSize = db.prepare("INSERT INTO model_sizes (model_id,size_id) VALUES(?,?)");
    const linkPrint = db.prepare("INSERT INTO model_prints (model_id,print_id) VALUES(?,?)");
    const linkPatch = db.prepare("INSERT INTO model_patches (model_id,patch_id) VALUES(?,?)");

    color_ids.forEach(id => linkColor.run(modelId, id));
    size_ids.forEach(id => linkSize.run(modelId, id));
    if (print_ids) print_ids.forEach(id => linkPrint.run(modelId, id));
    if (patch_ids) patch_ids.forEach(id => linkPatch.run(modelId, id));

    // ── ГЕНЕРАЦІЯ ТОВАРІВ ──────────────────────────────────────
    const createBP = db.prepare("INSERT INTO base_products (model_id,color_id,name) VALUES(?,?,?)");
    const createVar = db.prepare("INSERT INTO variations (base_product_id,print_id,name) VALUES(?,?,?)");
    const createStock = db.prepare("INSERT INTO stock_base (base_product_id,size_id,quantity) VALUES(?,?,0)");
    const createStockRet = db.prepare("INSERT INTO stock_returns (variation_id,size_id,quantity) VALUES(?,?,0)");

    const colors = db.prepare("SELECT * FROM colors WHERE id IN (" + color_ids.join(",") + ")").all();
    const sizes = db.prepare("SELECT * FROM sizes WHERE id IN (" + size_ids.join(",") + ")").all();
    const prints = print_ids?.length ? db.prepare("SELECT * FROM prints WHERE id IN (" + print_ids.join(",") + ")").all() : [];

    let bpCount = 0, varCount = 0;

    for (const color of colors) {
      // Create base product (per color)
      const bpName = `${name.trim()} ${color.name}`;
      const bp = createBP.run(modelId, color.id, bpName);
      const bpId = bp.lastInsertRowid;
      bpCount++;

      // Create stock entries for each size
      for (const size of sizes) {
        createStock.run(bpId, size.id);
      }

      if (is_ready_product) {
        // Ready product: 1 variation = base product itself (no print)
        const v = createVar.run(bpId, null, bpName);
        varCount++;
      } else {
        // Base product: create variation per print
        for (const print of prints) {
          const varName = `${name.trim()} ${color.name} — ${print.name}`;
          const v = createVar.run(bpId, print.id, varName);
          const varId = v.lastInsertRowid;
          varCount++;

          // Create return stock entries
          for (const size of sizes) {
            createStockRet.run(varId, size.id);
          }
        }
      }
    }

    return { modelId, bpCount, varCount };
  })();

  res.json({ ok: true, model_id: result.modelId, base_products_created: result.bpCount, variations_created: result.varCount });
});

// Додати принт/колір до існуючої моделі
app.post("/api/models/:id/add-print", authMiddleware, requireRole("admin"), (req, res) => {
  const { print_id } = req.body;
  const modelId = parseInt(req.params.id);
  const model = db.prepare("SELECT * FROM models WHERE id=?").get(modelId);
  if (!model) return res.status(404).json({ error: "Модель не знайдено" });
  if (model.is_ready_product) return res.status(400).json({ error: "Готовий товар не має принтів" });

  const print = db.prepare("SELECT * FROM prints WHERE id=?").get(print_id);
  if (!print) return res.status(404).json({ error: "Принт не знайдено" });

  const exists = db.prepare("SELECT 1 FROM model_prints WHERE model_id=? AND print_id=?").get(modelId, print_id);
  if (exists) return res.status(409).json({ error: "Цей принт вже додано" });

  db.transaction(() => {
    db.prepare("INSERT INTO model_prints (model_id,print_id) VALUES(?,?)").run(modelId, print_id);
    const sizes = db.prepare("SELECT size_id FROM model_sizes WHERE model_id=?").all(modelId);
    const bps = db.prepare("SELECT * FROM base_products WHERE model_id=?").all(modelId);

    for (const bp of bps) {
      const varName = `${model.name} ${db.prepare("SELECT name FROM colors WHERE id=?").get(bp.color_id)?.name||""} — ${print.name}`;
      const v = db.prepare("INSERT INTO variations (base_product_id,print_id,name) VALUES(?,?,?)").run(bp.id, print_id, varName);
      for (const s of sizes) {
        db.prepare("INSERT OR IGNORE INTO stock_returns (variation_id,size_id,quantity) VALUES(?,?,0)").run(v.lastInsertRowid, s.id);
      }
    }
  })();

  res.json({ ok: true });
});

app.post("/api/models/:id/add-color", authMiddleware, requireRole("admin"), (req, res) => {
  const { color_id } = req.body;
  const modelId = parseInt(req.params.id);
  const model = db.prepare("SELECT * FROM models WHERE id=?").get(modelId);
  if (!model) return res.status(404).json({ error: "Модель не знайдено" });

  const color = db.prepare("SELECT * FROM colors WHERE id=?").get(color_id);
  if (!color) return res.status(404).json({ error: "Колір не знайдено" });

  const exists = db.prepare("SELECT 1 FROM model_colors WHERE model_id=? AND color_id=?").get(modelId, color_id);
  if (exists) return res.status(409).json({ error: "Цей колір вже додано" });

  db.transaction(() => {
    db.prepare("INSERT INTO model_colors (model_id,color_id) VALUES(?,?)").run(modelId, color_id);
    const sizes = db.prepare("SELECT size_id FROM model_sizes WHERE model_id=?").all(modelId);
    const prints = db.prepare("SELECT print_id FROM model_prints WHERE model_id=?").all(modelId);

    const bpName = `${model.name} ${color.name}`;
    const bp = db.prepare("INSERT INTO base_products (model_id,color_id,name) VALUES(?,?,?)").run(modelId, color_id, bpName);
    const bpId = bp.lastInsertRowid;

    for (const s of sizes) {
      db.prepare("INSERT OR IGNORE INTO stock_base (base_product_id,size_id,quantity) VALUES(?,?,0)").run(bpId, s.id);
    }

    if (model.is_ready_product) {
      db.prepare("INSERT INTO variations (base_product_id,print_id,name) VALUES(?,NULL,?)").run(bpId, bpName);
    } else {
      for (const p of prints) {
        const pName = db.prepare("SELECT name FROM prints WHERE id=?").get(p.print_id)?.name||"";
        const v = db.prepare("INSERT INTO variations (base_product_id,print_id,name) VALUES(?,?,?)").run(bpId, p.print_id, `${bpName} — ${pName}`);
        for (const s of sizes) {
          db.prepare("INSERT OR IGNORE INTO stock_returns (variation_id,size_id,quantity) VALUES(?,?,0)").run(v.lastInsertRowid, s.id);
        }
      }
    }
  })();

  res.json({ ok: true });
});

// ── БАЗОВІ ТОВАРИ ────────────────────────────────────────────────

app.get("/api/base-products", authMiddleware, (req, res) => {
  const products = db.prepare(`
    SELECT bp.*, m.name as model_name, m.cost_price, m.drop_price, m.is_ready_product,
    c.name as color_name, c.hex_code, cat.name as category_name
    FROM base_products bp
    JOIN models m ON bp.model_id = m.id
    LEFT JOIN colors c ON bp.color_id = c.id
    LEFT JOIN categories cat ON m.category_id = cat.id
    WHERE bp.active = 1
    ORDER BY m.name, c.sort_order
  `).all();

  const sizes = db.prepare("SELECT * FROM sizes ORDER BY sort_order").all();

  products.forEach(p => {
    p.stock = {};
    const rows = db.prepare("SELECT size_id, quantity FROM stock_base WHERE base_product_id=?").all(p.id);
    rows.forEach(r => p.stock[r.size_id] = r.quantity);
    p.total_stock = rows.reduce((s, r) => s + r.quantity, 0);
  });

  res.json({ products, sizes });
});

// Оновити фото товару
app.put("/api/base-products/:id/photo", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("UPDATE base_products SET photo=? WHERE id=?").run(req.body.photo || "", req.params.id);
  res.json({ ok: true });
});

// ── ВАРІАЦІЇ (для дропшиперів) ───────────────────────────────────

app.get("/api/variations", authMiddleware, (req, res) => {
  const variations = db.prepare(`
    SELECT v.*, bp.model_id, bp.color_id, bp.name as base_name,
    m.name as model_name, m.drop_price as model_drop_price, m.is_ready_product,
    c.name as color_name, p.name as print_name, p.photo as print_photo
    FROM variations v
    JOIN base_products bp ON v.base_product_id = bp.id
    JOIN models m ON bp.model_id = m.id
    LEFT JOIN colors c ON bp.color_id = c.id
    LEFT JOIN prints p ON v.print_id = p.id
    WHERE v.active = 1 AND bp.active = 1 AND m.active = 1
    ORDER BY m.name, c.sort_order, p.sort_order
  `).all();

  const sizes = db.prepare("SELECT * FROM sizes ORDER BY sort_order").all();
  const modelSizes = {};

  variations.forEach(v => {
    // Get model sizes if not cached
    if (!modelSizes[v.model_id]) {
      modelSizes[v.model_id] = db.prepare("SELECT size_id FROM model_sizes WHERE model_id=?").all(v.model_id).map(r => r.size_id);
    }
    const mSizes = modelSizes[v.model_id];

    v.stock = {};
    v.total_stock = 0;

    for (const sizeId of mSizes) {
      // Base stock
      const base = db.prepare("SELECT quantity FROM stock_base WHERE base_product_id=? AND size_id=?").get(v.base_product_id, sizeId);
      const baseQty = base?.quantity || 0;

      if (v.print_id) {
        // For base products: stock = base + returns with this print
        const ret = db.prepare("SELECT quantity FROM stock_returns WHERE variation_id=? AND size_id=?").get(v.id, sizeId);
        const retQty = ret?.quantity || 0;
        v.stock[sizeId] = baseQty + retQty;
      } else {
        // Ready product: stock = base only
        v.stock[sizeId] = baseQty;
      }
      v.total_stock += v.stock[sizeId];
    }

    v.drop_price = v.drop_price_override || v.model_drop_price;
  });

  res.json({ variations, sizes });
});

// Оновити фото варіації
app.put("/api/variations/:id/photo", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("UPDATE variations SET photo=? WHERE id=?").run(req.body.photo || "", req.params.id);
  res.json({ ok: true });
});

// ── ПРИХІД ТОВАРУ ────────────────────────────────────────────────

app.post("/api/stock/incoming", authMiddleware, (req, res) => {
  const { base_product_id, size_id, quantity, note } = req.body;
  if (!base_product_id || !size_id || !quantity) return res.status(400).json({ error: "Всі поля обов'язкові" });
  const qty = parseInt(quantity);
  if (qty <= 0) return res.status(400).json({ error: "Кількість має бути більше 0" });

  db.transaction(() => {
    db.prepare("INSERT INTO stock_incoming (base_product_id,size_id,quantity,note,created_by) VALUES(?,?,?,?,?)")
      .run(base_product_id, size_id, qty, note||"", req.user.id);
    db.prepare("UPDATE stock_base SET quantity = quantity + ? WHERE base_product_id=? AND size_id=?")
      .run(qty, base_product_id, size_id);
  })();

  res.json({ ok: true });
});

// Масовий прихід
app.post("/api/stock/incoming-bulk", authMiddleware, (req, res) => {
  const { base_product_id, items, note } = req.body;
  if (!base_product_id || !items?.length) return res.status(400).json({ error: "Немає даних" });

  db.transaction(() => {
    for (const item of items) {
      const qty = parseInt(item.quantity);
      if (qty > 0) {
        db.prepare("INSERT INTO stock_incoming (base_product_id,size_id,quantity,note,created_by) VALUES(?,?,?,?,?)")
          .run(base_product_id, item.size_id, qty, note||"", req.user.id);
        db.prepare("UPDATE stock_base SET quantity = quantity + ? WHERE base_product_id=? AND size_id=?")
          .run(qty, base_product_id, item.size_id);
      }
    }
  })();

  res.json({ ok: true });
});

// ── DASHBOARD ────────────────────────────────────────────────────

app.get("/api/dashboard", authMiddleware, (req, res) => {
  if (req.user.role === "admin") {
    res.json({
      users: db.prepare("SELECT COUNT(*) as c FROM users WHERE active=1").get().c,
      dropshippers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='dropshipper' AND active=1").get().c,
      warehouse_workers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='warehouse' AND active=1").get().c,
      models: db.prepare("SELECT COUNT(*) as c FROM models WHERE active=1").get().c,
      base_products: db.prepare("SELECT COUNT(*) as c FROM base_products WHERE active=1").get().c,
      variations: db.prepare("SELECT COUNT(*) as c FROM variations WHERE active=1").get().c,
      orders_today: db.prepare("SELECT COUNT(*) as c FROM orders WHERE date(created_at)=date('now','localtime')").get().c,
      orders_new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='new'").get().c,
    });
  } else if (req.user.role === "dropshipper") {
    res.json({
      my_orders_total: db.prepare("SELECT COUNT(*) as c FROM orders WHERE dropshipper_id=?").get(req.user.id).c,
      my_orders_new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE dropshipper_id=? AND status='new'").get(req.user.id).c,
      my_payout: db.prepare("SELECT COALESCE(SUM(payout_amount),0) as s FROM orders WHERE dropshipper_id=? AND status='delivered'").get(req.user.id).s,
    });
  } else {
    res.json({
      orders_new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='new'").get().c,
      orders_in_progress: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='in_progress'").get().c,
      orders_packed: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='packed'").get().c,
    });
  }
});

// ── PAGE ROUTING ─────────────────────────────────────────────────

function pageAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.redirect("/login");
  const { verifyToken } = require("./auth");
  const user = verifyToken(token);
  if (!user) return res.redirect("/login");
  req.user = user;
  next();
}

function pageRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.redirect("/login");
    next();
  };
}

app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

app.get("/", (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.redirect("/login");
  const { verifyToken } = require("./auth");
  const user = verifyToken(token);
  if (!user) return res.redirect("/login");
  res.redirect({ admin: "/admin", dropshipper: "/drop", warehouse: "/warehouse" }[user.role] || "/login");
});

app.get("/admin", pageAuth, pageRole("admin"), (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/admin/*", pageAuth, pageRole("admin"), (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/drop", pageAuth, pageRole("dropshipper"), (req, res) => res.sendFile(path.join(__dirname, "public", "drop.html")));
app.get("/warehouse", pageAuth, pageRole("warehouse"), (req, res) => res.sendFile(path.join(__dirname, "public", "warehouse.html")));

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.redirect("/login");
});

app.listen(PORT, () => {
  console.log(`✅ Warehouse CRM on http://localhost:${PORT}`);
});
