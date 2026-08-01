# План: статус «Зібрано» + деталізація виплат

Спека: [2026-08-01-collected-status-and-payout-details.md](../specs/2026-08-01-collected-status-and-payout-details.md)

**Мета:** розділити роботу пакувальника Бази й пакувальниці окремим статусом
`collected`, дати адміну й дроперу нормальну деталізацію виплат.

**Підхід:** три незалежні частини. Задачі 1–3 — одна логічна зміна (статус),
деплоїться разом. Задачі 4–6 — чистий фронт без змін на сервері, деплояться окремо.

**Стек:** Node/Express + better-sqlite3, ванільний JS фронт, Fly.io.

## Глобальні обмеження

- Автотестів у проєкті немає. Кожна зміна на сервері перевіряється на живому
  локальному сервері реальними фікстурами (`__Test...`), через реальні
  API-ендпоінти, з перевіркою стану БД і прибиранням фікстур після себе.
- Локальний сервер: `mcp__Claude_Browser__preview_start` з конфігом `warehouse-crm`.
  Після змін у `server.js`/`db.js` сервер треба перезапустити; для змін лише
  в `.html` — не треба.
- Dev-логін: `fetch('/api/auth/dev-login/<role>', {method:'POST'})`, далі перехід
  на потрібну сторінку з невеликою затримкою.
- `git add` тільки конкретними файлами, ніколи `-A`. Комміт-меседж закінчується
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Деплой після кожної логічної частини: `git push origin main` + `fly deploy`,
  перевірка `curl -s -o /dev/null -w "%{http_code}\n" https://warehouse-crm.fly.dev/login` → 200.
- Код нового статусу всюди: `collected`. Назва українською: `Зібрано`. Колір: `#14b8a6`.

---

## Задача 1: статус `collected` у БД і на сервері

**Файли:**
- Змінити: `db.js` (після блоку реконсиляції статусів, ~рядок 725)
- Змінити: `server.js:1662`

**Віддає далі:** статус-код `collected` існує в `order_statuses` і приймається
`PUT /api/orders/:id/status`; `packed_by` заповнюється при переході в `collected`.

- [ ] **Крок 1: додати міграцію статусу в `db.js`**

Одразу після закритого блоку `})();` (рядок 725, той що дошиває `delivering`):

```js
// «Зібрано» — проміжний статус між «В роботі» і «Запаковано». Пакувальник Бази
// ставить його, зібравши речі з полиці; фінальний «Запаковано» лишається за
// пакувальницею (скан ТТН). Додається тут, а не в seed вище, бо на проді
// order_statuses уже заповнена. is_system — щоб адмін не видалив статус, на
// якому тримається потік складу.
if (!db.prepare("SELECT id FROM order_statuses WHERE code='collected'").get()) {
  const ip = db.prepare("SELECT sort_order FROM order_statuses WHERE code='in_progress'").get();
  const base = ip ? ip.sort_order : 2;
  db.prepare("UPDATE order_statuses SET sort_order=sort_order+1 WHERE sort_order>?").run(base);
  db.prepare("INSERT INTO order_statuses(code,name,color,sort_order,is_system)VALUES('collected','Зібрано','#14b8a6',?,1)").run(base + 1);
  console.log("✅ Додано статус 'Зібрано'");
}
```

- [ ] **Крок 2: дозволити `packed_by` для `collected` у `server.js:1662`**

Було:

```js
  if (status === "in_progress" || status === "packed") {
```

Стало:

```js
  // packed_by = хто фізично працював із замовленням: взяв у роботу, зібрав або
  // запакував. packed_at лишається тільки для packed — це час фактичного
  // пакування, на ньому тримається статистика.
  if (status === "in_progress" || status === "collected" || status === "packed") {
```

- [ ] **Крок 3: перезапустити сервер і перевірити, що статус з'явився**

```bash
curl -s localhost:3000/api/order-statuses
```

