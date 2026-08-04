const db = require("./db");

// Фінансовий модуль тримаємо окремо від server.js: там уже 4000+ рядків, і
// дописувати туди ще один домен означало б робити файл нечитабельним.
function register(app, { authMiddleware, requireRole }) {
  const adminOnly = [authMiddleware, requireRole("admin")];

  // Логіка витрати задається один раз — типом категорії. Власник при вводі
  // витрати обирає лише категорію, більше нічого пам'ятати не треба.
  const CATEGORY_KINDS = ["expense", "material", "sewing", "purchase"];

  app.get("/api/finance/categories", ...adminOnly, (req, res) => {
    res.json({ categories: db.prepare("SELECT * FROM fin_categories WHERE active=1 ORDER BY is_goods, sort_order, name").all(), kinds: CATEGORY_KINDS });
  });

  app.post("/api/finance/categories", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Вкажіть назву категорії" });
    const kind = req.body.kind || "expense";
    if (!CATEGORY_KINDS.includes(kind)) return res.status(400).json({ error: "Невідомий тип категорії" });
    const sort = db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 s FROM fin_categories").get().s;
    const r = db.prepare("INSERT INTO fin_categories(name,kind,is_goods,sort_order)VALUES(?,?,?,?)")
      .run(name, kind, kind === "expense" ? 0 : 1, sort);
    res.json({ ok: true, id: r.lastInsertRowid });
  });

  app.put("/api/finance/categories/:id", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Вкажіть назву категорії" });
    const kind = req.body.kind || "expense";
    if (!CATEGORY_KINDS.includes(kind)) return res.status(400).json({ error: "Невідомий тип категорії" });
    db.prepare("UPDATE fin_categories SET name=?,kind=?,is_goods=?,active=? WHERE id=?")
      .run(name, kind, kind === "expense" ? 0 : 1, req.body.active === 0 ? 0 : 1, req.params.id);
    res.json({ ok: true });
  });

  // Категорію, на якій уже висять витрати, не видаляємо фізично, а ховаємо:
  // інакше історія витрат втратила б назву категорії.
  app.delete("/api/finance/categories/:id", ...adminOnly, (req, res) => {
    const used = db.prepare("SELECT COUNT(*) c FROM expenses WHERE category_id=?").get(req.params.id).c;
    if (used) db.prepare("UPDATE fin_categories SET active=0 WHERE id=?").run(req.params.id);
    else db.prepare("DELETE FROM fin_categories WHERE id=?").run(req.params.id);
    res.json({ ok: true, hidden: !!used });
  });
}

module.exports = { register };
