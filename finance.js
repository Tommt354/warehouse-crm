const db = require("./db");

function round2(v) { return Math.round((v || 0) * 100) / 100; }

// Одне правило добору доходу на всі запити: плитку «Надходження», список
// «Забрані» і звіт. Тримати його в трьох місцях означало б, що вони
// розійдуться при першій же правці одного з них.
//
// Дохід визнається в день, коли клієнт ЗАБРАВ посилку — і для замовлень зі
// своєю ТТН теж (рішення власника): гроші від дропера приходять наперед, але
// доходом вони стають лише коли товар реально дійшов до клієнта. Наслідок,
// про який варто знати: поки менеджер не внесе номер своєї ТТН, НП таке
// замовлення не трекає, статус не стане «Отримано» і дохід не визнається.
const INCOME_DATE_SQL = `date(o.delivered_at)`;
const INCOME_WHERE_SQL = `(o.status='delivered' AND COALESCE(o.delivered_at,'')<>'')`;


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

// Ядро створення витрати — спільне для POST /api/finance/expenses (нижче) і
// приходу рулону тканини (goods.js): власник вписав ціну рулону, і це має
// лягти в матеріали тим самим шляхом, що й будь-яка інша витрата, а не
// власним дублем логіки боргу/оплати/руху каси. paid=1 — гроші пішли
// одразу; paid=0 (чи не передано) — борг постачальнику, каса не рухається.
function createExpense({ date, amount, category_id, supplier_id, workshop_id, note, created_by, paid }) {
  let id;
  db.transaction(() => {
    id = db.prepare("INSERT INTO expenses(date,amount,category_id,supplier_id,workshop_id,note,created_by)VALUES(?,?,?,?,?,?,?)")
      .run(date, round2(amount), category_id, supplier_id || null, workshop_id || null, note || "", created_by || null).lastInsertRowid;
    if (paid) {
      db.prepare("INSERT INTO expense_payments(expense_id,date,amount)VALUES(?,?,?)").run(id, date, round2(amount));
      addCashMove({ date, amount: -amount, kind: "expense", ref_type: "expense", ref_id: id, note: note || "" });
    }
  })();
  return id;
}

