// Вкладка «Матеріали»: довідник тканин, рулони (прихід/залишки) і оцінка
// партій крою. Окремий файл — той самий підхід, що й finance.js, admin.html
// уже завеликий, щоб дописувати в нього ще один цілий домен.

// ── Стан вкладки ─────────────────────────────────────────────────
var GOODS_MATERIALS = [];           // довідник видів тканини, кешується між відкриттями форм
var matLots = [];                   // рулони за поточним фільтром
var matOnlyLeft = true;             // перемикач "лише з залишком" — за замовчуванням ховаємо вичерпані рулони
var matFilterMaterialId = "";
var matCuts = [];                   // неоцінені партії крою
var matSuppliers = null;            // постачальники для форми приходу рулону, ліниво

function materialUnitLabel(u){ return u==="kg" ? "кг" : "м"; }

// ── Довідник тканин: кешований fetch, бо форма приходу рулону і форма
// нормативів товару (admin.html) обидві його потребують і не повинні
// щоразу бити в мережу заново в межах однієї роботи з вкладкою.
async function loadGoodsMaterials(force){
  if(!force && GOODS_MATERIALS.length) return GOODS_MATERIALS;
  GOODS_MATERIALS = (await api("/api/goods/materials")).materials || [];
  return GOODS_MATERIALS;
}

// ── Вхід у вкладку (реєструється у словнику завантажувачів admin.html) ──
async function loadMaterialsTab(){
  await loadGoodsMaterials(true);
  fillMatFilterSelect();
  await Promise.all([loadMatLots(), loadMatCuts()]);
}

function fillMatFilterSelect(){
  var sel=document.getElementById("mat-filter-material");
  var cur=sel.value;
  sel.innerHTML='<option value="">Усі види тканини</option>'+GOODS_MATERIALS.map(function(m){
    return '<option value="'+m.id+'">'+esc(m.name)+' ('+materialUnitLabel(m.unit)+')</option>';
  }).join("");
  sel.value=cur||"";
}

function showMatTab(t){
  document.getElementById("mat-v-lots").style.display=t==="lots"?"":"none";
  document.getElementById("mat-v-cuts").style.display=t==="cuts"?"":"none";
  document.getElementById("mattab-lots").classList.toggle("on",t==="lots");
  document.getElementById("mattab-cuts").classList.toggle("on",t==="cuts");
}

function setMatFilterMaterial(v){ matFilterMaterialId=v; loadMatLots(); }
function toggleMatOnlyLeft(btn){
  matOnlyLeft=!matOnlyLeft;
  btn.classList.toggle("on",matOnlyLeft);
  loadMatLots();
}

async function loadMatLots(){
  var q="?"+(matFilterMaterialId?"material_id="+matFilterMaterialId+"&":"")+(matOnlyLeft?"only_left=1":"");
  matLots=(await api("/api/goods/lots"+q)).lots||[];
  renderMatSummary();
  renderMatLots();
}

function renderMatSummary(){
  var byUnit={}; var sumUah=0;
  matLots.forEach(function(l){
    byUnit[l.unit]=(byUnit[l.unit]||0)+l.qty_left;
    sumUah+=l.qty_left*l.price_uah;
  });
  function tile(l,v,c){return '<div style="flex:1;min-width:140px;background:var(--card);border:1px solid var(--brd);border-radius:10px;padding:10px"><div style="font-size:10px;color:var(--td);margin-bottom:4px">'+l+'</div><div style="font-size:18px;font-weight:700;color:'+(c||"var(--th)")+'">'+v+'</div></div>'}
  var tiles=Object.keys(byUnit).map(function(u){
    return tile("Тканини, "+materialUnitLabel(u), (Math.round(byUnit[u]*100)/100).toLocaleString("uk-UA")+" "+materialUnitLabel(u));
  }).join("");
  document.getElementById("mat-summary").innerHTML='<div style="display:flex;flex-wrap:wrap;gap:8px">'
    +tiles
    +tile("Сума залишку", finMoney(sumUah)+"₴", "var(--acc)")
    +'</div>';
}

