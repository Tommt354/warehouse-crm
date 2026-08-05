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

  // Борг = нараховано мінус оплачено, для довільного зрізу витрат. Одне
  // визначення на весь модуль: і борг постачальника (GET /api/finance/suppliers),
  // і сумарне сальдо боргу на сьогодні (GET /api/finance/report, debts_total)
  // будуються з нього — зміна формули боргу тоді не вимагає правити два місця.
  // Оплати рахуємо окремим підзапитом по id відповідних витрат, а не через
  // JOIN expenses-payments напряму: такий JOIN задвоїв би суму нарахувань,
  // коли по одній витраті є кілька часткових оплат (кожен збіг рядка витрати
  // з рядком оплати в JOIN дав би ще одне додавання e.amount).
  function debtBalanceSql(expenseWhere) {
    const filter = expenseWhere ? `WHERE ${expenseWhere}` : "";
    return `(COALESCE((SELECT SUM(e.amount) FROM expenses e ${filter}),0) -
      COALESCE((SELECT SUM(p.amount) FROM expense_payments p WHERE p.expense_id IN (SELECT id FROM expenses e ${filter})),0))`;
  }

  // Борг по постачальнику = скільки йому нарахували мінус скільки заплатили.
  // Рахуємо на льоту, а не окремою колонкою: колонка розійшлася б із фактами
  // при першій же правці витрати.
  const SUPPLIER_DEBT_SQL = debtBalanceSql("e.supplier_id=s.id");

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
    // Стеля повернення: без неї зайвий нуль у полі суми знищує залишок, а
    // виправити з інтерфейсу нема як — повернути можна не більше, ніж
    // клієнт фактично заплатив за замовлення (дроп-ціна мінус уже повернене).
    const maxRefund = round2((o.total_drop_price || 0) - (o.refunded_amount || 0));
    if (round2(amount) > maxRefund) {
      return res.status(400).json({ error: "Сума перевищує залишок, доступний до повернення (" + maxRefund + "₴)" });
    }
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

    // Дохід рахуємо із замовлень, а не з каси: каса тепер показує реальні
    // рухи рахунку (наложка/передоплата/виплата), а не заробіток складу.
    // Дохід — це дроп-ціна замовлень, забраних у періоді (delivered_at),
    // мінус повернення коштів клієнту, зроблені в цьому ж періоді (рухи
    // amount у cash_moves уже від'ємні, тож додаємо їх напряму) — інакше
    // прибуток був би завищений на суму грошей, які вже повернули клієнту.
    const deliveredIncome = sum("SELECT COALESCE(SUM(total_drop_price),0) s FROM orders WHERE delivered_at!='' AND date(delivered_at) BETWEEN ? AND ?", from, to);
    const refundsInPeriod = sum("SELECT COALESCE(SUM(amount),0) s FROM cash_moves WHERE kind IN ('refund','refund_extra') AND date BETWEEN ? AND ?", from, to);
    const income = round2(deliveredIncome + refundsInPeriod);
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

    // Борг на сьогодні, а не борг за період: скільки зараз винні
    // постачальникам загалом — те саме сальдо, що для окремого постачальника
    // (debtBalanceSql), але без фільтра, тож ідуть УСІ неоплачені залишки
    // витрат, навіть якщо власник не вказав постачальника («__T7 борг» узятий
    // просто так, без картки постачальника — гроші однаково чужі). Показник
    // навмисно не залежить від from/to: він стоїть поруч із залишком на
    // рахунку і відповідає на «скільки з того, що я бачу, насправді чуже» —
    // якби рахувати лише витрати, нараховані в обраному періоді, то в
    // спокійний тиждень без нових закупівель показник ішов би в нуль, хоча
    // борг у десятки тисяч нікуди не подівся.
    const debtsTotal = sum(`SELECT ${debtBalanceSql()} s`);

    // Прибуток за формулою власника: дохід мінус усі витрати періоду, включно
    // із закупівлями. Саме від нього рахується відсоток менеджера — це
    // домовленість із людиною, і міняти базу під нову модель обліку не можна.
    const profitCash = round2(income - opexSpent - goodsSpent);
    const mgr = db.prepare("SELECT * FROM manager_rates WHERE from_date<=? ORDER BY from_date DESC, id DESC LIMIT 1").get(to) || null;
    // Рішення власника: у збитковий період нарахування лишається від'ємним —
    // це той самий відсоток від прибутку, без обмеження знизу, бо саме так
    // рахує його власна таблиця.
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

