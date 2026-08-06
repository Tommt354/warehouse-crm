// Вкладка «Гроші»: журнал витрат, борги постачальникам, звірка з банком.
// Логіку тримаємо окремим файлом — admin.html уже завеликий.
var finCats = [], finSups = [], finReport = null, finWorkshops = [];
var finExpenses = [], finSettings = null;
// id витрати, яку зараз редагують у fin-exp-modal; null = форма додавання.
var finEditExpenseId = null;
// id категорії/постачальника, рядок якого зараз розкритий на редагування.
var finCatEditId = null, finSupEditId = null;

// Назви типів логіки словами власника, а не кодом: він обирає, що система
// має зробити з грошима, і більше нічого не вказує.
var FIN_KIND_LABEL = {
  expense: "відняти від прибутку",
  material: "матеріал (тканина, фурнітура)",
  sewing: "робота цеху",
  purchase: "закупка готового товару"
};

function setFinPeriod(days){
  ["fin-7","fin-30","fin-90"].forEach(function(id){var b=document.getElementById(id);if(b)b.classList.remove("on")});
  var b=document.getElementById("fin-"+days); if(b)b.classList.add("on");
  var end=new Date(), start=new Date(end.getTime()-(days-1)*86400000);
  function f(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
  document.getElementById("fin-df").value=f(start);
  document.getElementById("fin-dt").value=f(end);
  loadFinance();
}

function showFinTab(t){
  ["list","debts","cats","mgr"].forEach(function(x){
    document.getElementById("fin-v-"+x).style.display=x===t?"":"none";
    document.getElementById("fintab-"+x).classList.toggle("on",x===t);
  });
}

async function loadFinance(){
  if(!document.getElementById("fin-df").value)return setFinPeriod(30);
  var f=document.getElementById("fin-df").value, t=document.getElementById("fin-dt").value;
  try{
    finCats=(await api("/api/finance/categories")).categories;
    finSups=(await api("/api/finance/suppliers")).suppliers;
    finWorkshops=(await api("/api/workshops")).workshops;
    finSettings=await api("/api/finance/settings");
    finReport=await api("/api/finance/report?from="+f+"&to="+t);
    finExpenses=(await api("/api/finance/expenses?from="+f+"&to="+t)).expenses;
    renderFinSummary(); renderFinList(finExpenses); renderFinDebts(); renderFinCats(); renderFinMgr();
  }catch(e){}
}

function finMoney(v){return (Math.round((v||0)*100)/100).toLocaleString("uk-UA")}

function renderFinSummary(){
  var r=finReport;
  function tile(l,v,c){return '<div style="flex:1;min-width:140px;background:var(--card);border:1px solid var(--brd);border-radius:10px;padding:10px"><div style="font-size:10px;color:var(--td);margin-bottom:4px">'+l+'</div><div style="font-size:18px;font-weight:700;color:'+(c||"var(--th)")+'">'+v+'</div></div>'}
  document.getElementById("fin-summary").innerHTML='<div style="display:flex;flex-wrap:wrap;gap:8px">'
    +tile("Надходження",finMoney(r.income)+"₴","var(--acc)")
    +tile("Витрати періоду",finMoney(r.opex_spent)+"₴","var(--red)")
    +tile("Вкладено в товар",finMoney(r.goods_spent)+"₴","var(--warn)")
    +tile("Різниця по касі",finMoney(r.cash_delta)+"₴",r.cash_delta<0?"var(--red)":"var(--acc)")
    +tile("Має бути на рахунку",finMoney(r.balance)+"₴")
    +tile("Борги постачальникам",finMoney(r.debts_total)+"₴",r.debts_total?"var(--warn)":"var(--th)")
    +tile("Прибуток за період",finMoney(r.profit_cash)+"₴",r.profit_cash<0?"var(--red)":"var(--acc)")
    +(r.manager?tile(esc(r.manager.name)+" "+r.manager.percent+"%",finMoney(r.manager.amount)+"₴"):"")
    +(r.manager?tile("Прибуток після виплати",finMoney(r.profit_after_manager)+"₴",r.profit_after_manager<0?"var(--red)":"var(--acc)"):"")
    +'</div>'
    +'<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    +'<button class="btn btn-sm" onclick="openFinCheck()">Звірити з банком</button>'
    +'<button class="btn btn-sm" onclick="openFinSettings()">'+Icon('banknote',13)+' Стартовий залишок</button>'
    +(r.last_check?'<span style="font-size:11px;color:'+(Math.abs(r.last_check.diff)<0.01?"var(--acc)":"var(--red)")+'">остання звірка '+esc(r.last_check.date)+': різниця '+finMoney(r.last_check.diff)+'₴</span>':'')
    +'</div>';
}

function renderFinList(exp){
  var byCat=finReport.by_category.map(function(c){
    return '<span style="font-size:11px;padding:3px 8px;border-radius:6px;background:var(--bg);color:'+(c.is_goods?"var(--warn)":"var(--td)")+';margin-right:4px">'+esc(c.name||"—")+' '+finMoney(c.amount)+'₴</span>';
  }).join("");
  var rows=exp.map(function(e){
    return '<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--brd);font-size:12px">'
      +'<div><b style="color:var(--th)">'+esc(e.category_name||"без категорії")+'</b>'+(e.is_goods?' <span style="font-size:10px;color:var(--warn)">товар</span>':'')
      +'<div style="font-size:10px;color:var(--td)">'+esc(e.date)+(e.supplier_name?' · '+esc(e.supplier_name):'')+(e.workshop_name?' · '+esc(e.workshop_name):'')+(e.note?' · '+esc(e.note):'')+'</div></div>'
      +'<div style="text-align:right;white-space:nowrap"><div style="display:flex;align-items:center;gap:6px;justify-content:flex-end">'+finMoney(e.amount)+'₴'
      +'<button class="btn btn-sm" onclick="openFinExpense('+e.id+')" title="Виправити">'+Icon('pencil',11)+'</button>'
      +'<button class="btn btn-sm btn-d" onclick="delFinExpense('+e.id+')" title="Видалити">'+Icon('trash2',11)+'</button></div>'
      +(e.debt>0?'<div style="font-size:10px;color:var(--red)">борг '+finMoney(e.debt)+'₴ <button class="btn btn-sm" onclick="payFinExpense('+e.id+','+e.debt+')">Оплатити</button></div>':'')
      +'</div></div>';
  }).join("");
  document.getElementById("fin-v-list").innerHTML='<div style="margin-bottom:8px">'+byCat+'</div>'+(rows||'<div class="empty">Витрат за період немає</div>');
}

function renderFinDebts(){
  var rows=finSups.filter(function(s){return s.debt>0}).map(function(s){
    return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--brd);font-size:12px"><div>'+esc(s.name)+'</div><div style="color:var(--red)">'+finMoney(s.debt)+'₴</div></div>';
  }).join("");
  // Постачальника без боргу в списку боргів вище не видно, а перейменувати
  // мусимо будь-якого — тому окремим блоком показуємо всіх.
  var allRows=finSups.map(function(s){
    if(finSupEditId===s.id){
      return '<div style="display:flex;gap:6px;align-items:center;padding:6px 0;border-top:1px solid var(--brd);flex-wrap:wrap">'
        +'<input id="fs-edit-name" value="'+esc(s.name)+'" placeholder="Назва" style="flex:1;min-width:110px;padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff">'
        +'<input id="fs-edit-note" value="'+esc(s.note||"")+'" placeholder="Коментар" style="flex:1;min-width:110px;padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff">'
        +'<button class="btn btn-sm btn-p" onclick="saveFinSupEdit('+s.id+')">'+Icon('check',11)+'</button>'
        +'<button class="btn btn-sm" onclick="finSupEditId=null;renderFinDebts()">'+Icon('x',11)+'</button></div>';
    }
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid var(--brd);font-size:12px">'
      +'<div>'+esc(s.name)+(s.note?' <span style="font-size:10px;color:var(--td)">· '+esc(s.note)+'</span>':'')+'</div>'
      +'<button class="btn btn-sm" onclick="finSupEditId='+s.id+';renderFinDebts()">'+Icon('pencil',11)+'</button></div>';
  }).join("");
  document.getElementById("fin-v-debts").innerHTML=(rows||'<div class="empty">Боргів немає</div>')
    +'<div style="margin-top:10px;display:flex;gap:6px"><input id="fin-sup-name" placeholder="Новий постачальник" style="flex:1;padding:8px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff"><button class="btn btn-sm btn-p" onclick="addFinSupplier()">Додати</button></div>'
    +'<div style="margin-top:16px;font-size:11px;color:var(--td);text-transform:uppercase;letter-spacing:.04em">Усі постачальники</div>'
    +allRows;
}

