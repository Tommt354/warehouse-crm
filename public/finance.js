// Вкладка «Гроші»: журнал витрат, борги постачальникам, звірка з банком.
// Логіку тримаємо окремим файлом — admin.html уже завеликий.
var finCats = [], finSups = [], finReport = null, finWorkshops = [];
var finExpenses = [], finSettings = null, finDelivered = null;
// Журнал: власне джерело даних вкладки «Журнал», перезавантажується разом
// з рештою фінмодуля (loadFinance) для того самого періоду — окремого
// календаря вкладка не має. Фільтр за типом — суто фронтенд-стан, тримаємо
// його тут, а не в даті/періоді, щоб зміна фільтра не тягла новий запит.
var finJournal = null, finJournalKindFilter = "";
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

// Тільки календар, без жодного запиту — викликається одноразово при
// завантаженні сторінки, щоб поля дат і кнопка "30д" були готові, коли
// власник відкриє вкладку «Гроші», але сама вкладка при цьому НЕ тягне
// 5 запитів фінмодуля щоразу, коли просто відкрили адмінку (setFinPeriod
// нижче робить те саме плюс вантажить дані — саме її раніше й викликали
// при завантаженні сторінки).
function initFinDates(days){
  ["fin-7","fin-30","fin-90"].forEach(function(id){var b=document.getElementById(id);if(b)b.classList.remove("on")});
  var b=document.getElementById("fin-"+days); if(b)b.classList.add("on");
  var end=new Date(), start=new Date(end.getTime()-(days-1)*86400000);
  function f(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
  document.getElementById("fin-df").value=f(start);
  document.getElementById("fin-dt").value=f(end);
}

function setFinPeriod(days){
  initFinDates(days);
  loadFinance();
}

function showFinTab(t){
  ["list","delivered","debts","journal","cats","goods","wholesale","mgr"].forEach(function(x){
    document.getElementById("fin-v-"+x).style.display=x===t?"":"none";
    document.getElementById("fintab-"+x).classList.toggle("on",x===t);
  });
}

async function loadFinance(){
  if(!document.getElementById("fin-df").value)return setFinPeriod(30);
  var f=document.getElementById("fin-df").value, t=document.getElementById("fin-dt").value;
  var errEl=document.getElementById("fin-err");
  try{
    finCats=(await api("/api/finance/categories")).categories;
    finSups=(await api("/api/finance/suppliers")).suppliers;
    finWorkshops=(await api("/api/workshops")).workshops;
    finSettings=await api("/api/finance/settings");
    finReport=await api("/api/finance/report?from="+f+"&to="+t);
    finExpenses=(await api("/api/finance/expenses?from="+f+"&to="+t)).expenses;
    finDelivered=await api("/api/finance/delivered?from="+f+"&to="+t);
    finJournal=await api("/api/finance/journal?from="+f+"&to="+t);
    if(errEl){errEl.style.display="none";errEl.textContent=""}
    renderFinSummary(); renderFinList(finExpenses); renderFinDelivered(); renderFinDebts(); renderFinJournal(); renderFinCats(); renderFinMgr(); loadFinGoods(); loadWholesale();
  }catch(e){
    // Порожній catch тут ковтав помилку мовчки — власник бачив старі цифри
    // й не здогадувався, що запит відпав (напр. сесія злетіла чи бекенд
    // упав). Показуємо так само, як інші місця вкладки (fe-err/fs-err/
    // rf-err/mr-err) — текстом над плитками, а не alert(), щоб не заважати
    // побачити, які саме дані застаріли.
    if(errEl){errEl.textContent="Не вдалось завантажити дані вкладки: "+e.message;errEl.style.display="block"}
  }
}

function finMoney(v){return (Math.round((v||0)*100)/100).toLocaleString("uk-UA")}

// esc() (admin.html) прибирає <, > і & — досить для тексту всередині тегу,
// але тут значення підставляються в атрибут value="..." інлайнових рядків
// редагування нижче: подвійна лапка в назві категорії чи постачальника
// розриває атрибут і ламає розмітку. Локальний хелпер лише для фінмодуля,
// а не правка esc() глобально — esc() використовується по всьому
// admin.html (сотні місць за межами фінансів), і міняти її поведінку там,
// де це не потрібно, — зайвий ризик регресу в інших вкладках.
function escAttr(s){return esc(s).replace(/"/g,"&quot;")}

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

// Розшифровка плитки «Надходження»: кожне забране за період замовлення
// (delivered_at у діапазоні, status='delivered' — те саме правило, що й на
// бекенді GET /api/finance/delivered/GET /api/finance/report). Сума дроп-цін
// тут навмисно звірена в підсумковому рядку з income звіту, щоб розходження
// між двома екранами було одразу видно, а не ховалось мовчки.
function renderFinDelivered(){
  var d=finDelivered;
  var el=document.getElementById("fin-v-delivered");
  if(!d||!d.orders||!d.orders.length){el.innerHTML='<div class="empty">За обраний період немає забраних замовлень</div>';return}
  function tile(l,v,c){return '<div style="flex:1;min-width:130px;background:var(--card);border:1px solid var(--brd);border-radius:10px;padding:10px"><div style="font-size:10px;color:var(--td);margin-bottom:4px">'+l+'</div><div style="font-size:16px;font-weight:700;color:'+(c||"var(--th)")+'">'+v+'</div></div>'}
  var summary='<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px">'
    +tile("Посилок",d.count)
    +tile("Сума дроп-цін",finMoney(d.drop_price_sum)+"₴","var(--acc)")
    +tile("Сума наложок",finMoney(d.cod_sum)+"₴")
    +'</div>';
  // Без повернень у періоді сума дроп-цін збігається з «Надходження» звіту
  // напряму. З поверненнями — пояснюємо різницю рядком, а не лишаємо власника
  // гадати, чому два числа не рівні.
  summary+='<div style="font-size:11px;color:var(--td);margin-bottom:10px">'
    +(Math.abs(d.refunds_in_period)>0.001
      ? ('Сума дроп-цін '+finMoney(d.drop_price_sum)+'₴ мінус повернення коштів клієнтам у цьому періоді '+finMoney(-d.refunds_in_period)+'₴ = '+finMoney(d.income_check)+'₴ — це і є «Надходження» зі звіту.')
      : ('Сума дроп-цін тут — це і є «Надходження» зі звіту ('+finMoney(d.income_check)+'₴).'))
    +'</div>';
  var rows=d.orders.map(function(o){
    return '<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--brd);font-size:12px">'
      +'<div><b style="color:var(--th)">Замовлення #'+o.id+'</b>'+(o.ttn?' <span style="font-size:10px;color:var(--td)">ТТН '+esc(o.ttn)+'</span>':'')
      +'<div style="font-size:10px;color:var(--td)">'+esc((o.delivered_at||"").slice(0,10))+' · '+esc(o.drop_name||"—")+'</div></div>'
      +'<div style="text-align:right;white-space:nowrap">'
      +'<div>'+finMoney(o.total_drop_price)+'₴ <span style="font-size:10px;color:var(--td)">дроп</span></div>'
      +'<div style="font-size:10px;color:var(--td)">наложка '+finMoney(o.cod_amount)+'₴</div>'
      +(o.refunded_amount>0?'<div style="font-size:10px;color:var(--red)">повернено '+finMoney(o.refunded_amount)+'₴</div>':'')
      +'</div></div>';
  }).join("");
  el.innerHTML=summary+rows;
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
        +'<input id="fs-edit-name" value="'+escAttr(s.name)+'" placeholder="Назва" style="flex:1;min-width:110px;padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff">'
        +'<input id="fs-edit-note" value="'+escAttr(s.note||"")+'" placeholder="Коментар" style="flex:1;min-width:110px;padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff">'
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

// Журнал: власник бере виписку з банку й проходиться по рядках, тож формат
// навмисно "як у банку" — дата, опис, сума зі знаком, залишок після. Рядки,
// що не рухають гроші (борг), позначені окремо й БЕЗ залишку — showFinTab
// уже перемикає видимість блоку, тут лише малюємо вміст.
function setFinJournalKind(v){finJournalKindFilter=v;renderFinJournal()}

function renderFinJournal(){
  var el=document.getElementById("fin-v-journal");
  var j=finJournal;
  if(!j){el.innerHTML='<div class="empty">Немає даних за обраний період</div>';return}
  function tile(l,v,c){return '<div style="flex:1;min-width:130px;background:var(--card);border:1px solid var(--brd);border-radius:10px;padding:10px"><div style="font-size:10px;color:var(--td);margin-bottom:4px">'+l+'</div><div style="font-size:16px;font-weight:700;color:'+(c||"var(--th)")+'">'+v+'</div></div>'}
  var summary='<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">'
    +tile("Прийшло",finMoney(j.summary.income)+"₴","var(--acc)")
    +tile("Пішло",finMoney(j.summary.outcome)+"₴","var(--red)")
    +tile("Чиста різниця",finMoney(j.summary.net)+"₴",j.summary.net<0?"var(--red)":"var(--acc)")
    +tile("Залишок на кінець періоду",finMoney(j.summary.balance_end)+"₴")
    +'</div>';
  var kinds=j.kinds||[];
  var filterHtml='<div style="margin-bottom:10px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
    +'<span style="font-size:11px;color:var(--td)">Тип операції:</span>'
    +'<select onchange="setFinJournalKind(this.value)" style="padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff;font-size:12px">'
    +'<option value="">Усі типи</option>'
    +kinds.map(function(k){return '<option value="'+k.value+'"'+(finJournalKindFilter===k.value?' selected':'')+'>'+esc(k.label)+'</option>'}).join("")
    +'</select></div>';
  var rows=(j.rows||[]).filter(function(r){return !finJournalKindFilter||r.journal_kind===finJournalKindFilter});
  if(!rows.length){
    el.innerHTML=summary+filterHtml+'<div class="empty">'+(j.rows&&j.rows.length?'Немає операцій цього типу за обраний період':'Операцій за обраний період немає')+'</div>';
    return;
  }
  var rowsHtml=rows.map(function(r){
    // Тип операції без людського опису (kind_label===null) — прогалина в
    // мапі описів на бекенді (finance.js:JOURNAL_KIND_LABELS), а не помилка
    // фронтенда: показуємо сирий код як є, а не вигадуємо назву.
    var label=r.kind_label?esc(r.kind_label):('<span style="color:var(--warn)">'+esc(r.kind)+' (немає опису)</span>');
    var amtColor=r.amount>0?"var(--acc)":(r.amount<0?"var(--red)":"var(--th)");
    var balHtml=r.is_cash?('<div style="font-size:10px;color:var(--td)">залишок '+finMoney(r.balance_after)+'₴</div>')
      :'<div style="font-size:10px;color:var(--warn)">борг · грошей ще не було, залишку не змінює</div>';
    return '<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--brd);font-size:12px'
      +(r.is_cash?'':';opacity:.75')+'">'
      +'<div><b style="color:var(--th)">'+label+'</b>'
      +(r.source?'<div style="font-size:10px;color:var(--td)">'+esc(r.source)+'</div>':'')
      +'<div style="font-size:10px;color:var(--td)">'+esc(r.date)+'</div></div>'
      +'<div style="text-align:right;white-space:nowrap"><div style="color:'+amtColor+';font-weight:600">'+(r.amount>0?"+":"")+finMoney(r.amount)+'₴</div>'
      +balHtml+'</div></div>';
  }).join("");
  el.innerHTML=summary+filterHtml+rowsHtml;
}

function renderFinCats(){
  var rows=finCats.map(function(c){
    if(finCatEditId===c.id){
      return '<div style="display:flex;gap:6px;align-items:center;padding:7px 0;border-top:1px solid var(--brd);flex-wrap:wrap">'
        +'<input id="fc-edit-name" value="'+escAttr(c.name)+'" placeholder="Назва" style="flex:1;min-width:130px;padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff">'
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
  var wsSel=document.getElementById("fe-ws");
  if(wsSel)wsSel.innerHTML='<option value="">—</option>'+(finWholesale||[]).map(function(w){return '<option value="'+w.id+'">'+esc(w.client_name)+'</option>'}).join("");
  document.getElementById("fe-sup").innerHTML='<option value="">—</option>'+finSups.map(function(s){return '<option value="'+s.id+'">'+esc(s.name)+'</option>'}).join("");
  document.getElementById("fe-workshop").innerHTML='<option value="">—</option>'+finWorkshops.map(function(w){return '<option value="'+w.id+'">'+esc(w.name)+'</option>'}).join("");
  if(e){document.getElementById("fe-cat").value=e.category_id;document.getElementById("fe-sup").value=e.supplier_id||"";document.getElementById("fe-workshop").value=e.workshop_id||"";}
  onFinCatChange();
  checkFeDateWarn();
  openM("fin-exp-modal");
}

// Рух каси, датований раніше за cash_opening_date, calcBalance() (finance.js)
// суму назавжди пропускає — власник має побачити це одразу при виборі дати,
// а не здогадуватись потім, чому «Має бути на рахунку» не зійшлося з
// випискою. Лише попередження, не блокування: іноді власник свідомо заводить
// давню витрату для повноти журналу, і це його право.
function checkFeDateWarn(){
  var w=document.getElementById("fe-warn");
  var d=document.getElementById("fe-date").value;
  var opening=finSettings&&finSettings.cash_opening_date;
  if(d&&opening&&d<opening){
    w.textContent="Дата раніша за старт обліку каси ("+opening+") — цей рух не потрапить у розрахунковий залишок.";
    w.style.display="block";
  }else{
    w.style.display="none";
  }
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

// Повернення коштів клієнту. Кнопка стоїть у картці замовлення (admin.html).
// Стелю раніше рахували тут-таки з полів замовлення (total_drop_price/
// cod_amount) — для замовлення, яке отримали, а потім НП повернула
// (onOrderUndelivered прибрав прихід із каси), це обіцяло повну суму, хоча
// бекенд гарантовано відмовляв нулем. Тепер питаємо той самий вираз, яким
// керується бекенд (GET .../refund-ceiling = orderReceivedAmount мінус
// уже повернене, finance.js), щоб модалка не могла розійтись із реальністю.
async function openOrderRefund(orderId){
  document.getElementById("rf-order-id").value=orderId;
  document.getElementById("rf-info").textContent="Рахуємо, скільки можна повернути…";
  document.getElementById("rf-amount").value="";
  document.getElementById("rf-amount").max="";
  document.getElementById("rf-note").value="";
  document.getElementById("rf-err").style.display="none";
  openM("refund-modal");
  var hint=document.getElementById("rf-payout-hint");
  if(hint)hint.textContent="Виплата дроперу за це замовлення буде знята повністю.";
  try{
    var c=await api("/api/finance/orders/"+orderId+"/refund-ceiling");
    document.getElementById("rf-info").textContent=c.refunded>0
      ?("Реально надійшло "+finMoney(c.received)+"₴, уже повернено "+finMoney(c.refunded)+"₴. Можна повернути ще до "+finMoney(c.max)+"₴.")
      :("Реально надійшло "+finMoney(c.received)+"₴. Можна повернути до "+finMoney(c.max)+"₴.");
    document.getElementById("rf-amount").max=c.max;
  }catch(e){
    document.getElementById("rf-err").textContent="Не вдалось порахувати стелю повернення: "+e.message;
    document.getElementById("rf-err").style.display="block";
  }
}

async function saveOrderRefund(){
  var id=document.getElementById("rf-order-id").value;
  var err=document.getElementById("rf-err");
  var amount=parseFloat(document.getElementById("rf-amount").value);
  if(!amount||amount<=0){err.textContent="Вкажіть суму повернення";err.style.display="block";return}
  // Гроші реально йдуть з рахунку і дію не можна відмінити з інтерфейсу —
  // підтвердження тут, а не лише кнопка в картці замовлення, страхує від
  // випадкового кліку/подвійного тапу на мобільному.
  if(!confirm("Повернути клієнту "+finMoney(amount)+"₴ по замовленню #"+id+"? Дію не можна відмінити."))return;
  try{
    var res=await api("/api/finance/orders/"+id+"/refund",{method:"POST",body:JSON.stringify({amount:amount,note:document.getElementById("rf-note").value})});
    closeM("refund-modal");
    // Виплату дроперу за це замовлення система знімає сама. Але якщо йому вже
    // заплатили — не чіпає: мовчки забрати виплачені гроші не можна, тому
    // кажемо адміну суму, яку треба закрити руками через баланс.
    if(res&&res.payout_already_paid)alert("Дроперу за це замовлення вже виплачено "+finMoney(res.payout_to_settle)+"₴. Система їх не забирає — врегулюйте вручну через баланс дропера.");
    // Картка замовлення — не вкладка "Гроші": оновлюємо список замовлень,
    // якщо він на екрані, щоб одразу побачити нову суму повернення.
    if(typeof loadAdmOrders==="function")loadAdmOrders(admOrdFilter);
  }catch(e){err.textContent=e.message;err.style.display="block"}
}


// ── Товар зараз ───────────────────────────────────────────────────
// Друга лінія обліку: скільки грошей лежить у товарі. З лінією грошей вона
// не додається, а звіряється — саме тому «реальний результат» показуємо як
// прибуток по касі плюс приріст вартості товару, і поруч пояснюємо, звідки
// береться різниця з тим, що видно на рахунку.
async function loadFinGoods(){
  var f=document.getElementById("fin-df").value, t=document.getElementById("fin-dt").value;
  var el=document.getElementById("fin-v-goods");
  var g;
  try{ g=await api("/api/goods/report?from="+f+"&to="+t) }
  catch(e){ el.innerHTML='<div class="empty">Не вдалось завантажити: '+esc(e.message)+'</div>'; return }

  function tile(l,v,sub,c){return '<div style="flex:1;min-width:150px;background:var(--card);border:1px solid var(--brd);border-radius:10px;padding:10px">'
    +'<div style="font-size:10px;color:var(--td);margin-bottom:4px">'+l+'</div>'
    +'<div style="font-size:17px;font-weight:700;color:'+(c||"var(--th)")+'">'+v+'</div>'
    +(sub?'<div style="font-size:10px;color:var(--td);margin-top:2px">'+sub+'</div>':'')+'</div>'}

  var shelves='<div style="display:flex;flex-wrap:wrap;gap:8px">'
    +tile("Матеріали",finMoney(g.materials.cost)+"₴",g.materials.qty+" од.")
    +tile("Фурнітура",finMoney(g.notions.cost)+"₴")
    +tile("Крій у цехах",finMoney(g.cuts.cost)+"₴",g.cuts.qty+" шт")
    +tile("Склад",finMoney(g.stock.cost)+"₴",g.stock.qty+" шт")
    +tile("Повернення",finMoney(g.returns.cost)+"₴",g.returns.qty+" шт")
    +tile("У дорозі",finMoney(g.in_transit.cost)+"₴",g.in_transit.qty+" шт")
    +tile("Разом у товарі",finMoney(g.total)+"₴","","var(--acc)")
    +'</div>';

  var profitCash=finReport?finReport.profit_cash:0;
  var real=Math.round((profitCash+g.goods_delta)*100)/100;
  var period='<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">'
    +tile("Собівартість проданого",finMoney(g.cogs_period)+"₴","за період")
    +tile("Втрати (брак, недостача)",finMoney(g.lost_period)+"₴","за період",g.lost_period?"var(--red)":"var(--th)")
    +tile("Осіло в товарі",(g.goods_delta>0?"+":"")+finMoney(g.goods_delta)+"₴","куплено мінус продано й втрачено",g.goods_delta<0?"var(--warn)":"var(--acc)")
    +tile("Реальний результат",(real>0?"+":"")+finMoney(real)+"₴","прибуток по касі + приріст товару",real<0?"var(--red)":"var(--acc)")
    +'</div>';

  var warn="";
  if(g.unvalued.lots_qty>0||g.unvalued.cuts>0){
    warn='<div style="margin-top:10px;padding:9px;border:1px solid rgba(255,167,38,.3);border-radius:10px;background:rgba(255,167,38,.06);font-size:11px;color:var(--warn)">'
      +'Неоцінене: '+g.unvalued.lots_qty+' шт на складі'+(g.unvalued.cuts?' і '+g.unvalued.cuts+' партій крою':'')
      +' — ці одиниці рахуються нулем, поки їм не проставлено вартість. Сума в товарі занижена на цю величину.</div>';
  }

  el.innerHTML=shelves+period+warn
    +'<div style="margin-top:10px;font-size:11px;color:var(--td)">Гроші й товар — дві окремі лінії: у місяць великої закупівлі каса показує мінус, а вартість товару росте на ту саму суму. Реальний результат — це їхня сума.</div>';
}


// ── Опт ───────────────────────────────────────────────────────────
// Кожна угода — окремий кошик: гроші приходять частинами й можуть прийти вже
// після відвантаження, шиється і їде теж частинами. Тому «отримано» і
// «відвантажено» тут журнали, а не одна дата.
var WS_STATUS = { in_work: "в роботі", shipped: "відвантажується", closed: "закрита", cancelled: "скасована" };
var wsShowAll = false;

async function loadWholesale(){
  var el=document.getElementById("fin-v-wholesale");
  var r;
  try{ r=await api("/api/finance/wholesale"+(wsShowAll?"?all=1":"")) }
  catch(e){ el.innerHTML='<div class="empty">Не вдалось завантажити: '+esc(e.message)+'</div>'; return }
  var rows=r.orders.map(function(w){
    var color=w.profit<0?"var(--red)":"var(--acc)";
    return '<div style="border-top:1px solid var(--brd);padding:9px 0;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;cursor:pointer" onclick="openWholesale('+w.id+')">'
      +'<div><b style="font-size:13px;color:var(--th)">'+esc(w.client_name)+'</b>'
      +' <span style="font-size:10px;color:var(--td)">'+(WS_STATUS[w.status]||w.status)+'</span>'
      +'<div style="font-size:10px;color:var(--td)">угода '+finMoney(w.deal_amount)+'₴'
      +(w.left_to_pay>0?' · лишилось отримати '+finMoney(w.left_to_pay)+'₴':' · оплачено повністю')
      +(w.shipments_count?' · відвантажень '+w.shipments_count+(w.shipped_qty?' ('+w.shipped_qty+' шт)':''):'')+'</div></div>'
      +'<div style="text-align:right;white-space:nowrap;font-size:12px">'
      +'<div>отримано '+finMoney(w.received)+'₴</div>'
      +'<div style="color:var(--td)">витрачено '+finMoney(w.spent)+'₴</div>'
      +'<div style="color:'+color+'">результат '+(w.profit>0?"+":"")+finMoney(w.profit)+'₴</div></div></div>';
  }).join("");
  finWholesale=r.orders.filter(function(w){return w.status==="in_work"||w.status==="shipped"});
  el.innerHTML='<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">'
    +'<button class="btn btn-sm btn-p" onclick="openWholesaleNew()">'+Icon("plus",13)+' Нова угода</button>'
    +'<button class="stab'+(wsShowAll?" on":"")+'" onclick="wsShowAll=!wsShowAll;loadWholesale()">показати закриті</button></div>'
    +(rows||'<div class="empty">Оптових замовлень немає</div>')
    +'<div style="margin-top:10px;font-size:11px;color:var(--td)">Опт не змішується з роздробом: у загальному звіті він іде окремим рядком, а тут — по кожній угоді окремо.</div>';
}

function openWholesaleNew(){
  document.getElementById("ws-client").value="";
  document.getElementById("ws-amount").value="";
  document.getElementById("ws-note").value="";
  document.getElementById("ws-err").style.display="none";
  openM("ws-modal");
}

async function saveWholesale(){
  var err=document.getElementById("ws-err");
  try{
    await api("/api/finance/wholesale",{method:"POST",body:JSON.stringify({
      client_name:document.getElementById("ws-client").value,
      deal_amount:parseFloat(document.getElementById("ws-amount").value)||0,
      note:document.getElementById("ws-note").value})});
    closeM("ws-modal");loadWholesale();
  }catch(e){err.textContent=e.message;err.style.display="block"}
}

async function openWholesale(id){
  var d;
  try{ d=(await api("/api/finance/wholesale/"+id)).order }catch(e){ alert(e.message); return }
  document.getElementById("ws-d-title").textContent=d.client_name+" — "+(WS_STATUS[d.status]||d.status);
  function rows(list,fmt){return list.length?list.map(fmt).join(""):'<div style="font-size:11px;color:var(--td);padding:4px 0">порожньо</div>'}
  document.getElementById("ws-d-body").innerHTML=
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;font-size:12px">'
      +'<span style="padding:5px 9px;border-radius:6px;background:var(--bg)">угода '+finMoney(d.deal_amount)+'₴</span>'
      +'<span style="padding:5px 9px;border-radius:6px;background:var(--bg);color:var(--acc)">отримано '+finMoney(d.received)+'₴</span>'
      +'<span style="padding:5px 9px;border-radius:6px;background:var(--bg);color:var(--red)">витрачено '+finMoney(d.spent)+'₴</span>'
      +'<span style="padding:5px 9px;border-radius:6px;background:var(--bg);color:'+(d.profit<0?"var(--red)":"var(--acc)")+'">результат '+(d.profit>0?"+":"")+finMoney(d.profit)+'₴</span>'
      +(d.left_to_pay>0?'<span style="padding:5px 9px;border-radius:6px;background:var(--bg);color:var(--warn)">чекаємо '+finMoney(d.left_to_pay)+'₴</span>':'')
    +'</div>'
    +'<div style="font-size:12px;font-weight:600;color:var(--th);margin-bottom:4px">Платежі</div>'
    +rows(d.payments,function(p){return '<div style="font-size:11px;padding:3px 0;border-top:1px solid var(--brd);display:flex;justify-content:space-between"><span>'+esc(p.date)+' '+esc(p.note||"")+'</span><span style="color:var(--acc)">+'+finMoney(p.amount)+'₴</span></div>'})
    +'<div style="display:flex;gap:6px;margin:6px 0 12px"><input id="ws-pay-amount" type="number" step="0.01" placeholder="сума" style="width:110px;padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff"><input id="ws-pay-note" placeholder="коментар" style="flex:1;padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff"><button class="btn btn-sm btn-p" onclick="addWholesalePayment('+d.id+')">Платіж</button></div>'
    +'<div style="font-size:12px;font-weight:600;color:var(--th);margin-bottom:4px">Витрати по угоді</div>'
    +rows(d.expenses,function(e){return '<div style="font-size:11px;padding:3px 0;border-top:1px solid var(--brd);display:flex;justify-content:space-between"><span>'+esc(e.date)+' '+esc(e.category_name||"")+' '+esc(e.note||"")+'</span><span style="color:var(--red)">−'+finMoney(e.amount)+'₴</span></div>'})
    +'<div style="font-size:10px;color:var(--td);margin:4px 0 12px">Витрати додаються у вкладці «Витрати» — там оберіть цю угоду.</div>'
    +'<div style="font-size:12px;font-weight:600;color:var(--th);margin-bottom:4px">Відвантаження</div>'
    +rows(d.shipments,function(s){return '<div style="font-size:11px;padding:3px 0;border-top:1px solid var(--brd);display:flex;justify-content:space-between"><span>'+esc(s.date)+' '+esc(s.note||"")+'</span><span>'+(s.qty||0)+' шт</span></div>'})
    +'<div style="display:flex;gap:6px;margin:6px 0 12px"><input id="ws-ship-qty" type="number" step="1" placeholder="шт" style="width:80px;padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff"><input id="ws-ship-note" placeholder="що поїхало" style="flex:1;padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff"><button class="btn btn-sm" onclick="addWholesaleShipment('+d.id+')">Відвантажив</button></div>'
    +'<div style="display:flex;gap:6px"><button class="btn btn-sm" onclick="setWholesaleStatus('+d.id+',\'closed\')">Закрити угоду</button><button class="btn btn-sm btn-d" onclick="setWholesaleStatus('+d.id+',\'cancelled\')">Скасувати</button></div>';
  openM("ws-detail-modal");
}

async function addWholesalePayment(id){
  var v=parseFloat(document.getElementById("ws-pay-amount").value);
  if(!v||v<=0)return;
  try{await api("/api/finance/wholesale/"+id+"/payment",{method:"POST",body:JSON.stringify({amount:v,note:document.getElementById("ws-pay-note").value})});openWholesale(id);loadWholesale();loadFinance()}catch(e){alert(e.message)}
}
async function addWholesaleShipment(id){
  try{await api("/api/finance/wholesale/"+id+"/shipment",{method:"POST",body:JSON.stringify({qty:parseFloat(document.getElementById("ws-ship-qty").value)||0,note:document.getElementById("ws-ship-note").value})});openWholesale(id);loadWholesale()}catch(e){alert(e.message)}
}
async function setWholesaleStatus(id,st){
  if(st==="cancelled"&&!confirm("Скасувати угоду? Платежі й витрати лишаться в обліку."))return;
  try{await api("/api/finance/wholesale/"+id,{method:"PUT",body:JSON.stringify({status:st})});closeM("ws-detail-modal");loadWholesale()}catch(e){alert(e.message)}
}
