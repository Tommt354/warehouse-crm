const db = require("./db");

function round2(v) { return Math.round((v || 0) * 100) / 100; }

// Ідемпотентний запис руху грошей: захист працює лише для подій зі
// стабільним зовнішнім ref_id — трекінг НП знову й знову бачить те саме
// забране замовлення, повторний виклик проведення виплати дроперу приносить
// той самий ref_id. Для витрат і оплат ref_id — це наш власний
// lastInsertRowid: повторний запит створює новий рядок з новим id, тож тут
// захист не спрацьовує і спрацьовувати не повинен.
function addCashMove({ date, amount, kind, ref_type, ref_id, note }) {
  if (ref_id) {
    const exists = db.prepare("SELECT id FROM cash_moves WHERE kind=? AND ref_type=? AND ref_id=?").get(kind, ref_type || "", ref_id);
    if (exists) return exists.id;
  }
  return db.prepare("INSERT INTO cash_moves(date,amount,kind,ref_type,ref_id,note)VALUES(?,?,?,?,?,?)")
    .run(date, round2(amount), kind, ref_type || "", ref_id || null, note || "").lastInsertRowid;
}

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

  // Борг по постачальнику = скільки йому нарахували мінус скільки заплатили.
  // Рахуємо на льоту, а не окремою колонкою: колонка розійшлася б із фактами
  // при першій же правці витрати.
  const SUPPLIER_DEBT_SQL = `COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.supplier_id=s.id),0)
    - COALESCE((SELECT SUM(p.amount) FROM expense_payments p JOIN expenses e2 ON p.expense_id=e2.id WHERE e2.supplier_id=s.id),0)`;

  app.get("/api/finance/suppliers", ...adminOnly, (req, res) => {
    res.json({ suppliers: db.prepare(`SELECT s.*, ROUND(${SUPPLIER_DEBT_SQL},2) as debt
      FROM suppliers s WHERE s.active=1 ORDER BY s.name`).all() });
  });

  app.post("/api/finance/suppliers", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Вкажіть назву постачальника" });
    const r = db.prepare("INSERT INTO suppliers(name,note)VALUES(?,?)").run(name, req.body.note || "");
    res.json({ ok: true, id: r.lastInsertRowid });
  });

  app.put("/api/finance/suppliers/:id", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Вкажіть назву постачальника" });
    db.prepare("UPDATE suppliers SET name=?,note=?,active=? WHERE id=?")
      .run(name, req.body.note || "", req.body.active === 0 ? 0 : 1, req.params.id);
    res.json({ ok: true });
  });

  const EXPENSE_ROWS = `SELECT e.*, c.name as category_name, c.is_goods, c.kind as category_kind, s.name as supplier_name,
      (SELECT w.name FROM workshops w WHERE w.id=e.workshop_id) as workshop_name,
      ROUND(COALESCE((SELECT SUM(p.amount) FROM expense_payments p WHERE p.expense_id=e.id),0),2) as paid_amount,
      ROUND(e.amount - COALESCE((SELECT SUM(p.amount) FROM expense_payments p WHERE p.expense_id=e.id),0),2) as debt
    FROM expenses e LEFT JOIN fin_categories c ON e.category_id=c.id LEFT JOIN suppliers s ON e.supplier_id=s.id`;

  app.get("/api/finance/expenses", ...adminOnly, (req, res) => {
    const from = req.query.from || db.prepare("SELECT date('now','localtime','-30 days') d").get().d;
    const to = req.query.to || db.prepare("SELECT date('now','localtime') d").get().d;
    res.json({ expenses: db.prepare(EXPENSE_ROWS + " WHERE e.date BETWEEN ? AND ? ORDER BY e.date DESC, e.id DESC").all(from, to), from, to });
  });

  // Витрата з категорією типу sewing без цеху унеможливлює звірку «скільки
  // заплачено цеху проти скільки роботи прийнято». Правило одне й те саме
  // при створенні витрати і при редагуванні (зміна категорії на sewing,
  // або зняття цеху з уже sewing-витрати) — тримаємо його в одному місці.
  function sewingExpenseHasWorkshop(categoryId, workshopId) {
    const cat = db.prepare("SELECT kind FROM fin_categories WHERE id=?").get(categoryId);
    return !(cat && cat.kind === "sewing" && !workshopId);
  }

  app.post("/api/finance/expenses", ...adminOnly, (req, res) => {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Вкажіть суму" });
    if (!req.body.category_id) return res.status(400).json({ error: "Оберіть категорію" });
    if (!sewingExpenseHasWorkshop(req.body.category_id, req.body.workshop_id)) return res.status(400).json({ error: "Оберіть цех" });
    const date = req.body.date || db.prepare("SELECT date('now','localtime') d").get().d;
    let id;
    db.transaction(() => {
      id = db.prepare("INSERT INTO expenses(date,amount,category_id,supplier_id,workshop_id,note,created_by)VALUES(?,?,?,?,?,?,?)")
        .run(date, round2(amount), req.body.category_id, req.body.supplier_id || null, req.body.workshop_id || null, req.body.note || "", req.user.id).lastInsertRowid;
      // paid=1 — гроші пішли одразу; paid=0 — це борг постачальнику, каса не рухається.
      if (req.body.paid) {
        db.prepare("INSERT INTO expense_payments(expense_id,date,amount)VALUES(?,?,?)").run(id, date, round2(amount));
        addCashMove({ date, amount: -amount, kind: "expense", ref_type: "expense", ref_id: id, note: req.body.note || "" });
      }
    })();
    res.json({ ok: true, id });
  });

  app.put("/api/finance/expenses/:id", ...adminOnly, (req, res) => {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Вкажіть суму" });
    const existing = db.prepare("SELECT * FROM expenses WHERE id=?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Витрату не знайдено" });
    const paid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM expense_payments WHERE expense_id=?").get(req.params.id).s;
    if (round2(amount) < round2(paid)) return res.status(400).json({ error: "Сума менша за вже оплачену (" + paid + "₴)" });
    // Поле, якого немає в тілі запиту (undefined), — часткове оновлення,
    // лишаємо як було; better-sqlite3 інакше впав би з TypeError на
    // undefined-параметрі. Поле, передане явно як null/порожнє, — скидаємо,
    // так само як це вже робилось для supplier_id і note.
    const date = req.body.date !== undefined ? req.body.date : existing.date;
    const category_id = req.body.category_id !== undefined ? req.body.category_id : existing.category_id;
    const supplier_id = req.body.supplier_id !== undefined ? (req.body.supplier_id || null) : existing.supplier_id;
    const workshop_id = req.body.workshop_id !== undefined ? (req.body.workshop_id || null) : existing.workshop_id;
    const note = req.body.note !== undefined ? req.body.note : existing.note;
    if (!sewingExpenseHasWorkshop(category_id, workshop_id)) return res.status(400).json({ error: "Оберіть цех" });
    db.prepare("UPDATE expenses SET date=?,amount=?,category_id=?,supplier_id=?,workshop_id=?,note=? WHERE id=?")
      .run(date, round2(amount), category_id, supplier_id, workshop_id, note, req.params.id);
    res.json({ ok: true });
  });

  app.delete("/api/finance/expenses/:id", ...adminOnly, (req, res) => {
    db.transaction(() => {
      db.prepare("DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id=?").run(req.params.id);
      db.prepare("DELETE FROM cash_moves WHERE ref_type='expense_payment' AND ref_id IN (SELECT id FROM expense_payments WHERE expense_id=?)").run(req.params.id);
      db.prepare("DELETE FROM expense_payments WHERE expense_id=?").run(req.params.id);
      db.prepare("DELETE FROM expenses WHERE id=?").run(req.params.id);
    })();
    res.json({ ok: true });
  });

  app.post("/api/finance/expenses/:id/pay", ...adminOnly, (req, res) => {
    const e = db.prepare("SELECT * FROM expenses WHERE id=?").get(req.params.id);
    if (!e) return res.status(404).json({ error: "Витрату не знайдено" });
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Вкажіть суму" });
    const paid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM expense_payments WHERE expense_id=?").get(e.id).s;
    if (round2(paid + amount) > round2(e.amount)) return res.status(400).json({ error: "Більше, ніж залишок боргу (" + round2(e.amount - paid) + "₴)" });
    const date = req.body.date || db.prepare("SELECT date('now','localtime') d").get().d;
    db.transaction(() => {
      const pid = db.prepare("INSERT INTO expense_payments(expense_id,date,amount)VALUES(?,?,?)").run(e.id, date, round2(amount)).lastInsertRowid;
      addCashMove({ date, amount: -amount, kind: "expense", ref_type: "expense_payment", ref_id: pid, note: "Оплата боргу" });
    })();
    res.json({ ok: true });
  });
}

module.exports = { register };
