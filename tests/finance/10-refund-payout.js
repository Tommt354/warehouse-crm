// Повернення коштів клієнту знімає виплату дроперу за це замовлення повністю
// (рішення власника): він за нього не отримує нічого, наш заробіток
// зменшується на суму повернення, а товар із собівартістю повертається на
// склад окремо. Якщо ж дроперу вже заплатили — автоматично не забираємо,
// лише повідомляємо суму: виплачене замовлення система сама не чіпає.
const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

(async () => {
  await login("admin");
  const dropId = db.prepare("SELECT id FROM users WHERE role='dropshipper' LIMIT 1").get().id;

  // ── замовлення з наложкою, забране клієнтом ────────────────────
  const oid = db.prepare(`INSERT INTO orders(dropshipper_id,client_name,status,cod_amount,total_drop_price,payout_amount,delivered_at,stock_pulled)
    VALUES(?,'__T10Client','delivered',1000,600,400,datetime('now','localtime'),1)`).run(dropId).lastInsertRowid;
  db.prepare(`INSERT INTO cash_moves(date,amount,kind,ref_type,ref_id,note)
    VALUES(date('now','localtime'),1000,'cod','order',?,'__T10 наложка')`).run(oid);

  let r = await api("/api/finance/orders/" + oid + "/refund", { method: "POST", body: JSON.stringify({ amount: 250, note: "__T10" }) });
  ok(r.s === 200, "повернення проведено (" + r.s + ")");
  ok(r.b.payout_already_paid === false, "виплата ще не проводилась (" + r.b.payout_already_paid + ")");
  let row = db.prepare("SELECT payout_amount, refunded_amount FROM orders WHERE id=?").get(oid);
  ok(row.payout_amount === 0, "виплата дроперу знята повністю (" + row.payout_amount + ")");
  ok(row.refunded_amount === 250, "сума повернення записана (" + row.refunded_amount + ")");

  // Дохід періоду зменшився рівно на повернення.
  const today = new Date().toISOString().slice(0, 10);
  const rep = await api("/api/finance/report?from=" + today + "&to=" + today);
  ok(rep.s === 200, "звіт віддається (" + rep.s + ")");

  // ── те саме, але дроперу вже заплатили ─────────────────────────
  const oid2 = db.prepare(`INSERT INTO orders(dropshipper_id,client_name,status,cod_amount,total_drop_price,payout_amount,delivered_at,stock_pulled)
    VALUES(?,'__T10Paid','delivered',1000,600,400,datetime('now','localtime'),1)`).run(dropId).lastInsertRowid;
  db.prepare(`INSERT INTO cash_moves(date,amount,kind,ref_type,ref_id,note)
    VALUES(date('now','localtime'),1000,'cod','order',?,'__T10 наложка 2')`).run(oid2);
  const prId = db.prepare("INSERT INTO payout_requests(dropshipper_id,total_amount,status,paid_at)VALUES(?,400,'paid',datetime('now','localtime'))").run(dropId).lastInsertRowid;
  db.prepare("INSERT INTO payout_items(payout_request_id,order_id,amount,is_return)VALUES(?,?,400,0)").run(prId, oid2);

  r = await api("/api/finance/orders/" + oid2 + "/refund", { method: "POST", body: JSON.stringify({ amount: 300, note: "__T10b" }) });
  ok(r.s === 200, "повернення на виплаченому замовленні проведено (" + r.s + ")");
  ok(r.b.payout_already_paid === true, "система бачить, що дроперу вже заплатили");
  ok(r.b.payout_to_settle === 400, "показано суму до ручного врегулювання (" + r.b.payout_to_settle + ")");
  row = db.prepare("SELECT payout_amount FROM orders WHERE id=?").get(oid2);
  ok(row.payout_amount === 400, "виплачене замовлення автоматично не чіпається (" + row.payout_amount + ")");

  // ── прибирання ─────────────────────────────────────────────────
  db.prepare("DELETE FROM payout_items WHERE payout_request_id=?").run(prId);
  db.prepare("DELETE FROM payout_requests WHERE id=?").run(prId);
  db.prepare("DELETE FROM cash_moves WHERE ref_id IN (?,?) OR note LIKE '__T10%'").run(oid, oid2);
  db.prepare("DELETE FROM orders WHERE id IN (?,?)").run(oid, oid2);
})();