async function saveFinSupEdit(id){
  var name=document.getElementById("fs-edit-name").value.trim();
  if(!name)return;
  var note=document.getElementById("fs-edit-note").value;
  try{await api("/api/finance/suppliers/"+id,{method:"PUT",body:JSON.stringify({name:name,note:note,active:1})});finSupEditId=null;loadFinance()}catch(e){alert(e.message)}
}

function renderFinCats(){
  var rows=finCats.map(function(c){
    if(finCatEditId===c.id){
      return '<div style="display:flex;gap:6px;align-items:center;padding:7px 0;border-top:1px solid var(--brd);flex-wrap:wrap">'
        +'<input id="fc-edit-name" value="'+esc(c.name)+'" placeholder="Назва" style="flex:1;min-width:130px;padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff">'
        +'<select id="fc-edit-kind" style="padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff">'
        +Object.keys(FIN_KIND_LABEL).map(function(k){return '<option value="'+k+'"'+(k===c.kind?' selected':'')+'>'+FIN_KIND_LABEL[k]+'</option>'}).join("")
        +'</select>'
        +'<button class="btn btn-sm btn-p" onclick="saveFinCatEdit('+c.id+')">'+Icon('check',11)+'</button>'
        +'<button class="btn btn-sm" onclick="finCatEditId=null;renderFinCats()">'+Icon('x',11)+'</button></div>';
    }
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-top:1px solid var(--brd);font-size:12px">'
      +'<div>'+esc(c.name)+' <span style="font-size:10px;color:'+(c.is_goods?"var(--warn)":"var(--td)")+'">'+FIN_KIND_LABEL[c.kind]+'</span></div>'
      +'<div style="display:flex;gap:4px"><button class="btn btn-sm" onclick="finCatEditId='+c.id+';renderFinCats()">'+Icon('pencil',11)+'</button>'
      +'<button class="btn btn-sm btn-d" onclick="delFinCat('+c.id+')">×</button></div></div>';
  }).join("");
  document.getElementById("fin-v-cats").innerHTML=rows
    +'<div style="margin-top:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
    +'<input id="fin-cat-name" placeholder="Назва категорії" style="flex:1;min-width:160px;padding:8px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff">'
    +'<select id="fin-cat-kind" style="padding:8px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff">'
    +Object.keys(FIN_KIND_LABEL).map(function(k){return '<option value="'+k+'">'+FIN_KIND_LABEL[k]+'</option>'}).join("")
    +'</select>'
    +'<button class="btn btn-sm btn-p" onclick="addFinCat()">Додати</button></div>';
}

