const db = require("./db");
const finance = require("./finance");

function round2(v) { return Math.round((v || 0) * 100) / 100; }
// Курс — не гроші, а коефіцієнт; округляти його до копійок як суму означало
// б втратити точність (41.2345 → 41.23 і назад немає). Чотири знаки —
// стандартна точність міжбанківського курсу.
function round4(v) { return Math.round((v || 0) * 10000) / 10000; }

const today = () => db.prepare("SELECT date('now','localtime') d").get().d;

// ── Курс НБУ ─────────────────────────────────────────────────────────
// Кешуємо в пам'яті процесу за датою: курс фіксується в момент приходу
// рулону і більше ніколи не перечитується, тож повторний запит на ту саму
// дату (наприклад форма приходу відкрита кілька разів за день) не має
// вдруге ходити в мережу. Кеш живе, поки живий процес сервера — це свідомо
// простіше за персистентний кеш, бо курс однієї дати не міняється.
const fxCache = new Map();
const FX_TIMEOUT_MS = 4000;

async function fetchNbuRate(dateYmd) {
  const url = `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json&valcode=USD&date=${dateYmd}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FX_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error("НБУ відповів " + r.status);
    const data = await r.json();
    const rate = data && data[0] && data[0].rate;
    if (!rate) throw new Error("НБУ не повернув курс на цю дату");
    return round4(rate);
  } finally {
    clearTimeout(timer);
  }
}

// Запасне значення, коли мережа недоступна: останній курс, з яким реально
// приходив рулон. Це не "вигаданий" нуль — це останнє відоме реальне
// число, і форма приходу все одно дає власнику виправити його вручну.
function lastKnownFxRate() {
  const r = db.prepare("SELECT fx_rate FROM material_lots WHERE fx_rate > 0 ORDER BY created_at DESC, id DESC LIMIT 1").get();
  return r ? r.fx_rate : 0;
}

async function getFxRate(date) {
  if (fxCache.has(date)) return fxCache.get(date);
  const ymd = date.replace(/-/g, "");
  let result;
  try {
    const rate = await fetchNbuRate(ymd);
    result = { rate, date, fallback: false };
  } catch (e) {
    result = { rate: lastKnownFxRate(), date, fallback: true, error: e.message };
  }
  fxCache.set(date, result);
  return result;
}

// Категорія витрат для приходу матеріалу: власник заводить категорії сам
// (розділ 3а), логіка живе в kind='material'. Явно передану категорію
// поважаємо (форма може дати вибір між "Тканина"/"Фурнітура"/"Матеріали"),
// інакше беремо першу активну категорію цього kind — на порожній базі це
// завжди є, бо db.js засіює стартовий набір категорій.
function defaultMaterialCategoryId() {
  const cat = db.prepare("SELECT id FROM fin_categories WHERE kind='material' AND active=1 ORDER BY sort_order, id LIMIT 1").get();
  return cat ? cat.id : null;
}

function register(app, { authMiddleware, requireRole }) {
  const adminOnly = [authMiddleware, requireRole("admin")];

  // ── Довідник тканин ────────────────────────────────────────────
  app.get("/api/goods/materials", ...adminOnly, (req, res) => {
    res.json({ materials: db.prepare("SELECT * FROM materials WHERE active=1 ORDER BY name").all() });
  });

  app.post("/api/goods/materials", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Вкажіть назву" });
    const unit = req.body.unit;
    if (!["kg", "m"].includes(unit)) return res.status(400).json({ error: "Одиниця має бути кг або м" });
    const r = db.prepare("INSERT INTO materials(name,unit)VALUES(?,?)").run(name, unit);
    res.json({ ok: true, id: r.lastInsertRowid });
  });

  app.put("/api/goods/materials/:id", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Вкажіть назву" });
    const unit = req.body.unit;
    if (!["kg", "m"].includes(unit)) return res.status(400).json({ error: "Одиниця має бути кг або м" });
    db.prepare("UPDATE materials SET name=?,unit=?,active=? WHERE id=?")
      .run(name, unit, req.body.active === 0 ? 0 : 1, req.params.id);
    res.json({ ok: true });
  });

  // ── Курс НБУ ───────────────────────────────────────────────────
  app.get("/api/goods/fx", ...adminOnly, async (req, res) => {
    const date = req.query.date || today();
    res.json(await getFxRate(date));
  });

  // ── Рулони тканини ─────────────────────────────────────────────
  app.get("/api/goods/lots", ...adminOnly, (req, res) => {
    let sql = `SELECT l.*, m.name as material_name, m.unit
      FROM material_lots l JOIN materials m ON l.material_id=m.id WHERE 1=1`;
    const params = [];
    if (req.query.material_id) { sql += " AND l.material_id=?"; params.push(req.query.material_id); }
    if (req.query.only_left === "1") sql += " AND l.qty_left > 0";
    sql += " ORDER BY l.created_at DESC, l.id DESC";
    res.json({ lots: db.prepare(sql).all(...params) });
  });

  app.post("/api/goods/lots", ...adminOnly, async (req, res) => {
    const material = db.prepare("SELECT * FROM materials WHERE id=?").get(req.body.material_id);
    if (!material) return res.status(400).json({ error: "Оберіть вид тканини" });
    const qtyTotal = parseFloat(req.body.qty_total);
    if (!qtyTotal || qtyTotal <= 0) return res.status(400).json({ error: "Вкажіть кількість" });
    const priceUsd = parseFloat(req.body.price_usd);
    if (!priceUsd || priceUsd <= 0) return res.status(400).json({ error: "Вкажіть ціну за одиницю в доларах" });

    // Курс — якщо не передали, підтягуємо НБУ (або fallback) і фіксуємо в
    // рулоні НАЗАВЖДИ: forma may re-open the same day, but the number that
    // lands in the roll must never silently recompute later.
    let fxRate = parseFloat(req.body.fx_rate);
    let fxFallback = false;
    if (!fxRate || fxRate <= 0) {
      const fx = await getFxRate(today());
      fxRate = fx.rate;
      fxFallback = fx.fallback;
    }
    if (!fxRate || fxRate <= 0) return res.status(400).json({ error: "Не вдалось визначити курс — вкажіть вручну" });

    const priceUah = round2(priceUsd * fxRate);

    // Категорію перевіряємо ДО транзакції: інакше довелось би ловити виняток
    // із середини db.transaction лише заради коду відповіді.
    let categoryId = null;
    if (req.body.create_expense) {
      categoryId = req.body.category_id || defaultMaterialCategoryId();
      if (!categoryId) return res.status(400).json({ error: "Немає категорії матеріалів для витрати" });
    }

    let expenseId = null;
    let id;
    db.transaction(() => {
      // Прихід рулону може одразу лягти у витрати категорії матеріалів —
      // через наявний механізм (finance.createExpense), а не власний рух
      // каси: лінія товару звіряється з лінією грошей, а не задвоює її.
      if (categoryId) {
        const amount = round2(qtyTotal * priceUah);
        expenseId = finance.createExpense({
          date: today(), amount, category_id: categoryId, supplier_id: req.body.supplier_id,
          note: "Рулон " + material.name + (req.body.roll_no ? " №" + req.body.roll_no : "") + (req.body.color ? ", " + req.body.color : ""),
          created_by: req.user.id, paid: req.body.paid !== false
        });
      }
      id = db.prepare(`INSERT INTO material_lots(material_id,color,roll_no,qty_total,qty_left,price_usd,fx_rate,price_uah,supplier_id,expense_id,note)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(material.id, req.body.color || "", req.body.roll_no || "", qtyTotal, qtyTotal, round2(priceUsd), fxRate, priceUah, req.body.supplier_id || null, expenseId, req.body.note || "")
        .lastInsertRowid;
    })();

    res.json({ ok: true, id, fx_rate: fxRate, fx_fallback: fxFallback, price_uah: priceUah, expense_id: expenseId });
  });

  // ── Оцінка крою: списання тканини й собівартість партії ─────────
  app.get("/api/goods/cuts/unvalued", ...adminOnly, (req, res) => {
    res.json({
      cuts: db.prepare(`SELECT ci.*, bp.name as product_name, w.name as workshop_name, s.name as size_name
        FROM cut_incoming ci
        JOIN base_products bp ON ci.base_product_id=bp.id
        JOIN workshops w ON ci.workshop_id=w.id
        JOIN sizes s ON ci.size_id=s.id
        WHERE COALESCE(ci.valued,0)=0
        ORDER BY ci.created_at ASC`).all()
    });
  });

  app.post("/api/goods/cuts/:cut_incoming_id/value", ...adminOnly, (req, res) => {
    const cut = db.prepare("SELECT * FROM cut_incoming WHERE id=?").get(req.params.cut_incoming_id);
    if (!cut) return res.status(404).json({ error: "Партію крою не знайдено" });
    // Ідемпотентність через явну відмову: повторний виклик не повинен
    // мовчки списати ту саму тканину вдруге чи задвоїти нарахування
    // фурнітури в котел — власник хоче переоцінити, значить спершу має
    // усвідомлено скасувати стару оцінку (окремого маршруту для цього
    // поки нема — редагування партії відбувається до першої оцінки).
    if (cut.valued) return res.status(400).json({ error: "Партія вже оцінена" });

    const usages = Array.isArray(req.body.usages) ? req.body.usages : [];
    if (!usages.length) return res.status(400).json({ error: "Вкажіть хоча б один рулон" });
    if (!cut.quantity || cut.quantity <= 0) return res.status(400).json({ error: "У партії немає фактичної кількості виробів" });

    // Валідуємо ВСІ рядки до першого запису — часткове списання при помилці
    // на другому рулоні залишило б базу в суперечливому стані.
    const EPS = 1e-9;
    const lots = [];
    for (const u of usages) {
      const qty = parseFloat(u.qty);
      if (!qty || qty <= 0) return res.status(400).json({ error: "Кількість списання має бути більшою за нуль" });
      const lot = db.prepare("SELECT * FROM material_lots WHERE id=?").get(u.lot_id);
      if (!lot) return res.status(400).json({ error: "Рулон #" + u.lot_id + " не знайдено" });
      if (qty > lot.qty_left + EPS) {
        return res.status(400).json({ error: "У рулоні №" + (lot.roll_no || lot.id) + " лишилось лише " + lot.qty_left + ", а списують " + qty });
      }
      lots.push({ lot, qty });
    }

    const sewingPrice = req.body.sewing_price !== undefined && req.body.sewing_price !== null && req.body.sewing_price !== ""
      ? parseFloat(req.body.sewing_price) : null;
    const notionsRate = req.body.notions_cost !== undefined && req.body.notions_cost !== null && req.body.notions_cost !== ""
      ? parseFloat(req.body.notions_cost) : null;

    const product = db.prepare("SELECT * FROM base_products WHERE id=?").get(cut.base_product_id);
    // Ставка пошиву — на партії (ціна пошиву різна для різних товарів), у
    // картці товару лежить лише значення за замовчуванням, яке підставляють
    // у форму. Так само для фурнітури.
    const effSewingPrice = sewingPrice !== null ? sewingPrice : (product ? product.sewing_cost : 0) || 0;
    const effNotionsRate = notionsRate !== null ? notionsRate : (product ? product.notions_cost : 0) || 0;

    let materialCost = 0;
    lots.forEach(({ lot, qty }) => { materialCost = round2(materialCost + round2(qty * lot.price_uah)); });
    const sewingCostTotal = round2(effSewingPrice * cut.quantity);
    const notionsCostTotal = round2(effNotionsRate * cut.quantity);
    const totalCost = round2(materialCost + sewingCostTotal + notionsCostTotal);
    // Брак усередині партії обробляється сам: cut.quantity — це вже
    // ФАКТИЧНА кількість придатних виробів (працівник/власник вписує саме
    // її), тож той самий totalCost, поділений на менше число, автоматично
    // дає вищу собівартість одиниці — рахувати брак окремо не треба.
    const unitCost = round2(totalCost / cut.quantity);

    db.transaction(() => {
      lots.forEach(({ lot, qty }) => {
        const cost = round2(qty * lot.price_uah);
        db.prepare("INSERT INTO cut_material_usage(cut_incoming_id,lot_id,qty,cost)VALUES(?,?,?,?)")
          .run(cut.id, lot.id, qty, cost);
        db.prepare("UPDATE material_lots SET qty_left = qty_left - ? WHERE id=?").run(qty, lot.id);
      });
      db.prepare(`UPDATE cut_incoming SET material_cost=?,notions_cost=?,sewing_price=?,sewing_cost=?,unit_cost=?,valued=1 WHERE id=?`)
        .run(materialCost, notionsCostTotal, effSewingPrice, sewingCostTotal, unitCost, cut.id);
      if (notionsCostTotal) {
        db.prepare("INSERT INTO notions_pool(date,amount,ref_type,ref_id,note)VALUES(?,?,?,?,?)")
          .run(today(), -notionsCostTotal, "cut_incoming", cut.id, "Нарахування за нормативом на партію крою #" + cut.id);
      }
    })();

    res.json({ ok: true, material_cost: materialCost, notions_cost: notionsCostTotal, sewing_cost: sewingCostTotal, unit_cost: unitCost, total_cost: totalCost });
  });

  // ── Партії готового товару: список і звірка ─────────────────────
  app.get("/api/goods/lots-stock", ...adminOnly, (req, res) => {
    let sql = `SELECT l.*, bp.name as product_name, s.name as size_name
      FROM inventory_lots l JOIN base_products bp ON l.base_product_id=bp.id JOIN sizes s ON l.size_id=s.id WHERE 1=1`;
    const params = [];
    if (req.query.base_product_id) { sql += " AND l.base_product_id=?"; params.push(req.query.base_product_id); }
    if (req.query.shelf) { sql += " AND l.shelf=?"; params.push(req.query.shelf); }
    if (req.query.only_left === "1") sql += " AND l.qty_left > 0";
    if (req.query.unvalued === "1") sql += " AND l.valued = 0";
    sql += " ORDER BY l.created_at ASC, l.id ASC";
    res.json({ lots: db.prepare(sql).all(...params) });
  });
}

