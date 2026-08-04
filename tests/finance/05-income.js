const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

(async () => {
  await login("admin");
  const o = db.prepare("SELECT id,total_drop_price FROM orders WHERE status!='delivered' AND total_drop_price>0 ORDER BY id DESC LIMIT 1").get();
  ok(!!o, "є замовлення для перевірки: #" + (o && o.id));
  db.prepare("UPDATE orders SET delivered_at='' WHERE id=?").run(o.id);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(o.id);

  let r = await api("/api/orders/" + o.id + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  ok(r.s === 200, "статус змінено на delivered");

  const row = db.prepare("SELECT delivered_at FROM orders WHERE id=?").get(o.id);
  ok(!!row.delivered_at, "delivered_at проставлено: " + row.delivered_at);
  const moves = db.prepare("SELECT * FROM cash_moves WHERE ref_type='order' AND ref_id=?").all(o.id);
  ok(moves.length === 1 && moves[0].amount === Math.round(o.total_drop_price * 100) / 100, "дохід записано один раз на " + (moves[0] && moves[0].amount));
  ok(moves[0].date === row.delivered_at.slice(0, 10), "дата доходу — день отримання");

  // повторний перехід не має подвоїти дохід
  await api("/api/orders/" + o.id + "/status", { method: "PUT", body: JSON.stringify({ status: "shipped" }) });
  await api("/api/orders/" + o.id + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  const again = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='order' AND ref_id=?").get(o.id).c;
  ok(again === 1, "повторне отримання доходу не подвоїло (" + again + ")");

  const first = db.prepare("SELECT delivered_at FROM orders WHERE id=?").get(o.id).delivered_at;
  ok(first === row.delivered_at, "delivered_at не перезаписалось");

  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(o.id);
})();
