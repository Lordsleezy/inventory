(function () {
  "use strict";

  function closeAllDropdowns(except) {
    document.querySelectorAll(".nav-dropdown").forEach(function (dropdown) {
      if (dropdown === except) return;
      dropdown.classList.remove("is-open");
      var trigger = dropdown.querySelector(".nav-dropdown-trigger");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var toggle = document.querySelector("[data-nav-toggle]");
    var nav = document.getElementById("site-nav");
    if (toggle && nav) {
      toggle.addEventListener("click", function () {
        var open = nav.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        if (!open) closeAllDropdowns();
      });
    }

    document.querySelectorAll(".nav-dropdown").forEach(function (dropdown) {
      var trigger = dropdown.querySelector(".nav-dropdown-trigger");
      if (!trigger) return;

      var closeTimer;
      dropdown.addEventListener("mouseenter", function () {
        if (!window.matchMedia("(min-width: 781px)").matches) return;
        clearTimeout(closeTimer);
        dropdown.classList.add("is-open");
        trigger.setAttribute("aria-expanded", "true");
      });
      dropdown.addEventListener("mouseleave", function () {
        if (!window.matchMedia("(min-width: 781px)").matches) return;
        closeTimer = setTimeout(function () {
          dropdown.classList.remove("is-open");
          trigger.setAttribute("aria-expanded", "false");
        }, 200);
      });

      trigger.addEventListener("click", function (event) {
        if (window.matchMedia("(min-width: 781px)").matches) return;
        event.preventDefault();
        var willOpen = !dropdown.classList.contains("is-open");
        closeAllDropdowns(dropdown);
        dropdown.classList.toggle("is-open", willOpen);
        trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
      });
    });

    document.addEventListener("click", function (event) {
      if (!event.target.closest(".nav-dropdown")) closeAllDropdowns();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeAllDropdowns();
    });
  });
})();
