(function () {
  "use strict";

  var DISCLAIMER =
    "Educational estimate only. Roseville-area quotes vary with access, clay soil footings, HOA material requirements, gates, and finish grade. Contact a licensed installer for a site-specific price.";

  var MATERIAL_RATES = {
    wood: { min: 25, max: 55, label: "Wood (cedar/redwood)" },
    vinyl: { min: 35, max: 70, label: "Vinyl" },
    chain: { min: 15, max: 35, label: "Chain link" },
    iron: { min: 45, max: 90, label: "Ornamental iron" },
  };

  var TERRAIN_FACTORS = {
    flat: { factor: 1, label: "Flat / standard suburban lot" },
    clay: { factor: 1.1, label: "Expansive clay soil footing" },
    tight: { factor: 1.2, label: "Tight side yard / limited access" },
    rocky: { factor: 1.3, label: "Hardpan or hand-dig conditions" },
  };

  var GATE_COST = { min: 450, max: 950 };

  var BAG_YIELD_CU_FT = 0.45;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "className") node.className = attrs[key];
        else if (key === "text") node.textContent = attrs.text;
        else if (key === "html") node.innerHTML = attrs.html;
        else if (attrs[key] == null) return;
        else node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function field(id, labelText, inputNode, hint) {
    var wrap = el("div", { className: "calc-field" });
    var label = el("label", { for: id, text: labelText });
    wrap.appendChild(label);
    wrap.appendChild(inputNode);
    if (hint) wrap.appendChild(el("p", { className: "calc-hint", text: hint }));
    return wrap;
  }

  function numberInput(id, value, min, step) {
    var input = el("input", {
      type: "number",
      id: id,
      name: id,
      value: String(value),
      min: String(min != null ? min : 0),
      step: step != null ? String(step) : "1",
    });
    input.className = "calc-input";
    return input;
  }

  function selectInput(id, options, selected) {
    var select = el("select", { id: id, name: id });
    select.className = "calc-input";
    options.forEach(function (opt) {
      var option = el("option", { value: opt.value, text: opt.label });
      if (opt.value === selected) option.selected = true;
      select.appendChild(option);
    });
    return select;
  }

  function resultsPanel() {
    var panel = el("div", {
      className: "calc-results",
      role: "region",
      "aria-live": "polite",
      "aria-label": "Calculator results",
    });
    panel.hidden = true;
    return panel;
  }

  function disclaimerNode() {
    return el("p", { className: "calc-disclaimer", text: DISCLAIMER });
  }

  function showResults(panel, title, rows, notes) {
    panel.innerHTML = "";
    panel.appendChild(el("h3", { className: "calc-results-title", text: title }));
    var list = el("dl", { className: "calc-results-list" });
    rows.forEach(function (row) {
      list.appendChild(el("dt", { text: row.label }));
      list.appendChild(el("dd", { text: row.value }));
    });
    panel.appendChild(list);
    if (notes && notes.length) {
      var noteWrap = el("div", { className: "calc-notes" });
      notes.forEach(function (note) {
        noteWrap.appendChild(el("p", { text: note }));
      });
      panel.appendChild(noteWrap);
    }
    panel.appendChild(disclaimerNode());
    panel.hidden = false;
  }

  function readNumber(input, fallback) {
    var value = parseFloat(input.value);
    return isFinite(value) && value >= 0 ? value : fallback;
  }

  function formatMoney(amount) {
    return "$" + Math.round(amount).toLocaleString("en-US");
  }

  function formatRange(min, max) {
    return formatMoney(min) + " – " + formatMoney(max);
  }

  function initCostCalculator(root) {
    var form = el("form", { className: "calc-form", "data-calc-form": "cost" });
    var feet = numberInput("cost-feet", 180, 1, 1);
    var material = selectInput(
      "cost-material",
      Object.keys(MATERIAL_RATES).map(function (key) {
        return { value: key, label: MATERIAL_RATES[key].label };
      }),
      "wood"
    );
    var gates = numberInput("cost-gates", 1, 0, 1);
    var terrain = selectInput(
      "cost-terrain",
      Object.keys(TERRAIN_FACTORS).map(function (key) {
        return { value: key, label: TERRAIN_FACTORS[key].label };
      }),
      "flat"
    );
    var panel = resultsPanel();

    form.appendChild(field("cost-feet", "Fence length (linear feet)", feet, "Typical Roseville backyard runs are 150–250 ft."));
    form.appendChild(field("cost-material", "Fence material", material));
    form.appendChild(field("cost-gates", "Number of gates", gates, "Walk gates and drive gates add hardware and post cost."));
    form.appendChild(field("cost-terrain", "Site terrain", terrain));
    form.appendChild(el("button", { type: "submit", className: "calc-submit", text: "Estimate cost" }));

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var lengthFt = readNumber(feet, 0);
      var gateCount = readNumber(gates, 0);
      var rates = MATERIAL_RATES[material.value] || MATERIAL_RATES.wood;
      var terrainData = TERRAIN_FACTORS[terrain.value] || TERRAIN_FACTORS.flat;
      if (lengthFt <= 0) {
        showResults(panel, "Enter a valid fence length", [{ label: "Status", value: "Add linear feet greater than zero." }], []);
        return;
      }
      var gateMin = gateCount * GATE_COST.min;
      var gateMax = gateCount * GATE_COST.max;
      var low = lengthFt * rates.min * terrainData.factor + gateMin;
      var high = lengthFt * rates.max * terrainData.factor + gateMax;
      var mid = (low + high) / 2;
      showResults(
        panel,
        "Estimated installed cost range",
        [
          { label: "Material", value: rates.label + " at " + formatMoney(rates.min) + "–" + formatMoney(rates.max) + "/ft (est.)" },
          { label: "Terrain factor", value: terrainData.label + " (×" + terrainData.factor.toFixed(2) + ")" },
          { label: "Fence subtotal", value: formatRange(lengthFt * rates.min * terrainData.factor, lengthFt * rates.max * terrainData.factor) },
          { label: "Gate allowance", value: gateCount ? formatRange(gateMin, gateMax) : "$0" },
          { label: "Total estimate", value: formatRange(low, high) },
          { label: "Midpoint", value: formatMoney(mid) },
        ],
        [
          "Sacramento-area ballpark installed ranges only—quotes vary with access, HOA material choice, and finish.",
          "Removal of existing fence, permits, and staining upgrades are not included.",
        ]
      );
    });

    root.appendChild(form);
    root.appendChild(panel);
  }

  function initMaterialCalculator(root) {
    var form = el("form", { className: "calc-form", "data-calc-form": "material" });
    var feet = numberInput("material-feet", 150, 1, 1);
    var spacing = selectInput(
      "material-spacing",
      [
        { value: "8", label: "8 feet (standard privacy)" },
        { value: "6", label: "6 feet (heavier panels / gate runs)" },
      ],
      "8"
    );
    var type = selectInput(
      "material-type",
      [
        { value: "wood", label: "Wood privacy" },
        { value: "vinyl", label: "Vinyl panels" },
        { value: "chain", label: "Chain link" },
      ],
      "wood"
    );
    var panel = resultsPanel();

    form.appendChild(field("material-feet", "Fence length (linear feet)", feet));
    form.appendChild(field("material-spacing", "Post spacing", spacing));
    form.appendChild(field("material-type", "Fence type", type));
    form.appendChild(el("button", { type: "submit", className: "calc-submit", text: "Estimate materials" }));

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var lengthFt = readNumber(feet, 0);
      var spacingFt = parseFloat(spacing.value) || 8;
      if (lengthFt <= 0) {
        showResults(panel, "Enter a valid fence length", [{ label: "Status", value: "Add linear feet greater than zero." }], []);
        return;
      }
      var posts = Math.floor(lengthFt / spacingFt) + 1;
      var sections = Math.ceil(lengthFt / spacingFt);
      var rows = [
        { label: "Line posts", value: String(posts) },
        { label: "Sections (~" + spacingFt + " ft)", value: String(sections) },
      ];
      var notes = [];

      if (type.value === "wood") {
        var rails = sections * 2;
        var picketsPerSection = spacingFt === 6 ? 13 : 17;
        var pickets = sections * picketsPerSection;
        rows.push({ label: "Horizontal rails (2 per section)", value: String(rails) });
        rows.push({ label: "Pickets (est.)", value: String(pickets) });
        notes.push("Picket count assumes standard 3.5-inch boards on a 6-foot privacy layout.");
      } else if (type.value === "vinyl") {
        rows.push({ label: "Prefabricated panels", value: String(sections) });
        rows.push({ label: "Top rails (included in panels)", value: "Included with panel system" });
        notes.push("Round up to your manufacturer’s panel length—many vinyl systems use 8-foot sections.");
      } else {
        var topRail = Math.ceil(lengthFt / 10);
        rows.push({ label: "Line posts", value: String(posts) });
        rows.push({ label: "Top rail sticks (~10 ft)", value: String(topRail) });
        rows.push({ label: "Chain link fabric (ft)", value: String(Math.ceil(lengthFt)) });
        rows.push({ label: "Tension bands / caps (est.)", value: String(posts * 2) });
        notes.push("Terminal, corner, and gate posts may require additional fittings.");
      }

      showResults(panel, "Material estimate", rows, notes);
    });

    root.appendChild(form);
    root.appendChild(panel);
  }

  function initConcreteCalculator(root) {
    var form = el("form", { className: "calc-form", "data-calc-form": "concrete" });
    var posts = numberInput("concrete-posts", 20, 1, 1);
    var diameter = numberInput("concrete-diameter", 10, 6, 1);
    var depth = numberInput("concrete-depth", 24, 12, 1);
    var panel = resultsPanel();

    form.appendChild(field("concrete-posts", "Number of posts", posts));
    form.appendChild(field("concrete-diameter", "Hole diameter (inches)", diameter, "10 inches is a common residential hole size."));
    form.appendChild(field("concrete-depth", "Hole depth (inches)", depth, "24–36 inches is typical for Roseville's clay soil."));
    form.appendChild(el("button", { type: "submit", className: "calc-submit", text: "Calculate concrete" }));

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var postCount = readNumber(posts, 0);
      var diaIn = readNumber(diameter, 10);
      var depthIn = readNumber(depth, 24);
      if (postCount <= 0) {
        showResults(panel, "Enter a valid post count", [{ label: "Status", value: "Add at least one post." }], []);
        return;
      }
      var radiusFt = diaIn / 2 / 12;
      var depthFt = depthIn / 12;
      var volumePerHole = Math.PI * radiusFt * radiusFt * depthFt;
      var totalVolume = volumePerHole * postCount;
      var bags = Math.ceil(totalVolume / BAG_YIELD_CU_FT);
      showResults(
        panel,
        "Concrete estimate",
        [
          { label: "Volume per hole", value: volumePerHole.toFixed(2) + " cu ft" },
          { label: "Total volume", value: totalVolume.toFixed(2) + " cu ft" },
          { label: "60 lb bags (est.)", value: String(bags) },
          { label: "Formula", value: "π × r² × depth × post count" },
        ],
        [
          "Assumes 0.45 cu ft yield per 60-pound bag—verify on your mix label.",
          "Expansive clay soil common in Roseville may need wider holes or extra bags.",
        ]
      );
    });

    root.appendChild(form);
    root.appendChild(panel);
  }

  function initPostCalculator(root) {
    var form = el("form", { className: "calc-form", "data-calc-form": "post" });
    var feet = numberInput("post-feet", 150, 1, 1);
    var spacing = selectInput(
      "post-spacing",
      [
        { value: "8", label: "8 feet" },
        { value: "6", label: "6 feet" },
        { value: "10", label: "10 feet (chain link)" },
      ],
      "8"
    );
    var corners = numberInput("post-corners", 4, 0, 1);
    var ends = numberInput("post-ends", 0, 0, 1);
    var panel = resultsPanel();

    form.appendChild(field("post-feet", "Fence length (linear feet)", feet));
    form.appendChild(field("post-spacing", "Post spacing", spacing));
    form.appendChild(field("post-corners", "Extra corner / brace posts", corners, "Add only posts beyond a simple straight run."));
    form.appendChild(field("post-ends", "Extra end / gate posts", ends));
    form.appendChild(el("button", { type: "submit", className: "calc-submit", text: "Count posts" }));

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var lengthFt = readNumber(feet, 0);
      var spacingFt = parseFloat(spacing.value) || 8;
      var cornerExtra = readNumber(corners, 0);
      var endExtra = readNumber(ends, 0);
      if (lengthFt <= 0) {
        showResults(panel, "Enter a valid fence length", [{ label: "Status", value: "Add linear feet greater than zero." }], []);
        return;
      }
      var basePosts = Math.floor(lengthFt / spacingFt) + 1;
      var totalPosts = basePosts + cornerExtra + endExtra;
      showResults(
        panel,
        "Post count estimate",
        [
          { label: "Spacing", value: spacingFt + " feet on center" },
          { label: "Base posts (length ÷ spacing + 1)", value: String(basePosts) },
          { label: "Corner / brace extras", value: String(cornerExtra) },
          { label: "End / gate extras", value: String(endExtra) },
          { label: "Total posts", value: String(totalPosts) },
        ],
        ["Gate posts typically need heavier stock and deeper footings to resist clay soil movement."]
      );
    });

    root.appendChild(form);
    root.appendChild(panel);
  }

  var HEIGHT_GUIDE = {
    privacy: {
      title: "Privacy / backyard",
      min: 6,
      max: 8,
      recommend: "6 ft solid or board-on-board",
      notes: [
        "Six feet is the most common rear-yard height in Roseville's master-planned neighborhoods.",
        "Taller 7–8 ft options may trigger HOA architectural review or neighbor sight-line concerns.",
      ],
    },
    pool: {
      title: "Pool barrier",
      min: 4,
      max: 5,
      recommend: "48–60 in climb-resistant mesh or iron",
      notes: [
        "California pool barrier rules often require minimum 60-inch height and self-closing, self-latching gates.",
        "Informational only—verify current code and City of Roseville enforcement before building.",
      ],
    },
    dog: {
      title: "Dog containment",
      min: 4,
      max: 6,
      recommend: "5–6 ft solid or extended chain link",
      notes: [
        "Medium and large dogs usually need 5–6 feet; dig barriers help on determined climbers.",
        "Side-yard gates near dog runs benefit from added stiffness so daily use doesn't sag the panel.",
      ],
    },
    decorative: {
      title: "Front yard / decorative",
      min: 3,
      max: 4,
      recommend: "3–4 ft picket or low rail",
      notes: [
        "Front-yard heights in most Roseville communities are lower than rear fences and often HOA-restricted.",
        "Corner visibility and sidewalk setback rules may apply—confirm with planning.",
      ],
    },
    hoa: {
      title: "HOA-restricted",
      min: 5,
      max: 6,
      recommend: "6 ft in an HOA-approved material and color",
      notes: [
        "Many Roseville HOAs cap height below the city maximum and specify approved materials, colors, or styles.",
        "Submit an architectural request before ordering material—approval timelines vary by community.",
      ],
    },
  };

  function initHeightCalculator(root) {
    var form = el("form", { className: "calc-form", "data-calc-form": "height" });
    var useCase = selectInput(
      "height-use",
      Object.keys(HEIGHT_GUIDE).map(function (key) {
        return { value: key, label: HEIGHT_GUIDE[key].title };
      }),
      "privacy"
    );
    var panel = resultsPanel();

    form.appendChild(field("height-use", "Primary use case", useCase));
    form.appendChild(el("button", { type: "submit", className: "calc-submit", text: "Show height guidance" }));

    function renderGuide() {
      var guide = HEIGHT_GUIDE[useCase.value] || HEIGHT_GUIDE.privacy;
      showResults(
        panel,
        guide.title + " — height guidance",
        [
          { label: "Typical range", value: guide.min + "–" + guide.max + " feet" },
          { label: "Common choice locally", value: guide.recommend },
          { label: "Legal advice?", value: "No — confirm permits and codes locally" },
        ],
        guide.notes.concat([
          "HOA rules vary by community—check your CC&Rs before finalizing height or material.",
        ])
      );
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      renderGuide();
    });

    root.appendChild(form);
    root.appendChild(panel);
    renderGuide();
  }

  function initPerimeterCalculator(root) {
    var form = el("form", { className: "calc-form", "data-calc-form": "perimeter" });
    var mode = selectInput(
      "perimeter-mode",
      [
        { value: "rect", label: "Rectangular lot (length × width)" },
        { value: "segments", label: "Irregular / multi-segment" },
      ],
      "rect"
    );
    var rectWrap = el("div", { className: "calc-mode calc-mode-rect" });
    var length = numberInput("perimeter-length", 100, 1, 1);
    var width = numberInput("perimeter-width", 75, 1, 1);
    rectWrap.appendChild(field("perimeter-length", "Lot length (feet)", length));
    rectWrap.appendChild(field("perimeter-width", "Lot width (feet)", width));

    var segWrap = el("div", { className: "calc-mode calc-mode-segments", hidden: "hidden" });
    var segmentList = el("div", { className: "calc-segment-list" });
    var addBtn = el("button", { type: "button", className: "calc-add-segment", text: "Add segment" });

    function addSegment(value) {
      var row = el("div", { className: "calc-segment-row" });
      var input = numberInput("segment-" + segmentList.children.length, value != null ? value : 50, 1, 1);
      input.classList.add("calc-segment-input");
      row.appendChild(field(input.id, "Segment length (feet)", input));
      var remove = el("button", { type: "button", className: "calc-remove-segment", text: "Remove" });
      remove.addEventListener("click", function () {
        row.remove();
      });
      row.appendChild(remove);
      segmentList.appendChild(row);
    }

    addBtn.addEventListener("click", function () {
      addSegment(50);
    });
    addSegment(80);
    addSegment(60);
    segWrap.appendChild(segmentList);
    segWrap.appendChild(addBtn);

    mode.addEventListener("change", function () {
      var isRect = mode.value === "rect";
      rectWrap.hidden = !isRect;
      segWrap.hidden = isRect;
    });

    var panel = resultsPanel();
    form.appendChild(field("perimeter-mode", "Property shape", mode));
    form.appendChild(rectWrap);
    form.appendChild(segWrap);
    form.appendChild(el("button", { type: "submit", className: "calc-submit", text: "Calculate perimeter" }));

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var total = 0;
      var notes = [];
      if (mode.value === "rect") {
        var len = readNumber(length, 0);
        var wid = readNumber(width, 0);
        if (len <= 0 || wid <= 0) {
          showResults(panel, "Enter valid dimensions", [{ label: "Status", value: "Length and width must be greater than zero." }], []);
          return;
        }
        total = 2 * (len + wid);
        showResults(
          panel,
          "Rectangular perimeter",
          [
            { label: "Length", value: len + " ft" },
            { label: "Width", value: wid + " ft" },
            { label: "Formula", value: "2 × (length + width)" },
            { label: "Total perimeter", value: total + " linear ft" },
          ],
          ["Deduct shared fences or structures you do not plan to replace.", "Field-measure before ordering—as-built lot lines can differ slightly from plat dimensions."]
        );
        return;
      }

      var inputs = segmentList.querySelectorAll(".calc-segment-input");
      if (!inputs.length) {
        showResults(panel, "Add at least one segment", [{ label: "Status", value: "Enter segment lengths for each fence run." }], []);
        return;
      }
      inputs.forEach(function (input, index) {
        var seg = readNumber(input, 0);
        total += seg;
        notes.push("Segment " + (index + 1) + ": " + seg + " ft");
      });
      showResults(
        panel,
        "Segment total",
        [
          { label: "Segments counted", value: String(inputs.length) },
          { label: "Total linear feet", value: total + " ft" },
        ],
        notes.concat(["Sum does not auto-close the polygon—add a closing segment if needed."])
      );
    });

    root.appendChild(form);
    root.appendChild(panel);
  }

  var MAINTENANCE_SCHEDULES = {
    wood: {
      label: "Wood (cedar / redwood)",
      seasons: {
        Spring: [
          "Inspect for winter moisture damage, rot at post bases, and loose pickets.",
          "Pressure-wash pollen and dust buildup; let dry before stain or seal.",
          "Re-stain or seal every 2–4 years on south- or west-facing sun exposures.",
        ],
        Summer: [
          "Check sprinkler overspray hitting lower pickets—a common cause of premature rot in Roseville yards.",
          "Tighten gate hinges and latches; intense summer heat can dry and shrink boards.",
          "Trim vegetation away from boards to reduce trapped moisture.",
        ],
        Fall: [
          "Clear leaf buildup along rails before the rainy season starts.",
          "Confirm posts are not buried by mulch or soil after landscaping work.",
          "Pre-treat gray or bare wood before winter rains arrive.",
        ],
        Winter: [
          "After storms, check for leaning posts—expansive clay soil can shift footings as it saturates.",
          "Re-tighten hardware once soil dries and settles.",
          "Schedule repairs before the next round of rain softens clay footings further.",
        ],
      },
    },
    vinyl: {
      label: "Vinyl",
      seasons: {
        Spring: [
          "Rinse pollen and dust with mild soap after the wet season.",
          "Inspect bottom rails for soil or debris buildup trapping moisture.",
          "Check post caps and joints for any winter movement.",
        ],
        Summer: [
          "Rinse dust and hard-water sprinkler spotting before it bakes on in the heat.",
          "Verify gates swing freely as temperature expansion changes fit.",
          "Keep weed trimmers away from posts and panels to avoid nicks.",
        ],
        Fall: [
          "Clear debris from bottom rails before winter rains.",
          "Tighten hardware and check post plumb after a full season of clay soil movement.",
        ],
        Winter: [
          "Check posts for lean after heavy rain saturates clay soil.",
          "Check latches after cold snaps; adjust gate posts if needed.",
        ],
      },
    },
    chain: {
      label: "Chain link",
      seasons: {
        Spring: [
          "Walk the line for rust at welds, tension wire fatigue, and bent top rail.",
          "Re-tension fabric after any winter soil movement pulls posts out of plumb.",
          "Grease gate rollers and hinges.",
        ],
        Summer: [
          "Trim vines and vegetation before they pull fabric off the line.",
          "Inspect tension bands and brace bands on corner posts.",
        ],
        Fall: [
          "Touch up rust spots before the rainy season.",
          "Clear debris from the bottom of fabric where pests can burrow.",
        ],
        Winter: [
          "Check brace posts and gate frames after storms and heavy rain.",
          "Confirm gates still latch cleanly after ground movement.",
        ],
      },
    },
    iron: {
      label: "Ornamental / wrought iron",
      seasons: {
        Spring: [
          "Inspect welds, pickets, and powder coat chips after the wet winter.",
          "Wire-brush rust spots; prime and touch up before summer heat sets in.",
        ],
        Summer: [
          "Check gate operators and self-closing hardware on pool or entry gates.",
          "Lubricate hinges; verify latch alignment after any soil movement.",
        ],
        Fall: [
          "Apply rust inhibitor to chips before winter rain arrives.",
          "Tighten anchor bolts at concrete footings.",
        ],
        Winter: [
          "After storms, check for footing movement from saturated clay soil.",
          "Keep drain paths clear so water does not pool at post bases.",
        ],
      },
    },
  };

  function initMaintenanceCalculator(root) {
    var form = el("form", { className: "calc-form", "data-calc-form": "maintenance" });
    var material = selectInput(
      "maintenance-material",
      Object.keys(MAINTENANCE_SCHEDULES).map(function (key) {
        return { value: key, label: MAINTENANCE_SCHEDULES[key].label };
      }),
      "wood"
    );
    var exposure = selectInput(
      "maintenance-exposure",
      [
        { value: "typical", label: "Typical suburban lot" },
        { value: "sun", label: "Full-sun / south-facing exposure" },
        { value: "sprinkler", label: "Near sprinkler heads or irrigation" },
      ],
      "typical"
    );
    var panel = resultsPanel();

    form.appendChild(field("maintenance-material", "Fence material", material));
    form.appendChild(field("maintenance-exposure", "Site exposure", exposure));
    form.appendChild(el("button", { type: "submit", className: "calc-submit", text: "Generate checklist" }));

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var schedule = MAINTENANCE_SCHEDULES[material.value] || MAINTENANCE_SCHEDULES.wood;
      panel.innerHTML = "";
      panel.appendChild(el("h3", { className: "calc-results-title", text: schedule.label + " maintenance checklist" }));
      Object.keys(schedule.seasons).forEach(function (season) {
        panel.appendChild(el("h4", { className: "calc-season", text: season }));
        var ul = el("ul", { className: "calc-checklist" });
        schedule.seasons[season].forEach(function (item) {
          ul.appendChild(el("li", { text: item }));
        });
        panel.appendChild(ul);
      });
      var climate = el("div", { className: "calc-notes" });
      climate.appendChild(
        el("p", {
          text:
            "Roseville climate notes: hot, dry summers, mild wet winters, and expansive clay soil increase wear—inspect posts and hardware at least twice yearly.",
        })
      );
      if (exposure.value === "sun") {
        climate.appendChild(el("p", { text: "Full-sun exposure: UV and heat accelerate wood fading and vinyl expansion—check fasteners and finish more often." }));
      }
      if (exposure.value === "sprinkler") {
        climate.appendChild(el("p", { text: "Sprinkler exposure: overspray is a leading cause of premature wood rot and hard-water spotting on vinyl—consider adjusting head direction." }));
      }
      panel.appendChild(climate);
      panel.appendChild(disclaimerNode());
      panel.hidden = false;
    });

    root.appendChild(form);
    root.appendChild(panel);
  }

  var INITIALIZERS = {
    cost: initCostCalculator,
    material: initMaterialCalculator,
    concrete: initConcreteCalculator,
    post: initPostCalculator,
    height: initHeightCalculator,
    perimeter: initPerimeterCalculator,
    maintenance: initMaintenanceCalculator,
  };

  function initCalculators() {
    var nodes = document.querySelectorAll("[data-calculator]");
    nodes.forEach(function (node) {
      var type = node.getAttribute("data-calculator");
      if (!type || node.getAttribute("data-calc-ready") === "true") return;
      var init = INITIALIZERS[type];
      if (!init) return;
      node.classList.add("calc-root");
      node.setAttribute("data-calc-ready", "true");
      init(node);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCalculators);
  } else {
    initCalculators();
  }
})();
