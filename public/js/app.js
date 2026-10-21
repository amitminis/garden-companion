// Garden Companion — web app frontend.
// Ported from garden-companion.html (the Claude Artifact). Same UI, copy and
// behavior; the Artifact's claude.use("db") / claude.use("sample") calls are
// replaced with fetch() against the /api Vercel Functions.
(function(){
  "use strict";

  // Every user-facing string goes through tr() (public/js/i18n.js): the
  // English text is the key, translated to the gardener's language.
  // Constant tables mark their strings with N_() and translate where they
  // render, so a language switch never needs a reload.
  var tr = I18N.t, trn = I18N.tn;
  function N_(s){ return s; }

  // ---------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------
  function el(tag, attrs, children){
    var e = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs){
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.indexOf("on") === 0 && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else e.setAttribute(k, v);
    }
    (children || []).forEach(function(c){ if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function fmtDate(d){
    try { return new Date(d).toLocaleDateString(I18N.locale(), {weekday:"short", month:"short", day:"numeric"}); }
    catch(e){ return d; }
  }
  function todayISO(){
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
  }
  function uid(){ return Math.random().toString(36).slice(2,10); }
  function pad2(n){ return String(n).padStart(2,"0"); }
  function isoDate(year, month, day){ return year + "-" + pad2(month) + "-" + pad2(day); }
  function addDays(iso, n){
    var d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + n);
    return isoDate(d.getFullYear(), d.getMonth()+1, d.getDate());
  }

  // Resize an image file to a small JPEG data URL (keeps db docs well under the 256KB cap).
  function resizeImage(file, maxW){
    maxW = maxW || 480;
    return new Promise(function(resolve, reject){
      var img = new Image();
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function(){
        img.onerror = reject;
        img.onload = function(){
          var scale = Math.min(1, maxW / img.width);
          var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
          var canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.7));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  function dataURLtoBlob(dataUrl){
    var parts = dataUrl.split(","), mime = parts[0].match(/:(.*?);/)[1];
    var bin = atob(parts[1]), arr = new Uint8Array(bin.length);
    for (var i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], {type:mime});
  }

  // Turns GPS coordinates into a readable city name (e.g. "Modi'in, Central
  // District, Israel") using BigDataCloud's free, no-key, client-side reverse
  // geocoding endpoint — so onboarding's "Use my current location" shows a
  // place name instead of raw lat/lon. Returns "" on any failure; callers
  // fall back to the coordinates or ask the user to type a location.
  async function reverseGeocodeCity(lat, lon){
    try {
      var res = await fetch("https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=" + lat + "&longitude=" + lon + "&localityLanguage=" + I18N.lang());
      if (!res.ok) return "";
      var data = await res.json();
      var city = data.city || data.locality || "";
      var region = data.principalSubdivision || "";
      var country = data.countryName || "";
      if (city) return city + (region && region !== city ? ", " + region : "") + (country ? ", " + country : "");
      if (region && country) return region + ", " + country;
      return country || "";
    } catch(e){ return ""; }
  }

  // A saved location label for display: the GPS-only sentinel is
  // translated, "Unspecified" shows as nothing.
  function placeLabel(label){
    if (!label || /^unspecified$/i.test(label)) return "";
    return /^current location$/i.test(label) ? tr("Current location") : label;
  }

  // ---------------------------------------------------------------
  // API access — replaces the Artifact's claude.use("db") / claude.use("sample").
  // JSON in/out; throws with the server's error message on a non-2xx.
  // ---------------------------------------------------------------
  async function api(path, opts){
    opts = opts || {};
    var hasBody = opts.body !== undefined;
    var res = await fetch("/api" + path, {
      method: opts.method || "GET",
      headers: hasBody ? {"Content-Type":"application/json"} : undefined,
      body: hasBody ? JSON.stringify(opts.body) : undefined
    });
    if (!res.ok){
      var err = await res.json().catch(function(){ return {error: res.statusText}; });
      throw new Error((err && err.error) || ("Request failed (" + res.status + ")"));
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // Why the last photo analysis / problem report didn't produce a diagnosis,
  // as user-facing text (replaces the Artifact's lastSampleError /
  // sampleErrorMessage / imageAnalysisNotice machinery). Whatever the
  // reason, the photo itself is always saved server-side — an upload is
  // never lost just because analysis couldn't run.
  var PHOTO_ONLY_MESSAGE = N_("Photo saved — analysis isn't available right now, but the photo itself is kept.");
  var ANALYZE_FAILED_MESSAGE = N_("Couldn't analyze that — try again.");
  var ANALYZE_FAILED_PHOTO_KEPT_MESSAGE = N_("Couldn't analyze that — the photo is saved, but try again for a diagnosis.");
  var lastAnalysisMessage = null;

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  var state = { settings:null, plants:[], tasks:[], weather:null, section:"tasks" };
  // Month and weekday names in the gardener's language (Intl), 0-based.
  // 2 Jan 2000 was a Sunday.
  function monthName(m){ return new Date(2000, m, 1).toLocaleDateString(I18N.locale(), {month:"long"}); }
  function monthShort(m){ return new Date(2000, m, 1).toLocaleDateString(I18N.locale(), {month:"short"}); }
  function dayName(d){ return new Date(2000, 0, 2 + d).toLocaleDateString(I18N.locale(), {weekday:"long"}); }
  function dayShort(d){ return new Date(2000, 0, 2 + d).toLocaleDateString(I18N.locale(), {weekday: I18N.isRTL() ? "narrow" : "short"}); }
  // "Oct 21" / "21 באוק׳"
  function shortDate(d){ return d.toLocaleDateString(I18N.locale(), {month:"short", day:"numeric"}); }
  // A fixed categorical palette so each plant gets a stable, distinguishable
  // color (used as calendar dots and list-row markers) — legible on both light
  // and dark grounds. Assigned by the plant's position in state.plants, so a
  // given plant keeps its color as long as it isn't removed and re-added.
  var PLANT_PALETTE = ["#4C7CE0","#E0794C","#9B59D6","#3FA6A0","#D6539B","#8AA33C","#C0392B","#3178C6","#C9932E","#5F6FE0"];
  function plantColorFor(plantId){
    var idx = state.plants.findIndex(function(p){ return p.id === plantId; });
    if (idx === -1) return "var(--ink-faint)";
    return PLANT_PALETTE[idx % PLANT_PALETTE.length];
  }

  function icon(name){
    var paths = {
      leaf:'<path d="M5 21c9 0 14-5 14-14 0 0-9-1-14 4-3 3-4 6-4 10 4 0 7-1 10-4"/>',
      sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
      cloud:'<path d="M6 18a4 4 0 0 1 .3-8 5 5 0 0 1 9.6-1.6A4.5 4.5 0 0 1 17 18H6z"/>',
      rain:'<path d="M6 15a4 4 0 0 1 .3-8 5 5 0 0 1 9.6-1.6A4.5 4.5 0 0 1 17 15H6z"/><path d="M8 19l-1 2M12 19l-1 2M16 19l-1 2"/>',
      drop:'<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
      scissors:'<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><path d="M20 6L7.5 15M20 18L7.5 9"/>',
      refresh:'<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.6"/><path d="M4 4v4.6h4.6"/><path d="M4 13a8 8 0 0 0 13.7 4.7l2.3-2.3"/><path d="M20 20v-4.6h-4.6"/>',
      library:'<rect x="4" y="4" width="7" height="16" rx="1"/><rect x="13" y="4" width="7" height="16" rx="1"/>',
      calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
      tasks:'<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
      camera:'<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
      bug:'<ellipse cx="12" cy="14" rx="5" ry="6"/><path d="M12 8v12M7 11H3M7 16H3M17 11h4M17 16h4M9 6L7 3M15 6l2-3"/>',
      seedling:'<path d="M12 21v-9"/><path d="M12 12c0-4-3-6-7-6 0 4 3 6 7 6z"/><path d="M12 10c0-3 2-6 7-6 0 4-3 6-7 6z"/>',
      basket:'<path d="M3 10h18l-2 10H5z"/><path d="M8 10l3-6M16 10l-3-6"/>',
      check:'<path d="M5 12.5l4.5 4.5L19 7"/>',
      home:'<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
      pencil:'<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/>',
      trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
      search:'<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
      moon:'<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
      gear:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'
    };
    return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+(paths[name]||paths.leaf)+'</svg>';
  }
  function weatherIconFor(text){
    text = (text||"").toLowerCase();
    if (/rain|storm|shower/.test(text)) return "rain";
    if (/cloud|overcast/.test(text)) return "cloud";
    return "sun";
  }

  // What kind of job a task is, guessed from its wording (English or
  // Hebrew) — drives the row icon, the plant rim's "next care" line and
  // the weekly summary.
  var TASK_CATEGORIES = [
    {key:"water",   label:N_("water"),   icon:"drop",     emoji:"💧", verb:N_("watered"),      re:/water|irrigat|soak|drip|השק|טפטוף|הרטב/},
    {key:"prune",   label:N_("prune"),   icon:"scissors", emoji:"✂️", verb:N_("pruned"),       re:/prun|trim|deadhead|cut back|pinch|גיזום|לגזום|גזמו|גזום|קיצוץ|דילול/},
    {key:"harvest", label:N_("harvest"), icon:"basket",   emoji:"🧺", verb:N_("harvested"),    re:/harvest|pick |collect|קטיף|לקטוף|קטפו|קציר|אסיף/},
    {key:"photo",   label:N_("photo"),   icon:"camera",   emoji:"📷", verb:N_("took photos"),  re:/photo|picture|check-in|checkin|צילום|תמונה|צלמו|לצלם/},
    {key:"treat",   label:N_("treat"),   icon:"bug",      emoji:"🐛", verb:N_("treated pests & problems"), re:/pest|aphid|bug|spray|fung|mildew|yellow|disease|rot|slug|מזיק|כנימ|ריסוס|לרסס|רססו|פטרי|קמחון|הצהב|מחל|ריקבון|שבלול|חילזון/},
    {key:"plant",   label:N_("planting"),   icon:"seedling", emoji:"🌱", verb:N_("planted & sowed"), re:/sow|seed|plant |bulb|transplant|pot up|repot|זריעה|לזרוע|זרעו|שתיל|לשתול|שתילה|פקע|העתק/},
    {key:"feed",    label:N_("feed"),    icon:"leaf",     emoji:"🍃", verb:N_("fed & mulched"), re:/fertili|feed|compost|mulch|manure|דשן|דישון|קומפוסט|חיפוי|זבל|הזנה/}
  ];
  var OTHER_CATEGORY = {key:"other", label:N_("task"), icon:"leaf", emoji:"🍃", verb:N_("did other jobs")};
  function taskCategory(t){
    var text = " " + (t.title || "").toLowerCase() + " ";
    for (var i=0;i<TASK_CATEGORIES.length;i++){ if (TASK_CATEGORIES[i].re.test(text)) return TASK_CATEGORIES[i]; }
    if (t.kind === "issue") return TASK_CATEGORIES[4];
    return OTHER_CATEGORY;
  }

  var TYPE_EMOJI = {tree:"🌳", bush:"🪴", flower:"🌸", vegetable:"🥕", herb:"🌿", other:"🌱"};
  function typeEmoji(type){ return TYPE_EMOJI[type] || TYPE_EMOJI.other; }
  var TYPE_LABELS = {tree:N_("Tree"), bush:N_("Bush"), flower:N_("Flower"), vegetable:N_("Vegetable"), herb:N_("Herb"), other:N_("Other")};
  function typeLabel(type){ return TYPE_LABELS[type] ? tr(TYPE_LABELS[type]) : (type || ""); }

  // Knowledge score -> a friendlier growth "level" (same thresholds as
  // gradeLabelFor).
  function plantLevel(score){
    if (score >= 80) return {emoji:"🌸", name:tr("Bloom")};
    if (score >= 50) return {emoji:"🌿", name:tr("Sprout")};
    return {emoji:"🌱", name:tr("Seedling")};
  }

  // Whole days from today to an ISO date (negative = past).
  function daysFromToday(iso){
    var a = new Date(todayISO() + "T00:00:00"), b = new Date(iso + "T00:00:00");
    return Math.round((b - a) / 86400000);
  }
  function relativeDay(iso){
    if (!iso) return "";
    var n = daysFromToday(iso);
    if (n < -1) return trn(Math.abs(n), "1 day overdue", "{n} days overdue");
    if (n === -1) return tr("yesterday");
    if (n === 0) return tr("today");
    if (n === 1) return tr("tomorrow");
    if (n < 7) return trn(n, "in 1 day", "in {n} days");
    return fmtDate(iso);
  }

  // The next open task for a plant (overdue ones first), or null.
  function nextTaskFor(plantId){
    var open = state.tasks.filter(function(t){ return t.plantId === plantId && t.status !== "done" && t.dueDate; });
    open.sort(function(a,b){ return a.dueDate.localeCompare(b.dueDate); });
    return open[0] || null;
  }

  function isTouch(){ return window.matchMedia && window.matchMedia("(pointer:coarse)").matches; }
  function buzz(ms){ try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch(e){} }

  // Per-device convenience storage (dismissed tips, library view). Never
  // required for correctness — every read/write is guarded.
  function localGet(key, fallback){
    try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch(e){ return fallback; }
  }
  function localSet(key, value){ try { localStorage.setItem(key, JSON.stringify(value)); } catch(e){} }

  var toastTimer = null;
  function showToast(text, action, ms){
    var t = document.getElementById("toast");
    t.innerHTML = "";
    t.appendChild(el("span", {}, [text]));
    if (action){
      var b = el("button", {}, [action.label]);
      b.addEventListener("click", function(){ t.hidden = true; action.fn(); });
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.hidden = true; }, ms || 4500);
  }

  // A little burst of leaves from wherever something was completed.
  function leafBurst(fromEl){
    if (!fromEl || !fromEl.getBoundingClientRect) return;
    var r = fromEl.getBoundingClientRect();
    var x = r.left + Math.min(r.width, 60) / 2, y = r.top + r.height / 2;
    var leaves = ["🍃","🌿","✨","🍃","🌱","🍀","✨"];
    leaves.forEach(function(leaf, i){
      var a = (Math.PI * 2 * i) / leaves.length + Math.random() * 0.6;
      var dist = 40 + Math.random() * 50;
      var span = el("span", {class:"leaf-burst", style:"left:" + x + "px;top:" + y + "px;--dx:" + Math.round(Math.cos(a) * dist) + "px;--dy:" + Math.round(Math.sin(a) * dist - 20) + "px;--rot:" + Math.round(Math.random() * 360 - 180) + "deg;"}, [leaf]);
      document.body.appendChild(span);
      setTimeout(function(){ span.remove(); }, 900);
    });
  }

  async function boot(){
    try {
      state.settings = await api("/settings");
    } catch(e){
      document.getElementById("boot").innerHTML =
        '<div class="onboard-card card" style="text-align:center;"><h2>' + tr("Couldn't reach the garden") + '</h2>'+
        '<p class="lead">' + tr("Garden Companion can't reach its saved garden data right now. Check your connection and try again.") + '</p>'+
        '<button class="btn btn-primary" onclick="location.reload()">' + tr("Try again") + '</button></div>';
      return;
    }

    // The saved language wins over this device's last-used one.
    if (state.settings && state.settings.language && state.settings.language !== I18N.lang()){
      I18N.setLang(state.settings.language);
      applyStaticText();
    }

    document.getElementById("boot").hidden = true;
    document.getElementById("app").hidden = false;

    if (!state.settings || !state.settings.onboarded){
      renderOnboarding();
    } else {
      await loadGardenData();
      renderShell();
      subscribeLive();
      refreshWeatherNow(); // live weather check every time the app is opened — don't wait on the daily cron
    }
  }

  // Fetches a fresh forecast on demand (no AI call, so it's fast) instead of
  // relying solely on the once-daily cron job — called once on every app
  // open (see boot()) and from the weather card's refresh button.
  var weatherRefreshing = false;
  async function refreshWeatherNow(){
    if (weatherRefreshing) return;
    weatherRefreshing = true;
    try {
      var w = await api("/weather-refresh", {method:"POST"});
      if (w && !w.error){
        state.weather = w;
        if (!modalOpenFor && !userIsBusy()) renderShell();
      }
    } catch(e){ /* silent — the cached weather card stays as-is */ }
    weatherRefreshing = false;
  }

  async function loadGardenData(){
    var results = await Promise.all([api("/plants"), api("/tasks"), api("/weather"), api("/settings")]);
    state.plants = results[0] || [];
    state.tasks = results[1] || [];
    state.weather = results[2] || null;
    state.settings = results[3] || state.settings;
  }

  // The Artifact's db pushed live onSnapshot updates; here a 45-second poll
  // stands in for them. Same guard as the original: state always updates,
  // but the dashboard only repaints while no plant modal is open (closeModal
  // repaints anyway once it closes).
  var liveTimer = null, livePolling = false;
  function subscribeLive(){
    if (liveTimer) return;
    liveTimer = setInterval(refreshLive, 45000);
  }
  async function refreshLive(){
    if (livePolling || document.hidden) return;
    livePolling = true;
    try {
      await loadGardenData();
      if (!modalOpenFor && !userIsBusy()) renderShell();
    } catch(e){ /* transient — try again on the next tick */ }
    livePolling = false;
  }

  // ---------------------------------------------------------------
  // ONBOARDING
  // ---------------------------------------------------------------
  var onboard = {
    step: 0,
    location: null,
    wiz: null,
    addedAny: false
  };

  // Plant type / spot dropdowns shared by onboarding's "Add your plants"
  // wizard and the dashboard's "+ Add a plant" modal — identifying a plant
  // is a pick-from-a-list wizard now, not a free-text box parsed by AI.
  function typeOptions(selectedType){
    return ["tree","bush","flower","vegetable","herb","other"].map(function(ty){
      var o = el("option", {value:ty}, [typeLabel(ty)]);
      if (selectedType === ty) o.setAttribute("selected","selected");
      return o;
    });
  }
  // Option values are saved in English (a stable key the server and the
  // "Not sure" checks rely on) and shown translated — see optLabel().
  var SPOT_OPTIONS = [N_("Front yard"),N_("Backyard"),N_("Side yard"),N_("Patio / pots"),N_("Raised bed"),N_("Greenhouse"),N_("Balcony"),N_("Windowsill")];
  function spotPicker(existingSpot){
    var isCustom = !!existingSpot && SPOT_OPTIONS.indexOf(existingSpot) === -1;
    var select = el("select", {}, [el("option", {value:""}, [tr("Choose a spot…")])].concat(
      SPOT_OPTIONS.map(function(s){ var o = el("option", {value:s}, [tr(s)]); if (existingSpot===s) o.setAttribute("selected","selected"); return o; }),
      [el("option", {value:"__custom__"}, [tr("Other / describe…")])]
    ));
    if (isCustom) select.value = "__custom__";
    var customInput = el("input", {type:"text", placeholder:tr("Describe the spot"), value: isCustom ? existingSpot : "", style: isCustom ? "margin-top:6px;" : "display:none;margin-top:6px;"});
    select.addEventListener("change", function(){
      customInput.style.display = select.value === "__custom__" ? "" : "none";
    });
    return { select: select, customInput: customInput, getValue: function(){ return select.value === "__custom__" ? customInput.value.trim() : select.value; } };
  }

  // Dropdown option lists for the plant wizard's "get to know it" fields —
  // plain option pickers (no free-text) since these values feed straight
  // into the AI care-card prompt as clean short labels.
  var AGE_OPTIONS = [N_("Just planted"),N_("Less than 1 year"),N_("1–2 years"),N_("3–5 years"),N_("More than 5 years"),N_("Not sure")];
  var SUN_OPTIONS = [N_("Full sun (6+ hrs)"),N_("Partial sun (4–6 hrs)"),N_("Partial shade (2–4 hrs)"),N_("Full shade (under 2 hrs)"),N_("Not sure")];
  var WATERING_OPTIONS = [N_("Drip irrigation"),N_("Sprinkler"),N_("Hand watering"),N_("Rain-fed only"),N_("Not sure")];
  var GROUND_OPTIONS = [N_("Clay soil"),N_("Sandy soil"),N_("Loamy soil"),N_("Raised bed"),N_("Pot / container"),N_("Not sure")];
  // A saved value shown in the gardener's language: preset option values
  // (and plant types) are translated, free text is shown as typed.
  function optLabel(v){ return v ? tr(v) : v; }
  function simpleSelect(options, selected, placeholder){
    var opts = [el("option", {value:""}, [placeholder || tr("Choose…")])].concat(options.map(function(o){
      var opt = el("option", {value:o}, [tr(o)]);
      if (o === selected) opt.setAttribute("selected","selected");
      return opt;
    }));
    return el("select", {}, opts);
  }

  function renderOnboarding(){
    var app = document.getElementById("app");
    app.innerHTML = "";
    app.appendChild(el("div", {class:"onboard-wrap"}, [ onboardStepView() ]));
  }

  function progressDots(active){
    var wrap = el("div", {class:"progress-dots"});
    for (var i=0;i<3;i++){
      wrap.appendChild(el("span", {class: i<active?"filled":(i===active?"active":"")}));
    }
    return wrap;
  }

  function onboardStepView(){
    if (onboard.step === 0) return stepWelcome();
    if (onboard.step === 1) return stepLocation();
    if (onboard.step === 2) return stepStartLibrary();
    if (onboard.step === 3) return stepPlantWizard();
    if (onboard.step === 4) return stepFinish();
    return stepWelcome();
  }

  function stepWelcome(){
    return el("div", {class:"onboard-card card"}, [
      languagePicker(function(){ renderOnboarding(); }),
      el("div", {class:"onboard-step-label"}, [tr("Welcome")]),
      el("h2", {}, [tr("Let's set up your garden")]),
      el("p", {class:"lead"}, [tr("I'll ask where you're gardening, get to know what you're growing, and take a look at a few photos. After that I'll check on things every day — weather, what's due for pruning or sowing, and how your plants are doing.")]),
      el("button", {class:"btn btn-primary", onclick:function(){ onboard.step=1; renderOnboarding(); }}, [tr("Start setup →")])
    ]);
  }

  // עברית / English toggle (onboarding's first screen and Settings). The
  // choice is saved to settings, since the server writes care guides, tips
  // and diagnoses in it too.
  var LANGUAGES = [["he","עברית"],["en","English"]];
  function setLanguage(lang){
    if (lang === I18N.lang()) return;
    I18N.setLang(lang);
    applyStaticText();
    tipsByMonth = {}; // tips are written in a language — fetch them again
    state.settings = Object.assign({}, state.settings, {language:lang});
    api("/settings", {method:"PATCH", body:{language:lang}}).catch(function(){});
  }
  function languagePicker(onChange){
    var seg = el("div", {class:"seg lang-seg", role:"group", "aria-label":tr("Language")});
    LANGUAGES.forEach(function(l){
      var b = el("button", {class: I18N.lang() === l[0] ? "active" : "", "aria-pressed": I18N.lang() === l[0] ? "true" : "false", lang:l[0]}, [l[1]]);
      b.addEventListener("click", function(){ setLanguage(l[0]); onChange(); });
      seg.appendChild(b);
    });
    return seg;
  }

  function stepLocation(){
    var card = el("div", {class:"onboard-card card"}, [
      progressDots(0),
      el("div", {class:"onboard-step-label"}, [tr("Step {n} of {total}", {n:1, total:3})]),
      el("h2", {}, [tr("Where's your garden?")]),
      el("p", {class:"lead"}, [tr("This sets your weather, local seasons and planting calendar.")])
    ]);
    var status = el("div", {class:"thinking", style:"margin-bottom:12px;"});
    var confirmBox = el("div", {});
    var manual = el("input", {type:"text", placeholder:tr("Town and country, e.g. Modi'in, Israel"), value: onboard.location && onboard.location.label || ""});
    var gpsBtn = el("button", {class:"btn", style:"margin-bottom:14px;"}, [tr("Use my current location")]);
    gpsBtn.addEventListener("click", function(){
      if (!navigator.geolocation){ status.textContent = tr("Location services aren't available here — type it in below."); return; }
      confirmBox.innerHTML = "";
      status.textContent = tr("Locating…");
      navigator.geolocation.getCurrentPosition(async function(pos){
        var lat = pos.coords.latitude, lon = pos.coords.longitude;
        status.textContent = tr("Got your coordinates — looking up the city name…");
        var cityLabel = await reverseGeocodeCity(lat, lon);
        status.textContent = "";
        if (!cityLabel){
          status.textContent = tr("Got your coordinates, but couldn't look up a city name — type one in below.");
          return;
        }
        // Don't commit the detected city as the location yet — show it and
        // let the user approve it (or fix it) before it's saved.
        confirmBox.innerHTML = "";
        confirmBox.appendChild(el("div", {class:"card", style:"padding:12px 14px;margin-bottom:14px;"}, [
          el("div", {style:"font-size:12.5px;color:var(--ink-faint);margin-bottom:4px;"}, [tr("We found:")]),
          el("div", {style:"font-weight:600;font-size:14.5px;margin-bottom:10px;"}, [cityLabel]),
          el("div", {class:"row", style:"gap:8px;"}, [
            (function(){
              var useBtn = el("button", {class:"btn btn-primary btn-sm"}, [tr("✓ Use this")]);
              useBtn.addEventListener("click", function(){
                onboard.location = { label: cityLabel, lat: lat, lon: lon };
                manual.value = cityLabel;
                confirmBox.innerHTML = "";
                status.textContent = tr("Using {place}.", {place:cityLabel});
              });
              return useBtn;
            })(),
            (function(){
              var editBtn = el("button", {class:"btn btn-ghost btn-sm"}, [tr("Edit manually")]);
              editBtn.addEventListener("click", function(){
                manual.value = cityLabel;
                manual.focus();
                confirmBox.innerHTML = "";
                status.textContent = "";
              });
              return editBtn;
            })()
          ])
        ]));
      }, function(){
        status.textContent = tr("Couldn't get your location — type it in below instead.");
      }, {timeout:8000});
    });
    card.appendChild(gpsBtn);
    card.appendChild(status);
    card.appendChild(confirmBox);
    card.appendChild(el("div", {class:"field"}, [
      el("label", {}, [tr("Or enter it manually")]),
      manual
    ]));
    var nextBtn = el("button", {class:"btn btn-primary"}, [tr("Continue →")]);
    nextBtn.addEventListener("click", function(){
      if (!onboard.location) onboard.location = {};
      onboard.location.label = manual.value || onboard.location.label || "Unspecified";
      onboard.step = 2;
      renderOnboarding();
    });
    var row = el("div", {class:"row", style:"justify-content:space-between;margin-top:6px;"}, [
      el("button", {class:"btn btn-ghost", onclick:function(){ onboard.step=0; renderOnboarding(); }}, [tr("← Back")]),
      nextBtn
    ]);
    card.appendChild(row);
    return card;
  }

  // ---- "Start building your library now?" (onboarding only) ----
  function stepStartLibrary(){
    var card = el("div", {class:"onboard-card card"}, [
      progressDots(1, 3),
      el("div", {class:"onboard-step-label"}, [tr("Step {n} of {total}", {n:2, total:3})]),
      el("h2", {}, [tr("Want to start adding plants to your garden now?")]),
      el("p", {class:"lead"}, [tr("I'll guide you through adding each plant with a short form — or you can skip this and do it anytime from the My garden section.")])
    ]);
    var yesBtn = el("button", {class:"btn btn-primary"}, [tr("Yes, let's add plants")]);
    yesBtn.addEventListener("click", function(){ onboard.step=3; onboard.wiz=null; renderOnboarding(); });
    var noBtn = el("button", {class:"btn btn-ghost"}, [tr("Not now")]);
    noBtn.addEventListener("click", function(){ onboard.step=4; renderOnboarding(); });
    card.appendChild(el("div", {class:"row", style:"gap:10px;margin-top:6px;"}, [yesBtn, noBtn]));
    card.appendChild(el("div", {class:"row", style:"justify-content:flex-start;margin-top:16px;"}, [
      el("button", {class:"btn btn-ghost", onclick:function(){ onboard.step=1; renderOnboarding(); }}, [tr("← Back")])
    ]));
    return card;
  }

  function stepPlantWizard(){
    if (!onboard.wiz) onboard.wiz = createWizardState();
    return plantWizardCard(onboard.wiz, {
      rerender: renderOnboarding,
      onAdded: function(){ onboard.addedAny = true; },
      onExit: function(){ onboard.step = 4; onboard.wiz = null; renderOnboarding(); }
    });
  }

  function stepFinish(){
    var card = el("div", {class:"onboard-card card"}, [
      el("div", {class:"onboard-step-label"}, [tr("All set")]),
      el("h2", {}, [tr("All set")]),
      el("p", {class:"lead"}, [onboard.addedAny
        ? tr("Your garden is saved — care guides and yearly schedules are ready for what you've added.")
        : tr("Your garden is set up. Add plants anytime from the My garden section.")])
    ]);
    var finishBtn = el("button", {class:"btn btn-primary"}, [tr("Go to my garden →")]);
    finishBtn.addEventListener("click", async function(){
      finishBtn.disabled = true;
      try {
        await api("/settings", {method:"PATCH", body:{onboarded:true, language:I18N.lang()}});
        state.settings = Object.assign({}, state.settings, {onboarded:true, language:I18N.lang()});
        await loadGardenData();
      } catch(e){
        finishBtn.disabled = false;
        finishBtn.textContent = tr("Couldn't reach the garden — try again");
        return;
      }
      document.getElementById("app").innerHTML = "";
      state.section = "tasks";
      renderShell();
      subscribeLive();
    });
    card.appendChild(finishBtn);
    return card;
  }

  // ---------------------------------------------------------------
  // PLANT WIZARD — a classic, one-field-per-screen setup wizard shared by
  // onboarding's "Add your plants" step and the dashboard's "+ Add a plant"
  // entry point. Dropdowns wherever the answer is from a fixed set; only
  // Name/Species/Notes stay free text since they're inherently open-ended.
  // Finishes by creating the plant, then handing everything collected
  // (structured answers + photos) to POST /api/plants/:id/build-card, which
  // does the AI work of turning it into a full care card in one call.
  // ---------------------------------------------------------------
  function createWizardState(){
    return {
      step: 0, name:"", type:"other", spot:"", species:"", notes:"",
      age:"", sunExposure:"", watering:"", groundType:"",
      photos: [], plantId: null, building:false, buildError:"", result:null, savedWithoutGuide:""
    };
  }
  function wizardFieldMeta(){
    return [
      {key:"name", question:tr("What's this plant called?"), kind:"text", required:true, placeholder:tr("e.g. Meyer lemon tree")},
      {key:"type", question:tr("What type of plant is it?"), kind:"type"},
      {key:"spot", question:tr("Where in the garden is it?"), kind:"spot"},
      {key:"species", question:tr("Species or variety?"), kind:"text", placeholder:tr("Optional — e.g. Citrus × meyeri")},
      {key:"age", question:tr("About how old is it?"), kind:"select", options:AGE_OPTIONS},
      {key:"sunExposure", question:tr("How much sun does that spot get?"), kind:"select", options:SUN_OPTIONS},
      {key:"watering", question:tr("How do you water it?"), kind:"select", options:WATERING_OPTIONS},
      {key:"groundType", question:tr("What's the ground like there?"), kind:"select", options:GROUND_OPTIONS},
      {key:"notes", question:tr("Anything else worth noting?"), kind:"textarea", placeholder:tr("Optional")}
    ];
  }
  function wizardTotalSteps(){ return wizardFieldMeta().length + 3; } // fields + photos + review + result
  function wizardProgress(step, total){
    var pct = Math.round((Math.min(step,total-1)/(total-1))*100);
    return el("div", {style:"margin-bottom:14px;"}, [
      el("div", {style:"font-size:11.5px;color:var(--ink-faint);margin-bottom:4px;"}, [tr("Step {n} of {total}", {n:Math.min(step,total-1)+1, total:total})]),
      el("div", {class:"grade-track"}, [el("div", {class:"grade-fill", style:"width:" + pct + "%;"})])
    ]);
  }

  function plantWizardCard(wiz, opts){
    var fields = wizardFieldMeta();
    if (wiz.step < fields.length) return wizardFieldStep(wiz, fields[wiz.step], opts);
    if (wiz.step === fields.length) return wizardPhotosStep(wiz, opts);
    if (wiz.step === fields.length + 1) return wizardReviewStep(wiz, opts);
    return wizardResultStep(wiz, opts);
  }

  function wizardFieldStep(wiz, field, opts){
    var card = el("div", {class:"onboard-card card"});
    card.appendChild(wizardProgress(wiz.step, wizardTotalSteps()));
    card.appendChild(el("h2", {style:"font-size:18px;"}, [field.question]));

    var input, spot;
    if (field.kind === "text"){
      input = el("input", {type:"text", placeholder:field.placeholder||"", value:wiz[field.key]||""});
      card.appendChild(el("div", {class:"field"}, [input]));
    } else if (field.kind === "textarea"){
      input = el("textarea", {placeholder:field.placeholder||"", style:"min-height:60px;"});
      input.value = wiz[field.key] || "";
      card.appendChild(el("div", {class:"field"}, [input]));
    } else if (field.kind === "type"){
      input = el("select", {}, typeOptions(wiz.type));
      card.appendChild(el("div", {class:"field"}, [input]));
    } else if (field.kind === "spot"){
      spot = spotPicker(wiz.spot);
      card.appendChild(el("div", {class:"field"}, [spot.select, spot.customInput]));
    } else if (field.kind === "select"){
      input = simpleSelect(field.options, wiz[field.key], tr("Not sure / skip"));
      card.appendChild(el("div", {class:"field"}, [input]));
    }

    var formError = el("div", {class:"empty", style:"margin:2px 0;"});
    card.appendChild(formError);

    function readValue(){
      if (field.kind === "spot") return spot.getValue();
      return input.value.trim();
    }

    var row = el("div", {class:"row", style:"justify-content:space-between;margin-top:14px;"});
    if (wiz.step > 0){
      var backBtn = el("button", {class:"btn btn-ghost"}, [tr("← Back")]);
      backBtn.addEventListener("click", function(){ wiz[field.key] = readValue(); wiz.step--; opts.rerender(); });
      row.appendChild(backBtn);
    } else {
      row.appendChild(el("div", {}));
    }
    var nextBtn = el("button", {class:"btn btn-primary"}, [tr("Next →")]);
    nextBtn.addEventListener("click", function(){
      var val = readValue();
      if (field.required && !val){ formError.textContent = tr("This one's required."); return; }
      wiz[field.key] = val;
      wiz.step++;
      opts.rerender();
    });
    row.appendChild(nextBtn);
    card.appendChild(row);
    return card;
  }

  function wizardPhotosStep(wiz, opts){
    var card = el("div", {class:"onboard-card card"});
    card.appendChild(wizardProgress(wiz.step, wizardTotalSteps()));
    card.appendChild(el("h2", {style:"font-size:18px;"}, [tr("Add a photo or two?")]));
    card.appendChild(el("p", {class:"lead", style:"font-size:13px;"}, [tr("Optional — helps build a more accurate care card and lets me track size and health over time. Up to 3.")]));

    var thumbs = el("div", {style:"display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;"});
    function renderThumbs(){
      thumbs.innerHTML = "";
      wiz.photos.forEach(function(dataUrl, i){
        var wrap = el("div", {style:"position:relative;"});
        wrap.appendChild(el("img", {src:dataUrl, style:"width:72px;height:72px;object-fit:cover;border-radius:8px;display:block;"}));
        var rm = el("button", {class:"btn btn-ghost btn-sm", style:"position:absolute;top:-8px;inset-inline-end:-8px;padding:1px 6px;background:var(--surface);border-radius:50%;"}, ["✕"]);
        rm.addEventListener("click", function(){ wiz.photos.splice(i,1); opts.rerender(); });
        wrap.appendChild(rm);
        thumbs.appendChild(wrap);
      });
    }
    renderThumbs();
    card.appendChild(thumbs);

    if (wiz.photos.length < 3){
      var pick = el("label", {class:"btn btn-sm"}, [tr("+ Add a photo")]);
      var input = el("input", {type:"file", accept:"image/*", class:"sr-only"});
      pick.appendChild(input);
      input.addEventListener("change", async function(){
        var file = input.files[0];
        if (!file) return;
        var dataUrl = await resizeImage(file);
        wiz.photos.push(dataUrl);
        opts.rerender();
      });
      card.appendChild(pick);
    }

    var row = el("div", {class:"row", style:"justify-content:space-between;margin-top:16px;"}, [
      el("button", {class:"btn btn-ghost"}, [tr("← Back")]),
      el("button", {class:"btn btn-primary"}, [tr("Next →")])
    ]);
    row.children[0].addEventListener("click", function(){ wiz.step--; opts.rerender(); });
    row.children[1].addEventListener("click", function(){ wiz.step++; opts.rerender(); });
    card.appendChild(row);
    return card;
  }

  function wizardReviewRow(label, value){
    return value ? el("div", {class:"row", style:"justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line);font-size:13px;"}, [
      el("span", {style:"color:var(--ink-faint);"}, [label]), el("span", {style:"font-weight:600;text-align:end;"}, [value])
    ]) : null;
  }

  function wizardReviewStep(wiz, opts){
    var card = el("div", {class:"onboard-card card"});
    card.appendChild(wizardProgress(wiz.step, wizardTotalSteps()));
    card.appendChild(el("h2", {style:"font-size:18px;"}, [wiz.name ? tr("Ready to build {name}'s card", {name:wiz.name}) : tr("Ready to build this plant's card")]));
    card.appendChild(el("p", {class:"lead", style:"font-size:13px;"}, [tr("Double-check what you've entered, then I'll put together its care guide.")]));

    var list = el("div", {style:"margin-bottom:12px;"});
    [[tr("Name"),wiz.name],[tr("Type"),typeLabel(wiz.type)],[tr("Spot"),optLabel(wiz.spot)],[tr("Species"),wiz.species],
     [tr("Age"),optLabel(wiz.age)],[tr("Sun exposure"),optLabel(wiz.sunExposure)],[tr("Watering"),optLabel(wiz.watering)],[tr("Ground"),optLabel(wiz.groundType)],
     [tr("Notes"),wiz.notes]].forEach(function(pair){
      var row = wizardReviewRow(pair[0], pair[1]);
      if (row) list.appendChild(row);
    });
    card.appendChild(list);
    if (wiz.photos.length){
      var pw = el("div", {style:"display:flex;gap:8px;margin-bottom:12px;"});
      wiz.photos.forEach(function(dataUrl){ pw.appendChild(el("img", {src:dataUrl, style:"width:56px;height:56px;object-fit:cover;border-radius:8px;"})); });
      card.appendChild(pw);
    }

    // Same rule as the plant page: the care guide needs the spot details.
    // Without them the plant is still saved, just without a guide yet.
    var wizReady = careReadiness({spot:wiz.spot, plantDetails:{sunExposure:wiz.sunExposure, watering:wiz.watering, groundType:wiz.groundType}});
    if (!wizReady.ready){
      card.appendChild(el("div", {class:"about-locked", style:"margin-bottom:12px;"}, [
        el("span", {"aria-hidden":"true"}, ["🔒"]),
        el("span", {}, [tr("I'll need {missing} before I can write its care guide. You can save it now and add those from its page later — or go back and fill them in.", {missing:missingLabelList(wizReady.missing)})])
      ]));
    }

    if (wiz.buildError) card.appendChild(el("div", {class:"empty", style:"margin-bottom:8px;"}, [wiz.buildError]));

    var row = el("div", {class:"row", style:"justify-content:space-between;margin-top:6px;"});
    var backBtn = el("button", {class:"btn btn-ghost"}, [tr("← Back")]);
    backBtn.addEventListener("click", function(){ wiz.step--; opts.rerender(); });
    var buildBtn = el("button", {class:"btn btn-primary"}, [wiz.building ? (wizReady.ready ? tr("Building…") : tr("Saving…")) : (wizReady.ready ? tr("Build my plant card →") : tr("Save plant →"))]);
    buildBtn.disabled = wiz.building;
    buildBtn.addEventListener("click", async function(){
      wiz.building = true; wiz.buildError = ""; opts.rerender();
      if (!wizReady.ready){
        try {
          var saved = wiz.plantId ? {id:wiz.plantId} : await api("/plants", {method:"POST", body:{
            name: wiz.name, type: wiz.type||"other", spot: wiz.spot||"", species: wiz.species||"", notes: wiz.notes||""
          }});
          wiz.plantId = saved.id;
          var answers = [["age",wiz.age],["sunExposure",wiz.sunExposure],["watering",wiz.watering],["groundType",wiz.groundType]].filter(function(a){ return a[1]; });
          for (var ai=0; ai<answers.length; ai++){
            saved = await api("/plants/" + wiz.plantId + "/details", {method:"POST", body:{key:answers[ai][0], rawText:answers[ai][1], clean:true}});
          }
          // Photos go through the normal photo pipeline (saved even if
          // analysis isn't available).
          for (var pi=0; pi<wiz.photos.length; pi++){
            try { await api("/plants/" + wiz.plantId + "/photo", {method:"POST", body:{dataUrl:wiz.photos[pi], note:""}}); } catch(e){}
          }
          wiz.result = saved; wiz.savedWithoutGuide = missingLabelList(wizReady.missing);
          wiz.building = false;
          if (opts.onAdded) opts.onAdded();
          wiz.step++;
          opts.rerender();
        } catch(e){
          wiz.building = false;
          wiz.buildError = tr("Couldn't save this plant — try again.");
          opts.rerender();
        }
        return;
      }
      try {
        var created = wiz.plantId ? {id:wiz.plantId} : await api("/plants", {method:"POST", body:{
          name: wiz.name, type: wiz.type||"other", spot: wiz.spot||"", species: wiz.species||"", notes: wiz.notes||""
        }});
        wiz.plantId = created.id;
        var details = [];
        if (wiz.age) details.push({key:"age", label:wiz.age});
        if (wiz.sunExposure) details.push({key:"sunExposure", label:wiz.sunExposure});
        if (wiz.watering) details.push({key:"watering", label:wiz.watering});
        if (wiz.groundType) details.push({key:"groundType", label:wiz.groundType});
        var built = await api("/plants/" + wiz.plantId + "/build-card", {method:"POST", body:{details:details, photos:wiz.photos}});
        wiz.result = built;
        wiz.building = false;
        if (opts.onAdded) opts.onAdded();
        wiz.step++;
        opts.rerender();
      } catch(e){
        wiz.building = false;
        wiz.buildError = wiz.plantId
          ? tr("Saved, but couldn't build the care card just now — try again.")
          : tr("Couldn't save this plant — try again.");
        opts.rerender();
      }
    });
    row.appendChild(backBtn);
    row.appendChild(buildBtn);
    card.appendChild(row);
    return card;
  }

  function wizardResultStep(wiz, opts){
    var card = el("div", {class:"onboard-card card"});
    var plant = wiz.result || {};
    var ok = plant && plant.careProfile;
    card.appendChild(el("h2", {style:"font-size:18px;"}, [ok ? tr("{name}'s card is ready", {name:wiz.name}) : tr("{name} is saved", {name:wiz.name})]));
    if (wiz.savedWithoutGuide){
      card.appendChild(el("p", {class:"lead"}, [tr("🔒 Its care guide unlocks once you add {missing} — open {name} from My garden and tap “Care guide”.", {missing:wiz.savedWithoutGuide, name:wiz.name})]));
    } else if (ok){
      var cg = el("dl", {class:"care-grid", style:"margin-bottom:6px;"});
      [["soil",tr("Soil")],["sun",tr("Sun")],["watering",tr("Watering")],["pruning",tr("Pruning")]].forEach(function(f){
        if (plant.careProfile[f[0]]) cg.appendChild(el("div", {}, [el("dt",{},[f[1]]), el("dd",{},[plant.careProfile[f[0]]])]));
      });
      card.appendChild(cg);
      if (plant.sizeInfo || plant.healthStatus === "needs_attention"){
        card.appendChild(el("div", {class:"agent-note", style:"margin-top:8px;"}, [
          (plant.sizeInfo ? plant.sizeInfo + ". " : "") + (plant.photos && plant.photos.length && plant.photos[plant.photos.length-1].summary || "")
        ]));
      }
    } else {
      card.appendChild(el("p", {class:"lead"}, [tr("Saved — I couldn't finish building the care card just now, but you can retry anytime from its Care guide tab.")]));
    }

    var row = el("div", {class:"row", style:"justify-content:space-between;margin-top:16px;"});
    var addAnotherBtn = el("button", {class:"btn btn-ghost"}, [tr("+ Add another plant")]);
    addAnotherBtn.addEventListener("click", function(){
      var fresh = createWizardState();
      Object.keys(fresh).forEach(function(k){ wiz[k] = fresh[k]; });
      opts.rerender();
    });
    var doneBtn = el("button", {class:"btn btn-primary"}, [tr("Done")]);
    doneBtn.addEventListener("click", function(){ opts.onExit(); });
    row.appendChild(addAnotherBtn);
    row.appendChild(doneBtn);
    card.appendChild(row);
    return card;
  }

  // Dashboard entry point — same wizard, shown in a modal.
  function openPlantWizard(){
    var wiz = createWizardState();
    function rerenderModal(){
      showModal(function(container){
        container.appendChild(el("div", {class:"modal-head"}, [
          el("h3", {}, [tr("Add a plant")]),
          el("button", {class:"modal-close", "aria-label":tr("Close"), onclick:closeModal}, ["×"])
        ]));
        container.appendChild(plantWizardCard(wiz, {
          rerender: rerenderModal,
          onExit: async function(){ try { await loadGardenData(); } catch(e){} closeModal(); }
        }));
      });
    }
    rerenderModal();
  }

  // ---------------------------------------------------------------
  // Plant status + research — server-side now.
  //
  // applyIssueDiagnosis / savePlantPhotoOnly live in lib/issue-diagnosis.js,
  // the photo prompt in lib/plant-photo.js, the "report a problem" prompt in
  // api/plants/[id]/issue.js, and researchPlant / materializeScheduledTasks-
  // ForYear in api/plants/[id]/research.js + lib/schedule.js. These client
  // functions keep the original names and return shapes so the screens
  // below are unchanged.
  // ---------------------------------------------------------------

  // Returns the diagnosis result ({summary, healthStatus, issues, ...}), a
  // result with __photoOnly:true when the photo was saved without analysis,
  // or null on failure. lastAnalysisMessage says why when there's no
  // diagnosis.
  async function analyzeAndApplyPlantPhoto(dataUrl, plant, userNote){
    lastAnalysisMessage = null;
    var r;
    try {
      r = await api("/plants/" + plant.id + "/photo", {method:"POST", body:{dataUrl:dataUrl, note:userNote || ""}});
    } catch(e){
      lastAnalysisMessage = ANALYZE_FAILED_MESSAGE;
      return null;
    }
    if (r && r.__photoOnly && r.result){
      lastAnalysisMessage = r.error ? ANALYZE_FAILED_PHOTO_KEPT_MESSAGE : PHOTO_ONLY_MESSAGE;
      return r.result;
    }
    if (!r || r.error || !r.result){
      lastAnalysisMessage = ANALYZE_FAILED_MESSAGE;
      return null;
    }
    return r.result;
  }

  // Counterpart to analyzeAndApplyPlantPhoto, for the "Report a problem"
  // button — description and/or photo (at least one required). Same
  // diagnosis→task pipeline server-side either way.
  async function reportPlantIssue(plant, description, photoDataUrl){
    lastAnalysisMessage = null;
    var hasText = !!(description && description.trim());
    if (!hasText && !photoDataUrl) return null;
    var r;
    try {
      r = await api("/plants/" + plant.id + "/issue", {method:"POST", body:{description: description || "", dataUrl: photoDataUrl || null}});
    } catch(e){
      lastAnalysisMessage = ANALYZE_FAILED_MESSAGE;
      return null;
    }
    if (!r || r.error || !r.result){
      lastAnalysisMessage = (r && r.photoSaved) ? ANALYZE_FAILED_PHOTO_KEPT_MESSAGE : ANALYZE_FAILED_MESSAGE;
      return null;
    }
    return r.result;
  }

  // Species-level research (care guide + yearly schedule). The server
  // carries forward completed (lastDone) schedule entries on a re-research.
  // Resolves true/false, never throws — same contract as the original.
  async function researchPlant(plantId){
    try {
      var r = await api("/plants/" + plantId + "/research", {method:"POST", body:{}});
      return !!(r && r.researched === true && !r.error);
    } catch(e){ return false; }
  }

  // ---- What we know about a plant ----
  // A care guide is built for *this* plant, so it needs to know about its
  // spot, not just its species. These four are required before "Build care
  // guide" unlocks ("Not sure" counts as answered — the guide then falls
  // back to general advice for that part). Species and a photo are
  // optional extras that make it sharper.
  var READINESS_FIELDS = [
    {key:"spot",        label:N_("Where it's planted"), todo:N_("tell me where it's planted"), btn:N_("Add its spot")},
    {key:"sunExposure", label:N_("Sun exposure"),       todo:N_("add its sun exposure"),       btn:N_("Add sun exposure")},
    {key:"watering",    label:N_("How it's watered"),   todo:N_("add how it's watered"),       btn:N_("Add watering")},
    {key:"groundType",  label:N_("Soil / ground"),      todo:N_("add its soil type"),          btn:N_("Add soil type")}
  ];
  function plantFieldValue(p, key){
    if (key === "spot") return p.spot || "";
    if (key === "species") return p.species || "";
    var entry = detailEntryOf(p, key);
    return entry ? (entry.display || entry.raw || "") : "";
  }
  function isNotSure(v){ return /^not sure/i.test(v || ""); }
  function careReadiness(p){
    var items = READINESS_FIELDS.map(function(f){
      var v = plantFieldValue(p, f.key);
      return {key:f.key, label:tr(f.label), todo:tr(f.todo), btn:tr(f.btn), value:v, done:!!v};
    });
    var missing = items.filter(function(i){ return !i.done; });
    return {items:items, missing:missing, done:items.length - missing.length, total:items.length, ready:missing.length === 0};
  }
  // "sun exposure and soil / ground" — readable list of missing labels.
  function missingLabelList(missing){
    var names = missing.map(function(m){ return I18N.isRTL() ? m.label : m.label.charAt(0).toLowerCase() + m.label.slice(1); });
    if (names.length <= 1) return names.join("");
    return tr("{list} and {last}", {list:names.slice(0, -1).join(", "), last:names[names.length-1]});
  }

  // How well the app knows a plant, 0–100 — driven by what the gardener has
  // actually told it: the four spot details + age (10 each, 5 for "Not
  // sure"), species (5), a care guide (25), a photo (15) and a recent photo
  // (5). `missing` lists what would raise it, most useful first: the
  // details that unlock the care guide, then the guide itself, then photos,
  // age and species.
  function plantKnowledge(p){
    var score = 0, missing = [];
    var readiness = careReadiness(p);
    readiness.items.forEach(function(i){
      if (!i.done) missing.push({key:i.key, text:i.todo, btn:i.btn, unlocks:true});
      else score += isNotSure(i.value) ? 5 : 10;
    });
    var hasGuide = !!(p.researched && p.careProfile);
    if (hasGuide) score += 25;
    else if (readiness.ready) missing.push({key:"guide", text:tr("build its care guide")});
    var photos = p.photos || [];
    if (photos.length){
      score += 15;
      var days = (Date.now() - new Date(photos[photos.length-1].date).getTime()) / 86400000;
      if (days <= 28) score += 5;
    } else missing.push({key:"photo", text:tr("add a photo")});
    var age = plantFieldValue(p, "age");
    if (age) score += isNotSure(age) ? 5 : 10; else missing.push({key:"age", text:tr("add its age")});
    if (p.species) score += 5; else missing.push({key:"species", text:tr("add its species or variety")});
    if (photos.length && days > 28) missing.push({key:"photo", text:tr("add a fresh photo")});
    return {score:Math.min(100, score), missing:missing, reasons:missing.map(function(m){ return m.text; })};
  }
  function gradeLabelFor(score){ return score>=80 ? tr("Well known") : (score>=50 ? tr("Getting there") : tr("Still learning")); }

  // ---- Quick answer: one question, answered by tapping an option chip
  // (or "Other…" for free text). Used by the care-guide checklist, the
  // level "next step" and the profile's Add/Edit buttons. opts.chain walks
  // through every still-missing care-guide detail in a row. ----
  var QUICK_FIELDS = {
    spot:        {q:N_("Where in the garden is it?"), options:function(){ return SPOT_OPTIONS; }, other:N_("Describe the spot")},
    sunExposure: {q:N_("How much sun does that spot get?"), options:function(){ return SUN_OPTIONS; }, other:N_("e.g. morning sun, shade after 2pm")},
    watering:    {q:N_("How do you water it?"), options:function(){ return WATERING_OPTIONS; }, other:N_("e.g. drip twice a week")},
    groundType:  {q:N_("What's the ground like there?"), options:function(){ return GROUND_OPTIONS; }, other:N_("e.g. rocky clay, mulched")},
    age:         {q:N_("About how old is it?"), options:function(){ return AGE_OPTIONS; }, other:N_("e.g. planted spring 2021")},
    species:     {q:N_("What species or variety is it?"), options:null, other:N_("e.g. Hass avocado, Citrus × meyeri")}
  };
  async function saveQuickAnswer(p, key, value, fromOption){
    if (key === "spot" || key === "species"){
      var patch = {}; patch[key] = value;
      await api("/plants/" + p.id, {method:"PATCH", body:patch});
    } else {
      await api("/plants/" + p.id + "/details", {method:"POST", body:{key:key, rawText:value, clean:!!fromOption}});
    }
    await loadGardenData();
    return state.plants.find(function(x){ return x.id === p.id; }) || p;
  }
  function openQuickAnswer(p, key, opts){
    opts = opts || {};
    var field = QUICK_FIELDS[key];
    if (!field) return;
    var current = plantFieldValue(p, key);
    showModal(function(container){
      container.appendChild(el("div", {class:"modal-head"}, [
        el("h3", {style:"font-size:17px;"}, [p.name]),
        el("button", {class:"modal-close", "aria-label":tr("Close"), onclick:closeModal}, ["×"])
      ]));
      var backBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-bottom:10px;"}, [tr("← Back to plant")]);
      backBtn.addEventListener("click", function(){ openPlantDetail(p.id, {keepTab:true}); });
      container.appendChild(backBtn);
      if (opts.chain && opts.chainTotal > 1){
        container.appendChild(el("div", {class:"onboard-step-label"}, [tr("Care guide details · {n} of {total}", {n:opts.chainIndex, total:opts.chainTotal})]));
      }
      container.appendChild(el("h2", {style:"font-size:19px;margin:2px 0 14px;"}, [tr(field.q)]));
      var status = el("div", {class:"thinking", style:"min-height:20px;margin-top:8px;"});

      async function commit(value, fromOption){
        value = String(value || "").trim();
        if (!value) return;
        container.querySelectorAll("button, input").forEach(function(b){ b.disabled = true; });
        status.textContent = tr("Saving…");
        var fresh;
        try { fresh = await saveQuickAnswer(p, key, value, fromOption); }
        catch(e){
          container.querySelectorAll("button, input").forEach(function(b){ b.disabled = false; });
          status.textContent = tr("Couldn't save — try again.");
          return;
        }
        buzz();
        if (opts.chain){
          var next = careReadiness(fresh).missing[0];
          if (next){ openQuickAnswer(fresh, next.key, {chain:true, chainIndex:(opts.chainIndex||1) + 1, chainTotal:opts.chainTotal}); return; }
        }
        var r = careReadiness(fresh);
        if (r.ready && !(fresh.researched && fresh.careProfile) && READINESS_FIELDS.some(function(f){ return f.key === key; })){
          plantDetailTab = "care";
          showToast(tr("✨ Care guide unlocked — ready to build!"));
        } else {
          showToast(tr("Saved"));
        }
        openPlantDetail(fresh.id, {keepTab:true});
      }

      var otherInput = el("input", {type:"text", placeholder:tr(field.other), value: current && (!field.options || field.options().indexOf(current) === -1) ? current : ""});
      var otherSave = el("button", {class:"btn btn-primary"}, [tr("Save")]);
      otherSave.addEventListener("click", function(){ commit(otherInput.value, false); });
      otherInput.addEventListener("keydown", function(e){ if (e.key === "Enter"){ e.preventDefault(); commit(otherInput.value, false); } });
      var otherRow = el("div", {class:"row", style:"gap:8px;flex-wrap:nowrap;margin-top:12px;"}, [el("div", {style:"flex:1;"}, [otherInput]), otherSave]);

      if (field.options){
        var chips = el("div", {class:"option-chips"});
        field.options().forEach(function(o){
          var chip = el("button", {class:"option-chip" + (o === current ? " active" : "")}, [tr(o)]);
          chip.addEventListener("click", function(){ commit(o, true); });
          chips.appendChild(chip);
        });
        var otherChip = el("button", {class:"option-chip" + (otherInput.value ? " active" : "")}, [tr("Other…")]);
        otherChip.addEventListener("click", function(){ otherRow.hidden = false; otherInput.focus(); });
        chips.appendChild(otherChip);
        container.appendChild(chips);
        otherRow.hidden = !otherInput.value;
      }
      container.appendChild(otherRow);
      container.appendChild(status);
      if (!field.options) setTimeout(function(){ otherInput.focus(); }, 50);
    });
  }

  // ---- The care-guide readiness card: a 4-step meter, a checklist of what
  // the guide needs (tap any row to fill it in), and the Build button —
  // locked and greyed until all four are answered, with a line saying
  // exactly what's still missing. ----
  function careReadinessCard(p){
    var r = careReadiness(p);
    var card = el("div", {class:"ready-card" + (r.ready ? " is-ready" : "")});
    card.appendChild(el("div", {class:"ready-head"}, [
      el("span", {class:"ready-icon", "aria-hidden":"true"}, [r.ready ? "✨" : "🔒"]),
      el("div", {}, [
        el("div", {class:"ready-title"}, [r.ready ? tr("Ready for a care guide") : tr("Care guide locked")]),
        el("div", {class:"ready-sub"}, [r.ready
          ? tr("I know enough about its spot to write a guide for your garden, not just the species.")
          : trn(r.missing.length, "A good guide depends on where it grows. Tell me 1 more thing to unlock it.", "A good guide depends on where it grows. Tell me {n} more things to unlock it.")])
      ])
    ]));
    var meter = el("div", {class:"ready-meter", role:"img", "aria-label": tr("{n} of {total} details added", {n:r.done, total:r.total})});
    r.items.forEach(function(i){ meter.appendChild(el("span", {class:i.done ? "on" : ""})); });
    card.appendChild(el("div", {class:"ready-meter-row"}, [meter, el("span", {class:"ready-count"}, [tr("{n} of {total}", {n:r.done, total:r.total})])]));

    var list = el("div", {class:"ready-list"});
    function row(item, optional){
      var b = el("button", {class:"ready-item" + (item.done ? " done" : "")}, [
        el("span", {class:"ready-check", "aria-hidden":"true", html: item.done ? icon("check") : ""}),
        el("span", {class:"ready-label"}, [item.label, optional ? el("span", {class:"ready-opt"}, [" · " + tr("optional")]) : null]),
        el("span", {class:"ready-value"}, [item.done ? optLabel(item.value) : (optional ? tr("Add") : tr("Add →"))])
      ]);
      b.addEventListener("click", function(){
        if (item.key === "photo"){ plantDetailTab = "overview"; openPlantDetail(p.id, {keepTab:true}); var inp = document.querySelector("#modalContent .overview-photo-input"); if (inp) inp.click(); }
        else openQuickAnswer(p, item.key);
      });
      list.appendChild(b);
    }
    r.items.forEach(function(i){ row(i, false); });
    row({key:"species", label:tr("Species or variety"), value:p.species || "", done:!!p.species}, true);
    var nPhotos = (p.photos || []).length;
    row({key:"photo", label:tr("A photo"), value: nPhotos ? trn(nPhotos, "1 photo", "{n} photos") : "", done: nPhotos > 0}, true);
    card.appendChild(list);

    var buildBtn = el("button", {class:"btn " + (r.ready ? "btn-primary" : "btn-locked"), "aria-label": r.ready ? null : tr("Build care guide — locked. Add {missing} first.", {missing:missingLabelList(r.missing)})}, [r.ready ? tr("✨ Build care guide") : tr("🔒 Build care guide")]);
    var note = el("div", {class:"ready-note"}, [r.ready ? tr("Takes about half a minute.") : tr("Add {missing} to unlock.", {missing:missingLabelList(r.missing)})]);
    buildBtn.addEventListener("click", async function(){
      if (!r.ready){
        // Locked: jump straight into filling what's missing.
        openQuickAnswer(p, r.missing[0].key, {chain:true, chainIndex:1, chainTotal:r.missing.length});
        return;
      }
      buildBtn.disabled = true; buildBtn.textContent = tr("Building…");
      note.textContent = tr("Writing a guide for {name}…", {name:p.name});
      var ok = await researchPlant(p.id);
      if (ok){
        await loadGardenData();
        buzz(15); showToast(tr("🌿 Care guide ready for {name}", {name:p.name}));
        plantDetailTab = "care";
        openPlantDetail(p.id, {keepTab:true});
      } else {
        buildBtn.disabled = false; buildBtn.textContent = tr("✨ Build care guide");
        note.textContent = tr("Couldn't build it just now — try again in a moment.");
      }
    });
    card.appendChild(el("div", {class:"ready-foot"}, [buildBtn, note]));
    if (r.missing.length > 1){
      var fill = el("button", {class:"link-btn", style:"margin-top:8px;"}, [tr("Answer the {n} missing questions →", {n:r.missing.length})]);
      fill.addEventListener("click", function(){ openQuickAnswer(p, r.missing[0].key, {chain:true, chainIndex:1, chainTotal:r.missing.length}); });
      card.appendChild(fill);
    }
    return card;
  }

  // ---------------------------------------------------------------
  // DASHBOARD
  // ---------------------------------------------------------------
  var modalOpenFor = null;

  // state.section drives which app section (Home/Tasks/My garden/
  // Calendar) is showing; renderShell() rebuilds the whole shell (topbar +
  // tab bar + the active section) every time it's called, same "full
  // re-render on any state change" approach the rest of the app already uses.
  // tr() for a sentence with an element inside it ("needs <b>3 things</b>
  // today"): returns its pieces, [text, node, text, ...], for el().
  function trParts(s, vars){
    return tr(s).split(/(\{\w+\})/).map(function(part){
      var m = /^\{(\w+)\}$/.exec(part);
      if (!m || !(m[1] in vars)) return part;
      var v = vars[m[1]];
      return (v && v.nodeType) ? v : String(v);
    }).filter(function(x){ return x !== ""; });
  }

  // index.html's own text (the Ask panel, the page title).
  function applyStaticText(){
    document.title = tr("Garden Companion");
    var boot = document.querySelector("#boot .onboard-card");
    if (boot && !document.getElementById("boot").hidden && !boot.querySelector("h2")) boot.textContent = tr("Opening the garden…");
    var fab = document.getElementById("askFab");
    fab.setAttribute("aria-label", tr("Ask your gardener"));
    fab.querySelector(".ask-fab-label").textContent = tr("Ask your gardener");
    document.querySelector("#askPanel .ask-head strong").textContent = tr("Ask your gardener");
    document.getElementById("askClose").setAttribute("aria-label", tr("Close"));
    document.getElementById("askInput").placeholder = tr("How's my tomato looking this week?");
    document.getElementById("askSend").textContent = tr("Send");
  }

  function renderShell(){
    var app = document.getElementById("app");
    // Horizontal scrollers (garden row, tips, library shelves) keep their
    // position across the full re-render, so the 45-second live refresh
    // doesn't yank a row back to the start mid-browse.
    var keptScroll = {};
    app.querySelectorAll("[data-keep-scroll]").forEach(function(n){ keptScroll[n.getAttribute("data-keep-scroll")] = n.scrollLeft; });
    app.innerHTML = "";
    var shell = el("div", {class:"shell"});

    var gearBtn = el("button", {class:"btn btn-ghost icon-btn gear-btn", title:tr("Settings"), "aria-label":tr("Settings"), onclick:openSettings}, [el("span", {html:icon("gear")})]);
    shell.appendChild(el("div", {class:"topbar"}, [
      el("div", {class:"brand"}, [el("span", {class:"mark", html:icon("leaf")}), el("h1", {}, [tr("Garden Companion")])]),
      gearBtn
    ]));

    shell.appendChild(sectionTabBar());

    if (state.section === "library") shell.appendChild(librarySection());
    else if (state.section === "calendar") shell.appendChild(calendarSection());
    else if (state.section === "tasklist") shell.appendChild(taskListScreen());
    else shell.appendChild(tasksHomeSection());

    app.appendChild(shell);
    app.querySelectorAll("[data-keep-scroll]").forEach(function(n){
      var k = n.getAttribute("data-keep-scroll");
      if (keptScroll[k]) n.scrollLeft = keptScroll[k];
    });
    document.getElementById("askFab").hidden = false;
  }

  // True while the user is in the middle of something a background
  // re-render would wreck: typing in a field, or dragging a task row.
  var swipeActive = false;
  function userIsBusy(){
    if (swipeActive) return true;
    var a = document.activeElement;
    return !!(a && document.getElementById("app").contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }

  function sectionTabBar(){
    // "tasks" is the Home dashboard (the key predates the separate Tasks
    // screen, which is "tasklist").
    var tabs = [["tasks",tr("Home"),"home"], ["tasklist",tr("Tasks"),"tasks"], ["library",tr("My garden"),"seedling"], ["calendar",tr("Calendar"),"calendar"]];
    var wrap = el("nav", {class:"tab-bar", "aria-label":tr("Sections")});
    // App-icon style counts: overdue tasks on Tasks, plants that need
    // something on My garden.
    var today = todayISO();
    var tabBadges = {
      tasklist: state.tasks.filter(function(t){ return t.status !== "done" && t.dueDate && t.dueDate < today; }).length,
      library: state.plants.filter(function(p){ return plantAlerts(p).count > 0; }).length
    };
    tabs.forEach(function(t){
      var btn = el("button", {class:"tab-btn" + (state.section===t[0] ? " active" : ""), "aria-current": state.section===t[0] ? "page" : null}, [
        el("span", {class:"tab-icon"}, [el("span", {class:"icon", html:icon(t[2])}), countBadge(tabBadges[t[0]] || 0, "tab-badge")]), t[1]
      ]);
      btn.addEventListener("click", function(){
        if (state.section === t[0]) { window.scrollTo({top:0, behavior:"smooth"}); return; }
        state.section = t[0];
        renderShell();
        window.scrollTo(0, 0);
        // Refresh in the background so switching tabs shows current data
        // without blocking the tab switch itself on a network round trip.
        loadGardenData().then(function(){ if (state.section === t[0] && !modalOpenFor && !userIsBusy()) renderShell(); }).catch(function(){});
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function tasksHomeSection(){
    var wrap = el("div", {});
    wrap.appendChild(heroCard());
    var garden = gardenRow();
    if (garden) wrap.appendChild(garden);
    var tips = tipsSection();
    if (tips) wrap.appendChild(tips);
    wrap.appendChild(tasksSection(thisWeekTasks()));
    wrap.appendChild(upcomingSection(upcomingTasks()));
    var doneRecent = state.tasks.filter(function(t){ return t.status === "done"; })
      .sort(function(a,b){ return String(b.completedAt||"").localeCompare(String(a.completedAt||"")); }).slice(0,6);
    if (doneRecent.length) wrap.appendChild(doneSection(doneRecent));
    return wrap;
  }

  // ---- Hero: greeting, what today needs, the week's progress ring, and
  // the weather (with a plain-language "so what" line). Its background
  // follows the sky: sunny / cloudy / rainy / night. ----
  function weekProgress(){
    var week = weekDatesFor(new Date());
    var from = isoDate(week[0].getFullYear(), week[0].getMonth()+1, week[0].getDate());
    var to = isoDate(week[6].getFullYear(), week[6].getMonth()+1, week[6].getDate());
    var inWeek = state.tasks.filter(function(t){ return t.dueDate && t.dueDate >= from && t.dueDate <= to; });
    return {done: inWeek.filter(function(t){ return t.status === "done"; }).length, total: inWeek.length};
  }
  function progressRing(done, total){
    var r = 30, c = 2 * Math.PI * r, frac = total ? done / total : 0;
    var ringLabel = tr("{done} of {total} tasks done this week", {done:done, total:total});
    var ring = el("div", {class:"ring", title: ringLabel, role:"img", "aria-label": ringLabel});
    ring.innerHTML = '<svg viewBox="0 0 72 72"><circle class="ring-track" cx="36" cy="36" r="' + r + '" fill="none" stroke-width="7"/>' +
      '<circle class="ring-fill" cx="36" cy="36" r="' + r + '" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - frac)).toFixed(1) + '"/></svg>';
    ring.appendChild(el("div", {class:"ring-label"}, [el("b", {dir:"ltr"}, [done + "/" + total]), el("span", {}, [tr("done")])]));
    return ring;
  }
  function weatherAdvice(w){
    if (!w) return null;
    var hi = parseInt((String(w.tempLabel || "").match(/-?\d+/) || [])[0], 10);
    var rain = parseInt((String(w.forecast || "").match(/(\d+)% chance of rain/) || [])[1], 10);
    if (rain >= 50) return ["🌧️", tr("Rain likely — you can probably skip watering today.")];
    if (hi >= 33) return ["🥵", tr("A hot one — water early morning or in the evening, not midday.")];
    if (hi <= 4) return ["🧣", tr("Chilly — keep an eye on tender plants tonight.")];
    if (/breezy/i.test(w.forecast || "")) return ["💨", tr("Breezy — worth checking stakes on tall plants.")];
    return ["🌿", tr("Good weather to get out in the garden.")];
  }
  // The server's forecast line (lib/weather.js) is a fixed set of English
  // phrases; shown translated.
  var FORECAST_PHRASES = [N_("Breezy, light chance of rain"), N_("Breezy and dry"), N_("Mostly dry, light chance of rain"), N_("Clear and mild")];
  function forecastLabel(f){
    var m = /^(\d+)% chance of rain$/.exec(f || "");
    return m ? tr("{n}% chance of rain", {n:m[1]}) : (f ? tr(f) : "");
  }
  function heroCard(){
    var now = new Date(), hour = now.getHours();
    var greet = hour < 5 ? tr("Good night") : hour < 12 ? tr("Good morning") : hour < 17 ? tr("Good afternoon") : tr("Good evening");
    var w = state.weather;
    var sky = weatherIconFor(w && (w.summary || w.forecast));
    var night = hour >= 19 || hour < 6;
    var theme = sky === "rain" ? "hero-rain" : sky === "cloud" ? "hero-cloud" : (night ? "hero-night" : "hero-sun");

    var today = todayISO();
    var open = state.tasks.filter(function(t){ return t.status !== "done" && t.dueDate; });
    var overdue = open.filter(function(t){ return t.dueDate < today; }).length;
    var dueToday = open.filter(function(t){ return t.dueDate === today; }).length;
    var laterThisWeek = open.filter(function(t){ var n = daysFromToday(t.dueDate); return n > 0 && n < 7; }).length;
    var needNow = overdue + dueToday;
    var sub;
    if (needNow > 0){
      sub = el("div", {class:"hero-sub"}, trParts(overdue ? N_("Your garden needs {count} today ({overdue} to catch up on).") : N_("Your garden needs {count} today."),
        {count: el("strong", {}, [trn(needNow, "1 thing", "{n} things")]), overdue: overdue}));
    } else if (laterThisWeek > 0){
      sub = el("div", {class:"hero-sub"}, [tr("Nothing due today — {n} coming up later this week.", {n:laterThisWeek})]);
    } else {
      sub = el("div", {class:"hero-sub"}, [tr("Nothing due — go enjoy your garden 🌿")]);
    }

    var prog = weekProgress();
    var top = el("div", {class:"hero-top"}, [
      el("div", {}, [
        el("div", {class:"hero-date"}, [now.toLocaleDateString(I18N.locale(), {weekday:"long", month:"long", day:"numeric"})]),
        el("h2", {}, [greet]),
        sub
      ]),
      prog.total ? progressRing(prog.done, prog.total) : null
    ]);
    var hero = el("section", {class:"hero " + theme}, [top]);

    var refreshBtn = el("button", {class:"btn btn-ghost btn-sm icon-btn", title:tr("Check weather now"), "aria-label":tr("Refresh weather"), style:"flex:none;"}, [el("span", {html:icon("refresh")})]);
    refreshBtn.addEventListener("click", async function(){
      refreshBtn.disabled = true; refreshBtn.classList.add("spinning");
      try { await refreshWeatherNow(); }
      finally { refreshBtn.disabled = false; refreshBtn.classList.remove("spinning"); }
    });
    var wxIcon = (night && sky === "sun") ? "moon" : sky;
    var wxText = w
      ? el("div", {class:"wx-text"}, [
          el("div", {}, [el("span", {class:"temp", dir:"ltr"}, [w.tempLabel || w.summary || "—"]), " ", el("span", {class:"desc"}, [forecastLabel(w.forecast)])]),
          el("div", {class:"loc"}, [placeLabel(w.locationLabel) + (w.fetchedAt ? " · " + tr("updated {date}", {date:fmtDate(w.fetchedAt)}) : "")])
        ])
      : el("div", {class:"wx-text"}, [
          el("div", {class:"desc"}, [tr("Weather check-in hasn't run yet")]),
          el("div", {class:"loc"}, [tr("Conditions for {place} will show here.", {place: placeLabel((state.settings.location||{}).label) || tr("your garden")})])
        ]);
    hero.appendChild(el("div", {class:"hero-weather"}, [el("span", {class:"icon-lg", html:icon(wxIcon)}), wxText, refreshBtn]));
    if (w && w.alert) hero.appendChild(el("div", {class:"hero-alert chip chip-crit"}, ["⚠︎ " + w.alert]));
    var advice = weatherAdvice(w);
    if (advice) hero.appendChild(el("div", {class:"hero-advice"}, [el("span", {}, [advice[0]]), el("span", {}, [advice[1]])]));
    return hero;
  }

  // ---- "Your plants": a row of plant avatars, the ones needing attention
  // first (with a pulsing ring). Tap one to open it. ----
  function plantAvatar(p){
    var lastPhoto = (p.photos && p.photos.length) ? p.photos[p.photos.length-1] : null;
    var color = plantColorFor(p.id);
    var attn = p.healthStatus === "needs_attention";
    var av = el("span", {class:"avatar" + (attn ? " attn" : ""), style:"--av-bg:color-mix(in srgb, " + color + " 28%, var(--surface));"},
      [lastPhoto ? el("img", {src:lastPhoto.dataUrl, alt:""}) : typeEmoji(p.type)]);
    var n = plantAlerts(p).count;
    var btn = el("button", {class:"avatar-btn", "aria-label": p.name + (n ? " — " + trn(n, "1 needs attention", "{n} need attention") : "")}, [
      el("span", {class:"avatar-wrap"}, [av, countBadge(n, "av-badge")]),
      el("span", {class:"avatar-name"}, [p.name])
    ]);
    btn.addEventListener("click", function(){ openPlantDetail(p.id); });
    return btn;
  }
  function gardenRow(){
    if (state.plants.length === 0){
      var cta = el("div", {class:"card empty-fun", style:"margin-bottom:18px;"}, [
        el("span", {class:"big"}, ["🌱"]),
        el("div", {style:"margin-bottom:12px;"}, [tr("Your garden is empty — add your first plant and I'll build its care guide and schedule.")])
      ]);
      var b = el("button", {class:"btn btn-primary"}, [tr("+ Add your first plant")]);
      b.addEventListener("click", openPlantWizard);
      cta.appendChild(b);
      return cta;
    }
    var plants = state.plants.slice().sort(function(a,b){
      return (b.healthStatus === "needs_attention" ? 1 : 0) - (a.healthStatus === "needs_attention" ? 1 : 0);
    });
    var seeAll = el("button", {class:"link-btn"}, [tr("See all →")]);
    seeAll.addEventListener("click", function(){ state.section = "library"; renderShell(); window.scrollTo(0, 0); });
    var row = el("div", {class:"hscroll", "data-keep-scroll":"garden-row"});
    plants.forEach(function(p){ row.appendChild(plantAvatar(p)); });
    var add = el("button", {class:"avatar-btn", "aria-label":tr("Add a plant")}, [el("span", {class:"avatar add"}, ["+"]), el("span", {class:"avatar-name"}, [tr("Add")])]);
    add.addEventListener("click", openPlantWizard);
    row.appendChild(add);
    return el("section", {}, [
      el("div", {class:"section-title"}, [
        el("h2", {}, [tr("Your plants")]),
        el("span", {class:"hint"}, [seeAll])
      ]),
      row
    ]);
  }

  // ---- Garden tips: seasonal / weather cards (public/js/tips.js), each
  // with a one-tap "Add as task". A tip already added this year shows as
  // added (matched by title against existing tip tasks); "Not now" hides it
  // on this device until next year (weather tips: until tomorrow). ----
  var TIP_DISMISS_KEY = "gc.dismissedTips";
  function tipDismissKey(tip){ return tip.weather ? todayISO() : String(new Date().getFullYear()); }
  function tipAddedTask(tip){
    var year = new Date().getFullYear(), today = todayISO();
    return state.tasks.find(function(t){
      if (t.kind !== "tip" || t.title !== tip.task.title) return false;
      return tip.weather ? (t.createdAt || "").slice(0,10) === today || t.dueDate === today : (t.year === year || (t.dueDate || "") >= today);
    }) || null;
  }
  function isTipHidden(tip){ return localGet(TIP_DISMISS_KEY, {})[tip.id] === tipDismissKey(tip); }
  function setTipHidden(tip, hidden){
    var d = localGet(TIP_DISMISS_KEY, {});
    if (hidden) d[tip.id] = tipDismissKey(tip); else delete d[tip.id];
    localSet(TIP_DISMISS_KEY, d);
  }
  // Seasonal tips come from GET /api/tips?month=N — written by the model for
  // this garden's location, climate and plants, cached server-side per
  // month. tipsByMonth[month0] is {status:"loading"|"ready"|"error", tips}.
  var tipsByMonth = {};
  function loadTips(month0, onDone){
    var entry = tipsByMonth[month0];
    if (entry && entry.status !== "error") { if (entry.status === "ready" && onDone) onDone(); return; }
    tipsByMonth[month0] = {status:"loading", tips:[]};
    api("/tips?month=" + (month0 + 1)).then(function(r){
      tipsByMonth[month0] = {status: r && r.tips && r.tips.length ? "ready" : "error", tips:(r && r.tips) || [], year:r && r.year};
    }).catch(function(){
      tipsByMonth[month0] = {status:"error", tips:[]};
    }).then(function(){ if (onDone) onDone(); });
  }
  function currentTips(){
    var weather = window.GardenTips ? window.GardenTips.weatherTips(state.weather) : [];
    var month = tipsByMonth[new Date().getMonth()];
    return weather.concat(month && month.status === "ready" ? month.tips : []);
  }

  function tipsSection(){
    var m0 = new Date().getMonth();
    var status = tipsByMonth[m0] ? tipsByMonth[m0].status : "loading";
    if (!tipsByMonth[m0]) loadTips(m0, function(){ if (state.section === "tasks" && !modalOpenFor && !userIsBusy()) renderShell(); });
    var all = currentTips();
    if (!all.length){
      if (status === "loading"){
        return el("section", {}, [
          el("div", {class:"section-title"}, [el("h2", {}, [tr("Garden tips")]), el("span", {class:"hint"}, [monthName(m0)])]),
          el("div", {class:"about-locked tips-loading"}, [el("span", {}, ["🌱"]), el("span", {}, [tr("Picking this month's tips for your garden…")])])
        ]);
      }
      return null;
    }
    var visible = all.filter(function(tip){ return !isTipHidden(tip); }).slice(0, 6);
    var seeAll = el("button", {class:"link-btn"}, [tr("All tips ({n}) →", {n:all.length})]);
    seeAll.addEventListener("click", function(){ openAllTips(); });
    var head = el("div", {class:"section-title"}, [el("h2", {}, [tr("Garden tips")]), el("span", {class:"hint"}, [monthName(new Date().getMonth()) + " · ", seeAll])]);
    if (!visible.length){
      // Everything hidden: keep a slim way back to them.
      var again = el("button", {class:"link-btn"}, [tr("See them all →")]);
      again.addEventListener("click", function(){ openAllTips(); });
      return el("section", {}, [head, el("div", {class:"about-locked"}, [el("span", {}, ["💡"]), el("span", {}, [tr("You've hidden this month's tips.") + " "]), again])]);
    }
    var row = el("div", {class:"hscroll", "data-keep-scroll":"tips"});
    visible.forEach(function(tip){ row.appendChild(tipCard(tip)); });
    return el("section", {}, [head, row]);
  }

  // opts.month (0-11): the tip is being browsed for that month (All tips
  // sheet); opts.onChange: repaint callback (defaults to the dashboard);
  // opts.list: full-width layout for the sheet.
  function tipCard(tip, opts){
    opts = opts || {};
    var refresh = opts.onChange || renderShell;
    var hidden = isTipHidden(tip);
    var card = el("article", {class:"tip-card tip-" + (tip.theme || "spring") + (opts.list ? " tip-card-list" : "") + (hidden ? " is-hidden" : "")});
    card.appendChild(el("div", {class:"tip-head"}, [
      el("span", {class:"tip-emoji", "aria-hidden":"true"}, [tip.emoji]),
      el("div", {}, [
        el("div", {class:"tip-kicker"}, [tip.weather ? tr("Weather tip") : (tip.plants && tip.plants.length ? tr("For your {plants}", {plants:tip.plants.join(", ")}) : tr("Seasonal tip")), hidden ? el("span", {class:"chip chip-neutral", style:"margin-inline-start:6px;letter-spacing:0;text-transform:none;"}, [tr("Hidden")]) : null]),
        el("div", {class:"tip-title"}, [tip.title])
      ])
    ]));
    card.appendChild(el("div", {class:"tip-body"}, [tip.body]));
    var actions = el("div", {class:"tip-actions"});
    var added = tipAddedTask(tip);
    if (added){
      actions.appendChild(el("div", {class:"tip-added"}, [el("span", {html:icon("check")}), tr("In your tasks · {when}", {when:relativeDay(added.dueDate)})]));
    } else {
      var addBtn = el("button", {class:"btn btn-primary btn-sm"}, [tr("+ Add as task")]);
      addBtn.addEventListener("click", function(){ addTipAsTask(tip, addBtn, {month:opts.month, onChange:refresh}); });
      actions.appendChild(addBtn);
    }
    if (hidden){
      var show = el("button", {class:"btn btn-ghost btn-sm"}, [tr("Show on Home")]);
      show.addEventListener("click", function(){ setTipHidden(tip, false); refresh(); showToast(tr("Tip is back on Home")); });
      actions.appendChild(show);
    } else if (!added && opts.month === undefined){
      var notNow = el("button", {class:"btn btn-ghost btn-sm"}, [tr("Not now")]);
      notNow.addEventListener("click", function(){
        setTipHidden(tip, true);
        refresh();
        showToast(tr("Tip hidden — find it under All tips"), {label:tr("Undo"), fn:function(){ setTipHidden(tip, false); refresh(); }});
      });
      actions.appendChild(notNow);
    }
    card.appendChild(actions);
    return card;
  }

  // Due date for a tip's task: dueInDays counts from today for this
  // month's tips, and from the 1st of the month for a tip browsed under
  // another month (that month's next occurrence: this year if still ahead,
  // else next year) — the same reference the server gives the model.
  function tipDueDate(tip, month){
    var now = new Date();
    if (month === undefined || month === now.getMonth()) return addDays(todayISO(), tip.task.dueInDays || 0);
    var year = month > now.getMonth() ? now.getFullYear() : now.getFullYear() + 1;
    return addDays(isoDate(year, month + 1, 1), tip.task.dueInDays || 0);
  }
  async function addTipAsTask(tip, btn, opts){
    opts = opts || {};
    btn.disabled = true; btn.textContent = tr("Adding…");
    var due = tipDueDate(tip, opts.month);
    try {
      var created = await api("/tasks", {method:"POST", body:{
        title: tip.task.title, description: tip.task.description || tip.body, dueDate: due,
        kind: "tip", reason: "Garden tip", severity: "info", year: new Date(due + "T00:00:00").getFullYear()
      }});
      if (created) state.tasks.push(created);
    } catch(e){
      btn.disabled = false; btn.textContent = tr("Couldn't add — try again");
      return;
    }
    buzz(); leafBurst(btn);
    showToast(tr("Added to your tasks — due {when}", {when:relativeDay(due)}));
    (opts.onChange || renderShell)();
  }

  // The "All tips" sheet: every tip for a month — including ones hidden
  // with "Not now" — with a month picker to browse the rest of the year.
  function openAllTips(month){
    var now = new Date();
    if (month === undefined) month = now.getMonth();
    showModal(function(container){
      container.appendChild(el("div", {class:"modal-head"}, [
        el("h3", {style:"font-size:17px;"}, [tr("Garden tips")]),
        el("button", {class:"modal-close", "aria-label":tr("Close"), onclick:closeModal}, ["×"])
      ]));
      var months = el("div", {class:"filter-chips month-chips", role:"toolbar", "aria-label":tr("Month")});
      for (var i=0;i<12;i++){
        var m = (now.getMonth() + i) % 12; // start from this month
        var chip = el("button", {class:"fchip" + (m === month ? " active" : ""), "aria-pressed": m === month ? "true" : "false"}, [i === 0 ? tr("This month") : monthShort(m)]);
        chip.addEventListener("click", (function(mm){ return function(){ openAllTips(mm); }; })(m));
        months.appendChild(chip);
      }
      container.appendChild(months);
      var isNow = month === now.getMonth();
      var entry = tipsByMonth[month];
      if (!entry || entry.status === "loading"){
        container.appendChild(el("div", {class:"about-locked tips-loading", style:"margin-top:12px;"}, [el("span", {}, ["🌱"]), el("span", {}, [tr("Writing {month}'s tips for your garden — this takes a few seconds the first time…", {month:monthName(month)})])]));
        // Re-open once loaded, unless the sheet was closed or moved on.
        loadTips(month, function(){
          var sheet = document.getElementById("modalContent");
          if (!document.getElementById("overlay").hidden && sheet && sheet.getAttribute("data-tips-month") === String(month)) openAllTips(month);
        });
        container.setAttribute("data-tips-month", String(month));
        return;
      }
      container.setAttribute("data-tips-month", String(month));
      var tips = (isNow && window.GardenTips ? window.GardenTips.weatherTips(state.weather) : []).concat(entry.status === "ready" ? entry.tips : []);
      container.appendChild(el("p", {class:"lead", style:"font-size:13px;color:var(--ink-soft);margin:10px 0 12px;"}, [
        isNow ? trn(tips.length, "1 tip for this month, written for your garden's location, climate and plants.", "{n} tips for this month, written for your garden's location, climate and plants.")
              : trn(tips.length, "1 tip for {month}, written for your garden's location, climate and plants. Adding it sets it for early {month}.", "{n} tips for {month}, written for your garden's location, climate and plants. Adding one sets it for early {month}.", {month:monthName(month)})
      ]));
      if (!tips.length){
        var retry = el("button", {class:"link-btn"}, [tr("Try again")]);
        retry.addEventListener("click", function(){ delete tipsByMonth[month]; openAllTips(month); });
        container.appendChild(el("div", {class:"empty"}, [tr("Couldn't load tips for this month right now.") + " ", retry]));
      }
      var list = el("div", {class:"tips-list"});
      tips.forEach(function(tip){
        list.appendChild(tipCard(tip, {list:true, month: isNow ? undefined : month, onChange:function(){ openAllTips(month); }}));
      });
      container.appendChild(list);
    }, {keepScroll:true});
  }

  // Why a task exists (tasks.reason) — saved as these English keys by the
  // server and the app, shown translated.
  var TASK_REASONS = [N_("care guide"), N_("photo diagnosis"), N_("reported issue"), N_("health tracking"), N_("weekly checkin"), N_("weather alert"), N_("Garden tip"), N_("Added by you"), N_("new plant photo")];
  // Comments the server used to write in English (it now writes them in
  // the saved language); shown translated on older tasks.
  var SERVER_COMMENTS = [N_("Superseded by a newer check-in."), N_("Resolved — latest photo looks healthy.")];

  function severityChip(sev){
    var map = {critical:["chip-crit",N_("Urgent")], warning:["chip-warn",N_("Soon")], info:["chip-neutral",N_("Note")]};
    var m = map[sev] || map.info;
    return el("span", {class:"chip " + m[0]}, [tr(m[1])]);
  }

  // "This week" = anything overdue (still pending, due before today) plus
  // whatever's due in the next 7 days — so nothing silently falls off the list
  // just because its date has passed.
  function thisWeekTasks(){
    var today = todayISO();
    var horizon = addDays(today, 6);
    return state.tasks.filter(function(t){
      if (t.status === "done") return false;
      if (!t.dueDate) return true;
      return t.dueDate < today || (t.dueDate >= today && t.dueDate <= horizon);
    }).sort(function(a,b){ return (a.dueDate||"").localeCompare(b.dueDate||""); });
  }

  // This week's list, grouped: Catch up (overdue) / Today / Tomorrow /
  // Later this week — easier to scan than one long list with "Overdue"
  // chips sprinkled through it.
  function tasksSection(tasks){
    var sec = el("div", {class:"card", style:"margin:22px 0 18px;"});
    var allLink = el("button", {class:"link-btn"}, [tr("All tasks →")]);
    allLink.addEventListener("click", function(){ state.section = "tasklist"; renderShell(); window.scrollTo(0, 0); });
    sec.appendChild(el("div", {class:"section-head"}, [
      el("h2", {}, [tr("This week")]),
      el("span", {class:"hint"}, [tasks.length ? tr("{n} open", {n:tasks.length}) + (isTouch() ? " · " + tr("swipe → when done") + " · " : " · ") : "", allLink])
    ]));
    if (tasks.length === 0){
      sec.appendChild(el("div", {class:"empty-fun"}, [el("span", {class:"big"}, ["🌻"]), tr("All clear this week! I'll add tasks here each morning when something needs attention.")]));
      return sec;
    }
    var today = todayISO();
    var groups = [
      {key:"catchup", label:tr("Catch up"), cls:"catchup", test:function(t){ return t.dueDate && t.dueDate < today; }},
      {key:"today", label:tr("Today"), test:function(t){ return t.dueDate === today; }},
      {key:"tomorrow", label:tr("Tomorrow"), test:function(t){ return t.dueDate && daysFromToday(t.dueDate) === 1; }},
      {key:"later", label:tr("Later this week"), test:function(t){ return t.dueDate && daysFromToday(t.dueDate) > 1; }},
      {key:"anytime", label:tr("Anytime"), test:function(t){ return !t.dueDate; }}
    ];
    groups.forEach(function(g){
      var items = tasks.filter(g.test);
      if (!items.length) return;
      sec.appendChild(el("div", {class:"task-group-label" + (g.cls ? " " + g.cls : "")}, [g.label, el("span", {class:"count"}, ["· " + items.length])]));
      items.forEach(function(t){ sec.appendChild(taskListRow(t, {swipe:true, hideDate: g.key === "today" || g.key === "tomorrow"})); });
    });
    return sec;
  }

  // "Upcoming" = the two weeks right after "This week" — days 8 through 21 from
  // today — so the dashboard gives a look further ahead without duplicating
  // what's already in This week's overdue+7-day window. Same minimal-row/detail-
  // modal treatment as This week (still completable — nothing stops you marking
  // an upcoming task done early), just its own section below it.
  function upcomingTasks(){
    var today = todayISO();
    var weekHorizon = addDays(today, 6);
    var twoWeekHorizon = addDays(today, 20);
    return state.tasks.filter(function(t){
      if (t.status === "done") return false;
      if (!t.dueDate) return false;
      return t.dueDate > weekHorizon && t.dueDate <= twoWeekHorizon;
    }).sort(function(a,b){ return (a.dueDate||"").localeCompare(b.dueDate||""); });
  }

  function upcomingSection(tasks){
    var sec = el("div", {class:"card", style:"margin-bottom:18px;"});
    sec.appendChild(el("div", {class:"section-head"}, [
      el("h2", {}, [tr("Upcoming")]),
      el("span", {class:"hint"}, [tr("next 2 weeks")])
    ]));
    if (tasks.length === 0){
      sec.appendChild(el("div", {class:"empty"}, [tr("Nothing scheduled for the two weeks after this one yet — a good moment to browse the garden tips above.")]));
    } else {
      tasks.forEach(function(t){ sec.appendChild(taskListRow(t, {swipe:true})); });
    }
    return sec;
  }

  // Consecutive past calendar weeks (most recent first) in which every task
  // due that week got done. Weeks with nothing due don't break the streak.
  function weekStreak(){
    var streak = 0;
    var start = weekDatesFor(new Date())[0];
    for (var k=1; k<=26; k++){
      var ws = new Date(start); ws.setDate(start.getDate() - 7*k);
      var we = new Date(ws); we.setDate(ws.getDate() + 6);
      var from = isoDate(ws.getFullYear(), ws.getMonth()+1, ws.getDate());
      var to = isoDate(we.getFullYear(), we.getMonth()+1, we.getDate());
      var due = state.tasks.filter(function(t){ return t.dueDate && t.dueDate >= from && t.dueDate <= to; });
      if (!due.length) continue;
      if (due.every(function(t){ return t.status === "done"; })) streak++;
      else break;
    }
    return streak;
  }

  // "Recently done" as a small celebration: what got done in the last 7
  // days by kind of job, plus a streak — with the plain list tucked away.
  function doneSection(tasks){
    var sec = el("div", {class:"card", style:"margin-bottom:18px;"});
    var weekAgo = Date.now() - 7 * 86400000;
    var doneThisWeek = state.tasks.filter(function(t){ return t.status === "done" && t.completedAt && new Date(t.completedAt).getTime() >= weekAgo; });
    var counts = {}, order = [];
    doneThisWeek.forEach(function(t){
      var c = taskCategory(t);
      if (!counts[c.key]){ counts[c.key] = {cat:c, n:0}; order.push(c.key); }
      counts[c.key].n++;
    });
    var parts = order.map(function(k){ var c = counts[k]; return c.cat.emoji + " " + tr(c.cat.verb) + (c.n > 1 ? " ×" + c.n : ""); });
    var streak = weekStreak();
    var text = doneThisWeek.length
      ? [el("div", {class:"celebrate-title"}, [trn(doneThisWeek.length, "Nice work — 1 job done this week!", "Nice work — {n} jobs done this week!")]),
         el("div", {class:"celebrate-sub"}, [parts.join(" · ")])]
      : [el("div", {class:"celebrate-title"}, [tr("Recently done")]),
         el("div", {class:"celebrate-sub"}, [tr("Nothing ticked off in the last 7 days yet.")])];
    if (streak >= 2) text.push(el("span", {class:"chip chip-amber streak"}, [tr("🔥 {n}-week streak — every task done", {n:streak})]));
    sec.appendChild(el("div", {class:"celebrate"}, [el("span", {class:"celebrate-emoji", "aria-hidden":"true"}, [doneThisWeek.length ? "🎉" : "🌾"]), el("div", {}, text)]));
    var details = el("details", {class:"done-list"}, [el("summary", {}, [tr("Show recently done ({n})", {n:tasks.length})])]);
    tasks.forEach(function(t){ details.appendChild(taskListRow(t)); });
    sec.appendChild(details);
    return sec;
  }

  // A clickable task row: category icon (tinted with the plant's color),
  // title, and a small meta line (plant, date, photo/overdue badges). Click
  // opens the full detail (openTaskDetail). opts.swipe: swipe right to mark
  // it done without opening it — still no checkbox cluttering the list.
  function taskListRow(t, opts){
    opts = opts || {};
    var overdue = t.status !== "done" && t.dueDate && t.dueDate < todayISO();
    var cat = taskCategory(t);
    var color = t.plantId ? plantColorFor(t.plantId) : "var(--moss)";
    var meta = el("span", {class:"task-mini-meta"}, [
      t.plantName ? el("span", {class:"chip chip-moss"}, [t.plantName]) : null,
      t.kind === "tip" ? el("span", {class:"chip chip-amber"}, [tr("Tip")]) : null,
      overdue ? el("span", {class:"chip chip-warn"}, [relativeDay(t.dueDate)]) : null,
      t.requestsPhoto ? el("span", {class:"chip chip-neutral"}, [tr("📷 photo")]) : null,
      (!overdue && !opts.hideDate && t.dueDate) ? el("span", {}, [t.status === "done" && t.completedAt ? tr("done {date}", {date:fmtDate(t.completedAt)}) : fmtDate(t.dueDate)]) : null
    ]);
    var row = el("button", {class:"task-mini" + (t.status==="done" ? " done" : ""), style:"--task-color:" + color + ";"}, [
      el("span", {class:"task-mini-icon", html:icon(cat.icon)}),
      el("span", {class:"task-mini-main"}, [el("span", {class:"task-mini-title"}, [t.title]), meta])
    ]);
    row.addEventListener("click", function(){
      if (row.__swiped) { row.__swiped = false; return; }
      openTaskDetail(t.id, {allowComplete:true});
    });
    if (!opts.swipe || t.status === "done") return row;
    var wrap = el("div", {class:"swipe-wrap"}, [
      el("div", {class:"swipe-bg", "aria-hidden":"true"}, [el("span", {html:icon("check")}), tr("Done")]),
      row
    ]);
    makeSwipeable(wrap, row, function(){ completeTaskFromList(t, wrap, row); });
    return wrap;
  }

  // Swipe right past ~35% of the row to complete (left in a right-to-left
  // language). Vertical scrolling keeps working (touch-action: pan-y); a
  // swipe never also counts as a tap.
  function makeSwipeable(wrap, row, onComplete){
    var startX = 0, startY = 0, tracking = false, dragging = false, armed = false, pid = null;
    var dir = I18N.isRTL() ? -1 : 1;
    row.addEventListener("pointerdown", function(e){
      if (e.button !== undefined && e.button !== 0) return;
      tracking = true; dragging = false; armed = false; pid = e.pointerId;
      startX = e.clientX; startY = e.clientY;
    });
    row.addEventListener("pointermove", function(e){
      if (!tracking || e.pointerId !== pid) return;
      var dx = (e.clientX - startX) * dir, dy = e.clientY - startY;
      if (!dragging){
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { tracking = false; return; }
        if (dx > 10 && dx > Math.abs(dy) * 1.5){
          dragging = true; swipeActive = true;
          try { row.setPointerCapture(pid); } catch(err){}
          wrap.classList.add("dragging");
        } else return;
      }
      var tx = Math.max(0, dx);
      row.style.transform = "translateX(" + (tx * dir) + "px)";
      var nowArmed = tx > Math.min(130, wrap.offsetWidth * 0.35);
      if (nowArmed !== armed){ armed = nowArmed; wrap.classList.toggle("armed", armed); if (armed) buzz(8); }
    });
    function end(){
      if (!tracking) return;
      tracking = false;
      if (!dragging) return;
      dragging = false;
      row.__swiped = true;
      setTimeout(function(){ row.__swiped = false; }, 400);
      row.classList.add("animating");
      if (armed){
        row.style.transform = "translateX(" + (wrap.offsetWidth * dir) + "px)";
        onComplete();
      } else {
        row.style.transform = "translateX(0)";
        setTimeout(function(){ wrap.classList.remove("dragging", "armed"); row.classList.remove("animating"); swipeActive = false; }, 230);
      }
    }
    row.addEventListener("pointerup", end);
    row.addEventListener("pointercancel", end);
  }

  async function setTaskStatus(t, status){
    await api("/tasks/" + t.id, {method:"PATCH", body:{status:status}});
    var local = state.tasks.find(function(x){ return x.id === t.id; });
    if (local){ local.status = status; local.completedAt = status === "done" ? new Date().toISOString() : null; }
  }

  async function completeTaskFromList(t, wrap, row){
    buzz(15);
    leafBurst(row.querySelector(".task-mini-icon") || row);
    wrap.classList.add("completing");
    try {
      await setTaskStatus(t, "done");
    } catch(e){
      swipeActive = false;
      showToast(tr("Couldn't save — try again"));
      renderShell();
      return;
    }
    setTimeout(function(){
      swipeActive = false;
      renderShell();
      showToast(tr("Nice! “{title}” done", {title:t.title}), {label:tr("Undo"), fn: async function(){
        try { await setTaskStatus(t, "pending"); } catch(e){ showToast(tr("Couldn't undo — try again")); }
        renderShell();
      }});
      // Pick up anything the server did on completion (e.g. schedule stamps).
      loadGardenData().then(function(){ if (!modalOpenFor && !userIsBusy()) renderShell(); }).catch(function(){});
    }, 420);
  }

  function statusChip(t){
    if (t.status === "done") return el("span", {class:"chip chip-moss"}, [tr("Done") + (t.completedAt ? " · " + fmtDate(t.completedAt) : "")]);
    if (t.dueDate && t.dueDate < todayISO()) return el("span", {class:"chip chip-warn"}, [tr("Overdue")]);
    return el("span", {class:"chip chip-neutral"}, [tr("Pending")]);
  }

  // opts.allowComplete (default true): show a Mark done/not done button. The
  // Yearly Plan passes allowComplete:false so a task can be opened and
  // reviewed (comments/photo still allowed) but never completed from the
  // calendar — only "This week" can complete a task.
  // opts.onBack / opts.backLabel: optional — shows a back button above the
  // detail instead of just the modal's × (used by the Yearly Plan to return
  // to the calendar it was opened from).
  // opts.afterSave: optional override for what runs after a save/toggle;
  // defaults to reloading data and rebuilding this same detail view in place.
  function openTaskDetail(taskId, opts){
    opts = opts || {};
    showModal(function(container){
      var t = state.tasks.find(function(x){ return x.id === taskId; });
      container.appendChild(el("div", {class:"modal-head"}, [
        el("h3", {style:"font-size:17px;"}, [tr("Task")]),
        el("button", {class:"modal-close", "aria-label":tr("Close"), onclick:closeModal}, ["×"])
      ]));
      if (opts.onBack){
        var backBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-bottom:14px;"}, [opts.backLabel || tr("← Back to calendar")]);
        backBtn.addEventListener("click", opts.onBack);
        container.appendChild(backBtn);
      }
      if (!t){
        container.appendChild(el("div", {class:"empty"}, [tr("This task couldn't be found — it may have been removed.")]));
        return;
      }
      container.appendChild(taskDetailBody(t, opts));
    });
  }

  function taskDetailBody(t, opts){
    opts = opts || {};
    var allowComplete = opts.allowComplete !== false;
    var refresh = opts.afterSave || async function(){ await loadGardenData(); openTaskDetail(t.id, opts); };

    var wrap = el("div", {});
    var statusRow = el("div", {style:"display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;"});
    if (allowComplete){
      var doneBtn = el("button", {class:"btn btn-sm" + (t.status==="done" ? " btn-ghost" : " btn-primary")}, [t.status==="done" ? tr("Mark not done") : tr("Mark done")]);
      doneBtn.addEventListener("click", async function(){
        doneBtn.disabled = true;
        var newStatus = t.status === "done" ? "pending" : "done";
        // completedAt, and stamping lastDone on the plant's matching
        // yearly-schedule entry, happen server-side (api/tasks/[id].js).
        try {
          await api("/tasks/" + t.id, {method:"PATCH", body:{status:newStatus}});
        } catch(e){
          doneBtn.disabled = false;
          doneBtn.textContent = tr("Couldn't save — try again");
          return;
        }
        if (newStatus === "done"){ buzz(15); leafBurst(doneBtn); }
        await refresh();
      });
      statusRow.appendChild(doneBtn);
    } else {
      statusRow.appendChild(statusChip(t));
    }
    if (t.severity) statusRow.appendChild(severityChip(t.severity));
    if (t.plantName) statusRow.appendChild(el("span", {class:"chip chip-moss"}, [t.plantName]));
    if (t.requestsPhoto) statusRow.appendChild(el("span", {class:"chip chip-neutral"}, [tr("📷 photo requested")]));
    wrap.appendChild(statusRow);

    wrap.appendChild(el("div", {style:"font-weight:600;font-size:15.5px;margin-bottom:4px;"}, [t.title]));
    if (t.description) wrap.appendChild(el("div", {class:"task-desc"}, [t.description]));
    wrap.appendChild(el("div", {class:"task-meta", style:"margin-bottom:14px;"}, [fmtDate(t.dueDate) + (t.reason ? " · " + tr(t.reason) : "")]));

    (t.comments||[]).forEach(function(c){
      wrap.appendChild(el("div", {class:"comment-item"}, [tr(c.text) + "  ·  " + fmtDate(c.date)]));
    });
    if (t.photo && t.photo.dataUrl){
      wrap.appendChild(el("img", {src:t.photo.dataUrl, class:"photo-preview", style:"max-width:260px;"}));
      if (t.photo.analysis) wrap.appendChild(el("div", {class:"agent-note"}, [t.photo.analysis]));
    }
    var commentTa = el("textarea", {placeholder:tr("Add a note…"), style:"margin-top:10px;"});
    var photoInput = el("input", {type:"file", accept:"image/*", class:"sr-only"});
    var photoLabel = el("label", {class:"btn btn-ghost btn-sm"}, [tr("Attach photo"), photoInput]);
    var saveBtn = el("button", {class:"btn btn-sm btn-primary"}, [tr("Save")]);
    var pendingPhoto = null;
    photoInput.addEventListener("change", async function(){
      var f = photoInput.files[0]; if (!f) return;
      pendingPhoto = await resizeImage(f);
      photoLabel.textContent = tr("Photo attached");
      photoLabel.appendChild(photoInput);
    });
    saveBtn.addEventListener("click", async function(){
      saveBtn.disabled = true; saveBtn.textContent = tr("Saving…");
      var noteText = commentTa.value.trim();
      try {
        if (pendingPhoto){
          // Server appends the note, analyzes the photo (onto the plant when
          // the task has one), and completes a weekly check-in.
          await api("/tasks/" + t.id + "/photo", {method:"POST", body:{dataUrl:pendingPhoto, note:noteText, allowComplete:allowComplete}});
        } else {
          var newComments = (t.comments||[]).slice();
          if (noteText) newComments.push({text:noteText, date:new Date().toISOString()});
          await api("/tasks/" + t.id, {method:"PATCH", body:{comments:newComments}});
        }
      } catch(e){
        saveBtn.disabled = false; saveBtn.textContent = tr("Couldn't save — try again");
        return;
      }
      await refresh();
    });
    wrap.appendChild(el("div", {class:"field", style:"margin-top:8px;"}, [commentTa]));
    wrap.appendChild(el("div", {class:"row"}, [photoLabel, saveBtn]));

    var editBtn = el("button", {class:"btn btn-ghost btn-sm"}, [el("span", {html:icon("pencil")}), " " + tr("Edit")]);
    editBtn.addEventListener("click", function(){ openTaskForm(t); });
    wrap.appendChild(el("div", {class:"row task-manage-row"}, [editBtn, deleteTaskButton(t)]));

    return wrap;
  }

  // ---- Tasks screen: every task in one place, with search and filters
  // (open/done, kind, plant), grouped by when it's due; add, edit and
  // delete from here. Search typing only repaints the list, so the field
  // keeps focus. ----
  var TASK_KINDS = [
    ["all", N_("All")], ["manual", N_("✍️ Mine")], ["scheduled", N_("📅 Care guide")], ["issue", N_("🩺 Problems")], ["checkin", N_("📷 Check-ins")], ["tip", N_("💡 Tips")]
  ];
  var taskFilter = {status:"open", kind:"all", plant:"all", q:""};

  function taskListScreen(){
    var wrap = el("div", {});
    var openCount = state.tasks.filter(function(t){ return t.status !== "done"; }).length;
    var addBtn = el("button", {class:"btn btn-sm btn-primary"}, [tr("+ New task")]);
    addBtn.addEventListener("click", function(){ openTaskForm(null); });
    wrap.appendChild(el("div", {class:"section-title", style:"margin-top:4px;align-items:center;"}, [
      el("div", {}, [el("h2", {}, [tr("Tasks")]), el("div", {class:"hint"}, [tr("{open} open · {done} done", {open:openCount, done:state.tasks.length - openCount})])]),
      addBtn
    ]));

    var toolbar = el("div", {class:"lib-toolbar"});
    var results = el("div", {});
    var search = el("input", {type:"search", placeholder:tr("Search tasks"), value:taskFilter.q, "aria-label":tr("Search tasks"), autocomplete:"off"});
    search.addEventListener("input", function(){ taskFilter.q = search.value; renderTaskResults(results); });
    toolbar.appendChild(el("div", {class:"search-wrap"}, [el("span", {html:icon("search")}), search]));

    var seg = el("div", {class:"seg", role:"group", "aria-label":tr("Status")});
    [["open",tr("Open")],["done",tr("Done")],["all",tr("All")]].forEach(function(v){
      var b = el("button", {class: taskFilter.status === v[0] ? "active" : "", "aria-pressed": taskFilter.status === v[0] ? "true" : "false"}, [v[1]]);
      b.addEventListener("click", function(){ taskFilter.status = v[0]; renderShell(); });
      seg.appendChild(b);
    });
    var plantSel = el("select", {class:"sort-select", "aria-label":tr("Filter by plant")},
      [["all",tr("All plants")]].concat(state.plants.map(function(p){ return [p.id, p.name]; }), [["none",tr("Not about a plant")]]).map(function(o){
        var opt = el("option", {value:o[0]}, [o[1]]);
        if (taskFilter.plant === o[0]) opt.setAttribute("selected","selected");
        return opt;
      }));
    plantSel.addEventListener("change", function(){ taskFilter.plant = plantSel.value; renderTaskResults(results); });
    toolbar.appendChild(el("div", {class:"lib-toolbar-row"}, [seg, plantSel]));

    // Kind chips — only kinds that actually exist, plus All.
    var kindsPresent = {};
    state.tasks.forEach(function(t){ kindsPresent[t.kind || "manual"] = true; });
    var chips = el("div", {class:"filter-chips", role:"toolbar", "aria-label":tr("Filter by type")});
    TASK_KINDS.forEach(function(k){
      if (k[0] !== "all" && !kindsPresent[k[0]]) return;
      var chip = el("button", {class:"fchip" + (taskFilter.kind === k[0] ? " active" : ""), "aria-pressed": taskFilter.kind === k[0] ? "true" : "false"}, [tr(k[1])]);
      chip.addEventListener("click", function(){ taskFilter.kind = k[0]; renderShell(); });
      chips.appendChild(chip);
    });
    if (chips.children.length > 2) toolbar.appendChild(chips);

    wrap.appendChild(toolbar);
    wrap.appendChild(results);
    renderTaskResults(results);
    return wrap;
  }

  function filteredTasks(){
    var q = taskFilter.q.trim().toLowerCase();
    return state.tasks.filter(function(t){
      if (taskFilter.status === "open" && t.status === "done") return false;
      if (taskFilter.status === "done" && t.status !== "done") return false;
      if (taskFilter.kind !== "all" && (t.kind || "manual") !== taskFilter.kind) return false;
      if (taskFilter.plant === "none" && t.plantId) return false;
      if (taskFilter.plant !== "all" && taskFilter.plant !== "none" && t.plantId !== taskFilter.plant) return false;
      if (!q) return true;
      return [t.title, t.description, t.plantName].some(function(v){ return v && String(v).toLowerCase().indexOf(q) !== -1; });
    });
  }

  function renderTaskResults(container){
    container.innerHTML = "";
    var list = filteredTasks();
    if (!list.length){
      var anyFilter = taskFilter.q || taskFilter.kind !== "all" || taskFilter.plant !== "all";
      container.appendChild(el("div", {class:"card empty-fun"}, [
        el("span", {class:"big"}, [taskFilter.status === "done" ? "🌾" : "🌻"]),
        anyFilter ? tr("No tasks match these filters.") : (taskFilter.status === "done" ? tr("Nothing finished yet.") : tr("No open tasks — tap “+ New task” to add one."))
      ]));
      return;
    }
    var today = todayISO();
    var open = list.filter(function(t){ return t.status !== "done"; })
      .sort(function(a,b){ return (a.dueDate||"9999").localeCompare(b.dueDate||"9999"); });
    var done = list.filter(function(t){ return t.status === "done"; })
      .sort(function(a,b){ return String(b.completedAt||b.dueDate||"").localeCompare(String(a.completedAt||a.dueDate||"")); });

    // Open: Overdue / Today / This week / then one group per month.
    var groups = [], byKey = {};
    function add(key, label, cls, t){
      if (!byKey[key]){ byKey[key] = {label:label, cls:cls, items:[]}; groups.push(byKey[key]); }
      byKey[key].items.push(t);
    }
    open.forEach(function(t){
      if (!t.dueDate) return add("nodate", tr("Anytime"), "", t);
      var n = daysFromToday(t.dueDate);
      if (t.dueDate < today) return add("overdue", tr("Overdue"), "catchup", t);
      if (n === 0) return add("today", tr("Today"), "", t);
      if (n < 7) return add("week", tr("This week"), "", t);
      var d = new Date(t.dueDate + "T00:00:00");
      add("m" + t.dueDate.slice(0,7), monthName(d.getMonth()) + (d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""), "", t);
    });
    // "Anytime" last.
    groups.sort(function(a,b){ return (a === byKey.nodate) - (b === byKey.nodate); });
    if (done.length) groups.push({label:tr("Done"), cls:"", items:done});

    var card = el("div", {class:"card"});
    groups.forEach(function(g){
      card.appendChild(el("div", {class:"task-group-label" + (g.cls ? " " + g.cls : "")}, [g.label, el("span", {class:"count"}, ["· " + g.items.length])]));
      g.items.forEach(function(t){ card.appendChild(taskListRow(t, {swipe:true})); });
    });
    container.appendChild(card);
  }

  // Add (task === null) or edit a task. opts.plantId pre-selects a plant.
  function openTaskForm(task, opts){
    opts = opts || {};
    var isNew = !task;
    showModal(function(container){
      container.appendChild(el("div", {class:"modal-head"}, [
        el("h3", {style:"font-size:17px;"}, [isNew ? tr("New task") : tr("Edit task")]),
        el("button", {class:"modal-close", "aria-label":tr("Close"), onclick:closeModal}, ["×"])
      ]));
      var titleIn = el("input", {type:"text", placeholder:tr("e.g. Buy compost"), value: task ? task.title : ""});
      var notesIn = el("textarea", {placeholder:tr("Notes (optional)"), style:"min-height:64px;"});
      notesIn.value = task ? (task.description || "") : "";
      var dateIn = el("input", {type:"date", value: task ? (task.dueDate || "") : todayISO()});
      var selectedPlant = task ? (task.plantId || "") : (opts.plantId || "");
      var plantSel = el("select", {}, [el("option", {value:""}, [tr("Not about a specific plant")])].concat(state.plants.map(function(p){
        var o = el("option", {value:p.id}, [p.name]);
        if (p.id === selectedPlant) o.setAttribute("selected","selected");
        return o;
      })));
      var photoIn = el("input", {type:"checkbox", id:"tfPhoto"});
      photoIn.checked = !!(task && task.requestsPhoto);
      var err = el("div", {class:"empty", style:"min-height:18px;"});

      // Quick due-date shortcuts.
      var quick = el("div", {class:"option-chips", style:"margin-top:8px;"});
      [[tr("Today"),0],[tr("Tomorrow"),1],[tr("In a week"),7],[tr("In 2 weeks"),14]].forEach(function(q){
        var b = el("button", {class:"option-chip", type:"button", style:"min-height:36px;padding:6px 12px;font-size:13px;"}, [q[0]]);
        b.addEventListener("click", function(){ dateIn.value = addDays(todayISO(), q[1]); });
        quick.appendChild(b);
      });

      container.appendChild(el("div", {class:"field"}, [el("label", {}, [tr("What needs doing?")]), titleIn]));
      container.appendChild(el("div", {class:"field"}, [el("label", {}, [tr("Due")]), dateIn, quick]));
      container.appendChild(el("div", {class:"field"}, [el("label", {}, [tr("Plant")]), plantSel]));
      container.appendChild(el("div", {class:"field"}, [el("label", {}, [tr("Notes")]), notesIn]));
      container.appendChild(el("label", {class:"check-row", for:"tfPhoto"}, [photoIn, tr("Ask me for a photo when I do this")]));
      if (task && task.kind === "scheduled"){
        container.appendChild(el("div", {class:"about-locked", style:"margin-top:10px;"}, [task.plantName
          ? tr("📅 This task comes from {name}'s care guide. Updating the care guide rebuilds these tasks, which would undo edits to upcoming ones.", {name:task.plantName})
          : tr("📅 This task comes from a plant's care guide. Updating the care guide rebuilds these tasks, which would undo edits to upcoming ones.")]));
      }
      container.appendChild(err);

      var saveBtn = el("button", {class:"btn btn-primary"}, [isNew ? tr("Add task") : tr("Save changes")]);
      saveBtn.addEventListener("click", async function(){
        var title = titleIn.value.trim();
        if (!title){ err.textContent = tr("Give the task a name."); titleIn.focus(); return; }
        if (!dateIn.value){ err.textContent = tr("Pick a due date."); return; }
        var plant = state.plants.find(function(p){ return p.id === plantSel.value; });
        var body = {
          title: title, description: notesIn.value.trim(), dueDate: dateIn.value,
          plantId: plant ? plant.id : null, plantName: plant ? plant.name : "",
          requestsPhoto: photoIn.checked
        };
        saveBtn.disabled = true; saveBtn.textContent = tr("Saving…");
        try {
          if (isNew){
            body.kind = "manual"; body.reason = "Added by you"; body.severity = "info";
            body.year = new Date(body.dueDate + "T00:00:00").getFullYear();
            await api("/tasks", {method:"POST", body:body});
          } else {
            await api("/tasks/" + task.id, {method:"PATCH", body:body});
          }
          await loadGardenData();
        } catch(e){
          saveBtn.disabled = false; saveBtn.textContent = tr("Couldn't save — try again");
          return;
        }
        buzz();
        closeModal();
        showToast(isNew ? tr("Task added — due {when}", {when:relativeDay(body.dueDate)}) : tr("Task updated"));
      });
      var row = el("div", {class:"row", style:"justify-content:space-between;margin-top:6px;"});
      if (!isNew) row.appendChild(deleteTaskButton(task)); else row.appendChild(el("span"));
      row.appendChild(saveBtn);
      container.appendChild(row);
      if (isNew) setTimeout(function(){ titleIn.focus(); }, 60);
    });
  }

  // A delete button that asks once, inline ("Tap again…"), then runs
  // doDelete(); a throw from doDelete re-enables it with a retry message.
  function confirmDeleteButton(label, armedLabel, doDelete){
    function idle(){ btn.innerHTML = ""; btn.appendChild(el("span", {html:icon("trash")})); btn.appendChild(document.createTextNode(" " + label)); }
    var btn = el("button", {class:"btn btn-ghost danger-btn"});
    idle();
    var armed = false;
    btn.addEventListener("click", async function(){
      if (!armed){
        armed = true;
        btn.classList.add("armed");
        btn.textContent = armedLabel;
        setTimeout(function(){ if (armed && !btn.disabled){ armed = false; btn.classList.remove("armed"); idle(); } }, 3500);
        return;
      }
      btn.disabled = true; btn.textContent = tr("Deleting…");
      try { await doDelete(); }
      catch(e){ btn.disabled = false; btn.textContent = tr("Couldn't delete — try again"); }
    });
    return btn;
  }

  function deleteTaskButton(t){
    return confirmDeleteButton(tr("Delete"), tr("Tap again to delete"), async function(){
      await api("/tasks/" + t.id, {method:"DELETE"});
      state.tasks = state.tasks.filter(function(x){ return x.id !== t.id; });
      closeModal();
      showToast(tr("Deleted “{title}”", {title:t.title}));
    });
  }

  // Removing a plant also removes its tasks (ON DELETE CASCADE server-side).
  function removePlantButton(p){
    return confirmDeleteButton(tr("Remove {name} from my garden", {name:p.name}), tr("Tap again to remove it for good"), async function(){
      await api("/plants/" + p.id, {method:"DELETE"});
      state.plants = state.plants.filter(function(x){ return x.id !== p.id; });
      state.tasks = state.tasks.filter(function(t){ return t.plantId !== p.id; });
      modalOpenFor = null;
      closeModal();
      showToast(tr("Removed {name}", {name:p.name}));
    });
  }

  // ---- Library: photo-first cards, searchable/filterable/sortable, shown
  // either as a grid or as "shelves" grouped by where each plant lives.
  // Search typing only repaints the results (not the whole shell), so the
  // field keeps focus. ----
  var LIB_VIEW_KEY = "gc.libraryView";
  var lib = {q:"", filter:"all", sort:"name", view: localGet(LIB_VIEW_KEY, "grid")};

  function librarySection(){
    var wrap = el("div", {});
    if (state.plants.length === 0){
      var sec = el("div", {class:"card empty-fun"}, [
        el("span", {class:"big"}, ["🪴"]),
        el("h2", {style:"font-size:20px;margin-bottom:6px;"}, [tr("Your garden is empty")]),
        el("p", {style:"margin:0 0 14px;"}, [tr("Add your first plant and I'll build a care guide and a yearly schedule for it.")])
      ]);
      var ctaBtn = el("button", {class:"btn btn-primary"}, [tr("+ Add your first plant")]);
      ctaBtn.addEventListener("click", openPlantWizard);
      sec.appendChild(ctaBtn);
      wrap.appendChild(sec);
      return wrap;
    }

    var addBtn = el("button", {class:"btn btn-sm btn-primary"}, [tr("+ Add a plant")]);
    addBtn.addEventListener("click", openPlantWizard);
    var head = el("div", {class:"section-title", style:"margin-top:4px;align-items:center;"}, [
      el("div", {}, [
        el("h2", {}, [tr("My garden")]),
        el("div", {class:"hint"}, [trn(state.plants.length, "1 plant", "{n} plants")])
      ]),
      addBtn
    ]);
    wrap.appendChild(head);

    var toolbar = el("div", {class:"lib-toolbar"});
    var results = el("div", {});

    if (state.plants.length >= 6){
      var search = el("input", {type:"search", placeholder:tr("Search your plants"), value:lib.q, "aria-label":tr("Search your plants"), autocomplete:"off"});
      search.addEventListener("input", function(){ lib.q = search.value; renderLibraryResults(results); });
      toolbar.appendChild(el("div", {class:"search-wrap"}, [el("span", {html:icon("search")}), search]));
    }

    // Filter chips: All, Needs attention (if any), then one per plant type present.
    var chips = el("div", {class:"filter-chips", role:"toolbar", "aria-label":tr("Filter plants")});
    var filters = [["all", tr("All")]];
    var needYou = state.plants.filter(function(p){ return plantAlerts(p).count > 0; }).length;
    if (needYou) filters.push(["attn", tr("🔴 Needs you · {n}", {n:needYou})]);
    var typesPresent = [];
    state.plants.forEach(function(p){ var ty = p.type || "other"; if (typesPresent.indexOf(ty) === -1) typesPresent.push(ty); });
    if (typesPresent.length > 1) typesPresent.forEach(function(ty){ filters.push(["type:" + ty, typeEmoji(ty) + " " + typeLabel(ty)]); });
    if (filters.every(function(f){ return f[0] !== lib.filter; })) lib.filter = "all";
    filters.forEach(function(f){
      var chip = el("button", {class:"fchip" + (lib.filter === f[0] ? " active" : ""), "aria-pressed": lib.filter === f[0] ? "true" : "false"}, [f[1]]);
      chip.addEventListener("click", function(){ lib.filter = f[0]; renderShell(); });
      chips.appendChild(chip);
    });
    toolbar.appendChild(chips);

    var seg = el("div", {class:"seg", role:"group", "aria-label":tr("View")});
    [["grid",tr("Grid")],["spots",tr("By spot")]].forEach(function(v){
      var b = el("button", {class: lib.view === v[0] ? "active" : "", "aria-pressed": lib.view === v[0] ? "true" : "false"}, [v[1]]);
      b.addEventListener("click", function(){ lib.view = v[0]; localSet(LIB_VIEW_KEY, v[0]); renderShell(); });
      seg.appendChild(b);
    });
    var sortSel = el("select", {class:"sort-select", "aria-label":tr("Sort plants")}, [
      ["name",tr("A → Z")], ["care",tr("Needs care soonest")], ["newest",tr("Newest first")]
    ].map(function(o){ var opt = el("option", {value:o[0]}, [o[1]]); if (lib.sort === o[0]) opt.setAttribute("selected","selected"); return opt; }));
    sortSel.addEventListener("change", function(){ lib.sort = sortSel.value; renderLibraryResults(results); });
    toolbar.appendChild(el("div", {class:"lib-toolbar-row"}, [seg, sortSel]));

    wrap.appendChild(toolbar);
    wrap.appendChild(results);
    renderLibraryResults(results);
    return wrap;
  }

  function filteredSortedPlants(){
    var q = lib.q.trim().toLowerCase();
    var list = state.plants.filter(function(p){
      if (lib.filter === "attn" && !plantAlerts(p).count) return false;
      if (lib.filter.indexOf("type:") === 0 && (p.type || "other") !== lib.filter.slice(5)) return false;
      if (!q) return true;
      return [p.name, p.type, typeLabel(p.type), p.spot, optLabel(p.spot), p.species].some(function(v){ return v && String(v).toLowerCase().indexOf(q) !== -1; });
    });
    if (lib.sort === "newest"){
      list.sort(function(a,b){ return String(b.createdAt||"").localeCompare(String(a.createdAt||"")); });
    } else if (lib.sort === "care"){
      var key = function(p){
        var t = nextTaskFor(p.id);
        return (p.healthStatus === "needs_attention" ? "0" : "1") + (t ? t.dueDate : "9999");
      };
      list.sort(function(a,b){ return key(a).localeCompare(key(b)) || a.name.localeCompare(b.name, I18N.locale()); });
    } else {
      list.sort(function(a,b){ return a.name.localeCompare(b.name, I18N.locale()); });
    }
    return list;
  }

  function renderLibraryResults(container){
    container.innerHTML = "";
    var list = filteredSortedPlants();
    if (!list.length){
      container.appendChild(el("div", {class:"no-results"}, [lib.q ? tr("No plants match “{q}”.", {q:lib.q.trim()}) : tr("No plants match this filter.")]));
      return;
    }
    if (lib.view === "spots"){
      var groups = {}, order = [];
      list.forEach(function(p){
        var spot = optLabel(p.spot) || tr("Somewhere in the garden");
        if (!groups[spot]){ groups[spot] = []; order.push(spot); }
        groups[spot].push(p);
      });
      order.sort(function(a,b){ return groups[b].length - groups[a].length || a.localeCompare(b); });
      order.forEach(function(spot){
        var row = el("div", {class:"hscroll", "data-keep-scroll":"shelf-" + spot});
        groups[spot].forEach(function(p){ row.appendChild(roundPlantTile(p)); });
        container.appendChild(el("section", {class:"shelf"}, [
          el("div", {class:"shelf-head"}, [el("h3", {}, [spot]), el("span", {class:"hint"}, [trn(groups[spot].length, "1 plant", "{n} plants")])]),
          row
        ]));
      });
      return;
    }
    var grid = el("div", {class:"round-grid"});
    list.forEach(function(p){ grid.appendChild(roundPlantTile(p)); });
    if (!lib.q && lib.filter === "all") grid.appendChild(addPlantTile());
    container.appendChild(el("div", {class:"garden-bed"}, [grid]));
  }

  // Photo (or a colored type-emoji placeholder) used by the round plant
  // tiles and the plant detail hero.
  function plantPhotoEl(p){
    var lastPhoto = (p.photos && p.photos.length) ? p.photos[p.photos.length-1] : null;
    if (lastPhoto) return el("img", {src:lastPhoto.dataUrl, alt:p.name, loading:"lazy"});
    return el("div", {class:"plant-photo-ph", style:"--ph-color:" + plantColorFor(p.id) + ";", "aria-hidden":"true"}, [typeEmoji(p.type)]);
  }

  // ---- Plant notifications: what a plant needs from you right now, shown
  // as a phone-style red count badge on its tile/avatar and as a list on
  // its page. Counts: each overdue task, a tracked problem, and — until it
  // has a care guide — each missing detail the guide needs. ----
  function plantAlerts(p){
    var items = [];
    var today = todayISO();
    var overdue = state.tasks.filter(function(t){ return t.plantId === p.id && t.status !== "done" && t.dueDate && t.dueDate < today; })
      .sort(function(a,b){ return a.dueDate.localeCompare(b.dueDate); });
    overdue.forEach(function(t){
      items.push({key:"task", text:t.title, sub:relativeDay(t.dueDate), btn:tr("Open"), fn:function(){ openTaskDetail(t.id, {allowComplete:true}); }});
    });
    if (p.healthStatus === "needs_attention"){
      items.push({key:"issue", text:(p.activeIssue && p.activeIssue.description) || tr("A problem is being tracked"), sub:tr("problem being tracked"), btn:tr("See issue"),
        fn:function(){ plantDetailTab = "issues"; openPlantDetail(p.id, {keepTab:true}); }});
    }
    if (!(p.researched && p.careProfile)){
      careReadiness(p).missing.forEach(function(m){
        items.push({key:m.key, text:m.label, sub:tr("needed for its care guide"), btn:tr("Add"),
          fn:function(){ openQuickAnswer(p, m.key); }});
      });
    }
    return {count:items.length, overdue:overdue.length, items:items};
  }
  function countBadge(n, extraClass){
    if (!n) return null;
    return el("span", {class:"count-badge" + (extraClass ? " " + extraClass : ""), "aria-label": trn(n, "1 notification", "{n} notifications")}, [n > 9 ? "9+" : String(n)]);
  }

  // The one-line status that goes on the bottom of a plant's rim:
  // {text, tone} — tone "warn" (overdue), "lock" (guide locked) or "".
  function plantRimStatus(p){
    var next = nextTaskFor(p.id);
    if (next){
      var cat = taskCategory(next);
      if (next.dueDate < todayISO()) return {text:"⚠ " + relativeDay(next.dueDate), tone:"warn"};
      return {text:cat.emoji + " " + tr("{job} {when}", {job:tr(cat.label), when:relativeDay(next.dueDate)}), tone:""};
    }
    if (!(p.researched && p.careProfile)){
      var rd = careReadiness(p);
      return rd.ready ? {text:"✨ " + tr("ready for a guide"), tone:""} : {text:"🔒 " + trn(rd.missing.length, "1 detail to go", "{n} details to go"), tone:"lock"};
    }
    return {text:"✓ " + tr("all caught up"), tone:""};
  }

  // A round plant tile: the photo (or emoji) in a circle, a ring around it
  // that fills with how well the app knows the plant, the level along the
  // top of the rim and what's next along the bottom, and a red count badge
  // for anything that needs you. The rim text follows the circle via SVG
  // textPath (top arc drawn left→right over the top, bottom arc left→right
  // under the bottom, so both read upright).
  var rimSeq = 0;
  function roundPlantTile(p){
    var k = plantKnowledge(p);
    var lvl = plantLevel(k.score);
    var alerts = plantAlerts(p);
    var status = plantRimStatus(p);
    var id = "rim" + (++rimSeq);
    var R = 68, C = 2 * Math.PI * R;
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 200 200");
    svg.setAttribute("class", "rt-ring");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML =
      '<defs>' +
        '<path id="' + id + 't" d="M 23,100 A 77,77 0 0 1 177,100"/>' +
        '<path id="' + id + 'b" d="M 10,100 A 90,90 0 0 0 190,100"/>' +
      '</defs>' +
      '<circle class="rt-band" cx="100" cy="100" r="84"/>' +
      '<circle class="rt-track" cx="100" cy="100" r="' + R + '"/>' +
      '<circle class="rt-fill" cx="100" cy="100" r="' + R + '" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (C * (1 - k.score / 100)).toFixed(1) + '" transform="rotate(-90 100 100)"/>' +
      '<text class="rt-text"><textPath href="#' + id + 't" startOffset="50%" text-anchor="middle"></textPath></text>' +
      '<text class="rt-text rt-text-bottom' + (status.tone ? " " + status.tone : "") + '"><textPath href="#' + id + 'b" startOffset="50%" text-anchor="middle"></textPath></text>';
    var paths = svg.querySelectorAll("textPath");
    paths[0].textContent = lvl.emoji + " " + lvl.name.toUpperCase() + " · " + k.score + "%";
    paths[1].textContent = status.text.toUpperCase();

    var disc = el("span", {class:"rt-disc", style:"--ph-color:" + plantColorFor(p.id) + ";"}, [
      el("span", {class:"rt-photo" + (p.healthStatus === "needs_attention" ? " attn" : "")}, [plantPhotoEl(p)]),
      svg,
      countBadge(alerts.count, "rt-badge")
    ]);
    var label = p.name + ", " + lvl.name + " " + k.score + "%, " + status.text.replace(/^[^\w\u0590-\u05FF]+/, "") + (alerts.count ? ", " + trn(alerts.count, "1 needs attention", "{n} need attention") : "");
    var tile = el("button", {class:"round-tile", "aria-label":label}, [
      disc,
      el("span", {class:"rt-name"}, [p.name]),
      el("span", {class:"rt-sub"}, [(p.type ? typeLabel(p.type) : tr("Plant")) + (p.spot ? " · " + optLabel(p.spot) : "")])
    ]);
    tile.addEventListener("click", function(){ openPlantDetail(p.id); });
    return tile;
  }
  function addPlantTile(){
    var tile = el("button", {class:"round-tile add"}, [
      el("span", {class:"rt-disc"}, [el("span", {class:"rt-photo rt-add"}, ["+"])]),
      el("span", {class:"rt-name"}, [tr("Add a plant")]),
      el("span", {class:"rt-sub"}, [" "])
    ]);
    tile.addEventListener("click", openPlantWizard);
    return tile;
  }

  // The plant page's notification list (same items as its badge).
  function plantAlertsBlock(p){
    var a = plantAlerts(p);
    if (!a.count) return null;
    var box = el("div", {class:"alerts-block"}, [
      el("div", {class:"alerts-head"}, [countBadge(a.count), el("span", {}, [trn(a.count, "1 thing needs you", "{n} things need you")])])
    ]);
    a.items.forEach(function(it){
      var b = el("button", {class:"btn btn-sm"}, [it.btn]);
      b.addEventListener("click", function(){ it.fn(); });
      box.appendChild(el("div", {class:"alert-row"}, [
        el("span", {class:"alert-dot", "aria-hidden":"true"}),
        el("span", {class:"alert-text"}, [el("b", {}, [it.text]), it.sub ? el("span", {class:"alert-sub"}, [it.sub]) : null]),
        b
      ]));
    });
    return box;
  }

  function openSettings(){
    var s = state.settings || {};
    showModal(function(container){
      container.appendChild(el("div", {class:"modal-head"}, [
        el("h3", {}, [tr("Settings")]),
        el("button", {class:"modal-close", "aria-label":tr("Close"), onclick:closeModal}, ["×"])
      ]));
      // Takes effect right away (and is saved) — the rest of the form
      // waits for Save.
      container.appendChild(el("div", {class:"field"}, [
        el("label", {}, [tr("Language")]),
        languagePicker(function(){ renderShell(); openSettings(); }),
        el("div", {style:"font-size:12px;color:var(--ink-faint);margin-top:4px;"}, [tr("The app, care guides, tips and answers are all written in this language.")])
      ]));
      // A GPS-only location is saved as "Current location"; ask for a real
      // name instead — it's what the AI uses to name the place (the
      // coordinates stay, for weather and the measured climate).
      var label = (s.location && s.location.label) || "";
      var locInput = el("input", {type:"text", value: /^(current location|unspecified)$/i.test(label) ? "" : label, placeholder:tr("Town and country, e.g. Modi'in, Israel")});
      container.appendChild(el("div", {class:"field"}, [
        el("label", {}, [tr("Garden location")]), locInput,
        el("div", {style:"font-size:12px;color:var(--ink-faint);margin-top:4px;"}, [s.location && s.location.lat != null
          ? tr("Used to time care guides and tips to your local climate (weather uses your saved GPS point).")
          : tr("Used to time care guides and tips to your local climate.")])
      ]));

      // Saved as the English day name (the daily job matches on it).
      var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      var daySelect = el("select", {}, days.map(function(d, i){
        var o = el("option", {value:d}, [dayName(i)]);
        if ((s.photoCheckinDay || "Friday") === d) o.setAttribute("selected","selected");
        return o;
      }));
      container.appendChild(el("div", {class:"field"}, [el("label", {}, [tr("Weekly photo check-in day")]), daySelect]));

      container.appendChild(el("p", {style:"font-size:12.5px;color:var(--ink-faint);margin:0 0 16px;"}, [
        tr("Weather and care checks run early each morning. New plants get researched within about an hour of adding them — no need to wait for the daily check-in.")
      ]));

      var rebuild = rebuildGuidesBlock();
      if (rebuild) container.appendChild(rebuild);

      var saveBtn = el("button", {class:"btn btn-primary btn-sm"}, [tr("Save")]);
      saveBtn.addEventListener("click", async function(){
        saveBtn.disabled = true; saveBtn.textContent = tr("Saving…");
        var loc = Object.assign({}, s.location, {label: locInput.value.trim() || label || "Unspecified"});
        try {
          await api("/settings", {method:"PATCH", body:{location:loc, photoCheckinDay:daySelect.value}});
        } catch(e){
          saveBtn.disabled = false; saveBtn.textContent = tr("Couldn't save — try again");
          return;
        }
        state.settings = Object.assign({}, state.settings, {location:loc, photoCheckinDay:daySelect.value});
        closeModal();
      });
      container.appendChild(saveBtn);
    });
  }

  // Settings' "Rebuild all care guides": re-runs every plant's care guide
  // (and its year of tasks) one after another — for after a language or
  // location change, so existing guides catch up. Pending care-guide tasks
  // are replaced; done ones stay.
  function rebuildGuidesBlock(){
    var plants = state.plants.filter(function(p){ return p.researched && p.careProfile; });
    if (!plants.length) return null;
    var status = el("div", {class:"thinking", style:"min-height:18px;margin-top:6px;"});
    var btn = el("button", {class:"btn btn-sm"}, [trn(plants.length, "Rebuild the care guide", "Rebuild all {n} care guides")]);
    btn.addEventListener("click", async function(){
      btn.disabled = true;
      var failed = [];
      for (var i = 0; i < plants.length; i++){
        status.textContent = tr("Rebuilding {name} ({n} of {total})…", {name:plants[i].name, n:i + 1, total:plants.length});
        if (!(await researchPlant(plants[i].id))) failed.push(plants[i].name);
      }
      try { await loadGardenData(); } catch(e){}
      btn.disabled = false;
      status.textContent = failed.length
        ? tr("Done, except: {names} — try again in a moment.", {names:failed.join(", ")})
        : tr("All care guides rebuilt.");
    });
    return el("div", {class:"field", style:"border-top:1px solid var(--line);padding-top:14px;"}, [
      el("label", {}, [tr("Care guides")]),
      el("div", {style:"font-size:12.5px;color:var(--ink-soft);margin-bottom:8px;"}, [tr("Rewrites each plant's care guide and its year of care tasks — in your language, for your location. About half a minute per plant.")]),
      btn, status
    ]);
  }

  // ---- Calendar section: Year/Month/Week views over the `tasks` collection. ----
  // Deliberately read-only for completion — tasks can be opened and reviewed
  // (comments/photo still allowed) but never marked done from here; that only
  // happens from the Tasks section. Spans Jan 1 of this year through the
  // next 12 months (care-guide tasks are scheduled on a rolling 12 months).
  var yearlyPlan = { mode:"month", anchor: isoDate(new Date().getFullYear(), new Date().getMonth()+1, 1) };

  function weekDatesFor(d){
    var start = new Date(d); start.setDate(start.getDate() - start.getDay());
    var days = [];
    for (var i=0;i<7;i++){ var x = new Date(start); x.setDate(start.getDate()+i); days.push(x); }
    return days;
  }
  function tasksByDateMap(){
    var map = {};
    state.tasks.forEach(function(t){ if (t.dueDate) (map[t.dueDate] = map[t.dueDate] || []).push(t); });
    return map;
  }
  // A compact color-key row mapping each plant to its dot color — without it
  // the calendar's dots would be unreadable, since they carry no text.
  function plantLegend(){
    if (state.plants.length === 0) return null;
    var wrap = el("div", {style:"display:flex;flex-wrap:wrap;gap:12px;margin-bottom:14px;padding:8px 10px;background:var(--surface-sunk);border-radius:8px;"});
    state.plants.forEach(function(p){
      wrap.appendChild(el("div", {style:"display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--ink-soft);"}, [
        el("span", {style:"width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;background:" + plantColorFor(p.id) + ";"}),
        p.name
      ]));
    });
    return wrap;
  }
  function yearlyPlanLabel(){
    var d = new Date(yearlyPlan.anchor + "T00:00:00");
    if (yearlyPlan.mode === "month") return monthName(d.getMonth()) + " " + d.getFullYear();
    var week = weekDatesFor(d), first = week[0], last = week[6];
    return shortDate(first) + " – " + shortDate(last) + ", " + last.getFullYear();
  }
  function shiftYearlyAnchor(dir){
    var now = new Date();
    var earliest = new Date(now.getFullYear(), 0, 1);
    var latest = new Date(now.getFullYear(), now.getMonth() + 12, 0); // end of the 12th month from now
    var d = new Date(yearlyPlan.anchor + "T00:00:00");
    if (yearlyPlan.mode === "month") d.setMonth(d.getMonth() + dir, 1);
    else d.setDate(d.getDate() + dir*7);
    if (d < earliest || d > latest) return;
    yearlyPlan.anchor = isoDate(d.getFullYear(), d.getMonth()+1, d.getDate());
  }

  function calendarSection(){
    var container = el("div", {class:"card"});
    container.appendChild(el("div", {class:"section-head"}, [el("h2", {}, [tr("Calendar")])]));
    if (state.plants.length === 0){
      container.appendChild(el("div", {class:"empty"}, [tr("Add a plant and its yearly schedule will show up here.")]));
      return container;
    }
    var anyResearched = state.plants.some(function(p){ return p.researched; });
    if (!anyResearched){
      container.appendChild(el("div", {class:"empty", style:"margin-bottom:10px;"}, [tr("Still building schedules for your plants — check back shortly.")]));
    }

    var yearBtn = el("button", {class:"btn btn-sm" + (yearlyPlan.mode==="year" ? "" : " btn-ghost")}, [tr("Year")]);
    var monthBtn = el("button", {class:"btn btn-sm" + (yearlyPlan.mode==="month" ? "" : " btn-ghost")}, [tr("Month")]);
    var weekBtn = el("button", {class:"btn btn-sm" + (yearlyPlan.mode==="week" ? "" : " btn-ghost")}, [tr("Week")]);
    yearBtn.addEventListener("click", function(){ yearlyPlan.mode = "year"; renderShell(); });
    monthBtn.addEventListener("click", function(){ yearlyPlan.mode = "month"; renderShell(); });
    weekBtn.addEventListener("click", function(){ yearlyPlan.mode = "week"; renderShell(); });
    var header = el("div", {class:"row", style:"justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;"}, [
      el("div", {class:"row", style:"gap:6px;"}, [yearBtn, monthBtn, weekBtn])
    ]);
    if (yearlyPlan.mode === "year"){
      header.appendChild(el("div", {style:"font-weight:600;font-size:14.5px;"}, [tr("Next 12 months")]));
    } else {
      // The row mirrors in right-to-left, so "previous" sits on the right.
      var rtl = I18N.isRTL();
      var prevBtn = el("button", {class:"btn btn-ghost btn-sm", "aria-label":tr("Previous")}, [rtl ? "→" : "←"]);
      var nextBtn = el("button", {class:"btn btn-ghost btn-sm", "aria-label":tr("Next")}, [rtl ? "←" : "→"]);
      prevBtn.addEventListener("click", function(){ shiftYearlyAnchor(-1); renderShell(); });
      nextBtn.addEventListener("click", function(){ shiftYearlyAnchor(1); renderShell(); });
      header.appendChild(el("div", {class:"row", style:"align-items:center;gap:8px;"}, [prevBtn, el("div", {style:"font-weight:600;font-size:14.5px;min-width:150px;text-align:center;"}, [yearlyPlanLabel()]), nextBtn]));
    }
    container.appendChild(header);
    container.appendChild(plantLegend());

    if (yearlyPlan.mode === "year") buildYearGrid(container);
    else {
      var anchorDate = new Date(yearlyPlan.anchor + "T00:00:00");
      if (yearlyPlan.mode === "month") buildMonthGrid(container, anchorDate);
      else buildWeekList(container, anchorDate);
    }
    return container;
  }

  // Year view: the next 12 months (this month first), one cell per month
  // with an open-task count; clicking a month drills into Month view.
  function buildYearGrid(container){
    var now = new Date();
    var map = tasksByDateMap();
    var grid = el("div", {style:"display:grid;grid-template-columns:repeat(3,1fr);gap:10px;"});
    for (var k=0; k<12; k++){
      var d = new Date(now.getFullYear(), now.getMonth() + k, 1);
      var prefix = isoDate(d.getFullYear(), d.getMonth()+1, 1).slice(0, 7);
      var count = 0;
      Object.keys(map).forEach(function(dateStr){
        if (dateStr.slice(0, 7) === prefix) count += map[dateStr].filter(function(t){ return t.status !== "done"; }).length;
      });
      var cell = el("button", {style:"text-align:start;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--surface);cursor:pointer;" + (k === 0 ? "box-shadow:inset 0 0 0 2px var(--moss);" : "")}, [
        el("div", {style:"font-weight:600;font-size:14px;margin-bottom:4px;"}, [monthName(d.getMonth()) + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "")]),
        el("div", {style:"font-size:12px;color:var(--ink-faint);"}, [trn(count, "1 open task", "{n} open tasks")])
      ]);
      cell.addEventListener("click", (function(y, m){ return function(){
        yearlyPlan.mode = "month";
        yearlyPlan.anchor = isoDate(y, m, 1);
        renderShell();
      }; })(d.getFullYear(), d.getMonth()+1));
      grid.appendChild(cell);
    }
    container.appendChild(grid);
  }

  function buildMonthGrid(container, anchor){
    var year = anchor.getFullYear(), month = anchor.getMonth();
    var map = tasksByDateMap();
    var startDow = new Date(year, month, 1).getDay();
    var daysInMonth = new Date(year, month+1, 0).getDate();
    var todayStr = todayISO();
    var totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;

    var grid = el("div", {style:"display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;"});
    for (var dw=0; dw<7; dw++){
      grid.appendChild(el("div", {style:"background:var(--surface-sunk);padding:6px 4px;font-size:10.5px;font-weight:700;text-align:center;color:var(--ink-faint);text-transform:uppercase;"}, [dayShort(dw)]));
    }
    for (var i=0;i<totalCells;i++){
      var dayNum = i - startDow + 1;
      if (dayNum < 1 || dayNum > daysInMonth){
        grid.appendChild(el("div", {style:"background:var(--surface);min-height:66px;"}));
        continue;
      }
      var dateStr = isoDate(year, month+1, dayNum);
      var dayTasks = map[dateStr] || [];
      var isToday = dateStr === todayStr;
      var cell = el("div", {style:"background:var(--surface);min-height:66px;padding:4px;display:flex;flex-direction:column;gap:4px;cursor:pointer;" + (isToday ? "box-shadow:inset 0 0 0 2px var(--moss);" : ""), title:tr("Show this week")});
      // Tapping a day opens its week as a readable list — the dots alone
      // are too small to hit reliably on a phone.
      cell.addEventListener("click", (function(ds){ return function(){ yearlyPlan.mode = "week"; yearlyPlan.anchor = ds; renderShell(); }; })(dateStr));
      cell.appendChild(el("div", {style:"font-size:11px;color:var(--ink-faint);font-weight:600;"}, [String(dayNum)]));
      if (dayTasks.length){
        var dots = el("div", {style:"display:flex;flex-wrap:wrap;gap:3px;"});
        dayTasks.slice(0,8).forEach(function(t){
          var dot = el("button", {
            title: t.title + (t.plantName ? " — " + t.plantName : "") + (t.status==="done" ? " (" + tr("done") + ")" : ""),
            style:"width:8px;height:8px;padding:0;border:none;border-radius:50%;cursor:pointer;flex:none;background:" + (t.plantId ? plantColorFor(t.plantId) : "var(--ink-faint)") + ";opacity:" + (t.status==="done" ? "0.35" : "1") + ";"
          });
          dot.addEventListener("click", (function(taskId){ return function(e){ e.stopPropagation(); openYearlyTaskDetail(taskId); }; })(t.id));
          dots.appendChild(dot);
        });
        cell.appendChild(dots);
        if (dayTasks.length > 8) cell.appendChild(el("div", {style:"font-size:9px;color:var(--ink-faint);"}, ["+" + (dayTasks.length-8)]));
      }
      grid.appendChild(cell);
    }
    container.appendChild(grid);
  }

  function buildWeekList(container, anchor){
    var days = weekDatesFor(anchor);
    var map = tasksByDateMap();
    var todayStr = todayISO();
    days.forEach(function(d){
      var dateStr = isoDate(d.getFullYear(), d.getMonth()+1, d.getDate());
      var dayTasks = map[dateStr] || [];
      var isToday = dateStr === todayStr;
      var section = el("div", {style:"margin-bottom:14px;"});
      section.appendChild(el("div", {style:"font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:" + (isToday?"var(--moss)":"var(--ink-faint)") + ";margin-bottom:6px;"}, [
        dayName(d.getDay()) + " · " + shortDate(d) + (isToday ? " · " + tr("today") : "")
      ]));
      if (dayTasks.length === 0){
        section.appendChild(el("div", {class:"empty", style:"padding:0 0 4px;"}, [tr("Nothing scheduled")]));
      } else {
        dayTasks.forEach(function(t){
          var row = el("button", {style:"display:flex;align-items:flex-start;gap:9px;width:100%;text-align:start;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:6px;background:var(--surface);cursor:pointer;" + (t.status==="done" ? "opacity:.55;" : "")}, [
            el("span", {style:"flex:none;width:9px;height:9px;margin-top:4px;border-radius:50%;background:" + (t.plantId ? plantColorFor(t.plantId) : "var(--ink-faint)") + ";"}),
            el("div", {style:"flex:1;min-width:0;"}, [
              el("div", {style:"font-size:13.5px;font-weight:600;color:var(--ink);" + (t.status==="done" ? "text-decoration:line-through;" : "")}, [t.title + (t.plantName ? " — " + t.plantName : "")]),
              t.description ? el("div", {style:"font-size:12px;color:var(--ink-soft);margin-top:2px;"}, [t.description]) : null
            ])
          ]);
          row.addEventListener("click", (function(taskId){ return function(){ openYearlyTaskDetail(taskId); }; })(t.id));
          section.appendChild(row);
        });
      }
      container.appendChild(section);
    });
  }

  function openYearlyTaskDetail(taskId){
    openTaskDetail(taskId, {allowComplete:false, onBack:function(){ state.section = "calendar"; closeModal(); }});
  }

  // Which tab is showing in the currently-open plant detail modal. Only one
  // plant modal is ever open at a time, so a single module-level var is fine.
  var plantDetailTab = "overview";

  async function openPlantDetail(id, opts){
    opts = opts || {};
    modalOpenFor = id;
    if (!opts.keepTab) plantDetailTab = "overview";
    var p = state.plants.find(function(x){ return x.id===id; });
    if (!p) return;
    showModal(function(container){
      // Hero: the latest photo full-bleed (or a colored placeholder), with
      // the name over it.
      var closeBtn = el("button", {class:"hero-close", "aria-label":tr("Close"), onclick:function(){ modalOpenFor=null; closeModal(); }}, ["×"]);
      container.appendChild(el("div", {class:"detail-hero"}, [
        plantPhotoEl(p),
        el("div", {class:"plant-overlay"}, [
          el("h3", {class:"plant-card-name", style:"color:inherit;"}, [p.name]),
          el("div", {class:"plant-card-sub"}, [[typeLabel(p.type), optLabel(p.spot), p.species].filter(Boolean).join(" · ")])
        ]),
        closeBtn
      ]));

      container.appendChild(plantLevelBlock(p));
      var alertsBlock = plantAlertsBlock(p);
      if (alertsBlock) container.appendChild(alertsBlock);

      var issueCount = state.tasks.filter(function(t){ return t.plantId === p.id && t.kind === "issue"; }).length;
      var tabs = [
        ["overview", tr("Overview")],
        ["care", tr("Care guide")],
        ["issues", tr("Issues") + ((p.activeIssue && p.activeIssue.description) ? " •" : (issueCount ? " (" + issueCount + ")" : ""))]
      ];
      var seg = el("div", {class:"seg", role:"tablist"});
      tabs.forEach(function(t){
        var b = el("button", {class: plantDetailTab === t[0] ? "active" : "", role:"tab", "aria-selected": plantDetailTab === t[0] ? "true" : "false"}, [t[1]]);
        b.addEventListener("click", function(){ plantDetailTab = t[0]; openPlantDetail(p.id, {keepTab:true, keepScroll:true}); });
        seg.appendChild(b);
      });
      container.appendChild(el("div", {class:"detail-tabs"}, [seg]));

      if (plantDetailTab === "care") buildPlantCareTab(container, p);
      else if (plantDetailTab === "issues") buildPlantIssuesTab(container, p);
      else buildPlantOverviewTab(container, p);
    }, {keepScroll: opts.keepScroll});
  }

  // "How well I know this plant" as a growth level (Seedling → Sprout →
  // Bloom), with a button for the single most useful next step instead of
  // a list of what's missing.
  function plantLevelBlock(p){
    var pk = plantKnowledge(p);
    var lvl = plantLevel(pk.score);
    var main = el("div", {class:"level-main"}, [
      el("div", {class:"level-title"}, [lvl.name, el("span", {}, [gradeLabelFor(pk.score) + " · " + pk.score + "%"])]),
      el("div", {class:"grade-track"}, [el("div", {class:"grade-fill", style:"width:" + pk.score + "%;"})])
    ]);
    var block = el("div", {class:"level-block"}, [el("span", {class:"level-emoji", "aria-hidden":"true"}, [lvl.emoji]), main]);
    // Care-guide details are already listed in the plant's notifications
    // (plantAlertsBlock, right below) — don't repeat them here.
    var next = pk.missing.filter(function(m){ return !m.unlocks; })[0];
    if (!next){
      main.appendChild(el("div", {class:"level-next"}, [pk.missing.length ? tr("Fill in what's listed below to unlock its care guide.") : tr("I know this plant well — keep the photos coming!")]));
      return block;
    }
    var stepLabel, stepFn;
    if (next.key === "guide"){
      stepLabel = tr("✨ Build care guide");
      stepFn = function(){ plantDetailTab = "care"; openPlantDetail(p.id, {keepTab:true, keepScroll:true}); };
    } else if (next.key === "photo"){
      stepLabel = tr("+ Add photo");
      stepFn = function(){
        // The photo picker lives on the Overview tab — open it there. Still
        // inside this click, so the browser allows opening the file picker.
        if (plantDetailTab !== "overview"){ plantDetailTab = "overview"; openPlantDetail(p.id, {keepTab:true, keepScroll:true}); }
        var input = document.querySelector("#modalContent .overview-photo-input");
        if (input) input.click();
      };
    } else {
      stepLabel = next.btn || ({age:tr("Add its age"), species:tr("Add species")})[next.key] || tr("Add");
      stepFn = function(){ openQuickAnswer(p, next.key); };
    }
    main.appendChild(el("div", {class:"level-next"}, [next.unlocks ? tr("Next step: {step} — it helps unlock the care guide.", {step:next.text}) : tr("Next step: {step}.", {step:next.text})]));
    var btn = el("button", {class:"btn btn-sm level-btn"}, [stepLabel]);
    btn.addEventListener("click", function(){ stepFn(btn); });
    block.appendChild(btn);
    return block;
  }

  // Growth journal: every photo as a dated card (newest first), plus a
  // draggable before/after comparison of the first and latest photo.
  function growthJournal(p){
    var wrap = el("div", {});
    var photos = (p.photos || []).slice();
    if (photos.length >= 2){
      var first = photos[0], latest = photos[photos.length-1];
      // Left-to-right in every language: first photo on the left, the
      // slider's value is the split position from the left edge.
      var cmp = el("div", {class:"compare", dir:"ltr", style:"--split:50%;"}, [
        el("img", {src:first.dataUrl, alt:tr("First photo")}),
        el("img", {class:"compare-after", src:latest.dataUrl, alt:tr("Latest photo")}),
        el("div", {class:"compare-line"}),
        el("span", {class:"compare-tag", style:"left:8px;"}, [fmtDate(first.date)]),
        el("span", {class:"compare-tag", style:"right:8px;"}, [tr("Now")])
      ]);
      var range = el("input", {type:"range", min:"0", max:"100", value:"50", "aria-label":tr("Compare first and latest photo")});
      range.addEventListener("input", function(){ cmp.style.setProperty("--split", range.value + "%"); });
      cmp.appendChild(range);
      wrap.appendChild(cmp);
      wrap.appendChild(el("div", {class:"hint", style:"font-size:12px;color:var(--ink-faint);margin-bottom:10px;"}, [tr("Drag to compare your first photo with the latest.")]));
    }
    var row = el("div", {class:"hscroll", style:"margin-bottom:8px;"});
    photos.slice().reverse().forEach(function(ph){
      row.appendChild(el("div", {class:"journal-card"}, [
        el("img", {src:ph.dataUrl, alt:tr("Photo from {date}", {date:fmtDate(ph.date)}), loading:"lazy"}),
        el("div", {class:"jc-body"}, [
          el("div", {class:"jc-date"}, [fmtDate(ph.date)]),
          (ph.summary || ph.userNote) ? el("div", {class:"jc-text"}, [ph.summary || ph.userNote]) : null
        ])
      ]));
    });
    wrap.appendChild(row);
    return wrap;
  }

  // A plantDetails entry can be either the plain string v12 first saved, or
  // (v13+) {raw, display} once answers started being normalized for display.
  // Read through this everywhere so old data keeps rendering correctly.
  function detailEntryOf(p, key){
    var v = (p.plantDetails||{})[key];
    if (!v) return null;
    if (typeof v === "string") return {raw:v, display:v};
    return v;
  }

  // ---- Overview tab, redesigned as a plant "profile" page: a short
  // species-level blurb up top (with a Read more → link into the Care guide,
  // rather than repeating that data here), then the profile itself — photo +
  // this specimen's own details, shown in clear standardized form rather than
  // the user's raw wording. Species-level research and "this specimen" status
  // used to be interleaved (an Age line here, the same age again in a details
  // list, an Update research button here for data shown on another tab) —
  // this version keeps each fact in exactly one place. ----
  function buildPlantOverviewTab(container, p){
    container.appendChild(el("div", {class:"section-head", style:"margin-bottom:4px;"}, [
      el("h3", {style:"font-size:13px;"}, [tr("About this {type}", {type: (function(){ var ty = p.type && p.type !== "other" ? typeLabel(p.type) : tr("plant"); return I18N.isRTL() ? ty : ty.toLowerCase(); })()})])
    ]));
    if (p.careProfile){
      var blurbBits = [p.careProfile.sun, p.careProfile.watering, p.careProfile.soil].filter(Boolean);
      var aboutRow = el("div", {style:"font-size:13.5px;color:var(--ink-soft);margin-bottom:16px;"});
      if (blurbBits.length) aboutRow.appendChild(document.createTextNode(blurbBits.join(" · ") + "  "));
      var readMoreBtn = el("button", {class:"btn btn-ghost btn-sm", style:"padding:2px 4px;"}, [tr("Read more →")]);
      readMoreBtn.addEventListener("click", function(){ plantDetailTab = "care"; openPlantDetail(p.id, {keepTab:true}); });
      aboutRow.appendChild(readMoreBtn);
      container.appendChild(aboutRow);
    } else {
      var rd = careReadiness(p);
      var goCare = el("button", {class:"link-btn"}, [rd.ready ? tr("Build it now →") : tr("See what's needed →")]);
      goCare.addEventListener("click", function(){ plantDetailTab = "care"; openPlantDetail(p.id, {keepTab:true, keepScroll:true}); });
      container.appendChild(el("div", {class:"about-locked"}, [
        el("span", {"aria-hidden":"true"}, [rd.ready ? "✨" : "🔒"]),
        el("span", {}, [(rd.ready ? tr("No care guide yet — it's ready to build.") : tr("No care guide yet — needs {missing}.", {missing:missingLabelList(rd.missing)})) + " "]),
        goCare
      ]));
    }

    container.appendChild(el("div", {class:"section-head", style:"margin-bottom:8px;"}, [
      el("h3", {style:"font-size:15px;"}, [tr("Growth journal")]),
      el("span", {class:"hint"}, [(p.photos && p.photos.length) ? trn(p.photos.length, "1 photo", "{n} photos") : tr("photos over time")])
    ]));

    if (p.photos && p.photos.length){
      container.appendChild(growthJournal(p));
      var latest = p.photos[p.photos.length-1];
      if (latest.summary) container.appendChild(el("div", {class:"agent-note", style:"margin-bottom:10px;"}, [latest.summary]));
    } else {
      container.appendChild(el("div", {class:"empty", style:"margin-bottom:8px;"}, [tr("No photos yet — add one and I'll start a journal so you can watch it grow.")]));
    }

    var noteInput = el("textarea", {placeholder:tr("Anything you've noticed? (optional)"), style:"margin-bottom:6px;min-height:44px;"});
    container.appendChild(noteInput);
    var addPhotoLabel = el("label", {class:"btn btn-sm", style:"display:inline-block;"}, [p.photos && p.photos.length ? tr("+ Update photo") : tr("+ Add photo")]);
    var addPhotoInput = el("input", {type:"file", accept:"image/*", class:"sr-only overview-photo-input"});
    addPhotoLabel.appendChild(addPhotoInput);
    var addPhotoResult = el("div", {});
    container.appendChild(addPhotoLabel);
    container.appendChild(addPhotoResult);
    addPhotoInput.addEventListener("change", async function(){
      var f = addPhotoInput.files[0]; if (!f) return;
      var dataUrl = await resizeImage(f);
      addPhotoResult.innerHTML = "";
      addPhotoResult.appendChild(el("img", {class:"photo-preview", src:dataUrl}));
      var thinking = el("div", {class:"thinking"}, [tr("Taking a look…")]);
      addPhotoResult.appendChild(thinking);
      var result = await analyzeAndApplyPlantPhoto(dataUrl, p, noteInput.value.trim());
      thinking.remove();
      if (!result){
        addPhotoResult.appendChild(el("div", {class:"empty"}, [tr(lastAnalysisMessage || ANALYZE_FAILED_MESSAGE)]));
        return;
      }
      if (result.__photoOnly){
        // Photo was saved even though it couldn't be analyzed — say so
        // plainly (and let the user dismiss it) rather than silently
        // reopening as if nothing happened.
        await loadGardenData();
        addPhotoResult.appendChild(el("div", {class:"empty"}, [tr(lastAnalysisMessage || PHOTO_ONLY_MESSAGE)]));
        var continueBtn = el("button", {class:"btn btn-sm", style:"margin-top:8px;"}, [tr("OK")]);
        continueBtn.addEventListener("click", function(){ openPlantDetail(p.id, {keepTab:true}); });
        addPhotoResult.appendChild(continueBtn);
        return;
      }
      await loadGardenData();
      openPlantDetail(p.id, {keepTab:true});
    });

    // Details, shown as a clean definition list — Size (AI-derived, read-only)
    // plus the five user-supplied facts, each rendered in its normalized
    // display form (see normalizeDetailAnswer) rather than the raw sentence
    // the user typed, with a single Add/Edit action per row.
    var detailsList = el("div", {style:"margin-top:14px;"});
    if (p.sizeInfo){
      var sizeRow = el("div", {class:"detail-row"}, [
        el("div", {style:"font-size:13px;"}, [el("span", {style:"color:var(--ink-faint);"}, [tr("Size") + " "]), p.sizeInfo]),
        el("span", {style:"font-size:11px;color:var(--ink-faint);"}, [tr("from photos")])
      ]);
      detailsList.appendChild(sizeRow);
    }
    [["spot",tr("Spot")],["species",tr("Species")]].forEach(function(f){
      var v = plantFieldValue(p, f[0]);
      var r = el("div", {class:"detail-row"}, [
        v ? el("div", {style:"font-size:13px;"}, [el("span", {style:"color:var(--ink-faint);"}, [f[1] + " "]), optLabel(v)])
          : el("div", {style:"font-size:13px;color:var(--ink-faint);"}, [tr("{label} — not set", {label:f[1]})])
      ]);
      var b = el("button", {class:"btn btn-ghost btn-sm"}, [v ? tr("Edit") : tr("Add")]);
      b.addEventListener("click", function(){ openQuickAnswer(p, f[0]); });
      r.appendChild(b);
      detailsList.appendChild(r);
    });
    GET_TO_KNOW_QUESTIONS.forEach(function(q, qi){
      var entry = detailEntryOf(p, q.key);
      var detailRow = el("div", {class:"detail-row"});
      var textPart = entry
        ? el("div", {style:"font-size:13px;"}, [el("span", {style:"color:var(--ink-faint);"}, [tr(q.shortLabel) + " "]), optLabel(entry.display || entry.raw)])
        : el("div", {style:"font-size:13px;color:var(--ink-faint);"}, [tr("{label} — not set", {label:tr(q.shortLabel)})]);
      detailRow.appendChild(textPart);
      var detailBtn = el("button", {class:"btn btn-ghost btn-sm"}, [entry ? tr("Edit") : tr("Add")]);
      detailBtn.addEventListener("click", function(){
        if (QUICK_FIELDS[q.key]) openQuickAnswer(p, q.key);
        else openGetToKnowPlant(p, {onlyIndex: qi});
      });
      detailRow.appendChild(detailBtn);
      detailsList.appendChild(detailRow);
    });
    container.appendChild(detailsList);

    var knowBtn = el("button", {class:"btn btn-sm", style:"margin-top:12px;"}, [tr("Walk through all details")]);
    knowBtn.addEventListener("click", function(){ openGetToKnowPlant(p); });
    container.appendChild(knowBtn);

    var addTaskBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-top:16px;display:block;"}, [tr("+ Add a task for this plant")]);
    addTaskBtn.addEventListener("click", function(){ modalOpenFor = null; openTaskForm(null, {plantId:p.id}); });
    container.appendChild(addTaskBtn);

    var askBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-top:4px;display:block;"}, [tr("Ask about this plant →")]);
    askBtn.addEventListener("click", function(){
      closeModal(); modalOpenFor=null;
      openAsk(tr("About my {name}: ", {name:p.name}));
    });
    container.appendChild(askBtn);

    var nTasks = state.tasks.filter(function(t){ return t.plantId === p.id; }).length;
    container.appendChild(el("div", {class:"danger-zone"}, [
      removePlantButton(p),
      el("div", {class:"danger-note"}, [nTasks
        ? trn(nTasks, "Deletes its photos, details and its 1 task. This can't be undone.", "Deletes its photos, details and its {n} tasks. This can't be undone.")
        : tr("Deletes its photos and details. This can't be undone.")])
    ]));
  }

  // ---- Care guide tab: species-level research, plus the "Update research"
  // action that overwrites it (moved here from Overview in v13, since it's
  // an action on exactly the data shown on this tab). ----
  function buildPlantCareTab(container, p){
    // No guide yet: the readiness checklist, with Build locked until the
    // plant's spot details are in.
    if (!p.careProfile){
      container.appendChild(careReadinessCard(p));
      return;
    }
    container.appendChild(el("div", {class:"section-head", style:"margin-bottom:8px;"}, [
      el("h3", {style:"font-size:15px;"}, [tr("Care guide")]),
      el("span", {class:"hint"}, [tr("for this plant, in its spot")])
    ]));
    var cg = el("dl", {class:"care-grid"});
    var fields = [["soil",tr("Soil / ground")],["sun",tr("Sunlight")],["watering",tr("Watering")],["nutrients",tr("Nutrients")],["pruning",tr("Pruning")],["frostSensitive",tr("Cold sensitivity")],["commonIssues",tr("Watch for")]];
    fields.forEach(function(f){
      if (p.careProfile[f[0]]) cg.appendChild(el("div", {}, [el("dt",{},[f[1]]), el("dd",{},[p.careProfile[f[0]]])]));
    });
    container.appendChild(cg);
    var researchBtn = el("button", {class:"btn btn-sm btn-ghost", style:"margin-top:8px;"}, [tr("Update care guide")]);
    researchBtn.title = tr("Rebuilds this guide from the species plus what you've told me about its spot. Won't touch its photos, details or health.");
    researchBtn.addEventListener("click", async function(){
      researchBtn.disabled = true; researchBtn.textContent = tr("Updating…");
      var ok = await researchPlant(p.id);
      if (ok){
        // Refresh everything (this plant, the grade bar, the yearly schedule
        // that now exists) and rebuild the modal fresh rather than patching
        // pieces by hand — that's what was leaving the card/schedule stale.
        await loadGardenData();
        openPlantDetail(p.id, {keepTab:true});
      } else {
        researchBtn.textContent = tr("Couldn't update — try again");
        researchBtn.disabled = false;
      }
    });
    container.appendChild(researchBtn);
  }

  // ---- Issues tab: everything issue-related for this plant in one place —
  // the currently-tracked problem (if any), the "Report a problem" entry
  // point (moved here from Overview since this is now its natural home),
  // and a history of every issue-kind task this plant has had, newest first.
  // Reuses taskListRow/openTaskDetail so each entry opens the same shared
  // detail (comments, photo, mark-done) as This week/Upcoming/the calendar. ----
  function buildPlantIssuesTab(container, p){
    container.appendChild(el("div", {class:"section-head", style:"margin-bottom:8px;"}, [
      el("h3", {style:"font-size:15px;"}, [tr("Tracked issues")]),
      el("span", {class:"hint"}, [tr("active + history")])
    ]));

    if (p.activeIssue && p.activeIssue.description){
      container.appendChild(el("div", {class:"agent-note", style:"margin-bottom:6px;"}, [
        tr("Currently tracking, since {date}: {issue}", {date:fmtDate(p.activeIssue.since), issue:p.activeIssue.description})
      ]));
      container.appendChild(el("div", {class:"empty", style:"margin-bottom:14px;"}, [tr("Each plant tracks one issue at a time — reporting a new problem below will replace this as the active issue.")]));
    } else {
      container.appendChild(el("div", {class:"empty", style:"margin-bottom:14px;"}, [tr("Nothing currently being tracked — looking healthy.")]));
    }

    var reportBtn = el("button", {class:"btn btn-sm", style:"margin-bottom:16px;"}, [p.activeIssue && p.activeIssue.description ? tr("Report a different problem") : tr("Report a problem")]);
    reportBtn.addEventListener("click", function(){ openReportProblem(p); });
    container.appendChild(reportBtn);

    var issueTasks = state.tasks
      .filter(function(t){ return t.plantId === p.id && t.kind === "issue"; })
      .sort(function(a,b){ return (b.createdAt||"").localeCompare(a.createdAt||""); });

    container.appendChild(el("div", {style:"font-size:12.5px;font-weight:600;color:var(--ink-soft);margin-bottom:6px;"}, [tr("History")]));
    if (issueTasks.length === 0){
      container.appendChild(el("div", {class:"empty"}, [tr("No issues reported yet for this plant.")]));
    } else {
      issueTasks.forEach(function(t){ container.appendChild(taskListRow(t)); });
    }
  }

  // Short, one-question-at-a-time intake for details only the user knows
  // firsthand about this specific plant (not the species-level research in
  // careProfile). Modeled on onboarding's step cards rather than a chat —
  // one question per screen, an optional Skip, then the next. Each answer
  // saves to plant.plantDetails immediately (not batched at the end), so
  // closing partway through never loses what's already been entered, and
  // any single detail can be revisited later — see the Profile section on
  // the Overview tab, which reopens this at opts.onlyIndex for just one
  // question instead of the whole sequence. Each saved answer also gets a
  // short normalized "display" form (normalizeDetailAnswer) so the profile
  // reads as clean facts rather than a transcript of the raw wording.
  var GET_TO_KNOW_QUESTIONS = [
    {key:"age", shortLabel:N_("Age"), label:N_("About how old is it?"), hint:N_("How old is this plant, or how long since you planted it?"), placeholder:N_("e.g. planted about 2 years ago")},
    {key:"yieldPerYear", shortLabel:N_("Yearly yield"), label:N_("How much does it produce each year?"), hint:N_("Roughly how many fruits, vegetables or flowers a year — skip if not applicable."), placeholder:N_("e.g. 20-30 lemons a season")},
    {key:"groundType", shortLabel:N_("Ground"), label:N_("What's the ground like there?"), hint:N_("Soil type or growing setup at its actual spot."), placeholder:N_("e.g. clay soil, raised bed, pot with drainage holes")},
    {key:"watering", shortLabel:N_("Watering"), label:N_("How do you water it?"), hint:N_("Method, and roughly how often."), placeholder:N_("e.g. drip irrigation every other day")},
    {key:"sunExposure", shortLabel:N_("Sun exposure"), label:N_("How much sun does that spot get?"), hint:N_("Sun exposure at its actual location."), placeholder:N_("e.g. full sun most of the day, shaded in the afternoon")}
  ];

  // Each answer is also turned into a short, standardized "display" label
  // (e.g. "planted about 2 years ago" -> "~2 years") — server-side now, in
  // api/plants/[id]/details.js (normalizeDetailAnswer). The raw text is
  // always kept too, and display falls back to it if normalization fails.

  function openGetToKnowPlant(p, opts){
    opts = opts || {};
    var onlyIndex = (opts.onlyIndex === undefined || opts.onlyIndex === null) ? null : opts.onlyIndex;
    var qIndex = onlyIndex !== null ? onlyIndex : (opts.step || 0);

    showModal(function(container){
      container.appendChild(el("div", {class:"modal-head"}, [
        el("h3", {style:"font-size:17px;"}, [tr("Get to know {name}", {name:p.name})]),
        el("button", {class:"modal-close", "aria-label":tr("Close"), onclick:closeModal}, ["×"])
      ]));
      var backBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-bottom:14px;"}, [tr("← Back to plant")]);
      backBtn.addEventListener("click", function(){ openPlantDetail(p.id, {keepTab:true}); });
      container.appendChild(backBtn);

      if (qIndex >= GET_TO_KNOW_QUESTIONS.length){
        container.appendChild(el("h2", {style:"font-size:18px;margin:2px 0 6px;"}, [tr("All set")]));
        container.appendChild(el("p", {class:"lead", style:"font-size:13.5px;margin:0 0 14px;"}, [
          tr("Saved what you told me — you can revisit any of these anytime from the Overview tab.")
        ]));
        var doneBtn = el("button", {class:"btn btn-primary"}, [tr("Back to plant")]);
        doneBtn.addEventListener("click", function(){ openPlantDetail(p.id, {keepTab:true}); });
        container.appendChild(doneBtn);
        return;
      }

      var q = GET_TO_KNOW_QUESTIONS[qIndex];
      if (onlyIndex === null){
        container.appendChild(el("div", {class:"empty", style:"margin-bottom:2px;"}, [tr("Question {n} of {total}", {n:qIndex+1, total:GET_TO_KNOW_QUESTIONS.length})]));
      }
      container.appendChild(el("h2", {style:"font-size:18px;margin:2px 0 4px;"}, [tr(q.label)]));
      container.appendChild(el("p", {class:"lead", style:"font-size:13px;margin:0 0 12px;"}, [tr(q.hint)]));

      var input = el("textarea", {placeholder:tr(q.placeholder), style:"min-height:56px;"});
      var existingEntry = detailEntryOf(p, q.key);
      if (existingEntry) input.value = existingEntry.raw;
      container.appendChild(input);

      var isLast = onlyIndex === null && qIndex === GET_TO_KNOW_QUESTIONS.length - 1;
      var skipBtn = el("button", {class:"btn btn-ghost"}, [tr("Skip")]);
      var nextBtn = el("button", {class:"btn btn-primary"}, [onlyIndex !== null ? tr("Save") : (isLast ? tr("Finish") : tr("Next →"))]);

      function advance(){
        if (onlyIndex !== null){ openPlantDetail(p.id, {keepTab:true}); }
        else { openGetToKnowPlant(p, {step: qIndex + 1}); }
      }
      skipBtn.addEventListener("click", function(){ advance(); });
      nextBtn.addEventListener("click", async function(){
        nextBtn.disabled = true; skipBtn.disabled = true; nextBtn.textContent = tr("Saving…");
        var val = input.value.trim();
        if (val){
          try {
            // Saves {raw, display} to plantDetails[q.key] (and ageEstimate for
            // "age") server-side, normalizing the display form there.
            await api("/plants/" + p.id + "/details", {method:"POST", body:{key:q.key, rawText:val}});
            await loadGardenData();
          } catch(e){
            nextBtn.disabled = false; skipBtn.disabled = false;
            nextBtn.textContent = tr("Couldn't save — try again");
            return;
          }
          var fresh = state.plants.find(function(x){ return x.id === p.id; });
          if (fresh) p = fresh;
        }
        advance();
      });
      container.appendChild(el("div", {class:"row", style:"justify-content:space-between;margin-top:14px;"}, [skipBtn, nextBtn]));
    });
  }

  // Issue report — description and/or a photo, for when the user notices
  // something and wants to flag it without going through the "+ Add a photo
  // update" flow. Runs through the same diagnosis→task pipeline as a photo
  // (reportPlantIssue → applyIssueDiagnosis), which now also accepts a photo.
  function openReportProblem(p){
    var pendingPhoto = null;
    showModal(function(container){
      container.appendChild(el("div", {class:"modal-head"}, [
        el("h3", {style:"font-size:17px;"}, [tr("Report a problem — {name}", {name:p.name})]),
        el("button", {class:"modal-close", "aria-label":tr("Close"), onclick:closeModal}, ["×"])
      ]));
      var backBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-bottom:14px;"}, [tr("← Back")]);
      backBtn.addEventListener("click", function(){ openPlantDetail(p.id, {keepTab:true}); });
      container.appendChild(backBtn);

      var descTa = el("textarea", {placeholder:tr("What are you seeing? e.g. “leaves are turning yellow at the tips”"), style:"min-height:70px;"});
      container.appendChild(el("div", {class:"field"}, [el("label",{},[tr("Describe the problem")]), descTa]));

      var photoResult = el("div", {});
      var photoLabel = el("label", {class:"btn btn-sm", style:"margin-bottom:10px;display:inline-block;"}, [tr("+ Attach a photo (optional)")]);
      var photoInput = el("input", {type:"file", accept:"image/*", class:"sr-only"});
      photoLabel.appendChild(photoInput);
      container.appendChild(photoLabel);
      container.appendChild(photoResult);
      photoInput.addEventListener("change", async function(){
        var f = photoInput.files[0]; if (!f) return;
        pendingPhoto = await resizeImage(f);
        photoResult.innerHTML = "";
        photoResult.appendChild(el("img", {class:"photo-preview", src:pendingPhoto, style:"max-width:200px;"}));
        photoLabel.textContent = tr("Photo attached — tap to replace");
        photoLabel.appendChild(photoInput);
      });

      var resultBox = el("div", {});
      var submitBtn = el("button", {class:"btn btn-primary btn-sm", style:"margin-top:14px;"}, [tr("Submit")]);
      submitBtn.addEventListener("click", async function(){
        var text = descTa.value.trim();
        if (!text && !pendingPhoto) return;
        submitBtn.disabled = true; submitBtn.textContent = tr("Thinking…");
        var result = await reportPlantIssue(p, text, pendingPhoto);
        submitBtn.disabled = false; submitBtn.textContent = tr("Submit");
        resultBox.innerHTML = "";
        if (!result){
          resultBox.appendChild(el("div", {class:"empty"}, [tr(lastAnalysisMessage || ANALYZE_FAILED_MESSAGE)]));
          try { await loadGardenData(); } catch(e){}
          return;
        }
        await loadGardenData();
        resultBox.appendChild(el("div", {class:"agent-note"}, [result.summary || tr("Got it — I've added care tasks.")]));
        if (!result.__photoOnly){
          resultBox.appendChild(el("div", {class:"chip chip-warn", style:"margin-top:8px;"}, [tr("Care tasks added — see This week")]));
        }
        var doneBtn = el("button", {class:"btn btn-sm", style:"margin-top:12px;display:block;"}, [tr("Back to plant")]);
        doneBtn.addEventListener("click", function(){ openPlantDetail(p.id, {keepTab:true}); });
        resultBox.appendChild(doneBtn);
      });
      container.appendChild(submitBtn);
      container.appendChild(resultBox);
    });
  }

  // On phones the modal is a bottom sheet (CSS): the handle at its top can
  // be dragged down to dismiss it. opts.keepScroll keeps the sheet's scroll
  // position when rebuilding the same modal in place (e.g. switching tabs).
  function showModal(build, opts){
    opts = opts || {};
    var overlay = document.getElementById("overlay");
    var content = document.getElementById("modalContent");
    var wasHidden = overlay.hidden;
    var scroll = content.scrollTop;
    content.innerHTML = "";
    content.removeAttribute("data-tips-month"); // set by the All tips sheet while it waits for a month to load
    var handle = el("div", {class:"sheet-handle", "aria-hidden":"true"});
    content.appendChild(handle);
    attachSheetDrag(handle, content);
    build(content);
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    content.scrollTop = (!wasHidden && opts.keepScroll) ? scroll : 0;
  }
  function attachSheetDrag(handle, sheet){
    var startY = null;
    handle.addEventListener("pointerdown", function(e){
      startY = e.clientY;
      try { handle.setPointerCapture(e.pointerId); } catch(err){}
      sheet.style.transition = "none";
    });
    handle.addEventListener("pointermove", function(e){
      if (startY === null) return;
      sheet.style.transform = "translateY(" + Math.max(0, e.clientY - startY) + "px)";
    });
    function end(e){
      if (startY === null) return;
      var dy = e.clientY - startY;
      startY = null;
      sheet.style.transition = "transform .2s ease";
      if (dy > 110){
        sheet.style.transform = "translateY(100%)";
        setTimeout(function(){ sheet.style.transform = ""; sheet.style.transition = ""; closeModal(); }, 180);
      } else {
        sheet.style.transform = "";
      }
    }
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  function closeModal(){
    document.getElementById("overlay").hidden = true;
    document.body.style.overflow = "";
    modalOpenFor = null;
    // The section behind the modal was frozen while it was open (live updates
    // still landed in `state`, they just weren't drawn) — repaint now so the
    // knowledge bar, status chips and task list reflect whatever just happened.
    renderShell();
  }
  document.getElementById("overlay").addEventListener("click", function(e){
    if (e.target.id === "overlay") closeModal();
  });
  document.addEventListener("keydown", function(e){
    if (e.key !== "Escape") return;
    if (!document.getElementById("overlay").hidden) closeModal();
    else if (!document.getElementById("askPanel").hidden) document.getElementById("askPanel").hidden = true;
  });

  // ---------------------------------------------------------------
  // ASK PANEL
  // ---------------------------------------------------------------
  var askTurns = [];
  // The garden-context system message (location + plant list) is built
  // server-side from the database now — see api/ask.js.
  function openAsk(prefill){
    document.getElementById("askPanel").hidden = false;
    renderAskBody();
    document.getElementById("askInput").value = prefill || "";
    document.getElementById("askInput").focus();
  }
  document.getElementById("askFab").addEventListener("click", function(){ openAsk(""); });
  document.getElementById("askClose").addEventListener("click", function(){ document.getElementById("askPanel").hidden = true; });
  document.getElementById("askSend").addEventListener("click", sendAsk);
  document.getElementById("askInput").addEventListener("keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); sendAsk(); }
  });
  async function sendAsk(){
    var input = document.getElementById("askInput");
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    askTurns.push({role:"user", content:text});
    renderAskBody();
    var body = document.getElementById("askBody");
    var thinking = el("div", {class:"thinking"}, [tr("Thinking…")]);
    body.appendChild(thinking);
    body.scrollTop = body.scrollHeight;
    try {
      var res = await api("/ask", {method:"POST", body:{turns:askTurns}});
      askTurns.push({role:"assistant", content:(res && res.text) || tr("Sorry, I couldn't answer that just now.")});
    } catch(e){
      askTurns.push({role:"assistant", content:tr("Sorry, I couldn't answer that just now.")});
    }
    renderAskBody();
  }
  function renderAskBody(){
    var body = document.getElementById("askBody");
    body.innerHTML = "";
    if (askTurns.length === 0){
      body.appendChild(el("div", {class:"bubble assistant"}, [tr("Ask me anything about your garden — what to do this week, how a plant's doing, or general advice.")]));
    }
    askTurns.forEach(function(t){ body.appendChild(el("div", {class:"bubble " + t.role}, [t.content])); });
    body.scrollTop = body.scrollHeight;
  }

  applyStaticText();
  boot();
})();
