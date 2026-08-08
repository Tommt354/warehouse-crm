// Ручні надходження (продав за готівку) і зобов'язання перед дроперами.
// Друге — це не витрата й не борг постачальнику: гроші лежать на рахунку,
// але частина з них чужа, і власник має бачити скільки саме.
const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

(async () => {
  await login("admin");
  const today = new Date().toISOString().slice(0, 10);
  const dropId = db.prepare("SELECT id FROM users WHERE role='dropshipper' AND active=1 LIMIT 1").get().id;
  const before = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;

  // ── ручне надходження ──────────────────────────────────────────
  let r = await api("/api/finance/income", { method: "POST", body: JSON.stringify({ amount: 800, note: "__T14 продав за готівку" }) });
  ok(r.s === 200 && r.b.id, "надходження записано (" + r.s + ")");
  const incId = r.b.id;

  r = await api("/api/finance/income", { method: "POST", body: JSON.stringify({ amount: 0 }) });
  ok(r.s === 400, "нульова сума не приймається (" + r.s + ")");

  let after = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(after.manual_income === 800, "показано окремим рядком (" + after.manual_income + ")");
  ok(Math.abs(after.income - (before.income + 800)) < 0.01, "дохід виріс на 800 (" + before.income + " → " + after.income + ")");
  ok(Math.abs(after.balance - (before.balance + 800)) < 0.01, "залишок виріс на 800 (" + after.balance + ")");
  ok(Math.abs(after.profit_cash - (before.profit_cash + 800)) < 0.01, "прибуток виріс на 800");

  const list = (await api("/api/finance/income?from=" + today + "&to=" + today)).b.items;
  ok(list.some(i => i.id === incId), "надходження є у списку");

  r = await api("/api/finance/income/" + incId, { method: "DELETE" });
  ok(r.s === 200, "надходження видалено (" + r.s + ")");
  after = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(Math.abs(after.balance - before.balance) < 0.01, "після видалення залишок повернувся (" + after.balance + ")");

  // ── зобов'язання перед дроперами ───────────────────────────────
  const pay0 = (await api("/api/finance/payables")).b;

  // Забране замовлення без запиту на виплату.
  const oid = db.prepare(`INSERT INTO orders(dropshipper_id,client_name,status,cod_amount,total_drop_price,payout_amount,delivered_at)
    VALUES(?,'__T14 Клієнт','delivered',1000,600,400,datetime('now','localtime'))`).run(dropId).lastInsertRowid;
  let pay = (await api("/api/finance/payables")).b;
  ok(Math.abs(pay.not_requested - (pay0.not_requested + 400)) < 0.01,
    "забране замовлення без запиту потрапило в «ще не подані» (" + pay.not_requested + ")");
  ok(Math.abs(pay.requested - pay0.requested) < 0.01, "у поданих запитах нічого не змінилось");

  // Той самий дропер подав запит — сума має переїхати з одного стовпця в інший.
  const prId = db.prepare("INSERT INTO payout_requests(dropshipper_id,total_amount,status)VALUES(?,400,'pending')").run(dropId).lastInsertRowid;
  db.prepare("INSERT INTO payout_items(payout_request_id,order_id,amount,is_return)VALUES(?,?,400,0)").run(prId, oid);
  pay = (await api("/api/finance/payables")).b;
  ok(Math.abs(pay.requested - (pay0.requested + 400)) < 0.01, "сума перейшла в подані запити (" + pay.requested + ")");
  ok(Math.abs(pay.not_requested - pay0.not_requested) < 0.01, "і зникла з «ще не подані» (" + pay.not_requested + ")");
  ok(Math.abs(pay.total - (pay0.total + 400)) < 0.01, "загальна сума не подвоїлась (" + pay.total + ")");

  const rep = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(Math.abs(rep.payables.total - pay.total) < 0.01, "у звіті та сама цифра, що й у списку (" + rep.payables.total + ")");

  // Виплатили — зобов'язання зникло.
  await api("/api/payouts/" + prId + "/paid", { method: "PUT", body: JSON.stringify({}) });
  pay = (await api("/api/finance/payables")).b;
  ok(Math.abs(pay.total - pay0.total) < 0.01, "після виплати зобов'язання зникло (" + pay.total + ")");

  // ── прибирання ─────────────────────────────────────────────────
  db.prepare("DELETE FROM cash_moves WHERE ref_type='payout' AND ref_id=?").run(prId);
  db.prepare("DELETE FROM payout_items WHERE payout_request_id=?").run(prId);
  db.prepare("DELETE FROM payout_requests WHERE id=?").run(prId);
  db.prepare("DELETE FROM cash_moves WHERE ref_id=?").run(oid);
  db.prepare("DELETE FROM orders WHERE id=?").run(oid);
  db.prepare("DELETE FROM cash_moves WHERE note LIKE '__T14%'").run();
})();
