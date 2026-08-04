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

  // Повернення грошей клієнту: мінус у касі й мінус у доході того дня, коли
  // повернули, а не того, коли замовлення створювалось.
  app.post("/api/finance/orders/:id/refund", ...adminOnly, (req, res) => {
    const o = db.prepare("SELECT id,total_drop_price,refunded_amount FROM orders WHERE id=?").get(req.params.id);
    if (!o) return res.status(404).json({ error: "Замовлення не знайдено" });
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Вкажіть суму повернення" });
    const date = db.prepare("SELECT date('now','localtime') d").get().d;
    const orderTag = "(замовлення #" + o.id + ")";
    // Захист від випадкового повтору того самого запиту (подвійний клік,
    // ретрай мережі). Унікальний індекс cash_moves_ref_uniq рятує лише перше
    // повернення по замовленню (воно одне пишеться з ref_id=замовлення) —
    // друге й наступні легітимні часткові повернення навмисно йдуть без
    // ref_id нижче, інакше друге часткове мовчки загубилось би через той
    // самий індекс. Тому дубль ловимо тут окремо, за сумою й ноткою: рух
    // повернення на ту саму суму по тому самому замовленню, створений щойно,
    // майже напевно і є той самий клік/ретрай, а не нове рішення повернути
    // ще раз рівно стільки ж. 5 хвилин — із запасом більше за будь-який
    // реалістичний ретрай мережі чи паузу подвійного кліку, але коротше за
    // час, за який людина встигла б усвідомлено вирішити повернути ще раз
    // ту саму суму.
    const DUPLICATE_WINDOW_MIN = 5;
    const dup = db.prepare(`SELECT id FROM cash_moves WHERE kind='refund' AND amount=? AND note LIKE ?
        AND created_at >= datetime('now','localtime','-${DUPLICATE_WINDOW_MIN} minutes')`)
      .get(round2(-amount), "%" + orderTag);
    if (dup) return res.status(409).json({ error: "Таке саме повернення щойно вже проведено — повторний запит відхилено" });
    db.transaction(() => {
      db.prepare("UPDATE orders SET refunded_amount=COALESCE(refunded_amount,0)+?,refunded_at=datetime('now','localtime') WHERE id=?")
        .run(round2(amount), o.id);
      // Одне замовлення можна повертати частинами, а унікальний індекс по ref
      // пропустить лише перший рух — далі пишемо без прив'язки до замовлення,
      // інакше друге часткове повернення мовчки загубилось би.
      const had = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='refund' AND ref_id=?").get(o.id).c;
      addCashMove({ date, amount: -amount, kind: "refund", ref_type: had ? "refund_extra" : "refund",
        ref_id: had ? null : o.id, note: (req.body.note || "Повернення коштів") + " " + orderTag });
    })();
    res.json({ ok: true });
  });

  // Стартовий залишок: система не знає, скільки було на рахунку до її появи,
  // тож власник вводить це число один раз, і від нього рахується баланс.
  const getSetting = (k, d) => {
    const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k);
    return r === undefined ? d : r.value;
  };

  app.get("/api/finance/settings", ...adminOnly, (req, res) => {
    res.json({
      cash_opening_balance: parseFloat(getSetting("cash_opening_balance", 0)) || 0,
      cash_opening_date: getSetting("cash_opening_date", "") || "",
      manager_rates: db.prepare("SELECT * FROM manager_rates ORDER BY from_date DESC, id DESC").all()
    });
  });

  // Нова ставка менеджера — новий рядок історії, а не правка старого: місяці,
  // за які вже заплачено, мають лишитись порахованими за тодішнім відсотком.
  app.post("/api/finance/manager-rate", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    const percent = parseFloat(req.body.percent);
    if (!name) return res.status(400).json({ error: "Вкажіть ім'я менеджера" });
    if (isNaN(percent) || percent < 0 || percent > 100) return res.status(400).json({ error: "Відсоток має бути від 0 до 100" });
    const from = req.body.from_date || db.prepare("SELECT date('now','localtime') d").get().d;
    db.prepare("INSERT INTO manager_rates(name,percent,from_date)VALUES(?,?,?)").run(name, percent, from);
    res.json({ ok: true });
  });

  app.put("/api/finance/settings", ...adminOnly, (req, res) => {
    const st = db.prepare("INSERT OR REPLACE INTO settings(key,value)VALUES(?,?)");
    if (req.body.cash_opening_balance !== undefined) st.run("cash_opening_balance", String(parseFloat(req.body.cash_opening_balance) || 0));
    if (req.body.cash_opening_date !== undefined) st.run("cash_opening_date", String(req.body.cash_opening_date || ""));
    res.json({ ok: true });
  });

  function calcBalance() {
    const opening = parseFloat(getSetting("cash_opening_balance", 0)) || 0;
    const since = getSetting("cash_opening_date", "") || "";
    const moves = since
      ? db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cash_moves WHERE date>=?").get(since).s
      : db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cash_moves").get().s;
    return round2(opening + moves);
  }

  app.get("/api/finance/report", ...adminOnly, (req, res) => {
    const from = req.query.from || db.prepare("SELECT date('now','localtime','-30 days') d").get().d;
    const to = req.query.to || db.prepare("SELECT date('now','localtime') d").get().d;
    const sum = (sql, ...p) => round2(db.prepare(sql).get(...p).s);

    const income = sum("SELECT COALESCE(SUM(amount),0) s FROM cash_moves WHERE kind='income' AND date BETWEEN ? AND ?", from, to);
    const cashDelta = sum("SELECT COALESCE(SUM(amount),0) s FROM cash_moves WHERE date BETWEEN ? AND ?", from, to);
    const expensesPaid = sum("SELECT COALESCE(SUM(amount),0) s FROM expense_payments WHERE date BETWEEN ? AND ?", from, to);

    // Розріз по категоріях беремо за нарахованими витратами, а не за оплатами:
    // «скільки я витратив на тканину цього місяця» — це про витрату, навіть
    // якщо частину взяв у борг.
    const byCategory = db.prepare(`SELECT c.name, c.is_goods, ROUND(SUM(e.amount),2) as amount
      FROM expenses e LEFT JOIN fin_categories c ON e.category_id=c.id
      WHERE e.date BETWEEN ? AND ? GROUP BY e.category_id ORDER BY amount DESC`).all(from, to);

    const goodsSpent = round2(byCategory.filter(c => c.is_goods).reduce((s, c) => s + c.amount, 0));
    const opexSpent = round2(byCategory.filter(c => !c.is_goods).reduce((s, c) => s + c.amount, 0));

    // Борг періоду: скільки з нарахованих у періоді витрат досі не оплачено
    // (може бути й без постачальника — «__T7 борг» узятий просто так, без
    // формальної картки постачальника). Рахуємо за датою нарахування витрати,
    // а не за датою оплати, з тих самих міркувань, що й розріз по категоріях:
    // борг належить періоду, в якому виникла витрата, і зменшується коли б
    // не прийшла оплата, навіть пізніше.
    const debtsTotal = sum(`SELECT COALESCE(SUM(e.amount - COALESCE((SELECT SUM(p.amount) FROM expense_payments p WHERE p.expense_id=e.id),0)),0) s
      FROM expenses e WHERE e.date BETWEEN ? AND ?`, from, to);

    // Прибуток за формулою власника: дохід мінус усі витрати періоду, включно
    // із закупівлями. Саме від нього рахується відсоток менеджера — це
    // домовленість із людиною, і міняти базу під нову модель обліку не можна.
    const profitCash = round2(income - opexSpent - goodsSpent);
    const mgr = db.prepare("SELECT * FROM manager_rates WHERE from_date<=? ORDER BY from_date DESC, id DESC LIMIT 1").get(to) || null;
    const managerAmount = mgr ? round2(profitCash * mgr.percent / 100) : 0;

    res.json({
      from, to, income, expenses_paid: expensesPaid, cash_delta: cashDelta,
      opening_balance: parseFloat(getSetting("cash_opening_balance", 0)) || 0,
      balance: calcBalance(),
      by_category: byCategory, goods_spent: goodsSpent, opex_spent: opexSpent,
      debts_total: debtsTotal,
      profit_cash: profitCash,
      manager: mgr ? { name: mgr.name, percent: mgr.percent, amount: managerAmount } : null,
      profit_after_manager: round2(profitCash - managerAmount),
      last_check: db.prepare("SELECT * FROM cash_checks ORDER BY id DESC LIMIT 1").get() || null
    });
  });

  // Звірка: власник вводить, скільки реально на рахунку, система показує
  // різницю з розрахунковим. Розбіжність означає, що якийсь рух не записано.
  app.post("/api/finance/cash-check", ...adminOnly, (req, res) => {
    const actual = parseFloat(req.body.actual_balance);
    if (isNaN(actual)) return res.status(400).json({ error: "Вкажіть фактичний залишок" });
    const calc = calcBalance();
    const diff = round2(actual - calc);
    db.prepare("INSERT INTO cash_checks(date,actual_balance,calc_balance,diff,note)VALUES(date('now','localtime'),?,?,?,?)")
      .run(round2(actual), calc, diff, req.body.note || "");
    res.json({ ok: true, calc_balance: calc, diff });
  });
}