function renderMatLots(){
  var el=document.getElementById("mat-lots-list");
  if(!matLots.length){el.innerHTML='<div class="empty">'+(matOnlyLeft?"Рулонів із залишком немає":"Рулонів немає")+'</div>';return}
  el.innerHTML=matLots.map(function(l){
    var u=materialUnitLabel(l.unit);
    return '<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--brd);font-size:12px">'
      +'<div><b style="color:var(--th)">'+esc(l.material_name)+'</b>'
      +(l.color?' <span style="color:var(--td)">'+esc(l.color)+'</span>':'')
      +(l.roll_no?' <span style="color:var(--td)">№'+esc(l.roll_no)+'</span>':'')
      +'<div style="font-size:10px;color:var(--td)">залишок '+l.qty_left+' з '+l.qty_total+' '+u
      +' · '+esc((l.created_at||"").slice(0,10))+(l.note?' · '+esc(l.note):'')+'</div></div>'
      +'<div style="text-align:right;white-space:nowrap">'
      +'<div>'+l.price_usd+'$ / '+finMoney(l.price_uah)+'₴ за '+u+'</div>'
      +'<div style="font-size:10px;color:var(--td)">на суму '+finMoney(l.qty_left*l.price_uah)+'₴</div>'
      +'</div></div>';
  }).join("");
}

// ── Прихід рулону ────────────────────────────────────────────────
async function openMatLot(){
  await loadGoodsMaterials(true);
  var sel=document.getElementById("mlot-material");
  sel.innerHTML=GOODS_MATERIALS.map(function(m){return '<option value="'+m.id+'" data-unit="'+m.unit+'">'+esc(m.name)+'</option>'}).join("");
  if(!GOODS_MATERIALS.length){
    document.getElementById("mlot-err").textContent="Спершу додайте вид тканини в довіднику.";
    document.getElementById("mlot-err").style.display="block";
  } else {
    document.getElementById("mlot-err").style.display="none";
  }
  document.getElementById("mlot-color").value="";
  document.getElementById("mlot-roll").value="";
  document.getElementById("mlot-qty").value="";
  document.getElementById("mlot-price-usd").value="";
  document.getElementById("mlot-note").value="";
  document.getElementById("mlot-expense").checked=true;
  if(!matSuppliers){ try{ matSuppliers=(await api("/api/finance/suppliers")).suppliers||[]; }catch(e){ matSuppliers=[]; } }
  document.getElementById("mlot-supplier").innerHTML='<option value="">—</option>'+matSuppliers.map(function(s){return '<option value="'+s.id+'">'+esc(s.name)+'</option>'}).join("");
  document.getElementById("mlot-fx-warn").style.display="none";
  document.getElementById("mlot-fx").value="";
  onMatLotMaterialChange();
  openM("mat-lot-modal");
  try{
    var fx=await api("/api/goods/fx");
    document.getElementById("mlot-fx").value=fx.rate||"";
    if(fx.fallback){
      document.getElementById("mlot-fx-warn").textContent="Курс НБУ зараз недоступний — підставлено останній відомий курс "+fx.rate+". Перевірте і виправте, якщо купували за іншим.";
      document.getElementById("mlot-fx-warn").style.display="block";
    }
    matLotRecalc();
  }catch(e){
    // Курс не підтягнувся мережею — форма лишається робочою, власник просто
    // вписує курс руками (так само як бекенд дозволяє, якщо fx_rate передано).
    document.getElementById("mlot-fx-warn").textContent="Не вдалось підтягти курс НБУ автоматично — вкажіть курс вручну.";
    document.getElementById("mlot-fx-warn").style.display="block";
  }
}

function onMatLotMaterialChange(){
  var sel=document.getElementById("mlot-material");
  var opt=sel.options[sel.selectedIndex];
  var unit=opt?materialUnitLabel(opt.dataset.unit):"";
  document.getElementById("mlot-qty-unit").textContent=unit;
  document.getElementById("mlot-price-unit").textContent=unit;
  matLotRecalc();
}

