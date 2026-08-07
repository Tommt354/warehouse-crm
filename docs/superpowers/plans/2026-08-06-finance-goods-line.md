# Фінансовий модуль, заход 2 «Товар» — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Показати власнику, скільки грошей лежить у товарі — тканина, крій, склад, повернення, у дорозі — і звести приріст цієї вартості з прибутком, щоб відповісти на питання «заробив, а грошей нема, де вони».

**Architecture:** Вартість наростає сходинками й фіксується партіями. Рулон тканини — партія з ціною за одиницю (кг або метри) і курсом, зафіксованим у момент приходу. Крій списує з конкретного рулону фактичну кількість; вартість партії крою = матеріал + фурнітура за нормативом + пошив за ставкою цієї партії. Перехід крою на склад створює партію готового товару (`inventory_lots`). Продаж списує партії за FIFO у собівартість проданого, зафіксовану в `order_items.cogs`, щоб вона не пливла заднім числом. Логіка — у новому модулі `goods.js` поруч із `finance.js`; фронтенд — `public/goods.js` плюс вкладка «Матеріали» і блок «Товар зараз».

**Tech Stack:** Node/Express, better-sqlite3, vanilla JS фронтенд без збірки. Курс валют — НБУ (`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json`, без ключа).

**Спека:** `docs/superpowers/specs/2026-08-04-finance-module-design.md` — розділи 3а, 4, 5, 9. Кожен виконавець читає розділ, що стосується його задачі.

## Global Constraints