async function saveFinCatEdit(id){
  var name=document.getElementById("fc-edit-name").value.trim();
  if(!name)return;
  var kind=document.getElementById("fc-edit-kind").value;
  try{await api("/api/finance/categories/"+id,{method:"PUT",body:JSON.stringify({name:name,kind:kind,active:1})});finCatEditId=null;loadFinance()}catch(e){alert(e.message)}
}

// Ставка менеджера: історія рядків, а не одне число — стара ставка не
// переписується, бо за закриті місяці вже заплачено за тодішньою домовленістю.
// Поки жодної ставки немає, плиток менеджера в звіті теж немає — вони
// зʼявляються самі, щойно бекенд знайде актуальний рядок на дату звіту.
function renderFinMgr(){
  var rates=(finSettings&&finSettings.manager_rates)||[];
  var rows=rates.map(function(r){
    return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-top:1px solid var(--brd);font-size:12px">'
      +'<div>'+esc(r.name)+'</div><div style="color:var(--th)">'+r.percent+'% <span style="color:var(--td);font-size:10px">з '+esc(r.from_date)+'</span></div></div>';
  }).join("");
  document.getElementById("fin-v-mgr").innerHTML=
    '<div style="font-size:11px;color:var(--td);margin-bottom:10px">Менеджер отримує відсоток від прибутку. Нова ставка не змінює вже пораховані місяці — додайте новий рядок з датою, з якої діє новий відсоток.</div>'
    +(rows||'<div class="empty">Ставок ще немає</div>')
    +'<div class="fld-row" style="margin-top:12px">'
    +'<div class="fld"><label>Імʼя</label><input id="mr-name" placeholder="Імʼя менеджера"></div>'
    +'<div class="fld"><label>Відсоток %</label><input id="mr-percent" type="number" step="0.1" min="0" max="100"></div>'
    +'</div>'
    +'<div class="fld"><label>Діє з</label><input type="date" id="mr-from"></div>'
    +'<div id="mr-err" style="display:none;color:var(--red);font-size:11px;margin-bottom:6px"></div>'
    +'<button class="btn btn-sm btn-p" onclick="addFinManagerRate()">Додати ставку</button>';
  document.getElementById("mr-from").value=new Date().toISOString().slice(0,10);
}

