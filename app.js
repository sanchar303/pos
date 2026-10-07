import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getDatabase, ref, onValue, set, update, remove } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-database.js";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, signInWithCustomToken, signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";

const fb = initializeApp({
  apiKey: "AIzaSyAJBCkrqX2SvE10Rjc3GRO57_aH5AKmjN4",
  authDomain: "sancharchat.firebaseapp.com",
  databaseURL: "https://sancharchat-default-rtdb.firebaseio.com",
  projectId: "sancharchat",
  storageBucket: "sancharchat.firebasestorage.app",
  messagingSenderId: "23453772006",
  appId: "1:23453772006:web:d3766e2b110d165d39b327",
  measurementId: "G-8QM9DQFK26"
});
const db = getDatabase(fb);
const auth = initializeAuth(fb, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });

const { createApp, ref: v, computed, watch, nextTick, onMounted, onUnmounted } = Vue;

const SK = "pos8848_rtdb_session";
const DEF_CATS = ["Momos", "Main Course", "Beverages", "Snacks"];
const DEF_TABLES = ["T1", "T2", "T3", "T4", "VIP Hall 1", "Outdoor Garden 1"];
const MODS = [
  { name: "Mild Spice", priceExtra: 0 },
  { name: "Medium Spice", priceExtra: 10 },
  { name: "Himalayan Hot", priceExtra: 25 },
  { name: "Yak Cheese Addon", priceExtra: 60 },
  { name: "Extra Dip / Soup", priceExtra: 30 }
];
const PAYS = [["cash", "Cash"], ["fonepay", "Fonepay QR"], ["esewa", "eSewa Wallet"], ["khalti", "Khalti Wallet"], ["card", "POS Card"], ["credit", "On Account"]];
const TYPES = [["dine_in", "Dine-In"], ["takeaway", "Takeaway"], ["delivery", "Delivery"]];

const clean = o => JSON.parse(JSON.stringify(o));
const sum = (a, k) => a.reduce((s, i) => s + (Number(i[k]) || 0), 0);
const money = n => Number(n || 0).toLocaleString();
const fdate = t => (t ? new Date(t).toLocaleDateString() : "");