// Скільки реально надійшло в касу за конкретне замовлення (наложка або
// передоплата) — спільне джерело правди для стелі ручного повернення
// (POST /api/finance/orders/:id/refund) і компенсації при скасуванні
// (compensateCancelledOrder) нижче. Навмисно не поле cod_amount/
// total_drop_price напряму: воно може розійтись із реальністю (НП
// скасувала наложку при refused/return_transit — onOrderUndelivered
// прибирає рух каси, а cod_amount у рядку замовлення лишається як був).
// У звичайному випадку (замовлення дійшло звичним шляхом) ця сума якраз і
// дорівнює cod_amount для наложки чи total_drop_price для передоплати,
// бо syncOrderCashMove тримає рух каси синхронним із сумою замовлення —
// але ніколи не дозволить рахувати "надійшло" більше, ніж реально є в касі.
function orderReceivedAmount(orderId) {
  return db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM cash_moves
    WHERE ref_type='order' AND ref_id=? AND kind IN ('cod','prepaid')`).get(orderId).s;
}

// GET /api/finance/journal (нижче в register()) показує повний журнал —
// власник хоче взяти виписку з банку й пройтись по рядках. Колонка kind у
// cash_moves сама по собі неоднозначна: і сама витрата, і оплата боргу
// пишуться з kind='expense' (різняться лише ref_type), тож для журналу
// вводимо власний "journal_kind" — рівно один код на один людський опис.
// Значення взяті з повного переліку addCashMove(...) по всьому коду
// (finance.js) — якщо колись з'явиться новий kind, якого нема в цьому
// списку, journalKindOf/JOURNAL_KIND_LABELS нижче не вигадують опис, а
// віддають сирий kind як є (щоб прогалину було видно, а не заховано за
// придуманою назвою).
const JOURNAL_KIND_LABELS = {
  cod: "Наложка від Нової Пошти",
  prepaid: "Передоплата від дропера",
  payout: "Виплата дроперу",
  expense: "Витрата",
  expense_payment: "Оплата боргу",
  refund: "Повернення коштів клієнту",
  cancel_refund: "Повернення при скасуванні замовлення",
  salary: "Зарплата",
  // Віртуальний тип: рядок не з cash_moves, а з expenses (paid=0) — грошей
  // ще не було, тож рухом каси він ніколи не стане, поки його не оплатять
  // (тоді з'явиться СВІЙ рух з journal_kind='expense_payment').
  expense_debt: "Витрата в борг (без руху грошей)"
};

// kind='expense' з ref_type='expense_payment' — оплата вже існуючого боргу,
// а не нова витрата; це єдина пара (kind,ref_type), що не мапиться 1:1 на
// journal_kind напряму.
function journalKindOf(cm) {
  if (cm.kind === "expense" && cm.ref_type === "expense_payment") return "expense_payment";
  return cm.kind;
}

// "Джерело" рядка журналу — звідки взялась сума (номер замовлення й дропер,
// категорія й постачальник витрати, працівник) — окремо від суми/дати,
// власник саме це має побачити, звіряючи журнал із випискою. За браком
// зв'язаного запису (ref_id порожній, чи запис уже видалений) віддаємо
// власний note руху — це те, що реально записав код у момент події.
function describeCashMove(cm) {
  const jkind = journalKindOf(cm);
  if (jkind === "cod" || jkind === "prepaid" || jkind === "cancel_refund") {
    const o = cm.ref_id ? db.prepare("SELECT o.id, u.name as drop_name FROM orders o LEFT JOIN users u ON o.dropshipper_id=u.id WHERE o.id=?").get(cm.ref_id) : null;
    return o ? "Замовлення #" + o.id + (o.drop_name ? " · Дропер " + o.drop_name : "") : (cm.note || "");
  }
  if (jkind === "payout") {
    const p = cm.ref_id ? db.prepare("SELECT pr.id, u.name as drop_name FROM payout_requests pr LEFT JOIN users u ON pr.dropshipper_id=u.id WHERE pr.id=?").get(cm.ref_id) : null;
    return p ? "Заявка на виплату #" + p.id + (p.drop_name ? " · Дропер " + p.drop_name : "") : (cm.note || "");
  }
  if (jkind === "expense") {
    const e = cm.ref_id ? db.prepare(`SELECT c.name as category_name, s.name as supplier_name, w.name as workshop_name, e.note
        FROM expenses e LEFT JOIN fin_categories c ON e.category_id=c.id LEFT JOIN suppliers s ON e.supplier_id=s.id LEFT JOIN workshops w ON e.workshop_id=w.id
        WHERE e.id=?`).get(cm.ref_id) : null;
    if (!e) return cm.note || "";
    return [e.category_name ? "Категорія: " + e.category_name : null, e.supplier_name ? "Постачальник: " + e.supplier_name : null,
      e.workshop_name ? "Цех: " + e.workshop_name : null].filter(Boolean).join(" · ") || (cm.note || "");
  }
  if (jkind === "expense_payment") {
    // Сама оплата пишеться з фіксованою нотою "Оплата боргу" (POST
    // .../expenses/:id/pay) — джерело тут особливо важливе, інакше в
    // журналі був би ряд однакових нічого не значущих рядків. Тягнемо його
    // з батьківської витрати через expense_payments, включно з її власною
    // нотою — саме за нею власник впізнає, який борг щойно погасили.
    const p = cm.ref_id ? db.prepare(`SELECT c.name as category_name, s.name as supplier_name, e.note
        FROM expense_payments ep LEFT JOIN expenses e ON ep.expense_id=e.id
        LEFT JOIN fin_categories c ON e.category_id=c.id LEFT JOIN suppliers s ON e.supplier_id=s.id
        WHERE ep.id=?`).get(cm.ref_id) : null;
    if (!p) return cm.note || "";
    return [p.category_name ? "Категорія: " + p.category_name : null, p.supplier_name ? "Постачальник: " + p.supplier_name : null,
      p.note ? "за витрату: " + p.note : null].filter(Boolean).join(" · ") || (cm.note || "");
  }
  if (jkind === "refund") {
    // refund_extra (друге й наступні часткові повернення того самого
    // замовлення) пишеться БЕЗ ref_id (унікальний індекс дозволяє лише
    // одну прив'язку kind+ref_type+ref_id на замовлення) — номер
    // замовлення тоді дістаємо з ноти, куди addCashMove його завжди додає.
    let orderId = cm.ref_id;
    if (!orderId) {
      const m = /замовлення #(\d+)/.exec(cm.note || "");
      orderId = m ? parseInt(m[1], 10) : null;
    }
    const o = orderId ? db.prepare("SELECT o.id, u.name as drop_name FROM orders o LEFT JOIN users u ON o.dropshipper_id=u.id WHERE o.id=?").get(orderId) : null;
    return o ? "Замовлення #" + o.id + (o.drop_name ? " · Дропер " + o.drop_name : "") : (cm.note || "");
  }
  if (jkind === "salary") {
    const w = cm.ref_id ? db.prepare("SELECT w.name FROM worker_payouts wp LEFT JOIN workers w ON wp.worker_id=w.id WHERE wp.id=?").get(cm.ref_id) : null;
    return w && w.name ? "Працівник: " + w.name : (cm.note || "");
  }
  // Невідомий kind — не вигадуємо джерело, показуємо, що є.
  return [cm.ref_type, cm.ref_id].filter(Boolean).join(" #") || (cm.note || "");
}

// Джерело для боргового (некасового) рядка — та сама структура полів, що й
// у "звичайної" витрати вище (describeCashMove, гілка jkind==='expense'),
// умисно повторена тут окремо: та гілка читає expenses ЧЕРЕЗ cash_moves.ref_id
// (руху каси в боргу якраз нема), тут — напряму з уже підвантаженого рядка.
function describeDebtExpense(e) {
  return [e.category_name ? "Категорія: " + e.category_name : null, e.supplier_name ? "Постачальник: " + e.supplier_name : null,
    e.workshop_name ? "Цех: " + e.workshop_name : null].filter(Boolean).join(" · ") || (e.note || "");
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
    const id = createExpense({
      date, amount, category_id: req.body.category_id, supplier_id: req.body.supplier_id,
      workshop_id: req.body.workshop_id, note: req.body.note, created_by: req.user.id, paid: req.body.paid
    });
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
    db.transaction(() => {
      db.prepare("UPDATE expenses SET date=?,amount=?,category_id=?,supplier_id=?,workshop_id=?,note=? WHERE id=?")
        .run(date, round2(amount), category_id, supplier_id, workshop_id, note, req.params.id);
      // Дата витрати рухає за собою лише ТУ оплату, що виникла РАЗОМ із
      // витратою (paid=1 при створенні, POST /api/finance/expenses вище) —
      // її "дата" ніколи не була окремим рішенням, а просто копією дати
      // витрати в момент створення. Впізнаємо її не за збігом дати (окрема
      // оплата боргу через POST /pay могла випадково лягти на той самий
      // день — власник саме так і працює: записав борг сьогодні, того ж дня
      // переказав частину), а за руху каси з ref_type='expense' і
      // ref_id=ця витрата — його адресує лише авто-оплата, і саме через неї
      // ми знаходимо відповідний рядок expense_payments: жодна ручна оплата
      // (POST /pay) не може існувати раніше, ніж сама витрата (вона вимагає
      // вже існуючого expense_id), тож авто-оплата завжди має найменший id
      // серед expense_payments цієї витрати. Немає руху з ref_type='expense'
      // — paid=0 при створенні, боргу тоді ще не було, і рухати нічого.
      if (date !== existing.date) {
        const bornMove = db.prepare("SELECT id FROM cash_moves WHERE ref_type='expense' AND ref_id=?").get(req.params.id);
        if (bornMove) {
          const bornPayment = db.prepare("SELECT id FROM expense_payments WHERE expense_id=? ORDER BY id ASC LIMIT 1").get(req.params.id);
          if (bornPayment) db.prepare("UPDATE expense_payments SET date=? WHERE id=?").run(date, bornPayment.id);
          db.prepare("UPDATE cash_moves SET date=? WHERE id=?").run(date, bornMove.id);
        }
        // Оплати боргу, зроблені ОКРЕМО (POST /pay, свідомо іншим днем —
        // реальна дата виходу грошей з рахунку), і їхні рухи каси
        // (ref_type='expense_payment') тут навмисно не чіпаються: посунути
        // їх разом із правкою заголовка витрати означало б задатувати
        // реальний рух каси днем, коли з рахунку насправді нічого не
        // виходило.
      }
    })();
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

  // Стеля ручного повернення — те саме число, яким нижче керується POST
  // .../refund (orderReceivedAmount мінус уже повернене), винесене в окремий
  // GET, щоб модалка «Повернення» (public/finance.js openOrderRefund) могла
  // спитати бекенд ПЕРЕД тим, як показати суму власнику, а не рахувати свою
  // копію з полів замовлення (o.total_drop_price / o.cod_amount) — саме та
  // копія показувала повну суму для замовлення, яке отримали, а потім НП
  // повернула (onOrderUndelivered прибрав прихід із каси, реальна стеля 0),
  // тож модалка обіцяла те, що бекенд гарантовано відхилив би.
  app.get("/api/finance/orders/:id/refund-ceiling", ...adminOnly, (req, res) => {
    const o = db.prepare("SELECT id,refunded_amount FROM orders WHERE id=?").get(req.params.id);
    if (!o) return res.status(404).json({ error: "Замовлення не знайдено" });
    const received = orderReceivedAmount(o.id);
    const max = Math.max(0, round2(received - (o.refunded_amount || 0)));
    res.json({ received, refunded: round2(o.refunded_amount || 0), max });
  });

  // Повернення грошей клієнту: мінус у касі й мінус у доході того дня, коли
  // повернули, а не того, коли замовлення створювалось.
  app.post("/api/finance/orders/:id/refund", ...adminOnly, (req, res) => {
    const o = db.prepare("SELECT id,refunded_amount FROM orders WHERE id=?").get(req.params.id);
    if (!o) return res.status(404).json({ error: "Замовлення не знайдено" });
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Вкажіть суму повернення" });
    // Стеля повернення: раніше стелею завжди була дроп-ціна — для наложки
    // це неправильно, бо клієнт по наложці платить cod_amount, який
    // зазвичай БІЛЬШИЙ за дроп-ціну (різниця — маржа складу), і повернути
    // йому реальну суму було неможливо. Стеля тепер — сума РЕАЛЬНИХ
    // приходів каси за це замовлення (orderReceivedAmount): для наложки це
    // й буде cod_amount, для передоплати — total_drop_price, оскільки
    // syncOrderCashMove тримає рух каси синхронним із сумою замовлення;
    // при цьому підхід сам захищає від переплати повернення там, де грошей
    // насправді ще нема (замовлення ще не забрали) чи вже нема (НП
    // скасувала наложку — onOrderUndelivered прибрав рух каси). Те саме
    // число віддає GET .../refund-ceiling вище — умисно однаковий вираз, щоб
    // модалка ніколи не розійшлась із тим, що бекенд справді дозволить.
    const maxRefund = round2(orderReceivedAmount(o.id) - (o.refunded_amount || 0));
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
    // Чи за це замовлення дроперу вже реально заплатили: від цього залежить,
    // чи можна зняти виплату автоматично, чи лише повідомити адміна.
    const paidRow = db.prepare(`SELECT COALESCE(SUM(pi.amount),0) s FROM payout_items pi
      JOIN payout_requests pr ON pi.payout_request_id=pr.id
      WHERE pi.order_id=? AND pr.status='paid' AND pi.is_return=0`).get(o.id);
    const paidPayout = paidRow ? paidRow.s : 0;
    const alreadyPaid = paidPayout > 0;
    db.transaction(() => {
      db.prepare("UPDATE orders SET refunded_amount=COALESCE(refunded_amount,0)+?,refunded_at=datetime('now','localtime') WHERE id=?")
        .run(round2(amount), o.id);
      // Одне замовлення можна повертати частинами, а унікальний індекс по ref
      // пропустить лише перший рух — далі пишемо без прив'язки до замовлення,
      // інакше друге часткове повернення мовчки загубилось би.
      const had = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='refund' AND ref_id=?").get(o.id).c;
      addCashMove({ date, amount: -amount, kind: "refund", ref_type: had ? "refund_extra" : "refund",
        ref_id: had ? null : o.id, note: (req.body.note || "Повернення коштів") + " " + orderTag });

      // Повернули гроші клієнту — дропер за це замовлення не отримує нічого
      // (рішення власника): виплата знімається повністю, наш заробіток
      // зменшується на суму повернення, а собівартість повертається на склад
      // разом із товаром (це вже робить лінія товару при поверненні на полицю).
      if (!alreadyPaid) {
        db.prepare("UPDATE orders SET payout_amount=0 WHERE id=?").run(o.id);
        // Незакритий запит на виплату перескладається під новий стан — інакше
        // у ньому лишилась би стара сума за це замовлення.
        db.prepare(`DELETE FROM payout_items WHERE order_id=? AND payout_request_id IN
          (SELECT id FROM payout_requests WHERE status<>'paid')`).run(o.id);
      }
    })();
    // Якщо гроші дроперу вже виплачені, автоматично їх не забираємо — це
    // давнє правило власника: виплачене замовлення система сама не чіпає
    // ніколи, перерахунок іде вручну через баланс. Повертаємо суму, яку
    // адміну треба закрити руками.
    res.json({ ok: true, payout_already_paid: alreadyPaid, payout_to_settle: alreadyPaid ? round2(paidPayout) : 0 });
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
    // Дата старту має існувати завжди: без неї calcBalance підсумовував би
    // ВСЮ історію рухів каси, а не лише те, що сталось після дати, з якої
    // власник почав рахунок. Небезпечно саме мовчазне порожнє значення —
    // одразу після деплою трекінг НП заднім числом проводить прихід
    // наложкою по старих замовленнях, і власник, щойно ввівши стартовий
    // залишок, бачить його роздутим на всю історичну наложку без пояснення.
    // Модалка (public/finance.js openFinSettings) тепер сама префілює поле
    // сьогоднішнім днем, але бекенд не покладається на фронтенд: якщо разом
    // із сумою дату явно не передали (порожній рядок так само, як undefined),
    // підставляємо сьогодні тут.
    const date = req.body.cash_opening_date
      ? String(req.body.cash_opening_date)
      : (req.body.cash_opening_balance !== undefined ? db.prepare("SELECT date('now','localtime') d").get().d : undefined);
    if (date !== undefined) st.run("cash_opening_date", date);
    res.json({ ok: true });
  });

  function calcBalance() {
    const opening = parseFloat(getSetting("cash_opening_balance", 0)) || 0;
    // Дата старту порожня лише до першого налаштування (PUT вище тепер
    // завжди її проставляє разом із сумою). Захисний фолбек на "сьогодні",
    // а не на "з нуля по всій історії": свіжий деплой, у якому власник ще
    // не встиг відкрити модалку стартового залишку, інакше миттю проковтнув
    // би в баланс усю історичну наложку, яку трекінг НП заднім числом
    // допише по старих замовленнях.
    const since = getSetting("cash_opening_date", "") || db.prepare("SELECT date('now','localtime') d").get().d;
    const moves = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cash_moves WHERE date>=?").get(since).s;
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
    // status='delivered' — навмисний дубль до delivered_at!='': delivered_at
    // навмисно НІКОЛИ не чиститься (навіть коли замовлення виходить зі
    // статусу delivered — finance.onOrderUndelivered прибирає лише прихід
    // каси, дату лишає, інакше повторне отримання проставило б її
    // сьогоднішнім днем і дохід/каса тихо переїхали б у інший, можливо вже
    // закритий місяць). Тож саме статус, а не порожня дата, відсікає
    // повернену посилку з доходу — прибирати цю умову не можна. Те саме
    // правило в GET /api/dashboard/accounting (server.js), щоб два екрани
    // доходу ніколи не розходились між собою.
    const deliveredIncome = sum(`SELECT COALESCE(SUM(o.total_drop_price),0) s FROM orders o
      WHERE ${INCOME_WHERE_SQL} AND ${INCOME_DATE_SQL} BETWEEN ? AND ?`, from, to);
    // Повернення коштів завжди пишуться з kind='refund' — 'refund_extra' це
    // значення ref_type (друге й наступні часткові повернення без ref_id,
    // див. addCashMove у POST /api/finance/orders/:id/refund), а не kind.
    // Раніше тут стояло kind IN ('refund','refund_extra') — 'refund_extra'
    // ніколи не збігалось із kind, тож умова була дублем kind='refund' і
    // працювала правильно лише випадково.
    const refundsInPeriod = sum("SELECT COALESCE(SUM(amount),0) s FROM cash_moves WHERE kind='refund' AND date BETWEEN ? AND ?", from, to);
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

  // Розшифровка плитки «Надходження»: власник бачить суму, але не бачить,
  // з яких саме посилок вона складається. Правило добору — те саме
  // INCOME_WHERE_SQL/INCOME_DATE_SQL, що й у плитці, тому список і плитка
  // не можуть розійтися.
  app.get("/api/finance/delivered", ...adminOnly, (req, res) => {
    const from = req.query.from || db.prepare("SELECT date('now','localtime','-30 days') d").get().d;
    const to = req.query.to || db.prepare("SELECT date('now','localtime') d").get().d;
    const orders = db.prepare(`SELECT o.id, o.ttn, o.delivered_at, o.total_drop_price, o.cod_amount, o.refunded_amount,
        o.own_ttn, ${INCOME_DATE_SQL} as income_date, u.name as drop_name
      FROM orders o JOIN users u ON o.dropshipper_id=u.id
      WHERE ${INCOME_WHERE_SQL} AND ${INCOME_DATE_SQL} BETWEEN ? AND ?
      ORDER BY income_date DESC, o.id DESC`).all(from, to);
    const dropPriceSum = round2(orders.reduce((s, o) => s + (o.total_drop_price || 0), 0));
    const codSum = round2(orders.reduce((s, o) => s + (o.cod_amount || 0), 0));
    // Повернення коштів, зроблені в цьому періоді — той самий підзапит, що й
    // refundsInPeriod у GET /api/finance/report. Повернення необов'язково
    // прив'язане до замовлення зі списку вище (гроші можна повернути іншого
    // дня, ніж забрали посилку), тож рахуємо його окремо, а не по рядках
    // orders.refunded_amount: сумувати останні означало б і чужі періоди.
    const refundsInPeriod = round2(db.prepare(
      "SELECT COALESCE(SUM(amount),0) s FROM cash_moves WHERE kind='refund' AND date BETWEEN ? AND ?"
    ).get(from, to).s);
    res.json({
      from, to, orders,
      count: orders.length,
      drop_price_sum: dropPriceSum,
      cod_sum: codSum,
      refunds_in_period: refundsInPeriod,
      // Має точно збігатись із income з GET /api/finance/report за той самий
      // період — це і є перевірка, яку бачить власник у підсумковому рядку.
      income_check: round2(dropPriceSum + refundsInPeriod)
    });
  });

  // Повний журнал усіх операцій — інструмент довіри до системи: власник бере
  // виписку з банку й проходиться по рядках. Тому наростаючий підсумок
  // рахуємо від cash_opening_date (той самий "since", яким керується
  // calcBalance), а НЕ від "from" обраного періоду: інакше "залишок після" у
  // межах короткого періоду був би відірваний від реального рахунку, і
  // останній рядок журналу перестав би збігатись зі звітом.
  app.get("/api/finance/journal", ...adminOnly, (req, res) => {
    const from = req.query.from || db.prepare("SELECT date('now','localtime','-30 days') d").get().d;
    const to = req.query.to || db.prepare("SELECT date('now','localtime') d").get().d;
    const kindFilter = req.query.kind || "";
    const since = getSetting("cash_opening_date", "") || db.prepare("SELECT date('now','localtime') d").get().d;
    const opening = parseFloat(getSetting("cash_opening_balance", 0)) || 0;

    // Хронологічно ЗРОСТАЮЧИЙ прохід від старту обліку до кінця обраного
    // періоду (не від "from"!) — тільки так залишок після кожного рядка є
    // правдою про рахунок станом на "to", а не числом, порахованим лише за
    // видиму частину журналу.
    const movesAsc = db.prepare("SELECT * FROM cash_moves WHERE date BETWEEN ? AND ? ORDER BY date ASC, id ASC").all(since, to);
    let running = opening;
    const enriched = movesAsc.map(cm => {
      running = round2(running + cm.amount);
      const jkind = journalKindOf(cm);
      return {
        id: "cm-" + cm.id, date: cm.date, created_at: cm.created_at,
        kind: cm.kind, journal_kind: jkind, kind_label: JOURNAL_KIND_LABELS[jkind] || null,
        amount: cm.amount, is_cash: true, balance_after: running,
        source: describeCashMove(cm), note: cm.note || "",
        ref_type: cm.ref_type, ref_id: cm.ref_id
      };
    });

    // "Залишок на кінець" обраного періоду — це залишок після останнього
    // руху хронологічного проходу вище, а НЕ calcBalance(): та функція не
    // має верхньої межі й завжди показує стан "на зараз", тоді як тут
    // власник міг обрати період, що закінчується в минулому. Коли to —
    // сьогодні (типовий випадок) і в базі нема рухів із датою в майбутньому,
    // ці два числа збігаються — саме це і є перевірка "журнал = звіт".
    const balanceEnd = enriched.length ? enriched[enriched.length - 1].balance_after : opening;

    // Борг: витрата, заведена paid=0, — гроші ще не пішли, тож рухом каси
    // вона не стає ніколи (навіть якщо пізніше її частково погасять — та
    // оплата вже прийде своїм окремим реальним рухом, ref_type='expense_payment',
    // він уже є в enriched вище). Ознака "не оплачена одразу" — відсутність
    // "народжуючого" руху (ref_type='expense', ref_id=e.id): POST
    // /api/finance/expenses пише його лише коли paid=1.
    const debtExpenses = db.prepare(`
      SELECT e.*, c.name as category_name, s.name as supplier_name, w.name as workshop_name
      FROM expenses e
      LEFT JOIN fin_categories c ON e.category_id=c.id
      LEFT JOIN suppliers s ON e.supplier_id=s.id
      LEFT JOIN workshops w ON e.workshop_id=w.id
      WHERE e.date BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM cash_moves cm WHERE cm.ref_type='expense' AND cm.ref_id=e.id)
      ORDER BY e.date ASC, e.id ASC
    `).all(from, to);
    const debtRows = debtExpenses.map(e => ({
      id: "debt-" + e.id, date: e.date, created_at: e.created_at,
      kind: "expense", journal_kind: "expense_debt", kind_label: JOURNAL_KIND_LABELS.expense_debt,
      // Сума — інформаційна (яким був би розхід, якби оплатили одразу), тому
      // й amount != 0, але balance_after=null нижче явно каже: у підсумок
      // рахунку це число не входить.
      amount: -round2(e.amount), is_cash: false, balance_after: null,
      source: describeDebtExpense(e), note: e.note || "",
      ref_type: "expense", ref_id: e.id
    }));

    // Показ обмежуємо обраним періодом (from — на відміну від нижньої межі
    // розрахунку залишку, яка навмисно ширша, від since), плюс необов'язковий
    // фільтр за типом. Підсумки нижче рахуються ДО фільтра — він лише лінза
    // на таблицю, а не спосіб змінити "скільки прийшло/пішло за період".
    const periodCash = enriched.filter(r => r.date >= from);
    let rows = periodCash.concat(debtRows);
    if (kindFilter) rows = rows.filter(r => r.journal_kind === kindFilter);

    // Найновіші зверху; у межах одного дня реальні рухи йдуть перед борговими
    // (боргові рядки не впливають на залишок, тож їхнє місце в тай-брейку не
    // міняє суті — лише узгоджений порядок показу).
    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.is_cash !== b.is_cash) return a.is_cash ? -1 : 1;
      const aid = parseInt(String(a.id).split("-")[1], 10), bid = parseInt(String(b.id).split("-")[1], 10);
      return bid - aid;
    });

    const income = round2(periodCash.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0));
    const outcome = round2(periodCash.filter(r => r.amount < 0).reduce((s, r) => s - r.amount, 0));

    res.json({
      from, to, kind: kindFilter,
      rows,
      summary: { income, outcome, net: round2(income - outcome), balance_end: balanceEnd },
      kinds: Object.keys(JOURNAL_KIND_LABELS).map(k => ({ value: k, label: JOURNAL_KIND_LABELS[k] }))
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

// Суми замовлення (наложка, дроп-ціна передоплати) інколи міняються вже
// ПІСЛЯ того, як каса записала прихід за старою сумою — адмін править
// наложку доставленого замовлення (PUT /api/orders/:id/edit), або хтось
// додає позицію чи міняє товар у передоплаченому замовленні, чия
// передоплата вже влетіла в касу при створенні. Рух каси має лишатись
// правдою про рахунок, а не другим записом поруч зі старим: приводимо вже
// записаний рух до нової суми. UPDATE торкається лише kind/ref_type/ref_id,
// що вже існують — якщо руху ще нема (наложка ще не доставлена, або
// передоплата йде з балансу дропера й у касу взагалі не пишеться), UPDATE
// нічого не знаходить і мовчки нічого не робить, що й треба: рух з'явиться
// сам, коли настане його момент (onOrderDelivered), уже з правильною сумою.
function syncOrderCashMove(orderId) {
  const o = db.prepare("SELECT id,cod_amount,total_drop_price,is_prepaid,paid_from_balance FROM orders WHERE id=?").get(orderId);
  if (!o) return;
  // Сума впала до нуля (наложку прибрали, дроп-ціну звели правкою до 0) —
  // прибираємо рух, а не лишаємо порожній рядок на 0₴: при створенні
  // нульова сума руху й так не породжує (addCashMove не викликається),
  // тож синхронізація має приводити до того самого стану, а не лишати слід
  // від суми, якої більше нема.
  if (!o.is_prepaid) {
    const amt = round2(o.cod_amount || 0);
    if (amt) db.prepare("UPDATE cash_moves SET amount=? WHERE kind='cod' AND ref_type='order' AND ref_id=?").run(amt, orderId);
    else db.prepare("DELETE FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").run(orderId);
  } else if (!o.paid_from_balance) {
    const amt = round2(o.total_drop_price || 0);
    if (amt) db.prepare("UPDATE cash_moves SET amount=? WHERE kind='prepaid' AND ref_type='order' AND ref_id=?").run(amt, orderId);
    else db.prepare("DELETE FROM cash_moves WHERE kind='prepaid' AND ref_type='order' AND ref_id=?").run(orderId);
  }
}

// Замовлення, що стало delivered, а потім вийшло з цього статусу — НП
// повернула посилку (refused/return_transit) чи хтось відкотив статус
// вручну — більше не має рахуватись як забране: прихід наложкою, який
// onOrderDelivered записав, знімаємо. delivered_at навмисно НЕ чистимо
// (це був регрес попереднього раунду): обидва місця, що рахують дохід за
// днем отримання (GET /api/finance/report тут і GET /api/dashboard/accounting
// у server.js), і так фільтрують status='delivered' першим — статус уже
// відсікає повернену посилку з доходу без порожньої дати. А от чищення дати
// шкодило: круговий рейс delivered → refused → delivered знову проставляв
// delivered_at СЬОГОДНІШНІМ днем замість того, щоб лишити день, коли посилку
// справді забрали вперше — дохід і каса тихо переїжджали в інший (можливо
// вже закритий) місяць. Рух каси прибирається тим самим шляхом, яким
// з'явився б заново: addCashMove не задвоїть його при повторному
// onOrderDelivered завдяки unique-індексу (kind,ref_type,ref_id), а сама
// дата руху візьметься зі збереженого delivered_at — того самого, вихідного.
function onOrderUndelivered(orderId) {
  db.prepare("DELETE FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").run(orderId);
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
  // Від'ємний підсумок сюди дійти не повинен — маршрут PUT /api/payouts/:id/paid
  // блокує його раніше. Сьогодні викликач один, але хелпер не повинен
  // покладатись на це: захисний ранній вихід тут коштує рядок, а без нього
  // помилка в майбутньому виклику мовчки написала б у касу плюс замість мінуса.
  if (amount <= 0) return;
  addCashMove({ date: (pr.paid_at || "").slice(0, 10) || db.prepare("SELECT date('now','localtime') d").get().d,
    amount: -amount, kind: "payout", ref_type: "payout", ref_id: pr.id, note: "Виплата дроперу" });
}

// Видалення замовлення (DELETE /api/orders/:id) прибирає рядок orders
// повністю — замовлення зникає з історії, тож і його рухам каси нема на що
// посилатись, вони стали б сиротами. Це БЕЗПЕЧНО лишити як є (сирота без
// orders-рядка): жоден екран модуля не підтягує рухи каси через JOIN з
// orders, лише сумує їх напряму.
//
// Критерій "стирати чи ні" — НЕ статус замовлення (це був баг попереднього
// раунду): статус нічого не каже про те, чи реально рухались гроші.
// Підтверджені випадки, де стара версія (статус==='delivered' → лишити,
// інакше стерти все) ламала касу:
//   а) delivered → часткове повернення клієнту (реальний розхід) →
//      НП повернула посилку (refused/return_transit, onOrderUndelivered
//      прибрав лише 'cod') → видалення. Стара версія стирала заразом і
//      РЕАЛЬНЕ повернення (ref_type='refund') — залишок стрибав угору.
//   б) передоплачене замовлення, ще НЕ отримане (packed/shipped — скасування
//      там уже недоступне, видалення єдиний шлях). Прихід передоплатою вже
//      реально на рахунку (onOrderCreated), стара версія стирала його
//      просто через DELETE FROM cash_moves — залишок падав нижче виписки.
//
// Правильна модель — та сама, що вже працює для скасування: історію
// НІКОЛИ не стираємо (жодного DELETE тут більше нема — ні для 'order', ні
// для 'refund'/'refund_extra'), а там, де гроші реально прийшли й товар
// так і не поїде, пишемо ЗУСТРІЧНИЙ розхід компенсацією.
//   - "delivered": товар клієнт отримав, гроші зароблені законно — нічого
//     не робимо.
//   - "cancelled": замовлення вже пройшло /cancel, яке саме викликало
//     compensateCancelledOrder — повторний виклик тут або нічого не додав
//     би (unique-індекс), або (гірше) удруге підняв би orders.refunded_amount
//     без нового реального руху каси, тож свідомо пропускаємо.
//   - решта статусів: та сама compensateCancelledOrder, що й при скасуванні
//     — вона сама рахує, скільки лишилось некомпенсованим (orderReceivedAmount
//     мінус вже повернене), і нічого не пише, якщо коштів не було (case а:
//     onOrderUndelivered уже прибрав 'cod', лишається лише 'refund', який
//     ми й так не стираємо).
// Різниця delete-vs-cancel лише в тому, що рядок orders одразу зникає
// (cancel лишає його в історії зі статусом "cancelled") — самій компенсації
// це байдуже, вона звертається до orders.id ДО видалення рядка (виклик тут
// відбувається раніше за DELETE FROM orders, server.js).
function removeCashMovesForOrder(orderId, orderStatus, dateStr) {
  if (orderStatus === "delivered" || orderStatus === "cancelled") return;
  compensateCancelledOrder(orderId, dateStr, "видалене замовлення");
}

// Скасування (POST /api/orders/:id/cancel), на відміну від видалення, лишає
// замовлення в історії зі статусом "cancelled" — тож і його рухи каси мають
// лишитись правдою про рахунок, а не зникнути. Попередній раунд помилково
// підключив сюди removeCashMovesForOrder: це стирало разом зі старим
// приходом (який справедливо піти при скасуванні — товар не поїде,
// передоплату треба повернути) ще й РЕАЛЬНЕ повернення коштів клієнту
// (kind='refund') — гроші, які вже вийшли з рахунку. Стерти цей рух означає
// назавжди завищити розрахунковий залишок на суму повернення.
// Правильна модель для каси-як-виписки — не стирати історію, а
// компенсувати: скільки грошей за це замовлення реально надійшло (наложка
// вже неможлива для скасовуваних статусів new/in_progress/collected —
// посилку ще не забрали, лишається лише передоплата) мінус те, що вже
// повернули клієнту. Якщо лишок додатний — на дату скасування пишемо
// зустрічний розхід на цю суму (гроші, які склад тепер має повернути
// дроперу за товар, який так і не поїде), не займаючи жодного вже
// записаного руху. Якщо надходжень не було (звичайне COD-замовлення до
// отримання) — не робимо нічого: рух повернення, якщо він був, так і
// лишається в касі, як і має бути.
//
// reason — лише текст нотатки: той самий хелпер викликає й removeCashMovesForOrder
// (видалення замовлення) з іншим формулюванням, суть компенсації однакова.
function compensateCancelledOrder(orderId, dateStr, reason) {
  const income = orderReceivedAmount(orderId);
  if (!income) return;
  const refunded = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM cash_moves
    WHERE kind='refund' AND ((ref_type='refund' AND ref_id=?) OR (ref_type='refund_extra' AND note LIKE ?))`)
    .get(orderId, "%(замовлення #" + orderId + ")").s; // від'ємна сума
  const remaining = round2(income + refunded);
  if (remaining <= 0) return;
  const date = dateStr || db.prepare("SELECT date('now','localtime') d").get().d;
  // ref_type='order' + свій kind — той самий шаблон ідентифікації руху, що
  // й у cod/prepaid, тож повторний виклик на вже скасованому замовленні
  // (наприклад помилковий подвійний клік) не задвоїть розхід.
  addCashMove({ date, amount: -remaining, kind: "cancel_refund", ref_type: "order", ref_id: orderId,
    note: "Повернення передоплати за " + (reason || "скасоване замовлення") + " #" + orderId });
  // Стеля ручного повернення (POST /api/finance/orders/:id/refund) рахується
  // як orderReceivedAmount мінус refunded_amount. Компенсація вище — це так
  // само гроші, що щойно вийшли з рахунку за це замовлення, просто іншим шляхом
  // (зустрічний розхід, а не кнопка «Повернення»). Без цього рядка стеля
  // лишалась би на повну суму, і адмін міг би натиснути «Повернення» ще раз
  // на суму, яку компенсація щойно повернула — подвійне списання з
  // розрахункового залишку на рівному місці.
  db.prepare("UPDATE orders SET refunded_amount=COALESCE(refunded_amount,0)+? WHERE id=?").run(remaining, orderId);
}

// Зарплата: у касу потрапляє факт виплати, а не нарахування.
function onWorkerPayout(workerPayoutId) {
  const p = db.prepare("SELECT wp.id, wp.amount, wp.created_at, w.name FROM worker_payouts wp JOIN workers w ON wp.worker_id=w.id WHERE wp.id=?").get(workerPayoutId);
  if (!p || !p.amount) return;
  addCashMove({ date: (p.created_at || "").slice(0, 10), amount: -p.amount, kind: "salary",
    ref_type: "worker_payout", ref_id: p.id, note: "Зарплата: " + p.name });
}

module.exports = { register, addCashMove, createExpense, onOrderCreated, onOrderDelivered, onOrderUndelivered, onDropPayoutPaid, onWorkerPayout, removeCashMovesForOrder, compensateCancelledOrder, syncOrderCashMove };
