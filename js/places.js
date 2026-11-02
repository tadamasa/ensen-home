// Google Places API (New) を端末から直接呼ぶ(近くの場所の候補)。APIキーは端末内(IndexedDB)にだけ保存する。
// キーは Google Cloud で「HTTP リファラー = https://tadamasa.github.io/*」「API = Places API (New)」に絞っておく。
// 規約: 座標の保存は30日まで・place_id は無期限、Google 以外の地図に重ねない(地図で選ぶには出さない)。

const FIELDS = 'places.id,places.displayName,places.location,places.primaryType';

export async function searchPlaces({ apiKey, lat, lng, radius = 300, q = '', signal }) {
  if (!apiKey) return [];
  const circle = { circle: { center: { latitude: lat, longitude: lng }, radius } };
  const body = q
    ? { textQuery: q, languageCode: 'ja', regionCode: 'JP', maxResultCount: 10, locationBias: circle }
    : { locationRestriction: circle, maxResultCount: 20, languageCode: 'ja', rankPreference: 'DISTANCE' };
  const res = await fetch(`https://places.googleapis.com/v1/places:${q ? 'searchText' : 'searchNearby'}`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error ? data.error.message : res.statusText}`.slice(0, 160));
  return parsePlaces(data);
}

export function parsePlaces(data) {
  return (data && data.places || []).map(p => ({
    id: `google:${p.id}`, src: 'google', name: p.displayName && p.displayName.text,
    lat: p.location && Number(p.location.latitude), lng: p.location && Number(p.location.longitude),
    category: p.primaryType ? `google=${p.primaryType}` : '',
  })).filter(p => p.name && isFinite(p.lat) && isFinite(p.lng));
}
