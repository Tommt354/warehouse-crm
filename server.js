const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const path = require("path");
const db = require("./db");
const { createToken, authMiddleware, requireRole } = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

// ── Статичні файли (тільки login) ────────────────────────────────
app.use("/public", express.static(path.join(__dirname, "public")));

// ── AUTH ROUTES ──────────────────────────────────────────────────

// Логін
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Введіть логін і пароль" });

  const user = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(username.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: "Невірний логін або пароль" });

  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Невірний логін або пароль" });
  }

  // Оновити час останнього входу
  db.prepare("UPDATE users SET last_login = datetime('now','localtime') WHERE id = ?").run(user.id);

  const token = createToken(user);
  res.cookie("token", token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: "lax" });
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, name: user.name } });
});

// Перевірка сесії
app.get("/api/auth/me", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT id, username, role, name, phone, email, telegram, discount_percent, discount_fixed, worker_role, payout_details FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(401).json({ error: "Користувач не знайдений" });
  res.json({ user });
});

// Вихід
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

// Зміна пароля
app.post("/api/auth/change-password", authMiddleware, (req, res) => {
  const { old_password, new_password } = req.body;
  if (!new_password || new_password.length < 4) return res.status(400).json({ error: "Пароль мінімум 4 символи" });

  const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  if (old_password && !bcrypt.compareSync(old_password, user.password_hash)) {
    return res.status(400).json({ error: "Старий пароль невірний" });
  }

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(new_password, 10), req.user.id);
  res.json({ ok: true });
});

// ── USER MANAGEMENT (admin only) ─────────────────────────────────

// Список користувачів
app.get("/api/users", authMiddleware, requireRole("admin"), (req, res) => {
  const role = req.query.role;
  let users;
  if (role) {
    users = db.prepare("SELECT id, username, role, name, phone, email, telegram, discount_percent, discount_fixed, worker_role, worker_rate, active, created_at, last_login FROM users WHERE role = ? ORDER BY name").all(role);
  } else {
    users = db.prepare("SELECT id, username, role, name, phone, email, telegram, discount_percent, discount_fixed, worker_role, worker_rate, active, created_at, last_login FROM users ORDER BY role, name").all();
  }
  res.json({ users });
});

// Один користувач
app.get("/api/users/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const user = db.prepare("SELECT id, username, role, name, phone, email, telegram, discount_percent, discount_fixed, worker_role, worker_rate, payout_details, active, created_at, last_login FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "Не знайдено" });
  res.json({ user });
});

// Створити користувача
app.post("/api/users", authMiddleware, requireRole("admin"), (req, res) => {
  const { username, password, role, name, phone, email, telegram, discount_percent, discount_fixed, worker_role, worker_rate } = req.body;

  if (!username || !password || !role) return res.status(400).json({ error: "Логін, пароль і роль обов'язкові" });
  if (!["admin", "dropshipper", "warehouse"].includes(role)) return res.status(400).json({ error: "Невірна роль" });
  if (password.length < 4) return res.status(400).json({ error: "Пароль мінімум 4 символи" });

  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: "Цей логін вже зайнятий" });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, role, name, phone, email, telegram, discount_percent, discount_fixed, worker_role, worker_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    username.trim().toLowerCase(), hash, role,
    (name || "").trim(), (phone || "").trim(), (email || "").trim(), (telegram || "").trim(),
    parseFloat(discount_percent) || 0, parseFloat(discount_fixed) || 0,
    worker_role || "", parseFloat(worker_rate) || 0
  );

  const user = db.prepare("SELECT id, username, role, name FROM users WHERE id = ?").get(result.lastInsertRowid);
  res.json({ ok: true, user });
});

// Оновити користувача
app.put("/api/users/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, phone, email, telegram, discount_percent, discount_fixed, worker_role, worker_rate, active, password } = req.body;
  const id = parseInt(req.params.id);

  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "Не знайдено" });

  db.prepare(`
    UPDATE users SET name=?, phone=?, email=?, telegram=?, discount_percent=?, discount_fixed=?,
    worker_role=?, worker_rate=?, active=? WHERE id=?
  `).run(
    (name || "").trim(), (phone || "").trim(), (email || "").trim(), (telegram || "").trim(),
    parseFloat(discount_percent) || 0, parseFloat(discount_fixed) || 0,
    worker_role || "", parseFloat(worker_rate) || 0,
    active !== undefined ? (active ? 1 : 0) : 1, id
  );

  // Зміна пароля якщо вказаний
  if (password && password.length >= 4) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 10), id);
  }

  res.json({ ok: true });
});

// Видалити користувача
app.delete("/api/users/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "Не можна видалити себе" });
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ── SETTINGS (admin) ─────────────────────────────────────────────
app.get("/api/settings", authMiddleware, requireRole("admin"), (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json({ settings });
});

app.put("/api/settings", authMiddleware, requireRole("admin"), (req, res) => {
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  db.transaction(() => {
    Object.entries(req.body).forEach(([k, v]) => stmt.run(k, String(v)));
  })();
  res.json({ ok: true });
});

// ── SIZES (admin) ────────────────────────────────────────────────
app.get("/api/sizes", authMiddleware, (req, res) => {
  res.json({ sizes: db.prepare("SELECT * FROM sizes ORDER BY sort_order").all() });
});

// ── DASHBOARD STATS ──────────────────────────────────────────────
app.get("/api/dashboard", authMiddleware, (req, res) => {
  if (req.user.role === "admin") {
    res.json({
      users: db.prepare("SELECT COUNT(*) as c FROM users WHERE active=1").get().c,
      dropshippers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='dropshipper' AND active=1").get().c,
      warehouse_workers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='warehouse' AND active=1").get().c,
      orders_today: db.prepare("SELECT COUNT(*) as c FROM orders WHERE date(created_at)=date('now','localtime')").get().c,
      orders_new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='new'").get().c,
      orders_total: db.prepare("SELECT COUNT(*) as c FROM orders").get().c,
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

// Middleware для сторінок — редірект на логін замість JSON помилки
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

// Логін сторінка
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

// Головна — перенаправляє по ролі або на логін
app.get("/", (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.redirect("/login");
  const { verifyToken } = require("./auth");
  const user = verifyToken(token);
  if (!user) return res.redirect("/login");
  const pages = { admin: "/admin", dropshipper: "/drop", warehouse: "/warehouse" };
  res.redirect(pages[user.role] || "/login");
});

// Сторінки по ролях
app.get("/admin", pageAuth, pageRole("admin"), (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/admin/*", pageAuth, pageRole("admin"), (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html")));

app.get("/drop", pageAuth, pageRole("dropshipper"), (req, res) =>
  res.sendFile(path.join(__dirname, "public", "drop.html")));

app.get("/warehouse", pageAuth, pageRole("warehouse"), (req, res) =>
  res.sendFile(path.join(__dirname, "public", "warehouse.html")));

// Catch-all: не авторизований → на логін
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.redirect("/login");
});

// ── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Warehouse CRM on http://localhost:${PORT}`);
  console.log(`📋 Default login: admin / admin123`);
});