// Дохід визнаємо в день, коли клієнт забрав посилку, і рівно один раз.
// Доходом вважається дроп-ціна, а не наложка: наложка приходить цілком, але
// різниця йде дроперу, тож заробіток складу — саме дроп-ціна.
function onOrderDelivered(orderId) {
  const o = db.prepare("SELECT id,total_drop_price,delivered_at FROM orders WHERE id=?").get(orderId);
  if (!o) return;
  if (!o.delivered_at) {
    db.prepare("UPDATE orders SET delivered_at=datetime('now','localtime') WHERE id=? AND COALESCE(delivered_at,'')=''").run(orderId);
  }
  const day = (db.prepare("SELECT delivered_at d FROM orders WHERE id=?").get(orderId).d || "").slice(0, 10);
  if (!o.total_drop_price) return;
  addCashMove({ date: day, amount: o.total_drop_price, kind: "income", ref_type: "order", ref_id: orderId, note: "Замовлення #" + orderId });
}

// Виплата дроперу — рух грошей, а не витрата: його частина вже виключена з
// доходу тим, що доходом рахується дроп-ціна, а не наложка. Записати її ще й
// витратою означало б відняти двічі.
function onDropPayoutPaid(payoutRequestId) {
  const pr = db.prepare("SELECT id,total_amount,paid_at FROM payout_requests WHERE id=?").get(payoutRequestId);
  if (!pr || !pr.total_amount) return;
  addCashMove({ date: (pr.paid_at || "").slice(0, 10) || db.prepare("SELECT date('now','localtime') d").get().d,
    amount: -pr.total_amount, kind: "payout", ref_type: "payout", ref_id: pr.id, note: "Виплата дроперу" });
}

// Зарплата: у касу потрапляє факт виплати, а не нарахування.
function onWorkerPayout(workerPayoutId) {
  const p = db.prepare("SELECT wp.id, wp.amount, wp.created_at, w.name FROM worker_payouts wp JOIN workers w ON wp.worker_id=w.id WHERE wp.id=?").get(workerPayoutId);
  if (!p || !p.amount) return;
  addCashMove({ date: (p.created_at || "").slice(0, 10), amount: -p.amount, kind: "salary",
    ref_type: "worker_payout", ref_id: p.id, note: "Зарплата: " + p.name });
}

module.exports = { register, addCashMove, onOrderDelivered, onDropPayoutPaid, onWorkerPayout };