- Мова коду й інтерфейсу — українська; коментарі пояснюють **чому**, а не що.
- Гроші — `REAL`, округлення до копійок через `round2`. Кількість матеріалу — `REAL` (кілограми й метри дробові).
- Дати — `YYYY-MM-DD` через `date('now','localtime')`, час — `datetime('now','localtime')`.
- Усі нові маршрути — `requireRole("admin")`, окрім тих, що потрібні складу для введення крою (там `admin` + `warehouse`).
- **Живу базу `crm.db` не чіпати.** `DB_PATH` виставляти до будь-якого `require` бекенду; працювати лише з копією через `.backup()`.
- Тести — `tests/goods/NN-*.js`, стиль і хелпери як у `tests/finance/` (`tests/finance/_helpers.js`, порт 3100). Кожен тест створює свої фікстури й прибирає за собою.
- Міграції в `db.js` виконуються при кожному старті сервера — мають бути ідемпотентні й лише додавати.
- **Вартість ніколи не вигадується.** Якщо даних для оцінки немає — партія лишається неоціненою і потрапляє в окремий список, а не отримує нуль чи середню по палаті.
- Заход 1 («Гроші») уже в продакшні: `finance.js`, `cash_moves`, вкладка «Гроші». Лінія товару **не додається** до лінії грошей — вони звіряються. Не чіпати логіку каси.
- Коміт після кожної задачі, українською, з рядком `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Гілка `main`. Деплой — лише після фінального ревʼю всього заходу.

## Файлова структура

| Файл | Відповідальність |
|---|---|
| `db.js` (зміни) | нові таблиці партій і матеріалів, колонки нормативів, міграції |
| `goods.js` (новий) | маршрути `/api/goods/*`, рух вартості, FIFO, звіт «Товар зараз» |
| `server.js` (зміни) | реєстрація модуля, хуки в місцях руху товару |
| `finance.js` (зміни) | звіт отримує собівартість проданого й реальний результат |
| `public/goods.js` (новий) | вкладка «Матеріали», форми приходу рулону й оцінки крою |
| `public/admin.html` (зміни) | розмітка вкладки, поля нормативів у картці товару |
| `public/warehouse.html` (зміни) | поле витраченої тканини й ставки пошиву у формі крою |
| `tests/goods/*.js` (нові) | перевірки задач |

---

### Task 1: Схема партій і нормативів

**Files:** Modify `db.js`; Test `tests/goods/01-schema.js`

**Interfaces:**
- Produces: `materials(id,name,unit,active)`; `material_lots(id,material_id,color,roll_no,qty_total,qty_left,price_usd,fx_rate,price_uah,supplier_id,expense_id,note,created_at)`; `cut_material_usage(id,cut_incoming_id,lot_id,qty,cost)`; `inventory_lots(id,base_product_id,size_id,qty_left,unit_cost,source,ref_id,created_at)`; `notions_pool(id,date,amount,ref_type,ref_id,note)`; колонки `base_products.notions_cost`, `base_products.sewing_cost`, `base_products.material_id`, `base_products.material_norm`; колонки `cut_incoming.material_cost`, `notions_cost`, `sewing_price`, `sewing_cost`, `unit_cost`, `valued`; колонка `order_items.cogs`

- [ ] **Step 1: Написати перевірку**

`tests/goods/01-schema.js` — за зразком `tests/finance/01-schema.js`: перевіряє наявність кожної таблиці з переліком колонок вище, наявність доданих колонок у `base_products`, `cut_incoming`, `order_items`, і що `materials.unit` приймає лише `kg`/`m` (перевір вставкою й очікуваною помилкою, якщо ставиш CHECK).

- [ ] **Step 2: Запустити, переконатись що падає**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && rm -f /tmp/goods-test.db* && node -e "const db=require('better-sqlite3')('crm.db',{readonly:true});db.backup('/tmp/goods-test.db').then(()=>console.log('ok'))" && DB_PATH=/tmp/goods-test.db node -e "require('./db')" && node tests/goods/01-schema.js
```

- [ ] **Step 3: Додати таблиці в `db.js`**

У великий `db.exec` зі схемою. Ключові рішення, які треба відобразити коментарями:
- `material_lots.qty_left` — залишок рулону в його одиниці; `price_uah` = ціна за одиницю в гривні, порахована в момент приходу за `fx_rate` і **більше ніколи не перераховується** (інакше історія собівартості попливе при кожному стрибку долара).
- `inventory_lots.source` — `cut` / `purchase` / `return`, щоб було видно, звідки партія на складі.
- `notions_pool` — котел фурнітури: плюс на закупівлю, мінус на нарахування за нормативом.

- [ ] **Step 4: Додати колонки через `addCol`**

`base_products.notions_cost` (₴/од., фурнітура), `sewing_cost` (₴/од., ставка пошиву за замовчуванням), `material_id`, `material_norm` (норма витрати на одиницю). `cut_incoming`: `material_cost`, `notions_cost`, `sewing_price`, `sewing_cost`, `unit_cost`, `valued INTEGER DEFAULT 0`. `order_items.cogs REAL DEFAULT 0`.

- [ ] **Step 5: Прогнати перевірку**

Та сама команда, що в кроці 2. Очікувано: усі ✅.

- [ ] **Step 6: Коміт**

```bash
git add db.js tests/goods/01-schema.js && git commit -m "Товар: схема партій матеріалів і готового товару

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Довідник тканин, курс НБУ, прихід рулонів

**Files:** Create `goods.js`; Modify `server.js`; Test `tests/goods/02-materials.js`

**Interfaces:**
- Consumes: таблиці Задачі 1
- Produces: `module.exports = { register(app, {authMiddleware, requireRole}) }`; `GET/POST/PUT /api/goods/materials`; `GET /api/goods/fx?date=` (курс НБУ з кешем); `GET /api/goods/lots?material_id=&only_left=`; `POST /api/goods/lots` `{material_id,color,roll_no,qty_total,price_usd,fx_rate,supplier_id,note,create_expense}`

- [ ] **Step 1: Написати перевірку**

`tests/goods/02-materials.js`: створення виду тканини з одиницею `kg` і `m`; відмова на невідому одиницю; прихід рулону рахує `price_uah = price_usd * fx_rate` і ставить `qty_left = qty_total`; курс НБУ підставляється, якщо його не передали, і **зберігається в рулоні**, а не читається щоразу; повторний запит курсу на ту саму дату не ходить у мережу вдруге; прихід із `create_expense` створює витрату в категорії матеріалів і рух каси (перевір через наявні таблиці `expenses`/`cash_moves`); не-адміну закрито.

- [ ] **Step 2: Запустити, переконатись що падає**

- [ ] **Step 3: Реалізувати `goods.js`**

Курс: запит до `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json&valcode=USD&date=YYYYMMDD`, кеш у памʼяті на дату. Мережа може бути недоступна — тоді маршрут віддає останній відомий курс із `material_lots` і ознаку, що це запасне значення; форма має дати ввести курс руками. Прихід рулону в транзакції: рулон + (за прапорцем) витрата з категорією типу `material` і оплатою, як у заході 1.

- [ ] **Step 4: Зареєструвати модуль у `server.js`**

Поруч із `finance.register(...)`, **вище** catch-all маршруту `app.get("*")`.

- [ ] **Step 5: Прогнати перевірку й регресію `tests/finance/0*.js`**

- [ ] **Step 6: Коміт**

---

### Task 3: Списання тканини на крій і вартість партії крою

**Files:** Modify `goods.js`, `server.js`; Test `tests/goods/03-cut-cost.js`

**Interfaces:**
- Consumes: рулони Задачі 2
- Produces: `POST /api/goods/cuts/:cut_incoming_id/value` `{usages:[{lot_id,qty}], sewing_price, notions_cost}`; `GET /api/goods/cuts/unvalued`; хелпер `valueCutBatch(cutIncomingId, payload)`

- [ ] **Step 1: Написати перевірку**

`tests/goods/03-cut-cost.js`: списання 13.6 кг із рулону по 258 ₴/кг дає матеріал 3 508.80 ₴; `qty_left` рулону зменшується рівно на списане; списати більше залишку не можна (400); вартість партії = матеріал + `sewing_price × кількість` + `notions_cost × кількість`, `unit_cost` = разом ÷ фактична кількість; **брак усередині партії**: та сама сума ділиться на меншу кількість — собівартість одиниці більша; списання з двох рулонів в одній партії; повторна оцінка тієї самої партії не списує тканину двічі (ідемпотентність або явна відмова — обери й покрий тестом); неоцінена партія потрапляє в `GET /api/goods/cuts/unvalued`, оцінена зникає звідти; нарахування фурнітури пише мінус у котел `notions_pool`.

- [ ] **Step 2: Запустити, переконатись що падає**

- [ ] **Step 3: Реалізувати**

Списання з рулонів — за явно вказаними `lot_id` (власник сам знає, з якого рулону різали; це точніше за FIFO). Ставка пошиву береться з тіла запиту, за замовчуванням підставляється `base_products.sewing_cost`; фурнітура — з `base_products.notions_cost`.

- [ ] **Step 4: Прогнати перевірку й регресію**

- [ ] **Step 5: Коміт**

---

### Task 4: Крій → склад, партії готового товару

**Files:** Modify `goods.js`, `server.js`; Test `tests/goods/04-lots.js`

**Interfaces:**
- Produces: `onCutMovedToBase(cutIncomingId, items)` — створює `inventory_lots` з `unit_cost` партії крою; `onStockIncoming(baseProductId, sizeId, qty, unitCost, source)` — партія для закупного товару; `GET /api/goods/lots-stock?base_product_id=`

- [ ] **Step 1: Написати перевірку**

`tests/goods/04-lots.js`: переміщення крою в базу створює партію складу з тією ж `unit_cost`, і **загальна вартість не змінюється** (гроші переїхали з шухляди «крій» у шухляду «склад»); перехід неоціненої партії крою лишає партію складу неоціненою й видимою в списку невизначених; прихід закупного товару бере собівартість із картки товару; сума `qty_left` партій по товару збігається з `stock_base.quantity_actual` (це головна перевірка цілісності — партії не мають розходитись із фактичним залишком).

- [ ] **Step 2: Запустити, переконатись що падає**

- [ ] **Step 3: Реалізувати й підключити в `server.js`**

Точки підключення — там, де вже рухається крій і прихід: маршрут переміщення крою в базу і маршрут приходу на склад (шукати `cut_out` і `incoming` у `stock_log`).

- [ ] **Step 4: Прогнати перевірку й регресію**

- [ ] **Step 5: Коміт**

---

### Task 5: FIFO при продажу, брак, повернення, у дорозі

**Files:** Modify `goods.js`, `server.js`; Test `tests/goods/05-cogs.js`

**Interfaces:**
- Produces: `consumeLotsFifo(baseProductId, sizeId, qty)` → `{cost, consumed:[{lot_id,qty,unit_cost}]}`; `onOrderShipped(orderId)` (склад → у дорозі); `onOrderDeliveredGoods(orderId)` (у дорозі → продано, фіксує `order_items.cogs`); `onOrderReturnedGoods(orderId)`; `onDefect(...)`, `onRecountShortage(...)`

- [ ] **Step 1: Написати перевірку**

`tests/goods/05-cogs.js`: дві партії з різною ціною — списання 450 шт бере 400 зі старої і 50 з нової, сума точна; `order_items.cogs` фіксується в момент отримання й **не міняється**, навіть якщо потім прийде дорожча партія; повернення посилки повертає вартість на полицю повернень тією ж ціною; брак списує партію у втрати; недостача при переобліку теж; товар у дорозі рахується окремо від складу і не зникає з капіталу між відправкою й отриманням.

- [ ] **Step 2: Запустити, переконатись що падає**

- [ ] **Step 3: Реалізувати й підключити хуки**

Прив'язуватись до наявних точок руху товару в `server.js` (`pullOrderStockOnce`, зміна статусу, повернення на полицю, брак, переоблік). Не дублювати логіку кількостей — вартість іде **слідом** за наявним рухом кількості, а не замість нього.

- [ ] **Step 4: Прогнати перевірку й регресію**

- [ ] **Step 5: Коміт**

---

### Task 6: Звіт «Товар зараз», реальний результат, звірка капіталу

**Files:** Modify `goods.js`, `finance.js`; Test `tests/goods/06-report.js`

**Interfaces:**
- Produces: `GET /api/goods/report?from&to` → `{materials:{qty,cost}, notions:{cost}, cuts:{qty,cost}, stock:{qty,cost}, returns:{qty,cost}, in_transit:{qty,cost}, total, cogs_period, defect_period, goods_delta, unvalued:[...]}`; `/api/finance/report` доповнюється полями `cogs_period`, `goods_delta`, `real_profit`

- [ ] **Step 1: Написати перевірку**

`tests/goods/06-report.js`: сума шухляд збігається з сумою партій; `real_profit = profit_cash + goods_delta` і збігається з `виручка − собівартість проданого − витрати періоду` на контрольному прикладі; неоцінені партії показуються окремим списком і **не рахуються нулем** у підсумку; порожній період не ламає звіт.

- [ ] **Step 2: Запустити, переконатись що падає**

- [ ] **Step 3: Реалізувати**

- [ ] **Step 4: Прогнати перевірку й регресію**

- [ ] **Step 5: Коміт**

---

### Task 7: Інтерфейс матеріалів і крою

**Files:** Create `public/goods.js`; Modify `public/admin.html`, `public/warehouse.html`; ручна перевірка

- [ ] **Step 1: Вкладка «Матеріали» в адмінці**

Список рулонів: вид, колір, номер, залишок / всього, ціна в доларах і гривнях, сума. Форма приходу рулону з підстановкою курсу НБУ й можливістю його виправити, з галочкою «створити витрату». Підсумок: скільки всього матеріалу й на яку суму.

- [ ] **Step 2: Оцінка крою**

Список неоцінених партій крою з формою: вибір рулону (кілька рядків), фактична кількість тканини, ставка пошиву, фурнітура. Показує розрахунок собівартості одиниці одразу, до збереження.

- [ ] **Step 3: Поля нормативів у картці товару**

Тканина, норма на одиницю, фурнітура ₴/шт, ставка пошиву ₴/шт — із поясненням, що це значення за замовчуванням, які підставляються у форму крою.

- [ ] **Step 4: Ставка пошиву у формі крою складу**

У `public/warehouse.html` — поле ставки за пошив однієї штуки поруч із кількістю, з підстановкою з картки товару. Кілограми вводить власник пізніше в адмінці, тож форма складу лишається простою.

- [ ] **Step 5: Ручна перевірка сценаріїв і коміт**

---

### Task 8: Блок «Товар зараз» і реальний результат

**Files:** Modify `public/goods.js`, `public/finance.js`, `public/admin.html`; ручна перевірка

- [ ] **Step 1: Блок «Товар зараз» у вкладці «Гроші»**

Рядки: матеріали, фурнітура, крій, склад, повернення, у дорозі — кількість і сума, разом. Окремо помітний рядок «неоцінені партії», якщо такі є, з переходом до їх оцінки.

- [ ] **Step 2: Реальний результат і звірка капіталу**

Плитки: собівартість проданого за період, «осіло в товарі», реальний результат. Рядок звірки: приріст капіталу проти прибутку, з поясненням розбіжності, якщо вона є.

- [ ] **Step 3: Ручна перевірка, коміт**

---

### Task 9: Фінальне ревʼю заходу й деплой

- [ ] **Step 1: Фінальне ревʼю всього заходу** на найпотужнішій моделі: чи не розходяться партії з фактичним залишком, чи не вигадується вартість там, де даних немає, чи не ламає лінія товару лінію грошей, чи міграції безпечні для живої бази.
- [ ] **Step 2: Виправити знахідки одним заходом, повторити прогін усіх тестів `tests/finance/0*.js` і `tests/goods/0*.js`.**
- [ ] **Step 3: Деплой** — `git push origin main && fly deploy`, перевірка `curl -s -o /dev/null -w "%{http_code}\n" https://warehouse-crm.fly.dev/login` (очікувано 200).
