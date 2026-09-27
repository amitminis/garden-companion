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
      tasks:'<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>'
    };
    return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+(paths[name]||paths.leaf)+'</svg>';
  }
  function weatherIconFor(text){
    text = (text||"").toLowerCase();
    if (/rain|storm|shower/.test(text)) return "rain";
    if (/cloud|overcast/.test(text)) return "cloud";
    return "sun";
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
        if (!modalOpenFor) renderShell();
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
      if (!modalOpenFor) renderShell();
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
      el("h2", {}, ["Want to start building your plant library now?"]),
      el("p", {class:"lead"}, ["I'll guide you through adding each plant with a short form — or you can skip this and do it anytime from the Library section."])
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
        : "Your garden is set up. Add plants anytime from the Library section."])
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
      photos: [], plantId: null, building:false, buildError:"", result:null
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

    if (wiz.buildError) card.appendChild(el("div", {class:"empty", style:"margin-bottom:8px;"}, [wiz.buildError]));

    var row = el("div", {class:"row", style:"justify-content:space-between;margin-top:6px;"});
    var backBtn = el("button", {class:"btn btn-ghost"}, ["← Back"]);
    backBtn.addEventListener("click", function(){ wiz.step--; opts.rerender(); });
    var buildBtn = el("button", {class:"btn btn-primary"}, [wiz.building ? "Building…" : "Build my plant card →"]);
    buildBtn.disabled = wiz.building;
    buildBtn.addEventListener("click", async function(){
      wiz.building = true; wiz.buildError = ""; opts.rerender();
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
    if (ok){
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

  function plantKnowledge(p){
    var reasons = [];
    var score = 0;
    if (p.researched && p.careProfile) score += 25; else reasons.push("care guide not researched yet");
    var photos = p.photos || [];
    if (photos.length > 0) score += 20; else reasons.push("no photo yet");
    if (photos.length > 0){
      var days = (Date.now() - new Date(photos[photos.length-1].date).getTime()) / 86400000;
      if (days <= 28) score += 20; else reasons.push("photo update overdue");
    } else reasons.push("photo update overdue");
    if (p.sizeInfo) score += 15; else reasons.push("size/age unknown");
    if (p.healthStatus !== "needs_attention") score += 20; else reasons.push("active issue being tracked");
    return {score:score, reasons:reasons};
  }
  function gradeLabelFor(score){ return score>=80 ? "Well known" : (score>=50 ? "Getting there" : "Still learning"); }

  // ---------------------------------------------------------------
  // DASHBOARD
  // ---------------------------------------------------------------
  var modalOpenFor = null;

  // state.section drives which of the three app sections (Tasks/Library/
  // Calendar) is showing; renderShell() rebuilds the whole shell (topbar +
  // tab bar + the active section) every time it's called, same "full
  // re-render on any state change" approach the rest of the app already uses.
  function renderShell(){
    var app = document.getElementById("app");
    app.innerHTML = "";
    var shell = el("div", {class:"shell"});

    shell.appendChild(el("div", {class:"topbar"}, [
      el("div", {class:"brand"}, [el("span", {class:"mark", html:icon("leaf")}), el("h1", {}, ["Garden Companion"])]),
      el("div", {class:"row", style:"align-items:center;gap:10px;"}, [
        el("div", {class:"date"}, [new Date().toLocaleDateString(undefined,{weekday:"long", month:"long", day:"numeric"})]),
        el("button", {class:"btn btn-ghost btn-sm", onclick:openSettings}, ["Settings"])
      ])
    ]));

    shell.appendChild(sectionTabBar());

    if (state.section === "library") shell.appendChild(librarySection());
    else if (state.section === "calendar") shell.appendChild(calendarSection());
    else shell.appendChild(tasksHomeSection());

    app.appendChild(shell);
    document.getElementById("askFab").hidden = false;
  }

  function sectionTabBar(){
    var tabs = [["tasks","Tasks","tasks"], ["library","Library","library"], ["calendar","Calendar","calendar"]];
    var wrap = el("div", {class:"tab-bar"});
    tabs.forEach(function(t){
      var btn = el("button", {class:"tab-btn" + (state.section===t[0] ? " active" : "")}, [
        el("span", {class:"icon", html:icon(t[2])}), t[1]
      ]);
      btn.addEventListener("click", function(){
        if (state.section === t[0]) return;
        state.section = t[0];
        renderShell();
        // Refresh in the background so switching tabs shows current data
        // without blocking the tab switch itself on a network round trip.
        loadGardenData().then(function(){ if (state.section === t[0]) renderShell(); }).catch(function(){});
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function tasksHomeSection(){
    var wrap = el("div", {});
    wrap.appendChild(weatherCard());
    wrap.appendChild(tasksSection(thisWeekTasks()));
    wrap.appendChild(upcomingSection(upcomingTasks()));
    var doneRecent = state.tasks.filter(function(t){ return t.status === "done"; }).slice(0,6);
    if (doneRecent.length) wrap.appendChild(doneSection(doneRecent));
    return wrap;
  }

  function weatherCard(){
    var w = state.weather;
    var body;
    if (!w){
      body = [
        el("div", {html:icon("sun"), class:"icon-lg"}),
        el("div", {}, [
          el("div", {class:"desc"}, ["Weather check-in hasn't run yet"]),
          el("div", {class:"loc"}, ["Your first daily check-in will fetch conditions for " + ((state.settings.location||{}).label || "your garden")])
        ])
      ];
    } else {
      body = [
        el("div", {html:icon(weatherIconFor(w.summary || w.forecast)), class:"icon-lg"}),
        el("div", {}, [
          el("div", {class:"temp"}, [w.tempLabel || w.summary || "—"]),
          el("div", {class:"desc"}, [w.forecast || w.summary || ""]),
          el("div", {class:"loc"}, [(w.locationLabel||"") + " · updated " + fmtDate(w.fetchedAt)])
        ])
      ];
      if (w.alert){
        body.push(el("div", {class:"alert chip chip-crit"}, [w.alert]));
      }
    }
    var refreshBtn = el("button", {class:"btn btn-ghost btn-sm icon-btn", title:"Check weather now", "aria-label":"Refresh weather", style:"margin-left:auto;flex:none;"}, [el("span", {html:icon("refresh")})]);
    refreshBtn.addEventListener("click", async function(){
      refreshBtn.disabled = true; refreshBtn.classList.add("spinning");
      try { await refreshWeatherNow(); }
      finally { refreshBtn.disabled = false; refreshBtn.classList.remove("spinning"); }
    });
    body.push(refreshBtn);
    return el("div", {class:"card weather", style:"margin-bottom:20px;"}, body);
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

  function tasksSection(tasks){
    var sec = el("div", {class:"card", style:"margin-bottom:20px;"});
    sec.appendChild(el("div", {class:"section-head"}, [
      el("h2", {}, ["This week"]),
      el("span", {class:"hint"}, [tasks.length + (tasks.length===1?" open":" open")])
    ]));
    if (tasks.length === 0){
      sec.appendChild(el("div", {class:"empty"}, ["Nothing due this week — I'll add tasks here each morning when something needs attention."]));
    } else {
      tasks.forEach(function(t){ sec.appendChild(taskListRow(t)); });
    }
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
    var sec = el("div", {class:"card", style:"margin-bottom:20px;"});
    sec.appendChild(el("div", {class:"section-head"}, [
      el("h2", {}, ["Upcoming"]),
      el("span", {class:"hint"}, ["next 2 weeks"])
    ]));
    if (tasks.length === 0){
      sec.appendChild(el("div", {class:"empty"}, ["Nothing scheduled in the two weeks after this one yet."]));
    } else {
      tasks.forEach(function(t){ sec.appendChild(taskListRow(t)); });
    }
    return sec;
  }

  function doneSection(tasks){
    var sec = el("div", {class:"card", style:"margin-bottom:20px;"});
    sec.appendChild(el("div", {class:"section-head"}, [el("h2", {}, ["Recently done"])]));
    tasks.forEach(function(t){ sec.appendChild(taskListRow(t)); });
    return sec;
  }

  // A minimal, single-line, clickable task row for the dashboard lists — a
  // colored dot (this task's plant), the title, a couple of compact badges,
  // and the date. Click opens the full detail in a modal (openTaskDetail);
  // there's no inline checkbox or expand here on purpose, per the user's
  // request to keep the list itself minimal.
  function taskListRow(t){
    var overdue = t.status !== "done" && t.dueDate && t.dueDate < todayISO();
    var row = el("button", {class:"task-mini" + (t.status==="done" ? " done" : "")}, [
      el("span", {class:"task-mini-dot", style:"background:" + (t.plantId ? plantColorFor(t.plantId) : "var(--ink-faint)") + ";"}),
      el("span", {class:"task-mini-title"}, [t.title]),
      t.plantName ? el("span", {class:"chip chip-moss"}, [t.plantName]) : null,
      overdue ? el("span", {class:"chip chip-warn"}, ["Overdue"]) : null,
      t.requestsPhoto ? el("span", {class:"chip chip-neutral"}, ["📷"]) : null,
      el("span", {class:"task-mini-date"}, [fmtDate(t.dueDate)])
    ]);
    row.addEventListener("click", function(){ openTaskDetail(t.id, {allowComplete:true}); });
    return row;
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

    return wrap;
  }

  function librarySection(){
    var sec = el("div", {class:"card"});
    if (state.plants.length === 0){
      sec.appendChild(el("div", {class:"section-head"}, [el("h2", {}, ["Your library"])]));
      var cta = el("div", {style:"text-align:center;padding:24px 12px;"}, [
        el("div", {html:icon("leaf"), class:"icon-lg", style:"margin:0 auto 10px;"}),
        el("p", {class:"lead", style:"margin-bottom:14px;"}, ["No plants yet — add your first one and I'll build a care guide for it."])
      ]);
      var ctaBtn = el("button", {class:"btn btn-primary"}, ["+ Start building your plant library"]);
      ctaBtn.addEventListener("click", openPlantWizard);
      cta.appendChild(ctaBtn);
      sec.appendChild(cta);
    } else {
      sec.appendChild(el("div", {class:"section-head"}, [
        el("h2", {}, ["Your library"]),
        el("button", {class:"btn btn-sm", onclick:openPlantWizard}, ["+ Add a plant"])
      ]));
      var grid = el("div", {class:"plant-grid"});
      state.plants.forEach(function(p){ grid.appendChild(plantCard(p)); });
      sec.appendChild(grid);
    }
    return sec;
  }

  function plantCard(p){
    var lastPhoto = (p.photos && p.photos.length) ? p.photos[p.photos.length-1] : null;
    var thumb = lastPhoto
      ? el("img", {class:"plant-thumb", src:lastPhoto.dataUrl, alt:p.name})
      : el("div", {class:"plant-thumb-placeholder", html:icon("leaf")});
    var status = p.healthStatus === "needs_attention"
      ? el("span", {class:"chip chip-warn"}, ["Needs attention"])
      : (p.researched ? el("span", {class:"chip chip-moss"}, ["Care guide ready"]) : el("span", {class:"chip chip-neutral"}, ["Getting to know it"]));
    var k = plantKnowledge(p);
    var card = el("button", {class:"plant-card"}, [
      thumb,
      el("div", {class:"plant-info"}, [
        el("div", {class:"plant-name"}, [p.name]),
        el("div", {class:"plant-type"}, [p.type + (p.spot ? " · " + p.spot : "")]),
        el("div", {class:"plant-status"}, [status]),
        el("div", {class:"grade-row", title:gradeLabelFor(k.score) + " · " + k.score + "%"}, [
          el("div", {class:"grade-track"}, [el("div", {class:"grade-fill", style:"width:" + k.score + "%;"})])
        ])
      ])
    ]);
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

      container.appendChild(el("p", {style:"font-size:12.5px;color:var(--ink-faint);margin:0 0 16px;"}, [
        "Weather and care checks run early each morning. New plants get researched within about an hour of adding them — no need to wait for the daily check-in."
      ]));

      var saveBtn = el("button", {class:"btn btn-primary btn-sm"}, ["Save"]);
      saveBtn.addEventListener("click", async function(){
        saveBtn.disabled = true; saveBtn.textContent = "Saving…";
        var loc = Object.assign({}, s.location, {label: locInput.value || "Unspecified"});
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
      var cell = el("div", {style:"background:var(--surface);min-height:66px;padding:4px;display:flex;flex-direction:column;gap:4px;" + (isToday ? "box-shadow:inset 0 0 0 2px var(--moss);" : "")});
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
      container.appendChild(el("div", {class:"modal-head"}, [
        el("h3", {}, [p.name]),
        el("button", {class:"modal-close", onclick:function(){ modalOpenFor=null; closeModal(); }}, ["×"])
      ]));
      container.appendChild(el("div", {class:"plant-type", style:"margin-bottom:10px;"}, [p.type + (p.spot?" · "+p.spot:"") + (p.species?" · "+p.species:"")]));

      var pk = plantKnowledge(p);
      container.appendChild(el("div", {class:"grade-block", style:"margin-bottom:16px;"}, [
        el("div", {style:"display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;"}, [
          el("span", {style:"font-size:12.5px;font-weight:600;color:var(--ink-soft);"}, ["How well I know this plant"]),
          el("span", {style:"font-size:12.5px;color:var(--ink-faint);"}, [gradeLabelFor(pk.score) + " · " + pk.score + "%"])
        ]),
        el("div", {class:"grade-track"}, [el("div", {class:"grade-fill", style:"width:" + pk.score + "%;"})]),
        pk.reasons.length ? el("div", {style:"margin-top:6px;font-size:12px;color:var(--ink-faint);"}, ["Missing: " + pk.reasons.join(", ")]) : null
      ]));

      var overviewTabBtn = el("button", {class:"btn btn-sm" + (plantDetailTab==="overview" ? "" : " btn-ghost")}, ["Overview"]);
      var careTabBtn = el("button", {class:"btn btn-sm" + (plantDetailTab==="care" ? "" : " btn-ghost")}, ["Care guide"]);
      var issueCount = state.tasks.filter(function(t){ return t.plantId === p.id && t.kind === "issue"; }).length;
      var issuesTabBtn = el("button", {class:"btn btn-sm" + (plantDetailTab==="issues" ? "" : " btn-ghost")}, [
        "Issues" + ((p.activeIssue && p.activeIssue.description) ? " •" : (issueCount ? " (" + issueCount + ")" : ""))
      ]);
      overviewTabBtn.addEventListener("click", function(){ plantDetailTab = "overview"; openPlantDetail(p.id, {keepTab:true}); });
      careTabBtn.addEventListener("click", function(){ plantDetailTab = "care"; openPlantDetail(p.id, {keepTab:true}); });
      issuesTabBtn.addEventListener("click", function(){ plantDetailTab = "issues"; openPlantDetail(p.id, {keepTab:true}); });
      container.appendChild(el("div", {class:"row", style:"gap:6px;margin-bottom:16px;border-bottom:1px solid var(--line);padding-bottom:12px;"}, [overviewTabBtn, careTabBtn, issuesTabBtn]));

      if (plantDetailTab === "care") buildPlantCareTab(container, p);
      else if (plantDetailTab === "issues") buildPlantIssuesTab(container, p);
      else buildPlantOverviewTab(container, p);
    });
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
      container.appendChild(el("div", {class:"empty", style:"margin-bottom:16px;"}, ["Care guide not ready yet — this happens automatically moments after a plant is added."]));
    }

    container.appendChild(el("div", {class:"section-head", style:"margin-bottom:8px;"}, [
      el("h3", {style:"font-size:15px;"}, ["Profile"]),
      el("span", {class:"hint"}, ["photo + what you know about this one"])
    ]));

    if (p.photos && p.photos.length){
      var pw = el("div", {class:"plant-detail-photos", style:"margin-bottom:8px;"});
      p.photos.forEach(function(ph){ pw.appendChild(el("img", {src:ph.dataUrl, title:fmtDate(ph.date)})); });
      container.appendChild(pw);
      var latest = p.photos[p.photos.length-1];
      if (latest.summary) container.appendChild(el("div", {class:"agent-note", style:"margin-bottom:10px;"}, [latest.summary]));
    } else {
      container.appendChild(el("div", {class:"empty", style:"margin-bottom:8px;"}, ["No photo yet."]));
    }

    var noteInput = el("textarea", {placeholder:"Anything you've noticed? (optional)", style:"margin-bottom:6px;min-height:44px;"});
    container.appendChild(noteInput);
    var addPhotoLabel = el("label", {class:"btn btn-sm", style:"display:inline-block;"}, [p.photos && p.photos.length ? "+ Update photo" : "+ Add photo"]);
    var addPhotoInput = el("input", {type:"file", accept:"image/*", class:"sr-only"});
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
      var sizeRow = el("div", {class:"row", style:"justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);"}, [
        el("div", {style:"font-size:13px;"}, [el("span", {style:"color:var(--ink-faint);"}, ["Size "]), p.sizeInfo]),
        el("span", {style:"font-size:11px;color:var(--ink-faint);"}, ["from photos"])
      ]);
      detailsList.appendChild(sizeRow);
    }
    GET_TO_KNOW_QUESTIONS.forEach(function(q, qi){
      var entry = detailEntryOf(p, q.key);
      var detailRow = el("div", {class:"row", style:"justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);"});
      var textPart = entry
        ? el("div", {style:"font-size:13px;"}, [el("span", {style:"color:var(--ink-faint);"}, [q.shortLabel + " "]), entry.display || entry.raw])
        : el("div", {style:"font-size:13px;color:var(--ink-faint);"}, [q.shortLabel + " — not set"]);
      detailRow.appendChild(textPart);
      var detailBtn = el("button", {class:"btn btn-ghost btn-sm"}, [entry ? "Edit" : "Add"]);
      detailBtn.addEventListener("click", function(){ openGetToKnowPlant(p, {onlyIndex: qi}); });
      detailRow.appendChild(detailBtn);
      detailsList.appendChild(detailRow);
    });
    container.appendChild(detailsList);

    var knowBtn = el("button", {class:"btn btn-sm", style:"margin-top:12px;"}, ["Walk through all details"]);
    knowBtn.addEventListener("click", function(){ openGetToKnowPlant(p); });
    container.appendChild(knowBtn);

    var askBtn = el("button", {class:"btn btn-ghost btn-sm", style:"margin-top:16px;display:block;"}, ["Ask about this plant →"]);
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
    container.appendChild(el("div", {class:"section-head", style:"margin-bottom:8px;"}, [
      el("h3", {style:"font-size:15px;"}, ["Care guide"]),
      el("span", {class:"hint"}, ["what this kind of plant needs"])
    ]));
    if (p.careProfile){
      var cg = el("dl", {class:"care-grid"});
      var fields = [["soil","Soil / ground"],["sun","Sunlight"],["watering","Watering"],["nutrients","Nutrients"],["pruning","Pruning"],["frostSensitive","Frost sensitivity"],["commonIssues","Watch for"]];
      fields.forEach(function(f){
        if (p.careProfile[f[0]]) cg.appendChild(el("div", {}, [el("dt",{},[f[1]]), el("dd",{},[p.careProfile[f[0]]])]));
      });
      container.appendChild(cg);
    } else {
      container.appendChild(el("div", {class:"empty", style:"margin-bottom:10px;"}, ["Not researched yet — this happens automatically moments after a plant is added."]));
    }
    var researchBtn = el("button", {class:"btn btn-sm btn-ghost", style:"margin-top:8px;"}, [p.careProfile ? "Update research" : "Research now"]);
    researchBtn.title = "Re-runs species research and overwrites this guide. Won't touch this plant's own profile (photo/details/health).";
    researchBtn.addEventListener("click", async function(){
      researchBtn.disabled = true; researchBtn.textContent = "Researching…";
      var ok = await researchPlant(p.id);
      if (ok){
        // Refresh everything (this plant, the grade bar, the yearly schedule
        // that now exists) and rebuild the modal fresh rather than patching
        // pieces by hand — that's what was leaving the card/schedule stale.
        await loadGardenData();
        openPlantDetail(p.id, {keepTab:true});
      } else {
        researchBtn.textContent = "Couldn't research — try again";
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

  function showModal(build){
    var overlay = document.getElementById("overlay");
    var content = document.getElementById("modalContent");
    content.innerHTML = "";
    build(content);
    overlay.hidden = false;
  }
  function closeModal(){
    document.getElementById("overlay").hidden = true;
    modalOpenFor = null;
    // The section behind the modal was frozen while it was open (live updates
    // still landed in `state`, they just weren't drawn) — repaint now so the
    // knowledge bar, status chips and task list reflect whatever just happened.
    renderShell();
  }
  document.getElementById("overlay").addEventListener("click", function(e){
    if (e.target.id === "overlay") closeModal();
  });

  // ---------------------------------------------------------------
  // ASK PANEL
  // ---------------------------------------------------------------
  var askTurns = [];
  // The garden-context system message (location + plant list) is built
  // server-side from the database now — see api/ask.js.
  function openAsk(prefill){
    document.getElementById("askPanel").hidden = false;
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