// ══════════════════════════════════════════════════════════════════
// Рух вартості готового товару: крій → склад. Ці функції не рухають
// КІЛЬКІСТЬ — вона вже рухається в server.js у своїх перевірених точках
// (/api/stock-cuts/incoming, /api/stock/incoming-bulk). Тут лише вартість
// іде слідом.
// ══════════════════════════════════════════════════════════════════

// Створює нову партію на вказаній полиці. Партії з тієї самої полиці й
// джерела свідомо НЕ зливаються навіть з однаковою ціною — кожен прихід/
// повернення лишається окремим рядком, як material_lots, для простежуваності.
function addToShelf(baseProductId, sizeId, shelf, qty, unitCost, source, refId, valued) {
  if (!qty || qty <= 0) return null;
  return db.prepare(`INSERT INTO inventory_lots(base_product_id,size_id,qty_left,unit_cost,source,ref_id,shelf,valued)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run(baseProductId, sizeId, qty, round2(unitCost) || 0, source, refId || null, shelf === "returns" ? "returns" : "base", valued ? 1 : 0)
    .lastInsertRowid;
}

// Крій → база: партія складу з тією ж unit_cost, що й у партії крою — сума
// капіталу не змінюється, гроші лише переїжджають із шухляди "крій" у
// шухляду "склад". FIFO по датах партій КРОЮ (cut_incoming.qty_left) у
// межах саме того цеху, з якого server.js уже забирає кількість
// (stock_cuts) — які саме цехи й скільки бере кількісна логіка, тут не
// дублюється, ми лише йдемо тим самим шляхом за вартістю. Якщо партій крою
// для цього товару/розміру/цеху не вистачає (крій рухався ще до
// впровадження партій) — залишок стає партією складу з unit_cost=0,
// valued=0: вартість не вигадується, партія лишається видимою в списку
// неоцінених.
function onCutMovedToBase(baseProductId, sizeId, qty, workshopId) {
  let remaining = qty;
  if (workshopId) {
    const batches = db.prepare(`SELECT * FROM cut_incoming WHERE base_product_id=? AND size_id=? AND workshop_id=? AND qty_left>0.0000001 ORDER BY created_at ASC, id ASC`)
      .all(baseProductId, sizeId, workshopId);
    for (const b of batches) {
      if (remaining <= 0.0000001) break;
      const take = Math.min(remaining, b.qty_left);
      db.prepare("UPDATE cut_incoming SET qty_left = qty_left - ? WHERE id=?").run(take, b.id);
      addToShelf(baseProductId, sizeId, "base", take, b.valued ? b.unit_cost : 0, "cut", b.id, !!b.valued);
      remaining -= take;
    }
  }
  if (remaining > 0.0000001) {
    addToShelf(baseProductId, sizeId, "base", remaining, 0, "cut", null, false);
  }
}

// Закупний товар (базар): собівартість береться з картки товару
// (base_products.cost_price), партія одразу на складі. cost_price=0 означає
// "не вписана" — не вигадуємо ціну, партія лишається неоціненою (valued=0),
// а не отримує тихий нуль, який виглядав би як "безкоштовний товар".
function onStockIncoming(baseProductId, sizeId, qty) {
  const bp = db.prepare("SELECT cost_price FROM base_products WHERE id=?").get(baseProductId);
  const cost = bp ? bp.cost_price : 0;
  addToShelf(baseProductId, sizeId, "base", qty, cost, "purchase", null, cost > 0);
}

module.exports = { register, onCutMovedToBase, onStockIncoming };