Очікується: у списку є `{"code":"collected","name":"Зібрано",...}` з `is_system:1`,
його `sort_order` на 1 більший за `in_progress`, а `packed` зсунувся вище.

- [ ] **Крок 4: перевірити перехід на живій фікстурі**

Створити тестове замовлення з товаром, у якого `stock_base.quantity_actual` відомий.
Прогнати через API три сценарії й перевірити БД після кожного:

1. `new` → `in_progress` → `collected`: `quantity_actual` зменшився рівно один раз
   (на кроці `in_progress`), `packed_by` заповнений, `packed_at` порожній.
2. Нове замовлення `new` → одразу `collected`: `quantity_actual` зменшився рівно
   один раз.
3. Нове замовлення `new` → `collected` → `packed`: `packed_at` проставився на
   останньому кроці.

Прибрати всі фікстури.

- [ ] **Крок 5: комміт**

```bash
git add db.js server.js
git commit -m "Статус «Зібрано»: міграція БД + приймання на сервері"
```

---

## Задача 2: пакувальник Бази — вкладка «Зібрані» і згорнута картка

**Файли:**
- Змінити: `public/warehouse.html` — CSS (~рядок 59), `SL`/`SC` (192–193),
  `WHS` (194), `renderOrderCard` (256), новий стан `whExpanded`.

**Споживає:** статус `collected` із Задачі 1.

- [ ] **Крок 1: додати клас тегу після рядка 59**

```css
.tag-coll{background:rgba(20,184,166,.14);color:#14b8a6}
```

- [ ] **Крок 2: додати підпис і клас статусу (рядки 192–193)**

У `SL` після `in_progress:"В роботі",` додати `collected:"Зібрано",`.
У `SC` після `in_progress:"tag-prog",` додати `collected:"tag-coll",`.

- [ ] **Крок 3: перебудувати `WHS` (рядок 194)**

У вкладки `in_progress` замінити `next:"packed"` на `next:"collected"` (підпис
кнопки `nl` лишається «Готово»). Після неї додати вкладку:

```js
{key:"collected",label:Icon('package',13)+" Зібрані"},
```

- [ ] **Крок 4: додати стан розгортання і компактну картку**

Поряд із `var whLoadedOrders=[];` (рядок 343) додати:

```js
// Зібрані замовлення пакувальник бачить згорнутими й приглушеними, щоб не
// роздати одне й те саме двічі. whExpanded тримає ті, які він сам розгорнув
// кнопкою «Детальніше» — скидається при перезавантаженні списку.
var whExpanded={};
function expandCollected(id){whExpanded[id]=1;refreshOrderCard(id)}
function renderCollectedCard(o){
  var totalItems=o.items.reduce(function(s,i){return s+i.quantity},0);
  return '<div class="ocard" style="opacity:.45">'+
    '<div class="ocard-header"><div>'+
    '<div class="ocard-id"><span style="font-size:18px">#'+o.id+'</span> <span class="tag tag-coll">'+Icon('check',11)+' Зібрано</span> <span class="tag" style="background:var(--accbg);color:var(--acc)">'+totalItems+' шт</span></div>'+
    '<div class="cl-name">'+esc(o.client_name)+'</div>'+
    '<div class="cl-addr">'+esc(o.client_city)+' · '+esc(o.client_warehouse)+'</div>'+
    (o.ttn?'<div style="font-family:JetBrains Mono,monospace;font-size:13px;font-weight:700;color:var(--warn);margin-top:3px">'+esc(o.ttn)+'</div>':'')+
    '</div><div class="ocard-meta"><div style="color:var(--blue)">'+esc(o.drop_name)+'</div><div>'+(o.created_at?o.created_at.slice(0,16):"")+'</div></div></div>'+
    '<div class="ocard-footer" style="justify-content:flex-end"><button class="btn btn-sm" onclick="expandCollected('+o.id+')">'+Icon('eye',13)+' Детальніше</button></div>'+
  '</div>';
}
```

- [ ] **Крок 5: підключити компактну картку в `renderOrderCard` (рядок 256)**

Першим рядком тіла функції:

