// Опт — окремий кошик. Платежі клієнта можуть приходити частинами й навіть
// після відвантаження, шиється й їде теж частинами. Головне: у загальний звіт
// опт іде одним рядком, а не розмазується по днях, інакше він спотворив би і
// витрати, і прибуток роздробу.
const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

(async () => {
  await login("admin");
  const today = new Date().toISOString().slice(0, 10);
  const cats = (await api("/api/finance/categories")).b.categories;
  const matCat = cats.find(c => c.kind === "material");

  const before = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;

  // ── угода ──────────────────────────────────────────────────────
  let r = await api("/api/finance/wholesale", { method: "POST", body: JSON.stringify({ client_name: "__T11 Клієнт", deal_amount: 50000, note: "__T11" }) });
  ok(r.s === 200 && r.b.id, "оптове замовлення створено (" + r.s + ")");
  const wid = r.b.id;

  r = await api("/api/finance/wholesale", { method: "POST", body: JSON.stringify({ client_name: "" }) });
  ok(r.s === 400, "без клієнта не приймається (" + r.s + ")");

  // ── завдаток ───────────────────────────────────────────────────
  r = await api("/api/finance/wholesale/" + wid + "/payment", { method: "POST", body: JSON.stringify({ amount: 20000, note: "__T11 завдаток" }) });
  ok(r.s === 200, "завдаток проведено (" + r.s + ")");

  // ── витрата під цю угоду ───────────────────────────────────────
  r = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({
    date: today, amount: 12000, category_id: matCat.id, wholesale_id: wid, note: "__T11 тканина", paid: 1 }) });
  ok(r.s === 200, "витрата під угоду проведена (" + r.s + ")");
  const expId = r.b.id;

  let d = (await api("/api/finance/wholesale/" + wid)).b.order;
  ok(d.received === 20000, "отримано по угоді (" + d.received + ")");
  ok(d.spent === 12000, "витрачено по угоді (" + d.spent + ")");
  ok(d.profit === 8000, "проміжний результат по угоді (" + d.profit + ")");
  ok(d.left_to_pay === 30000, "залишок до оплати (" + d.left_to_pay + ")");

  // ── відвантаження частинами ────────────────────────────────────
  r = await api("/api/finance/wholesale/" + wid + "/shipment", { method: "POST", body: JSON.stringify({ qty: 40, note: "перша партія" }) });
  ok(r.s === 200, "перше відвантаження записано (" + r.s + ")");
  d = (await api("/api/finance/wholesale/" + wid)).b.order;
  ok(d.status === "shipped", "статус перейшов у «відвантажується» (" + d.status + ")");
  await api("/api/finance/wholesale/" + wid + "/shipment", { method: "POST", body: JSON.stringify({ qty: 60, note: "друга партія" }) });
  d = (await api("/api/finance/wholesale/" + wid)).b.order;
  ok(d.shipments_count === 2 && d.shipped_qty === 100, "журнал відвантажень веде обидві партії (" + d.shipments_count + " записи, " + d.shipped_qty + " шт)");

  // ── доплата вже після відвантаження ────────────────────────────
  r = await api("/api/finance/wholesale/" + wid + "/payment", { method: "POST", body: JSON.stringify({ amount: 30000, note: "__T11 доплата" }) });
  ok(r.s === 200, "доплата після відвантаження приймається (" + r.s + ")");
  d = (await api("/api/finance/wholesale/" + wid)).b.order;
  ok(d.received === 50000 && d.left_to_pay === 0, "угода оплачена повністю (" + d.received + ", лишилось " + d.left_to_pay + ")");
  ok(d.profit === 38000, "прибуток по угоді (" + d.profit + ")");

  // ── опт не змішується із загальним звітом ──────────────────────
  const after = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(after.income === before.income, "дохід роздробу не змінився від опту (" + before.income + " → " + after.income + ")");
  ok(after.goods_spent === before.goods_spent, "витрати роздробу не змінились (" + before.goods_spent + " → " + after.goods_spent + ")");
  ok(after.wholesale.received === 50000, "опт показаний окремим рядком: отримано " + after.wholesale.received);
  ok(after.wholesale.spent === 12000, "опт: витрачено " + after.wholesale.spent);
  ok(after.wholesale.open_deals >= 1, "видно кількість відкритих угод (" + after.wholesale.open_deals + ")");

  // Каса при цьому бачить усе: банк не знає про поділ на опт і роздріб.
  ok(after.balance === Math.round((before.balance + 50000 - 12000) * 100) / 100,
    "залишок на рахунку врахував і опт (" + before.balance + " → " + after.balance + ")");

  // ── закриття угоди ─────────────────────────────────────────────
  r = await api("/api/finance/wholesale/" + wid, { method: "PUT", body: JSON.stringify({ status: "closed" }) });
  ok(r.s === 200, "угоду закрито (" + r.s + ")");
  const list = (await api("/api/finance/wholesale")).b.orders;
  ok(!list.some(o => o.id === wid), "закрита угода зникла зі списку активних");
  const listAll = (await api("/api/finance/wholesale?all=1")).b.orders;
  ok(listAll.some(o => o.id === wid), "але видно в повному списку");

  // ── прибирання ─────────────────────────────────────────────────
  db.prepare("DELETE FROM cash_moves WHERE wholesale_id=?").run(wid);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id=?").run(expId);
  db.prepare("DELETE FROM expense_payments WHERE expense_id=?").run(expId);
  db.prepare("DELETE FROM expenses WHERE id=?").run(expId);
  db.prepare("DELETE FROM wholesale_shipments WHERE wholesale_id=?").run(wid);
  db.prepare("DELETE FROM wholesale_orders WHERE id=?").run(wid);
})();
