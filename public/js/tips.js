// Garden Companion — seasonal tips library for the dashboard's "Garden
// tips" cards ("It's bulb-buying time", "Get ready for spring — sow flower
// seeds", ...). Plain data + one selection function, no network and no AI
// call, so the cards are instant and free. app.js renders them and turns a
// tip into a task through the existing POST /api/tasks route.
//
// `months` are NORTHERN-hemisphere calendar months (1-12); tipsFor() shifts
// them by six for a southern-hemisphere garden. `types` (optional) limits a
// tip to gardens that have at least one plant of one of those types — the
// same type keys as the plant wizard (tree, bush, flower, vegetable, herb,
// other). `task` is what "Add as task" creates: dueInDays counts from today.
(function(){
  "use strict";

  var TIPS = [
    // ---- winter ----
    {id:"plan-season", months:[1,2], emoji:"📝", theme:"winter",
      title:"Plan this year's garden",
      body:"Seed catalogs are out. Sketch what goes where, note what did well last year, and make a wishlist before the rush.",
      task:{title:"Plan this year's garden & seed wishlist", description:"Sketch beds/pots, list what worked last year, and make a seed and plant wishlist.", dueInDays:7}},
    {id:"tool-care", months:[1,2], emoji:"🧰", theme:"winter",
      title:"Sharpen & clean your tools",
      body:"A quiet month is the best time to sharpen pruners, oil hinges and clean pots so everything's ready when spring starts.",
      task:{title:"Clean, sharpen and oil garden tools", description:"Sharpen pruners and shears, oil moving parts, scrub and disinfect pots.", dueInDays:7}},
    {id:"dormant-prune", months:[1,2], emoji:"✂️", theme:"winter", types:["tree","bush"],
      title:"Prune while it's dormant",
      body:"Fruit trees and shrubs are easiest to shape while leafless — remove dead, crossing and inward-growing branches.",
      task:{title:"Dormant-season pruning of trees & shrubs", description:"Remove dead, crossing and inward-growing branches while plants are leafless.", dueInDays:5}},
    {id:"winter-birds", months:[12,1,2], emoji:"🐦", theme:"winter",
      title:"Feed the garden birds",
      body:"Birds that visit in winter stay to eat your aphids and caterpillars in spring. A feeder and some water go a long way.",
      task:{title:"Put out a bird feeder and fresh water", description:"Birds that winter in the garden help with pest control in spring.", dueInDays:3}},

    // ---- late winter / spring ----
    {id:"start-seeds-indoors", months:[2,3], emoji:"🌱", theme:"spring", types:["vegetable","herb"],
      title:"Start seeds indoors",
      body:"Tomatoes, peppers and many herbs like a 6–8 week head start on a sunny windowsill before they go outside.",
      task:{title:"Sow tomato, pepper & herb seeds indoors", description:"Start seeds in trays on a bright windowsill, 6–8 weeks before your last frost.", dueInDays:5}},
    {id:"prune-roses", months:[2,3], emoji:"🌹", theme:"spring", types:["flower","bush"],
      title:"Time to prune the roses",
      body:"Just as buds begin to swell, cut roses back by about a third to an outward-facing bud for a strong spring flush.",
      task:{title:"Prune roses back by a third", description:"Cut to an outward-facing bud, remove dead and weak stems.", dueInDays:5}},
    {id:"spring-seeds", months:[3,4], emoji:"🌼", theme:"spring",
      title:"Get your garden ready for spring",
      body:"It's time to buy flower seeds and sow them! Hardy annuals like cornflowers, sweet peas and calendula can go straight in the ground now.",
      task:{title:"Buy flower seeds and sow them", description:"Pick up hardy annual seeds (cornflower, calendula, sweet pea, nigella) and sow them into prepared beds or pots.", dueInDays:4}},
    {id:"feed-soil", months:[3,4], emoji:"🪱", theme:"spring",
      title:"Feed the soil",
      body:"Spread a few centimetres of compost over beds before things take off. Healthy soil means fewer problems all year.",
      task:{title:"Spread compost over beds", description:"Top-dress beds and pots with 3–5 cm of compost or well-rotted manure.", dueInDays:7}},
    {id:"divide-perennials-spring", months:[3,4], emoji:"🪴", theme:"spring", types:["flower"],
      title:"Divide crowded perennials",
      body:"Clumps that flowered poorly last year will perk up if you lift and split them now — free plants, too!",
      task:{title:"Lift and divide crowded perennials", description:"Split overgrown clumps into smaller sections and replant or share them.", dueInDays:7}},
    {id:"harden-off", months:[4,5], emoji:"🌤️", theme:"spring", types:["vegetable","herb"],
      title:"Harden off your seedlings",
      body:"Give indoor-raised seedlings a week of a few hours outside each day before planting them out, so they don't sulk.",
      task:{title:"Harden off seedlings for a week", description:"Put seedlings outside for a few more hours each day over 7–10 days.", dueInDays:2}},
    {id:"plant-herbs", months:[4,5], emoji:"🌿", theme:"spring",
      title:"Plant a herb pot",
      body:"Basil, parsley, thyme and mint are happy in a sunny pot by the kitchen door — snip-as-you-cook gardening.",
      task:{title:"Plant a pot of kitchen herbs", description:"Basil, parsley, thyme, chives — a big pot in the sun near the kitchen.", dueInDays:5}},
    {id:"mulch", months:[4,5], emoji:"🍂", theme:"spring",
      title:"Mulch before the heat",
      body:"A layer of mulch now locks in spring moisture, keeps roots cool and saves you weeding all summer.",
      task:{title:"Mulch beds and around trees", description:"5–7 cm of bark, straw or leaf mould — keep it a hand's width from stems and trunks.", dueInDays:5}},

    // ---- summer ----
    {id:"plant-out", months:[5,6], emoji:"🍅", theme:"summer", types:["vegetable"],
      title:"Plant out the tender crops",
      body:"Once nights stay warm, tomatoes, peppers, squash and beans can go into their final spots.",
      task:{title:"Plant out tomatoes, peppers & squash", description:"Plant tender crops out once nights are reliably warm; water in well.", dueInDays:3}},
    {id:"stake", months:[5,6], emoji:"🎋", theme:"summer", types:["vegetable","flower"],
      title:"Stake before they flop",
      body:"Put supports in for tall flowers and tomatoes now — it's much harder once they've already fallen over.",
      task:{title:"Stake tall flowers and tomatoes", description:"Add canes, cages or twine supports before plants get top-heavy.", dueInDays:3}},
    {id:"water-smart", months:[6,7,8], emoji:"💧", theme:"summer",
      title:"Water deeply, less often",
      body:"A long soak early in the morning beats a daily sprinkle — roots grow deeper and plants handle heat better.",
      task:{title:"Check irrigation and switch to deep morning watering", description:"Test drippers/sprinklers for leaks and clogs; water early, deeply and less often.", dueInDays:2}},
    {id:"deadhead", months:[6,7,8], emoji:"🌸", theme:"summer", types:["flower","bush"],
      title:"Deadhead for more flowers",
      body:"Snipping off faded blooms tells plants to keep flowering instead of setting seed.",
      task:{title:"Deadhead faded flowers", description:"Snip spent blooms back to the next leaf or bud.", dueInDays:2}},
    {id:"pinch-herbs", months:[6,7,8], emoji:"🌿", theme:"summer", types:["herb"],
      title:"Pinch your herbs",
      body:"Regularly pinching tips (and flowers) keeps basil and friends bushy and full of flavour.",
      task:{title:"Pinch back and harvest herbs", description:"Pinch growing tips and remove flower buds to keep herbs leafy.", dueInDays:2}},
    {id:"summer-prune", months:[7,8], emoji:"✂️", theme:"summer", types:["tree"],
      title:"Summer-prune fruit trees",
      body:"Trimming this year's long shoots in summer keeps trees compact and lets sun reach the ripening fruit.",
      task:{title:"Summer-prune fruit trees", description:"Shorten this season's long whippy shoots to a few leaves.", dueInDays:5}},
    {id:"holiday-watering", months:[7,8], emoji:"🧳", theme:"summer",
      title:"Going away? Plan the watering",
      body:"Group pots in the shade, set up a timer or ask a neighbour — and water everything deeply the day you leave.",
      task:{title:"Arrange holiday watering", description:"Group pots in shade, set an irrigation timer or line up a neighbour.", dueInDays:4}},

    // ---- autumn ----
    {id:"order-bulbs", months:[8,9], emoji:"🛒", theme:"autumn",
      title:"It's time to buy bulbs!",
      body:"Spring-flowering bulbs — tulips, daffodils, crocus, alliums — are in the shops now, and the best varieties sell out early.",
      task:{title:"Buy spring-flowering bulbs", description:"Tulips, daffodils, crocus, alliums, hyacinths — pick firm, heavy bulbs.", dueInDays:5}},
    {id:"save-seeds", months:[8,9], emoji:"🫘", theme:"autumn", types:["flower","vegetable","herb"],
      title:"Save your own seeds",
      body:"Let a few of your best flowers and beans dry on the plant, then collect the seed in paper envelopes for next year.",
      task:{title:"Collect and label seeds", description:"Dry seed heads, shake out seeds into labelled paper envelopes.", dueInDays:5}},
    {id:"plant-bulbs", months:[10,11], emoji:"🌷", theme:"autumn",
      title:"Plant your spring bulbs",
      body:"Plant bulbs about three times their own depth, pointy end up. Future-you will be very happy in spring.",
      task:{title:"Plant spring bulbs", description:"Plant ~3x the bulb's depth, pointy end up; water in.", dueInDays:5}},
    {id:"autumn-planting", months:[9,10,11], emoji:"🌳", theme:"autumn",
      title:"Autumn is planting season",
      body:"Warm soil and cool air are ideal for new trees, shrubs and perennials — they root in over winter and take off in spring.",
      task:{title:"Plant new trees, shrubs or perennials", description:"Autumn planting gives roots all winter to establish.", dueInDays:7}},
    {id:"garlic", months:[10,11], emoji:"🧄", theme:"autumn", types:["vegetable","herb"],
      title:"Plant garlic",
      body:"Garlic needs a cold spell to form proper bulbs — plant individual cloves now for a summer harvest.",
      task:{title:"Plant garlic cloves", description:"Plant cloves pointy end up, about 5 cm deep and 15 cm apart.", dueInDays:5}},
    {id:"leaf-mould", months:[10,11], emoji:"🍁", theme:"autumn",
      title:"Turn leaves into gold",
      body:"Don't bin fallen leaves — pile them in a bag or corner and in a year they become rich, free leaf mould.",
      task:{title:"Collect fallen leaves for leaf mould", description:"Bag damp leaves (poke a few holes) or pile them in a corner to rot down.", dueInDays:4}},
    {id:"bring-in-pots", months:[10,11], emoji:"🏠", theme:"autumn",
      title:"Bring tender pots in",
      body:"Before the first cold nights, move frost-tender potted plants somewhere sheltered and bright.",
      task:{title:"Move tender potted plants to shelter", description:"Bring frost-tender pots under cover or indoors before cold nights.", dueInDays:3}},
    {id:"frost-protect", months:[11,12], emoji:"🧣", theme:"winter",
      title:"Get ready for frost",
      body:"Keep fleece handy, mulch the roots of tender plants and drain hoses and outdoor taps before the first freeze.",
      task:{title:"Prepare frost protection", description:"Have fleece ready, mulch tender plants' roots, drain hoses and outdoor taps.", dueInDays:3}},
    {id:"year-review", months:[12], emoji:"📔", theme:"winter",
      title:"Look back on your garden year",
      body:"Jot down what thrived, what struggled and what you want to try next year — it makes spring planning so much easier.",
      task:{title:"Write a garden year review", description:"What thrived, what struggled, what to try next year.", dueInDays:7}}
  ];

  // Weather-driven tips, shown first when the forecast calls for them.
  function weatherTips(weather){
    var out = [];
    if (!weather) return out;
    var alert = (weather.alert || "").toLowerCase();
    var forecast = (weather.forecast || "").toLowerCase();
    var hi = parseInt((String(weather.tempLabel || "").match(/-?\d+/) || [])[0], 10); // "31° / 21°" -> 31
    if (/frost|freez/.test(alert)){
      out.push({id:"wx-frost", emoji:"❄️", theme:"winter", weather:true,
        title:"Frost on the way",
        body:"Cover tender plants with fleece tonight and move pots next to the house.",
        task:{title:"Cover tender plants before the frost", description:"Fleece over tender plants, pots against the house wall.", dueInDays:0}});
    }
    if (/heat/.test(alert) || hi >= 33){
      out.push({id:"wx-heat", emoji:"🥵", theme:"summer", weather:true,
        title:"Hot day ahead",
        body:"Water early in the morning, give pots a deep soak and shade anything newly planted.",
        task:{title:"Deep morning watering before the heat", description:"Water early, soak pots thoroughly, shade new plantings.", dueInDays:0}});
    }
    var rainPct = parseInt((forecast.match(/(\d+)% chance of rain/) || [])[1], 10);
    if (rainPct >= 60){
      out.push({id:"wx-rain", emoji:"🌧️", theme:"spring", weather:true,
        title:"Rain is coming",
        body:"Skip watering today — and it's a perfect moment to feed plants so the rain washes it in.",
        task:{title:"Feed plants before the rain", description:"Scatter slow-release fertilizer so the rain washes it in; skip watering.", dueInDays:0}});
    }
    if (/wind|gale|storm/.test(alert)){
      out.push({id:"wx-wind", emoji:"💨", theme:"autumn", weather:true,
        title:"Windy weather",
        body:"Check stakes and ties, and move tall pots somewhere sheltered.",
        task:{title:"Secure stakes and move tall pots", description:"Check ties and supports; shelter tall or top-heavy pots.", dueInDays:0}});
    }
    return out;
  }

  // Which hemisphere a garden is in: an explicit Settings choice wins, then
  // the saved GPS latitude, else northern.
  function hemisphereOf(settings){
    var loc = (settings && settings.location) || {};
    if (loc.hemisphere === "south" || loc.hemisphere === "north") return loc.hemisphere;
    if (typeof loc.lat === "number") return loc.lat < 0 ? "south" : "north";
    return "north";
  }

  // Tips for "now": weather tips, then this month's seasonal tips (in
  // library order) whose plant-type condition matches the garden — tips
  // with no condition always match.
  function tipsFor(opts){
    var date = opts.date || new Date();
    var month = date.getMonth() + 1;
    if (hemisphereOf(opts.settings) === "south") month = ((month + 5) % 12) + 1;
    var types = {};
    (opts.plants || []).forEach(function(p){ types[p.type || "other"] = true; });
    var seasonal = TIPS.filter(function(t){
      if (t.months.indexOf(month) === -1) return false;
      if (t.types && !t.types.some(function(ty){ return types[ty]; })) return false;
      return true;
    });
    return weatherTips(opts.weather).concat(seasonal);
  }

  window.GardenTips = { tipsFor: tipsFor, hemisphereOf: hemisphereOf, all: TIPS };
})();
