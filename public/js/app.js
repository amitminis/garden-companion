// Garden Companion — web app frontend.
// Ported from garden-companion.html (the Claude Artifact). Same UI, copy and
// behavior; the Artifact's claude.use("db") / claude.use("sample") calls are
// replaced with fetch() against the /api Vercel Functions.
(function(){
  "use strict";

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
    try { return new Date(d).toLocaleDateString(undefined, {weekday:"short", month:"short", day:"numeric"}); }
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
      var res = await fetch("https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=" + lat + "&longitude=" + lon + "&localityLanguage=en");
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
  var PHOTO_ONLY_MESSAGE = "Photo saved — analysis isn't available right now, but the photo itself is kept.";
  var ANALYZE_FAILED_MESSAGE = "Couldn't analyze that — try again.";
  var ANALYZE_FAILED_PHOTO_KEPT_MESSAGE = "Couldn't analyze that — the photo is saved, but try again for a diagnosis.";
  var lastAnalysisMessage = null;

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  var state = { settings:null, plants:[], tasks:[], weather:null, section:"tasks" };
  var MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  var DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
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

  // What kind of job a task is, guessed from its wording — drives the row
  // icon, the library card's "next care" line and the weekly summary.
  var TASK_CATEGORIES = [
    {key:"water",   icon:"drop",     emoji:"💧", verb:"watered",      re:/water|irrigat|soak|drip/},
    {key:"prune",   icon:"scissors", emoji:"✂️", verb:"pruned",       re:/prun|trim|deadhead|cut back|pinch/},
    {key:"harvest", icon:"basket",   emoji:"🧺", verb:"harvested",    re:/harvest|pick |collect/},
    {key:"photo",   icon:"camera",   emoji:"📷", verb:"took photos",  re:/photo|picture|check-in|checkin/},
    {key:"treat",   icon:"bug",      emoji:"🐛", verb:"treated pests & problems", re:/pest|aphid|bug|spray|fung|mildew|yellow|disease|rot|slug/},
    {key:"plant",   icon:"seedling", emoji:"🌱", verb:"planted & sowed", re:/sow|seed|plant |bulb|transplant|pot up|repot/},
    {key:"feed",    icon:"leaf",     emoji:"🍃", verb:"fed & mulched", re:/fertili|feed|compost|mulch|manure/}
  ];
  var OTHER_CATEGORY = {key:"other", icon:"leaf", emoji:"🍃", verb:"did other jobs"};
  function taskCategory(t){
    var text = " " + (t.title || "").toLowerCase() + " ";
    for (var i=0;i<TASK_CATEGORIES.length;i++){ if (TASK_CATEGORIES[i].re.test(text)) return TASK_CATEGORIES[i]; }
    if (t.kind === "issue") return TASK_CATEGORIES[4];
    return OTHER_CATEGORY;
  }

  var TYPE_EMOJI = {tree:"🌳", bush:"🪴", flower:"🌸", vegetable:"🥕", herb:"🌿", other:"🌱"};
  function typeEmoji(type){ return TYPE_EMOJI[type] || TYPE_EMOJI.other; }

  // Knowledge score -> a friendlier growth "level" (same thresholds as
  // gradeLabelFor).
  function plantLevel(score){
    if (score >= 80) return {emoji:"🌸", name:"Bloom"};
    if (score >= 50) return {emoji:"🌿", name:"Sprout"};
    return {emoji:"🌱", name:"Seedling"};
  }

  // Whole days from today to an ISO date (negative = past).
  function daysFromToday(iso){
    var a = new Date(todayISO() + "T00:00:00"), b = new Date(iso + "T00:00:00");
    return Math.round((b - a) / 86400000);
  }
  function relativeDay(iso){
    if (!iso) return "";
    var n = daysFromToday(iso);
    if (n < -1) return Math.abs(n) + " days overdue";
    if (n === -1) return "yesterday";
    if (n === 0) return "today";
    if (n === 1) return "tomorrow";
    if (n < 7) return "in " + n + " days";
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
        '<div class="onboard-card card" style="text-align:center;"><h2>Couldn\'t reach the garden</h2>'+
        '<p class="lead">Garden Companion can\'t reach its saved garden data right now. Check your connection and try again.</p>'+
        '<button class="btn btn-primary" onclick="location.reload()">Try again</button></div>';
      return;
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
    return ["tree","bush","flower","vegetable","herb","other"].map(function(t){
      var o = el("option", {value:t}, [t.charAt(0).toUpperCase() + t.slice(1)]);
      if (selectedType === t) o.setAttribute("selected","selected");
      return o;
    });
  }
  var SPOT_OPTIONS = ["Front yard","Backyard","Side yard","Patio / pots","Raised bed","Greenhouse","Balcony","Windowsill"];
  function spotPicker(existingSpot){
    var isCustom = !!existingSpot && SPOT_OPTIONS.indexOf(existingSpot) === -1;
    var select = el("select", {}, [el("option", {value:""}, ["Choose a spot…"])].concat(
      SPOT_OPTIONS.map(function(s){ var o = el("option", {value:s}, [s]); if (existingSpot===s) o.setAttribute("selected","selected"); return o; }),
      [el("option", {value:"__custom__"}, ["Other / describe…"])]
    ));
    if (isCustom) select.value = "__custom__";
    var customInput = el("input", {type:"text", placeholder:"Describe the spot", value: isCustom ? existingSpot : "", style: isCustom ? "margin-top:6px;" : "display:none;margin-top:6px;"});
    select.addEventListener("change", function(){
      customInput.style.display = select.value === "__custom__" ? "" : "none";
    });
    return { select: select, customInput: customInput, getValue: function(){ return select.value === "__custom__" ? customInput.value.trim() : select.value; } };
  }

  // Dropdown option lists for the plant wizard's "get to know it" fields —
  // plain option pickers (no free-text) since these values feed straight
  // into the AI care-card prompt as clean short labels.
  var AGE_OPTIONS = ["Just planted","Less than 1 year","1–2 years","3–5 years","More than 5 years","Not sure"];
  var SUN_OPTIONS = ["Full sun (6+ hrs)","Partial sun (4–6 hrs)","Partial shade (2–4 hrs)","Full shade (under 2 hrs)","Not sure"];
  var WATERING_OPTIONS = ["Drip irrigation","Sprinkler","Hand watering","Rain-fed only","Not sure"];
  var GROUND_OPTIONS = ["Clay soil","Sandy soil","Loamy soil","Raised bed","Pot / container","Not sure"];
  function simpleSelect(options, selected, placeholder){
    var opts = [el("option", {value:""}, [placeholder || "Choose…"])].concat(options.map(function(o){
      var opt = el("option", {value:o}, [o]);
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
      el("div", {class:"onboard-step-label"}, ["Welcome"]),
      el("h2", {}, ["Let's set up your garden"]),
      el("p", {class:"lead"}, ["I'll ask where you're gardening, get to know what you're growing, and take a look at a few photos. After that I'll check on things every day — weather, what's due for pruning or sowing, and how your plants are doing."]),
      el("button", {class:"btn btn-primary", onclick:function(){ onboard.step=1; renderOnboarding(); }}, ["Start setup →"])
    ]);
  }

  function stepLocation(){
    var card = el("div", {class:"onboard-card card"}, [
      progressDots(0),
      el("div", {class:"onboard-step-label"}, ["Step 1 of 3"]),
      el("h2", {}, ["Where's your garden?"]),
      el("p", {class:"lead"}, ["This sets your weather, frost dates, and planting calendar."])
    ]);
    var status = el("div", {class:"thinking", style:"margin-bottom:12px;"});
    var confirmBox = el("div", {});
    var manual = el("input", {type:"text", placeholder:"City, region or country", value: onboard.location && onboard.location.label || ""});
    var gpsBtn = el("button", {class:"btn", style:"margin-bottom:14px;"}, ["Use my current location"]);
    gpsBtn.addEventListener("click", function(){
      if (!navigator.geolocation){ status.textContent = "Location services aren't available here — type it in below."; return; }
      confirmBox.innerHTML = "";
      status.textContent = "Locating…";
      navigator.geolocation.getCurrentPosition(async function(pos){
        var lat = pos.coords.latitude, lon = pos.coords.longitude;
        status.textContent = "Got your coordinates — looking up the city name…";
        var cityLabel = await reverseGeocodeCity(lat, lon);
        status.textContent = "";
        if (!cityLabel){
          status.textContent = "Got your coordinates, but couldn't look up a city name — type one in below.";
          return;
        }
        // Don't commit the detected city as the location yet — show it and
        // let the user approve it (or fix it) before it's saved.
        confirmBox.innerHTML = "";
        confirmBox.appendChild(el("div", {class:"card", style:"padding:12px 14px;margin-bottom:14px;"}, [
          el("div", {style:"font-size:12.5px;color:var(--ink-faint);margin-bottom:4px;"}, ["We found:"]),
          el("div", {style:"font-weight:600;font-size:14.5px;margin-bottom:10px;"}, [cityLabel]),
          el("div", {class:"row", style:"gap:8px;"}, [
            (function(){
              var useBtn = el("button", {class:"btn btn-primary btn-sm"}, ["✓ Use this"]);
              useBtn.addEventListener("click", function(){
                onboard.location = { label: cityLabel, lat: lat, lon: lon };
                manual.value = cityLabel;
                confirmBox.innerHTML = "";
                status.textContent = "Using " + cityLabel + ".";
              });
              return useBtn;
            })(),
            (function(){
              var editBtn = el("button", {class:"btn btn-ghost btn-sm"}, ["Edit manually"]);
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
        status.textContent = "Couldn't get your location — type it in below instead.";
      }, {timeout:8000});
    });
    card.appendChild(gpsBtn);
    card.appendChild(status);
    card.appendChild(confirmBox);
    card.appendChild(el("div", {class:"field"}, [
      el("label", {}, ["Or enter it manually"]),
      manual
    ]));
    var nextBtn = el("button", {class:"btn btn-primary"}, ["Continue →"]);
    nextBtn.addEventListener("click", function(){
      if (!onboard.location) onboard.location = {};
      onboard.location.label = manual.value || onboard.location.label || "Unspecified";
      onboard.step = 2;
      renderOnboarding();
    });
    var row = el("div", {class:"row", style:"justify-content:space-between;margin-top:6px;"}, [
      el("button", {class:"btn btn-ghost", onclick:function(){ onboard.step=0; renderOnboarding(); }}, ["← Back"]),
      nextBtn
    ]);
    card.appendChild(row);
    return card;
  }

  // ---- "Start building your library now?" (onboarding only) ----
  function stepStartLibrary(){
    var card = el("div", {class:"onboard-card card"}, [
      progressDots(1, 3),
      el("div", {class:"onboard-step-label"}, ["Step 2 of 3"]),
      el("h2", {}, ["Want to start adding plants to your garden now?"]),
      el("p", {class:"lead"}, ["I'll guide you through adding each plant with a short form — or you can skip this and do it anytime from the My garden section."])
    ]);
    var yesBtn = el("button", {class:"btn btn-primary"}, ["Yes, let's add plants"]);
    yesBtn.addEventListener("click", function(){ onboard.step=3; onboard.wiz=null; renderOnboarding(); });
    var noBtn = el("button", {class:"btn btn-ghost"}, ["Not now"]);
    noBtn.addEventListener("click", function(){ onboard.step=4; renderOnboarding(); });
    card.appendChild(el("div", {class:"row", style:"gap:10px;margin-top:6px;"}, [yesBtn, noBtn]));
    card.appendChild(el("div", {class:"row", style:"justify-content:flex-start;margin-top:16px;"}, [
      el("button", {class:"btn btn-ghost", onclick:function(){ onboard.step=1; renderOnboarding(); }}, ["← Back"])
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
      el("div", {class:"onboard-step-label"}, ["All set"]),
      el("h2", {}, ["All set"]),
      el("p", {class:"lead"}, [onboard.addedAny
        ? "Your garden is saved — care guides and yearly schedules are ready for what you've added."
        : "Your garden is set up. Add plants anytime from the My garden section."])
    ]);
    var finishBtn = el("button", {class:"btn btn-primary"}, ["Go to my garden →"]);
    finishBtn.addEventListener("click", async function(){
      finishBtn.disabled = true;
      try {
        await api("/settings", {method:"PATCH", body:{onboarded:true}});
        state.settings = Object.assign({}, state.settings, {onboarded:true});
        await loadGardenData();
      } catch(e){
        finishBtn.disabled = false;
        finishBtn.textContent = "Couldn't reach the garden — try again";
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
      {key:"name", question:"What's this plant called?", kind:"text", required:true, placeholder:"e.g. Meyer lemon tree"},
      {key:"type", question:"What type of plant is it?", kind:"type"},
      {key:"spot", question:"Where in the garden is it?", kind:"spot"},
      {key:"species", question:"Species or variety?", kind:"text", placeholder:"Optional — e.g. Citrus × meyeri"},
      {key:"age", question:"About how old is it?", kind:"select", options:AGE_OPTIONS},
      {key:"sunExposure", question:"How much sun does that spot get?", kind:"select", options:SUN_OPTIONS},
      {key:"watering", question:"How do you water it?", kind:"select", options:WATERING_OPTIONS},
      {key:"groundType", question:"What's the ground like there?", kind:"select", options:GROUND_OPTIONS},
      {key:"notes", question:"Anything else worth noting?", kind:"textarea", placeholder:"Optional"}
    ];
  }
  function wizardTotalSteps(){ return wizardFieldMeta().length + 3; } // fields + photos + review + result
  function wizardProgress(step, total){
    var pct = Math.round((Math.min(step,total-1)/(total-1))*100);
    return el("div", {style:"margin-bottom:14px;"}, [
      el("div", {style:"font-size:11.5px;color:var(--ink-faint);margin-bottom:4px;"}, ["Step " + (Math.min(step,total-1)+1) + " of " + total]),
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
      input = simpleSelect(field.options, wiz[field.key], "Not sure / skip");
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
      var backBtn = el("button", {class:"btn btn-ghost"}, ["← Back"]);
      backBtn.addEventListener("click", function(){ wiz[field.key] = readValue(); wiz.step--; opts.rerender(); });
      row.appendChild(backBtn);
    } else {
      row.appendChild(el("div", {}));
    }
    var nextBtn = el("button", {class:"btn btn-primary"}, ["Next →"]);
    nextBtn.addEventListener("click", function(){
      var val = readValue();
      if (field.required && !val){ formError.textContent = "This one's required."; return; }
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
    card.appendChild(el("h2", {style:"font-size:18px;"}, ["Add a photo or two?"]));
    card.appendChild(el("p", {class:"lead", style:"font-size:13px;"}, ["Optional — helps build a more accurate care card and lets me track size and health over time. Up to 3."]));

    var thumbs = el("div", {style:"display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;"});
    function renderThumbs(){
      thumbs.innerHTML = "";
      wiz.photos.forEach(function(dataUrl, i){
        var wrap = el("div", {style:"position:relative;"});
        wrap.appendChild(el("img", {src:dataUrl, style:"width:72px;height:72px;object-fit:cover;border-radius:8px;display:block;"}));
        var rm = el("button", {class:"btn btn-ghost btn-sm", style:"position:absolute;top:-8px;right:-8px;padding:1px 6px;background:var(--surface);border-radius:50%;"}, ["✕"]);
        rm.addEventListener("click", function(){ wiz.photos.splice(i,1); opts.rerender(); });
        wrap.appendChild(rm);
        thumbs.appendChild(wrap);
      });
    }
    renderThumbs();
    card.appendChild(thumbs);

    if (wiz.photos.length < 3){
      var pick = el("label", {class:"btn btn-sm"}, ["+ Add a photo"]);
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
      el("button", {class:"btn btn-ghost"}, ["← Back"]),
      el("button", {class:"btn btn-primary"}, ["Next →"])
    ]);
    row.children[0].addEventListener("click", function(){ wiz.step--; opts.rerender(); });
    row.children[1].addEventListener("click", function(){ wiz.step++; opts.rerender(); });
    card.appendChild(row);
    return card;
  }

  function wizardReviewRow(label, value){
    return value ? el("div", {class:"row", style:"justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line);font-size:13px;"}, [
      el("span", {style:"color:var(--ink-faint);"}, [label]), el("span", {style:"font-weight:600;text-align:right;"}, [value])
    ]) : null;
  }

  function wizardReviewStep(wiz, opts){
    var card = el("div", {class:"onboard-card card"});
    card.appendChild(wizardProgress(wiz.step, wizardTotalSteps()));
    card.appendChild(el("h2", {style:"font-size:18px;"}, ["Ready to build " + (wiz.name||"this plant") + "'s card"]));
    card.appendChild(el("p", {class:"lead", style:"font-size:13px;"}, ["Double-check what you've entered, then I'll put together its care guide."]));

    var list = el("div", {style:"margin-bottom:12px;"});
    [["Name",wiz.name],["Type",wiz.type],["Spot",wiz.spot],["Species",wiz.species],
     ["Age",wiz.age],["Sun exposure",wiz.sunExposure],["Watering",wiz.watering],["Ground",wiz.groundType],
     ["Notes",wiz.notes]].forEach(function(pair){
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
        el("span", {}, ["I'll need " + missingLabelList(wizReady.missing) + " before I can write its care guide. You can save it now and add those from its page later — or go back and fill them in."])
      ]));
    }

    if (wiz.buildError) card.appendChild(el("div", {class:"empty", style:"margin-bottom:8px;"}, [wiz.buildError]));

    var row = el("div", {class:"row", style:"justify-content:space-between;margin-top:6px;"});
    var backBtn = el("button", {class:"btn btn-ghost"}, ["← Back"]);
    backBtn.addEventListener("click", function(){ wiz.step--; opts.rerender(); });
    var buildBtn = el("button", {class:"btn btn-primary"}, [wiz.building ? (wizReady.ready ? "Building…" : "Saving…") : (wizReady.ready ? "Build my plant card →" : "Save plant →")]);
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
          wiz.buildError = "Couldn't save this plant — try again.";
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
          ? "Saved, but couldn't build the care card just now — try again."
          : "Couldn't save this plant — try again.";
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
    card.appendChild(el("h2", {style:"font-size:18px;"}, [ok ? (wiz.name + "'s card is ready") : (wiz.name + " is saved")]));
    if (wiz.savedWithoutGuide){
      card.appendChild(el("p", {class:"lead"}, ["🔒 Its care guide unlocks once you add " + wiz.savedWithoutGuide + " — open " + wiz.name + " from My garden and tap “Care guide”."]));
    } else if (ok){
      var cg = el("dl", {class:"care-grid", style:"margin-bottom:6px;"});
      [["soil","Soil"],["sun","Sun"],["watering","Watering"],["pruning","Pruning"]].forEach(function(f){
        if (plant.careProfile[f[0]]) cg.appendChild(el("div", {}, [el("dt",{},[f[1]]), el("dd",{},[plant.careProfile[f[0]]])]));
      });
      card.appendChild(cg);
      if (plant.sizeInfo || plant.healthStatus === "needs_attention"){
        card.appendChild(el("div", {class:"agent-note", style:"margin-top:8px;"}, [
          (plant.sizeInfo ? plant.sizeInfo + ". " : "") + (plant.photos && plant.photos.length && plant.photos[plant.photos.length-1].summary || "")
        ]));
      }
    } else {
      card.appendChild(el("p", {class:"lead"}, ["Saved — I couldn't finish building the care card just now, but you can retry anytime from its Care guide tab."]));
    }

    var row = el("div", {class:"row", style:"justify-content:space-between;margin-top:16px;"});
    var addAnotherBtn = el("button", {class:"btn btn-ghost"}, ["+ Add another plant"]);
    addAnotherBtn.addEventListener("click", function(){
      var fresh = createWizardState();
      Object.keys(fresh).forEach(function(k){ wiz[k] = fresh[k]; });
      opts.rerender();
    });
    var doneBtn = el("button", {class:"btn btn-primary"}, ["Done"]);
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
          el("h3", {}, ["Add a plant"]),
          el("button", {class:"modal-close", onclick:closeModal}, ["×"])
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
    {key:"spot",        label:"Where it's planted", todo:"tell me where it's planted", btn:"Add its spot"},
    {key:"sunExposure", label:"Sun exposure",       todo:"add its sun exposure",       btn:"Add sun exposure"},
    {key:"watering",    label:"How it's watered",   todo:"add how it's watered",       btn:"Add watering"},
    {key:"groundType",  label:"Soil / ground",      todo:"add its soil type",          btn:"Add soil type"}
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
      return {key:f.key, label:f.label, todo:f.todo, btn:f.btn, value:v, done:!!v};
    });
    var missing = items.filter(function(i){ return !i.done; });
    return {items:items, missing:missing, done:items.length - missing.length, total:items.length, ready:missing.length === 0};
  }
  // "sun exposure and soil / ground" — readable list of missing labels.
  function missingLabelList(missing){
    var names = missing.map(function(m){ return m.label.charAt(0).toLowerCase() + m.label.slice(1); });
    if (names.length <= 1) return names.join("");
    return names.slice(0, -1).join(", ") + " and " + names[names.length-1];
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
    else if (readiness.ready) missing.push({key:"guide", text:"build its care guide"});
    var photos = p.photos || [];
    if (photos.length){
      score += 15;
      var days = (Date.now() - new Date(photos[photos.length-1].date).getTime()) / 86400000;
      if (days <= 28) score += 5;
    } else missing.push({key:"photo", text:"add a photo"});
    var age = plantFieldValue(p, "age");
    if (age) score += isNotSure(age) ? 5 : 10; else missing.push({key:"age", text:"add its age"});
    if (p.species) score += 5; else missing.push({key:"species", text:"add its species or variety"});
    if (photos.length && days > 28) missing.push({key:"photo", text:"add a fresh photo"});
    return {score:Math.min(100, score), missing:missing, reasons:missing.map(function(m){ return m.text; })};
  }
  function gradeLabelFor(score){ return score>=80 ? "Well known" : (score>=50 ? "Getting there" : "Still learning"); }

  // ---- Quick answer: one question, answered by tapping an option chip
  // (or "Other…" for free text). Used by the care-guide checklist, the
  // level "next step" and the profile's Add/Edit buttons. opts.chain walks
  // through every still-missing care-guide detail in a row. ----
  var QUICK_FIELDS = {
    spot:        {q:"Where in the garden is it?", options:function(){ return SPOT_OPTIONS; }, other:"Describe the spot"},
    sunExposure: {q:"How much sun does that spot get?", options:function(){ return SUN_OPTIONS; }, other:"e.g. morning sun, shade after 2pm"},
    watering:    {q:"How do you water it?", options:function(){ return WATERING_OPTIONS; }, other:"e.g. drip twice a week"},
    groundType:  {q:"What's the ground like there?", options:function(){ return GROUND_OPTIONS; }, other:"e.g. rocky clay, mulched"},
    age:         {q:"About how old is it?", options:function(){ return AGE_OPTIONS; }, other:"e.g. planted spring 2021"},
    species:     {q:"What species or variety is it?", options:null, other:"e.g. Hass avocado, Citrus × meyeri"}
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
        el("button", {class:"modal-close", "aria-label":"Close", onclick:closeModal}, ["×"])
      ]));
      var backBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-bottom:10px;"}, ["← Back to plant"]);
      backBtn.addEventListener("click", function(){ openPlantDetail(p.id, {keepTab:true}); });
      container.appendChild(backBtn);
      if (opts.chain && opts.chainTotal > 1){
        container.appendChild(el("div", {class:"onboard-step-label"}, ["Care guide details · " + opts.chainIndex + " of " + opts.chainTotal]));
      }
      container.appendChild(el("h2", {style:"font-size:19px;margin:2px 0 14px;"}, [field.q]));
      var status = el("div", {class:"thinking", style:"min-height:20px;margin-top:8px;"});

      async function commit(value, fromOption){
        value = String(value || "").trim();
        if (!value) return;
        container.querySelectorAll("button, input").forEach(function(b){ b.disabled = true; });
        status.textContent = "Saving…";
        var fresh;
        try { fresh = await saveQuickAnswer(p, key, value, fromOption); }
        catch(e){
          container.querySelectorAll("button, input").forEach(function(b){ b.disabled = false; });
          status.textContent = "Couldn't save — try again.";
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
          showToast("✨ Care guide unlocked — ready to build!");
        } else {
          showToast("Saved");
        }
        openPlantDetail(fresh.id, {keepTab:true});
      }

      var otherInput = el("input", {type:"text", placeholder:field.other, value: current && (!field.options || field.options().indexOf(current) === -1) ? current : ""});
      var otherSave = el("button", {class:"btn btn-primary"}, ["Save"]);
      otherSave.addEventListener("click", function(){ commit(otherInput.value, false); });
      otherInput.addEventListener("keydown", function(e){ if (e.key === "Enter"){ e.preventDefault(); commit(otherInput.value, false); } });
      var otherRow = el("div", {class:"row", style:"gap:8px;flex-wrap:nowrap;margin-top:12px;"}, [el("div", {style:"flex:1;"}, [otherInput]), otherSave]);

      if (field.options){
        var chips = el("div", {class:"option-chips"});
        field.options().forEach(function(o){
          var chip = el("button", {class:"option-chip" + (o === current ? " active" : "")}, [o]);
          chip.addEventListener("click", function(){ commit(o, true); });
          chips.appendChild(chip);
        });
        var otherChip = el("button", {class:"option-chip" + (otherInput.value ? " active" : "")}, ["Other…"]);
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
        el("div", {class:"ready-title"}, [r.ready ? "Ready for a care guide" : "Care guide locked"]),
        el("div", {class:"ready-sub"}, [r.ready
          ? "I know enough about its spot to write a guide for your garden, not just the species."
          : "A good guide depends on where it grows. Tell me " + r.missing.length + " more thing" + (r.missing.length === 1 ? "" : "s") + " to unlock it."])
      ])
    ]));
    var meter = el("div", {class:"ready-meter", role:"img", "aria-label": r.done + " of " + r.total + " details added"});
    r.items.forEach(function(i){ meter.appendChild(el("span", {class:i.done ? "on" : ""})); });
    card.appendChild(el("div", {class:"ready-meter-row"}, [meter, el("span", {class:"ready-count"}, [r.done + " of " + r.total])]));

    var list = el("div", {class:"ready-list"});
    function row(item, optional){
      var b = el("button", {class:"ready-item" + (item.done ? " done" : "")}, [
        el("span", {class:"ready-check", "aria-hidden":"true", html: item.done ? icon("check") : ""}),
        el("span", {class:"ready-label"}, [item.label, optional ? el("span", {class:"ready-opt"}, [" · optional"]) : null]),
        el("span", {class:"ready-value"}, [item.done ? item.value : (optional ? "Add" : "Add →")])
      ]);
      b.addEventListener("click", function(){
        if (item.key === "photo"){ plantDetailTab = "overview"; openPlantDetail(p.id, {keepTab:true}); var inp = document.querySelector("#modalContent .overview-photo-input"); if (inp) inp.click(); }
        else openQuickAnswer(p, item.key);
      });
      list.appendChild(b);
    }
    r.items.forEach(function(i){ row(i, false); });
    row({key:"species", label:"Species or variety", value:p.species || "", done:!!p.species}, true);
    var nPhotos = (p.photos || []).length;
    row({key:"photo", label:"A photo", value: nPhotos ? nPhotos + (nPhotos === 1 ? " photo" : " photos") : "", done: nPhotos > 0}, true);
    card.appendChild(list);

    var buildBtn = el("button", {class:"btn " + (r.ready ? "btn-primary" : "btn-locked"), "aria-label": r.ready ? null : "Build care guide — locked. Add " + missingLabelList(r.missing) + " first."}, [r.ready ? "✨ Build care guide" : "🔒 Build care guide"]);
    var note = el("div", {class:"ready-note"}, [r.ready ? "Takes about half a minute." : "Add " + missingLabelList(r.missing) + " to unlock."]);
    buildBtn.addEventListener("click", async function(){
      if (!r.ready){
        // Locked: jump straight into filling what's missing.
        openQuickAnswer(p, r.missing[0].key, {chain:true, chainIndex:1, chainTotal:r.missing.length});
        return;
      }
      buildBtn.disabled = true; buildBtn.textContent = "Building…";
      note.textContent = "Writing a guide for " + p.name + "…";
      var ok = await researchPlant(p.id);
      if (ok){
        await loadGardenData();
        buzz(15); showToast("🌿 Care guide ready for " + p.name);
        plantDetailTab = "care";
        openPlantDetail(p.id, {keepTab:true});
      } else {
        buildBtn.disabled = false; buildBtn.textContent = "✨ Build care guide";
        note.textContent = "Couldn't build it just now — try again in a moment.";
      }
    });
    card.appendChild(el("div", {class:"ready-foot"}, [buildBtn, note]));
    if (r.missing.length > 1){
      var fill = el("button", {class:"link-btn", style:"margin-top:8px;"}, ["Answer the " + r.missing.length + " missing questions →"]);
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
  function renderShell(){
    var app = document.getElementById("app");
    // Horizontal scrollers (garden row, tips, library shelves) keep their
    // position across the full re-render, so the 45-second live refresh
    // doesn't yank a row back to the start mid-browse.
    var keptScroll = {};
    app.querySelectorAll("[data-keep-scroll]").forEach(function(n){ keptScroll[n.getAttribute("data-keep-scroll")] = n.scrollLeft; });
    app.innerHTML = "";
    var shell = el("div", {class:"shell"});

    var gearBtn = el("button", {class:"btn btn-ghost icon-btn gear-btn", title:"Settings", "aria-label":"Settings", onclick:openSettings}, [el("span", {html:icon("gear")})]);
    shell.appendChild(el("div", {class:"topbar"}, [
      el("div", {class:"brand"}, [el("span", {class:"mark", html:icon("leaf")}), el("h1", {}, ["Garden Companion"])]),
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
    var tabs = [["tasks","Home","home"], ["tasklist","Tasks","tasks"], ["library","My garden","seedling"], ["calendar","Calendar","calendar"]];
    var wrap = el("nav", {class:"tab-bar", "aria-label":"Sections"});
    tabs.forEach(function(t){
      var btn = el("button", {class:"tab-btn" + (state.section===t[0] ? " active" : ""), "aria-current": state.section===t[0] ? "page" : null}, [
        el("span", {class:"icon", html:icon(t[2])}), t[1]
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
    var ring = el("div", {class:"ring", title: done + " of " + total + " tasks done this week", role:"img", "aria-label": done + " of " + total + " tasks done this week"});
    ring.innerHTML = '<svg viewBox="0 0 72 72"><circle class="ring-track" cx="36" cy="36" r="' + r + '" fill="none" stroke-width="7"/>' +
      '<circle class="ring-fill" cx="36" cy="36" r="' + r + '" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - frac)).toFixed(1) + '"/></svg>';
    ring.appendChild(el("div", {class:"ring-label"}, [el("b", {}, [done + "/" + total]), el("span", {}, ["done"])]));
    return ring;
  }
  function weatherAdvice(w){
    if (!w) return null;
    var hi = parseInt((String(w.tempLabel || "").match(/-?\d+/) || [])[0], 10);
    var rain = parseInt((String(w.forecast || "").match(/(\d+)% chance of rain/) || [])[1], 10);
    if (rain >= 50) return ["🌧️", "Rain likely — you can probably skip watering today."];
    if (hi >= 33) return ["🥵", "A hot one — water early morning or in the evening, not midday."];
    if (hi <= 4) return ["🧣", "Chilly — keep an eye on tender plants tonight."];
    if (/breezy/i.test(w.forecast || "")) return ["💨", "Breezy — worth checking stakes on tall plants."];
    return ["🌿", "Good weather to get out in the garden."];
  }
  function heroCard(){
    var now = new Date(), hour = now.getHours();
    var greet = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
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
      sub = el("div", {class:"hero-sub"}, ["Your garden needs ", el("strong", {}, [needNow + (needNow === 1 ? " thing" : " things")]), " today" + (overdue ? " (" + overdue + " to catch up on)." : ".")]);
    } else if (laterThisWeek > 0){
      sub = el("div", {class:"hero-sub"}, ["Nothing due today — " + laterThisWeek + " coming up later this week."]);
    } else {
      sub = el("div", {class:"hero-sub"}, ["Nothing due — go enjoy your garden 🌿"]);
    }

    var prog = weekProgress();
    var top = el("div", {class:"hero-top"}, [
      el("div", {}, [
        el("div", {class:"hero-date"}, [now.toLocaleDateString(undefined, {weekday:"long", month:"long", day:"numeric"})]),
        el("h2", {}, [greet]),
        sub
      ]),
      prog.total ? progressRing(prog.done, prog.total) : null
    ]);
    var hero = el("section", {class:"hero " + theme}, [top]);

    var refreshBtn = el("button", {class:"btn btn-ghost btn-sm icon-btn", title:"Check weather now", "aria-label":"Refresh weather", style:"flex:none;"}, [el("span", {html:icon("refresh")})]);
    refreshBtn.addEventListener("click", async function(){
      refreshBtn.disabled = true; refreshBtn.classList.add("spinning");
      try { await refreshWeatherNow(); }
      finally { refreshBtn.disabled = false; refreshBtn.classList.remove("spinning"); }
    });
    var wxIcon = (night && sky === "sun") ? "moon" : sky;
    var wxText = w
      ? el("div", {class:"wx-text"}, [
          el("div", {}, [el("span", {class:"temp"}, [w.tempLabel || w.summary || "—"]), " ", el("span", {class:"desc"}, [w.forecast || ""])]),
          el("div", {class:"loc"}, [(w.locationLabel || "") + (w.fetchedAt ? " · updated " + fmtDate(w.fetchedAt) : "")])
        ])
      : el("div", {class:"wx-text"}, [
          el("div", {class:"desc"}, ["Weather check-in hasn't run yet"]),
          el("div", {class:"loc"}, ["Conditions for " + ((state.settings.location||{}).label || "your garden") + " will show here."])
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
    var btn = el("button", {class:"avatar-btn", "aria-label": p.name + (attn ? " — needs attention" : "")}, [av, el("span", {class:"avatar-name"}, [p.name])]);
    btn.addEventListener("click", function(){ openPlantDetail(p.id); });
    return btn;
  }
  function gardenRow(){
    if (state.plants.length === 0){
      var cta = el("div", {class:"card empty-fun", style:"margin-bottom:18px;"}, [
        el("span", {class:"big"}, ["🌱"]),
        el("div", {style:"margin-bottom:12px;"}, ["Your garden is empty — add your first plant and I'll build its care guide and schedule."])
      ]);
      var b = el("button", {class:"btn btn-primary"}, ["+ Add your first plant"]);
      b.addEventListener("click", openPlantWizard);
      cta.appendChild(b);
      return cta;
    }
    var plants = state.plants.slice().sort(function(a,b){
      return (b.healthStatus === "needs_attention" ? 1 : 0) - (a.healthStatus === "needs_attention" ? 1 : 0);
    });
    var attnCount = plants.filter(function(p){ return p.healthStatus === "needs_attention"; }).length;
    var seeAll = el("button", {class:"link-btn"}, ["See all in My garden →"]);
    seeAll.addEventListener("click", function(){ state.section = "library"; renderShell(); window.scrollTo(0, 0); });
    var row = el("div", {class:"hscroll", "data-keep-scroll":"garden-row"});
    plants.forEach(function(p){ row.appendChild(plantAvatar(p)); });
    var add = el("button", {class:"avatar-btn", "aria-label":"Add a plant"}, [el("span", {class:"avatar add"}, ["+"]), el("span", {class:"avatar-name"}, ["Add"])]);
    add.addEventListener("click", openPlantWizard);
    row.appendChild(add);
    return el("section", {}, [
      el("div", {class:"section-title"}, [
        el("h2", {}, ["Your plants"]),
        el("span", {class:"hint"}, [attnCount ? attnCount + " need" + (attnCount === 1 ? "s" : "") + " attention · " : "", seeAll])
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
  function currentTips(){
    if (!window.GardenTips) return [];
    return window.GardenTips.tipsFor({date:new Date(), settings:state.settings, plants:state.plants, weather:state.weather});
  }

  function tipsSection(){
    var all = currentTips();
    if (!all.length) return null;
    var visible = all.filter(function(tip){ return !isTipHidden(tip); }).slice(0, 6);
    var seeAll = el("button", {class:"link-btn"}, ["All tips (" + all.length + ") →"]);
    seeAll.addEventListener("click", function(){ openAllTips(); });
    var head = el("div", {class:"section-title"}, [el("h2", {}, ["Garden tips"]), el("span", {class:"hint"}, [MONTH_NAMES[new Date().getMonth()] + " · ", seeAll])]);
    if (!visible.length){
      // Everything hidden: keep a slim way back to them.
      var again = el("button", {class:"link-btn"}, ["See them all →"]);
      again.addEventListener("click", function(){ openAllTips(); });
      return el("section", {}, [head, el("div", {class:"about-locked"}, [el("span", {}, ["💡"]), el("span", {}, ["You've hidden this month's tips. "]), again])]);
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
        el("div", {class:"tip-kicker"}, [tip.weather ? "Weather tip" : "Seasonal tip", hidden ? el("span", {class:"chip chip-neutral", style:"margin-left:6px;letter-spacing:0;text-transform:none;"}, ["Hidden"]) : null]),
        el("div", {class:"tip-title"}, [tip.title])
      ])
    ]));
    card.appendChild(el("div", {class:"tip-body"}, [tip.body]));
    var actions = el("div", {class:"tip-actions"});
    var added = tipAddedTask(tip);
    if (added){
      actions.appendChild(el("div", {class:"tip-added"}, [el("span", {html:icon("check")}), "In your tasks · " + relativeDay(added.dueDate)]));
    } else {
      var addBtn = el("button", {class:"btn btn-primary btn-sm"}, ["+ Add as task"]);
      addBtn.addEventListener("click", function(){ addTipAsTask(tip, addBtn, {month:opts.month, onChange:refresh}); });
      actions.appendChild(addBtn);
    }
    if (hidden){
      var show = el("button", {class:"btn btn-ghost btn-sm"}, ["Show on Home"]);
      show.addEventListener("click", function(){ setTipHidden(tip, false); refresh(); showToast("Tip is back on Home"); });
      actions.appendChild(show);
    } else if (!added && opts.month === undefined){
      var notNow = el("button", {class:"btn btn-ghost btn-sm"}, ["Not now"]);
      notNow.addEventListener("click", function(){
        setTipHidden(tip, true);
        refresh();
        showToast("Tip hidden — find it under All tips", {label:"Undo", fn:function(){ setTipHidden(tip, false); refresh(); }});
      });
      actions.appendChild(notNow);
    }
    card.appendChild(actions);
    return card;
  }

  // Due date for a tip's task: from today for this month's tips; for a
  // tip browsed under another month, from the start of that month's next
  // occurrence (this year if still ahead, else next year).
  function tipDueDate(tip, month){
    var now = new Date();
    if (month === undefined || month === now.getMonth()) return addDays(todayISO(), tip.task.dueInDays || 0);
    var year = month > now.getMonth() ? now.getFullYear() : now.getFullYear() + 1;
    return addDays(isoDate(year, month + 1, 1), tip.task.dueInDays || 0);
  }
  async function addTipAsTask(tip, btn, opts){
    opts = opts || {};
    btn.disabled = true; btn.textContent = "Adding…";
    var due = tipDueDate(tip, opts.month);
    try {
      var created = await api("/tasks", {method:"POST", body:{
        title: tip.task.title, description: tip.task.description || tip.body, dueDate: due,
        kind: "tip", reason: "Garden tip", severity: "info", year: new Date(due + "T00:00:00").getFullYear()
      }});
      if (created) state.tasks.push(created);
    } catch(e){
      btn.disabled = false; btn.textContent = "Couldn't add — try again";
      return;
    }
    buzz(); leafBurst(btn);
    showToast("Added to your tasks — due " + relativeDay(due));
    (opts.onChange || renderShell)();
  }

  // The "All tips" sheet: every tip for a month — including ones hidden
  // with "Not now" — with a month picker to browse the rest of the year.
  function openAllTips(month){
    var now = new Date();
    if (month === undefined) month = now.getMonth();
    showModal(function(container){
      container.appendChild(el("div", {class:"modal-head"}, [
        el("h3", {style:"font-size:17px;"}, ["Garden tips"]),
        el("button", {class:"modal-close", "aria-label":"Close", onclick:closeModal}, ["×"])
      ]));
      var months = el("div", {class:"filter-chips month-chips", role:"toolbar", "aria-label":"Month"});
      for (var i=0;i<12;i++){
        var m = (now.getMonth() + i) % 12; // start from this month
        var chip = el("button", {class:"fchip" + (m === month ? " active" : ""), "aria-pressed": m === month ? "true" : "false"}, [i === 0 ? "This month" : MONTH_NAMES[m].slice(0,3)]);
        chip.addEventListener("click", (function(mm){ return function(){ openAllTips(mm); }; })(m));
        months.appendChild(chip);
      }
      container.appendChild(months);
      var isNow = month === now.getMonth();
      var tips = window.GardenTips ? window.GardenTips.tipsFor({
        date:new Date(now.getFullYear(), month, 15), settings:state.settings, plants:state.plants, weather: isNow ? state.weather : null
      }) : [];
      container.appendChild(el("p", {class:"lead", style:"font-size:13px;color:var(--ink-soft);margin:10px 0 12px;"}, [
        tips.length + (tips.length === 1 ? " tip" : " tips") + " for " + (isNow ? "this month" : MONTH_NAMES[month]) + ", picked for the plants in your garden." + (isNow ? "" : " Adding one sets it for early " + MONTH_NAMES[month] + ".")
      ]));
      if (!tips.length) container.appendChild(el("div", {class:"empty"}, ["No tips for this month."]));
      var list = el("div", {class:"tips-list"});
      tips.forEach(function(tip){
        list.appendChild(tipCard(tip, {list:true, month: isNow ? undefined : month, onChange:function(){ openAllTips(month); }}));
      });
      container.appendChild(list);
    }, {keepScroll:true});
  }

  function severityChip(sev){
    var map = {critical:["chip-crit","Urgent"], warning:["chip-warn","Soon"], info:["chip-neutral","Note"]};
    var m = map[sev] || map.info;
    return el("span", {class:"chip " + m[0]}, [m[1]]);
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
    var allLink = el("button", {class:"link-btn"}, ["All tasks →"]);
    allLink.addEventListener("click", function(){ state.section = "tasklist"; renderShell(); window.scrollTo(0, 0); });
    sec.appendChild(el("div", {class:"section-head"}, [
      el("h2", {}, ["This week"]),
      el("span", {class:"hint"}, [tasks.length ? tasks.length + " open" + (isTouch() ? " · swipe → when done · " : " · ") : "", allLink])
    ]));
    if (tasks.length === 0){
      sec.appendChild(el("div", {class:"empty-fun"}, [el("span", {class:"big"}, ["🌻"]), "All clear this week! I'll add tasks here each morning when something needs attention."]));
      return sec;
    }
    var today = todayISO();
    var groups = [
      {label:"Catch up", cls:"catchup", test:function(t){ return t.dueDate && t.dueDate < today; }},
      {label:"Today", test:function(t){ return t.dueDate === today; }},
      {label:"Tomorrow", test:function(t){ return t.dueDate && daysFromToday(t.dueDate) === 1; }},
      {label:"Later this week", test:function(t){ return t.dueDate && daysFromToday(t.dueDate) > 1; }},
      {label:"Anytime", test:function(t){ return !t.dueDate; }}
    ];
    groups.forEach(function(g){
      var items = tasks.filter(g.test);
      if (!items.length) return;
      sec.appendChild(el("div", {class:"task-group-label" + (g.cls ? " " + g.cls : "")}, [g.label, el("span", {class:"count"}, ["· " + items.length])]));
      items.forEach(function(t){ sec.appendChild(taskListRow(t, {swipe:true, hideDate: g.label === "Today" || g.label === "Tomorrow"})); });
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
      el("h2", {}, ["Upcoming"]),
      el("span", {class:"hint"}, ["next 2 weeks"])
    ]));
    if (tasks.length === 0){
      sec.appendChild(el("div", {class:"empty"}, ["Nothing scheduled for the two weeks after this one yet — a good moment to browse the garden tips above."]));
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
    var parts = order.map(function(k){ var c = counts[k]; return c.cat.emoji + " " + c.cat.verb + (c.n > 1 ? " ×" + c.n : ""); });
    var streak = weekStreak();
    var text = doneThisWeek.length
      ? [el("div", {class:"celebrate-title"}, ["Nice work — " + doneThisWeek.length + (doneThisWeek.length === 1 ? " job" : " jobs") + " done this week!"]),
         el("div", {class:"celebrate-sub"}, [parts.join(" · ")])]
      : [el("div", {class:"celebrate-title"}, ["Recently done"]),
         el("div", {class:"celebrate-sub"}, ["Nothing ticked off in the last 7 days yet."])];
    if (streak >= 2) text.push(el("span", {class:"chip chip-amber streak"}, ["🔥 " + streak + "-week streak — every task done"]));
    sec.appendChild(el("div", {class:"celebrate"}, [el("span", {class:"celebrate-emoji", "aria-hidden":"true"}, [doneThisWeek.length ? "🎉" : "🌾"]), el("div", {}, text)]));
    var details = el("details", {class:"done-list"}, [el("summary", {}, ["Show recently done (" + tasks.length + ")"])]);
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
      t.kind === "tip" ? el("span", {class:"chip chip-amber"}, ["Tip"]) : null,
      overdue ? el("span", {class:"chip chip-warn"}, [relativeDay(t.dueDate)]) : null,
      t.requestsPhoto ? el("span", {class:"chip chip-neutral"}, ["📷 photo"]) : null,
      (!overdue && !opts.hideDate && t.dueDate) ? el("span", {}, [t.status === "done" && t.completedAt ? "done " + fmtDate(t.completedAt) : fmtDate(t.dueDate)]) : null
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
      el("div", {class:"swipe-bg", "aria-hidden":"true"}, [el("span", {html:icon("check")}), "Done"]),
      row
    ]);
    makeSwipeable(wrap, row, function(){ completeTaskFromList(t, wrap, row); });
    return wrap;
  }

  // Swipe right past ~35% of the row to complete. Vertical scrolling keeps
  // working (touch-action: pan-y); a swipe never also counts as a tap.
  function makeSwipeable(wrap, row, onComplete){
    var startX = 0, startY = 0, tracking = false, dragging = false, armed = false, pid = null;
    row.addEventListener("pointerdown", function(e){
      if (e.button !== undefined && e.button !== 0) return;
      tracking = true; dragging = false; armed = false; pid = e.pointerId;
      startX = e.clientX; startY = e.clientY;
    });
    row.addEventListener("pointermove", function(e){
      if (!tracking || e.pointerId !== pid) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragging){
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { tracking = false; return; }
        if (dx > 10 && dx > Math.abs(dy) * 1.5){
          dragging = true; swipeActive = true;
          try { row.setPointerCapture(pid); } catch(err){}
          wrap.classList.add("dragging");
        } else return;
      }
      var tx = Math.max(0, dx);
      row.style.transform = "translateX(" + tx + "px)";
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
        row.style.transform = "translateX(" + wrap.offsetWidth + "px)";
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
      showToast("Couldn't save — try again");
      renderShell();
      return;
    }
    setTimeout(function(){
      swipeActive = false;
      renderShell();
      showToast("Nice! “" + t.title + "” done", {label:"Undo", fn: async function(){
        try { await setTaskStatus(t, "pending"); } catch(e){ showToast("Couldn't undo — try again"); }
        renderShell();
      }});
      // Pick up anything the server did on completion (e.g. schedule stamps).
      loadGardenData().then(function(){ if (!modalOpenFor && !userIsBusy()) renderShell(); }).catch(function(){});
    }, 420);
  }

  function statusChip(t){
    if (t.status === "done") return el("span", {class:"chip chip-moss"}, ["Done" + (t.completedAt ? " · " + fmtDate(t.completedAt) : "")]);
    if (t.dueDate && t.dueDate < todayISO()) return el("span", {class:"chip chip-warn"}, ["Overdue"]);
    return el("span", {class:"chip chip-neutral"}, ["Pending"]);
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
        el("h3", {style:"font-size:17px;"}, ["Task"]),
        el("button", {class:"modal-close", onclick:closeModal}, ["×"])
      ]));
      if (opts.onBack){
        var backBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-bottom:14px;"}, [opts.backLabel || "← Back to calendar"]);
        backBtn.addEventListener("click", opts.onBack);
        container.appendChild(backBtn);
      }
      if (!t){
        container.appendChild(el("div", {class:"empty"}, ["This task couldn't be found — it may have been removed."]));
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
      var doneBtn = el("button", {class:"btn btn-sm" + (t.status==="done" ? " btn-ghost" : " btn-primary")}, [t.status==="done" ? "Mark not done" : "Mark done"]);
      doneBtn.addEventListener("click", async function(){
        doneBtn.disabled = true;
        var newStatus = t.status === "done" ? "pending" : "done";
        // completedAt, and stamping lastDone on the plant's matching
        // yearly-schedule entry, happen server-side (api/tasks/[id].js).
        try {
          await api("/tasks/" + t.id, {method:"PATCH", body:{status:newStatus}});
        } catch(e){
          doneBtn.disabled = false;
          doneBtn.textContent = "Couldn't save — try again";
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
    if (t.requestsPhoto) statusRow.appendChild(el("span", {class:"chip chip-neutral"}, ["📷 photo requested"]));
    wrap.appendChild(statusRow);

    wrap.appendChild(el("div", {style:"font-weight:600;font-size:15.5px;margin-bottom:4px;"}, [t.title]));
    if (t.description) wrap.appendChild(el("div", {class:"task-desc"}, [t.description]));
    wrap.appendChild(el("div", {class:"task-meta", style:"margin-bottom:14px;"}, [fmtDate(t.dueDate) + (t.reason ? " · " + t.reason : "")]));

    (t.comments||[]).forEach(function(c){
      wrap.appendChild(el("div", {class:"comment-item"}, [c.text + "  ·  " + fmtDate(c.date)]));
    });
    if (t.photo && t.photo.dataUrl){
      wrap.appendChild(el("img", {src:t.photo.dataUrl, class:"photo-preview", style:"max-width:260px;"}));
      if (t.photo.analysis) wrap.appendChild(el("div", {class:"agent-note"}, [t.photo.analysis]));
    }
    var commentTa = el("textarea", {placeholder:"Add a note…", style:"margin-top:10px;"});
    var photoInput = el("input", {type:"file", accept:"image/*", class:"sr-only"});
    var photoLabel = el("label", {class:"btn btn-ghost btn-sm"}, ["Attach photo", photoInput]);
    var saveBtn = el("button", {class:"btn btn-sm btn-primary"}, ["Save"]);
    var pendingPhoto = null;
    photoInput.addEventListener("change", async function(){
      var f = photoInput.files[0]; if (!f) return;
      pendingPhoto = await resizeImage(f);
      photoLabel.textContent = "Photo attached";
      photoLabel.appendChild(photoInput);
    });
    saveBtn.addEventListener("click", async function(){
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
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
        saveBtn.disabled = false; saveBtn.textContent = "Couldn't save — try again";
        return;
      }
      await refresh();
    });
    wrap.appendChild(el("div", {class:"field", style:"margin-top:8px;"}, [commentTa]));
    wrap.appendChild(el("div", {class:"row"}, [photoLabel, saveBtn]));

    var editBtn = el("button", {class:"btn btn-ghost btn-sm"}, [el("span", {html:icon("pencil")}), " Edit"]);
    editBtn.addEventListener("click", function(){ openTaskForm(t); });
    wrap.appendChild(el("div", {class:"row task-manage-row"}, [editBtn, deleteTaskButton(t)]));

    return wrap;
  }

  // ---- Tasks screen: every task in one place, with search and filters
  // (open/done, kind, plant), grouped by when it's due; add, edit and
  // delete from here. Search typing only repaints the list, so the field
  // keeps focus. ----
  var TASK_KINDS = [
    ["all", "All"], ["manual", "✍️ Mine"], ["scheduled", "📅 Care guide"], ["issue", "🩺 Problems"], ["checkin", "📷 Check-ins"], ["tip", "💡 Tips"]
  ];
  var taskFilter = {status:"open", kind:"all", plant:"all", q:""};

  function taskListScreen(){
    var wrap = el("div", {});
    var openCount = state.tasks.filter(function(t){ return t.status !== "done"; }).length;
    var addBtn = el("button", {class:"btn btn-sm btn-primary"}, ["+ New task"]);
    addBtn.addEventListener("click", function(){ openTaskForm(null); });
    wrap.appendChild(el("div", {class:"section-title", style:"margin-top:4px;align-items:center;"}, [
      el("div", {}, [el("h2", {}, ["Tasks"]), el("div", {class:"hint"}, [openCount + " open · " + (state.tasks.length - openCount) + " done"])]),
      addBtn
    ]));

    var toolbar = el("div", {class:"lib-toolbar"});
    var results = el("div", {});
    var search = el("input", {type:"search", placeholder:"Search tasks", value:taskFilter.q, "aria-label":"Search tasks", autocomplete:"off"});
    search.addEventListener("input", function(){ taskFilter.q = search.value; renderTaskResults(results); });
    toolbar.appendChild(el("div", {class:"search-wrap"}, [el("span", {html:icon("search")}), search]));

    var seg = el("div", {class:"seg", role:"group", "aria-label":"Status"});
    [["open","Open"],["done","Done"],["all","All"]].forEach(function(v){
      var b = el("button", {class: taskFilter.status === v[0] ? "active" : "", "aria-pressed": taskFilter.status === v[0] ? "true" : "false"}, [v[1]]);
      b.addEventListener("click", function(){ taskFilter.status = v[0]; renderShell(); });
      seg.appendChild(b);
    });
    var plantSel = el("select", {class:"sort-select", "aria-label":"Filter by plant"},
      [["all","All plants"]].concat(state.plants.map(function(p){ return [p.id, p.name]; }), [["none","Not about a plant"]]).map(function(o){
        var opt = el("option", {value:o[0]}, [o[1]]);
        if (taskFilter.plant === o[0]) opt.setAttribute("selected","selected");
        return opt;
      }));
    plantSel.addEventListener("change", function(){ taskFilter.plant = plantSel.value; renderTaskResults(results); });
    toolbar.appendChild(el("div", {class:"lib-toolbar-row"}, [seg, plantSel]));

    // Kind chips — only kinds that actually exist, plus All.
    var kindsPresent = {};
    state.tasks.forEach(function(t){ kindsPresent[t.kind || "manual"] = true; });
    var chips = el("div", {class:"filter-chips", role:"toolbar", "aria-label":"Filter by type"});
    TASK_KINDS.forEach(function(k){
      if (k[0] !== "all" && !kindsPresent[k[0]]) return;
      var chip = el("button", {class:"fchip" + (taskFilter.kind === k[0] ? " active" : ""), "aria-pressed": taskFilter.kind === k[0] ? "true" : "false"}, [k[1]]);
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
        anyFilter ? "No tasks match these filters." : (taskFilter.status === "done" ? "Nothing finished yet." : "No open tasks — tap “+ New task” to add one.")
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
      if (!t.dueDate) return add("nodate", "Anytime", "", t);
      var n = daysFromToday(t.dueDate);
      if (t.dueDate < today) return add("overdue", "Overdue", "catchup", t);
      if (n === 0) return add("today", "Today", "", t);
      if (n < 7) return add("week", "This week", "", t);
      var d = new Date(t.dueDate + "T00:00:00");
      add("m" + t.dueDate.slice(0,7), MONTH_NAMES[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""), "", t);
    });
    // "Anytime" last.
    groups.sort(function(a,b){ return (a.label === "Anytime") - (b.label === "Anytime"); });
    if (done.length) groups.push({label:"Done", cls:"", items:done});

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
        el("h3", {style:"font-size:17px;"}, [isNew ? "New task" : "Edit task"]),
        el("button", {class:"modal-close", "aria-label":"Close", onclick:closeModal}, ["×"])
      ]));
      var titleIn = el("input", {type:"text", placeholder:"e.g. Buy compost", value: task ? task.title : ""});
      var notesIn = el("textarea", {placeholder:"Notes (optional)", style:"min-height:64px;"});
      notesIn.value = task ? (task.description || "") : "";
      var dateIn = el("input", {type:"date", value: task ? (task.dueDate || "") : todayISO()});
      var selectedPlant = task ? (task.plantId || "") : (opts.plantId || "");
      var plantSel = el("select", {}, [el("option", {value:""}, ["Not about a specific plant"])].concat(state.plants.map(function(p){
        var o = el("option", {value:p.id}, [p.name]);
        if (p.id === selectedPlant) o.setAttribute("selected","selected");
        return o;
      })));
      var photoIn = el("input", {type:"checkbox", id:"tfPhoto"});
      photoIn.checked = !!(task && task.requestsPhoto);
      var err = el("div", {class:"empty", style:"min-height:18px;"});

      // Quick due-date shortcuts.
      var quick = el("div", {class:"option-chips", style:"margin-top:8px;"});
      [["Today",0],["Tomorrow",1],["In a week",7],["In 2 weeks",14]].forEach(function(q){
        var b = el("button", {class:"option-chip", type:"button", style:"min-height:36px;padding:6px 12px;font-size:13px;"}, [q[0]]);
        b.addEventListener("click", function(){ dateIn.value = addDays(todayISO(), q[1]); });
        quick.appendChild(b);
      });

      container.appendChild(el("div", {class:"field"}, [el("label", {}, ["What needs doing?"]), titleIn]));
      container.appendChild(el("div", {class:"field"}, [el("label", {}, ["Due"]), dateIn, quick]));
      container.appendChild(el("div", {class:"field"}, [el("label", {}, ["Plant"]), plantSel]));
      container.appendChild(el("div", {class:"field"}, [el("label", {}, ["Notes"]), notesIn]));
      container.appendChild(el("label", {class:"check-row", for:"tfPhoto"}, [photoIn, "Ask me for a photo when I do this"]));
      if (task && task.kind === "scheduled"){
        container.appendChild(el("div", {class:"about-locked", style:"margin-top:10px;"}, ["📅 This task comes from " + (task.plantName || "a plant") + "'s care guide. Updating the care guide rebuilds these tasks, which would undo edits to upcoming ones."]));
      }
      container.appendChild(err);

      var saveBtn = el("button", {class:"btn btn-primary"}, [isNew ? "Add task" : "Save changes"]);
      saveBtn.addEventListener("click", async function(){
        var title = titleIn.value.trim();
        if (!title){ err.textContent = "Give the task a name."; titleIn.focus(); return; }
        if (!dateIn.value){ err.textContent = "Pick a due date."; return; }
        var plant = state.plants.find(function(p){ return p.id === plantSel.value; });
        var body = {
          title: title, description: notesIn.value.trim(), dueDate: dateIn.value,
          plantId: plant ? plant.id : null, plantName: plant ? plant.name : "",
          requestsPhoto: photoIn.checked
        };
        saveBtn.disabled = true; saveBtn.textContent = "Saving…";
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
          saveBtn.disabled = false; saveBtn.textContent = "Couldn't save — try again";
          return;
        }
        buzz();
        closeModal();
        showToast(isNew ? "Task added — due " + relativeDay(body.dueDate) : "Task updated");
      });
      var row = el("div", {class:"row", style:"justify-content:space-between;margin-top:6px;"});
      if (!isNew) row.appendChild(deleteTaskButton(task)); else row.appendChild(el("span"));
      row.appendChild(saveBtn);
      container.appendChild(row);
      if (isNew) setTimeout(function(){ titleIn.focus(); }, 60);
    });
  }

  // A Delete button that asks once, inline, before deleting.
  function deleteTaskButton(t){
    var btn = el("button", {class:"btn btn-ghost danger-btn"}, [el("span", {html:icon("trash")}), " Delete"]);
    var armed = false;
    btn.addEventListener("click", async function(){
      if (!armed){
        armed = true;
        btn.classList.add("armed");
        btn.textContent = "Tap again to delete";
        setTimeout(function(){ if (armed && !btn.disabled){ armed = false; btn.classList.remove("armed"); btn.innerHTML = ""; btn.appendChild(el("span", {html:icon("trash")})); btn.appendChild(document.createTextNode(" Delete")); } }, 3500);
        return;
      }
      btn.disabled = true; btn.textContent = "Deleting…";
      try {
        await api("/tasks/" + t.id, {method:"DELETE"});
      } catch(e){
        btn.disabled = false; btn.textContent = "Couldn't delete — try again";
        return;
      }
      state.tasks = state.tasks.filter(function(x){ return x.id !== t.id; });
      closeModal();
      showToast("Deleted “" + t.title + "”");
    });
    return btn;
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
        el("h2", {style:"font-size:20px;margin-bottom:6px;"}, ["Your garden is empty"]),
        el("p", {style:"margin:0 0 14px;"}, ["Add your first plant and I'll build a care guide and a yearly schedule for it."])
      ]);
      var ctaBtn = el("button", {class:"btn btn-primary"}, ["+ Add your first plant"]);
      ctaBtn.addEventListener("click", openPlantWizard);
      sec.appendChild(ctaBtn);
      wrap.appendChild(sec);
      return wrap;
    }

    var addBtn = el("button", {class:"btn btn-sm btn-primary"}, ["+ Add a plant"]);
    addBtn.addEventListener("click", openPlantWizard);
    var head = el("div", {class:"section-title", style:"margin-top:4px;align-items:center;"}, [
      el("div", {}, [
        el("h2", {}, ["My garden"]),
        el("div", {class:"hint"}, [state.plants.length + (state.plants.length === 1 ? " plant" : " plants")])
      ]),
      addBtn
    ]);
    wrap.appendChild(head);

    var toolbar = el("div", {class:"lib-toolbar"});
    var results = el("div", {});

    if (state.plants.length >= 6){
      var search = el("input", {type:"search", placeholder:"Search your plants", value:lib.q, "aria-label":"Search your plants", autocomplete:"off"});
      search.addEventListener("input", function(){ lib.q = search.value; renderLibraryResults(results); });
      toolbar.appendChild(el("div", {class:"search-wrap"}, [el("span", {html:icon("search")}), search]));
    }

    // Filter chips: All, Needs attention (if any), then one per plant type present.
    var chips = el("div", {class:"filter-chips", role:"toolbar", "aria-label":"Filter plants"});
    var filters = [["all", "All"]];
    if (state.plants.some(function(p){ return p.healthStatus === "needs_attention"; })) filters.push(["attn", "⚠︎ Needs care"]);
    var typesPresent = [];
    state.plants.forEach(function(p){ var ty = p.type || "other"; if (typesPresent.indexOf(ty) === -1) typesPresent.push(ty); });
    if (typesPresent.length > 1) typesPresent.forEach(function(ty){ filters.push(["type:" + ty, typeEmoji(ty) + " " + ty.charAt(0).toUpperCase() + ty.slice(1)]); });
    if (filters.every(function(f){ return f[0] !== lib.filter; })) lib.filter = "all";
    filters.forEach(function(f){
      var chip = el("button", {class:"fchip" + (lib.filter === f[0] ? " active" : ""), "aria-pressed": lib.filter === f[0] ? "true" : "false"}, [f[1]]);
      chip.addEventListener("click", function(){ lib.filter = f[0]; renderShell(); });
      chips.appendChild(chip);
    });
    toolbar.appendChild(chips);

    var seg = el("div", {class:"seg", role:"group", "aria-label":"View"});
    [["grid","Grid"],["spots","By spot"]].forEach(function(v){
      var b = el("button", {class: lib.view === v[0] ? "active" : "", "aria-pressed": lib.view === v[0] ? "true" : "false"}, [v[1]]);
      b.addEventListener("click", function(){ lib.view = v[0]; localSet(LIB_VIEW_KEY, v[0]); renderShell(); });
      seg.appendChild(b);
    });
    var sortSel = el("select", {class:"sort-select", "aria-label":"Sort plants"}, [
      ["name","A → Z"], ["care","Needs care soonest"], ["newest","Newest first"]
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
      if (lib.filter === "attn" && p.healthStatus !== "needs_attention") return false;
      if (lib.filter.indexOf("type:") === 0 && (p.type || "other") !== lib.filter.slice(5)) return false;
      if (!q) return true;
      return [p.name, p.type, p.spot, p.species].some(function(v){ return v && String(v).toLowerCase().indexOf(q) !== -1; });
    });
    if (lib.sort === "newest"){
      list.sort(function(a,b){ return String(b.createdAt||"").localeCompare(String(a.createdAt||"")); });
    } else if (lib.sort === "care"){
      var key = function(p){
        var t = nextTaskFor(p.id);
        return (p.healthStatus === "needs_attention" ? "0" : "1") + (t ? t.dueDate : "9999");
      };
      list.sort(function(a,b){ return key(a).localeCompare(key(b)) || a.name.localeCompare(b.name); });
    } else {
      list.sort(function(a,b){ return a.name.localeCompare(b.name); });
    }
    return list;
  }

  function renderLibraryResults(container){
    container.innerHTML = "";
    var list = filteredSortedPlants();
    if (!list.length){
      container.appendChild(el("div", {class:"no-results"}, [lib.q ? "No plants match “" + lib.q.trim() + "”." : "No plants match this filter."]));
      return;
    }
    if (lib.view === "spots"){
      var groups = {}, order = [];
      list.forEach(function(p){
        var spot = p.spot || "Somewhere in the garden";
        if (!groups[spot]){ groups[spot] = []; order.push(spot); }
        groups[spot].push(p);
      });
      order.sort(function(a,b){ return groups[b].length - groups[a].length || a.localeCompare(b); });
      order.forEach(function(spot){
        var row = el("div", {class:"hscroll", "data-keep-scroll":"shelf-" + spot});
        groups[spot].forEach(function(p){ row.appendChild(plantCard(p)); });
        container.appendChild(el("section", {class:"shelf"}, [
          el("div", {class:"shelf-head"}, [el("h3", {}, [spot]), el("span", {class:"hint"}, [groups[spot].length + (groups[spot].length === 1 ? " plant" : " plants")])]),
          row
        ]));
      });
      return;
    }
    var grid = el("div", {class:"plant-grid"});
    list.forEach(function(p){ grid.appendChild(plantCard(p)); });
    if (!lib.q && lib.filter === "all"){
      var tile = el("button", {class:"add-tile"}, [el("span", {class:"plus"}, ["+"]), "Add a plant"]);
      tile.addEventListener("click", openPlantWizard);
      grid.appendChild(tile);
    }
    container.appendChild(grid);
  }

  // Photo (or a colored type-emoji placeholder) used by library cards and
  // the plant detail hero.
  function plantPhotoEl(p){
    var lastPhoto = (p.photos && p.photos.length) ? p.photos[p.photos.length-1] : null;
    if (lastPhoto) return el("img", {src:lastPhoto.dataUrl, alt:p.name, loading:"lazy"});
    return el("div", {class:"plant-photo-ph", style:"--ph-color:" + plantColorFor(p.id) + ";", "aria-hidden":"true"}, [typeEmoji(p.type)]);
  }

  function plantCard(p){
    var k = plantKnowledge(p);
    var lvl = plantLevel(k.score);
    var attn = p.healthStatus === "needs_attention";
    var photo = el("div", {class:"plant-photo"}, [
      plantPhotoEl(p),
      el("div", {class:"card-badges"}, [
        el("span", {class:"level-badge", title:gradeLabelFor(k.score)}, [lvl.emoji + " " + lvl.name + " · " + k.score + "%"]),
        attn ? el("span", {class:"attn-badge"}, ["Needs care"]) : null
      ]),
      el("div", {class:"plant-overlay"}, [
        el("div", {class:"plant-card-name"}, [p.name]),
        el("div", {class:"plant-card-sub"}, [(p.type ? p.type.charAt(0).toUpperCase() + p.type.slice(1) : "Plant") + (p.spot ? " · " + p.spot : "")])
      ])
    ]);
    var next = nextTaskFor(p.id);
    var nextLine;
    if (next){
      var overdue = next.dueDate < todayISO();
      var when = relativeDay(next.dueDate);
      nextLine = el("div", {class:"plant-next" + (overdue ? " overdue" : "")}, [
        el("span", {"aria-hidden":"true"}, [taskCategory(next).emoji]),
        el("span", {class:"plant-next-text"}, [el("b", {}, [when.charAt(0).toUpperCase() + when.slice(1) + ": "]), next.title])
      ]);
    } else if (!(p.researched && p.careProfile)){
      var rd = careReadiness(p);
      nextLine = rd.ready
        ? el("div", {class:"plant-next"}, [el("span", {"aria-hidden":"true"}, ["✨"]), el("span", {class:"plant-next-text"}, [el("b", {}, ["Ready: "]), "build its care guide"])])
        : el("div", {class:"plant-next locked"}, [el("span", {"aria-hidden":"true"}, ["🔒"]), el("span", {class:"plant-next-text"}, [el("b", {}, ["Care guide: "]), rd.missing.length + " detail" + (rd.missing.length === 1 ? "" : "s") + " to go"])]);
    } else {
      nextLine = el("div", {class:"plant-next"}, [el("span", {"aria-hidden":"true"}, ["✓"]), el("span", {class:"plant-next-text"}, ["All caught up"])]);
    }
    var card = el("button", {class:"plant-card", "aria-label": p.name + (attn ? " — needs attention" : "")}, [photo, nextLine]);
    card.addEventListener("click", function(){ openPlantDetail(p.id); });
    return card;
  }

  function openSettings(){
    var s = state.settings || {};
    showModal(function(container){
      container.appendChild(el("div", {class:"modal-head"}, [
        el("h3", {}, ["Settings"]),
        el("button", {class:"modal-close", onclick:closeModal}, ["×"])
      ]));
      var locInput = el("input", {type:"text", value:(s.location && s.location.label) || ""});
      container.appendChild(el("div", {class:"field"}, [el("label", {}, ["Garden location"]), locInput]));

      var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      var daySelect = el("select", {}, days.map(function(d){
        var o = el("option", {value:d}, [d]);
        if ((s.photoCheckinDay || "Friday") === d) o.setAttribute("selected","selected");
        return o;
      }));
      container.appendChild(el("div", {class:"field"}, [el("label", {}, ["Weekly photo check-in day"]), daySelect]));

      // Seasonal garden tips flip by six months south of the equator.
      var hemi = (s.location && s.location.hemisphere) || "";
      var hemiSelect = el("select", {}, [["", "Automatic (from your location)"], ["north", "Northern hemisphere"], ["south", "Southern hemisphere"]].map(function(o){
        var opt = el("option", {value:o[0]}, [o[1]]);
        if (hemi === o[0]) opt.setAttribute("selected","selected");
        return opt;
      }));
      container.appendChild(el("div", {class:"field"}, [el("label", {}, ["Seasons for garden tips"]), hemiSelect]));

      container.appendChild(el("p", {style:"font-size:12.5px;color:var(--ink-faint);margin:0 0 16px;"}, [
        "Weather and care checks run early each morning. New plants get researched within about an hour of adding them — no need to wait for the daily check-in."
      ]));

      var saveBtn = el("button", {class:"btn btn-primary btn-sm"}, ["Save"]);
      saveBtn.addEventListener("click", async function(){
        saveBtn.disabled = true; saveBtn.textContent = "Saving…";
        var loc = Object.assign({}, s.location, {label: locInput.value || "Unspecified"});
        if (hemiSelect.value) loc.hemisphere = hemiSelect.value; else delete loc.hemisphere;
        try {
          await api("/settings", {method:"PATCH", body:{location:loc, photoCheckinDay:daySelect.value}});
        } catch(e){
          saveBtn.disabled = false; saveBtn.textContent = "Couldn't save — try again";
          return;
        }
        state.settings = Object.assign({}, state.settings, {location:loc, photoCheckinDay:daySelect.value});
        closeModal();
      });
      container.appendChild(saveBtn);
    });
  }

  // ---- Calendar section: Year/Month/Week views over the `tasks` collection. ----
  // Deliberately read-only for completion — tasks can be opened and reviewed
  // (comments/photo still allowed) but never marked done from here; that only
  // happens from the Tasks section. Locked to the current year.
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
    if (yearlyPlan.mode === "month") return MONTH_NAMES[d.getMonth()] + " " + d.getFullYear();
    var week = weekDatesFor(d), first = week[0], last = week[6];
    var fmt = function(x){ return MONTH_NAMES[x.getMonth()].slice(0,3) + " " + x.getDate(); };
    return fmt(first) + " – " + (first.getMonth()===last.getMonth() ? last.getDate() : fmt(last)) + ", " + last.getFullYear();
  }
  function shiftYearlyAnchor(dir){
    var year = new Date().getFullYear();
    var d = new Date(yearlyPlan.anchor + "T00:00:00");
    if (yearlyPlan.mode === "month") d.setMonth(d.getMonth() + dir, 1);
    else d.setDate(d.getDate() + dir*7);
    if (d.getFullYear() !== year) return; // stay within the current year
    yearlyPlan.anchor = isoDate(d.getFullYear(), d.getMonth()+1, d.getDate());
  }

  function calendarSection(){
    var container = el("div", {class:"card"});
    container.appendChild(el("div", {class:"section-head"}, [el("h2", {}, ["Calendar"])]));
    if (state.plants.length === 0){
      container.appendChild(el("div", {class:"empty"}, ["Add a plant and its yearly schedule will show up here."]));
      return container;
    }
    var anyResearched = state.plants.some(function(p){ return p.researched; });
    if (!anyResearched){
      container.appendChild(el("div", {class:"empty", style:"margin-bottom:10px;"}, ["Still building schedules for your plants — check back shortly."]));
    }

    var yearBtn = el("button", {class:"btn btn-sm" + (yearlyPlan.mode==="year" ? "" : " btn-ghost")}, ["Year"]);
    var monthBtn = el("button", {class:"btn btn-sm" + (yearlyPlan.mode==="month" ? "" : " btn-ghost")}, ["Month"]);
    var weekBtn = el("button", {class:"btn btn-sm" + (yearlyPlan.mode==="week" ? "" : " btn-ghost")}, ["Week"]);
    yearBtn.addEventListener("click", function(){ yearlyPlan.mode = "year"; renderShell(); });
    monthBtn.addEventListener("click", function(){ yearlyPlan.mode = "month"; renderShell(); });
    weekBtn.addEventListener("click", function(){ yearlyPlan.mode = "week"; renderShell(); });
    var header = el("div", {class:"row", style:"justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;"}, [
      el("div", {class:"row", style:"gap:6px;"}, [yearBtn, monthBtn, weekBtn])
    ]);
    if (yearlyPlan.mode === "year"){
      header.appendChild(el("div", {style:"font-weight:600;font-size:14.5px;"}, [String(new Date().getFullYear())]));
    } else {
      var prevBtn = el("button", {class:"btn btn-ghost btn-sm"}, ["←"]);
      var nextBtn = el("button", {class:"btn btn-ghost btn-sm"}, ["→"]);
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

  // Year view: one cell per month with an open-task count; clicking a month
  // drills into Month view anchored there.
  function buildYearGrid(container){
    var year = new Date().getFullYear();
    var map = tasksByDateMap();
    var counts = new Array(12).fill(0);
    Object.keys(map).forEach(function(dateStr){
      if (dateStr.slice(0,4) === String(year)){
        var m = parseInt(dateStr.slice(5,7), 10) - 1;
        counts[m] += map[dateStr].filter(function(t){ return t.status !== "done"; }).length;
      }
    });
    var grid = el("div", {style:"display:grid;grid-template-columns:repeat(3,1fr);gap:10px;"});
    var thisMonth = new Date().getMonth();
    MONTH_NAMES.forEach(function(name, i){
      var isCurrent = i === thisMonth;
      var cell = el("button", {style:"text-align:left;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--surface);cursor:pointer;" + (isCurrent ? "box-shadow:inset 0 0 0 2px var(--moss);" : "")}, [
        el("div", {style:"font-weight:600;font-size:14px;margin-bottom:4px;"}, [name]),
        el("div", {style:"font-size:12px;color:var(--ink-faint);"}, [counts[i] + (counts[i]===1 ? " open task" : " open tasks")])
      ]);
      cell.addEventListener("click", function(){
        yearlyPlan.mode = "month";
        yearlyPlan.anchor = isoDate(year, i+1, 1);
        renderShell();
      });
      grid.appendChild(cell);
    });
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
    DAY_NAMES.forEach(function(d){
      grid.appendChild(el("div", {style:"background:var(--surface-sunk);padding:6px 4px;font-size:10.5px;font-weight:700;text-align:center;color:var(--ink-faint);text-transform:uppercase;"}, [d.slice(0,3)]));
    });
    for (var i=0;i<totalCells;i++){
      var dayNum = i - startDow + 1;
      if (dayNum < 1 || dayNum > daysInMonth){
        grid.appendChild(el("div", {style:"background:var(--surface);min-height:66px;"}));
        continue;
      }
      var dateStr = isoDate(year, month+1, dayNum);
      var dayTasks = map[dateStr] || [];
      var isToday = dateStr === todayStr;
      var cell = el("div", {style:"background:var(--surface);min-height:66px;padding:4px;display:flex;flex-direction:column;gap:4px;cursor:pointer;" + (isToday ? "box-shadow:inset 0 0 0 2px var(--moss);" : ""), title:"Show this week"});
      // Tapping a day opens its week as a readable list — the dots alone
      // are too small to hit reliably on a phone.
      cell.addEventListener("click", (function(ds){ return function(){ yearlyPlan.mode = "week"; yearlyPlan.anchor = ds; renderShell(); }; })(dateStr));
      cell.appendChild(el("div", {style:"font-size:11px;color:var(--ink-faint);font-weight:600;"}, [String(dayNum)]));
      if (dayTasks.length){
        var dots = el("div", {style:"display:flex;flex-wrap:wrap;gap:3px;"});
        dayTasks.slice(0,8).forEach(function(t){
          var dot = el("button", {
            title: t.title + (t.plantName ? " — " + t.plantName : "") + (t.status==="done" ? " (done)" : ""),
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
        DAY_NAMES[d.getDay()] + " · " + MONTH_NAMES[d.getMonth()].slice(0,3) + " " + d.getDate() + (isToday ? " · today" : "")
      ]));
      if (dayTasks.length === 0){
        section.appendChild(el("div", {class:"empty", style:"padding:0 0 4px;"}, ["Nothing scheduled"]));
      } else {
        dayTasks.forEach(function(t){
          var row = el("button", {style:"display:flex;align-items:flex-start;gap:9px;width:100%;text-align:left;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:6px;background:var(--surface);cursor:pointer;" + (t.status==="done" ? "opacity:.55;" : "")}, [
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
      var closeBtn = el("button", {class:"hero-close", "aria-label":"Close", onclick:function(){ modalOpenFor=null; closeModal(); }}, ["×"]);
      container.appendChild(el("div", {class:"detail-hero"}, [
        plantPhotoEl(p),
        el("div", {class:"plant-overlay"}, [
          el("h3", {class:"plant-card-name", style:"color:inherit;"}, [p.name]),
          el("div", {class:"plant-card-sub"}, [[p.type, p.spot, p.species].filter(Boolean).join(" · ")])
        ]),
        closeBtn
      ]));

      container.appendChild(plantLevelBlock(p));

      var issueCount = state.tasks.filter(function(t){ return t.plantId === p.id && t.kind === "issue"; }).length;
      var tabs = [
        ["overview", "Overview"],
        ["care", "Care guide"],
        ["issues", "Issues" + ((p.activeIssue && p.activeIssue.description) ? " •" : (issueCount ? " (" + issueCount + ")" : ""))]
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
    var next = pk.missing[0];
    if (!next){
      main.appendChild(el("div", {class:"level-next"}, ["I know this plant well — keep the photos coming!"]));
      return block;
    }
    var stepLabel, stepFn;
    if (next.key === "guide"){
      stepLabel = "✨ Build care guide";
      stepFn = function(){ plantDetailTab = "care"; openPlantDetail(p.id, {keepTab:true, keepScroll:true}); };
    } else if (next.key === "photo"){
      stepLabel = next.text.charAt(0).toUpperCase() + next.text.slice(1);
      stepFn = function(){
        // The photo picker lives on the Overview tab — open it there. Still
        // inside this click, so the browser allows opening the file picker.
        if (plantDetailTab !== "overview"){ plantDetailTab = "overview"; openPlantDetail(p.id, {keepTab:true, keepScroll:true}); }
        var input = document.querySelector("#modalContent .overview-photo-input");
        if (input) input.click();
      };
    } else {
      stepLabel = next.btn || ({age:"Add its age", species:"Add species"})[next.key] || "Add";
      stepFn = function(){ openQuickAnswer(p, next.key); };
    }
    main.appendChild(el("div", {class:"level-next"}, ["Next step: " + next.text + (next.unlocks ? " — it helps unlock the care guide." : ".")]));
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
      var cmp = el("div", {class:"compare", style:"--split:50%;"}, [
        el("img", {src:first.dataUrl, alt:"First photo"}),
        el("img", {class:"compare-after", src:latest.dataUrl, alt:"Latest photo"}),
        el("div", {class:"compare-line"}),
        el("span", {class:"compare-tag", style:"left:8px;"}, [fmtDate(first.date)]),
        el("span", {class:"compare-tag", style:"right:8px;"}, ["Now"])
      ]);
      var range = el("input", {type:"range", min:"0", max:"100", value:"50", "aria-label":"Compare first and latest photo"});
      range.addEventListener("input", function(){ cmp.style.setProperty("--split", range.value + "%"); });
      cmp.appendChild(range);
      wrap.appendChild(cmp);
      wrap.appendChild(el("div", {class:"hint", style:"font-size:12px;color:var(--ink-faint);margin-bottom:10px;"}, ["Drag to compare your first photo with the latest."]));
    }
    var row = el("div", {class:"hscroll", style:"margin-bottom:8px;"});
    photos.slice().reverse().forEach(function(ph){
      row.appendChild(el("div", {class:"journal-card"}, [
        el("img", {src:ph.dataUrl, alt:"Photo from " + fmtDate(ph.date), loading:"lazy"}),
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
      el("h3", {style:"font-size:13px;"}, ["About this " + (p.type || "plant")])
    ]));
    if (p.careProfile){
      var blurbBits = [p.careProfile.sun, p.careProfile.watering, p.careProfile.soil].filter(Boolean);
      var aboutRow = el("div", {style:"font-size:13.5px;color:var(--ink-soft);margin-bottom:16px;"});
      if (blurbBits.length) aboutRow.appendChild(document.createTextNode(blurbBits.join(" · ") + "  "));
      var readMoreBtn = el("button", {class:"btn btn-ghost btn-sm", style:"padding:2px 4px;"}, ["Read more →"]);
      readMoreBtn.addEventListener("click", function(){ plantDetailTab = "care"; openPlantDetail(p.id, {keepTab:true}); });
      aboutRow.appendChild(readMoreBtn);
      container.appendChild(aboutRow);
    } else {
      var rd = careReadiness(p);
      var goCare = el("button", {class:"link-btn"}, [rd.ready ? "Build it now →" : "See what's needed →"]);
      goCare.addEventListener("click", function(){ plantDetailTab = "care"; openPlantDetail(p.id, {keepTab:true, keepScroll:true}); });
      container.appendChild(el("div", {class:"about-locked"}, [
        el("span", {"aria-hidden":"true"}, [rd.ready ? "✨" : "🔒"]),
        el("span", {}, [rd.ready ? "No care guide yet — it's ready to build. " : "No care guide yet — needs " + missingLabelList(rd.missing) + ". "]),
        goCare
      ]));
    }

    container.appendChild(el("div", {class:"section-head", style:"margin-bottom:8px;"}, [
      el("h3", {style:"font-size:15px;"}, ["Growth journal"]),
      el("span", {class:"hint"}, [(p.photos && p.photos.length) ? p.photos.length + (p.photos.length === 1 ? " photo" : " photos") : "photos over time"])
    ]));

    if (p.photos && p.photos.length){
      container.appendChild(growthJournal(p));
      var latest = p.photos[p.photos.length-1];
      if (latest.summary) container.appendChild(el("div", {class:"agent-note", style:"margin-bottom:10px;"}, [latest.summary]));
    } else {
      container.appendChild(el("div", {class:"empty", style:"margin-bottom:8px;"}, ["No photos yet — add one and I'll start a journal so you can watch it grow."]));
    }

    var noteInput = el("textarea", {placeholder:"Anything you've noticed? (optional)", style:"margin-bottom:6px;min-height:44px;"});
    container.appendChild(noteInput);
    var addPhotoLabel = el("label", {class:"btn btn-sm", style:"display:inline-block;"}, [p.photos && p.photos.length ? "+ Update photo" : "+ Add photo"]);
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
      var thinking = el("div", {class:"thinking"}, ["Taking a look…"]);
      addPhotoResult.appendChild(thinking);
      var result = await analyzeAndApplyPlantPhoto(dataUrl, p, noteInput.value.trim());
      thinking.remove();
      if (!result){
        addPhotoResult.appendChild(el("div", {class:"empty"}, [lastAnalysisMessage || ANALYZE_FAILED_MESSAGE]));
        return;
      }
      if (result.__photoOnly){
        // Photo was saved even though it couldn't be analyzed — say so
        // plainly (and let the user dismiss it) rather than silently
        // reopening as if nothing happened.
        await loadGardenData();
        addPhotoResult.appendChild(el("div", {class:"empty"}, [lastAnalysisMessage || PHOTO_ONLY_MESSAGE]));
        var continueBtn = el("button", {class:"btn btn-sm", style:"margin-top:8px;"}, ["OK"]);
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
        el("div", {style:"font-size:13px;"}, [el("span", {style:"color:var(--ink-faint);"}, ["Size "]), p.sizeInfo]),
        el("span", {style:"font-size:11px;color:var(--ink-faint);"}, ["from photos"])
      ]);
      detailsList.appendChild(sizeRow);
    }
    [["spot","Spot"],["species","Species"]].forEach(function(f){
      var v = plantFieldValue(p, f[0]);
      var r = el("div", {class:"detail-row"}, [
        v ? el("div", {style:"font-size:13px;"}, [el("span", {style:"color:var(--ink-faint);"}, [f[1] + " "]), v])
          : el("div", {style:"font-size:13px;color:var(--ink-faint);"}, [f[1] + " — not set"])
      ]);
      var b = el("button", {class:"btn btn-ghost btn-sm"}, [v ? "Edit" : "Add"]);
      b.addEventListener("click", function(){ openQuickAnswer(p, f[0]); });
      r.appendChild(b);
      detailsList.appendChild(r);
    });
    GET_TO_KNOW_QUESTIONS.forEach(function(q, qi){
      var entry = detailEntryOf(p, q.key);
      var detailRow = el("div", {class:"detail-row"});
      var textPart = entry
        ? el("div", {style:"font-size:13px;"}, [el("span", {style:"color:var(--ink-faint);"}, [q.shortLabel + " "]), entry.display || entry.raw])
        : el("div", {style:"font-size:13px;color:var(--ink-faint);"}, [q.shortLabel + " — not set"]);
      detailRow.appendChild(textPart);
      var detailBtn = el("button", {class:"btn btn-ghost btn-sm"}, [entry ? "Edit" : "Add"]);
      detailBtn.addEventListener("click", function(){
        if (QUICK_FIELDS[q.key]) openQuickAnswer(p, q.key);
        else openGetToKnowPlant(p, {onlyIndex: qi});
      });
      detailRow.appendChild(detailBtn);
      detailsList.appendChild(detailRow);
    });
    container.appendChild(detailsList);

    var knowBtn = el("button", {class:"btn btn-sm", style:"margin-top:12px;"}, ["Walk through all details"]);
    knowBtn.addEventListener("click", function(){ openGetToKnowPlant(p); });
    container.appendChild(knowBtn);

    var addTaskBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-top:16px;display:block;"}, ["+ Add a task for this plant"]);
    addTaskBtn.addEventListener("click", function(){ modalOpenFor = null; openTaskForm(null, {plantId:p.id}); });
    container.appendChild(addTaskBtn);

    var askBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-top:4px;display:block;"}, ["Ask about this plant →"]);
    askBtn.addEventListener("click", function(){
      closeModal(); modalOpenFor=null;
      openAsk("About my " + p.name + ": ");
    });
    container.appendChild(askBtn);
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
      el("h3", {style:"font-size:15px;"}, ["Care guide"]),
      el("span", {class:"hint"}, ["for this plant, in its spot"])
    ]));
    var cg = el("dl", {class:"care-grid"});
    var fields = [["soil","Soil / ground"],["sun","Sunlight"],["watering","Watering"],["nutrients","Nutrients"],["pruning","Pruning"],["frostSensitive","Frost sensitivity"],["commonIssues","Watch for"]];
    fields.forEach(function(f){
      if (p.careProfile[f[0]]) cg.appendChild(el("div", {}, [el("dt",{},[f[1]]), el("dd",{},[p.careProfile[f[0]]])]));
    });
    container.appendChild(cg);
    var researchBtn = el("button", {class:"btn btn-sm btn-ghost", style:"margin-top:8px;"}, ["Update care guide"]);
    researchBtn.title = "Rebuilds this guide from the species plus what you've told me about its spot. Won't touch its photos, details or health.";
    researchBtn.addEventListener("click", async function(){
      researchBtn.disabled = true; researchBtn.textContent = "Updating…";
      var ok = await researchPlant(p.id);
      if (ok){
        // Refresh everything (this plant, the grade bar, the yearly schedule
        // that now exists) and rebuild the modal fresh rather than patching
        // pieces by hand — that's what was leaving the card/schedule stale.
        await loadGardenData();
        openPlantDetail(p.id, {keepTab:true});
      } else {
        researchBtn.textContent = "Couldn't update — try again";
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
      el("h3", {style:"font-size:15px;"}, ["Tracked issues"]),
      el("span", {class:"hint"}, ["active + history"])
    ]));

    if (p.activeIssue && p.activeIssue.description){
      container.appendChild(el("div", {class:"agent-note", style:"margin-bottom:6px;"}, [
        "Currently tracking, since " + fmtDate(p.activeIssue.since) + ": " + p.activeIssue.description
      ]));
      container.appendChild(el("div", {class:"empty", style:"margin-bottom:14px;"}, ["Each plant tracks one issue at a time — reporting a new problem below will replace this as the active issue."]));
    } else {
      container.appendChild(el("div", {class:"empty", style:"margin-bottom:14px;"}, ["Nothing currently being tracked — looking healthy."]));
    }

    var reportBtn = el("button", {class:"btn btn-sm", style:"margin-bottom:16px;"}, [p.activeIssue && p.activeIssue.description ? "Report a different problem" : "Report a problem"]);
    reportBtn.addEventListener("click", function(){ openReportProblem(p); });
    container.appendChild(reportBtn);

    var issueTasks = state.tasks
      .filter(function(t){ return t.plantId === p.id && t.kind === "issue"; })
      .sort(function(a,b){ return (b.createdAt||"").localeCompare(a.createdAt||""); });

    container.appendChild(el("div", {style:"font-size:12.5px;font-weight:600;color:var(--ink-soft);margin-bottom:6px;"}, ["History"]));
    if (issueTasks.length === 0){
      container.appendChild(el("div", {class:"empty"}, ["No issues reported yet for this plant."]));
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
    {key:"age", shortLabel:"Age", label:"About how old is it?", hint:"How old is this plant, or how long since you planted it?", placeholder:"e.g. planted about 2 years ago"},
    {key:"yieldPerYear", shortLabel:"Yearly yield", label:"How much does it produce each year?", hint:"Roughly how many fruits, vegetables or flowers a year — skip if not applicable.", placeholder:"e.g. 20-30 lemons a season"},
    {key:"groundType", shortLabel:"Ground", label:"What's the ground like there?", hint:"Soil type or growing setup at its actual spot.", placeholder:"e.g. clay soil, raised bed, pot with drainage holes"},
    {key:"watering", shortLabel:"Watering", label:"How do you water it?", hint:"Method, and roughly how often.", placeholder:"e.g. drip irrigation every other day"},
    {key:"sunExposure", shortLabel:"Sun exposure", label:"How much sun does that spot get?", hint:"Sun exposure at its actual location.", placeholder:"e.g. full sun most of the day, shaded in the afternoon"}
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
        el("h3", {style:"font-size:17px;"}, ["Get to know " + p.name]),
        el("button", {class:"modal-close", onclick:closeModal}, ["×"])
      ]));
      var backBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-bottom:14px;"}, ["← Back to plant"]);
      backBtn.addEventListener("click", function(){ openPlantDetail(p.id, {keepTab:true}); });
      container.appendChild(backBtn);

      if (qIndex >= GET_TO_KNOW_QUESTIONS.length){
        container.appendChild(el("h2", {style:"font-size:18px;margin:2px 0 6px;"}, ["All set"]));
        container.appendChild(el("p", {class:"lead", style:"font-size:13.5px;margin:0 0 14px;"}, [
          "Saved what you told me — you can revisit any of these anytime from the Profile section on the Overview tab."
        ]));
        var doneBtn = el("button", {class:"btn btn-primary"}, ["Back to plant"]);
        doneBtn.addEventListener("click", function(){ openPlantDetail(p.id, {keepTab:true}); });
        container.appendChild(doneBtn);
        return;
      }

      var q = GET_TO_KNOW_QUESTIONS[qIndex];
      if (onlyIndex === null){
        container.appendChild(el("div", {class:"empty", style:"margin-bottom:2px;"}, ["Question " + (qIndex+1) + " of " + GET_TO_KNOW_QUESTIONS.length]));
      }
      container.appendChild(el("h2", {style:"font-size:18px;margin:2px 0 4px;"}, [q.label]));
      container.appendChild(el("p", {class:"lead", style:"font-size:13px;margin:0 0 12px;"}, [q.hint]));

      var input = el("textarea", {placeholder:q.placeholder, style:"min-height:56px;"});
      var existingEntry = detailEntryOf(p, q.key);
      if (existingEntry) input.value = existingEntry.raw;
      container.appendChild(input);

      var isLast = onlyIndex === null && qIndex === GET_TO_KNOW_QUESTIONS.length - 1;
      var skipBtn = el("button", {class:"btn btn-ghost"}, ["Skip"]);
      var nextBtn = el("button", {class:"btn btn-primary"}, [onlyIndex !== null ? "Save" : (isLast ? "Finish" : "Next →")]);

      function advance(){
        if (onlyIndex !== null){ openPlantDetail(p.id, {keepTab:true}); }
        else { openGetToKnowPlant(p, {step: qIndex + 1}); }
      }
      skipBtn.addEventListener("click", function(){ advance(); });
      nextBtn.addEventListener("click", async function(){
        nextBtn.disabled = true; skipBtn.disabled = true; nextBtn.textContent = "Saving…";
        var val = input.value.trim();
        if (val){
          try {
            // Saves {raw, display} to plantDetails[q.key] (and ageEstimate for
            // "age") server-side, normalizing the display form there.
            await api("/plants/" + p.id + "/details", {method:"POST", body:{key:q.key, rawText:val}});
            await loadGardenData();
          } catch(e){
            nextBtn.disabled = false; skipBtn.disabled = false;
            nextBtn.textContent = "Couldn't save — try again";
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
        el("h3", {style:"font-size:17px;"}, ["Report a problem — " + p.name]),
        el("button", {class:"modal-close", onclick:closeModal}, ["×"])
      ]));
      var backBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-bottom:14px;"}, ["← Back"]);
      backBtn.addEventListener("click", function(){ openPlantDetail(p.id, {keepTab:true}); });
      container.appendChild(backBtn);

      var descTa = el("textarea", {placeholder:"What are you seeing? e.g. \"leaves are turning yellow at the tips\"", style:"min-height:70px;"});
      container.appendChild(el("div", {class:"field"}, [el("label",{},["Describe the problem"]), descTa]));

      var photoResult = el("div", {});
      var photoLabel = el("label", {class:"btn btn-sm", style:"margin-bottom:10px;display:inline-block;"}, ["+ Attach a photo (optional)"]);
      var photoInput = el("input", {type:"file", accept:"image/*", class:"sr-only"});
      photoLabel.appendChild(photoInput);
      container.appendChild(photoLabel);
      container.appendChild(photoResult);
      photoInput.addEventListener("change", async function(){
        var f = photoInput.files[0]; if (!f) return;
        pendingPhoto = await resizeImage(f);
        photoResult.innerHTML = "";
        photoResult.appendChild(el("img", {class:"photo-preview", src:pendingPhoto, style:"max-width:200px;"}));
        photoLabel.textContent = "Photo attached — tap to replace";
        photoLabel.appendChild(photoInput);
      });

      var resultBox = el("div", {});
      var submitBtn = el("button", {class:"btn btn-primary btn-sm", style:"margin-top:14px;"}, ["Submit"]);
      submitBtn.addEventListener("click", async function(){
        var text = descTa.value.trim();
        if (!text && !pendingPhoto) return;
        submitBtn.disabled = true; submitBtn.textContent = "Thinking…";
        var result = await reportPlantIssue(p, text, pendingPhoto);
        submitBtn.disabled = false; submitBtn.textContent = "Submit";
        resultBox.innerHTML = "";
        if (!result){
          resultBox.appendChild(el("div", {class:"empty"}, [lastAnalysisMessage || ANALYZE_FAILED_MESSAGE]));
          try { await loadGardenData(); } catch(e){}
          return;
        }
        await loadGardenData();
        resultBox.appendChild(el("div", {class:"agent-note"}, [result.summary || "Got it — I've added care tasks."]));
        if (!result.__photoOnly){
          resultBox.appendChild(el("div", {class:"chip chip-warn", style:"margin-top:8px;"}, ["Care tasks added — see This week"]));
        }
        var doneBtn = el("button", {class:"btn btn-sm", style:"margin-top:12px;display:block;"}, ["Back to plant"]);
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
    var thinking = el("div", {class:"thinking"}, ["Thinking…"]);
    body.appendChild(thinking);
    body.scrollTop = body.scrollHeight;
    try {
      var res = await api("/ask", {method:"POST", body:{turns:askTurns}});
      askTurns.push({role:"assistant", content:(res && res.text) || "Sorry, I couldn't answer that just now."});
    } catch(e){
      askTurns.push({role:"assistant", content:"Sorry, I couldn't answer that just now."});
    }
    renderAskBody();
  }
  function renderAskBody(){
    var body = document.getElementById("askBody");
    body.innerHTML = "";
    if (askTurns.length === 0){
      body.appendChild(el("div", {class:"bubble assistant"}, ["Ask me anything about your garden — what to do this week, how a plant's doing, or general advice."]));
    }
    askTurns.forEach(function(t){ body.appendChild(el("div", {class:"bubble " + t.role}, [t.content])); });
    body.scrollTop = body.scrollHeight;
  }

  boot();
})();