function matLotRecalc(){
  var qty=parseFloat(document.getElementById("mlot-qty").value)||0;
  var priceUsd=parseFloat(document.getElementById("mlot-price-usd").value)||0;
  var fx=parseFloat(document.getElementById("mlot-fx").value)||0;
  var sel=document.getElementById("mlot-material");
  var opt=sel.options[sel.selectedIndex];
  var unit=opt?materialUnitLabel(opt.dataset.unit):"од.";
  var priceUah=Math.round(priceUsd*fx*100)/100;
  var total=Math.round(qty*priceUah*100)/100;
  document.getElementById("mlot-calc").textContent=
    qty&&priceUsd&&fx
      ? (priceUsd+"$ × "+fx+" = "+finMoney(priceUah)+"₴ за "+unit+" · всього "+qty+" "+unit+" = "+finMoney(total)+"₴")
      : "Впишіть кількість, ціну й курс — тут з'явиться розрахунок.";
}

async function saveMatLot(){
  var err=document.getElementById("mlot-err");
  var materialId=document.getElementById("mlot-material").value;
  if(!materialId){err.textContent="Оберіть вид тканини";err.style.display="block";return}
  var body={
    material_id:parseInt(materialId),
    color:document.getElementById("mlot-color").value,
    roll_no:document.getElementById("mlot-roll").value,
    qty_total:parseFloat(document.getElementById("mlot-qty").value),
    price_usd:parseFloat(document.getElementById("mlot-price-usd").value),
    fx_rate:parseFloat(document.getElementById("mlot-fx").value)||undefined,
    supplier_id:parseInt(document.getElementById("mlot-supplier").value)||null,
    note:document.getElementById("mlot-note").value,
    create_expense:document.getElementById("mlot-expense").checked
  };
  try{
    await api("/api/goods/lots",{method:"POST",body:JSON.stringify(body)});
    closeM("mat-lot-modal");
    loadMatLots();
  }catch(e){err.textContent=e.message;err.style.display="block"}
}

