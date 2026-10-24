(function () {
  "use strict";

  var pricing = {
    wood: { low: 5, high: 8, label: "Wood Privacy Fence" },
    cedar: { low: 9, high: 13, label: "Cedar Fence" },
    vinyl: { low: 7, high: 11, label: "Vinyl Fence" },
    chainlink: { low: 3, high: 5, label: "Chain Link Fence" },
    ornamental: { low: 13, high: 21, label: "Ornamental Iron Fence" },
    ranch: { low: 4, high: 8, label: "Ranch Fence" },
    custom: { low: 12, high: 24, label: "Custom Fence" }
  };

  var heightMultipliers = {
    "4": 0.9,
    "6": 1,
    "8": 1.22
  };

  var gatePricing = {
    low: 75,
    high: 200
  };

  var removalPricing = {
    low: 1,
    high: 3
  };

  var cityMultipliers = {
    sacramento: 1,
    "elk-grove": 1,
    folsom: 1.04,
    rocklin: 1.04,
    roseville: 1.04,
    "granite-bay": 1.04,
    "grass-valley": 1.08,
    other: 1.05
  };

  function money(value) {
    return "$" + (Math.round(value / 100) * 100).toLocaleString();
  }

  function gateCount(value) {
    return value === "3" ? 3 : Math.max(0, parseInt(value || "0", 10) || 0);
  }

  function calculateEstimate(input) {
    var table = pricing[input.fenceType] || pricing.wood;
    var footage = Math.max(0, parseFloat(input.footage || "0") || 0);
    var gates = gateCount(input.gates);
    var heightMultiplier = heightMultipliers[input.height] || 1;
    var cityMultiplier = cityMultipliers[input.city] || cityMultipliers.other;
    var low = footage * table.low * heightMultiplier * cityMultiplier;
    var high = footage * table.high * heightMultiplier * cityMultiplier;

    if (input.removal === "yes") {
      low += footage * removalPricing.low;
      high += footage * removalPricing.high;
    }

    low += gates * gatePricing.low;
    high += gates * gatePricing.high;

    return {
      low: Math.max(0, Math.round(low)),
      high: Math.max(0, Math.round(high)),
      label: table.label
    };
  }

  window.TwinRiversFencePricing = {
    pricing: pricing,
    heightMultipliers: heightMultipliers,
    gatePricing: gatePricing,
    removalPricing: removalPricing,
    cityMultipliers: cityMultipliers,
    calculateEstimate: calculateEstimate,
    formatMoney: money
  };
}());
