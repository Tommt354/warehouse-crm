// Зворотна доставка НП: гроші бере НП з нас, а ми утримуємо ту саму суму з
// виплати дроперу. Без обліку компенсації прибуток був би занижений на всі
// утримання, хоча склад по факту нічого не втратив.
const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

(async () => {
  await login("admin");
  const today = new Date().toISOString().slice(0, 10);
  const dropId = db.prepare("SELECT id FROM users WHERE role='dropshipper' LIMIT 1").get().id;
  const cats = (await api("/api/finance/categories")).b.categories;
  const retCat = cats.find(c => c.name === "Повернення НП") || cats.find(c => c.kind === "expense");

  const before = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;

  // НП забрала з нас 150₴ за зворотну доставку — власник записав це витратою.
  let r = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({
    date: today, amount: 150, category_id: retCat.id, note: "__T12 доставка повернення", paid: 1 }) });
  ok(r.s === 200, "витрата на зворотну доставку записана (" + r.s + ")");
  const expId = r.b.id;

  const mid = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(Math.abs(mid.profit_cash - (before.profit_cash - 150)) < 0.01,
    "поки утримання немає — прибуток впав на 150 (" + before.profit_cash + " → " + mid.profit_cash + ")");

  // Ту саму суму утримали з дропера: у виплаті вона стоїть мінусом.
  const oid = db.prepare(`INSERT INTO orders(dropshipper_id,client_name,status,return_cost)
    VALUES(?,'__T12 Клієнт','refused',150)`).run(dropId).lastInsertRowid;
  const prId = db.prepare(`INSERT INTO payout_requests(dropshipper_id,total_amount,status,paid_at)
    VALUES(?,-150,'paid',datetime('now','localtime'))`).run(dropId).lastInsertRowid;
  db.prepare("INSERT INTO payout_items(payout_request_id,order_id,amount,is_return)VALUES(?,?,-150,1)").run(prId, oid);

  const after = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(after.returns_compensation === 150, "утримання з дропера показане окремо (" + after.returns_compensation + ")");
  ok(Math.abs(after.profit_cash - before.profit_cash) < 0.01,
    "витрата й компенсація погасили одна одну — прибуток як був (" + before.profit_cash + " → " + after.profit_cash + ")");

  // ── прибирання ─────────────────────────────────────────────────
  db.prepare("DELETE FROM payout_items WHERE payout_request_id=?").run(prId);
  db.prepare("DELETE FROM payout_requests WHERE id=?").run(prId);
  db.prepare("DELETE FROM orders WHERE id=?").run(oid);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id=?").run(expId);
  db.prepare("DELETE FROM expense_payments WHERE expense_id=?").run(expId);
  db.prepare("DELETE FROM expenses WHERE id=?").run(expId);
})();
