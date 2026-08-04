const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
const round2 = v => Math.round((v || 0) * 100) / 100;

(async () => {
  await login("admin");
  const o = db.prepare("SELECT id,total_drop_price FROM orders WHERE total_drop_price>0 ORDER BY id DESC LIMIT 1").get();

  // повернення коштів клієнту
  db.prepare("UPDATE orders SET refunded_amount=0,refunded_at='' WHERE id=?").run(o.id);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='refund' AND ref_id=?").run(o.id);
  let r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: 250, note: "__T6" }) });
  ok(r.s === 200, "повернення коштів проведено");
  const mv = db.prepare("SELECT * FROM cash_moves WHERE ref_type='refund' AND ref_id=?").get(o.id);
  ok(mv && mv.amount === -250, "у касі мінус 250 (" + (mv && mv.amount) + ")");
  ok(db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r === 250, "сума повернення записана в замовлення");

  // друге часткове повернення того ж замовлення не має загубитись через
  // унікальний індекс по ref_id — для нього хелпер пише ref_type='refund_extra'
  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: 50, note: "__T6" }) });
  ok(r.s === 200, "друге часткове повернення проведено");
  const mv2 = db.prepare("SELECT * FROM cash_moves WHERE ref_type='refund_extra' AND note LIKE '__T6%' ORDER BY id DESC LIMIT 1").get();
  ok(mv2 && mv2.amount === -50, "друге часткове повернення лягло в касу окремим рухом (" + (mv2 && mv2.amount) + ")");
  ok(db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r === 300, "сума другого повернення додалась до замовлення (" + db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r + ")");

  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: -5 }) });
  ok(r.s === 400, "від'ємна сума відхилена");

  // випадковий повтор того самого запиту (подвійний клік/ретрай мережі):
  // той самий виклик (сума 50), зроблений одразу після легітимного,
  // не повинен ще раз рухати касу й нараховувати повернення
  const orderTag = "(замовлення #" + o.id + ")";
  const movesBefore = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE kind='refund' AND note LIKE ?").get("%" + orderTag).c;
  const refundedBefore = db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r;
  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: 50, note: "__T6" }) });
  ok(r.s === 409, "повтор того самого повернення (50) одразу відхилений з 409 (" + r.s + ")");
  const movesAfterDup = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE kind='refund' AND note LIKE ?").get("%" + orderTag).c;
  ok(movesAfterDup === movesBefore, "відхилений повтор не додав рух каси (" + movesBefore + " -> " + movesAfterDup + ")");
  const refundedAfterDup = db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r;
  ok(refundedAfterDup === refundedBefore, "відхилений повтор не змінив refunded_amount (" + refundedBefore + " -> " + refundedAfterDup + ")");

  // легітимне повернення на іншу суму одразу після — має пройти нормально,
  // захист від дублю не має чіпати повернення з іншою сумою
  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: 77, note: "__T6" }) });
  ok(r.s === 200, "повернення на іншу суму (77) одразу після проходить нормально (" + r.s + ")");
  const mv3 = db.prepare("SELECT * FROM cash_moves WHERE kind='refund' AND amount=-77 AND note LIKE ? ORDER BY id DESC LIMIT 1").get("%" + orderTag);
  ok(mv3 && mv3.amount === -77, "рух на іншу суму лягла в касу (" + (mv3 && mv3.amount) + ")");
  ok(db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r === 377, "сума третього повернення додалась до замовлення (" + db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r + ")");

  // виплата дроперу
  const pr = db.prepare("SELECT id,total_amount FROM payout_requests WHERE status!='paid' ORDER BY id DESC LIMIT 1").get();
  if (pr) {
    db.prepare("DELETE FROM cash_moves WHERE ref_type='payout' AND ref_id=?").run(pr.id);
    r = await api("/api/payouts/" + pr.id + "/paid", { method: "PUT", body: JSON.stringify({}) });
    ok(r.s === 200, "виплату дроперу проведено");
    const pm = db.prepare("SELECT * FROM cash_moves WHERE ref_type='payout' AND ref_id=?").get(pr.id);
    ok(pm && Math.abs(pm.amount + pr.total_amount) < 0.01, "виплата дроперу лягла в касу мінусом (" + (pm && pm.amount) + ")");
    ok(pm && pm.kind === "payout", "тип руху payout, не витрата");
  } else console.log("⚠️ немає невиплаченого запиту — перевірку виплати пропущено");

  // виплата зарплати працівнику — цей хук окремо не описаний у кроці 1 брифа,
  // але прямо входить у задачу (onWorkerPayout), тож додаємо перевірку тут.
  // Якщо в знімку БД в жодного працівника немає нарахованого — заводимо
  // фіксатуру: один рядок нарахування безпечний, на відміну від
  // payout_requests, де синк підтягнув би реальні замовлення дропера.
  const w = db.prepare("SELECT id,name FROM workers WHERE active=1 ORDER BY id LIMIT 1").get();
  if (w) {
    let earned = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM worker_payroll WHERE worker_id=?").get(w.id).s;
    const paid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM worker_payouts WHERE worker_id=?").get(w.id).s;
    let fixtureId = null;
    if (earned - paid <= 0) {
      fixtureId = db.prepare("INSERT INTO worker_payroll(worker_id,amount,type,note)VALUES(?,?,?,?)").run(w.id, 77.5, "item", "__T6").lastInsertRowid;
      earned = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM worker_payroll WHERE worker_id=?").get(w.id).s;
    }
    if (earned - paid > 0) {
      r = await api("/api/workers/" + w.id + "/pay", { method: "POST", body: JSON.stringify({}) });
      ok(r.s === 200, "виплату зарплати проведено");
      const wp = db.prepare("SELECT id FROM worker_payouts WHERE worker_id=? ORDER BY id DESC LIMIT 1").get(w.id);
      const sm = db.prepare("SELECT * FROM cash_moves WHERE ref_type='worker_payout' AND ref_id=?").get(wp.id);
      ok(sm && sm.amount === -round2(earned - paid), "зарплата лягла в касу мінусом (" + (sm && sm.amount) + ")");
      ok(sm && sm.kind === "salary", "тип руху salary, не витрата");
      db.prepare("DELETE FROM cash_moves WHERE ref_type='worker_payout' AND ref_id=?").run(wp.id);
      db.prepare("DELETE FROM worker_payouts WHERE id=?").run(wp.id);
    } else console.log("⚠️ працівнику нічого виплачувати — перевірку зарплати пропущено");
    if (fixtureId) db.prepare("DELETE FROM worker_payroll WHERE id=?").run(fixtureId);
  } else console.log("⚠️ немає активних працівників — перевірку зарплати пропущено");

  db.prepare("DELETE FROM cash_moves WHERE note LIKE '__T6%' OR (ref_type='refund' AND ref_id=?) OR (ref_type='refund_extra' AND note LIKE '__T6%')").run(o.id);
  db.prepare("UPDATE orders SET refunded_amount=0,refunded_at='' WHERE id=?").run(o.id);
})();
