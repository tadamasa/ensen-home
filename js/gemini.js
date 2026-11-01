// Gemini API を端末から直接呼ぶ。APIキーは端末内(IndexedDB)にだけ保存する。
// 無料枠では入力がGoogleの製品改善に使われうるため、呼ぶのはボタンを押したときだけ。送る中身は画面に書く。

export const DEFAULT_MODEL = 'gemini-3.8-flash';

export async function generateJson({ apiKey, model = DEFAULT_MODEL, prompt }) {
  if (!apiKey) throw new Error('設定でGemini APIキーを入れてください');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || DEFAULT_MODEL)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.9 } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Geminiの呼び出しに失敗しました: ${data.error ? data.error.message : res.statusText}`);
  const cand = (data.candidates || [])[0] || {};
  return ((cand.content || {}).parts || []).map(p => p.text || '').join('').trim();
}