createApp({
  setup() {
    const session = v(null), mode = v("tenant"), code = v(""), pin = v(""), hq = v("");
    const restaurants = v({}), orders = v({}), allOrders = v({});
    const ready = v(true), busy = v(false), now = v(Date.now()), view = v("pos");
    const fails = v(0), lockUntil = v(0);
    let unsub = [], timer = null;

    /* notices */
    const notice = v({ show: false, title: "", message: "", type: "info", ok: null });
    const notify = (title, message, type = "info") => (notice.value = { show: true, title, message, type, ok: null });
    const ask = (title, message, ok) => (notice.value = { show: true, title, message, type: "confirm", ok });
    const noticeOk = () => { const f = notice.value.ok; notice.value.show = false; if (f) f(); };
    const guard = fn => async (...a) => {
      if (busy.value) return;
      busy.value = true;
      try { await fn(...a); } catch (e) { notify("Error", e.message || "Failed", "error"); } finally { busy.value = false; }
    };

    /* data */
    const list = computed(() => Object.entries(restaurants.value).map(([c, r]) => ({ code: c, ...r })));
    const tenant = computed(() => (session.value && session.value.role === "tenant" ? restaurants.value[session.value.code] || null : null));
    const cur = computed(() => (tenant.value && tenant.value.currencySymbol) || "रू");
    const tables = computed(() => (tenant.value && tenant.value.tables) || DEF_TABLES);
    const items = computed(() => Object.entries((tenant.value && tenant.value.menuItems) || {}).map(([id, i]) => ({ id, ...i })));
    const cats = computed(() => ["All", ...new Set([...((tenant.value && tenant.value.categories) || DEF_CATS), ...items.value.map(i => i.category)].filter(c => c && c !== "All"))]);
    const staff = computed(() => Object.entries((tenant.value && tenant.value.staffPins) || {}).map(([id, s]) => ({ id, ...s })));
    const cfg = computed(() => {
      const t = tenant.value || {};
      return { vat: t.vatEnabled ?? true, vr: t.vatRate || 13, sc: t.serviceChargeEnabled ?? true, sr: t.serviceChargeRate || 10 };
    });
    const calc = (sub, disc) => {
      const c = cfg.value, base = Math.max(0, sub - disc);
      const sc = c.sc ? Math.round(base * c.sr / 100) : 0;
      const vat = c.vat ? Math.round((base + sc) * c.vr / 100) : 0;
      return { sub, disc, sc, vat, total: base + sc + vat };
    };
    const olist = computed(() => Object.entries(orders.value).map(([id, o]) => ({ id, ...o })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
    const kds = computed(() => olist.value.filter(o => !o.isPaid && ["pending", "in_prep", "ready"].includes(o.status)));
    const tabOf = t => olist.value.find(o => o.table === t && o.orderType === "dine_in" && !o.isPaid);

    const tabs = computed(() => [["pos", "POS Terminal"], ["kds", "Kitchen KDS"], ["tables", "Floor & Tables"],
      ...(session.value && session.value.isManager ? [["menu", "Menu Manager"], ["staff", "Staff & PINs"], ["reports", "Sales & Reports"], ["settings", "Outlet Settings"]] : [])]);

    /* subscriptions and session */
    const FIELDS = ["name", "panNumber", "address", "phone", "currencySymbol", "receiptFooter", "vatEnabled", "serviceChargeEnabled", "vatRate", "serviceChargeRate", "categories", "tables", "menuItems"];
    const setField = (c, f, val) => {
      const r = { ...restaurants.value };
      r[c] = { ...(r[c] || {}) };
      if (val === null) delete r[c][f]; else r[c][f] = val;
      restaurants.value = r;
    };
    watch(session, s => {
      unsub.forEach(f => f()); unsub = []; orders.value = {}; allOrders.value = {}; restaurants.value = {};
      if (s) localStorage.setItem(SK, JSON.stringify(s)); else localStorage.removeItem(SK);
      if (!s) return;
      if (s.role === "hq") {
        unsub.push(onValue(ref(db, "8848/restaurants"), x => (restaurants.value = x.val() || {})));
        unsub.push(onValue(ref(db, "8848/orders"), x => (allOrders.value = x.val() || {})));
      } else {
        restaurants.value = { [s.code]: {} };
        (s.isManager ? [...FIELDS, "managerPin", "staffPins"] : FIELDS).forEach(f =>
          unsub.push(onValue(ref(db, `8848/restaurants/${s.code}/${f}`), x => setField(s.code, f, x.val()))));
        unsub.push(onValue(ref(db, "8848/orders/" + s.code), x => (orders.value = x.val() || {})));
      }
    });
    watch(tables, t => { if (!t.includes(table.value)) table.value = t[0]; });
    watch(view, x => { if (x === "settings") loadSet(); });

    onMounted(async () => {
      timer = setInterval(() => (now.value = Date.now()), 30000);
      await auth.authStateReady();
      let s = null;
      try { s = JSON.parse(localStorage.getItem(SK)); } catch (e) { s = null; }
      if (s && auth.currentUser) {
        const c = (await auth.currentUser.getIdTokenResult()).claims;
        if (c.role === "hq" || (s.role === "tenant" && c.code === s.code && (c.role === "manager" || (c.role === "staff" && !s.isManager)))) {
          session.value = s;
          if (s.role === "tenant") enter(true);
          return;
        }
      }
      logout();
    });
    onUnmounted(() => clearInterval(timer));

    /* auth */
    const locked = () => {
      if (Date.now() < lockUntil.value) { notify("Authentication Failed", "Too many attempts. Wait 30 seconds.", "error"); return true; }
      return false;
    };
    const fail = m => {
      if (++fails.value >= 5) { lockUntil.value = Date.now() + 30000; fails.value = 0; }
      notify("Authentication Failed", m, "error");
    };
    const enter = (keep) => { if (!keep) view.value = "pos"; cart.value = []; dval.value = 0; cname.value = ""; type.value = "dine_in"; table.value = (restaurants.value[session.value.code]?.tables || DEF_TABLES)[0]; };
    const api = async body => {
      const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Login failed.");
      try { await signInWithCustomToken(auth, d.token); }
      catch (e) { throw new Error(/configuration-not-found|operation-not-allowed/.test(e.code || "") ? "Enable Authentication in the Firebase console." : "Login failed."); }
      return d;
    };
    const loginTenant = guard(async () => {
      if (locked()) return;
      let d;
      try { d = await api({ mode: "tenant", code: code.value, pin: pin.value }); } catch (e) { return fail(e.message); }
      fails.value = 0;
      session.value = { role: "tenant", code: d.code, isManager: d.role === "manager", staffName: d.name, isImpersonating: false };
      enter(); pin.value = ""; code.value = "";
    });
    const loginHq = guard(async () => {
      if (locked()) return;
      try { await api({ mode: "hq", password: hq.value }); } catch (e) { return fail(e.message); }
      fails.value = 0;
      session.value = { role: "hq", code: null, isManager: true, isImpersonating: false };
      hq.value = "";
    });
    const impersonate = c => { session.value = { role: "tenant", code: c, isManager: true, staffName: "Owner HQ", isImpersonating: true }; enter(); };
    const exitImp = () => (session.value = { role: "hq", code: null, isManager: true, isImpersonating: false });
    const logout = () => { session.value = null; receipt.value = null; signOut(auth).catch(() => {}); };

    /* POS */
    const type = v("dine_in"), table = v("T1"), cname = v(""), q = v(""), cat = v("All"), cartOpen = v(false);
    const cart = v([]), dtype = v("percent"), dval = v(0);
    const shown = computed(() => items.value.filter(i =>
      (cat.value === "All" || i.category === cat.value) &&
      (!q.value || i.name.toLowerCase().includes(q.value.toLowerCase()) || (i.nepaliName || "").includes(q.value))));
    const sub = computed(() => sum(cart.value, "itemTotal"));
    const disc = computed(() => {
      const d = Number(dval.value) || 0;
      if (d <= 0) return 0;
      return dtype.value === "percent" ? Math.round(sub.value * Math.min(d, 100) / 100) : Math.min(d, sub.value);
    });
    const running = computed(() => (type.value === "dine_in" ? tabOf(table.value) : null));
    const bill = computed(() => {
      const ex = running.value;
      return ex ? calc(sum([...(ex.items || []), ...cart.value], "itemTotal"), (ex.discount || 0) + disc.value) : calc(sub.value, disc.value);
    });
    const qtyAll = computed(() => sum(cart.value, "qty"));
    const label = computed(() => (type.value === "dine_in" ? table.value : TYPES.find(t => t[0] === type.value)[1]));

    const mi = v(null), mSel = v([]), mNote = v(""), mQty = v(1);
    const openMod = i => { mi.value = i; mSel.value = []; mNote.value = ""; mQty.value = 1; };
    const togMod = m => { const k = mSel.value.findIndex(x => x.name === m.name); if (k < 0) mSel.value.push(m); else mSel.value.splice(k, 1); };
    const picked = m => mSel.value.some(x => x.name === m.name);
    const key = c => (c.selectedModifiers || []).map(m => m.name).join("|");
    const changeQty = (c, d) => {
      c.qty += d;
      if (c.qty <= 0) cart.value = cart.value.filter(x => x !== c);
      else c.itemTotal = (c.unitPrice + sum(c.selectedModifiers || [], "priceExtra")) * c.qty;
    };
    const addToCart = () => {
      const i = mi.value, mods = clean(mSel.value), note = mNote.value.trim();
      const line = { id: i.id, name: i.name, unitPrice: Number(i.price), selectedModifiers: mods, note, qty: 0, itemTotal: 0 };
      const same = cart.value.find(c => c.id === i.id && key(c) === key(line) && (c.note || "") === note);
      if (same) changeQty(same, mQty.value);
      else { cart.value.push(line); changeQty(line, mQty.value); }
      mi.value = null;
    };

    const mkOrder = paid => {
      const ex = running.value, b = bill.value, t = tenant.value || {};
      const its = clean([...((ex && ex.items) || []), ...cart.value]);
      const base = ex ? { ...ex } : {
        id: "8848-" + String(Date.now()).slice(-6), restaurantCode: session.value.code,
        tenantName: t.name || session.value.code, address: t.address || "", panNumber: t.panNumber || "", phone: t.phone || "",
        customerName: cname.value || "Walk-in Guest", table: type.value === "dine_in" ? table.value : null, orderType: type.value,
        staffName: session.value.staffName, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        createdAt: Date.now(), isPaid: false, paymentMethod: null
      };
      return clean({ ...base, items: its, discount: b.disc, subtotal: b.sub, serviceCharge: b.sc, vat: b.vat, grandTotal: b.total, status: paid ? "completed" : "pending" });
    };
    const resetCart = () => { cart.value = []; cname.value = ""; dval.value = 0; cartOpen.value = false; };
    const putOrder = o => set(ref(db, `8848/orders/${session.value.code}/${o.id}`), o);

    const sendKot = guard(async () => {
      if (!cart.value.length) return;
      await putOrder(mkOrder(false));
      resetCart();
      notify("KOT Ticket Dispatched", `Dispatched KOT order ticket for ${label.value}!`);
    });

    const showCo = v(false), co = v(null), coCart = v(false), method = v("cash"), cash = v(0), receipt = v(null);
    const openCo = ord => {
      if (ord) { co.value = ord; coCart.value = false; }
      else { if (!cart.value.length && !running.value) return; co.value = mkOrder(false); coCart.value = true; }
      method.value = "cash"; cash.value = co.value.grandTotal; showCo.value = true;
    };
    const printOrder = async o => { receipt.value = o; await nextTick(); window.print(); };
    const finalize = guard(async () => {
      const o = co.value;
      if (method.value === "cash" && Number(cash.value) < o.grandTotal) return notify("Amount Tendered", "Amount is less than total.", "error");
      const done = clean({ ...o, isPaid: true, paymentMethod: method.value, status: "completed", paidAt: Date.now() });
      await putOrder(done);
      if (coCart.value) resetCart();
      showCo.value = false;
      await printOrder(done);
    });
    const setStatus = (id, status) => update(ref(db, `8848/orders/${session.value.code}/${id}`), { status });
    const pickTable = t => { table.value = t; type.value = "dine_in"; view.value = "pos"; };

    /* kitchen timers */
    const mins = o => Math.max(0, Math.floor((now.value - (o.createdAt || now.value)) / 60000));
    const timerCls = o => (mins(o) < 5 ? "ok" : mins(o) < 15 ? "warn" : "late");

    /* tables */
    const showTb = v(false), tbName = v("");
    const addTable = guard(async () => {
      const n = tbName.value.trim();
      if (!n) return;
      if (tables.value.some(t => t.toLowerCase() === n.toLowerCase())) return notify("Error", "Table already exists.", "error");
      await update(ref(db, `8848/restaurants/${session.value.code}`), { tables: [...tables.value, n] });
      tbName.value = "";
    });
    const delTable = guard(async t => {
      if (tabOf(t)) return notify("Error", "Table has an open order.", "error");
      if (tables.value.length < 2) return notify("Error", "At least one table is required.", "error");
      await update(ref(db, `8848/restaurants/${session.value.code}`), { tables: tables.value.filter(x => x !== t) });
    });

    /* menu */
    const showM = v(false), editM = v(null), mf = v({});
    const openM = i => {
      editM.value = i;
      mf.value = i ? { ...i } : { name: "", nepaliName: "", price: "", category: cats.value[1] || "Main Course", isVeg: true, image: "" };
      showM.value = true;
    };
    const saveM = guard(async () => {
      const f = mf.value, c = f.category.trim(), rc = session.value.code, id = editM.value ? editM.value.id : "item_" + Date.now();
      await set(ref(db, `8848/restaurants/${rc}/menuItems/${id}`), { name: f.name.trim(), nepaliName: f.nepaliName || "", price: Number(f.price), category: c, isVeg: !!f.isVeg, image: f.image || "" });
      const stored = (tenant.value && tenant.value.categories) || ["All", ...DEF_CATS];
      if (!stored.includes(c)) await update(ref(db, `8848/restaurants/${rc}`), { categories: [...stored, c] });
      showM.value = false;
    });
    const delM = id => ask("Delete Dish", "Delete this food item?", guard(() => remove(ref(db, `8848/restaurants/${session.value.code}/menuItems/${id}`))));

    /* staff */
    const showS = v(false), sf = v({ name: "", pin: "" });
    const openS = () => { sf.value = { name: "", pin: "" }; showS.value = true; };
    const pinTaken = p => p === ((tenant.value && tenant.value.managerPin) || "0000") || staff.value.some(s => s.pin === p);
    const saveS = guard(async () => {
      const f = sf.value;
      if (!/^\d{4}$/.test(f.pin)) return notify("Invalid PIN", "PIN must be 4 digits.", "error");
      if (pinTaken(f.pin)) return notify("Invalid PIN", "PIN already in use.", "error");
      await set(ref(db, `8848/restaurants/${session.value.code}/staffPins/stf_${Date.now()}`), { name: f.name.trim(), pin: f.pin, role: "Staff" });
      showS.value = false;
    });
    const delS = id => ask("Remove Staff PIN", "Delete this staff access PIN?", guard(() => remove(ref(db, `8848/restaurants/${session.value.code}/staffPins/${id}`))));

    /* reports */
    const range = v("today"), detail = v(null);
    const since = computed(() => (range.value === "today" ? new Date(now.value).setHours(0, 0, 0, 0) : range.value === "week" ? now.value - 7 * 864e5 : 0));
    const logs = computed(() => olist.value.filter(o => (o.createdAt || 0) >= since.value));
    const paid = computed(() => logs.value.filter(o => o.isPaid));
    const rRev = computed(() => sum(paid.value, "grandTotal"));
    const rVat = computed(() => sum(paid.value, "vat"));
    const rAvg = computed(() => (paid.value.length ? Math.round(rRev.value / paid.value.length) : 0));
    const exportCsv = () => {
      const e = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
      let csv = "\uFEFFOrder ID,Date,Time,Customer,Table/Mode,Payment Method,Subtotal,Service Charge,VAT,Grand Total\n";
      paid.value.forEach(o => (csv += [e(o.id), e(fdate(o.createdAt)), e(o.time), e(o.customerName || "Walk-in"), e(o.table || o.orderType), e(o.paymentMethod), o.subtotal, o.serviceCharge, o.vat, o.grandTotal].join(",") + "\n"));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = `POS8848_SalesReport_${session.value.code}.csv`;
      a.click();
    };

    /* settings */
    const sfm = v({});
    const loadSet = () => {
      const t = tenant.value;
      if (t) sfm.value = { name: t.name || "", panNumber: t.panNumber || "", address: t.address || "", phone: t.phone || "", managerPin: t.managerPin || "0000", currencySymbol: t.currencySymbol || "रू", receiptFooter: t.receiptFooter || "", vatEnabled: t.vatEnabled ?? true, serviceChargeEnabled: t.serviceChargeEnabled ?? true };
    };
    const saveSet = guard(async () => {
      const f = sfm.value;
      if (!/^\d{4,}$/.test(String(f.managerPin))) return notify("Invalid PIN", "Manager PIN must be at least 4 digits.", "error");
      if (staff.value.some(s => s.pin === String(f.managerPin))) return notify("Invalid PIN", "PIN already in use.", "error");
      await update(ref(db, `8848/restaurants/${session.value.code}`), clean({ ...f, managerPin: String(f.managerPin) }));
      notify("Settings Saved", "Outlet profile updated.");
    });

    /* HQ */
    const showT = v(false), editT = v(null), tf = v({});
    const gOrders = computed(() => Object.values(allOrders.value).flatMap(o => Object.values(o || {})));
    const gCount = computed(() => gOrders.value.length);
    const gRev = computed(() => sum(gOrders.value.filter(o => o.isPaid), "grandTotal"));
    const openT = r => {
      editT.value = r;
      tf.value = r ? { ...r } : { name: "", code: "", managerPin: "", panNumber: "", address: "", phone: "" };
      showT.value = true;
    };
    const saveT = guard(async () => {
      const f = tf.value, c = String(f.code).trim().toUpperCase();
      if (!/^[A-Z0-9_-]{3,20}$/.test(c)) return notify("Error", "Use 3-20 letters, numbers, - or _.", "error");
      if (!editT.value && restaurants.value[c]) return notify("Error", "Code already exists.", "error");
      const base = { name: f.name.trim(), managerPin: String(f.managerPin), panNumber: f.panNumber, address: f.address, phone: f.phone || "" };
      await update(ref(db, `8848/restaurants/${c}`), editT.value ? base : {
        ...base, currencySymbol: "रू", receiptFooter: "Thank you for dining with us!", vatEnabled: true, serviceChargeEnabled: true,
        vatRate: 13, serviceChargeRate: 10, categories: ["All", ...DEF_CATS], tables: DEF_TABLES
      });
      showT.value = false;
    });
    const delT = c => ask("Delete Outlet", `Permanently delete restaurant outlet "${c}"?`, guard(async () => {
      await remove(ref(db, `8848/restaurants/${c}`));
      await remove(ref(db, `8848/orders/${c}`));
    }));

    return {
      session, mode, code, pin, hq, ready, busy, view, tabs, notice, noticeOk, list, tenant, cur, tables, items, cats, staff, cfg, olist, kds,
      loginTenant, loginHq, impersonate, exitImp, logout,
      type, table, cname, q, cat, cartOpen, cart, dtype, dval, shown, disc, running, bill, qtyAll, label,
      mi, mSel, mNote, mQty, openMod, togMod, picked, changeQty, addToCart, sendKot,
      showCo, co, method, cash, receipt, openCo, finalize, printOrder, setStatus, pickTable, tabOf, mins, timerCls,
      showTb, tbName, addTable, delTable, showM, editM, mf, openM, saveM, delM, showS, sf, openS, saveS, delS,
      range, detail, logs, paid, rRev, rVat, rAvg, exportCsv, sfm, saveSet, showT, editT, tf, gCount, gRev, openT, saveT, delT,
      MODS, PAYS, TYPES, money, fdate
    };
  }
}).mount("#app");