```js
function renderOrderCard(o){
  // Пакувальник Готового товару має власний потік і зібраних не бачить.
  if(o.status==="collected"&&ME.worker_role!=="packer_ready"&&!whExpanded[o.id])return renderCollectedCard(o);
```

- [ ] **Крок 6: скидати `whExpanded` при перезавантаженні списку**

У `loadOrders` (рядок 344), одразу після `renderStabs();` додати:

```js
  whExpanded={};
```

- [ ] **Крок 7: перевірити в браузері**

Зайти пакувальником (`pack2`, База). На вкладці «В роботі» натиснути «Готово» —
картка зникає зі списку. Перейти на «Зібрані» — замовлення там, картка згорнута
й приглушена, без чекбоксів. Натиснути «Детальніше» — розгортається у звичайний
вигляд зі списком речей. Перезавантажити список — знову згорнута.

Окремо: зайти `pack3` (Готовий товар) і переконатись, що його потік
`new`→«Запаковано» не змінився.

- [ ] **Крок 8: комміт**

```bash
git add public/warehouse.html
git commit -m "Пакувальник Бази: «Готово» → «Зібрано», згорнуті зібрані картки"
```

---

## Задача 3: пакувальниця й підписи статусів у решті UI

**Файли:**
- Змінити: `public/finalizer.html:173` і `:96`
- Змінити: `public/drop.html:234`
- Змінити: `public/admin.html:1651`

**Критично:** без правки `finalizer.html:173` потік стане — пакувальниця не
зможе закрити щойно зібране замовлення.

- [ ] **Крок 1: дозволити фіналізацію зі статусу `collected` (`finalizer.html:173`)**

Було:

```js
    if(o.status==="packed"||o.status==="new"||o.status==="in_progress")
```

Стало:

```js
    if(o.status==="packed"||o.status==="new"||o.status==="in_progress"||o.status==="collected")
```

- [ ] **Крок 2: додати підпис статусу в три файли**

У `finalizer.html:96` (`var SL={...}`), `drop.html:234` (`var SL={...}`) і
`admin.html:1651` (`const OSL={...}`) — після `in_progress:"В роботі",` додати:

```js
collected:"Зібрано",
```

- [ ] **Крок 3: перевірити наскрізний потік на фікстурі**

Замовлення з ТТН провести пакувальником до `collected`, потім зайти
пакувальницею (`final1`), просканувати ТТН — кнопка «Підтвердити відправку»
має з'явитись; натиснути. Перевірити в БД: статус `packed`, `packed_at`
проставлений, у `worker_payroll` з'явились нарахування за це замовлення.
Прибрати фікстури.

- [ ] **Крок 4: комміт і деплой першої частини**

```bash
git add public/finalizer.html public/drop.html public/admin.html
git commit -m "Пакувальниця фіналізує зібрані замовлення; підписи статусу «Зібрано»"
git push origin main
fly deploy
curl -s -o /dev/null -w "%{http_code}\n" https://warehouse-crm.fly.dev/login
```

Очікується: `200`.

---

## Задача 4: адмін — деталізація виплати

**Файли:**
- Змінити: `public/admin.html:2320` (`renderPayouts`)

Змін на сервері немає — `GET /api/payouts/all` уже віддає `items` з `is_return`,
`client_name`, `ttn`, `return_ttn`, сумами.

- [ ] **Крок 1: порахувати % повернень у `renderPayouts`**

Після рядка `var returnSum=...` додати:

```js
    // Відсоток повернень у межах цієї виплати — швидка оцінка якості дропера.
    var totalCnt=success.length+returns.length;
    var retPct=totalCnt?(returns.length/totalCnt*100):0;
    var retColor=retPct<10?"var(--acc)":(retPct<=25?"var(--warn)":"var(--red)");
```

- [ ] **Крок 2: вивести % у шапці картки**

У рядок із лічильниками (`'<div style="font-size:10px;margin-top:3px">...'`)
дописати в кінець, перед закриваючим `'</div>'`:

```js
+' · <span style="color:'+retColor+';font-weight:700">'+retPct.toFixed(0)+'% повернень</span>'
```

- [ ] **Крок 3: додати кнопки «Детальніше» і «Картка дропера»**

Перед блоком `'<div style="display:none;border-top:1px solid var(--brd)">'` додати
рядок кнопок. `stopPropagation` обов'язковий — інакше клік ще й розгорне картку:

```js
    '<div style="padding:0 14px 10px;display:flex;gap:6px">'+
      '<button class="btn btn-sm" onclick="event.stopPropagation();togglePayoutDetails(this)">'+Icon('eye',13)+' Детальніше · '+totalCnt+' замовл.</button>'+
      '<button class="btn btn-sm" onclick="event.stopPropagation();viewDropStats('+p.dropshipper_id+',\''+esc(p.drop_name).replace(/'/g,"")+'\')">'+Icon('barChart3',13)+' Картка дропера</button>'+
    '</div>'+
```

- [ ] **Крок 4: додати перемикач біля `markPaid` (рядок 2361)**

```js
// Кнопка «Детальніше» відкриває той самий блок зі списком замовлень, що й клік
// по шапці картки. Ряд кнопок стоїть безпосередньо перед цим блоком, тому
// nextElementSibling батька кнопки — це саме він.
function togglePayoutDetails(btn){
  var wrap=btn.parentElement.nextElementSibling;
  if(!wrap)return;
  wrap.style.display=wrap.style.display==="none"?"":"none";
}
```

- [ ] **Крок 5: перевірити в браузері**

Зайти адміном, відкрити Виплати. На картці видно `N% повернень` потрібним
кольором. «Детальніше» розгортає список замовлень і не ламає клік по шапці.
«Картка дропера» відкриває модалку зі статистикою саме цього дропера.

- [ ] **Крок 6: комміт**

```bash
git add public/admin.html
git commit -m "Адмін-виплати: % повернень, явне «Детальніше», перехід у картку дропера"
```

---

## Задача 5: дропер — видно, за які замовлення подано виплату

**Файли:**
- Змінити: `public/drop.html:820-822` (активний запит), `:826-843` (історія)

- [ ] **Крок 1: винести рендер списку замовлень у спільну функцію**

Перед `async function loadPayouts` додати:

```js
// Список замовлень усередині виплати — однаковий для активного запиту і для
// історії. items приходять з /api/payouts/my з прапорцем is_return.
function payItemsHtml(items){
  var success=(items||[]).filter(function(i){return !i.is_return});
  var rets=(items||[]).filter(function(i){return i.is_return});
  var sSum=success.reduce(function(s,i){return s+i.amount},0);
  var rSum=rets.reduce(function(s,i){return s+Math.abs(i.amount)},0);
  return (success.length?'<div style="font-size:10px;font-weight:600;color:var(--acc);margin-bottom:4px">Успішні (+'+sSum.toFixed(0)+'₴):</div>'+success.map(function(i){return '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:10px;border-bottom:1px solid var(--brd)"><div style="color:var(--th)">#'+i.order_id+' '+esc(i.client_name)+(i.ttn?' <span style="color:var(--warn);font-family:JetBrains Mono,monospace">'+esc(i.ttn)+'</span>':'')+'</div><div style="color:var(--acc);font-weight:700;font-family:JetBrains Mono,monospace">+'+i.amount.toFixed(0)+'₴</div></div>'}).join(""):"")+
    (rets.length?'<div style="font-size:10px;font-weight:600;color:var(--red);margin:6px 0 4px">Повернення (-'+rSum.toFixed(0)+'₴):</div>'+rets.map(function(i){return '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:10px;border-bottom:1px solid var(--brd)"><div style="color:var(--th)">#'+i.order_id+' '+esc(i.client_name)+'</div><div style="color:var(--red);font-weight:700;font-family:JetBrains Mono,monospace">'+i.amount.toFixed(0)+'₴</div></div>'}).join(""):"");
}
// Відсоток повернень у межах виплати, той самий розрахунок, що в адміна.
function payRetPct(items){
  var all=(items||[]).length;var rets=(items||[]).filter(function(i){return i.is_return}).length;
  return all?(rets/all*100):0;
}
function payPctColor(pct){return pct<10?"var(--acc)":(pct<=25?"var(--warn)":"var(--red)")}
function togglePayBlock(btn){var w=btn.parentElement.nextElementSibling;if(w)w.style.display=w.style.display==="none"?"":"none"}
```