// ── Довідник видів тканини ──────────────────────────────────────
var matDictEditId=null;
async function openMatDict(){
  matDictEditId=null;
  await loadGoodsMaterials(true);
  renderMatDict();
  openM("mat-dict-modal");
}
function renderMatDict(){
  var rows=GOODS_MATERIALS.map(function(m){
    if(matDictEditId===m.id){
      return '<div style="display:flex;gap:6px;align-items:center;padding:6px 0;border-top:1px solid var(--brd);flex-wrap:wrap">'
        +'<input id="md-edit-name" value="'+esc(m.name).replace(/"/g,"&quot;")+'" style="flex:1;min-width:110px;padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff">'
        +'<select id="md-edit-unit" style="padding:6px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff"><option value="kg"'+(m.unit==="kg"?' selected':'')+'>кг</option><option value="m"'+(m.unit==="m"?' selected':'')+'>м</option></select>'
        +'<button class="btn btn-sm btn-p" onclick="saveMatDictEdit('+m.id+')">'+Icon('check',11)+'</button>'
        +'<button class="btn btn-sm" onclick="matDictEditId=null;renderMatDict()">'+Icon('x',11)+'</button></div>';
    }
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid var(--brd);font-size:12px">'
      +'<div>'+esc(m.name)+' <span style="font-size:10px;color:var(--td)">'+materialUnitLabel(m.unit)+'</span></div>'
      +'<button class="btn btn-sm" onclick="matDictEditId='+m.id+';renderMatDict()">'+Icon('pencil',11)+'</button></div>';
  }).join("");
  document.getElementById("mat-dict-list").innerHTML=(rows||'<div class="empty">Видів тканини ще немає</div>')
    +'<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">'
    +'<input id="md-add-name" placeholder="Назва (напр. Двонитка)" style="flex:1;min-width:140px;padding:8px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff">'
    +'<select id="md-add-unit" style="padding:8px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff"><option value="kg">кг</option><option value="m">м</option></select>'
    +'<button class="btn btn-sm btn-p" onclick="addMatDict()">Додати</button></div>';
}
async function addMatDict(){
  var name=document.getElementById("md-add-name").value.trim();
  if(!name)return;
  var unit=document.getElementById("md-add-unit").value;
  try{
    await api("/api/goods/materials",{method:"POST",body:JSON.stringify({name:name,unit:unit})});
    await loadGoodsMaterials(true);
    fillMatFilterSelect();
    renderMatDict();
  }catch(e){alert(e.message)}
}
async function saveMatDictEdit(id){
  var name=document.getElementById("md-edit-name").value.trim();
  if(!name)return;
  var unit=document.getElementById("md-edit-unit").value;
  try{
    await api("/api/goods/materials/"+id,{method:"PUT",body:JSON.stringify({name:name,unit:unit,active:1})});
    matDictEditId=null;
    await loadGoodsMaterials(true);
    fillMatFilterSelect();
    renderMatDict();
    loadMatLots();
  }catch(e){alert(e.message)}
}

// ── Оцінка партій крою ───────────────────────────────────────────
async function loadMatCuts(){
  matCuts=(await api("/api/goods/cuts/unvalued")).cuts||[];
  var badge=document.getElementById("mat-cuts-badge");
  if(badge){badge.textContent=matCuts.length;badge.style.display=matCuts.length?"":"none"}
  renderMatCuts();
}
function renderMatCuts(){
  var el=document.getElementById("mat-cuts-list");
  if(!matCuts.length){el.innerHTML='<div class="empty">Неоцінених партій крою немає</div>';return}
  el.innerHTML=matCuts.map(function(c){
    return '<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--brd);font-size:12px">'
      +'<div><b style="color:var(--th)">'+esc(c.product_name)+'</b> <span style="color:var(--td)">'+esc(c.size_name)+'</span>'
      +'<div style="font-size:10px;color:var(--td)">'+esc((c.created_at||"").slice(0,10))+' · '+esc(c.workshop_name)+(c.note?' · '+esc(c.note):'')+'</div></div>'
      +'<div style="text-align:right;white-space:nowrap"><div style="font-weight:600;color:var(--th)">'+c.quantity+' шт</div>'
      +'<button class="btn btn-sm btn-p" onclick="openMatValue('+c.id+')">Оцінити</button></div></div>';
  }).join("");
}

var matValueCutId=null, matValueRows=[], matValueLots=[], matValueProduct=null;
async function openMatValue(cutId){
  var cut=matCuts.find(function(x){return x.id===cutId});
  if(!cut)return;
  matValueCutId=cutId;
  matValueRows=[{lot_id:"",qty:""}];
  document.getElementById("mval-err").style.display="none";
  document.getElementById("mval-title").textContent=cut.product_name+" · "+cut.size_name+" · "+cut.quantity+" шт";
  var[lots,product]=await Promise.all([
    api("/api/goods/lots?only_left=1"),
    api("/api/base-products/"+cut.base_product_id)
  ]);
  matValueLots=lots.lots||[];
  matValueProduct=product.product||null;
  document.getElementById("mval-sewing").value=(matValueProduct&&matValueProduct.sewing_cost)||0;
  document.getElementById("mval-notions").value=(matValueProduct&&matValueProduct.notions_cost)||0;
  var normHint=document.getElementById("mval-norm-hint");
  if(matValueProduct&&matValueProduct.material_norm){
    var mat=GOODS_MATERIALS.find(function(m){return m.id===matValueProduct.material_id});
    var unit=mat?materialUnitLabel(mat.unit):"од.";
    normHint.textContent="Норма з картки товару: "+matValueProduct.material_norm+" "+unit+"/шт × "+cut.quantity+" шт = "+(Math.round(matValueProduct.material_norm*cut.quantity*1000)/1000)+" "+unit+" (орієнтир, рулон і фактичну витрату впишіть нижче).";
    normHint.style.display="block";
  } else {
    normHint.style.display="none";
  }
  renderMatValueRows();
  openM("mat-value-modal");
}
function matValueLotOptions(selected){
  return '<option value="">— рулон —</option>'+matValueLots.map(function(l){
    var u=materialUnitLabel(l.unit);
    return '<option value="'+l.id+'"'+(String(selected)===String(l.id)?' selected':'')+'>'+esc(l.material_name)+(l.color?' '+esc(l.color):'')+(l.roll_no?' №'+esc(l.roll_no):'')+' — залишок '+l.qty_left+' '+u+'</option>';
  }).join("");
}
function renderMatValueRows(){
  document.getElementById("mval-rows").innerHTML=matValueRows.map(function(r,i){
    return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">'
      +'<select onchange="matValueRows['+i+'].lot_id=this.value;matValueRecalc()" style="flex:1;padding:7px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff;font-size:11px">'+matValueLotOptions(r.lot_id)+'</select>'
      +'<input type="number" step="0.001" min="0" placeholder="Кількість" value="'+esc(r.qty)+'" oninput="matValueRows['+i+'].qty=this.value;matValueRecalc()" style="width:100px;padding:7px;background:var(--input);border:1px solid var(--brd);border-radius:6px;color:#fff;font-size:11px">'
      +'<button type="button" class="btn btn-sm btn-d" onclick="matValueRemoveRow('+i+')">'+Icon('x',11)+'</button></div>';
  }).join("")+'<button type="button" class="btn btn-sm" onclick="matValueAddRow()"><i data-icon="plus" data-size="11"></i> Додати рулон</button>';
  if(window.mountIcons)mountIcons(document.getElementById("mval-rows"));
  matValueRecalc();
}
function matValueAddRow(){matValueRows.push({lot_id:"",qty:""});renderMatValueRows()}
function matValueRemoveRow(i){matValueRows.splice(i,1);if(!matValueRows.length)matValueRows.push({lot_id:"",qty:""});renderMatValueRows()}
function matValueRecalc(){
  var cut=matCuts.find(function(x){return x.id===matValueCutId});
  if(!cut)return;
  var materialCost=0;
  matValueRows.forEach(function(r){
    var lot=matValueLots.find(function(l){return String(l.id)===String(r.lot_id)});
    var qty=parseFloat(r.qty)||0;
    if(lot&&qty>0)materialCost+=Math.round(qty*lot.price_uah*100)/100;
  });
  var sewingRate=parseFloat(document.getElementById("mval-sewing").value)||0;
  var notionsRate=parseFloat(document.getElementById("mval-notions").value)||0;
  var sewingTotal=Math.round(sewingRate*cut.quantity*100)/100;
  var notionsTotal=Math.round(notionsRate*cut.quantity*100)/100;
  var total=Math.round((materialCost+sewingTotal+notionsTotal)*100)/100;
  var unitCost=cut.quantity?Math.round((total/cut.quantity)*100)/100:0;
  document.getElementById("mval-calc").innerHTML=
    'Тканина '+finMoney(materialCost)+'₴ + пошив '+finMoney(sewingTotal)+'₴ + фурнітура '+finMoney(notionsTotal)+'₴ = <b>'+finMoney(total)+'₴</b>'
    +'<div style="font-size:16px;font-weight:700;color:var(--acc);margin-top:4px">Собівартість одиниці: '+finMoney(unitCost)+'₴</div>';
}
async function saveMatValue(){
  var err=document.getElementById("mval-err");
  var usages=matValueRows.filter(function(r){return r.lot_id&&parseFloat(r.qty)>0}).map(function(r){return {lot_id:parseInt(r.lot_id),qty:parseFloat(r.qty)}});
  if(!usages.length){err.textContent="Додайте хоча б один рулон з кількістю";err.style.display="block";return}
  var body={
    usages:usages,
    sewing_price:parseFloat(document.getElementById("mval-sewing").value)||0,
    notions_cost:parseFloat(document.getElementById("mval-notions").value)||0
  };
  try{
    await api("/api/goods/cuts/"+matValueCutId+"/value",{method:"POST",body:JSON.stringify(body)});
    closeM("mat-value-modal");
    loadMatCuts();
    loadMatLots();
  }catch(e){err.textContent=e.message;err.style.display="block"}
}
