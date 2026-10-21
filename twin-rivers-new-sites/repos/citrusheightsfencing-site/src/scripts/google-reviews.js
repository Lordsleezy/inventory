(function () {
  "use strict";

  var ENDPOINT = "/.netlify/functions/google-reviews";
  var VERIFIED_GOOGLE_MAPS_URL = "https://maps.app.goo.gl/rXBxsJXV2E6Z3Luu6";
  var FALLBACK_PROFILE = {
    ok: true,
    source: "verified-google-maps-link",
    name: "Twin Rivers Fence",
    rating: null,
    user_ratings_total: null,
    url: VERIFIED_GOOGLE_MAPS_URL,
    reviews: []
  };

  function qsAll(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  function setText(selector, value) {
    qsAll(selector).forEach(function (node) {
      node.textContent = value;
    });
  }

  function starMarkup(rating) {
    if (rating == null) return "";
    var score = Math.round(Number(rating) || 0);
    var stars = "";
    for (var i = 1; i <= 5; i += 1) {
      stars += i <= score ? "★" : "☆";
    }
    return stars;
  }

  function formatRating(rating) {
    var numeric = Number(rating);
    return rating != null && Number.isFinite(numeric) ? numeric.toFixed(1) + " on Google" : "See our Google reviews";
  }

  function formatCount(count) {
    var numeric = Number(count);
    return Number.isFinite(numeric) && numeric > 0
      ? numeric.toLocaleString() + " Google reviews"
      : "Verified Twin Rivers Fence profile";
  }

  function renderTrustPanel(data) {
    var rating = data.rating != null ? data.rating : null;
    var mapsUrl = data.url || data.google_maps_url || VERIFIED_GOOGLE_MAPS_URL;
    var countLabel = formatCount(data.user_ratings_total);
    var ratingMarkup = rating != null
      ? '<div class="google-trust-rating-row">' +
          '<span class="google-review-stars" aria-label="' + rating + ' out of 5 stars on Google">' + starMarkup(rating) + '</span>' +
          '<strong class="google-trust-score">' + Number(rating).toFixed(1) + '</strong>' +
        '</div>'
      : '<div class="google-trust-rating-row">' +
          '<a class="google-trust-see-reviews" href="' + mapsUrl + '" target="_blank" rel="noopener noreferrer">See our Google reviews</a>' +
        '</div>';
    return '<div class="google-trust-panel">' +
      '<div class="google-trust-badge" aria-label="Google Business Profile">' +
        '<div class="google-logo-mark" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="28" height="28" focusable="false"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>' +
        '</div>' +
        '<div class="google-trust-meta">' +
          '<span class="google-trust-label">Google Business Profile</span>' +
          ratingMarkup +
          '<span class="google-trust-business">Twin Rivers Fence · Northern California · ' + countLabel + '</span>' +
        '</div>' +
      '</div>' +
      '<ul class="google-trust-points">' +
        '<li><strong>Licensed contractor</strong><span>California License #1089233</span></li>' +
        '<li><strong>40+ years experience</strong><span>Residential and commercial fencing</span></li>' +
        '<li><strong>Verified profile only</strong><span>Customer reviews are read directly on our official Google listing</span></li>' +
      '</ul>' +
    '</div>';
  }

  function render(data) {
    var profile = data && data.ok !== false ? data : FALLBACK_PROFILE;
    var mapsUrl = profile.url || profile.google_maps_url || VERIFIED_GOOGLE_MAPS_URL;
    var rating = profile.rating != null ? profile.rating : null;
    var count = profile.user_ratings_total != null ? profile.user_ratings_total : profile.review_count;

    setText(".google-review-rating", formatRating(rating));
    setText(".google-review-count", formatCount(count));
    qsAll(".google-star-row").forEach(function (node) {
      node.textContent = starMarkup(rating);
      if (rating != null) {
        node.setAttribute("aria-label", rating + " out of 5 stars on Google");
      } else {
        node.setAttribute("aria-label", "Reviews on Google");
      }
    });
    qsAll(".google-review-link").forEach(function (node) {
      node.setAttribute("href", mapsUrl);
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    });
    qsAll("[data-google-reviews-status]").forEach(function (node) {
      node.textContent = profile.live_reviews_available === false
        ? "Read real customer reviews, photos, and business details on our official Google Business Profile."
        : "Recent Google reviews from Twin Rivers Fence customers.";
    });

    var liveReviews = Array.isArray(profile.reviews)
      ? profile.reviews.filter(function (review) { return review && review.text; }).slice(0, 3)
      : [];

    qsAll("[data-google-review-cards]").forEach(function (container) {
      if (liveReviews.length) {
        container.innerHTML = liveReviews.map(function (review) {
          return '<article class="google-review-card"><div class="google-review-card-head"><div><strong>' +
            (review.author_name || "Google reviewer") + "</strong><span>" +
            (review.relative_time_description || "Google review") + '</span></div><div class="google-review-stars" aria-label="' +
            (review.rating || rating) + ' star Google review">' + starMarkup(review.rating || rating) + "</div></div><p>" +
            (review.text || "") + "</p></article>";
        }).join("");
      } else {
        container.innerHTML = renderTrustPanel(profile);
      }
    });
  }

  function loadReviews() {
    if (!qsAll("[data-google-review-cards]").length) return;
    render(FALLBACK_PROFILE);

    fetch(ENDPOINT, { headers: { Accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) throw new Error("Review feed unavailable");
        return response.json();
      })
      .then(function (data) {
        if (!data || data.ok === false) {
          render(FALLBACK_PROFILE);
          return;
        }
        if (!data.url) {
          data.url = VERIFIED_GOOGLE_MAPS_URL;
        }
        render(data);
      })
      .catch(function () {
        render(FALLBACK_PROFILE);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadReviews);
  } else {
    loadReviews();
  }
}());