// Каса тепер відображає реальні рухи рахунку, «як у банку» — не заробіток
// складу. Нова Пошта переказує на рахунок ВСЮ наложку, а не дроп-ціну; частку
// дропера склад віддає йому окремим рухом (onDropPayoutPaid). Записувати сюди
// дроп-ціну замість наложки означало б віднімати частку дропера двічі: раз
// тим, що в касу й так потрапляє менше за наложку, і ще раз — виплатою.
// Дохід для звіту (яким звик оперувати власник — дроп-ціна забраних посилок)
// рахується окремо, із самих замовлень: GET /api/finance/report.
function onOrderDelivered(orderId) {
  const o = db.prepare("SELECT id,cod_amount,is_prepaid,delivered_at FROM orders WHERE id=?").get(orderId);
  if (!o) return;
  if (!o.delivered_at) {
    db.prepare("UPDATE orders SET delivered_at=datetime('now','localtime') WHERE id=? AND COALESCE(delivered_at,'')=''").run(orderId);
  }
  const day = (db.prepare("SELECT delivered_at d FROM orders WHERE id=?").get(orderId).d || "").slice(0, 10);
  // Повна передоплата йде без наложки — гроші за таке замовлення вже
  // потрапили в касу при створенні (onOrderCreated), тут рухати нічого.
  if (o.is_prepaid || !o.cod_amount) return;
  addCashMove({ date: day, amount: o.cod_amount, kind: "cod", ref_type: "order", ref_id: orderId, note: "Наложка, замовлення #" + orderId });
}

// Повна передоплата: дропер платить наперед, до відправки, і гроші приходять
// на рахунок у день створення замовлення, а не в день отримання клієнтом.
// Замовлення, оплачене з балансу дропера (paid_from_balance) — виняток:
// баланс це внутрішній облік, реальних грошей на рахунок у цей момент не
// надходить, тож рух каси тут не пишемо.
function onOrderCreated(orderId) {
  const o = db.prepare("SELECT id,total_drop_price,is_prepaid,paid_from_balance,created_at FROM orders WHERE id=?").get(orderId);
  if (!o || !o.is_prepaid || o.paid_from_balance) return;
  if (!o.total_drop_price) return;
  const day = (o.created_at || "").slice(0, 10) || db.prepare("SELECT date('now','localtime') d").get().d;
  addCashMove({ date: day, amount: o.total_drop_price, kind: "prepaid", ref_type: "order", ref_id: orderId, note: "Передоплата, замовлення #" + orderId });
}

// Виплата дроперу — рух грошей, а не витрата: його частина вже виключена з
// каси тим, що в касу за наложкою потрапляє менше, ніж дроп-ціна. З рахунку
// реально виходить не тільки total_amount заявки, а й залік балансу
// (balance_applied) — та сама сума, яку бачить дропер у сповіщенні про
// виплату (POST /api/payouts/:id/paid), тож рахуємо однаково.
function onDropPayoutPaid(payoutRequestId) {
  const pr = db.prepare("SELECT id,total_amount,balance_applied,paid_at FROM payout_requests WHERE id=?").get(payoutRequestId);
  if (!pr) return;
  const amount = round2((pr.total_amount || 0) + (pr.balance_applied || 0));
  if (!amount) return;
  addCashMove({ date: (pr.paid_at || "").slice(0, 10) || db.prepare("SELECT date('now','localtime') d").get().d,
    amount: -amount, kind: "payout", ref_type: "payout", ref_id: pr.id, note: "Виплата дроперу" });
}

// Видалення замовлення не має лишати його рухи каси сиротами. Часткові
// повернення (kind='refund_extra') не мають ref_id — унікальний індекс
// cash_moves_ref_uniq дозволяє прив'язати до замовлення лише перший рух
// повернення, наступні пишуться без ref, тож для них шукаємо по мітці
// "(замовлення #N)" у нотатці, так само як /refund вирішує, який це рух.
function removeCashMovesForOrder(orderId) {
  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(orderId);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='refund' AND ref_id=?").run(orderId);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='refund_extra' AND note LIKE ?").run("%(замовлення #" + orderId + ")");
}

// Зарплата: у касу потрапляє факт виплати, а не нарахування.
function onWorkerPayout(workerPayoutId) {
  const p = db.prepare("SELECT wp.id, wp.amount, wp.created_at, w.name FROM worker_payouts wp JOIN workers w ON wp.worker_id=w.id WHERE wp.id=?").get(workerPayoutId);
  if (!p || !p.amount) return;
  addCashMove({ date: (p.created_at || "").slice(0, 10), amount: -p.amount, kind: "salary",
    ref_type: "worker_payout", ref_id: p.id, note: "Зарплата: " + p.name });
}

module.exports = { register, addCashMove, onOrderCreated, onOrderDelivered, onDropPayoutPaid, onWorkerPayout, removeCashMovesForOrder };
