// Garden Companion — weather tips for the dashboard's "Garden tips" cards:
// a few cards driven by the actual forecast (frost, heat, heavy rain, wind),
// shown before the month's seasonal tips. The seasonal tips themselves are
// written per garden by the model (GET /api/tips — lib/handlers/garden-tips.js),
// from its location, measured climate and plants; this file used to hold a
// fixed temperate-climate list, which gave advice like frost protection in
// places where it never freezes.
//
// Each tip: {id, emoji, theme, weather:true, title, body, task:{title,
// description, dueInDays}} — the same shape as the server's tips, so the
// cards and "Add as task" treat both alike.
(function(){
  "use strict";
  var t = window.I18N.t; // see i18n.js

  // Weather-driven tips, shown first when the forecast calls for them. The
  // text is translated when built, so the task added from a tip is saved in
  // the gardener's language.
  function weatherTips(weather){
    var out = [];
    if (!weather) return out;
    var alert = (weather.alert || "").toLowerCase();
    var forecast = (weather.forecast || "").toLowerCase();
    var hi = parseInt((String(weather.tempLabel || "").match(/-?\d+/) || [])[0], 10); // "31° / 21°" -> 31
    if (/frost|freez/.test(alert)){
      out.push({id:"wx-frost", emoji:"❄️", theme:"winter", weather:true,
        title:t("Frost on the way"),
        body:t("Cover tender plants with fleece tonight and move pots next to the house."),
        task:{title:t("Cover tender plants before the frost"), description:t("Fleece over tender plants, pots against the house wall."), dueInDays:0}});
    }
    if (/heat/.test(alert) || hi >= 33){
      out.push({id:"wx-heat", emoji:"🥵", theme:"summer", weather:true,
        title:t("Hot day ahead"),
        body:t("Water early in the morning, give pots a deep soak and shade anything newly planted."),
        task:{title:t("Deep morning watering before the heat"), description:t("Water early, soak pots thoroughly, shade new plantings."), dueInDays:0}});
    }
    var rainPct = parseInt((forecast.match(/(\d+)% chance of rain/) || [])[1], 10);
    if (rainPct >= 60){
      out.push({id:"wx-rain", emoji:"🌧️", theme:"spring", weather:true,
        title:t("Rain is coming"),
        body:t("Skip watering today — and it's a perfect moment to feed plants so the rain washes it in."),
        task:{title:t("Feed plants before the rain"), description:t("Scatter slow-release fertilizer so the rain washes it in; skip watering."), dueInDays:0}});
    }
    if (/wind|gale|storm/.test(alert)){
      out.push({id:"wx-wind", emoji:"💨", theme:"autumn", weather:true,
        title:t("Windy weather"),
        body:t("Check stakes and ties, and move tall pots somewhere sheltered."),
        task:{title:t("Secure stakes and move tall pots"), description:t("Check ties and supports; shelter tall or top-heavy pots."), dueInDays:0}});
    }
    return out;
  }

  window.GardenTips = { weatherTips: weatherTips };
})();
