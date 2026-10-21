(function () {
  "use strict";

  function field(form, name) {
    return form.querySelector('[name="' + name + '"]');
  }

  function digits(value) {
    return (value || "").replace(/\D/g, "");
  }

  function leadId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "lead-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function readUtms() {
    var out = {};
    try {
      Object.assign(out, JSON.parse(sessionStorage.getItem("tr_utm") || "{}"));
    } catch (error) {}
    var params = new URLSearchParams(window.location.search);
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach(function (key) {
      var value = params.get(key);
      if (value) out[key] = value;
    });
    try {
      sessionStorage.setItem("tr_utm", JSON.stringify(out));
    } catch (error) {}
    return out;
  }

  function ensureHidden(form, name, value) {
    var el = field(form, name);
    if (!el) {
      el = document.createElement("input");
      el.type = "hidden";
      el.name = name;
      form.appendChild(el);
    }
    if (value != null) el.value = value;
    return el;
  }

  function initQuoteCalculator() {
    var calculator = document.querySelector("[data-quote-calculator]");
    var pricing = window.TwinRiversFencePricing;
    if (!calculator || !pricing) return;

    var inputForm = calculator.querySelector("[data-quote-inputs]");
    var leadForm = calculator.querySelector("[data-quote-lead-form]");
    var rangeEl = calculator.querySelector("[data-estimate-range]");
    var status = calculator.querySelector("[data-quote-status]");
    if (!inputForm || !leadForm || !rangeEl) return;

    function readInput() {
      return {
        fenceType: field(inputForm, "fence_type").value,
        height: field(inputForm, "height").value,
        footage: field(inputForm, "footage").value,
        gates: field(inputForm, "gates").value,
        removal: field(inputForm, "removal").value,
        city: field(inputForm, "city").value
      };
    }

    function updateHiddenFields(input, estimateText) {
      var values = {
        estimated_range: estimateText,
        fence_type: input.fenceType,
        height: input.height + " Foot",
        footage: input.footage,
        gates: input.gates === "3" ? "3+" : input.gates,
        removal: input.removal,
        city: input.city
      };
      Object.keys(values).forEach(function (name) {
        var el = field(leadForm, name);
        if (el) el.value = values[name];
      });
    }

    function updateEstimate() {
      var input = readInput();
      var estimate = pricing.calculateEstimate(input);
      var estimateText = pricing.formatMoney(estimate.low) + " - " + pricing.formatMoney(estimate.high);
      rangeEl.textContent = estimateText;
      updateHiddenFields(input, estimateText);
      return estimateText;
    }

    function resetTurnstile() {
      if (!window.turnstile) return;
      var widget = leadForm.querySelector(".cf-turnstile");
      if (!widget) return;
      try { window.turnstile.reset(widget); } catch (error) {}
    }

    function formProof(startedAt) {
      var s = String(startedAt || "");
      var n = 2166136261;
      for (var i = 0; i < s.length; i++) {
        n ^= s.charCodeAt(i);
        n = Math.imul(n, 16777619);
      }
      return (n >>> 0).toString(16);
    }

    function solvePow(startedAt) {
      var n = 0;
      var s = String(startedAt || "");
      while (n < 250000) {
        if (formProof(s + ":" + n).slice(0, 3) === "000") return String(n);
        n++;
      }
      return "";
    }

    function markJsCookie() {
      document.cookie = "tr_js=1; Path=/; SameSite=Lax; Max-Age=86400";
    }

    function bumpInt() {
      var n = Number(leadForm.dataset.int || 0) + 1;
      leadForm.dataset.int = String(n);
      ensureHidden(leadForm, "form_int", String(n));
      return n;
    }

    function stampFormStart() {
      markJsCookie();
      if (!leadForm.dataset.startedAt) leadForm.dataset.startedAt = new Date().toISOString();
      ensureHidden(leadForm, "form_started_at", leadForm.dataset.startedAt);
      ensureHidden(leadForm, "form_js", formProof(leadForm.dataset.startedAt));
      ensureHidden(leadForm, "form_pow", solvePow(leadForm.dataset.startedAt));
      if (!leadForm.dataset.int) ensureHidden(leadForm, "form_int", "0");
    }

    function payloadFromForms() {
      var input = readInput();
      var utm = readUtms();
      var estimateText = updateEstimate();
      var id = ensureHidden(leadForm, "lead_id").value || leadId();
      ensureHidden(leadForm, "lead_id", id);
      stampFormStart();
      var tokenField = leadForm.querySelector("[name='cf-turnstile-response']");
      return {
        lead_id: id,
        name: (field(leadForm, "name") && field(leadForm, "name").value) || "",
        email: (field(leadForm, "email") && field(leadForm, "email").value) || "",
        phone: (field(leadForm, "phone") && field(leadForm, "phone").value) || "",
        city: input.city,
        source_domain: window.location.hostname,
        source_page: window.location.pathname + window.location.hash,
        form_name: "instant-quote",
        lead_type: "fence-quote",
        message: (field(leadForm, "notes") && field(leadForm, "notes").value) || "",
        project_details: "",
        quote_details: [
          "Fence type: " + input.fenceType,
          "Height: " + input.height + " Foot",
          "Linear feet: " + input.footage,
          "Gates: " + (input.gates === "3" ? "3+" : input.gates),
          "Removal: " + input.removal,
          "Estimated range: " + estimateText
        ].join("\n"),
        fence_type: input.fenceType,
        height: input.height + " Foot",
        footage: input.footage,
        gates: input.gates === "3" ? "3+" : input.gates,
        removal: input.removal,
        estimated_range: estimateText,
        utm_source: utm.utm_source || "",
        utm_medium: utm.utm_medium || "",
        utm_campaign: utm.utm_campaign || "",
        utm_term: utm.utm_term || "",
        utm_content: utm.utm_content || "",
        referrer: document.referrer || "",
        form_started_at: leadForm.dataset.startedAt || "",
        form_js: formProof(leadForm.dataset.startedAt || ""),
        form_pow: (field(leadForm, "form_pow") && field(leadForm, "form_pow").value) || solvePow(leadForm.dataset.startedAt || ""),
        form_int: leadForm.dataset.int || "0",
        "cf-turnstile-response": (tokenField && tokenField.value) || "",
        "bot-field": (field(leadForm, "bot-field") && field(leadForm, "bot-field").value) || "",
        website: (field(leadForm, "website") && field(leadForm, "website").value) || ""
      };
    }

    inputForm.addEventListener("input", function () { bumpInt(); updateEstimate(); });
    inputForm.addEventListener("change", function () { bumpInt(); updateEstimate(); });
    leadForm.addEventListener("input", bumpInt);
    leadForm.addEventListener("change", bumpInt);

    stampFormStart();

    leadForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (leadForm.dataset.submitting === "true") return;
      var phone = field(leadForm, "phone");
      if (!phone || digits(phone.value).length < 10) {
        resetTurnstile();
        if (status) status.textContent = "Please enter a phone number so we can follow up with an exact quote.";
        if (phone) phone.focus();
        return;
      }

      bumpInt();
      var endpoint = leadForm.getAttribute("action") || "/";
      var isCity = /\/\.netlify\/functions\/contact-lead/.test(endpoint);
      var body = payloadFromForms();
      leadForm.dataset.submitting = "true";
      var button = leadForm.querySelector("button[type='submit']");
      if (button) button.disabled = true;
      if (status) status.textContent = "Sending your estimate request...";

      function succeed() {
        delete leadForm.dataset.submitting;
        delete leadForm.dataset.startedAt;
        delete leadForm.dataset.int;
        stampFormStart();
        resetTurnstile();
        if (button) button.disabled = false;
        if (status) status.textContent = "Thanks — your estimate request was sent. Twin Rivers Fence will follow up with an exact quote.";
        field(leadForm, "name") && (field(leadForm, "name").value = "");
        field(leadForm, "email") && (field(leadForm, "email").value = "");
        field(leadForm, "phone") && (field(leadForm, "phone").value = "");
        field(leadForm, "notes") && (field(leadForm, "notes").value = "");
        ensureHidden(leadForm, "lead_id", "");
      }

      function fail() {
        delete leadForm.dataset.submitting;
        resetTurnstile();
        if (button) button.disabled = false;
        if (status) status.textContent = "Something went wrong sending your request. Please call Twin Rivers Fence at (916) 906-2254.";
      }

      var headers = { "Content-Type": "application/json", Accept: "application/json", "X-Fence-Lead": "1" };
      var primary = isCity ? endpoint : "/.netlify/functions/lead-ingest";

      fetch(primary, { method: "POST", headers: headers, credentials: "same-origin", body: JSON.stringify(body) })
        .then(function (res) {
          if (!res.ok) throw new Error("primary failed");
          if (isCity) return res;
          return fetch("/", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Fence-Lead": "1" },
            body: new URLSearchParams(new FormData(leadForm)).toString()
          });
        })
        .then(succeed)
        .catch(fail);
    });

    updateEstimate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initQuoteCalculator);
  } else {
    initQuoteCalculator();
  }
}());