- [ ] **Крок 2: активний запит зі списком (`drop.html:821`)**

Замінити вміст `pay-active-block` на версію з кнопкою і списком:

```js
      var aPct=payRetPct(r.activeItems);
      document.getElementById("pay-active-block").innerHTML='<div style="background:rgba(255,167,38,.06);border:1px solid rgba(255,167,38,.15);border-radius:10px;padding:12px;margin-bottom:10px">'+
        '<div style="font-size:13px;font-weight:600;color:var(--warn);margin-bottom:6px">'+Icon('clipboardList',13)+' Активний запит #'+r.active.id+' · <span style="font-family:JetBrains Mono,monospace">'+r.active.total_amount.toFixed(0)+'₴</span></div>'+
        '<div style="font-size:11px;color:var(--td)">'+r.activeItems.length+' замовлень · Створено: '+(r.active.created_at?.slice(0,16)||"")+' · <span style="color:'+payPctColor(aPct)+';font-weight:700">'+aPct.toFixed(0)+'% повернень</span></div>'+
        (r.active.comment?'<div style="font-size:11px;color:var(--t);margin-top:4px">'+Icon('messageSquare',11)+' '+esc(r.active.comment)+'</div>':'')+
        '<div style="margin-top:8px"><button class="btn btn-sm" onclick="togglePayBlock(this)">'+Icon('eye',12)+' Детальніше · '+r.activeItems.length+' замовл.</button></div>'+
        '<div style="display:none;margin-top:8px;border-top:1px solid var(--brd);padding-top:8px">'+payItemsHtml(r.activeItems)+'</div>'+
      '</div>';
```

- [ ] **Крок 3: історія — кнопка і % повернень (`drop.html:826`)**

У картці історії: додати `% повернень` у блок із лічильниками (рядок 836),
кнопку «Детальніше» перед блоком `display:none`, а сам блок зі списком замінити
викликом `payItemsHtml(p.items)`.

- [ ] **Крок 4: перевірити в браузері**

Зайти дропером із активним запитом на виплату. Активний запит показує кнопку
«Детальніше», під нею — конкретні замовлення з номерами, ТТН і сумами.
В історії те саме. Суми в списку сходяться з підсумком виплати.

- [ ] **Крок 5: комміт**

```bash
git add public/drop.html
git commit -m "Дропер бачить, за які саме замовлення подано виплату"
```

---

## Задача 6: підпис «прибуток» на картці замовлення дропера

**Файли:**
- Змінити: `public/drop.html:387`

- [ ] **Крок 1: додати підпис під сумою**

У блоці справа зверху, одразу після `div` із `money`, додати підпис у стилі
сусідніх рядків (`₴ нал`, `дроп ...₴`):

```js
'<div style="font-size:10px;color:'+(isRet?'var(--red)':'var(--acc)')+';margin-top:-2px">'+(isRet?'збиток':'прибуток')+'</div>'+
```

- [ ] **Крок 2: перевірити в браузері**

На сторінці замовлень дропера над `₴ нал` тепер підписано «прибуток»;
у замовленні-поверненні — «збиток» червоним.

- [ ] **Крок 3: комміт і деплой другої частини**

```bash
git add public/drop.html
git commit -m "Картка замовлення дропера: підпис «прибуток»/«збиток» біля суми"
git push origin main
fly deploy
curl -s -o /dev/null -w "%{http_code}\n" https://warehouse-crm.fly.dev/login
```

Очікується: `200`.
