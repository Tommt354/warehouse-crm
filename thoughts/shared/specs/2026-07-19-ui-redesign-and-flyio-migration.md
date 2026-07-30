# Warehouse CRM: Dark UI Redesign + Fly.io Migration Specification

## Executive Summary
Redesign the visual layer of warehouse-crm (a Node/Express/SQLite dropshipping CRM currently running on Railway) into a modern dark-theme UI inspired by mydrop.com.ua's UX patterns, and migrate hosting to Fly.io so Claude can deploy and test changes directly during development sessions. Business logic, data model, and roles remain unchanged.

## Problem Statement
- Current UI (`admin.html`, `drop.html`, `warehouse.html`, `finalizer.html`, `login.html`) is plain HTML/CSS with no loading transitions — pages render instantly with no polish, feels dated.
- Current hosting (Railway) is cumbersome to redeploy and cannot be tested interactively from within a Claude session.
- The owner already runs a similar (larger) system on mydrop.com.ua as a dropshipper/vendor and wants to reuse its proven UX patterns (status badges, multi-field filters, smooth loading states) without adopting its business logic — warehouse-crm's existing logic (models → base_products → variations, stock_base/stock_returns/stock_cuts, orders, payouts, shifts/payroll) is correct and must not change.

## Success Criteria
- All 5 frontend pages redesigned with a cohesive dark theme, icon-based navigation, smooth skeleton/spinner loading states, and colored status badges — matching the polish level observed on mydrop.com.ua.
- Zero changes to `db.js` schema, zero changes to business logic in `server.js` beyond what was already fixed for security (RBAC, JWT secret, etc. — see prior session).
- App redeployed on Fly.io, reachable at a stable URL, with SQLite data persisted across deploys via a Fly volume.
- Claude can run `fly deploy` (or equivalent) directly from a session, then verify the live result via the Browser pane — full inner-loop without the user manually redeploying.

## Reference System Findings (mydrop.com.ua/vendor)
Observed via the owner's authenticated Chrome session:
- **Nav structure** (sidebar, collapsible, icon+label): В роботі, Всі замовлення, Склад (Категорії/Товари/Імпорт/Експорт/Атрибути/Надходження-списання/Масові дії/Знижки/Закінчується наявність/Виробники/Аналітика tabs), Дропшиппери, Виплати, Статистика (Загальне/Дропшиппери/Товари/Статуси НП/Менеджери/Таблиця наявності tabs), Бюджет, Клієнти, Інтеграції, Telegram-бот, Чати, Друковані форми, Допомога, Налаштування.
- **Order list**: dense filterable table — filter row includes order-group dropdown, date-range dropdown, warehouse, product, manufacturer, dropshipper selectors, bulk-select checkbox, barcode-scan input, page-size selector, "Пошук та фільтрація" and "Налаштувати таблицю" buttons.
- **Order detail**: two-column card. Left: ID, shared ID, date, status badge, payment-status badge, TTN link/generate button, drop price, profit, dropshipper link + discount badge, payout amount/status badge. Right: client name/phone (as links), delivery service icon+name, city, branch address, prepayment badge, COD amount, NP counterparty, weight/seats/packaging, attached receipt photo (rendered inline as a phone-screenshot image). Top toolbar: row of small colored icon buttons (green check, orange icon, black lock, pencil edit, chat, paperclip, two dropdown menus, document icon).
- **Status badges**: pill-shaped, soft-colored background + colored text (e.g. blue "Нове", red "Не оплачено", pink/red "Повна" (prepayment), red "Не виплачено"). This is the pattern to replicate for order/payout statuses in our system.
- **Loading state**: while a page's data loads, content area shows a centered grayscale icon (contextual, e.g. an open box for products) plus a spinner beside it — not a blank flash. This is the "плавно" behavior the owner wants replicated.
- **Dropshippers list**: invite-link box at top (`https://mydrop.com.ua/join/adsdrop`) for self-service signup, table with ID/name/social-contact/group/registration-date/edit-icon, pagination.
- Overall mydrop is a **light** theme with a dark sidebar — our redesign target is a **full dark theme** per the owner's explicit request, borrowing structural/interaction patterns only, not the color scheme.

## User Personas (unchanged from existing system)
- **admin**: full control — products, stock, users, settings, payouts.
- **dropshipper**: places orders, views own orders/stats/payouts only.
- **warehouse** (worker_role: packer/finalizer): packs orders, manages stock movements, scans.

## Functional Requirements

### Must Have (P0)
1. **Dark theme redesign** of all 5 pages using Tailwind CSS (dark mode) + Lucide icons, replacing current inline-styled plain HTML.
   - Acceptance: consistent color tokens (background, surface, border, text, accent) across all pages; no page keeps the old plain look.
