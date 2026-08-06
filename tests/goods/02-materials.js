// Довідник тканин, курс НБУ, прихід рулонів. Стиль — за зразком
// tests/finance/03-suppliers.js і 04-expenses.js.
const { api, ok, login } = require("../finance/_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

(async () => {
  await login("admin");

  // ── довідник тканин ─────────────────────────────────────────────
  let r = await api("/api/goods/materials", { method: "POST", body: JSON.stringify({ name: "__TestДвонитка", unit: "kg" }) });
  ok(r.s === 200 && r.b.id, "вид тканини в кілограмах створений");
  const matKg = r.b.id;

  r = await api("/api/goods/materials", { method: "POST", body: JSON.stringify({ name: "__TestПлащівка", unit: "m" }) });
  ok(r.s === 200 && r.b.id, "вид тканини в метрах створений");
  const matM = r.b.id;

  r = await api("/api/goods/materials", { method: "POST", body: JSON.stringify({ name: "__TestБад", unit: "box" }) });
  ok(r.s === 400, "невідома одиниця відхилена (" + r.s + ")");

  r = await api("/api/goods/materials");
  ok(r.s === 200 && r.b.materials.some(m => m.id === matKg) && r.b.materials.some(m => m.id === matM), "обидва види у списку");

  // ── курс НБУ ─────────────────────────────────────────────────────
  // Мережа в тестовому середовищі може бути недоступна — маршрут тоді
  // віддає останній відомий курс із material_lots і позначає fallback:true.
  // Обидва випадки валідні; перевіряємо лише форму відповіді.
  const today = db.prepare("SELECT date('now','localtime') d").get().d;
  r = await api("/api/goods/fx?date=" + today);
  ok(r.s === 200 && typeof r.b.rate === "number", "курс НБУ повернутий (" + JSON.stringify(r.b) + ")");
  const fx1 = r.b;

  // Повторний запит на ту саму дату — той самий результат із кешу (в
  // пам'яті процесу). Чорноскринькового способу довести "мережа вдруге не
  // викликалась" через самі лише HTTP-відповіді нема — реальна гарантія
  // живе в коді (Map за датою в goods.js), тут перевіряємо зовнішньо
  // спостережну поведінку: детермінований однаковий результат.
  r = await api("/api/goods/fx?date=" + today);
  ok(r.s === 200 && r.b.rate === fx1.rate && r.b.fallback === fx1.fallback, "повторний запит курсу на ту саму дату дав той самий результат (кеш)");

  // ── прихід рулону ────────────────────────────────────────────────
  r = await api("/api/goods/lots", {
    method: "POST",
    body: JSON.stringify({ material_id: matKg, color: "чорний", roll_no: "R-1", qty_total: 50, price_usd: 6.5, fx_rate: 41.2 })
  });
  ok(r.s === 200 && r.b.id, "рулон приходить (" + JSON.stringify(r.b) + ")");
  const lot1 = r.b.id;
  let lotRow = db.prepare("SELECT * FROM material_lots WHERE id=?").get(lot1);
  ok(Math.abs(lotRow.price_uah - 6.5 * 41.2) < 0.01, "price_uah = price_usd × fx_rate (" + lotRow.price_uah + ")");
  ok(lotRow.qty_left === 50 && lotRow.qty_total === 50, "qty_left = qty_total на приході (" + lotRow.qty_left + ")");
  ok(lotRow.fx_rate === 41.2, "курс рулону зафіксований (" + lotRow.fx_rate + ")");

  // Курс не передали — система підставляє НБУ (або fallback) сама і
  // зберігає його в рулоні, а не рахує щоразу наново.
  r = await api("/api/goods/lots", {
    method: "POST",
    body: JSON.stringify({ material_id: matM, color: "білий", roll_no: "R-2", qty_total: 30, price_usd: 3.2 })
  });
  ok(r.s === 200 && r.b.id, "рулон без явного курсу приходить (" + JSON.stringify(r.b) + ")");
  const lot2 = r.b.id;
  lotRow = db.prepare("SELECT * FROM material_lots WHERE id=?").get(lot2);
  ok(lotRow.fx_rate > 0, "курс підставлений автоматично (" + lotRow.fx_rate + ")");
  ok(Math.abs(lotRow.price_uah - 3.2 * lotRow.fx_rate) < 0.01, "price_uah порахований і збережений (" + lotRow.price_uah + ")");

  r = await api("/api/goods/lots?material_id=" + matKg);
  ok(r.s === 200 && r.b.lots.some(l => l.id === lot1), "рулон видно у списку по виду тканини");

  // ── прихід із create_expense ────────────────────────────────────
  const matCat = db.prepare("SELECT id FROM fin_categories WHERE kind='material' AND active=1 LIMIT 1").get();
  r = await api("/api/goods/lots", {
    method: "POST",
    body: JSON.stringify({ material_id: matKg, color: "синій", roll_no: "R-3", qty_total: 20, price_usd: 6.5, fx_rate: 40, create_expense: true })
  });
  ok(r.s === 200 && r.b.id, "рулон із create_expense приходить (" + JSON.stringify(r.b) + ")");
  const lot3 = r.b.id;
  lotRow = db.prepare("SELECT * FROM material_lots WHERE id=?").get(lot3);
  ok(lotRow.expense_id, "рулон отримав посилання на витрату (" + lotRow.expense_id + ")");
  const exp = db.prepare("SELECT * FROM expenses WHERE id=?").get(lotRow.expense_id);
  ok(exp && exp.category_id === matCat.id, "витрата заведена в категорії матеріалів (" + (exp && exp.category_id) + " очікували " + matCat.id + ")");
  ok(Math.abs(exp.amount - 20 * (6.5 * 40)) < 0.01, "сума витрати = кількість × ціна за одиницю в грн (" + (exp && exp.amount) + ")");
  const cash = db.prepare("SELECT amount FROM cash_moves WHERE ref_type='expense' AND ref_id=?").get(lotRow.expense_id);
  ok(cash && cash.amount === -exp.amount, "рух каси через наявний механізм витрат (" + (cash && cash.amount) + ")");

  // прибирання (спершу рулони — material_lots.expense_id посилається на
  // expenses, FOREIGN KEY не дасть видалити витрату, поки на неї є посилання)
  db.prepare("DELETE FROM material_lots WHERE id IN (?,?,?)").run(lot1, lot2, lot3);
  db.prepare("DELETE FROM materials WHERE id IN (?,?)").run(matKg, matM);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id=?").run(lotRow.expense_id);
  db.prepare("DELETE FROM expense_payments WHERE expense_id=?").run(lotRow.expense_id);
  db.prepare("DELETE FROM expenses WHERE id=?").run(lotRow.expense_id);

  // ── доступ ──────────────────────────────────────────────────────
  await login("packer");
  r = await api("/api/goods/materials");
  ok(r.s === 403, "не-адміну закрито: матеріали (" + r.s + ")");
  r = await api("/api/goods/lots");
  ok(r.s === 403, "не-адміну закрито: рулони (" + r.s + ")");
  r = await api("/api/goods/fx");
  ok(r.s === 403, "не-адміну закрито: курс (" + r.s + ")");
})();