async function addFinManagerRate(){
  var err=document.getElementById("mr-err");
  var name=document.getElementById("mr-name").value.trim();
  var percent=parseFloat(document.getElementById("mr-percent").value);
  var from=document.getElementById("mr-from").value;
  try{
    await api("/api/finance/manager-rate",{method:"POST",body:JSON.stringify({name:name,percent:percent,from_date:from})});
    err.style.display="none";
    loadFinance();
  }catch(e){err.textContent=e.message;err.style.display="block"}
}

// Без id — форма додавання нової витрати. З id — редагування вже введеної:
// журнал власник заповнює руками щодня, і має бути спосіб виправити описку.
function openFinExpense(id){
  finEditExpenseId=id||null;
  var e=finEditExpenseId?finExpenses.find(function(x){return x.id===finEditExpenseId}):null;
  document.getElementById("fe-modal-title").textContent=e?"Редагувати витрату":"Витрата";
  document.getElementById("fe-date").value=e?e.date:new Date().toISOString().slice(0,10);
  document.getElementById("fe-amount").value=e?e.amount:"";
  document.getElementById("fe-note").value=e?(e.note||""):"";
  // paid — це те, чи витрата була оплачена одразу СТВОРЕННЯМ; редагування
  // не проводить нову оплату (для цього є "Оплатити" в списку), тож поле
  // ховаємо, щоб не виглядало, ніби зміна суми ще раз спише гроші з каси.
  document.getElementById("fe-paid-fld").style.display=e?"none":"";
  document.getElementById("fe-paid").checked=true;
  document.getElementById("fe-err").style.display="none";
  document.getElementById("fe-cat").innerHTML=finCats.map(function(c){return '<option value="'+c.id+'" data-kind="'+c.kind+'">'+esc(c.name)+' — '+FIN_KIND_LABEL[c.kind]+'</option>'}).join("");
  document.getElementById("fe-sup").innerHTML='<option value="">—</option>'+finSups.map(function(s){return '<option value="'+s.id+'">'+esc(s.name)+'</option>'}).join("");
  document.getElementById("fe-workshop").innerHTML='<option value="">—</option>'+finWorkshops.map(function(w){return '<option value="'+w.id+'">'+esc(w.name)+'</option>'}).join("");
  if(e){document.getElementById("fe-cat").value=e.category_id;document.getElementById("fe-sup").value=e.supplier_id||"";document.getElementById("fe-workshop").value=e.workshop_id||"";}
  onFinCatChange();
  openM("fin-exp-modal");
}

// Категорія типу sewing (робота цеху) без прив'язки до цеху — бекенд
// відповість 400 (див. finance.js:sewingExpenseHasWorkshop). Поле цеху
// показуємо лише тоді, коли воно дійсно потрібне.
function onFinCatChange(){
  var sel=document.getElementById("fe-cat");
  var opt=sel.options[sel.selectedIndex];
  var isSewing=opt && opt.dataset.kind==="sewing";
  document.getElementById("fe-workshop-fld").style.display=isSewing?"":"none";
}

async function saveFinExpense(btn){
  var err=document.getElementById("fe-err");
  var body={date:document.getElementById("fe-date").value,amount:parseFloat(document.getElementById("fe-amount").value),
    category_id:parseInt(document.getElementById("fe-cat").value),supplier_id:parseInt(document.getElementById("fe-sup").value)||null,
    workshop_id:parseInt(document.getElementById("fe-workshop").value)||null,
    note:document.getElementById("fe-note").value};
  try{
    if(finEditExpenseId)await api("/api/finance/expenses/"+finEditExpenseId,{method:"PUT",body:JSON.stringify(body)});
    else{body.paid=document.getElementById("fe-paid").checked?1:0;await api("/api/finance/expenses",{method:"POST",body:JSON.stringify(body)});}
    closeM("fin-exp-modal");loadFinance();
  }catch(e){err.textContent=e.message;err.style.display="block"}
}

async function delFinExpense(id){
  if(!confirm("Видалити витрату разом з оплатами й рухами каси? Дію не можна відмінити."))return;
  try{await api("/api/finance/expenses/"+id,{method:"DELETE"});loadFinance()}catch(e){alert(e.message)}
}

async function payFinExpense(id,debt){
  var v=prompt("Скільки платимо? Залишок боргу "+finMoney(debt)+"₴", debt);
  if(v===null)return;
  try{await api("/api/finance/expenses/"+id+"/pay",{method:"POST",body:JSON.stringify({amount:parseFloat(v)})});loadFinance()}catch(e){alert(e.message)}
}