2. **Status badges**: replace plain text status fields (order status, payment status, payout status, TTN status) with colored pill badges, consistent palette per status meaning (info/warning/success/danger).
   - Acceptance: every status field in orders/payouts tables and detail views renders as a badge, not raw text.
3. **Smooth loading states**: every async data fetch (page load, table refresh, modal open) shows a skeleton or icon+spinner placeholder instead of a blank/instant flash.
   - Acceptance: navigating between sections and reloading data never shows an empty flash — always a transition.
4. **Multi-field filter bars**: order/stock/product list views get a filter row similar to mydrop's (status, date range, warehouse/dropshipper/product selectors as applicable) — same underlying API/query params, just richer combined UI.
   - Acceptance: filters combine (AND) and are reflected in the URL/query so state survives refresh.
5. **Icon-based sidebar navigation** replacing/enhancing current nav, collapsible, consistent across admin/drop/warehouse/finalizer views (each showing only the sections relevant to that role).
6. **No backend logic changes**: `db.js` schema, `server.js` route handlers' business logic, and role permissions stay exactly as they are (post security-fix state) — only markup/CSS/JS presentation layer and query-building for richer filters change.
7. **Fly.io deployment**: app runs on Fly.io with a persistent volume for the SQLite DB file and the `photos` upload directory; `fly.toml` + `Dockerfile` added; Claude can `fly deploy` from the session and verify via Browser pane.

### Should Have (P1)
- Toast notifications replacing any `alert()`/inline message patterns, for consistency with the new smooth-UX goal.
- Responsive layout pass (tablet width at minimum, since warehouse workers may use tablets for scanning).

### Nice to Have (P2)
- Self-service dropshipper invite link (mirroring mydrop's join-link pattern) — only if trivial to add without changing the underlying user-creation logic (admin still creates the record, but a link could pre-fill an invite flow). **Out of scope unless explicitly requested later** — flagged as optional, not committed.

## Technical Architecture

### Frontend
- Keep vanilla JS (no framework rewrite) to minimize risk — add Tailwind CSS (compiled, not CDN, for production reliability) and Lucide icons (inline SVG, no external font/icon CDN dependency per Fly.io self-contained deploy).
- Introduce a small shared CSS/JS layer (design tokens, badge component, skeleton loader helper, toast helper) reused across all 4 authenticated pages.

### Backend
- No schema changes. Any new filter combinations are additive query-building in existing `dirRoutes`/order-list endpoints (extra optional query params), not new tables.

### Deployment (Fly.io)
- Add `Dockerfile` (Node 20-slim base, `npm ci --omit=dev`, `better-sqlite3` native build).
- Add `fly.toml`: single app, one persistent volume mounted at the DB/photos path, `PORT`, `JWT_SECRET`, `NP_API_KEY` set as Fly secrets (not committed).
- `RESET_DB` env var stays available for controlled resets, never set by default in prod config.
- Deploy flow: Claude runs `fly deploy` from the repo directory; verifies with `fly logs` / Browser pane hitting the `*.fly.dev` URL.

## Non-Functional Requirements
- Performance: page transitions should feel instant-to-user even while data loads (skeleton, not blocking).
- Reliability: SQLite data must survive redeploys (Fly volume), matching current Railway persistence guarantee.
- Security: preserve all RBAC/JWT fixes from the prior security-review session; no regressions.

## Out of Scope
- Any change to warehouse/stock/order/payout business logic, data model, or role permissions.
- Adopting mydrop's actual dropshipping logic (their categories/products/workflows) — only their interaction/visual patterns are reused.
- Rewriting frontend into a JS framework (React/Vue) — stays vanilla JS + Tailwind.
- Multi-tenant/self-service vendor signup (mydrop's core business model) — not relevant to this internal single-vendor tool.

## Open Questions for Implementation
- Exact color token values for the dark palette (to be decided during implementation using the `frontend-design`/`ui-styling` skills, not fixed here).
- Whether Tailwind is compiled via a build step (esbuild/PostCSS) added to `package.json`, given the project currently has zero build tooling — implementation should add the minimal necessary tooling.
- Fly.io region/sizing — default to the closest region to primary users, smallest VM size, adjustable later (budget is not a constraint per owner).

## Appendix: Research Conducted
- Live inspection of mydrop.com.ua/vendor/* (active_orders, order detail, products/categories, stats, expenses, dropshippers) via the owner's authenticated Chrome session, screenshots analyzed for nav structure, badge styling, loading-state behavior, and filter UI patterns.
