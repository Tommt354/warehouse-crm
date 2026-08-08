// Нова Пей утримує відсоток із КОЖНОЇ прийнятої наложки — з повної суми, яку
// заплатив клієнт, а не з нашого заробітку. Без цього на рахунок падало б
// менше, ніж каже система, і звірка з банком розходилась би щодня.
const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

(async () => {
  await login("admin");
  const today = new Date().toISOString().slice(0, 10);
  const dropId = db.prepare("SELECT id FROM users WHERE role='dropshipper' LIMIT 1").get().id;

  const settingsBefore = (await api("/api/finance/settings")).b;
  await api("/api/finance/settings", { method: "POST", body: "{}" }).catch(() => {});
  await api("/api/finance/settings", { method: "PUT", body: JSON.stringify({ novapay_percent: 0.5 }) });
  const st = (await api("/api/finance/settings")).b;
  ok(st.novapay_percent === 0.5, "відсоток збережено (" + st.novapay_percent + ")");

  const before = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;

  // ── наложкове замовлення на 10 000 ─────────────────────────────
  const oid = db.prepare(`INSERT INTO orders(dropshipper_id,client_name,status,cod_amount,total_drop_price,payout_amount)
    VALUES(?,'__T13 Наложка','packed',10000,6000,4000)`).run(dropId).lastInsertRowid;
  await api("/api/orders/" + oid + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });

  const cod = db.prepare("SELECT amount FROM cash_moves WHERE kind='cod' AND ref_id=?").get(oid);
  const fee = db.prepare("SELECT amount FROM cash_moves WHERE kind='fee' AND ref_type='novapay' AND ref_id=?").get(oid);
  ok(cod && cod.amount === 10000, "прихід наложки повною сумою (" + (cod && cod.amount) + ")");
  ok(fee && fee.amount === -50, "комісія 0.5% від 10 000 = 50₴ знята (" + (fee && fee.amount) + ")");

  const after = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(after.novapay_fee === 50, "комісія показана окремим рядком (" + after.novapay_fee + ")");
  ok(Math.abs(after.balance - (before.balance + 10000 - 50)) < 0.01,
    "залишок врахував і наложку, і комісію (" + before.balance + " → " + after.balance + ")");
  ok(Math.abs(after.profit_cash - (before.profit_cash + 6000 - 50)) < 0.01,
    "прибуток: дроп-ціна мінус комісія (" + before.profit_cash + " → " + after.profit_cash + ")");

  // ── передоплачене замовлення комісії не має ────────────────────
  const oid2 = db.prepare(`INSERT INTO orders(dropshipper_id,client_name,status,cod_amount,total_drop_price,is_prepaid)
    VALUES(?,'__T13 Передоплата','packed',0,5000,1)`).run(dropId).lastInsertRowid;
  await api("/api/orders/" + oid2 + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  const fee2 = db.prepare("SELECT amount FROM cash_moves WHERE kind='fee' AND ref_type='novapay' AND ref_id=?").get(oid2);
  ok(!fee2, "передоплачене замовлення комісії не породжує");

  // ── правка наложки тягне за собою комісію ──────────────────────
  db.prepare("UPDATE orders SET cod_amount=20000 WHERE id=?").run(oid);
  const finance = require("../../finance");
  finance.syncOrderCashMove(oid);
  const fee3 = db.prepare("SELECT amount FROM cash_moves WHERE kind='fee' AND ref_type='novapay' AND ref_id=?").get(oid);
  ok(fee3 && fee3.amount === -100, "наложку виправили на 20 000 — комісія стала 100₴ (" + (fee3 && fee3.amount) + ")");

  // ── повернення посилки знімає і наложку, і комісію ─────────────
  await api("/api/orders/" + oid + "/status", { method: "PUT", body: JSON.stringify({ status: "refused" }) });
  const gone = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_id=? AND kind IN ('cod','fee')").get(oid).c;
  ok(gone === 0, "посилку повернули — обидва рухи зняті (" + gone + ")");

  // ── прибирання ─────────────────────────────────────────────────
  await api("/api/finance/settings", { method: "PUT", body: JSON.stringify({ novapay_percent: settingsBefore.novapay_percent || 0 }) });
  db.prepare("DELETE FROM cash_moves WHERE ref_id IN (?,?)").run(oid, oid2);
  db.prepare("DELETE FROM orders WHERE id IN (?,?)").run(oid, oid2);
})();
