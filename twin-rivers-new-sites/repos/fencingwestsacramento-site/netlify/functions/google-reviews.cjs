const VERIFIED_GOOGLE_MAPS_URL = 'https://maps.app.goo.gl/rXBxsJXV2E6Z3Luu6';
const VERIFIED_KG_MID = '/g/11z2g5p6z2';
const VERIFIED_CID = '6217874961313686833';
const VERIFIED_COORDINATES = { latitude: 38.255235, longitude: -121.0614744 };
const VERIFIED_RATING = 5.0;
const CACHE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=900, s-maxage=43200, stale-while-revalidate=86400'
};

function response(statusCode, payload) {
  return { statusCode, headers: CACHE_HEADERS, body: JSON.stringify(payload) };
}

function normalizeReview(review) {
  return {
    author_name: review.author_name || 'Google reviewer',
    rating: typeof review.rating === 'number' ? review.rating : null,
    relative_time_description: review.relative_time_description || '',
    text: review.text || '',
    time: review.time || null,
    author_url: review.author_url || '',
    profile_photo_url: review.profile_photo_url || ''
  };
}

async function googleJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await res.json();
  if (!res.ok) throw new Error('Google review request failed.');
  return data;
}

function verifiedFallback(message) {
  return response(200, {
    ok: true,
    source: 'verified-google-maps-link',
    live_reviews_available: false,
    message: message || 'Google reviews are available on the verified Twin Rivers Fence Google Maps profile.',
    name: 'Twin Rivers Fence',
    url: VERIFIED_GOOGLE_MAPS_URL,
    google_maps_url: VERIFIED_GOOGLE_MAPS_URL,
    kg_mid: VERIFIED_KG_MID,
    cid: VERIFIED_CID,
    coordinates: VERIFIED_COORDINATES,
    rating: VERIFIED_RATING,
    user_ratings_total: null,
    review_count: null,
    reviews: []
  });
}

exports.handler = async function () {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID || '';

  if (!apiKey || !placeId) {
    return verifiedFallback(
      'Live Google review text is not available from Places API for this verified profile. Rating and profile link are provided as a fallback.'
    );
  }

  try {
    const detailsUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    detailsUrl.searchParams.set('place_id', placeId);
    detailsUrl.searchParams.set('fields', 'place_id,name,rating,user_ratings_total,reviews,url');
    detailsUrl.searchParams.set('reviews_sort', 'newest');
    detailsUrl.searchParams.set('key', apiKey);
    const details = await googleJson(detailsUrl.toString());
    if (details.status !== 'OK' || !details.result) {
      throw new Error('Twin Rivers Fence Google review details were unavailable.');
    }

    const result = details.result;
    return response(200, {
      ok: true,
      source: 'google',
      live_reviews_available: true,
      cached_at: Math.floor(Date.now() / 1000),
      place_id: result.place_id || placeId,
      name: result.name || 'Twin Rivers Fence',
      rating: typeof result.rating === 'number' ? result.rating : VERIFIED_RATING,
      user_ratings_total: typeof result.user_ratings_total === 'number' ? result.user_ratings_total : null,
      url: result.url || VERIFIED_GOOGLE_MAPS_URL,
      google_maps_url: VERIFIED_GOOGLE_MAPS_URL,
      reviews: Array.isArray(result.reviews) ? result.reviews.map(normalizeReview) : []
    });
  } catch (error) {
    return verifiedFallback(error.message);
  }
};