async function addFinCat(){
  var name=document.getElementById("fin-cat-name").value.trim();
  if(!name)return;
  try{await api("/api/finance/categories",{method:"POST",body:JSON.stringify({name:name,kind:document.getElementById("fin-cat-kind").value})});loadFinance()}catch(e){alert(e.message)}
}

async function delFinCat(id){
  if(!confirm("Прибрати категорію?"))return;
  try{await api("/api/finance/categories/"+id,{method:"DELETE"});loadFinance()}catch(e){alert(e.message)}
}

async function addFinSupplier(){
  var name=document.getElementById("fin-sup-name").value.trim();
  if(!name)return;
  try{await api("/api/finance/suppliers",{method:"POST",body:JSON.stringify({name:name})});loadFinance()}catch(e){alert(e.message)}
}

function openFinCheck(){
  document.getElementById("fc-calc").textContent="За системою на рахунку має бути "+finMoney(finReport.balance)+"₴";
  document.getElementById("fc-actual").value="";
  document.getElementById("fc-res").textContent="";
  openM("fin-check-modal");
}

async function saveFinCheck(btn){
  var v=parseFloat(document.getElementById("fc-actual").value);
  if(isNaN(v))return;
  try{
    var r=await api("/api/finance/cash-check",{method:"POST",body:JSON.stringify({actual_balance:v})});
    var el=document.getElementById("fc-res");
    el.style.color=Math.abs(r.diff)<0.01?"var(--acc)":"var(--red)";
    el.textContent=Math.abs(r.diff)<0.01?"Все сходиться":"Розбіжність "+finMoney(r.diff)+"₴ — якийсь рух не записано";
    loadFinance();
  }catch(e){alert(e.message)}
}

// Стартовий залишок каси: без нього розрахунковий баланс рахує рухи з нуля,
// і звірка з банком нічого не показує (calcBalance у finance.js на бекенді).
function openFinSettings(){
  document.getElementById("fs-balance").value=finSettings?finSettings.cash_opening_balance:0;
  // Порожню дату старту не показуємо — бекенд однаково підставить сьогодні,
  // якщо зберегти без дати, тож префілюємо тут сьогоднішнім днем, щоб
  // власник одразу бачив, від якого дня рахується залишок, а не гадав.
  document.getElementById("fs-date").value=(finSettings&&finSettings.cash_opening_date)||new Date().toISOString().slice(0,10);
  document.getElementById("fs-err").style.display="none";
  openM("fin-settings-modal");
}

async function saveFinSettings(){
  var err=document.getElementById("fs-err");
  var body={cash_opening_balance:parseFloat(document.getElementById("fs-balance").value)||0,
    cash_opening_date:document.getElementById("fs-date").value||""};
  try{await api("/api/finance/settings",{method:"PUT",body:JSON.stringify(body)});closeM("fin-settings-modal");loadFinance()}
  catch(e){err.textContent=e.message;err.style.display="block"}
}

// Повернення коштів клієнту. Кнопка стоїть у картці замовлення (admin.html),
// звідти й приходять total/refunded — вони вже є в об'єкті замовлення, тож
// окремий запит на відкриття модалки не потрібен.
function openOrderRefund(orderId,total,refunded){
  document.getElementById("rf-order-id").value=orderId;
  var max=Math.round(((total||0)-(refunded||0))*100)/100;
  document.getElementById("rf-info").textContent=refunded>0
    ?("Клієнт заплатив "+finMoney(total)+"₴, уже повернено "+finMoney(refunded)+"₴. Можна повернути ще до "+finMoney(max)+"₴.")
    :("Клієнт заплатив "+finMoney(total)+"₴. Можна повернути до "+finMoney(max)+"₴.");
  document.getElementById("rf-amount").value="";
  document.getElementById("rf-amount").max=max;
  document.getElementById("rf-note").value="";
  document.getElementById("rf-err").style.display="none";
  openM("refund-modal");
}

async function saveOrderRefund(){
  var id=document.getElementById("rf-order-id").value;
  var err=document.getElementById("rf-err");
  var amount=parseFloat(document.getElementById("rf-amount").value);
  if(!amount||amount<=0){err.textContent="Вкажіть суму повернення";err.style.display="block";return}
  try{
    await api("/api/finance/orders/"+id+"/refund",{method:"POST",body:JSON.stringify({amount:amount,note:document.getElementById("rf-note").value})});
    closeM("refund-modal");
    // Картка замовлення — не вкладка "Гроші": оновлюємо список замовлень,
    // якщо він на екрані, щоб одразу побачити нову суму повернення.
    if(typeof loadAdmOrders==="function")loadAdmOrders(admOrdFilter);
  }catch(e){err.textContent=e.message;err.style.display="block"}
}
